import { useCallback, useEffect, useRef } from "react";
import type { RefObject } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import type { AppTheme } from "../../../shared/types";
import type { ShellTerminalState } from "../components/Workspace";
import { clearTerminal, errorMessage } from "./terminalUtils";
import { registerTerminalPathLinks } from "./terminalPathLinks";
import {
  logTerminalInteraction,
  scheduleTerminalImeBufferReset,
  subscribeTerminalRenderRecoveryRequest,
  subscribeWindowFocus
} from "./terminalInteractions";
import {
  applyTerminalAppearance,
  getTerminalMinimumContrastRatio,
  getTerminalTheme
} from "./terminalTheme";
import { createTerminalWriteQueue } from "./terminalWriteQueue";
import type { TerminalWriteQueue } from "./terminalWriteQueue";
import {
  createTerminalRenderRecovery,
  getTerminalPtyPulseCols,
  pulseTerminalPtySize
} from "./terminalRenderRecovery";
import type { TerminalRenderRecovery } from "./terminalRenderRecovery";

type UseProjectShellTerminalOptions = {
  shellTerminal: ShellTerminalState;
  shellTerminalVisible: boolean;
  shellTerminalVersion: number;
  theme: AppTheme;
  onError: (message: string) => void;
  onShellExited: (projectId: string) => void;
};

