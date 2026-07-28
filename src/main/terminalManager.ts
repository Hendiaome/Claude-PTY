import { BrowserWindow } from "electron";
import * as pty from "node-pty";
import type { IPty } from "node-pty";
import { existsSync } from "node:fs";
import type { SessionActivityState, SessionActivityStatus, SessionRecord } from "../shared/types";
import {
  getLoginEnv,
  getShellPath,
  resolveClaudePath,
  supportsAppendSystemPrompt
} from "./environment";
import type { SettingsStore } from "./settingsStore";
import type { AppStore } from "./store";
import { logError, logInfo, logWarn } from "./appLogger";
import type { ClaudeActivityHooks, ClaudeActivitySignal } from "./claudeActivityHooks";
import { PtyOutputGate } from "./ptyOutputGate";
import {
  claudeTranscriptExists,
  getClaudeTranscriptPath,
  normalizeClaudeSessionId
} from "./claudeHistory";

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 36;
const MAX_BUFFER_CHARS = 1_000_000;
const BUFFER_TRIM_LOG_INTERVAL_MS = 60_000;
const ACTIVITY_FLUSH_DELAY_MS = 2_000;
const BLOCKED_PROMPT_INSTRUCTION =
  "当任务无法继续并且必须等待用户确认、选择或补充信息时，必须调用 AskUserQuestion 工具提问，不要只输出普通文本问句后结束本轮响应；如果不需要用户输入即可继续，则不要调用该工具。";

type TerminalProcess = {
  sessionId: string;
  process: IPty;
  cols: number;
  rows: number;
  stopping: boolean;
};

type TerminalOutputBuffer = {
  chunks: string[];
  size: number;
  trimmedChars: number;
  trimmedChunks: number;
  lastTrimLogAt?: number;
};

type TerminalManagerCallbacks = {
  onSessionChanged?: () => void;
  onActivityChanged?: (
    state: SessionActivityState,
    previousState: SessionActivityStatus | undefined,
    source: string
  ) => void;
};

