import { app, BrowserWindow, clipboard, dialog, ipcMain, powerMonitor, screen, shell } from "electron";
import { join } from "node:path";
import {
  DEFAULT_WINDOW_HEIGHT,
  DEFAULT_WINDOW_WIDTH,
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH
} from "../shared/layout";
import { AppStore } from "./store";
import { checkEnvironment } from "./environment";
import { TerminalManager } from "./terminalManager";
import { StructuredClaudeManager } from "./structuredClaudeManager";
import { SessionTitleService } from "./sessionTitleService";
import { ShellTerminalManager } from "./shellTerminalManager";
import { SettingsStore } from "./settingsStore";
import { UpdateService } from "./updateService";
import { attachDevDiagnostics, registerDevDiagnosticsIpc } from "./devDiagnostics";
import { FileOpenService } from "./fileOpenService";
import { ClaudeActivityHooks } from "./claudeActivityHooks";
import { FloatingStatusWindow } from "./floatingStatusWindow";
import { initializeAppLogger, logError, logInfo, logWarn } from "./appLogger";
import type { AppLogger } from "./appLogger";
import type {
  AppTheme,
  AppWindowState,
  FloatingStatusNotice,
  FloatingStatusSnapshot,
  SessionActivityState,
  SessionActivityStatus,
  SessionMode,
  StructuredPermissionDecision,
  StructuredQuestionAnswers
} from "../shared/types";

let mainWindow: BrowserWindow | null = null;
let store: AppStore | null = null;
let settingsStore: SettingsStore | null = null;
let terminals: TerminalManager | null = null;
let structuredClaude: StructuredClaudeManager | null = null;
let projectShells: ShellTerminalManager | null = null;
let titleService: SessionTitleService | null = null;
let updateService: UpdateService | null = null;
let fileOpenService: FileOpenService | null = null;
let activityHooks: ClaudeActivityHooks | null = null;
let floatingStatusWindow: FloatingStatusWindow | null = null;
let logger: AppLogger | null = null;
let pendingFloatingSessionId: string | undefined;
let quittingConfirmed = false;
const outputPauseReasons = new Set<"lock-screen" | "suspend">();
const WINDOW_STATE_SAVE_DELAY_MS = 350;

type RestoredWindowBounds = {
  x?: number;
  y?: number;
  width: number;
  height: number;
};

