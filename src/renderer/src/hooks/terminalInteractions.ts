import type { Terminal } from "@xterm/xterm";
import type {
  TerminalFilePasteEvent,
  TerminalImeNavigationTrigger,
  TerminalInteractionLogRequest,
  TerminalRenderRecoveryRequestEvent
} from "../../../shared/types";

type TerminalInputSelectionDeletion = {
  input: string;
  charCount: number;
};

type TerminalImeBufferReset = {
  trigger: TerminalImeNavigationTrigger;
  previousLength: number;
  selectionStart: number;
  selectionEnd: number;
  cursorColumn: number;
};

const CTRL_IME_NAVIGATION_TRIGGERS: Partial<Record<string, TerminalImeNavigationTrigger>> = {
  a: "ctrl-a",
  b: "ctrl-b",
  e: "ctrl-e",
  f: "ctrl-f",
  n: "ctrl-n",
  p: "ctrl-p"
};

const IME_NAVIGATION_TRIGGERS: Partial<Record<string, TerminalImeNavigationTrigger>> = {
  arrowdown: "arrow-down",
  arrowleft: "arrow-left",
  arrowright: "arrow-right",
  arrowup: "arrow-up",
  end: "end",
  home: "home"
};

const CURSOR_LEFT = "\u001b[D";
const CURSOR_RIGHT = "\u001b[C";
const BACKSPACE = "\u007f";

/** 兼容旧 preload：能力尚未加载时返回空取消函数，不让 renderer 直接报错。 */
export function subscribeTerminalFilePaste(
  callback: (paths: string[]) => void
): () => void {
  const manager = window.claudeManager as Partial<{
    onTerminalFilePaste: (listener: (event: TerminalFilePasteEvent) => void) => () => void;
  }>;
  if (typeof manager.onTerminalFilePaste !== "function") {
    return () => undefined;
  }

  return manager.onTerminalFilePaste((event) => {
    callback(event.paths);
  });
}

export function pasteTerminalFilePaths(terminal: Terminal, paths: string[]): number {
  const absolutePaths = paths.filter((path) => typeof path === "string" && path.startsWith("/"));
  if (absolutePaths.length === 0) {
    return 0;
  }

  terminal.paste(absolutePaths.map(shellQuote).join(" "));
  return absolutePaths.length;
}

export function logTerminalInteraction(request: TerminalInteractionLogRequest): void {
  const manager = window.claudeManager as Partial<{
    terminalInteractionLog: (payload: TerminalInteractionLogRequest) => void;
  }>;
  if (typeof manager.terminalInteractionLog === "function") {
    manager.terminalInteractionLog(request);
  }
}

/**
 * 光标导航只改变 PTY 中的编辑位置，xterm 隐藏 textarea 仍可能残留旧中文。
 * 在当前按键完成后清空该缓存，避免下一次输入法提交按旧偏移截取字符串。
 */
export function scheduleTerminalImeBufferReset(
  terminal: Terminal,
  event: KeyboardEvent,
  onReset: (metadata: TerminalImeBufferReset) => void
): void {
  const trigger = terminalImeNavigationTrigger(event);
  if (!trigger) {
    return;
  }

  const cursorColumn = terminal.buffer.active.cursorX;
  queueMicrotask(() => {
    const textarea = terminal.textarea;
    const previousLength = textarea?.value.length ?? 0;
    if (!textarea || previousLength === 0) {
      return;
    }

    const selectionStart = textarea.selectionStart ?? 0;
    const selectionEnd = textarea.selectionEnd ?? selectionStart;
    textarea.value = "";
    textarea.setSelectionRange(0, 0);
    onReset({
      trigger,
      previousLength,
      selectionStart,
      selectionEnd,
      cursorColumn
    });
  });
}

