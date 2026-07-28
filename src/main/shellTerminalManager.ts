import { BrowserWindow } from "electron";
import * as pty from "node-pty";
import type { IPty } from "node-pty";
import { existsSync } from "node:fs";
import type { ShellTerminalInfo } from "../shared/types";
import { getLoginEnv, getShellPath } from "./environment";
import type { AppStore } from "./store";
import { logError, logInfo, logWarn } from "./appLogger";
import { PtyOutputGate } from "./ptyOutputGate";

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 14;
const MAX_BUFFER_CHARS = 250_000;

type ShellProcess = {
  projectId: string;
  cwd: string;
  process: IPty;
  cols: number;
  rows: number;
};

type ShellOutputBuffer = {
  chunks: string[];
  size: number;
};

/** 管理每个项目至多一个底部登录 shell，并缓存有限输出供面板重新打开时回放。 */
export class ShellTerminalManager {
  private readonly shells = new Map<string, ShellProcess>();
  private readonly outputBuffers = new Map<string, ShellOutputBuffer>();
  private readonly outputGate: PtyOutputGate;

  constructor(
    private readonly store: AppStore,
    private readonly getMainWindow: () => BrowserWindow | null
  ) {
    this.outputGate = new PtyOutputGate(
      "shell",
      (projectId) => this.shells.get(projectId)?.process,
      (projectId, data) => this.getMainWindow()?.webContents.send("shell:data", { projectId, data }),
      (projectId) => this.getMainWindow()?.webContents.send("shell:output-resumed", { projectId })
    );
  }

  isRunning(projectId: string): boolean {
    return this.shells.has(projectId);
  }

  setOutputPaused(paused: boolean, trigger: string): void {
    this.outputGate.setPaused(paused, trigger);
  }

  open(projectId: string): ShellTerminalInfo {
    const running = this.shells.get(projectId);
    if (running) {
      logInfo("project-terminal", "reuse-running", { projectId, cwd: running.cwd, pid: running.process.pid });
      return {
        projectId,
        cwd: running.cwd
      };
    }

    const project = this.store.getProject(projectId);
    if (!project) {
      logWarn("project-terminal", "project-not-found", { projectId });
      throw new Error("项目不存在。");
    }

    if (project.missing || !existsSync(project.path)) {
      logWarn("project-terminal", "project-path-missing", { projectId, path: project.path });
      throw new Error(`项目路径不存在：${project.path}`);
    }

    let ptyProcess: IPty;
    try {
      ptyProcess = pty.spawn(getShellPath(), ["-l"], {
        name: "xterm-256color",
        cols: DEFAULT_COLS,
        rows: DEFAULT_ROWS,
        cwd: project.path,
        env: {
          ...getLoginEnv(),
          TERM: "xterm-256color",
          COLORTERM: "truecolor"
        }
      });
    } catch (error) {
      logError("project-terminal", "spawn-failed", error, { projectId, cwd: project.path });
      throw error;
    }

    logInfo("project-terminal", "spawned", { projectId, cwd: project.path, pid: ptyProcess.pid });

    this.shells.set(projectId, {
      projectId,
      cwd: project.path,
      process: ptyProcess,
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS
    });
    this.outputBuffers.set(projectId, {
      chunks: [],
      size: 0
    });

    ptyProcess.onData((data) => {
      appendOutput(this.getOutputBuffer(projectId), data);
      this.outputGate.deliver(projectId, data);
    });

    ptyProcess.onExit(({ exitCode }) => {
      logInfo("project-terminal", "exited", { projectId, pid: ptyProcess.pid, exitCode });
      this.shells.delete(projectId);
      this.outputBuffers.delete(projectId);
      this.outputGate.complete(projectId, () => {
        this.getMainWindow()?.webContents.send("shell:exit", {
          projectId,
          exitCode
        });
      });
    });

    return {
      projectId,
      cwd: project.path
    };
  }

  write(projectId: string, data: string): void {
    this.shells.get(projectId)?.process.write(data);
  }

  resize(projectId: string, cols: number, rows: number): void {
    const shell = this.shells.get(projectId);
    if (!shell) {
      return;
    }

    shell.cols = cols;
    shell.rows = rows;
    shell.process.resize(cols, rows);
  }

  stop(projectId: string): void {
    logInfo("project-terminal", "stop-requested", { projectId });
    const shell = this.shells.get(projectId);
    if (!shell) {
      this.outputBuffers.delete(projectId);
      this.outputGate.remove(projectId);
      return;
    }

    this.outputGate.remove(projectId);
    shell.process.kill();
    this.shells.delete(projectId);
    this.outputBuffers.delete(projectId);
  }

  stopAll(): void {
    logInfo("project-terminal", "stop-all", { count: this.shells.size });
    this.outputGate.clear();
    for (const shell of this.shells.values()) {
      shell.process.kill();
    }
    this.shells.clear();
    this.outputBuffers.clear();
  }

  getBuffer(projectId: string): string[] {
    const chunks = [...(this.outputBuffers.get(projectId)?.chunks ?? [])];
    this.outputGate.supersedePendingWithSnapshot(projectId);
    return chunks;
  }

  private getOutputBuffer(projectId: string): ShellOutputBuffer {
    const existing = this.outputBuffers.get(projectId);
    if (existing) {
      return existing;
    }

    const created = {
      chunks: [],
      size: 0
    };
    this.outputBuffers.set(projectId, created);
    return created;
  }
}

function appendOutput(buffer: ShellOutputBuffer, data: string): void {
  buffer.chunks.push(data);
  buffer.size += data.length;

  // 项目终端同样采用有界缓存，避免后台常驻 shell 无限占用内存。
  while (buffer.size > MAX_BUFFER_CHARS && buffer.chunks.length > 1) {
    const removed = buffer.chunks.shift() ?? "";
    buffer.size -= removed.length;
  }
}
