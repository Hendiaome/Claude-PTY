import type { BrowserWindow, IpcMain } from "electron";
import type {
  StructuredImeSuppressionTrigger,
  TerminalImeNavigationTrigger,
  TerminalRenderRecoveryTrigger
} from "../shared/types";
import { logError, logInfo, logWarn } from "./appLogger";

type RendererErrorPayload = {
  type: "error" | "unhandledrejection";
  message: string;
  stack?: string;
  source?: string;
  line?: number;
  column?: number;
};

type TerminalInteractionPayload = {
  event:
    | "focus-restored"
    | "file-paths-pasted"
    | "session-selection-restored"
    | "terminal-selection-copied"
    | "terminal-input-selection-deleted"
    | "terminal-ime-buffer-reset"
    | "terminal-render-recovered"
    | "terminal-search-performed"
    | "structured-ime-enter-suppressed";
  identifier: string;
  surface?: "claude" | "shell";
  trigger?:
    | "window-focus"
    | TerminalImeNavigationTrigger
    | TerminalRenderRecoveryTrigger
    | StructuredImeSuppressionTrigger;
  fileCount?: number;
  source?: "saved" | "running-fallback";
  charCount?: number;
  direction?: "next" | "previous";
  found?: boolean;
  previousLength?: number;
  selectionStart?: number;
  selectionEnd?: number;
  cursorColumn?: number;
  cols?: number;
  rows?: number;
  ptyResizeRequested?: boolean;
  pulseCols?: number;
};

export function isDevDiagnosticsEnabled(): boolean {
  return Boolean(process.env.ELECTRON_RENDERER_URL) && process.env.CLAUDE_PTY_DEVTOOLS !== "0";
}

/** 注册 renderer 错误和低频交互日志入口，所有 renderer 数据都在主进程再次校验。 */
export function registerDevDiagnosticsIpc(ipcMain: IpcMain): void {
  ipcMain.on("diagnostics:renderer-error", (_event, rawPayload: unknown) => {
    const payload = normalizeRendererErrorPayload(rawPayload);
    if (!payload) {
      logWarn("renderer", "invalid-error-payload");
      if (isDevDiagnosticsEnabled()) {
        console.error("[renderer:error] received invalid diagnostics payload");
      }
      return;
    }

    logError("renderer", payload.type, payload.message, {
      stack: payload.stack,
      source: payload.source,
      line: payload.line,
      column: payload.column
    });
    if (isDevDiagnosticsEnabled()) {
      logRendererError(payload);
    }
  });

  // 仅接收白名单元数据，禁止 renderer 把文件路径、剪贴板文本或终端正文写入日志。
  ipcMain.on("diagnostics:terminal-interaction", (_event, rawPayload: unknown) => {
    const payload = normalizeTerminalInteractionPayload(rawPayload);
    if (!payload) {
      logWarn("terminal-interaction", "invalid-payload");
      return;
    }

    if (payload.event === "session-selection-restored") {
      logInfo("session-selection", "restored", {
        sessionId: payload.identifier,
        source: payload.source
      });
      return;
    }

    if (payload.event === "terminal-ime-buffer-reset") {
      const identifierKey = payload.surface === "shell" ? "projectId" : "sessionId";
      logInfo("terminal-interaction", payload.event, {
        surface: payload.surface,
        [identifierKey]: payload.identifier,
        trigger: payload.trigger,
        previousLength: payload.previousLength,
        selectionStart: payload.selectionStart,
        selectionEnd: payload.selectionEnd,
        cursorColumn: payload.cursorColumn
      });
      return;
    }

    if (payload.event === "terminal-render-recovered") {
      const identifierKey = payload.surface === "shell" ? "projectId" : "sessionId";
      logInfo("terminal-interaction", payload.event, {
        surface: payload.surface,
        [identifierKey]: payload.identifier,
        trigger: payload.trigger,
        cols: payload.cols,
        rows: payload.rows,
        ptyResizeRequested: payload.ptyResizeRequested,
        ...(payload.pulseCols ? { pulseCols: payload.pulseCols } : {})
      });
      return;
    }

    logInfo("terminal-interaction", payload.event, {
      surface: "claude",
      sessionId: payload.identifier,
      ...(payload.trigger ? { trigger: payload.trigger } : {}),
      ...(payload.fileCount ? { fileCount: payload.fileCount } : {}),
      ...(payload.charCount ? { charCount: payload.charCount } : {}),
      ...(payload.direction ? { direction: payload.direction, found: payload.found } : {})
    });
  });
}

