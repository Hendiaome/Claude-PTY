import { BrowserWindow } from "electron";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import type {
  SessionActivityState,
  SessionActivityStatus,
  SessionRecord,
  StructuredPermissionDecision,
  StructuredPermissionRequest,
  StructuredQuestion,
  StructuredQuestionAnswers,
  StructuredQuestionRequest,
  StructuredSessionSnapshot
} from "../shared/types";
import type { ClaudeActivityHooks, ClaudeActivitySignal } from "./claudeActivityHooks";
import { getClaudeTranscriptPath } from "./claudeHistory";
import { getLoginEnv, resolveClaudePath, supportsAppendSystemPrompt } from "./environment";
import { logError, logInfo, logWarn } from "./appLogger";
import type { SettingsStore } from "./settingsStore";
import type { AppStore } from "./store";
import {
  applyStructuredProtocolMessage,
  createStructuredSnapshot,
  normalizeSlashCommands,
  toStructuredDisplayValue
} from "./structuredProtocol";
import { loadStructuredTranscript } from "./structuredTranscript";

const MAX_STDOUT_PENDING_CHARS = 1_000_000;
const MAX_STDERR_CHARS = 100_000;
const MAX_SNAPSHOT_ITEMS = 600;
const MAX_SNAPSHOT_TEXT_CHARS = 2_000_000;
const MAX_STREAMING_TEXT_CHARS = 500_000;
const ASK_USER_QUESTION_DIALOG_KIND = "permission_ask_user_question";
const BLOCKED_PROMPT_INSTRUCTION =
  "当任务无法继续并且必须等待用户确认、选择或补充信息时，必须调用 AskUserQuestion 工具提问，不要只输出普通文本问句后结束本轮响应；如果不需要用户输入即可继续，则不要调用该工具。";

type StructuredProcess = {
  sessionId: string;
  process: ChildProcessWithoutNullStreams;
  stdoutPending: string;
  stderr: string;
  stderrBytes: number;
  stopping: boolean;
  streamStats?: StructuredStreamStats;
  pendingCommandName?: string;
  initializeRequestId?: string;
};

type StructuredStreamStats = {
  startedAt: number;
  streamEventCount: number;
  textDeltaCount: number;
  textCharCount: number;
  thinkingDeltaCount: number;
  inputJsonDeltaCount: number;
  firstTextDeltaAt?: number;
  lastTextDeltaAt?: number;
};

type InternalPermissionRequest = {
  publicRequest: StructuredPermissionRequest;
  originalInput: unknown;
};

type InternalQuestionRequest = {
  publicRequest: StructuredQuestionRequest;
  originalInput: unknown;
};

type StructuredClaudeManagerCallbacks = {
  onSessionChanged?: () => void;
  onActivityChanged?: (
    state: SessionActivityState,
    previousState: SessionActivityStatus | undefined,
    source: string
  ) => void;
};

/**
 * 独立管理 Claude stream-json 子进程。它不读取 PTY ANSI，也不与 TerminalManager 共享输出缓存。
 */
export class StructuredClaudeManager {
  private readonly processes = new Map<string, StructuredProcess>();
  private readonly snapshots = new Map<string, StructuredSessionSnapshot>();
  private readonly permissions = new Map<string, Map<string, InternalPermissionRequest>>();
  private readonly questions = new Map<string, Map<string, InternalQuestionRequest>>();
  private readonly activityStates = new Map<string, SessionActivityState>();

  constructor(
    private readonly store: AppStore,
    private readonly settingsStore: SettingsStore,
    private readonly getMainWindow: () => BrowserWindow | null,
    private readonly activityHooks?: ClaudeActivityHooks,
    private readonly callbacks: StructuredClaudeManagerCallbacks = {}
  ) {}

  hasRunningProcesses(): boolean {
    return this.processes.size > 0;
  }

  isRunning(sessionId: string): boolean {
    const running = this.processes.get(sessionId);
    return Boolean(running && !running.stopping);
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
      logWarn("structured-claude", "project-not-found", { projectId, action: "create" });
      throw new Error("项目不存在。");
    }
    if (project.missing || !existsSync(project.path)) {
      logWarn("structured-claude", "project-path-missing", { projectId, action: "create" });
      throw new Error(`项目路径不存在：${project.path}`);
    }