/** 创建唯一主窗口，并保持 renderer 与 Node 能力通过 preload 隔离。 */
function createWindow(): void {
  const savedWindowState = getSettingsStore().getSettings().windowState;
  const restoredBounds = resolveWindowBounds(savedWindowState);
  const window = new BrowserWindow({
    ...restoredBounds,
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    title: "Claude PTY Manager",
    backgroundColor: windowBackgroundColor(getSettingsStore().getSettings().theme),
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow = window;
  registerWindowStatePersistence(window, savedWindowState.maximized);
  if (savedWindowState.maximized) {
    window.maximize();
  }
  logInfo("window", "created", {
    id: window.id,
    restoredBounds,
    maximized: savedWindowState.maximized
  });
  attachDevDiagnostics(window);

  if (process.env.ELECTRON_RENDERER_URL) {
    window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    window.loadFile(join(__dirname, "../renderer/index.html"));
  }

  window.on("closed", () => {
    logInfo("window", "closed");
    if (mainWindow === window) {
      mainWindow = null;
    }
  });
  window.on("focus", () => {
    logInfo("window", "focused", { id: window.id });
    window.webContents.send("window:focused");
  });
  window.on("blur", () => {
    logInfo("window", "blurred", { id: window.id });
  });
}

/** 恢复窗口时按当前显示器工作区收敛边界，避免外接屏移除后窗口落在屏幕外。 */
function resolveWindowBounds(state: AppWindowState): RestoredWindowBounds {
  const primaryWorkArea = screen.getPrimaryDisplay().workArea;
  if (state.x === undefined || state.y === undefined) {
    return {
      width: Math.min(state.width || DEFAULT_WINDOW_WIDTH, primaryWorkArea.width),
      height: Math.min(state.height || DEFAULT_WINDOW_HEIGHT, primaryWorkArea.height)
    };
  }

  const display = screen.getDisplayMatching({
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height
  });
  const workArea = display.workArea;
  const width = Math.min(state.width, workArea.width);
  const height = Math.min(state.height, workArea.height);
  return {
    x: clamp(state.x, workArea.x, workArea.x + workArea.width - width),
    y: clamp(state.y, workArea.y, workArea.y + workArea.height - height),
    width,
    height
  };
}

function registerWindowStatePersistence(window: BrowserWindow, initiallyMaximized: boolean): void {
  let maximized = initiallyMaximized;
  let saveTimer: NodeJS.Timeout | undefined;

  const persist = (trigger: string): void => {
    if (window.isDestroyed()) {
      return;
    }
    const bounds = window.getNormalBounds();
    const windowState: AppWindowState = {
      ...bounds,
      maximized
    };
    try {
      getSettingsStore().saveSettings({ windowState });
      logInfo("window-state", "saved", { trigger, ...windowState });
    } catch (error) {
      // 窗口状态属于体验增强，保存失败不能阻断关闭或让应用崩溃。
      logError("window-state", "save-failed", error, { trigger, ...windowState });
    }
  };
  const schedule = (trigger: string): void => {
    if (saveTimer) {
      clearTimeout(saveTimer);
    }
    saveTimer = setTimeout(() => {
      saveTimer = undefined;
      persist(trigger);
    }, WINDOW_STATE_SAVE_DELAY_MS);
  };

  window.on("move", () => schedule("move"));
  window.on("resize", () => schedule("resize"));
  window.on("maximize", () => {
    maximized = true;
    schedule("maximize");
  });
  window.on("unmaximize", () => {
    maximized = false;
    schedule("unmaximize");
  });
  window.on("close", () => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = undefined;
    }
    persist("close");
  });
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

/** 锁屏和系统暂停可以重叠，只有所有原因都解除后才恢复终端输出交付。 */
function registerPowerOutputFlow(): void {
  powerMonitor.on("lock-screen", () => updateOutputPauseReason("lock-screen", true, "lock-screen"));
  powerMonitor.on("unlock-screen", () => updateOutputPauseReason("lock-screen", false, "unlock-screen"));
  powerMonitor.on("suspend", () => updateOutputPauseReason("suspend", true, "suspend"));
  powerMonitor.on("resume", () => updateOutputPauseReason("suspend", false, "resume"));
}

function updateOutputPauseReason(
  reason: "lock-screen" | "suspend",
  active: boolean,
  trigger: string
): void {
  const wasPaused = outputPauseReasons.size > 0;
  if (active) {
    outputPauseReasons.add(reason);
  } else {
    outputPauseReasons.delete(reason);
  }
  const paused = outputPauseReasons.size > 0;
  logInfo("power-state", active ? "pause-reason-added" : "pause-reason-removed", {
    reason,
    trigger,
    paused,
    activeReasons: [...outputPauseReasons]
  });
  if (wasPaused === paused) {
    return;
  }
  terminals?.setOutputPaused(paused, trigger);
  projectShells?.setOutputPaused(paused, trigger);
  if (!paused) {
    // 即使锁屏期间没有 PTY 输出，也要在窗口恢复后强制 Claude TUI 重新同步行列状态。
    mainWindow?.webContents.send("terminal:render-recovery-requested", {
      trigger: "power-resumed"
    });
    logInfo("terminal-render-recovery", "requested", { trigger });
  }
}

/** 集中注册 renderer 可调用的业务入口，实际状态和进程生命周期均由主进程管理。 */
function registerIpc(): void {
  registerDevDiagnosticsIpc(ipcMain);

  ipcMain.handle("environment:check", () => {
    const result = checkEnvironment();
    const data = {
      ok: result.ok,
      claudePath: result.claudePath,
      nodePath: result.nodePath,
      shellPath: result.shellPath,
      message: result.message
    };
    if (result.ok) {
      logInfo("environment", "check-succeeded", data);
    } else {
      logWarn("environment", "check-failed", data);
    }
    return result;
  });
  ipcMain.handle("store:path", () => getStore().path);
  ipcMain.handle("settings:get", () => getSettingsStore().getSettings());
  ipcMain.handle("settings:save", (_event, patch) => {
    const previousSettings = getSettingsStore().getSettings();
    const settings = getSettingsStore().saveSettings(patch);
    const changedKeys = patch && typeof patch === "object" ? Object.keys(patch) : [];
    logInfo("settings", "saved", {
      changedKeys,
      defaultEffort: settings.defaultEffort,
      enableBlockedPromptInstruction: settings.enableBlockedPromptInstruction,
      fileOpenMode: settings.fileOpenMode,
      theme: settings.theme,
      sidebarCollapsed: settings.sidebarCollapsed,
      sidebarWidth: settings.sidebarWidth,
      enableFloatingStatus: settings.enableFloatingStatus,
      checkUpdatesAutomatically: settings.checkUpdatesAutomatically
    });
    if (changedKeys.includes("sidebarWidth") && previousSettings.sidebarWidth !== settings.sidebarWidth) {
      logInfo("layout", "sidebar-resized", {
        previousWidth: previousSettings.sidebarWidth,
        width: settings.sidebarWidth
      });
    }
    if (
      changedKeys.includes("sidebarCollapsed") &&
      previousSettings.sidebarCollapsed !== settings.sidebarCollapsed
    ) {
      logInfo("layout", settings.sidebarCollapsed ? "sidebar-collapsed" : "sidebar-expanded", {
        sidebarWidth: settings.sidebarWidth
      });
    }
    if (changedKeys.includes("updateFeedUrl") || changedKeys.includes("checkUpdatesAutomatically")) {
      getUpdateService().restart();
    }
    if (
      changedKeys.includes("defaultEffort") &&
      previousSettings.defaultEffort !== settings.defaultEffort
    ) {
      logInfo("settings", "default-effort-changed", {
        previousEffort: previousSettings.defaultEffort,
        effort: settings.defaultEffort,
        appliesOn: "next-session-start"
      });
    }
    if (
      changedKeys.includes("enableBlockedPromptInstruction") &&
      previousSettings.enableBlockedPromptInstruction !== settings.enableBlockedPromptInstruction
    ) {
      logInfo("settings", "blocked-prompt-instruction-changed", {
        enabled: settings.enableBlockedPromptInstruction,
        appliesOn: "next-session-start"
      });
    }
    if (changedKeys.includes("theme") && previousSettings.theme !== settings.theme) {
      mainWindow?.setBackgroundColor(windowBackgroundColor(settings.theme));
      logInfo("appearance", "theme-changed", {
        previousTheme: previousSettings.theme,
        theme: settings.theme
      });
    }
    floatingStatusWindow?.syncEnabled();
    return settings;
  });

  ipcMain.handle("projects:list", () => getStore().listProjects());

  ipcMain.handle("projects:chooseAndAdd", async () => {
    const dialogOptions: Electron.OpenDialogOptions = {
      title: "选择 Claude 工作目录",
      properties: ["openDirectory", "createDirectory"]
    };
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions);

    if (result.canceled || result.filePaths.length === 0) {
      logInfo("project", "add-dialog-canceled");
      return undefined;
    }

    const project = getStore().addProject(result.filePaths[0]);
    logInfo("project", "added", { projectId: project.id, path: project.path });
    return project;
  });

  ipcMain.handle("projects:add", (_event, path: string) => {
    const project = getStore().addProject(path);
    logInfo("project", "added", { projectId: project.id, path: project.path });
    return project;
  });
  ipcMain.handle("projects:remove", (_event, projectId: string) => {
    const sessions = getStore().listSessions(projectId);
    const active = sessions.some(
      (session) =>
        session.status === "creating" || session.status === "running" || session.status === "stopping"
    );

    if (active) {
      logWarn("project", "remove-blocked-active-session", { projectId });
      throw new Error("该项目仍有活动中的 Claude 会话，请先结束会话再移除项目记录。");
    }
    if (getProjectShells().isRunning(projectId)) {
      logWarn("project", "remove-blocked-running-project-terminal", { projectId });
      throw new Error("该项目终端仍在运行，请先关闭项目终端再移除项目记录。");
    }

    getStore().removeProject(projectId);
    for (const session of sessions) {
      getTerminals().discardSession(session.id);
      getStructuredClaude().discardSession(session.id);
    }
    logInfo("project", "removed", { projectId, sessionCount: sessions.length });
    floatingStatusWindow?.publish();
  });

  ipcMain.handle("sessions:list", (_event, projectId?: string) => getStore().listSessions(projectId));
  ipcMain.handle("sessions:activityStates", () => [
    ...getTerminals().getActivityStates(),
    ...getStructuredClaude().getActivityStates()
  ]);
  ipcMain.handle("sessions:create", (_event, projectId: string, rawMode?: unknown) => {
    const mode = normalizeSessionMode(rawMode);
    return mode === "structured"
      ? getStructuredClaude().create(projectId)
      : getTerminals().create(projectId);
  });
  ipcMain.handle("sessions:importAndResume", (_event, projectId: string, claudeSessionId: unknown) =>
    getTerminals().importAndResume(projectId, claudeSessionId)
  );
  ipcMain.handle("sessions:resume", (_event, sessionId: string) => {
    const session = getStore().getSession(sessionId);
    if (!session) {
      throw new Error("会话不存在。");
    }
    return session.mode === "structured"
      ? getStructuredClaude().resume(sessionId)
      : getTerminals().resume(sessionId);
  });
  ipcMain.handle("sessions:stop", (_event, sessionId: string) => {
    const session = getStore().getSession(sessionId);
    return session?.mode === "structured"
      ? getStructuredClaude().stop(sessionId)
      : getTerminals().stop(sessionId);
  });
  ipcMain.handle("sessions:rename", (_event, sessionId: string, title: string) => {
    const session = getStore().renameSession(sessionId, title);
    logInfo("session", "renamed", { sessionId: session.id, projectId: session.projectId });
    mainWindow?.webContents.send("session:updated", session);
    floatingStatusWindow?.publish();
    return session;
  });
  ipcMain.handle("sessions:remove", (_event, sessionId: string) => {
    const session = getStore().getSession(sessionId);
    if (!session) {
      return;
    }

    if (session.status === "running" && isSessionProcessRunning(session.id, session.mode)) {
      logWarn("session", "remove-blocked-running", { sessionId: session.id, projectId: session.projectId });
      throw new Error("该 Claude 会话仍在运行，请先结束会话再删除记录。");
    }

    getStore().removeSession(session.id);
    getTerminals().discardSession(session.id);
    getStructuredClaude().discardSession(session.id);
    logInfo("session", "record-removed", { sessionId: session.id, projectId: session.projectId });
    floatingStatusWindow?.publish();
  });

  ipcMain.handle("floating:status", () => buildFloatingStatusSnapshot());
  ipcMain.handle("floating:setExpanded", (_event, expanded: unknown, height: unknown) => {
    if (typeof expanded !== "boolean" || typeof height !== "number" || !Number.isFinite(height)) {
      throw new Error("悬浮窗尺寸参数无效。");
    }
    floatingStatusWindow?.setExpanded(expanded, height);
  });
  ipcMain.handle("floating:openSession", (_event, sessionId: unknown) => {
    if (typeof sessionId !== "string" || !sessionId) {
      throw new Error("悬浮窗会话参数无效。");
    }
    floatingStatusWindow?.openSession(sessionId);
  });
  ipcMain.handle("floating:consumePendingSession", () => {
    const sessionId = pendingFloatingSessionId;
    pendingFloatingSessionId = undefined;
    return sessionId;
  });

  ipcMain.handle("terminal:input", (_event, sessionId: string, data: string) => getTerminals().write(sessionId, data));
  ipcMain.handle("terminal:resize", (_event, sessionId: string, cols: number, rows: number) =>
    getTerminals().resize(sessionId, cols, rows)
  );
  ipcMain.handle("terminal:buffer", (_event, sessionId: string) => getTerminals().getBuffer(sessionId));
  ipcMain.handle("terminal:pathOpen", (_event, request: unknown) => getFileOpenService().open(request));
  ipcMain.handle("terminal:copyText", (_event, text: unknown) => {
    // 只接受有限长度的纯文本，避免 renderer 借通用 IPC 传递任意对象或超大数据。
    if (typeof text !== "string" || text.length === 0 || text.length > 10_000_000) {
      throw new Error("无效的剪贴板文本。");
    }
    clipboard.writeText(text);
  });

  ipcMain.handle("structured:snapshot", (_event, sessionId: string) =>
    getStructuredClaude().getSnapshot(sessionId)
  );
  ipcMain.handle("structured:send", (_event, sessionId: string, text: unknown) =>
    getStructuredClaude().send(sessionId, text)
  );
  ipcMain.handle(
    "structured:permissionRespond",
    (_event, sessionId: string, requestId: unknown, decision: StructuredPermissionDecision) =>
      getStructuredClaude().respondPermission(sessionId, requestId, decision)
  );
  ipcMain.handle(
    "structured:questionRespond",
    (_event, sessionId: string, requestId: unknown, answers: StructuredQuestionAnswers | null) =>
      getStructuredClaude().respondQuestion(sessionId, requestId, answers)
  );
  ipcMain.handle("structured:interrupt", (_event, sessionId: string) =>
    getStructuredClaude().interrupt(sessionId)
  );

  ipcMain.handle("shell:open", (_event, projectId: string) => getProjectShells().open(projectId));
  ipcMain.handle("shell:input", (_event, projectId: string, data: string) => getProjectShells().write(projectId, data));
  ipcMain.handle("shell:resize", (_event, projectId: string, cols: number, rows: number) =>
    getProjectShells().resize(projectId, cols, rows)
  );
  ipcMain.handle("shell:stop", (_event, projectId: string) => getProjectShells().stop(projectId));
  ipcMain.handle("shell:buffer", (_event, projectId: string) => getProjectShells().getBuffer(projectId));

  ipcMain.handle("updates:getAvailable", () => getUpdateService().getAvailableUpdate());
  ipcMain.handle("updates:openDownload", (_event, url: string) => getUpdateService().openDownload(url));

  ipcMain.handle("logs:getInfo", () => ({ path: getLogger().path }));
  ipcMain.handle("logs:open", async () => {
    logInfo("logs", "open-requested", { path: getLogger().path });
    const error = await shell.openPath(getLogger().path);
    if (error) {
      logError("logs", "open-failed", error, { path: getLogger().path });
      throw new Error(`打开日志失败：${error}`);
    }
  });
  ipcMain.handle("logs:clear", () => {
    if (!getLogger().clear()) {
      throw new Error("清空日志失败，请检查日志文件权限。");
    }
    logInfo("logs", "cleared", { path: getLogger().path });
  });

  ipcMain.handle("app:openStoreFile", () => shell.openPath(getStore().path));
}