/** 管理 Claude CLI 的 PTY 生命周期、恢复命令、有限输出缓存和会话活跃时间。 */
export class TerminalManager {
  private readonly terminals = new Map<string, TerminalProcess>();
  private readonly outputBuffers = new Map<string, TerminalOutputBuffer>();
  private readonly activityStates = new Map<string, SessionActivityState>();
  private readonly warnedUnsupportedPromptPaths = new Set<string>();
  private readonly outputGate: PtyOutputGate;
  private readonly pendingActivity = new Map<string, string>();
  private preferredCols = DEFAULT_COLS;
  private preferredRows = DEFAULT_ROWS;
  private preferredSizeMeasured = false;
  private activityFlushTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly store: AppStore,
    private readonly settingsStore: SettingsStore,
    private readonly getMainWindow: () => BrowserWindow | null,
    private readonly activityHooks?: ClaudeActivityHooks,
    private readonly callbacks: TerminalManagerCallbacks = {}
  ) {
    this.outputGate = new PtyOutputGate(
      "claude",
      (sessionId) => this.terminals.get(sessionId)?.process,
      (sessionId, data) => this.getMainWindow()?.webContents.send("terminal:data", { sessionId, data }),
      (sessionId) => this.getMainWindow()?.webContents.send("terminal:output-resumed", { sessionId })
    );
  }

  hasRunningTerminals(): boolean {
    return this.terminals.size > 0;
  }

  setOutputPaused(paused: boolean, trigger: string): void {
    this.outputGate.setPaused(paused, trigger);
  }

  isRunning(sessionId: string): boolean {
    const terminal = this.terminals.get(sessionId);
    return Boolean(terminal && !terminal.stopping);
  }

  getActivityStates(): SessionActivityState[] {
    return [...this.activityStates.values()].map((state) => ({ ...state }));
  }

  applyActivitySignal(signal: ClaudeActivitySignal): void {
    if (!this.isRunning(signal.sessionId)) {
      return;
    }
    this.setActivityState(signal.sessionId, signal.state, signal.source);
  }

  async create(projectId: string): Promise<SessionRecord> {
    const project = this.store.getProject(projectId);
    if (!project) {
      logWarn("claude-terminal", "project-not-found", { projectId, action: "create" });
      throw new Error("项目不存在。");
    }

    if (project.missing || !existsSync(project.path)) {
      logWarn("claude-terminal", "project-path-missing", { projectId, path: project.path, action: "create" });
      throw new Error(`项目路径不存在：${project.path}`);
    }

    const title = `${project.name} ${formatShortDate(new Date())}`;
    const session = this.store.createSession(project.id, title);
    this.store.touchProject(project.id);
    logInfo("claude-terminal", "create-requested", {
      sessionId: session.id,
      claudeSessionId: session.claudeSessionId,
      projectId: project.id,
      cwd: project.path
    });

    return this.spawnClaude(session, project.path, "new");
  }

  async importAndResume(projectId: string, rawClaudeSessionId: unknown): Promise<SessionRecord> {
    const project = this.store.getProject(projectId);
    if (!project) {
      logWarn("history-import", "project-not-found", { projectId });
      throw new Error("项目不存在。");
    }
    if (project.missing || !existsSync(project.path)) {
      logWarn("history-import", "project-path-missing", { projectId, path: project.path });
      throw new Error(`项目路径不存在：${project.path}`);
    }

    let claudeSessionId: string;
    try {
      claudeSessionId = normalizeClaudeSessionId(rawClaudeSessionId);
    } catch (error) {
      logWarn("history-import", "session-id-invalid", { projectId });
      throw error;
    }

    logInfo("history-import", "resume-requested", { projectId, claudeSessionId });
    const existing = this.store.getSessionByClaudeSessionId(claudeSessionId);
    if (existing) {
      logWarn("history-import", "session-duplicated", {
        projectId,
        claudeSessionId,
        existingSessionId: existing.id
      });
      throw new Error("该 Claude CLI 会话已在管理器中。");
    }
    const transcriptPath = getClaudeTranscriptPath(project.path, claudeSessionId);
    if (!claudeTranscriptExists(project.path, claudeSessionId)) {
      // 记录推导后的文件位置，不记录历史正文，便于排查 Claude 路径编码或项目目录不一致。
      logWarn("history-import", "transcript-not-found", {
        projectId,
        projectPath: project.path,
        claudeSessionId,
        transcriptPath
      });
      throw new Error(`当前文件夹下未找到该 Claude CLI 历史会话。\n查找路径：${transcriptPath}`);
    }
    if (!resolveClaudePath()) {
      logWarn("history-import", "claude-not-found", { projectId, claudeSessionId });
      throw new Error("未找到 claude 命令。");
    }

    // 只有 PTY 确认启动后才保留导入记录，任何失败都回滚，避免留下不可恢复的脏会话。
    let session: SessionRecord | undefined;
    try {
      this.store.touchProject(project.id);
      session = this.store.createImportedSession(
        project.id,
        claudeSessionId,
        `${project.name}的恢复`,
        transcriptPath
      );
      const running = this.spawnClaude(session, project.path, "resume", true);
      logInfo("history-import", "resume-started", {
        projectId,
        sessionId: running.id,
        claudeSessionId
      });
      return running;
    } catch (error) {
      if (session && this.store.getSession(session.id)) {
        try {
          this.store.removeSession(session.id);
        } catch (cleanupError) {
          logError("history-import", "cleanup-failed", cleanupError, {
            projectId,
            sessionId: session.id,
            claudeSessionId
          });
        }
      }
      logError("history-import", "resume-failed", error, { projectId, claudeSessionId });
      throw error;
    }
  }

  async resume(sessionId: string): Promise<SessionRecord> {
    const running = this.terminals.get(sessionId);
    const existingSession = this.store.getSession(sessionId);

    if (!existingSession) {
      logWarn("claude-terminal", "session-not-found", { sessionId, action: "resume" });
      throw new Error("会话不存在。");
    }

    if (running) {
      logInfo("claude-terminal", "reuse-running", { sessionId, pid: running.process.pid });
      return this.store.updateSession(sessionId, {
        status: "running",
        lastActiveAt: new Date().toISOString()
      });
    }

    const project = this.store.getProject(existingSession.projectId);
    if (!project) {
      logWarn("claude-terminal", "project-not-found", {
        sessionId,
        projectId: existingSession.projectId,
        action: "resume"
      });
      throw new Error("会话关联的项目不存在。");
    }

    if (project.missing || !existsSync(project.path)) {
      logWarn("claude-terminal", "project-path-missing", {
        sessionId,
        projectId: project.id,
        path: project.path,
        action: "resume"
      });
      throw new Error(`项目路径不存在：${project.path}`);
    }

    this.store.touchProject(project.id);
    logInfo("claude-terminal", "resume-requested", {
      sessionId: existingSession.id,
      claudeSessionId: existingSession.claudeSessionId,
      projectId: project.id,
      cwd: project.path
    });
    return this.spawnClaude(existingSession, project.path, "resume");
  }

  write(sessionId: string, data: string): void {
    const terminal = this.terminals.get(sessionId);
    if (!terminal) {
      return;
    }

    terminal.process.write(data);
    // AskUserQuestion 和权限选择都以回车确认；先即时解除阻塞，再由后续 Hook 校准真实状态。
    if (this.activityStates.get(sessionId)?.state === "blocked" && /[\r\n]/u.test(data)) {
      this.setActivityState(sessionId, "working", "terminal:user-confirmed");
    }
    this.markSessionActivity(sessionId);
  }

  resize(sessionId: string, cols: number, rows: number): void {
    if (!isValidTerminalSize(cols, rows)) {
      logWarn("terminal-size", "invalid", { sessionId, cols, rows });
      return;
    }

    const preferredSizeChanged =
      !this.preferredSizeMeasured || this.preferredCols !== cols || this.preferredRows !== rows;
    this.preferredCols = cols;
    this.preferredRows = rows;
    this.preferredSizeMeasured = true;

    const terminal = this.terminals.get(sessionId);
    if (!terminal) {
      if (preferredSizeChanged) {
        // 会话恢复前的 fit 也要保留，后续 PTY 才能从第一帧就使用真实可见尺寸。
        logInfo("terminal-size", "captured-before-spawn", { sessionId, cols, rows });
      }
      return;
    }

    if (terminal.cols === cols && terminal.rows === rows) {
      return;
    }
    terminal.cols = cols;
    terminal.rows = rows;
    terminal.process.resize(cols, rows);
  }

  stop(sessionId: string): void {
    logInfo("claude-terminal", "stop-requested", { sessionId });
    const terminal = this.terminals.get(sessionId);
    const lastActiveAt = this.takePendingActivity(sessionId);
    if (!terminal) {
      this.outputGate.remove(sessionId);
      const session = this.store.getSession(sessionId);
      if (session?.status === "running" || session?.status === "stopping") {
        const exited = this.store.updateSession(sessionId, {
          status: "exited",
          exitedAt: new Date().toISOString(),
          ...(lastActiveAt ? { lastActiveAt } : {})
        });
        this.emitSession(exited);
      }
      return;
    }

    terminal.stopping = true;
    const stopping = this.store.updateSession(sessionId, {
      status: "stopping",
      lastActiveAt: lastActiveAt ?? new Date().toISOString()
    });
    this.emitSession(stopping);
    this.outputGate.remove(sessionId);
    terminal.process.kill();
  }

  stopAll(): void {
    logInfo("claude-terminal", "stop-all", { count: this.terminals.size });
    logInfo("terminal-buffer", "shutdown-summary", {
      count: this.outputBuffers.size,
      chars: [...this.outputBuffers.values()].reduce((total, buffer) => total + buffer.size, 0)
    });
    this.flushSessionActivity();
    this.outputGate.clear();
    for (const terminal of this.terminals.values()) {
      terminal.process.kill();
    }
  }

  discardSession(sessionId: string): void {
    this.takePendingActivity(sessionId);
    const buffer = this.outputBuffers.get(sessionId);
    if (buffer) {
      logInfo("terminal-buffer", "discarded", {
        sessionId,
        chars: buffer.size,
        chunks: buffer.chunks.length,
        trimmedChars: buffer.trimmedChars,
        reason: "session-record-discarded"
      });
    }
    this.outputBuffers.delete(sessionId);
    this.activityStates.delete(sessionId);
    this.outputGate.remove(sessionId);
  }

  getBuffer(sessionId: string): string[] {
    const buffer = this.outputBuffers.get(sessionId);
    const chunks = [...(buffer?.chunks ?? [])];
    logInfo("terminal-buffer", "snapshot-read", {
      sessionId,
      chars: buffer?.size ?? 0,
      chunks: buffer?.chunks.length ?? 0,
      trimmedChars: buffer?.trimmedChars ?? 0,
      processRunning: this.isRunning(sessionId)
    });
    this.outputGate.supersedePendingWithSnapshot(sessionId);
    return chunks;
  }

  private spawnClaude(
    session: SessionRecord,
    cwd: string,
    mode: "new" | "resume",
    cleanupOnFailure = false
  ): SessionRecord {
    const claudePath = resolveClaudePath();
    if (!claudePath) {
      logWarn("claude-terminal", "claude-not-found", { sessionId: session.id, mode, cwd });
      if (cleanupOnFailure) {
        this.store.removeSession(session.id);
        throw new Error("未找到 claude 命令。");
      }
      const failed = this.store.updateSession(session.id, {
        status: "failed",
        error: "未找到 claude 命令。"
      });
      this.emitSession(failed);
      return failed;
    }

    const startedAt = new Date().toISOString();
    const runningSession = this.store.updateSession(session.id, {
      status: "running",
      startedAt,
      lastActiveAt: startedAt,
      error: undefined
    });

    const settings = this.settingsStore.getSettings();
    const effort = settings.defaultEffort;
    // 只有 Hook 可用且本机 CLI 支持时才注入提示词，避免旧版 Claude 因未知参数无法启动。
    const blockedPromptInstructionApplied =
      settings.enableBlockedPromptInstruction &&
      Boolean(this.activityHooks) &&
      supportsAppendSystemPrompt(claudePath);
    if (
      settings.enableBlockedPromptInstruction &&
      this.activityHooks &&
      !blockedPromptInstructionApplied &&
      !this.warnedUnsupportedPromptPaths.has(claudePath)
    ) {
      this.warnedUnsupportedPromptPaths.add(claudePath);
      logWarn("claude-terminal", "append-system-prompt-unsupported", { claudePath });
    }
    const command = buildClaudeCommand(
      claudePath,
      runningSession,
      mode,
      effort,
      this.activityHooks?.pluginDir,
      blockedPromptInstructionApplied ? BLOCKED_PROMPT_INSTRUCTION : undefined
    );
    const initialCols = this.preferredCols;
    const initialRows = this.preferredRows;
    logInfo("claude-terminal", "spawn-requested", {
      sessionId: runningSession.id,
      claudeSessionId: runningSession.claudeSessionId,
      mode,
      cwd,
      claudePath,
      effort,
      initialCols,
      initialRows,
      initialSizeSource: this.preferredSizeMeasured ? "renderer-fit" : "fallback",
      blockedPromptInstructionEnabled: settings.enableBlockedPromptInstruction,
      blockedPromptInstructionApplied
    });
    let ptyProcess: IPty;

    try {
      ptyProcess = pty.spawn(getShellPath(), ["-lc", `source ~/.zshrc >/dev/null 2>&1; exec ${command}`], {
        name: "xterm-256color",
        cols: initialCols,
        rows: initialRows,
        cwd,
        env: {
          ...getLoginEnv(),
          ...(this.activityHooks ? this.activityHooks.environmentFor(runningSession.id) : {}),
          TERM: "xterm-256color",
          COLORTERM: "truecolor"
        }
      });
    } catch (error) {
      logError("claude-terminal", "spawn-failed", error, {
        sessionId: session.id,
        mode,
        cwd,
        claudePath,
        effort
      });
      if (cleanupOnFailure) {
        this.store.removeSession(session.id);
        throw error;
      }
      const failed = this.store.updateSession(session.id, {
        status: "failed",
        error: error instanceof Error ? error.message : String(error)
      });
      this.emitSession(failed);
      return failed;
    }

    const terminal: TerminalProcess = {
      sessionId: runningSession.id,
      process: ptyProcess,
      cols: initialCols,
      rows: initialRows,
      stopping: false
    };

    this.terminals.set(runningSession.id, terminal);
    const existingBuffer = this.outputBuffers.get(runningSession.id);
    if (existingBuffer) {
      // 同一次应用运行期间恢复进程时继续沿用旧输出，避免一次 stop/resume 清空滚动历史。
      logInfo("terminal-buffer", "retained-for-spawn", {
        sessionId: runningSession.id,
        mode,
        chars: existingBuffer.size,
        chunks: existingBuffer.chunks.length,
        trimmedChars: existingBuffer.trimmedChars
      });
    } else {
      this.outputBuffers.set(runningSession.id, createOutputBuffer());
      logInfo("terminal-buffer", "created", {
        sessionId: runningSession.id,
        mode,
        maxChars: MAX_BUFFER_CHARS
      });
    }
    this.setActivityState(runningSession.id, "idle", "process:spawned");
    logInfo("claude-terminal", "spawned", {
      sessionId: runningSession.id,
      pid: ptyProcess.pid,
      mode,
      cwd
    });
    this.emitSession(runningSession);

    ptyProcess.onData((data) => {
      const buffer = this.getOutputBuffer(runningSession.id);
      if (appendOutput(buffer, data)) {
        this.logBufferTrimmed(runningSession.id, buffer);
      }
      this.outputGate.deliver(runningSession.id, data);
    });

    ptyProcess.onExit(({ exitCode }) => {
      logInfo("claude-terminal", "exited", {
        sessionId: runningSession.id,
        pid: ptyProcess.pid,
        exitCode
      });
      this.terminals.delete(runningSession.id);
      const retainedBuffer = this.outputBuffers.get(runningSession.id);
      if (retainedBuffer) {
        // 仅保留在内存中，应用退出后自然释放，不把可能包含代码的终端正文写入磁盘。
        logInfo("terminal-buffer", "retained-after-exit", {
          sessionId: runningSession.id,
          exitCode,
          chars: retainedBuffer.size,
          chunks: retainedBuffer.chunks.length,
          trimmedChars: retainedBuffer.trimmedChars
        });
      }
      this.activityStates.delete(runningSession.id);
      const lastActiveAt = this.takePendingActivity(runningSession.id);
      if (!this.store.getSession(runningSession.id)) {
        this.outputGate.complete(runningSession.id, () => {
          this.getMainWindow()?.webContents.send("terminal:exit", {
            sessionId: runningSession.id,
            exitCode
          });
        });
        return;
      }

      const exited = this.store.updateSession(runningSession.id, {
        status: "exited",
        exitCode,
        exitedAt: new Date().toISOString(),
        ...(lastActiveAt ? { lastActiveAt } : {})
      });

      this.emitSession(exited);
      this.outputGate.complete(runningSession.id, () => {
        this.getMainWindow()?.webContents.send("terminal:exit", {
          sessionId: runningSession.id,
          exitCode
        });
      });
    });

    return runningSession;
  }

  private emitSession(session: SessionRecord): void {
    this.getMainWindow()?.webContents.send("session:updated", session);
    this.callbacks.onSessionChanged?.();
  }

  private setActivityState(sessionId: string, state: SessionActivityStatus, source: string): void {
    const previous = this.activityStates.get(sessionId);
    if (previous?.state === "blocked" && state === "idle" && source === "hook:stop") {
      // AskUserQuestion 后紧随的 Stop 只代表本轮暂停，不能覆盖仍在等待用户输入的阻塞态。
      logInfo("session-activity", "transition-ignored", {
        sessionId,
        previousState: previous.state,
        state,
        source
      });
      return;
    }
    if (previous?.state === state) {
      return;
    }

    const next: SessionActivityState = {
      sessionId,
      state,
      updatedAt: new Date().toISOString()
    };
    this.activityStates.set(sessionId, next);
    logInfo("session-activity", "changed", {
      sessionId,
      previousState: previous?.state,
      state,
      source
    });
    this.getMainWindow()?.webContents.send("session:activity-state", next);
    this.callbacks.onActivityChanged?.(next, previous?.state, source);
  }

  private markSessionActivity(sessionId: string): void {
    // 输入事件很密集，合并一小段时间内的活跃时间更新，减少配置文件写盘次数。
    this.pendingActivity.set(sessionId, new Date().toISOString());
    if (this.activityFlushTimer) {
      return;
    }

    this.activityFlushTimer = setTimeout(() => {
      this.activityFlushTimer = undefined;
      this.flushSessionActivity();
    }, ACTIVITY_FLUSH_DELAY_MS);
    this.activityFlushTimer.unref?.();
  }

  private takePendingActivity(sessionId: string): string | undefined {
    const lastActiveAt = this.pendingActivity.get(sessionId);
    this.pendingActivity.delete(sessionId);
    this.clearActivityTimerWhenIdle();
    return lastActiveAt;
  }

  private flushSessionActivity(): void {
    if (this.activityFlushTimer) {
      clearTimeout(this.activityFlushTimer);
      this.activityFlushTimer = undefined;
    }

    if (this.pendingActivity.size === 0) {
      return;
    }

    const activities = new Map(this.pendingActivity);
    this.pendingActivity.clear();
    this.store.updateSessionActivities(activities);
  }

  private clearActivityTimerWhenIdle(): void {
    if (this.pendingActivity.size > 0 || !this.activityFlushTimer) {
      return;
    }

    clearTimeout(this.activityFlushTimer);
    this.activityFlushTimer = undefined;
  }

  private getOutputBuffer(sessionId: string): TerminalOutputBuffer {
    const existing = this.outputBuffers.get(sessionId);
    if (existing) {
      return existing;
    }

    const created = createOutputBuffer();
    this.outputBuffers.set(sessionId, created);
    logInfo("terminal-buffer", "created-late", {
      sessionId,
      maxChars: MAX_BUFFER_CHARS
    });
    return created;
  }

  private logBufferTrimmed(sessionId: string, buffer: TerminalOutputBuffer): void {
    const now = Date.now();
    if (buffer.lastTrimLogAt && now - buffer.lastTrimLogAt < BUFFER_TRIM_LOG_INTERVAL_MS) {
      return;
    }

    buffer.lastTrimLogAt = now;
    // 只记录容量指标，不记录任何终端正文、命令或文件路径。
    logInfo("terminal-buffer", "trimmed", {
      sessionId,
      chars: buffer.size,
      chunks: buffer.chunks.length,
      trimmedChars: buffer.trimmedChars,
      trimmedChunks: buffer.trimmedChunks,
      maxChars: MAX_BUFFER_CHARS
    });
  }
}