/** 记录 preload、renderer 加载和进程存活状态；开发环境额外转发控制台并打开 DevTools。 */
export function attachDevDiagnostics(window: BrowserWindow): void {
  const { webContents } = window;

  webContents.on("preload-error", (_event, preloadPath, error) => {
    logError("preload", "load-failed", error, { preloadPath });
    if (isDevDiagnosticsEnabled()) {
      console.error(`[preload:error] ${preloadPath}\n${error.stack ?? error.message}`);
    }
  });

  webContents.on("render-process-gone", (_event, details) => {
    logError("renderer", "process-gone", details.reason, { exitCode: details.exitCode });
    if (isDevDiagnosticsEnabled()) {
      console.error(`[renderer:gone] reason=${details.reason} exitCode=${details.exitCode}`);
    }
  });

  webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    logError("renderer", "load-failed", errorDescription, {
      errorCode,
      validatedURL,
      isMainFrame
    });
    if (isDevDiagnosticsEnabled()) {
      console.error(
        `[renderer:did-fail-load] code=${errorCode} mainFrame=${isMainFrame} url=${validatedURL}\n${errorDescription}`
      );
    }
  });

  webContents.on("unresponsive", () => {
    logWarn("renderer", "unresponsive");
    if (isDevDiagnosticsEnabled()) {
      console.warn("[renderer:unresponsive]");
    }
  });

  webContents.on("responsive", () => {
    logInfo("renderer", "responsive");
    if (isDevDiagnosticsEnabled()) {
      console.info("[renderer:responsive]");
    }
  });

  if (!isDevDiagnosticsEnabled()) {
    return;
  }

  webContents.once("did-finish-load", () => {
    console.info("[devtools] opening renderer DevTools");
    webContents.openDevTools({ mode: "detach" });
  });

  webContents.on("console-message", (details, deprecatedLevel, deprecatedMessage, deprecatedLine, deprecatedSourceId) => {
    const level = details.level ?? consoleLevel(deprecatedLevel);
    const message = details.message ?? deprecatedMessage;
    const line = details.lineNumber ?? deprecatedLine;
    const source = details.sourceId ?? deprecatedSourceId;

    logRendererConsole(level, message, source, line);
  });
}

function logRendererConsole(level: string, message: string, source?: string, line?: number): void {
  const location = source ? ` (${source}${line ? `:${line}` : ""})` : "";
  const text = `[renderer:${level}] ${message}${location}`;

  if (level === "error") {
    console.error(text);
    return;
  }

  if (level === "warning") {
    console.warn(text);
    return;
  }

  console.info(text);
}

function logRendererError(payload: RendererErrorPayload): void {
  const location = payload.source ? ` (${payload.source}${payload.line ? `:${payload.line}` : ""})` : "";
  const header = `[renderer:${payload.type}] ${payload.message}${location}`;
  console.error(payload.stack ? `${header}\n${payload.stack}` : header);
}

function normalizeRendererErrorPayload(rawPayload: unknown): RendererErrorPayload | undefined {
  if (!rawPayload || typeof rawPayload !== "object") {
    return undefined;
  }

  const record = rawPayload as Record<string, unknown>;
  const type = record.type === "unhandledrejection" ? "unhandledrejection" : "error";
  const message = typeof record.message === "string" && record.message.trim() ? record.message : undefined;
  if (!message) {
    return undefined;
  }

  return {
    type,
    message,
    stack: typeof record.stack === "string" ? record.stack : undefined,
    source: typeof record.source === "string" ? record.source : undefined,
    line: typeof record.line === "number" ? record.line : undefined,
    column: typeof record.column === "number" ? record.column : undefined
  };
}