    const session = this.store.createSession(
      project.id,
      `${project.name} ${formatShortDate(new Date())}`,
      "structured"
    );
    this.store.touchProject(project.id);
    this.snapshots.set(session.id, createStructuredSnapshot(session.id));
    logInfo("structured-claude", "create-requested", {
      sessionId: session.id,
      claudeSessionId: session.claudeSessionId,
      projectId: project.id,
      mode: "structured"
    });
    return this.spawnClaude(session, project.path, "new");
  }

  async resume(sessionId: string): Promise<SessionRecord> {
    const session = this.store.getSession(sessionId);
    if (!session) {
      throw new Error("会话不存在。");
    }
    if (session.mode !== "structured") {
      throw new Error("该会话不是结构化模式。");
    }
    const running = this.processes.get(sessionId);
    if (running) {
      return this.store.updateSession(sessionId, {
        status: "running",
        lastActiveAt: new Date().toISOString()
      });
    }

    const project = this.store.getProject(session.projectId);
    if (!project) {
      throw new Error("会话关联的项目不存在。");
    }
    if (project.missing || !existsSync(project.path)) {
      throw new Error(`项目路径不存在：${project.path}`);
    }

    this.store.touchProject(project.id);
    const defaultTranscriptPath = getClaudeTranscriptPath(project.path, session.claudeSessionId);
    const transcriptPath = session.transcriptPath && existsSync(session.transcriptPath)
      ? session.transcriptPath
      : defaultTranscriptPath;
    const transcriptFound = existsSync(transcriptPath);
    if (!transcriptFound) {
      // 新会话尚未发送过 Prompt 时不会生成 JSONL；清掉失败恢复留下的临时卡片，按原 ID 重新启动。
      this.snapshots.set(session.id, createStructuredSnapshot(session.id));
      logInfo("structured-history", "resume-fallback-new", {
        sessionId: session.id,
        projectId: project.id,
        transcriptFound: false
      });
    } else if (!this.snapshots.has(session.id)) {
      const snapshot = createStructuredSnapshot(session.id);
      const parsedEvents = await loadStructuredTranscript(transcriptPath, snapshot);
      this.trimSnapshot(snapshot, "history-load");
      this.snapshots.set(session.id, snapshot);
      logInfo("structured-history", "loaded", {
        sessionId: session.id,
        projectId: project.id,
        parsedEvents,
        itemCount: snapshot.items.length,
        transcriptFound: true
      });
    }

    const launchMode = transcriptFound ? "resume" : "new";
    logInfo("structured-claude", "resume-requested", {
      sessionId: session.id,
      claudeSessionId: session.claudeSessionId,
      projectId: project.id,
      mode: "structured",
      launchMode,
      transcriptFound
    });
    return this.spawnClaude(session, project.path, launchMode);
  }

  send(sessionId: string, text: unknown): void {
    const running = this.processes.get(sessionId);
    if (!running || running.stopping) {
      throw new Error("结构化 Claude 会话未运行。");
    }
    if (typeof text !== "string" || !text.trim()) {
      throw new Error("请输入消息。");
    }
    if (text.length > 200_000) {
      throw new Error("单条消息过长，请拆分后发送。");
    }
    if (this.pendingInteractionCount(sessionId) > 0) {
      throw new Error("请先处理当前权限请求或问题。");
    }

    const snapshot = this.getMutableSnapshot(sessionId);
    const now = new Date().toISOString();
    const commandName = slashCommandName(text, snapshot.slashCommands);
    snapshot.items.push({
      id: `local-user:${randomUUID()}`,
      kind: "user",
      text,
      createdAt: now
    });
    snapshot.busy = true;
    snapshot.busyStartedAt = now;
    snapshot.activityLabel = commandName ? `正在执行 ${commandName}` : "Claude 工作中";
    snapshot.error = undefined;
    this.trimSnapshot(snapshot, "user-input");
    running.process.stdin.write(`${JSON.stringify({
      type: "user",
      session_id: "",
      parent_tool_use_id: null,
      message: { role: "user", content: text }
    })}\n`);
    this.store.updateSession(sessionId, { lastActiveAt: now });
    running.pendingCommandName = commandName;
    this.setActivityState(sessionId, "working", "structured:user-input");
    this.emitSnapshot(sessionId);
    // 日志只记录长度，不记录用户 Prompt 正文。
    logInfo("structured-input", "sent", { sessionId, charCount: text.length });
    if (commandName) {
      // 命令参数可能包含路径或业务内容，因此日志只保留命令名称。
      logInfo("structured-command", "sent", { sessionId, commandName });
    }
  }

  respondPermission(
    sessionId: string,
    requestId: unknown,
    decision: StructuredPermissionDecision
  ): void {
    if (typeof requestId !== "string" || (decision !== "allow" && decision !== "deny")) {
      throw new Error("权限响应参数无效。");
    }
    const running = this.processes.get(sessionId);
    const pending = this.permissions.get(sessionId)?.get(requestId);
    if (!running || !pending) {
      throw new Error("权限请求已失效。");
    }

    const response = decision === "allow"
      ? {
          behavior: "allow",
          updatedInput: pending.originalInput,
          updatedPermissions: [],
          toolUseID: pending.publicRequest.toolUseId
        }
      : {
          behavior: "deny",
          message: "用户拒绝了本次工具调用。",
          interrupt: false,
          toolUseID: pending.publicRequest.toolUseId
        };
    running.process.stdin.write(`${JSON.stringify({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: requestId,
        response
      }
    })}\n`);
    this.removePermission(sessionId, requestId);
    const snapshot = this.getMutableSnapshot(sessionId);
    snapshot.busy = true;
    snapshot.busyStartedAt = new Date().toISOString();
    snapshot.activityLabel = "Claude 工作中";
    this.setActivityState(sessionId, "working", `structured:permission-${decision}`);
    this.emitSnapshot(sessionId);
    logInfo("structured-permission", "responded", {
      sessionId,
      requestId,
      toolUseId: pending.publicRequest.toolUseId,
      toolName: pending.publicRequest.toolName,
      decision
    });
  }

  respondQuestion(
    sessionId: string,
    requestId: unknown,
    answers: StructuredQuestionAnswers | null
  ): void {
    if (typeof requestId !== "string") {
      throw new Error("问题响应参数无效。");
    }
    const running = this.processes.get(sessionId);
    const pending = this.questions.get(sessionId)?.get(requestId);
    if (!running || !pending) {
      throw new Error("问题已失效。");
    }

    const normalizedAnswers = answers === null
      ? null
      : validateQuestionAnswers(pending.publicRequest.questions, answers);
    const response = normalizedAnswers === null
      ? { behavior: "deny" }
      : {
          behavior: "allow",
          updatedInput: mergeQuestionAnswers(pending.originalInput, pending.publicRequest.questions, normalizedAnswers)
        };
    running.process.stdin.write(`${JSON.stringify({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: requestId,
        response
      }
    })}\n`);
    this.removeQuestion(sessionId, requestId);
    const snapshot = this.getMutableSnapshot(sessionId);
    snapshot.busy = true;
    snapshot.busyStartedAt = new Date().toISOString();
    snapshot.activityLabel = "Claude 工作中";
    this.setActivityState(sessionId, "working", "structured:question-responded");
    this.emitSnapshot(sessionId);
    // 问题和答案正文都不进入日志，只记录数量与提交状态。
    logInfo("structured-question", "responded", {
      sessionId,
      requestId,
      questionCount: pending.publicRequest.questions.length,
      answerCount: normalizedAnswers ? Object.keys(normalizedAnswers).length : 0,
      cancelled: normalizedAnswers === null
    });
  }

  interrupt(sessionId: string): void {
    const running = this.processes.get(sessionId);
    if (!running || running.stopping) {
      return;
    }
    const requestId = randomUUID();
    running.process.stdin.write(`${JSON.stringify({
      type: "control_request",
      request_id: requestId,
      request: { subtype: "interrupt" }
    })}\n`);
    logInfo("structured-claude", "interrupt-requested", { sessionId, requestId });
  }

  stop(sessionId: string): void {
    logInfo("structured-claude", "stop-requested", { sessionId });
    const running = this.processes.get(sessionId);
    if (!running) {
      const session = this.store.getSession(sessionId);
      if (session?.status === "running" || session?.status === "stopping") {
        const exited = this.store.updateSession(sessionId, {
          status: "exited",
          exitedAt: new Date().toISOString()
        });
        this.emitSession(exited);
      }
      return;
    }
    running.stopping = true;
    const stopping = this.store.updateSession(sessionId, {
      status: "stopping",
      lastActiveAt: new Date().toISOString()
    });
    this.emitSession(stopping);
    running.process.kill("SIGTERM");
  }

  stopAll(): void {
    logInfo("structured-claude", "stop-all", { count: this.processes.size });
    for (const running of this.processes.values()) {
      running.stopping = true;
      running.process.kill("SIGTERM");
    }
  }

  discardSession(sessionId: string): void {
    this.snapshots.delete(sessionId);
    this.permissions.delete(sessionId);
    this.questions.delete(sessionId);
    this.activityStates.delete(sessionId);
    logInfo("structured-history", "memory-discarded", { sessionId });
  }

  getSnapshot(sessionId: string): StructuredSessionSnapshot {
    const snapshot = this.snapshots.get(sessionId) ?? createStructuredSnapshot(sessionId);
    return cloneSnapshot(snapshot);
  }

  private spawnClaude(
    session: SessionRecord,
    cwd: string,
    mode: "new" | "resume"
  ): SessionRecord {
    const claudePath = resolveClaudePath();
    if (!claudePath) {
      const failed = this.store.updateSession(session.id, {
        status: "failed",
        error: "未找到 claude 命令。"
      });
      this.emitSession(failed);
      return failed;
    }

    const settings = this.settingsStore.getSettings();
    const appendPromptApplied =
      settings.enableBlockedPromptInstruction &&
      Boolean(this.activityHooks) &&
      supportsAppendSystemPrompt(claudePath);
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--input-format",
      "stream-json",
      "--include-partial-messages",
      "--verbose",
      "--permission-prompt-tool",
      "stdio",
      "--effort",
      settings.defaultEffort
    ];
    if (this.activityHooks) {
      args.push("--plugin-dir", this.activityHooks.pluginDir);
    }
    if (appendPromptApplied) {
      args.push("--append-system-prompt", BLOCKED_PROMPT_INSTRUCTION);
    }
    if (mode === "resume") {
      args.push(`--resume=${session.claudeSessionId}`);
    } else {
      args.push(`--session-id=${session.claudeSessionId}`);
    }

    const startedAt = new Date().toISOString();
    const runningSession = this.store.updateSession(session.id, {
      status: "running",
      startedAt,
      lastActiveAt: startedAt,
      error: undefined
    });
    const snapshot = this.getMutableSnapshot(session.id);
    snapshot.initialized = false;
    snapshot.busy = false;
    snapshot.busyStartedAt = undefined;
    snapshot.activityLabel = undefined;
    snapshot.error = undefined;
    snapshot.permissionRequests = [];
    snapshot.questionRequests = [];
    snapshot.streamingText = undefined;
    snapshot.streamingPhase = undefined;
    snapshot.slashCommands = [];
    snapshot.effort = settings.defaultEffort;

    logInfo("structured-claude", "spawn-requested", {
      sessionId: session.id,
      claudeSessionId: session.claudeSessionId,
      projectId: session.projectId,
      mode,
      effort: settings.defaultEffort,
      blockedPromptInstructionApplied: appendPromptApplied,
      partialMessagesEnabled: true,
      supportedDialogKindCount: 1
    });

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(claudePath, args, {
        cwd,
        env: {
          ...getLoginEnv(),
          ...(this.activityHooks ? this.activityHooks.environmentFor(session.id) : {}),
          // 与 Claude 官方 SDK/VS Code 插件一致，启用 stream-json 的 SDK 传输语义。
          CLAUDE_CODE_ENTRYPOINT: "sdk-ts"
        },
        stdio: ["pipe", "pipe", "pipe"]
      });
    } catch (error) {
      logError("structured-claude", "spawn-failed", error, { sessionId: session.id, mode });
      const failed = this.store.updateSession(session.id, {
        status: "failed",
        error: error instanceof Error ? error.message : String(error)
      });
      this.emitSession(failed);
      return failed;
    }

    const running: StructuredProcess = {
      sessionId: session.id,
      process: child,
      stdoutPending: "",
      stderr: "",
      stderrBytes: 0,
      stopping: false
    };
    this.processes.set(session.id, running);
    this.permissions.set(session.id, new Map());
    this.questions.set(session.id, new Map());
    this.setActivityState(session.id, "idle", "structured:spawned");
    this.emitSession(runningSession);
    this.emitSnapshot(session.id);
    logInfo("structured-claude", "spawned", { sessionId: session.id, pid: child.pid, mode });

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (data: string) => this.consumeStdout(running, data));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (data: string) => {
      running.stderrBytes += Buffer.byteLength(data, "utf8");
      running.stderr = `${running.stderr}${data}`.slice(-MAX_STDERR_CHARS);
    });
    child.on("error", (error) => {
      logError("structured-claude", "process-error", error, { sessionId: session.id, pid: child.pid });
      const mutable = this.getMutableSnapshot(session.id);
      mutable.error = error.message;
      mutable.items.push({
        id: `process-error:${randomUUID()}`,
        kind: "notice",
        text: error.message,
        tone: "error",
        createdAt: new Date().toISOString()
      });
      this.trimSnapshot(mutable, "process-error");
      this.emitSnapshot(session.id);
    });
    child.on("exit", (exitCode, signal) => this.handleExit(running, exitCode, signal));
    this.initializeDialogBridge(running);
    return runningSession;
  }

  /** 声明 renderer 真正支持的原生对话框，Claude 才会把 AskUserQuestion 交给本应用。 */
  private initializeDialogBridge(running: StructuredProcess): void {
    const requestId = randomUUID();
    running.initializeRequestId = requestId;
    running.process.stdin.write(`${JSON.stringify({
      type: "control_request",
      request_id: requestId,
      request: {
        subtype: "initialize",
        supportedDialogKinds: [ASK_USER_QUESTION_DIALOG_KIND]
      }
    })}\n`);
    logInfo("structured-control", "initialize-sent", {
      sessionId: running.sessionId,
      requestId,
      supportedDialogKindCount: 1
    });
  }

  private consumeStdout(running: StructuredProcess, data: string): void {
    running.stdoutPending += data;
    if (running.stdoutPending.length > MAX_STDOUT_PENDING_CHARS && !running.stdoutPending.includes("\n")) {
      logWarn("structured-protocol", "unterminated-line-discarded", {
        sessionId: running.sessionId,
        charCount: running.stdoutPending.length
      });
      running.stdoutPending = "";
      return;
    }

    for (;;) {
      const lineEnd = running.stdoutPending.indexOf("\n");
      if (lineEnd < 0) {
        break;
      }
      const line = running.stdoutPending.slice(0, lineEnd);
      running.stdoutPending = running.stdoutPending.slice(lineEnd + 1);
      if (!line.trim()) {
        continue;
      }
      try {
        this.handleProtocolMessage(running.sessionId, JSON.parse(line) as unknown, line.length);
      } catch (error) {
        // 不记录原始行，防止 Prompt、命令或代码进入系统日志。
        logWarn("structured-protocol", "invalid-json-line", {
          sessionId: running.sessionId,
          charCount: line.length,
          errorName: error instanceof Error ? error.name : "unknown"
        });
      }
    }
  }

  private handleProtocolMessage(sessionId: string, message: unknown, byteLikeCount: number): void {
    if (isRecord(message) && message.type === "control_response") {
      this.handleControlResponse(sessionId, message);
      return;
    }
    if (isRecord(message) && message.type === "control_request") {
      this.handleControlRequest(sessionId, message);
      return;
    }
    if (isRecord(message) && message.type === "control_cancel_request") {
      const requestId = typeof message.request_id === "string" ? message.request_id : undefined;
      if (requestId) {
        this.removePermission(sessionId, requestId);
        this.removeQuestion(sessionId, requestId);
        this.emitSnapshot(sessionId);
      }
      return;
    }
    if (isRecord(message) && message.type === "stream_event") {
      this.handleStreamEvent(sessionId, message);
      return;
    }

    const running = this.processes.get(sessionId);
    if (running && isRecord(message) && message.type === "assistant") {
      // 每条完整 assistant 消息对应一段增量流；这里只汇总数量和耗时，不记录任何正文。
      this.finishStreamStats(running, "assistant", true);
    } else if (running && isRecord(message) && message.type === "result" && running.streamStats) {
      this.finishStreamStats(running, "result");
    }
    const snapshot = this.getMutableSnapshot(sessionId);
    const hadStreamingState = snapshot.streamingText !== undefined || snapshot.streamingPhase !== undefined;
    const result = applyStructuredProtocolMessage(snapshot, message, false);
    if (!result.changed) {
      if (hadStreamingState && snapshot.streamingText === undefined && snapshot.streamingPhase === undefined) {
        this.emitSnapshot(sessionId);
      }
      return;
    }
    if (result.eventType === "result" && running?.pendingCommandName) {
      const commandName = running.pendingCommandName;
      const failed = isRecord(message) && message.is_error === true;
      if (!failed) {
        snapshot.items.push({
          id: `command-result:${randomUUID()}`,
          kind: "notice",
          text: `命令 ${commandName} 已执行完成。`,
          tone: "muted",
          createdAt: new Date().toISOString()
        });
      }
      logInfo("structured-command", failed ? "failed" : "completed", {
        sessionId,
        commandName
      });
      running.pendingCommandName = undefined;
    }
    this.trimSnapshot(snapshot, result.eventType ?? "unknown");
    if (result.activity) {
      const nextActivity =
        result.activity === "idle" && this.pendingInteractionCount(sessionId) > 0
          ? "blocked"
          : result.activity;
      this.setActivityState(sessionId, nextActivity, `structured:${result.eventType ?? "message"}`);
    }
    this.emitSnapshot(sessionId);
    logInfo("structured-protocol", "event-applied", {
      sessionId,
      eventType: result.eventType,
      toolNames: result.toolNames,
      itemCount: snapshot.items.length,
      permissionCount: snapshot.permissionRequests.length,
      questionCount: snapshot.questionRequests.length,
      charCount: byteLikeCount
    });
    if (result.eventType === "system:init" || result.eventType === "result") {
      logInfo("structured-runtime", result.eventType === "system:init" ? "initialized" : "usage-updated", {
        sessionId,
        model: snapshot.model,
        effort: snapshot.effort,
        contextUsedTokens: snapshot.contextUsedTokens,
        contextWindowTokens: snapshot.contextWindowTokens
      });
    }
  }

  /** initialize 响应会在首条 Prompt 前返回命令元数据，不能等到延迟到来的 system:init。 */
  private handleControlResponse(sessionId: string, message: Record<string, unknown>): void {
    const running = this.processes.get(sessionId);
    const envelope = isRecord(message.response) ? message.response : undefined;
    const requestId = typeof envelope?.request_id === "string" ? envelope.request_id : undefined;
    if (!running || !requestId || requestId !== running.initializeRequestId) {
      return;
    }
    running.initializeRequestId = undefined;

    if (envelope?.subtype !== "success" || !isRecord(envelope.response)) {
      logWarn("structured-control", "initialize-failed", {
        sessionId,
        requestId,
        subtype: typeof envelope?.subtype === "string" ? envelope.subtype : "unknown"
      });
      return;
    }

    const snapshot = this.getMutableSnapshot(sessionId);
    const commands = normalizeSlashCommands(envelope.response.commands);
    snapshot.initialized = true;
    snapshot.slashCommands = commands;
    this.emitSnapshot(sessionId);
    // 只记录命令数量，不记录命令名称、描述或参数提示。
    logInfo("structured-control", "initialize-completed", {
      sessionId,
      requestId,
      commandCount: commands.length
    });
  }

  /** 文本增量走轻量事件，避免每个 token 都把数百条历史消息重新克隆给 renderer。 */
  private handleStreamEvent(sessionId: string, message: Record<string, unknown>): void {
    const running = this.processes.get(sessionId);
    const event = isRecord(message.event) ? message.event : undefined;
    if (!running || !event) {
      return;
    }
    const snapshot = this.getMutableSnapshot(sessionId);
    if (event.type === "message_start") {
      if (running.streamStats) {
        this.finishStreamStats(running, "message-restarted");
      }
      running.streamStats = createStreamStats();
      running.streamStats.streamEventCount = 1;
      if (snapshot.streamingText !== undefined || snapshot.streamingPhase !== undefined) {
        snapshot.streamingText = undefined;
        snapshot.streamingPhase = undefined;
        this.emitTextDelta(sessionId, undefined, true);
      }
      return;
    }
    const stats = running.streamStats ?? createStreamStats();
    running.streamStats = stats;
    stats.streamEventCount += 1;
    const delta = isRecord(event.delta) ? event.delta : undefined;
    if (event.type !== "content_block_delta" || !delta) {
      return;
    }
    if (delta.type === "thinking_delta") {
      stats.thinkingDeltaCount += 1;
      if (snapshot.streamingPhase !== "thinking") {
        snapshot.streamingPhase = "thinking";
        snapshot.busy = true;
        snapshot.busyStartedAt ??= new Date().toISOString();
        snapshot.activityLabel = "Claude 思考中";
        this.setActivityState(sessionId, "working", "structured:thinking-delta");
        // 思考正文仍由完整 assistant 事件落卡，这里只通知阶段，避免高频渲染隐藏内容。
        this.emitTextDelta(sessionId, undefined, false, "thinking");
      }
      return;
    }
    if (delta.type === "input_json_delta") {
      stats.inputJsonDeltaCount += 1;
      return;
    }
    if (delta.type !== "text_delta" || typeof delta.text !== "string") {
      return;
    }
    const now = Date.now();
    stats.textDeltaCount += 1;
    stats.textCharCount += delta.text.length;
    stats.firstTextDeltaAt ??= now;
    stats.lastTextDeltaAt = now;

    const current = snapshot.streamingText ?? "";
    const available = Math.max(0, MAX_STREAMING_TEXT_CHARS - current.length);
    const appended = delta.text.slice(0, available);
    if (!appended) {
      return;
    }
    snapshot.streamingText = `${current}${appended}`;
    snapshot.streamingPhase = "responding";
    snapshot.busy = true;
    snapshot.busyStartedAt ??= new Date().toISOString();
    snapshot.activityLabel = "Claude 回复中";
    this.setActivityState(sessionId, "working", "structured:text-delta");
    this.emitTextDelta(sessionId, appended, false, "responding");
  }

  /** 每条消息只写一条脱敏汇总，既能判断是否真的流式，又不会把 Prompt 或回复写入日志。 */
  private finishStreamStats(
    running: StructuredProcess,
    completion: "assistant" | "result" | "message-restarted" | "process-exit",
    logWhenMissing = false
  ): void {
    const stats = running.streamStats;
    running.streamStats = undefined;
    if (!stats && !logWhenMissing) {
      return;
    }
    const now = Date.now();
    logInfo("structured-stream", "message-completed", {
      sessionId: running.sessionId,
      completion,
      streamEventCount: stats?.streamEventCount ?? 0,
      textDeltaCount: stats?.textDeltaCount ?? 0,
      textCharCount: stats?.textCharCount ?? 0,
      thinkingDeltaCount: stats?.thinkingDeltaCount ?? 0,
      inputJsonDeltaCount: stats?.inputJsonDeltaCount ?? 0,
      messageDurationMs: stats ? Math.max(0, now - stats.startedAt) : 0,
      textStreamDurationMs: stats?.firstTextDeltaAt && stats.lastTextDeltaAt
        ? Math.max(0, stats.lastTextDeltaAt - stats.firstTextDeltaAt)
        : 0
    });
  }

  private emitTextDelta(
    sessionId: string,
    text: string | undefined,
    reset: boolean,
    phase?: "thinking" | "responding"
  ): void {
    this.getMainWindow()?.webContents.send("structured:text-delta", {
      sessionId,
      text,
      phase,
      reset
    });
  }

  private handleControlRequest(sessionId: string, event: Record<string, unknown>): void {
    const requestId = typeof event.request_id === "string" ? event.request_id : undefined;
    const request = isRecord(event.request) ? event.request : undefined;
    if (!requestId || !request) {
      logWarn("structured-control", "unsupported-request", {
        sessionId,
        requestId,
        subtype: "unknown"
      });
      return;
    }

    if (request.subtype === "request_user_dialog") {
      this.handleUserDialogRequest(sessionId, requestId, request);
      return;
    }

    if (request.subtype !== "can_use_tool") {
      const running = this.processes.get(sessionId);
      if (running) {
        const controlResponse = {
          type: "control_response",
          response: {
            subtype: "error",
            request_id: requestId,
            error: `Unsupported control request: ${String(request.subtype)}`
          }
        };
        running.process.stdin.write(`${JSON.stringify(controlResponse)}\n`);
      }
      logWarn("structured-control", "unsupported-request", {
        sessionId,
        requestId,
        subtype: typeof request.subtype === "string" ? request.subtype : "unknown",
        responseSent: Boolean(running)
      });
      return;
    }

    const toolName = typeof request.tool_name === "string" ? request.tool_name : "未知工具";
    const toolUseId = typeof request.tool_use_id === "string" ? request.tool_use_id : undefined;
    const questions = toolName === "AskUserQuestion" ? normalizeQuestionsFromInput(request.input) : [];
    if (questions.length > 0) {
      // 兼容未支持原生 dialog 握手的 Claude 版本：AskUserQuestion 仍直接展示问题，不先询问工具权限。
      this.queueQuestion(sessionId, {
        publicRequest: {
          requestId,
          toolUseId,
          questions,
          createdAt: new Date().toISOString()
        },
        originalInput: request.input
      });
      return;
    }
    const publicRequest: StructuredPermissionRequest = {
      requestId,
      toolUseId,
      toolName,
      input: toStructuredDisplayValue(request.input),
      title: typeof request.title === "string" ? request.title : undefined,
      description: typeof request.description === "string" ? request.description : undefined,
      createdAt: new Date().toISOString()
    };
    const permissionMap = this.permissions.get(sessionId) ?? new Map<string, InternalPermissionRequest>();
    permissionMap.set(requestId, { publicRequest, originalInput: request.input });
    this.permissions.set(sessionId, permissionMap);
    const snapshot = this.getMutableSnapshot(sessionId);
    snapshot.permissionRequests = [...permissionMap.values()].map((value) => value.publicRequest);
    snapshot.busy = false;
    snapshot.busyStartedAt = undefined;
    snapshot.activityLabel = undefined;
    this.setActivityState(sessionId, "blocked", "structured:permission-requested");
    this.emitSnapshot(sessionId);
    logInfo("structured-permission", "requested", {
      sessionId,
      requestId,
      toolUseId,
      toolName,
      permissionCount: permissionMap.size
    });
  }

  private handleUserDialogRequest(
    sessionId: string,
    requestId: string,
    request: Record<string, unknown>
  ): void {
    const dialogKind = typeof request.dialog_kind === "string" ? request.dialog_kind : "unknown";
    const payload = isRecord(request.payload) ? request.payload : undefined;
    const questions = dialogKind === ASK_USER_QUESTION_DIALOG_KIND
      ? normalizeQuestions(payload?.questions)
      : [];
    if (!payload || questions.length === 0) {
      this.cancelUnsupportedDialog(sessionId, requestId, dialogKind);
      return;
    }

    const payloadRequestId = typeof payload.requestId === "string" ? payload.requestId : undefined;
    const toolUseId = typeof request.tool_use_id === "string" ? request.tool_use_id : payloadRequestId;
    const originalInput = isRecord(payload.input)
      ? payload.input
      : { questions: payload.questions };
    this.queueQuestion(sessionId, {
      publicRequest: {
        requestId,
        toolUseId,
        questions,
        createdAt: new Date().toISOString()
      },
      originalInput
    });
  }

  private queueQuestion(sessionId: string, pending: InternalQuestionRequest): void {
    const questionMap = this.questions.get(sessionId) ?? new Map<string, InternalQuestionRequest>();
    questionMap.set(pending.publicRequest.requestId, pending);
    this.questions.set(sessionId, questionMap);
    const snapshot = this.getMutableSnapshot(sessionId);
    snapshot.questionRequests = [...questionMap.values()].map((value) => value.publicRequest);
    snapshot.busy = false;
    snapshot.busyStartedAt = undefined;
    snapshot.activityLabel = undefined;
    this.setActivityState(sessionId, "blocked", "structured:question-requested");
    this.emitSnapshot(sessionId);
    logInfo("structured-question", "requested", {
      sessionId,
      requestId: pending.publicRequest.requestId,
      toolUseId: pending.publicRequest.toolUseId,
      questionCount: pending.publicRequest.questions.length,
      pendingCount: questionMap.size
    });
  }

  private cancelUnsupportedDialog(sessionId: string, requestId: string, dialogKind: string): void {
    const running = this.processes.get(sessionId);
    running?.process.stdin.write(`${JSON.stringify({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: requestId,
        response: { behavior: "cancelled" }
      }
    })}\n`);
    const snapshot = this.getMutableSnapshot(sessionId);
    snapshot.items.push({
      id: `unsupported-dialog:${requestId}`,
      kind: "notice",
      text: "该 Claude 交互弹窗暂不受结构化模式支持，请在原生终端模式中执行。",
      tone: "muted",
      createdAt: new Date().toISOString()
    });
    this.trimSnapshot(snapshot, "unsupported-dialog");
    this.emitSnapshot(sessionId);
    logWarn("structured-control", "unsupported-dialog", {
      sessionId,
      requestId,
      dialogKind,
      responseSent: Boolean(running)
    });
  }

  private removePermission(sessionId: string, requestId: string): void {
    const permissionMap = this.permissions.get(sessionId);
    permissionMap?.delete(requestId);
    const snapshot = this.getMutableSnapshot(sessionId);
    snapshot.permissionRequests = permissionMap
      ? [...permissionMap.values()].map((value) => value.publicRequest)
      : [];
  }

  private removeQuestion(sessionId: string, requestId: string): void {
    const questionMap = this.questions.get(sessionId);
    questionMap?.delete(requestId);
    const snapshot = this.getMutableSnapshot(sessionId);
    snapshot.questionRequests = questionMap
      ? [...questionMap.values()].map((value) => value.publicRequest)
      : [];
  }

  private pendingInteractionCount(sessionId: string): number {
    return (this.permissions.get(sessionId)?.size ?? 0) + (this.questions.get(sessionId)?.size ?? 0);
  }

  private handleExit(running: StructuredProcess, exitCode: number | null, signal: NodeJS.Signals | null): void {
    const sessionId = running.sessionId;
    if (this.processes.get(sessionId) !== running) {
      return;
    }
    this.finishStreamStats(running, "process-exit");
    this.processes.delete(sessionId);
    this.permissions.delete(sessionId);
    this.questions.delete(sessionId);
    this.activityStates.delete(sessionId);
    const snapshot = this.getMutableSnapshot(sessionId);
    snapshot.busy = false;
    snapshot.busyStartedAt = undefined;
    snapshot.activityLabel = undefined;
    snapshot.permissionRequests = [];
    snapshot.questionRequests = [];
    snapshot.streamingText = undefined;
    snapshot.streamingPhase = undefined;

    const failed = !running.stopping && exitCode !== 0;
    if (failed) {
      const message = running.stderr.trim() || `Claude 结构化进程异常退出（退出码 ${exitCode ?? "未知"}）。`;
      snapshot.error = message;
      snapshot.items.push({
        id: `exit:${randomUUID()}`,
        kind: "notice",
        text: message,
        tone: "error",
        createdAt: new Date().toISOString()
      });
      this.trimSnapshot(snapshot, "process-exit");
    }

    const existing = this.store.getSession(sessionId);
    if (existing) {
      const exited = this.store.updateSession(sessionId, {
        status: failed ? "failed" : "exited",
        exitCode: exitCode ?? undefined,
        exitedAt: new Date().toISOString(),
        error: failed ? snapshot.error : undefined
      });
      this.emitSession(exited);
    }
    this.emitSnapshot(sessionId);
    logInfo("structured-claude", "exited", {
      sessionId,
      pid: running.process.pid,
      exitCode,
      signal,
      stopping: running.stopping,
      stderrBytes: running.stderrBytes,
      itemCount: snapshot.items.length
    });
  }

  private trimSnapshot(snapshot: StructuredSessionSnapshot, trigger: string): void {
    const initialCount = snapshot.items.length;
    let chars = estimateSnapshotText(snapshot);
    while (
      snapshot.items.length > 1 &&
      (snapshot.items.length > MAX_SNAPSHOT_ITEMS || chars > MAX_SNAPSHOT_TEXT_CHARS)
    ) {
      snapshot.items.shift();
      chars = estimateSnapshotText(snapshot);
    }
    if (snapshot.items.length !== initialCount) {
      logInfo("structured-history", "memory-trimmed", {
        sessionId: snapshot.sessionId,
        trigger,
        removedItems: initialCount - snapshot.items.length,
        itemCount: snapshot.items.length,
        estimatedChars: chars
      });
    }
  }

  private getMutableSnapshot(sessionId: string): StructuredSessionSnapshot {
    const existing = this.snapshots.get(sessionId);
    if (existing) {
      return existing;
    }
    const snapshot = createStructuredSnapshot(sessionId);
    this.snapshots.set(sessionId, snapshot);
    return snapshot;
  }

  private emitSnapshot(sessionId: string): void {
    this.getMainWindow()?.webContents.send("structured:snapshot-updated", {
      sessionId,
      snapshot: this.getSnapshot(sessionId)
    });
  }

  private emitSession(session: SessionRecord): void {
    this.getMainWindow()?.webContents.send("session:updated", session);
    this.callbacks.onSessionChanged?.();
  }

  private setActivityState(sessionId: string, state: SessionActivityStatus, source: string): void {
    const previous = this.activityStates.get(sessionId);
    if (previous?.state === "blocked" && state === "idle" && source === "hook:stop") {
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
      source,
      mode: "structured"
    });
    this.getMainWindow()?.webContents.send("session:activity-state", next);
    this.callbacks.onActivityChanged?.(next, previous?.state, source);
  }
}

