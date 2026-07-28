import { app } from "electron";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  DEFAULT_SIDEBAR_WIDTH,
  DEFAULT_WINDOW_HEIGHT,
  DEFAULT_WINDOW_WIDTH,
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  normalizeSidebarWidth
} from "../shared/layout";
import type {
  AppSettings,
  AppTheme,
  AppWindowState,
  ClaudeEffortLevel,
  FileOpenMode,
  FloatingWindowPosition
} from "../shared/types";
import { logError } from "./appLogger";

const SETTINGS_VERSION = 2;
const DEFAULT_UPDATE_FEED_URL = "https://raw.githubusercontent.com/Hendiaome/Claude-PTY/main/latest.json";
const EFFORT_LEVELS = new Set<ClaudeEffortLevel>(["low", "medium", "high", "max", "xhigh"]);

const DEFAULT_SETTINGS: AppSettings = {
  version: SETTINGS_VERSION,
  defaultEffort: "xhigh",
  enableBlockedPromptInstruction: true,
  fileOpenMode: "idea",
  theme: "dark",
  sidebarCollapsed: false,
  sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
  windowState: {
    width: DEFAULT_WINDOW_WIDTH,
    height: DEFAULT_WINDOW_HEIGHT,
    maximized: false
  },
  enableFloatingStatus: true,
  updateFeedUrl: DEFAULT_UPDATE_FEED_URL,
  checkUpdatesAutomatically: true
};

type AppSettingsPatch = Partial<Omit<AppSettings, "version">>;

/** 负责设置默认值、旧值兼容和原子持久化，renderer 不直接读写设置文件。 */
export class SettingsStore {
  private readonly settingsPath: string;
  private settings: AppSettings;

  constructor(settingsPath = join(app.getPath("userData"), "claude-pty-settings.json")) {
    this.settingsPath = settingsPath;
    this.settings = this.load();
  }

  get path(): string {
    return this.settingsPath;
  }

  getSettings(): AppSettings {
    return {
      ...this.settings,
      windowState: { ...this.settings.windowState },
      floatingWindowPosition: this.settings.floatingWindowPosition
        ? { ...this.settings.floatingWindowPosition }
        : undefined
    };
  }

  saveSettings(patch: AppSettingsPatch): AppSettings {
    this.settings = normalizeSettings({
      ...this.settings,
      ...patch
    });
    this.save();
    return this.getSettings();
  }

  private load(): AppSettings {
    if (!existsSync(this.settingsPath)) {
      return cloneSettings(DEFAULT_SETTINGS);
    }

    try {
      const raw = readFileSync(this.settingsPath, "utf8");
      return normalizeSettings(JSON.parse(raw) as Partial<AppSettings>);
    } catch (error) {
      const backupPath = `${this.settingsPath}.broken-${Date.now()}`;
      renameSync(this.settingsPath, backupPath);
      logError("settings", "load-failed", error, { settingsPath: this.settingsPath, backupPath });
      return cloneSettings(DEFAULT_SETTINGS);
    }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.settingsPath), { recursive: true });
      const tempPath = `${this.settingsPath}.tmp`;
      writeFileSync(tempPath, `${JSON.stringify(this.settings, null, 2)}\n`, "utf8");
      renameSync(tempPath, this.settingsPath);
    } catch (error) {
      logError("settings", "save-failed", error, { settingsPath: this.settingsPath });
      throw error;
    }
  }
}

function cloneSettings(settings: AppSettings): AppSettings {
  return {
    ...settings,
    windowState: { ...settings.windowState },
    floatingWindowPosition: settings.floatingWindowPosition
      ? { ...settings.floatingWindowPosition }
      : undefined
  };
}

function normalizeSettings(raw: Partial<AppSettings>): AppSettings {
  const defaultEffort = normalizeEffort(raw.defaultEffort);

  return {
    version: SETTINGS_VERSION,
    defaultEffort,
    // 旧设置没有该字段时默认开启，让结构化等待识别在升级后直接生效。
    enableBlockedPromptInstruction: raw.enableBlockedPromptInstruction !== false,
    fileOpenMode: normalizeFileOpenMode(raw.fileOpenMode),
    theme: normalizeTheme(raw.theme),
    sidebarCollapsed: raw.sidebarCollapsed === true,
    sidebarWidth: normalizeSidebarWidth(raw.sidebarWidth),
    windowState: normalizeWindowState(raw.windowState),
    enableFloatingStatus: raw.enableFloatingStatus !== false,
    floatingWindowPosition: normalizeFloatingWindowPosition(raw.floatingWindowPosition),
    updateFeedUrl: normalizeUpdateFeedUrl(raw.updateFeedUrl, raw.version),
    checkUpdatesAutomatically:
      typeof raw.checkUpdatesAutomatically === "boolean"
        ? raw.checkUpdatesAutomatically
        : DEFAULT_SETTINGS.checkUpdatesAutomatically
  };
}

function normalizeUpdateFeedUrl(value: unknown, storedVersion: unknown): string {
  // V1 使用发布前的默认更新源，升级到开源版本时统一迁移到仓库内 latest.json。
  if (storedVersion === 1) {
    return DEFAULT_SETTINGS.updateFeedUrl;
  }
  if (typeof value !== "string" || !value.trim()) {
    return DEFAULT_SETTINGS.updateFeedUrl;
  }
  return value.trim();
}

function normalizeWindowState(value: unknown): AppWindowState {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    x: normalizeOptionalInteger(record.x),
    y: normalizeOptionalInteger(record.y),
    width: normalizeWindowDimension(record.width, DEFAULT_WINDOW_WIDTH, MIN_WINDOW_WIDTH),
    height: normalizeWindowDimension(record.height, DEFAULT_WINDOW_HEIGHT, MIN_WINDOW_HEIGHT),
    maximized: record.maximized === true
  };
}

function normalizeFloatingWindowPosition(value: unknown): FloatingWindowPosition | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const x = normalizeOptionalInteger(record.x);
  const y = normalizeOptionalInteger(record.y);
  return x === undefined || y === undefined ? undefined : { x, y };
}

function normalizeWindowDimension(value: unknown, fallback: number, minimum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(Math.max(Math.round(value), minimum), 10_000);
}

function normalizeOptionalInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : undefined;
}

function normalizeFileOpenMode(value: unknown): FileOpenMode {
  return value === "system" ? "system" : "idea";
}

function normalizeTheme(value: unknown): AppTheme {
  // 旧版本没有主题字段，继续使用原深色外观，避免升级后未经选择改变界面。
  return value === "light" ? "light" : "dark";
}

function normalizeEffort(value: unknown): ClaudeEffortLevel {
  // Max 与 XHigh 是独立选项；默认值变更不能覆盖用户已经保存的合法级别。
  if (EFFORT_LEVELS.has(value as ClaudeEffortLevel)) {
    return value as ClaudeEffortLevel;
  }

  return DEFAULT_SETTINGS.defaultEffort;
}