function normalizeTerminalInteractionPayload(rawPayload: unknown): TerminalInteractionPayload | undefined {
  if (!rawPayload || typeof rawPayload !== "object") {
    return undefined;
  }

  const record = rawPayload as Record<string, unknown>;
  const identifier =
    typeof record.identifier === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(record.identifier)
      ? record.identifier
      : undefined;
  if (!identifier) {
    return undefined;
  }

  if (record.event === "focus-restored") {
    const trigger = record.trigger === "window-focus" ? record.trigger : undefined;
    return trigger
      ? {
          event: "focus-restored",
          identifier,
          trigger
        }
      : undefined;
  }

  if (record.event === "file-paths-pasted") {
    const fileCount =
      typeof record.fileCount === "number" &&
      Number.isInteger(record.fileCount) &&
      record.fileCount > 0 &&
      record.fileCount <= 1000
        ? record.fileCount
        : undefined;
    return fileCount
      ? {
          event: "file-paths-pasted",
          identifier,
          fileCount
        }
      : undefined;
  }

  if (record.event === "session-selection-restored") {
    const source =
      record.source === "saved" || record.source === "running-fallback"
        ? record.source
        : undefined;
    return source
      ? {
          event: "session-selection-restored",
          identifier,
          source
        }
      : undefined;
  }

  if (record.event === "terminal-selection-copied") {
    const charCount = normalizePositiveCount(record.charCount);
    return charCount
      ? {
          event: "terminal-selection-copied",
          identifier,
          charCount
        }
      : undefined;
  }

  if (record.event === "terminal-input-selection-deleted") {
    const charCount = normalizePositiveCount(record.charCount);
    return charCount
      ? {
          event: "terminal-input-selection-deleted",
          identifier,
          charCount
        }
      : undefined;
  }

  if (record.event === "terminal-ime-buffer-reset") {
    const surface = record.surface === "claude" || record.surface === "shell" ? record.surface : undefined;
    const trigger = normalizeImeNavigationTrigger(record.trigger);
    const previousLength = normalizePositiveCount(record.previousLength);
    const selectionStart = normalizeNonNegativeCount(record.selectionStart);
    const selectionEnd = normalizeNonNegativeCount(record.selectionEnd);
    const cursorColumn = normalizeNonNegativeCount(record.cursorColumn);
    return surface && trigger && previousLength !== undefined && selectionStart !== undefined &&
      selectionEnd !== undefined && cursorColumn !== undefined
      ? {
          event: "terminal-ime-buffer-reset",
          identifier,
          surface,
          trigger,
          previousLength,
          selectionStart,
          selectionEnd,
          cursorColumn
        }
      : undefined;
  }

  if (record.event === "terminal-render-recovered") {
    const surface = record.surface === "claude" || record.surface === "shell" ? record.surface : undefined;
    const trigger = normalizeRenderRecoveryTrigger(record.trigger);
    const cols = normalizePositiveCount(record.cols);
    const rows = normalizePositiveCount(record.rows);
    const pulseCols = record.pulseCols === undefined ? undefined : normalizePositiveCount(record.pulseCols);
    return surface && trigger && cols !== undefined && rows !== undefined &&
      typeof record.ptyResizeRequested === "boolean" &&
      (!record.ptyResizeRequested || pulseCols !== undefined)
      ? {
          event: "terminal-render-recovered",
          identifier,
          surface,
          trigger,
          cols,
          rows,
          ptyResizeRequested: record.ptyResizeRequested,
          pulseCols
        }
      : undefined;
  }

  if (record.event === "terminal-search-performed") {
    const direction =
      record.direction === "next" || record.direction === "previous"
        ? record.direction
        : undefined;
    return direction && typeof record.found === "boolean"
      ? {
          event: "terminal-search-performed",
          identifier,
          direction,
          found: record.found
        }
      : undefined;
  }

  if (record.event === "structured-ime-enter-suppressed") {
    const trigger = normalizeStructuredImeSuppressionTrigger(record.trigger);
    return trigger
      ? {
          event: "structured-ime-enter-suppressed",
          identifier,
          trigger
        }
      : undefined;
  }

  return undefined;
}

function normalizePositiveCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 10_000_000
    ? value
    : undefined;
}

function normalizeNonNegativeCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 10_000_000
    ? value
    : undefined;
}

function normalizeImeNavigationTrigger(value: unknown): TerminalImeNavigationTrigger | undefined {
  return typeof value === "string" && /^(?:ctrl-[abefnp]|arrow-(?:down|left|right|up)|end|home)$/u.test(value)
    ? value as TerminalImeNavigationTrigger
    : undefined;
}

function normalizeRenderRecoveryTrigger(value: unknown): TerminalRenderRecoveryTrigger | undefined {
  return value === "output-resumed" || value === "power-resumed" || value === "window-focus"
    ? value
    : undefined;
}

function normalizeStructuredImeSuppressionTrigger(value: unknown): StructuredImeSuppressionTrigger | undefined {
  return value === "composition" || value === "native-composing" || value === "keycode-229" ||
    value === "recent-composition-end"
    ? value
    : undefined;
}

function consoleLevel(level: number): string {
  switch (level) {
    case 0:
      return "debug";
    case 1:
      return "info";
    case 2:
      return "warning";
    case 3:
      return "error";
    default:
      return "info";
  }
}