function cloneSnapshot(snapshot: StructuredSessionSnapshot): StructuredSessionSnapshot {
  return {
    ...snapshot,
    items: snapshot.items.map((item) =>
      item.kind === "tool"
        ? { ...item, tool: { ...item.tool, input: structuredClone(item.tool.input) } }
        : { ...item }
    ),
    permissionRequests: snapshot.permissionRequests.map((request) => ({
      ...request,
      input: structuredClone(request.input)
    })),
    questionRequests: snapshot.questionRequests.map((request) => ({
      ...request,
      questions: request.questions.map((question) => ({
        ...question,
        options: question.options.map((option) => ({ ...option }))
      }))
    })),
    slashCommands: snapshot.slashCommands.map((command) => ({ ...command }))
  };
}

function createStreamStats(): StructuredStreamStats {
  return {
    startedAt: Date.now(),
    streamEventCount: 0,
    textDeltaCount: 0,
    textCharCount: 0,
    thinkingDeltaCount: 0,
    inputJsonDeltaCount: 0
  };
}

function estimateSnapshotText(snapshot: StructuredSessionSnapshot): number {
  return snapshot.items.reduce((total, item) => {
    if (item.kind === "tool") {
      return total + safeLength(item.tool.input) + (item.tool.output?.length ?? 0);
    }
    return total + item.text.length;
  }, 0);
}

