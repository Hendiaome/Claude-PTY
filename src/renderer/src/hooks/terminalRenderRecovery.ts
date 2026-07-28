import type { Terminal } from "@xterm/xterm";
import type { TerminalRenderRecoveryTrigger } from "../../../shared/types";

export type TerminalRenderRecoveryMetadata = {
  trigger: TerminalRenderRecoveryTrigger;
  cols: number;
  rows: number;
  ptyResizeRequested: boolean;
};

export type TerminalRenderRecovery = {
  schedule: (trigger: TerminalRenderRecoveryTrigger, requestPtyResize?: boolean) => void;
  dispose: () => void;
};

const PTY_RESIZE_PULSE_DELAY_MS = 40;

const RECOVERY_TRIGGER_PRIORITY: Record<TerminalRenderRecoveryTrigger, number> = {
  "window-focus": 0,
  "output-resumed": 1,
  "power-resumed": 2
};

type TerminalRenderRecoveryOptions = {
  getTerminal: () => Terminal | null;
  fit: () => void;
  onRecovered: (metadata: TerminalRenderRecoveryMetadata) => void;
};

/**
 * 锁屏恢复后 Chromium 的终端渲染层可能仍处于失效状态。
 * 等待两帧让窗口重新参与合成，再重建纹理并延迟复查，效果等同于用户手动缩放窗口。
 */
export function createTerminalRenderRecovery({
  getTerminal,
  fit,
  onRecovered
}: TerminalRenderRecoveryOptions): TerminalRenderRecovery {
  let firstFrame: number | undefined;
  let secondFrame: number | undefined;
  let finalTimer: number | undefined;
  let pendingTrigger: TerminalRenderRecoveryTrigger | undefined;
  let pendingPtyResize = false;
  let disposed = false;

  const cancelScheduled = (): void => {
    if (firstFrame !== undefined) {
      window.cancelAnimationFrame(firstFrame);
      firstFrame = undefined;
    }
    if (secondFrame !== undefined) {
      window.cancelAnimationFrame(secondFrame);
      secondFrame = undefined;
    }
    if (finalTimer !== undefined) {
      window.clearTimeout(finalTimer);
      finalTimer = undefined;
    }
  };

  const redraw = (): void => {
    const terminal = getTerminal();
    if (!terminal) {
      return;
    }
    fit();
    // xterm 官方建议在系统休眠恢复后清理纹理缓存，避免字形或 Canvas 内容损坏。
    terminal.clearTextureAtlas();
    terminal.refresh(0, Math.max(0, terminal.rows - 1));
  };

  return {
    schedule(trigger, requestPtyResize = false): void {
      if (disposed) {
        return;
      }

      // 系统恢复优先级最高，合并短时间内重复触发，避免连续全屏刷新和尺寸脉冲。
      if (!pendingTrigger || RECOVERY_TRIGGER_PRIORITY[trigger] > RECOVERY_TRIGGER_PRIORITY[pendingTrigger]) {
        pendingTrigger = trigger;
      }
      pendingPtyResize ||= requestPtyResize;
      cancelScheduled();
      firstFrame = window.requestAnimationFrame(() => {
        firstFrame = undefined;
        secondFrame = window.requestAnimationFrame(() => {
          secondFrame = undefined;
          redraw();
          finalTimer = window.setTimeout(() => {
            finalTimer = undefined;
            redraw();
            const terminal = getTerminal();
            const completedTrigger = pendingTrigger;
            const ptyResizeRequested = pendingPtyResize;
            pendingTrigger = undefined;
            pendingPtyResize = false;
            if (!terminal || !completedTrigger) {
              return;
            }
            onRecovered({
              trigger: completedTrigger,
              cols: terminal.cols,
              rows: terminal.rows,
              ptyResizeRequested
            });
          }, 80);
        });
      });
    },
    dispose(): void {
      disposed = true;
      pendingTrigger = undefined;
      pendingPtyResize = false;
      cancelScheduled();
    }
  };
}

/** 真实改变一列后恢复原尺寸，确保操作系统向 TUI 发送 SIGWINCH，而不是无效的同尺寸 resize。 */
export async function pulseTerminalPtySize(
  resize: (cols: number, rows: number) => Promise<void>,
  cols: number,
  rows: number
): Promise<number> {
  const pulseCols = getTerminalPtyPulseCols(cols);
  await resize(pulseCols, rows);
  await new Promise<void>((resolve) => window.setTimeout(resolve, PTY_RESIZE_PULSE_DELAY_MS));
  await resize(cols, rows);
  return pulseCols;
}

export function getTerminalPtyPulseCols(cols: number): number {
  return cols > 2 ? cols - 1 : cols + 1;
}
