import type { IPty } from "node-pty";
import { logInfo, logWarn } from "./appLogger";

const MAX_PAUSED_OUTPUT_CHARS = 8 * 1024 * 1024;
const OUTPUT_BATCH_CHARS = 64 * 1024;

type PendingOutput = {
  chunks: string[];
  size: number;
  processPaused: boolean;
  afterFlush: Array<() => void>;
};

/**
 * 锁屏或系统暂停时暂存 PTY 原始输出，避免把大量细碎 IPC 推给暂停中的 renderer。
 * 队列达到上限后暂停读取 IPty；解锁时先按原序发送积压，再恢复读取，保证不丢控制序列。
 */
export class PtyOutputGate {
  private readonly pending = new Map<string, PendingOutput>();
  private paused = false;
  private pausedAt: number | undefined;

  constructor(
    private readonly surface: "claude" | "shell",
    private readonly getProcess: (identifier: string) => IPty | undefined,
    private readonly sendData: (identifier: string, data: string) => void,
    private readonly sendResumed: (identifier: string) => void
  ) {}

  setPaused(paused: boolean, trigger: string): void {
    if (this.paused === paused) {
      return;
    }

    this.paused = paused;
    if (paused) {
      this.pausedAt = Date.now();
      logInfo("terminal-output-flow", "delivery-paused", { surface: this.surface, trigger });
      return;
    }

    const pausedDurationMs = this.pausedAt ? Date.now() - this.pausedAt : undefined;
    this.pausedAt = undefined;
    for (const identifier of [...this.pending.keys()]) {
      this.flush(identifier, trigger, pausedDurationMs);
    }
  }

  deliver(identifier: string, data: string): void {
    if (!this.paused) {
      this.sendData(identifier, data);
      return;
    }

    const current: PendingOutput = this.pending.get(identifier) ?? {
      chunks: [],
      size: 0,
      processPaused: false,
      afterFlush: []
    };
    current.chunks.push(data);
    current.size += data.length;
    this.pending.set(identifier, current);

    if (current.size < MAX_PAUSED_OUTPUT_CHARS || current.processPaused) {
      return;
    }

    const process = this.getProcess(identifier);
    if (!process) {
      return;
    }
    try {
      // 超过上限后用 PTY 自身背压保留后续输出，避免无限扩大主进程内存。
      process.pause();
      current.processPaused = true;
      logWarn("terminal-output-flow", "pty-paused", {
        surface: this.surface,
        identifier,
        pendingChars: current.size
      });
    } catch (error) {
      logWarn("terminal-output-flow", "pty-pause-failed", {
        surface: this.surface,
        identifier,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  /**
   * renderer 在暂停期间重新加载或切换终端时，会从主进程缓存回放一份完整快照。
   * 快照已经包含此前的暂停输出，因此将旧积压作废，只保留快照之后新到达的数据。
   */
  supersedePendingWithSnapshot(identifier: string): void {
    if (!this.paused) {
      return;
    }

    const current = this.pending.get(identifier);
    if (!current || (current.size === 0 && !current.processPaused)) {
      return;
    }

    const pendingChars = current.size;
    const ptyWasPaused = current.processPaused;
    current.chunks = [];
    current.size = 0;
    current.processPaused = false;

    // 快照接管了旧积压后可以重新读取 PTY，后续输出会进入一条新的暂停队列。
    if (ptyWasPaused) {
      this.resumeProcess(identifier);
    }
    logInfo("terminal-output-flow", "snapshot-superseded-pending", {
      surface: this.surface,
      identifier,
      pendingChars,
      ptyWasPaused
    });
  }

  remove(identifier: string): void {
    const current = this.pending.get(identifier);
    if (current?.processPaused) {
      this.resumeProcess(identifier);
    }
    this.pending.delete(identifier);
  }

  complete(identifier: string, callback: () => void): void {
    const current = this.pending.get(identifier);
    if (this.paused && current) {
      // 会话可能在锁屏期间结束，退出事件必须排在最后一批终端数据之后。
      current.afterFlush.push(callback);
      return;
    }
    callback();
  }

  clear(): void {
    for (const [identifier, current] of this.pending) {
      if (current.processPaused) {
        this.resumeProcess(identifier);
      }
    }
    this.pending.clear();
  }

  private flush(identifier: string, trigger: string, pausedDurationMs?: number): void {
    const current = this.pending.get(identifier);
    if (!current) {
      return;
    }
    this.pending.delete(identifier);

    const batches = createOutputBatches(current.chunks);
    for (const batch of batches) {
      this.sendData(identifier, batch);
    }
    // 该事件排在所有积压数据之后，renderer 收到后再等待 Xterm 解析完成并执行 fit。
    this.sendResumed(identifier);

    if (current.processPaused) {
      this.resumeProcess(identifier);
    }
    for (const callback of current.afterFlush) {
      callback();
    }
    logInfo("terminal-output-flow", "delivery-resumed", {
      surface: this.surface,
      identifier,
      trigger,
      pausedDurationMs,
      pendingChars: current.size,
      batchCount: batches.length,
      ptyWasPaused: current.processPaused
    });
  }

  private resumeProcess(identifier: string): void {
    try {
      this.getProcess(identifier)?.resume();
    } catch (error) {
      logWarn("terminal-output-flow", "pty-resume-failed", {
        surface: this.surface,
        identifier,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
}

function createOutputBatches(chunks: string[]): string[] {
  const batches: string[] = [];
  let batch = "";

  for (const chunk of chunks) {
    // 不切开单个 PTY 片段，避免在 IPC 边界拆散 UTF-16 代理对或终端控制序列。
    if (batch && batch.length + chunk.length > OUTPUT_BATCH_CHARS) {
      batches.push(batch);
      batch = "";
    }
    if (chunk.length > OUTPUT_BATCH_CHARS) {
      batches.push(chunk);
    } else {
      batch += chunk;
    }
  }
  if (batch) {
    batches.push(batch);
  }
  return batches;
}