function safeLength(value: unknown): number {
  try {
    return JSON.stringify(value).length;
  } catch {
    return 0;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeQuestionsFromInput(input: unknown): StructuredQuestion[] {
  return isRecord(input) ? normalizeQuestions(input.questions) : [];
}

/** 只接收 Claude AskUserQuestion 的有限结构，防止任意 dialog payload 进入 renderer。 */
function normalizeQuestions(value: unknown): StructuredQuestion[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4) {
    return [];
  }
  const normalized: StructuredQuestion[] = [];
  for (const rawQuestion of value) {
    if (!isRecord(rawQuestion) || typeof rawQuestion.question !== "string") {
      return [];
    }
    const question = rawQuestion.question.trim();
    if (!question || question.length > 50_000 || !Array.isArray(rawQuestion.options)) {
      return [];
    }
    if (rawQuestion.options.length < 2 || rawQuestion.options.length > 4) {
      return [];
    }
    const options = rawQuestion.options.map((rawOption) => {
      if (!isRecord(rawOption) || typeof rawOption.label !== "string") {
        return undefined;
      }
      const label = rawOption.label.trim();
      if (!label || label.length > 500) {
        return undefined;
      }
      return {
        label,
        description: typeof rawOption.description === "string"
          ? rawOption.description.slice(0, 20_000)
          : undefined,
        preview: typeof rawOption.preview === "string" ? rawOption.preview.slice(0, 50_000) : undefined
      };
    });
    if (options.some((option) => option === undefined)) {
      return [];
    }
    normalized.push({
      question,
      header: typeof rawQuestion.header === "string" ? rawQuestion.header.slice(0, 200) : undefined,
      options: options as StructuredQuestion["options"],
      multiSelect: rawQuestion.multiSelect === true
    });
  }
  return normalized;
}

function validateQuestionAnswers(
  questions: StructuredQuestion[],
  answers: unknown
): StructuredQuestionAnswers {
  if (!isRecord(answers)) {
    throw new Error("问题答案格式无效。");
  }
  const normalized = Object.create(null) as StructuredQuestionAnswers;
  for (const question of questions) {
    const answer = answers[question.question];
    if (typeof answer !== "string" || !answer.trim()) {
      throw new Error("请回答全部问题后再提交。");
    }
    if (answer.length > 50_000) {
      throw new Error("单个问题的答案过长。");
    }
    normalized[question.question] = answer.trim();
  }
  return normalized;
}

function mergeQuestionAnswers(
  originalInput: unknown,
  questions: StructuredQuestion[],
  answers: StructuredQuestionAnswers
): Record<string, unknown> {
  const input = isRecord(originalInput) ? { ...originalInput } : { questions };
  return { ...input, answers };
}

function formatShortDate(date: Date): string {
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  const hour = `${date.getHours()}`.padStart(2, "0");
  const minute = `${date.getMinutes()}`.padStart(2, "0");
  return `${month}-${day} ${hour}:${minute}`;
}

function slashCommandName(
  text: string,
  commands: ReadonlyArray<{ name: string }>
): string | undefined {
  const match = /^\s*(\/[^\s]{1,120})(?:\s|$)/u.exec(text);
  const requested = match?.[1];
  return requested && commands.some((command) => command.name === requested)
    ? requested
    : undefined;
}