function buildClaudeCommand(
  claudePath: string,
  session: SessionRecord,
  mode: "new" | "resume",
  effort: string,
  activityPluginDir?: string,
  appendSystemPrompt?: string
): string {
  const activityPluginArgument = activityPluginDir
    ? ` --plugin-dir ${shellQuote(activityPluginDir)}`
    : "";
  const appendSystemPromptArgument = appendSystemPrompt
    ? ` --append-system-prompt ${shellQuote(appendSystemPrompt)}`
    : "";
  if (mode === "resume") {
    return `${shellQuote(claudePath)} --resume ${shellQuote(session.claudeSessionId)} --effort ${shellQuote(effort)}${activityPluginArgument}${appendSystemPromptArgument}`;
  }

  return `${shellQuote(claudePath)} --session-id ${shellQuote(session.claudeSessionId)} --effort ${shellQuote(effort)}${activityPluginArgument}${appendSystemPromptArgument}`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\"'\"'")}'`;
}

function isValidTerminalSize(cols: number, rows: number): boolean {
  return Number.isSafeInteger(cols) && cols >= 2 && Number.isSafeInteger(rows) && rows >= 1;
}

function createOutputBuffer(): TerminalOutputBuffer {
  return {
    chunks: [],
    size: 0,
    trimmedChars: 0,
    trimmedChunks: 0
  };
}

function appendOutput(buffer: TerminalOutputBuffer, data: string): boolean {
  buffer.chunks.push(data);
  buffer.size += data.length;
  let trimmed = false;

  // 缓存的是含 ANSI 控制序列的原始 PTY 数据，因此按字符限制内存而不是承诺固定可见行数。
  while (buffer.size > MAX_BUFFER_CHARS && buffer.chunks.length > 1) {
    const removed = buffer.chunks.shift() ?? "";
    buffer.size -= removed.length;
    buffer.trimmedChars += removed.length;
    buffer.trimmedChunks += 1;
    trimmed = true;
  }

  return trimmed;
}

function formatShortDate(date: Date): string {
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  const hour = `${date.getHours()}`.padStart(2, "0");
  const minute = `${date.getMinutes()}`.padStart(2, "0");
  return `${month}-${day} ${hour}:${minute}`;
}
