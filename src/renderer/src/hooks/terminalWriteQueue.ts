import type { Terminal } from "@xterm/xterm";

const COALESCE_LIMIT_CHARS = 64 * 1024;

export type TerminalWriteQueue = {
  write: (data: string) => void;
  whenDrained: (callback: () => void) => void;
  dispose: () => void;
};

/** 串行等待 Xterm 完成每批解析，避免恢复后大量 ANSI/TUI 控制序列同时堆入内部缓冲。 */
export function createTerminalWriteQueue(terminal: Terminal): TerminalWriteQueue {
  const pending: string[] = [];
  const drainCallbacks: Array<() => void> = [];
  let writing = false;
  let disposed = false;

  const notifyDrained = (): void => {
    if (writing || pending.length > 0 || disposed) {
      return;
    }
    const callbacks = drainCallbacks.splice(0);
    for (const callback of callbacks) {
      callback();
    }
  };

  const flush = (): void => {
    if (writing || disposed) {
      return;
    }
    const data = pending.shift();
    if (data === undefined) {
      notifyDrained();
      return;
    }

    writing = true;
    terminal.write(data, () => {
      writing = false;
      flush();
    });
  };

  return {
    write(data: string): void {
      if (!data || disposed) {
        return;
      }
      const lastIndex = pending.length - 1;
      if (lastIndex >= 0 && pending[lastIndex].length + data.length <= COALESCE_LIMIT_CHARS) {
        pending[lastIndex] += data;
      } else {
        pending.push(data);
      }
      flush();
    },
    whenDrained(callback: () => void): void {
      if (disposed) {
        return;
      }
      drainCallbacks.push(callback);
      notifyDrained();
    },
    dispose(): void {
      disposed = true;
      pending.length = 0;
      drainCallbacks.length = 0;
    }
  };
}