app.whenReady().then(async () => {
  logger = initializeAppLogger(join(app.getPath("logs"), "claude-pty.log"));
  registerProcessDiagnostics();
  logInfo("app", "ready", {
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron,
    node: process.versions.node,
    logPath: logger.path
  });
  store = new AppStore();
  settingsStore = new SettingsStore();
  activityHooks = new ClaudeActivityHooks(
    join(app.getPath("userData"), "claude-pty-activity-plugin"),
    (signal) => {
      const session = store?.getSession(signal.sessionId);
      if (session?.mode === "structured") {
        structuredClaude?.applyActivitySignal(signal);
      } else {
        terminals?.applyActivitySignal(signal);
      }
    }
  );
  try {
    await activityHooks.start();
  } catch (error) {
    logError("session-activity-hook", "start-failed", error);
    activityHooks = null;
  }
  terminals = new TerminalManager(
    store,
    settingsStore,
    () => mainWindow,
    activityHooks ?? undefined,
    {
      onSessionChanged: () => floatingStatusWindow?.publish(),
      onActivityChanged: (state, previousState, source) => {
        const notice = createFloatingStatusNotice(state, previousState);
        floatingStatusWindow?.publish(buildFloatingStatusSnapshot(notice));
        if (notice) {
          logInfo("floating-status", "notice-published", {
            sessionId: notice.sessionId,
            kind: notice.kind,
            source
          });
        }
      }
    }
  );
  structuredClaude = new StructuredClaudeManager(
    store,
    settingsStore,
    () => mainWindow,
    activityHooks ?? undefined,
    {
      onSessionChanged: () => floatingStatusWindow?.publish(),
      onActivityChanged: (state, previousState, source) => {
        const notice = createFloatingStatusNotice(state, previousState);
        floatingStatusWindow?.publish(buildFloatingStatusSnapshot(notice));
        if (notice) {
          logInfo("floating-status", "notice-published", {
            sessionId: notice.sessionId,
            kind: notice.kind,
            source,
            mode: "structured"
          });
        }
      }
    }
  );
  projectShells = new ShellTerminalManager(store, () => mainWindow);
  registerPowerOutputFlow();
  titleService = new SessionTitleService(store, () => mainWindow);
  updateService = new UpdateService(settingsStore, () => mainWindow);
  fileOpenService = new FileOpenService(settingsStore);
  floatingStatusWindow = new FloatingStatusWindow(settingsStore, {
    preloadPath: join(__dirname, "../preload/index.js"),
    rendererFilePath: join(__dirname, "../renderer/index.html"),
    rendererUrl: process.env.ELECTRON_RENDERER_URL,
    getSnapshot: () => buildFloatingStatusSnapshot(),
    onOpenSession: (sessionId) => openMainWindowSession(sessionId)
  });
  registerIpc();
  createWindow();
  floatingStatusWindow.syncEnabled();
  titleService.start();
  updateService.start();

  app.on("activate", (_event, hasVisibleWindows) => {
    logInfo("window", "dock-activated", {
      hasVisibleWindows,
      mainWindowExists: Boolean(mainWindow && !mainWindow.isDestroyed())
    });
    focusMainWindow("dock-activate");
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

// 有托管会话时先确认退出，避免关闭窗口时无提示地杀掉 Claude 进程。
app.on("before-quit", (event) => {
  logInfo("app", "before-quit", {
    quittingConfirmed,
    runningClaudeTerminals: terminals?.hasRunningTerminals() ?? false,
    runningStructuredClaude: structuredClaude?.hasRunningProcesses() ?? false
  });
  if (
    quittingConfirmed ||
    (!terminals?.hasRunningTerminals() && !structuredClaude?.hasRunningProcesses())
  ) {
    return;
  }

  const messageOptions: Electron.MessageBoxSyncOptions = {
    type: "warning",
    buttons: ["取消", "退出并结束 Claude 会话"],
    defaultId: 0,
    cancelId: 0,
    title: "仍有 Claude 会话运行中",
    message: "退出应用会结束当前托管的 Claude 终端进程。"
  };
  const choice = mainWindow
    ? dialog.showMessageBoxSync(mainWindow, messageOptions)
    : dialog.showMessageBoxSync(messageOptions);

  if (choice === 0) {
    logInfo("app", "quit-canceled");
    event.preventDefault();
    return;
  }

  quittingConfirmed = true;
  titleService?.stop();
  updateService?.stop();
  terminals?.stopAll();
  structuredClaude?.stopAll();
  projectShells?.stopAll();
});

app.on("will-quit", () => {
  logInfo("app", "will-quit");
  activityHooks?.stop();
  floatingStatusWindow?.stop();
  updateService?.stop();
  projectShells?.stopAll();
  structuredClaude?.stopAll();
});

function getStore(): AppStore {
  if (!store) {
    throw new Error("Store has not been initialized.");
  }

  return store;
}

function getSettingsStore(): SettingsStore {
  if (!settingsStore) {
    throw new Error("Settings store has not been initialized.");
  }

  return settingsStore;
}

function windowBackgroundColor(theme: AppTheme): string {
  return theme === "light" ? "#f7f7f5" : "#101114";
}

function getTerminals(): TerminalManager {
  if (!terminals) {
    throw new Error("Terminal manager has not been initialized.");
  }

  return terminals;
}

function getProjectShells(): ShellTerminalManager {
  if (!projectShells) {
    throw new Error("Shell terminal manager has not been initialized.");
  }

  return projectShells;
}

function getStructuredClaude(): StructuredClaudeManager {
  if (!structuredClaude) {
    throw new Error("Structured Claude manager has not been initialized.");
  }
  return structuredClaude;
}

function getUpdateService(): UpdateService {
  if (!updateService) {
    throw new Error("Update service has not been initialized.");
  }

  return updateService;
}

function getLogger(): AppLogger {
  if (!logger) {
    throw new Error("Logger has not been initialized.");
  }

  return logger;
}

function getFileOpenService(): FileOpenService {
  if (!fileOpenService) {
    throw new Error("File open service has not been initialized.");
  }

  return fileOpenService;
}

function buildFloatingStatusSnapshot(notice?: FloatingStatusNotice): FloatingStatusSnapshot {
  const activityStates = new Map(
    [...getTerminals().getActivityStates(), ...getStructuredClaude().getActivityStates()].map(
      (state) => [state.sessionId, state]
    )
  );
  const projectNames = new Map(getStore().listProjects().map((project) => [project.id, project.name]));
  const sessions = getStore()
    .listSessions()
    .filter(
      (session) =>
        session.status === "running" && isSessionProcessRunning(session.id, session.mode)
    )
    .map((session) => {
      const activity = activityStates.get(session.id);
      return {
        sessionId: session.id,
        title: session.title,
        projectName: projectNames.get(session.projectId) ?? "未知项目",
        state: activity?.state ?? "idle" as const,
        updatedAt: activity?.updatedAt ?? session.updatedAt
      };
    })
    .sort((left, right) => {
      const priority: Record<SessionActivityStatus, number> = { blocked: 0, working: 1, idle: 2 };
      return priority[left.state] - priority[right.state] || right.updatedAt.localeCompare(left.updatedAt);
    });
  return { sessions, ...(notice ? { notice } : {}) };
}

function normalizeSessionMode(value: unknown): SessionMode {
  if (value === undefined || value === "terminal") {
    return "terminal";
  }
  if (value === "structured") {
    return "structured";
  }
  throw new Error("会话模式无效。");
}

function isSessionProcessRunning(sessionId: string, mode: SessionMode): boolean {
  return mode === "structured"
    ? getStructuredClaude().isRunning(sessionId)
    : getTerminals().isRunning(sessionId);
}

function createFloatingStatusNotice(
  state: SessionActivityState,
  previousState: SessionActivityStatus | undefined
): FloatingStatusNotice | undefined {
  if (state.state === "blocked") {
    return { sessionId: state.sessionId, kind: "blocked", createdAt: state.updatedAt };
  }
  if (state.state === "idle" && previousState === "working") {
    return { sessionId: state.sessionId, kind: "completed", createdAt: state.updatedAt };
  }
  return undefined;
}

function openMainWindowSession(sessionId: string): void {
  if (!getStore().getSession(sessionId)) {
    logWarn("floating-status", "session-not-found", { sessionId });
    return;
  }
  pendingFloatingSessionId = sessionId;
  const window = focusMainWindow("floating-session");
  if (!window) {
    return;
  }
  const selectSession = (): void => {
    window.webContents.send("session:select-requested", { sessionId });
    logInfo("floating-status", "session-opened", { sessionId });
  };
  if (window.webContents.isLoadingMainFrame()) {
    window.webContents.once("did-finish-load", selectSession);
  } else {
    selectSession();
  }
}

/** Dock 或悬浮窗属于明确的用户操作，此时应把主窗口恢复到最前，而不是被常驻悬浮窗拦截。 */
function focusMainWindow(trigger: "dock-activate" | "floating-session"): BrowserWindow | null {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
  }
  const window = mainWindow;
  if (!window) {
    return null;
  }
  const wasMinimized = window.isMinimized();
  const wasVisible = window.isVisible();
  if (wasMinimized) {
    window.restore();
  }
  window.show();
  if (process.platform === "darwin") {
    app.focus({ steal: true });
  }
  window.focus();
  logInfo("window", "main-focused-by-user-action", {
    trigger,
    windowId: window.id,
    wasMinimized,
    wasVisible
  });
  return window;
}

function registerProcessDiagnostics(): void {
  process.on("uncaughtExceptionMonitor", (error, origin) => {
    logError("process", "uncaught-exception", error, { origin });
  });
  process.on("unhandledRejection", (reason) => {
    logError("process", "unhandled-rejection", reason);
  });
}
