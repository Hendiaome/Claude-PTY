import { useCallback, useEffect, useRef } from "react";
import type { RefObject } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Terminal } from "@xterm/xterm";
import type { AppTheme, SessionRecord } from "../../../shared/types";
import { translateClaudeStatusOutput } from "./claudeStatusTransform";
import { clearTerminal, errorMessage } from "./terminalUtils";
import { registerTerminalPathLinks } from "./terminalPathLinks";
import {
  copyTerminalSelection,
  createTerminalInputSelectionDeletion,
  logTerminalInteraction,
  pasteTerminalFilePaths,
  scheduleTerminalImeBufferReset,
  subscribeTerminalRenderRecoveryRequest,
  subscribeTerminalFilePaste,
  subscribeWindowFocus
} from "./terminalInteractions";
import {
  applyTerminalAppearance,
  getTerminalMinimumContrastRatio,
  getTerminalSearchOptions,
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

export type TerminalSearchDirection = "next" | "previous";

type UseClaudeTerminalOptions = {
  activeSessionId: string | null;
  focusRequest: number;
  theme: AppTheme;
  onError: (message: string) => void;
  onSessionUpdated: (session: SessionRecord) => void;
};

type UseClaudeTerminalResult = {
  terminalHostRef: RefObject<HTMLDivElement | null>;
  searchTerminal: (query: string, direction: TerminalSearchDirection) => boolean;
  clearTerminalSearch: () => void;
};

/** 维护唯一 Claude xterm 实例，在会话切换时回放主进程缓存并路由实时 PTY 数据。 */
export function useClaudeTerminal({
  activeSessionId,
  focusRequest,
  theme,
  onError,
  onSessionUpdated
}: UseClaudeTerminalOptions): UseClaudeTerminalResult {
  const terminalHostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const writeQueueRef = useRef<TerminalWriteQueue | null>(null);
  const renderRecoveryRef = useRef<TerminalRenderRecovery | null>(null);
  const activeSessionRef = useRef<string | null>(null);
  const themeRef = useRef<AppTheme>(theme);

  const fitTerminal = useCallback(() => {
    const terminal = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    const host = terminalHostRef.current;

    if (!terminal || !fitAddon || !host) {
      return;
    }

    const { width, height } = host.getBoundingClientRect();
    if (width <= 0 || height <= 0) {
      return;
    }

    fitAddon.fit();

    const sessionId = activeSessionRef.current;
    if (!sessionId) {
      return;
    }

    window.claudeManager
      .terminalResize(sessionId, terminal.cols, terminal.rows)
      .catch((error: unknown) => onError(errorMessage(error)));
  }, [onError]);

  const scheduleTerminalFit = useCallback(() => {
    window.requestAnimationFrame(() => {
      fitTerminal();
      window.setTimeout(fitTerminal, 80);
    });
  }, [fitTerminal]);

  const searchTerminal = useCallback((query: string, direction: TerminalSearchDirection): boolean => {
    const searchAddon = searchAddonRef.current;
    const sessionId = activeSessionRef.current;
    if (!searchAddon || !sessionId || !query) {
      return false;
    }

    const found = direction === "previous"
      ? searchAddon.findPrevious(query, getTerminalSearchOptions(theme))
      : searchAddon.findNext(query, getTerminalSearchOptions(theme));
    logTerminalInteraction({
      event: "terminal-search-performed",
      identifier: sessionId,
      direction,
      found
    });
    return found;
  }, [theme]);

  const clearTerminalSearch = useCallback((): void => {
    searchAddonRef.current?.clearDecorations();
    terminalRef.current?.focus();
  }, []);

  useEffect(() => {
    activeSessionRef.current = activeSessionId;
  }, [activeSessionId]);

  useEffect(() => {
    // xterm 支持运行时替换配色，无需销毁实例或丢失当前滚动位置。
    themeRef.current = theme;
    if (terminalRef.current) {
      applyTerminalAppearance(terminalRef.current, theme, "claude");
      searchAddonRef.current?.clearDecorations();
    }
  }, [theme]);

  useEffect(() => {
    const terminal = new Terminal({
      // SearchAddon 的匹配高亮使用 xterm proposed API，仅为 Claude 主终端开启。
      allowProposedApi: true,
      cursorBlink: true,
      convertEol: true,
      fontFamily: "SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      fontSize: 13,
      lineHeight: 1.22,
      // 默认仅 1000 行；提高滚动区后，长会话回放不会过早丢掉已经解析出的可见行。
      scrollback: 10_000,
      minimumContrastRatio: getTerminalMinimumContrastRatio(themeRef.current),
      theme: getTerminalTheme(themeRef.current, "claude")
    });
    const fitAddon = new FitAddon();
    const searchAddon = new SearchAddon();

    terminal.loadAddon(fitAddon);
    terminal.loadAddon(searchAddon);
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    searchAddonRef.current = searchAddon;
    const writeQueue = createTerminalWriteQueue(terminal);
    writeQueueRef.current = writeQueue;

    if (terminalHostRef.current) {
      terminal.open(terminalHostRef.current);
      scheduleTerminalFit();
    }

    const renderRecovery = createTerminalRenderRecovery({
      getTerminal: () => terminalRef.current,
      fit: fitTerminal,
      onRecovered: ({ trigger, cols, rows, ptyResizeRequested }) => {
        const sessionId = activeSessionRef.current;
        if (!sessionId) {
          return;
        }
        if (ptyResizeRequested) {
          // 一列尺寸脉冲会产生真实 SIGWINCH，最终恢复原尺寸并触发 Claude TUI 全量重绘。
          pulseTerminalPtySize(
            (nextCols, nextRows) => window.claudeManager.terminalResize(sessionId, nextCols, nextRows),
            cols,
            rows
          ).catch((error: unknown) => onError(errorMessage(error)));
        }
        logTerminalInteraction({
          event: "terminal-render-recovered",
          identifier: sessionId,
          surface: "claude",
          trigger,
          cols,
          rows,
          ptyResizeRequested,
          ...(ptyResizeRequested ? { pulseCols: getTerminalPtyPulseCols(cols) } : {})
        });
      }
    });
    renderRecoveryRef.current = renderRecovery;

    const pathLinkDisposable = registerTerminalPathLinks(terminal, (request) => {
      window.claudeManager.terminalPathOpen(request).catch((error: unknown) => {
        onError(errorMessage(error));
      });
    });

    const inputDisposable = terminal.onData((data) => {
      const sessionId = activeSessionRef.current;
      if (!sessionId) {
        return;
      }

      window.claudeManager.terminalInput(sessionId, data).catch((error: unknown) => {
        onError(errorMessage(error));
      });
    });
    terminal.attachCustomKeyEventHandler((event) => {
      scheduleTerminalImeBufferReset(terminal, event, (metadata) => {
        const sessionId = activeSessionRef.current;
        if (!sessionId) {
          return;
        }
        logTerminalInteraction({
          event: "terminal-ime-buffer-reset",
          identifier: sessionId,
          surface: "claude",
          ...metadata
        });
      });

      if (
        event.type !== "keydown" ||
        (event.key !== "Backspace" && event.key !== "Delete") ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.isComposing
      ) {
        return true;
      }

      const sessionId = activeSessionRef.current;
      const deletion = createTerminalInputSelectionDeletion(terminal);
      if (!sessionId || !deletion) {
        return true;
      }

      event.preventDefault();
      event.stopPropagation();
      terminal.clearSelection();
      window.claudeManager
        .terminalInput(sessionId, deletion.input)
        .then(() => {
          logTerminalInteraction({
            event: "terminal-input-selection-deleted",
            identifier: sessionId,
            charCount: deletion.charCount
          });
        })
        .catch((error: unknown) => onError(errorMessage(error)));
      return false;
    });
    const unsubscribeFilePaste = subscribeTerminalFilePaste((paths) => {
      const sessionId = activeSessionRef.current;
      if (!sessionId) {
        return;
      }

      const fileCount = pasteTerminalFilePaths(terminal, paths);
      if (fileCount > 0) {
        logTerminalInteraction({
          event: "file-paths-pasted",
          identifier: sessionId,
          fileCount
        });
      }
    });

    // xterm 完成鼠标选区后再读取内容，避免拖动过程中反复覆盖系统剪贴板。
    let selectionCopyFrame: number | undefined;
    const copySelectionOnMouseUp = (event: MouseEvent): void => {
      if (event.button !== 0) {
        return;
      }

      if (selectionCopyFrame !== undefined) {
        window.cancelAnimationFrame(selectionCopyFrame);
      }
      selectionCopyFrame = window.requestAnimationFrame(() => {
        selectionCopyFrame = undefined;
        const selection = terminal.getSelection();
        const sessionId = activeSessionRef.current;
        if (!selection || !sessionId) {
          return;
        }

        copyTerminalSelection(selection)
          .then(() => {
            logTerminalInteraction({
              event: "terminal-selection-copied",
              identifier: sessionId,
              charCount: selection.length
            });
          })
          .catch((error: unknown) => onError(errorMessage(error)));
      });
    };
    terminal.element?.addEventListener("mouseup", copySelectionOnMouseUp, true);

    const resizeObserver = new ResizeObserver(() => {
      scheduleTerminalFit();
    });

    if (terminalHostRef.current) {
      resizeObserver.observe(terminalHostRef.current);
    }

    return () => {
      pathLinkDisposable.dispose();
      inputDisposable.dispose();
      unsubscribeFilePaste();
      terminal.element?.removeEventListener("mouseup", copySelectionOnMouseUp, true);
      if (selectionCopyFrame !== undefined) {
        window.cancelAnimationFrame(selectionCopyFrame);
      }
      resizeObserver.disconnect();
      renderRecovery.dispose();
      writeQueue.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      searchAddonRef.current = null;
      if (writeQueueRef.current === writeQueue) {
        writeQueueRef.current = null;
      }
      if (renderRecoveryRef.current === renderRecovery) {
        renderRecoveryRef.current = null;
      }
    };
  }, [onError, scheduleTerminalFit]);

  useEffect(() => {
    if (activeSessionId && focusRequest > 0) {
      // 点击已选中的退出会话时 activeSessionId 不变，仍需在恢复进程前后重新同步实际尺寸。
      scheduleTerminalFit();
      terminalRef.current?.focus();
    }
  }, [activeSessionId, focusRequest, scheduleTerminalFit]);

  useEffect(() => {
    // 仅恢复 Claude 主会话；弹窗或底部项目终端正在使用时不抢焦点。
    const restoreActiveSessionFocus = (): void => {
      const sessionId = activeSessionRef.current;
      const terminal = terminalRef.current;
      if (!sessionId || !terminal) {
        return;
      }

      // 渲染恢复不抢输入焦点，即使弹窗打开也可以修复后台终端的失效 Canvas。
      renderRecoveryRef.current?.schedule("window-focus");
      if (
        document.querySelector(".modal-backdrop") ||
        document.activeElement?.closest(".shell-terminal-host")
      ) {
        return;
      }

      terminal.focus();
      logTerminalInteraction({
        event: "focus-restored",
        identifier: sessionId,
        trigger: "window-focus"
      });
    };

    return subscribeWindowFocus(restoreActiveSessionFocus);
  }, []);

  useEffect(() => subscribeTerminalRenderRecoveryRequest(() => {
    renderRecoveryRef.current?.schedule("power-resumed", true);
  }), []);

  useEffect(() => {
    const unsubscribeData = window.claudeManager.onTerminalData(({ sessionId, data }) => {
      // 所有会话共享一个可见 xterm，非当前会话的数据只留在主进程缓存中。
      if (sessionId === activeSessionRef.current) {
        writeQueueRef.current?.write(data);
      }
    });
    const unsubscribeExit = window.claudeManager.onTerminalExit(({ sessionId }) => {
      if (sessionId === activeSessionRef.current) {
        writeQueueRef.current?.write("\r\n[Claude 会话已退出]\r\n");
      }
    });
    const unsubscribeOutputResumed = typeof window.claudeManager.onTerminalOutputResumed === "function"
      ? window.claudeManager.onTerminalOutputResumed(({ sessionId }) => {
          if (sessionId !== activeSessionRef.current) {
            return;
          }
          // 主进程已发完锁屏积压；等 Xterm 解析和窗口合成都稳定后再完整恢复渲染。
          writeQueueRef.current?.whenDrained(() => {
            if (sessionId !== activeSessionRef.current) {
              return;
            }
            renderRecoveryRef.current?.schedule("output-resumed");
          });
        })
      : () => undefined;
    const unsubscribeSession = window.claudeManager.onSessionUpdated(onSessionUpdated);

    return () => {
      unsubscribeData();
      unsubscribeExit();
      unsubscribeOutputResumed();
      unsubscribeSession();
    };
  }, [onSessionUpdated, scheduleTerminalFit]);

  useEffect(() => {
    if (!activeSessionId) {
      clearTerminal(terminalRef.current);
      return;
    }

    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }

    clearTerminal(terminal);
    window.claudeManager
      .terminalGetBuffer(activeSessionId)
      .then((chunks) => {
        if (activeSessionRef.current !== activeSessionId) {
          return;
        }

        for (const chunk of chunks) {
          writeQueueRef.current?.write(chunk);
        }
        scheduleTerminalFit();
        terminal.focus();
      })
      .catch((error: unknown) => onError(errorMessage(error)));
  }, [activeSessionId, onError, scheduleTerminalFit]);

  return {
    terminalHostRef,
    searchTerminal,
    clearTerminalSearch
  };
}
