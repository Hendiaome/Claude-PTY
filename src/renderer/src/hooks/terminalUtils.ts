import type { Terminal } from "@xterm/xterm";

/** 同时清理 xterm 状态和滚动区，避免切换会话后残留上一会话内容。 */
export function clearTerminal(terminal: Terminal | null): void {
  if (!terminal) {
    return;
  }

  terminal.reset();
  terminal.clear();
  terminal.write("\x1b[2J\x1b[3J\x1b[H");
}

/** 去掉 Electron IPC 包装前缀，只向界面展示实际业务错误。 */
export function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  return message
    .replace(/^Error invoking remote method '[^']+':\s*/u, "")
    .replace(/^Error:\s*/u, "");
}
