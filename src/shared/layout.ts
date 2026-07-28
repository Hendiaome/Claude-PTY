export const DEFAULT_SIDEBAR_WIDTH = 330;
export const COLLAPSED_SIDEBAR_WIDTH = 44;
export const MIN_SIDEBAR_WIDTH = 240;
export const MAX_SIDEBAR_WIDTH = 520;
export const DEFAULT_WINDOW_WIDTH = 1320;
export const DEFAULT_WINDOW_HEIGHT = 860;
export const MIN_WINDOW_WIDTH = 980;
export const MIN_WINDOW_HEIGHT = 640;

/** 拖动和持久化都复用同一宽度边界，避免异常设置把主工作区挤出视口。 */
export function clampSidebarWidth(width: number): number {
  return Math.min(Math.max(Math.round(width), MIN_SIDEBAR_WIDTH), MAX_SIDEBAR_WIDTH);
}

export function normalizeSidebarWidth(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_SIDEBAR_WIDTH;
  }

  return clampSidebarWidth(value);
}