/** 通过 preload 请求主进程写入剪贴板；旧 preload 下回退到浏览器 Clipboard API。 */
export function copyTerminalSelection(text: string): Promise<void> {
  const manager = window.claudeManager as Partial<{
    terminalCopyText: (value: string) => Promise<void> | void;
  }>;
  if (typeof manager.terminalCopyText === "function") {
    try {
      return Promise.resolve(manager.terminalCopyText(text));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  return navigator.clipboard?.writeText(text) ?? Promise.reject(new Error("系统剪贴板不可用。"));
}

/**
 * 将当前光标行的鼠标选区转换为终端编辑按键。
 * PTY 不提供输入/输出语义，因此跨行选区不做处理，避免把历史输出误当成可编辑文本。
 */
export function createTerminalInputSelectionDeletion(
  terminal: Terminal
): TerminalInputSelectionDeletion | undefined {
  const selection = terminal.getSelectionPosition();
  const selectedText = terminal.getSelection();
  const buffer = terminal.buffer.active;
  const cursorY = buffer.baseY + buffer.cursorY;
  if (
    !selection ||
    !selectedText ||
    selection.start.y !== cursorY ||
    selection.end.y !== cursorY ||
    selection.start.x >= selection.end.x
  ) {
    return undefined;
  }

  const charCount = countBufferCharacters(terminal, cursorY, selection.start.x, selection.end.x);
  const cursorToSelectionEnd = countBufferCharacters(
    terminal,
    cursorY,
    Math.min(buffer.cursorX, selection.end.x),
    Math.max(buffer.cursorX, selection.end.x)
  );
  if (charCount === 0 || (buffer.cursorX !== selection.end.x && cursorToSelectionEnd === 0)) {
    return undefined;
  }

  // 先把 CLI 光标移动到选区末尾，再用退格删除；宽字符的续单元不会重复计数。
  const moveToSelectionEnd = buffer.cursorX > selection.end.x
    ? CURSOR_LEFT.repeat(cursorToSelectionEnd)
    : CURSOR_RIGHT.repeat(cursorToSelectionEnd);
  return {
    input: `${moveToSelectionEnd}${BACKSPACE.repeat(charCount)}`,
    charCount
  };
}

/** 优先使用 Electron 主窗口事件；旧 preload 尚未加载时回退到 DOM focus。 */
export function subscribeWindowFocus(callback: () => void): () => void {
  const manager = window.claudeManager as Partial<{
    onWindowFocused: (listener: () => void) => () => void;
  }>;
  if (typeof manager.onWindowFocused === "function") {
    return manager.onWindowFocused(callback);
  }

  window.addEventListener("focus", callback);
  return () => window.removeEventListener("focus", callback);
}

/** 兼容旧 preload：新版主进程会在每次系统恢复后主动请求终端重排。 */
export function subscribeTerminalRenderRecoveryRequest(
  callback: (event: TerminalRenderRecoveryRequestEvent) => void
): () => void {
  const manager = window.claudeManager as Partial<{
    onTerminalRenderRecoveryRequested: (
      listener: (event: TerminalRenderRecoveryRequestEvent) => void
    ) => () => void;
  }>;
  return typeof manager.onTerminalRenderRecoveryRequested === "function"
    ? manager.onTerminalRenderRecoveryRequested(callback)
    : () => undefined;
}

function shellQuote(path: string): string {
  // 每个路径独立单引号转义，确保空格、中文和单引号都作为一个 shell 参数粘贴。
  return `'${path.replace(/'/gu, `'"'"'`)}'`;
}

function terminalImeNavigationTrigger(event: KeyboardEvent): TerminalImeNavigationTrigger | undefined {
  if (event.type !== "keydown" || event.isComposing || event.metaKey || event.altKey) {
    return undefined;
  }

  const key = event.key.toLowerCase();
  if (event.ctrlKey) {
    return CTRL_IME_NAVIGATION_TRIGGERS[key];
  }

  return IME_NAVIGATION_TRIGGERS[key];
}

function countBufferCharacters(terminal: Terminal, row: number, startColumn: number, endColumn: number): number {
  const line = terminal.buffer.active.getLine(row);
  if (!line) {
    return 0;
  }

  let count = 0;
  for (let column = startColumn; column < endColumn; column += 1) {
    const cell = line.getCell(column);
    if (cell && cell.getWidth() > 0 && cell.getChars()) {
      count += 1;
    }
  }
  return count;
}
