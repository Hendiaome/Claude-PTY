import type { ISearchOptions } from "@xterm/addon-search";
import type { ITheme, Terminal } from "@xterm/xterm";
import type { AppTheme } from "../../../shared/types";

const DARK_CLAUDE_TERMINAL_THEME: ITheme = {
  background: "#101114",
  foreground: "#e7e8ea",
  cursor: "#f7c948",
  selectionBackground: "#334155"
};

const DARK_SHELL_TERMINAL_THEME: ITheme = {
  ...DARK_CLAUDE_TERMINAL_THEME,
  background: "#0d0f12"
};

// 浅色终端使用暖白底和克制的 ANSI 色，降低大面积纯白及高饱和色造成的视觉疲劳。
const LIGHT_TERMINAL_THEME: ITheme = {
  background: "#f7f7f5",
  foreground: "#242422",
  cursor: "#245d87",
  cursorAccent: "#f7f7f5",
  selectionBackground: "#d7e6f8",
  selectionForeground: "#17212b",
  selectionInactiveBackground: "#e5edf5",
  black: "#242422",
  red: "#9f2d25",
  green: "#176b45",
  yellow: "#805600",
  blue: "#245d87",
  magenta: "#77477c",
  cyan: "#0b626a",
  // 浅色终端里的 ANSI white 也必须是深色，否则 Claude 的状态点和提示符会消失在背景中。
  white: "#4b4b47",
  brightBlack: "#5f5f59",
  brightRed: "#b42318",
  brightGreen: "#18794e",
  brightYellow: "#946200",
  brightBlue: "#326891",
  brightMagenta: "#87558c",
  brightCyan: "#0f6f78",
  brightWhite: "#242422"
};

const DARK_SEARCH_OPTIONS: ISearchOptions = {
  decorations: {
    matchBackground: "#3f3620",
    matchBorder: "#7c6f32",
    matchOverviewRuler: "#d6b94c",
    activeMatchBackground: "#705d18",
    activeMatchBorder: "#f7c948",
    activeMatchColorOverviewRuler: "#f7c948"
  }
};

const LIGHT_SEARCH_OPTIONS: ISearchOptions = {
  decorations: {
    matchBackground: "#f6e6a7",
    matchBorder: "#c8a742",
    matchOverviewRuler: "#a77b00",
    activeMatchBackground: "#f0cf66",
    activeMatchBorder: "#946200",
    activeMatchColorOverviewRuler: "#946200"
  }
};

export type TerminalSurface = "claude" | "shell";

export function getTerminalTheme(theme: AppTheme, surface: TerminalSurface): ITheme {
  const selected = theme === "light"
    ? LIGHT_TERMINAL_THEME
    : surface === "shell"
      ? DARK_SHELL_TERMINAL_THEME
      : DARK_CLAUDE_TERMINAL_THEME;
  // 每次切换返回新对象，避免 xterm 复用上一个主题对象及其颜色缓存。
  return { ...selected };
}

export function getTerminalSearchOptions(theme: AppTheme): ISearchOptions {
  return theme === "light" ? LIGHT_SEARCH_OPTIONS : DARK_SEARCH_OPTIONS;
}

export function getTerminalMinimumContrastRatio(theme: AppTheme): number {
  // 浅色模式启用 WCAG AA 对比度保护，兼容 Claude 输出的 dim 和显式 RGB 浅色文字。
  return theme === "light" ? 4.5 : 1;
}

export function applyTerminalAppearance(
  terminal: Terminal,
  theme: AppTheme,
  surface: TerminalSurface
): void {
  // 先切换对比度策略，再替换独立色板并刷新可见区，防止浅色修正残留到深色主题。
  terminal.options.minimumContrastRatio = getTerminalMinimumContrastRatio(theme);
  terminal.options.theme = getTerminalTheme(theme, surface);
  terminal.refresh(0, Math.max(0, terminal.rows - 1));
}
