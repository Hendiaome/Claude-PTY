import { BrowserWindow, screen } from "electron";
import type {
  AppSettings,
  FloatingStatusSnapshot,
  FloatingWindowPosition
} from "../shared/types";
import { logError, logInfo } from "./appLogger";
import type { SettingsStore } from "./settingsStore";

// 收起态只保留状态图标和展开按钮，避免无活跃会话时长期占用横向空间。
const COLLAPSED_WIDTH = 92;
const COLLAPSED_HEIGHT = 56;
const EXPANDED_WIDTH = 340;
const MAX_EXPANDED_HEIGHT = 420;
const DEFAULT_MARGIN = 22;
const POSITION_SAVE_DELAY_MS = 300;

type FloatingStatusWindowOptions = {
  preloadPath: string;
  rendererFilePath: string;
  rendererUrl?: string;
  getSnapshot: () => FloatingStatusSnapshot;
  onOpenSession: (sessionId: string) => void;
};

/** 管理独立悬浮状态窗，只交换会话状态元数据，不接收或渲染终端正文。 */
export class FloatingStatusWindow {
  private window: BrowserWindow | null = null;
  private loaded = false;
  private moveSaveTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly settingsStore: SettingsStore,
    private readonly options: FloatingStatusWindowOptions
  ) {}

  syncEnabled(): void {
    const settings = this.settingsStore.getSettings();
    if (!settings.enableFloatingStatus) {
      this.destroy("settings-disabled");
      return;
    }
    this.ensureWindow();
    this.sendSettings(settings);
  }

  publish(snapshot = this.options.getSnapshot()): void {
    if (!this.window || this.window.isDestroyed() || !this.loaded) {
      return;
    }
    this.window.webContents.send("floating:status-updated", snapshot);
  }

  setExpanded(expanded: boolean, requestedHeight: number): void {
    const window = this.window;
    if (!window || window.isDestroyed()) {
      return;
    }
    const width = expanded ? EXPANDED_WIDTH : COLLAPSED_WIDTH;
    const height = expanded
      ? Math.min(Math.max(Math.round(requestedHeight), COLLAPSED_HEIGHT), MAX_EXPANDED_HEIGHT)
      : COLLAPSED_HEIGHT;
    const bounds = clampBoundsToDisplay({ ...window.getBounds(), width, height });
    window.setBounds(bounds, true);
    logInfo("floating-status", expanded ? "expanded" : "collapsed", { width, height });
  }

  openSession(sessionId: string): void {
    logInfo("floating-status", "session-open-requested", { sessionId });
    this.options.onOpenSession(sessionId);
  }

  stop(): void {
    this.destroy("app-stopping");
  }

  private ensureWindow(): void {
    if (this.window && !this.window.isDestroyed()) {
      return;
    }

    const settings = this.settingsStore.getSettings();
    const bounds = initialBounds(settings.floatingWindowPosition);
    const window = new BrowserWindow({
      ...bounds,
      acceptFirstMouse: true,
      alwaysOnTop: true,
      backgroundColor: "#00000000",
      frame: false,
      fullscreenable: false,
      hasShadow: true,
      maximizable: false,
      minimizable: false,
      movable: true,
      resizable: false,
      show: false,
      skipTaskbar: true,
      title: "Claude 会话状态",
      transparent: true,
      webPreferences: {
        preload: this.options.preloadPath,
        sandbox: false,
        contextIsolation: true,
        nodeIntegration: false
      }
    });
    this.window = window;
    this.loaded = false;
    window.setAlwaysOnTop(true, "floating");
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

    window.once("ready-to-show", () => {
      if (!window.isDestroyed()) {
        window.showInactive();
      }
    });
    window.webContents.on("did-finish-load", () => {
      this.loaded = true;
      this.sendSettings(this.settingsStore.getSettings());
      this.publish();
    });
    window.on("move", () => this.schedulePositionSave());
    window.on("closed", () => {
      this.clearPositionSaveTimer();
      if (this.window === window) {
        this.window = null;
        this.loaded = false;
      }
      logInfo("floating-status", "closed");
    });

    if (this.options.rendererUrl) {
      const url = new URL(this.options.rendererUrl);
      url.searchParams.set("window", "floating");
      window.loadURL(url.toString());
    } else {
      window.loadFile(this.options.rendererFilePath, { query: { window: "floating" } });
    }
    logInfo("floating-status", "created", { ...bounds, enabled: true });
  }

  private sendSettings(settings: AppSettings): void {
    if (!this.window || this.window.isDestroyed() || !this.loaded) {
      return;
    }
    this.window.webContents.send("floating:settings-updated", settings);
  }

  private schedulePositionSave(): void {
    this.clearPositionSaveTimer();
    this.moveSaveTimer = setTimeout(() => {
      this.moveSaveTimer = undefined;
      this.persistPosition("move");
    }, POSITION_SAVE_DELAY_MS);
  }

  private destroy(reason: string): void {
    this.clearPositionSaveTimer();
    this.persistPosition(reason);
    const window = this.window;
    this.window = null;
    this.loaded = false;
    if (window && !window.isDestroyed()) {
      window.destroy();
      logInfo("floating-status", "destroyed", { reason });
    }
  }

  private persistPosition(trigger: string): void {
    const window = this.window;
    if (!window || window.isDestroyed()) {
      return;
    }
    const { x, y } = window.getBounds();
    try {
      this.settingsStore.saveSettings({ floatingWindowPosition: { x, y } });
      logInfo("floating-status", "position-saved", { trigger, x, y });
    } catch (error) {
      logError("floating-status", "position-save-failed", error, { trigger, x, y });
    }
  }

  private clearPositionSaveTimer(): void {
    if (!this.moveSaveTimer) {
      return;
    }
    clearTimeout(this.moveSaveTimer);
    this.moveSaveTimer = undefined;
  }
}

function initialBounds(position: FloatingWindowPosition | undefined): Electron.Rectangle {
  if (!position) {
    const workArea = screen.getPrimaryDisplay().workArea;
    return {
      x: workArea.x + workArea.width - COLLAPSED_WIDTH - DEFAULT_MARGIN,
      y: workArea.y + DEFAULT_MARGIN,
      width: COLLAPSED_WIDTH,
      height: COLLAPSED_HEIGHT
    };
  }
  return clampBoundsToDisplay({
    ...position,
    width: COLLAPSED_WIDTH,
    height: COLLAPSED_HEIGHT
  });
}

function clampBoundsToDisplay(bounds: Electron.Rectangle): Electron.Rectangle {
  const workArea = screen.getDisplayMatching(bounds).workArea;
  const width = Math.min(bounds.width, workArea.width);
  const height = Math.min(bounds.height, workArea.height);
  return {
    x: clamp(bounds.x, workArea.x, workArea.x + workArea.width - width),
    y: clamp(bounds.y, workArea.y, workArea.y + workArea.height - height),
    width,
    height
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}