/** 按需创建底部项目终端；关闭面板时销毁 xterm，PTY 与输出缓存仍由主进程托管。 */
export function useProjectShellTerminal({
  shellTerminal,
  shellTerminalVisible,
  shellTerminalVersion,
  theme,
  onError,
  onShellExited
}: UseProjectShellTerminalOptions): RefObject<HTMLDivElement | null> {
  const shellHostRef = useRef<HTMLDivElement | null>(null);
  const shellTerminalRef = useRef<Terminal | null>(null);
  const shellFitAddonRef = useRef<FitAddon | null>(null);
  const shellWriteQueueRef = useRef<TerminalWriteQueue | null>(null);
  const shellRenderRecoveryRef = useRef<TerminalRenderRecovery | null>(null);
  const activeShellProjectRef = useRef<string | null>(null);
  const themeRef = useRef<AppTheme>(theme);

  const fitShellTerminal = useCallback(() => {
    const terminal = shellTerminalRef.current;
    const fitAddon = shellFitAddonRef.current;
    const host = shellHostRef.current;

    if (!terminal || !fitAddon || !host) {
      return;
    }

    const { width, height } = host.getBoundingClientRect();
    if (width <= 0 || height <= 0) {
      return;
    }

    fitAddon.fit();

    const projectId = activeShellProjectRef.current;
    if (!projectId) {
      return;
    }

    window.claudeManager
      .shellResize(projectId, terminal.cols, terminal.rows)
      .catch((error: unknown) => onError(errorMessage(error)));
  }, [onError]);

  const scheduleShellTerminalFit = useCallback(() => {
    window.requestAnimationFrame(() => {
      fitShellTerminal();
      window.setTimeout(fitShellTerminal, 80);
    });
  }, [fitShellTerminal]);

  useEffect(() => {
    // 与主终端一致，主题切换只替换颜色，不重启项目 Shell 或重放缓存。
    themeRef.current = theme;
    if (shellTerminalRef.current) {
      applyTerminalAppearance(shellTerminalRef.current, theme, "shell");
    }
  }, [theme]);

  useEffect(() => {
    activeShellProjectRef.current = shellTerminal?.projectId ?? null;

    // 面板隐藏只销毁 renderer 视图，不等同于结束主进程中的 shell。
    if (!shellTerminal || !shellTerminalVisible) {
      shellWriteQueueRef.current?.dispose();
      shellTerminalRef.current?.dispose();
      shellTerminalRef.current = null;
      shellFitAddonRef.current = null;
      shellWriteQueueRef.current = null;
      return undefined;
    }

    const host = shellHostRef.current;
    if (!host) {
      return undefined;
    }

    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: true,
      fontFamily: "SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      fontSize: 12,
      lineHeight: 1.2,
      minimumContrastRatio: getTerminalMinimumContrastRatio(themeRef.current),
      theme: getTerminalTheme(themeRef.current, "shell")
    });
    const fitAddon = new FitAddon();

    terminal.loadAddon(fitAddon);
    terminal.open(host);
    shellTerminalRef.current = terminal;
    shellFitAddonRef.current = fitAddon;
    const writeQueue = createTerminalWriteQueue(terminal);
    shellWriteQueueRef.current = writeQueue;
    activeShellProjectRef.current = shellTerminal.projectId;
    scheduleShellTerminalFit();

    const renderRecovery = createTerminalRenderRecovery({
      getTerminal: () => shellTerminalRef.current,
      fit: fitShellTerminal,
      onRecovered: ({ trigger, cols, rows, ptyResizeRequested }) => {
        const projectId = activeShellProjectRef.current;
        if (!projectId) {
          return;
        }
        if (ptyResizeRequested) {
          pulseTerminalPtySize(
            (nextCols, nextRows) => window.claudeManager.shellResize(projectId, nextCols, nextRows),
            cols,
            rows
          ).catch((error: unknown) => onError(errorMessage(error)));
        }
        logTerminalInteraction({
          event: "terminal-render-recovered",
          identifier: projectId,
          surface: "shell",
          trigger,
          cols,
          rows,
          ptyResizeRequested,
          ...(ptyResizeRequested ? { pulseCols: getTerminalPtyPulseCols(cols) } : {})
        });
      }
    });
    shellRenderRecoveryRef.current = renderRecovery;

    const pathLinkDisposable = registerTerminalPathLinks(terminal, (request) => {
      window.claudeManager.terminalPathOpen(request).catch((error: unknown) => {
        onError(errorMessage(error));
      });
    });

    const inputDisposable = terminal.onData((data) => {
      const projectId = activeShellProjectRef.current;
      if (!projectId) {
        return;
      }

      window.claudeManager.shellInput(projectId, data).catch((error: unknown) => {
        onError(errorMessage(error));
      });
    });
    terminal.attachCustomKeyEventHandler((event) => {
      scheduleTerminalImeBufferReset(terminal, event, (metadata) => {
        const projectId = activeShellProjectRef.current;
        if (!projectId) {
          return;
        }
        logTerminalInteraction({
          event: "terminal-ime-buffer-reset",
          identifier: projectId,
          surface: "shell",
          ...metadata
        });
      });
      return true;
    });

    const resizeObserver = new ResizeObserver(() => {
      scheduleShellTerminalFit();
    });
    resizeObserver.observe(host);

    window.claudeManager
      .shellGetBuffer(shellTerminal.projectId)
      .then((chunks) => {
        if (activeShellProjectRef.current !== shellTerminal.projectId) {
          return;
        }

        clearTerminal(terminal);
        for (const chunk of chunks) {
          writeQueue.write(chunk);
        }
        scheduleShellTerminalFit();
        terminal.focus();
      })
      .catch((error: unknown) => onError(errorMessage(error)));

    return () => {
      pathLinkDisposable.dispose();
      inputDisposable.dispose();
      resizeObserver.disconnect();
      renderRecovery.dispose();
      writeQueue.dispose();
      terminal.dispose();
      if (shellTerminalRef.current === terminal) {
        shellTerminalRef.current = null;
        shellFitAddonRef.current = null;
      }
      if (shellWriteQueueRef.current === writeQueue) {
        shellWriteQueueRef.current = null;
      }
      if (shellRenderRecoveryRef.current === renderRecovery) {
        shellRenderRecoveryRef.current = null;
      }
      if (activeShellProjectRef.current === shellTerminal.projectId) {
        activeShellProjectRef.current = shellTerminalVisible ? null : shellTerminal.projectId;
      }
    };
  }, [onError, scheduleShellTerminalFit, shellTerminal, shellTerminalVersion, shellTerminalVisible]);

  useEffect(() => subscribeWindowFocus(() => {
    shellRenderRecoveryRef.current?.schedule("window-focus");
  }), []);

  useEffect(() => subscribeTerminalRenderRecoveryRequest(() => {
    shellRenderRecoveryRef.current?.schedule("power-resumed", true);
  }), []);

  useEffect(() => {
    if (!hasProjectShellEvents()) {
      return undefined;
    }

    const unsubscribeShellData = window.claudeManager.onShellData(({ projectId, data }) => {
      if (projectId === activeShellProjectRef.current) {
        shellWriteQueueRef.current?.write(data);
      }
    });
    const unsubscribeShellExit = window.claudeManager.onShellExit(({ projectId }) => {
      if (projectId === activeShellProjectRef.current) {
        shellWriteQueueRef.current?.write("\r\n[项目终端已退出，点击右上角按钮可重新打开]\r\n");
        activeShellProjectRef.current = null;
        onShellExited(projectId);
      }
    });
    const unsubscribeOutputResumed = typeof window.claudeManager.onShellOutputResumed === "function"
      ? window.claudeManager.onShellOutputResumed(({ projectId }) => {
          if (projectId !== activeShellProjectRef.current) {
            return;
          }
          shellWriteQueueRef.current?.whenDrained(() => {
            if (projectId !== activeShellProjectRef.current) {
              return;
            }
            shellRenderRecoveryRef.current?.schedule("output-resumed");
          });
        })
      : () => undefined;

    return () => {
      unsubscribeShellData();
      unsubscribeShellExit();
      unsubscribeOutputResumed();
    };
  }, [onShellExited, scheduleShellTerminalFit]);

  return shellHostRef;
}

function hasProjectShellEvents(): boolean {
  const manager = window.claudeManager as Partial<Record<"onShellData" | "onShellExit", unknown>>;
  return typeof manager.onShellData === "function" && typeof manager.onShellExit === "function";
}
