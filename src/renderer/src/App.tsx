import { useCallback, useEffect, useState } from "react";
import { COLLAPSED_SIDEBAR_WIDTH, DEFAULT_SIDEBAR_WIDTH } from "../../shared/layout";
import type { AppSettings, AppTheme, FileOpenMode, UpdateInfo } from "../../shared/types";
import { ImportSessionDialog } from "./components/ImportSessionDialog";
import { RenameDialog } from "./components/RenameDialog";
import { SettingsDialog } from "./components/SettingsDialog";
import { SessionContextMenu } from "./components/SessionContextMenu";
import { Sidebar } from "./components/Sidebar";
import { SidebarResizeHandle } from "./components/SidebarResizeHandle";
import { Workspace } from "./components/Workspace";
import type { ShellTerminalState } from "./components/Workspace";
import { errorMessage } from "./hooks/terminalUtils";
import { useClaudeTerminal } from "./hooks/useClaudeTerminal";
import { useProjectShellTerminal } from "./hooks/useProjectShellTerminal";
import { useSessionWorkspace } from "./hooks/useSessionWorkspace";
import { useStructuredClaude } from "./hooks/useStructuredClaude";

/** 应用编排层：连接主进程能力、会话状态、两类终端和所有全局弹窗。 */
export function App(): JSX.Element {
  const [activeError, setActiveError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH);
  const [logPath, setLogPath] = useState("");
  const [availableUpdate, setAvailableUpdate] = useState<UpdateInfo | null>(null);
  const [shellTerminal, setShellTerminal] = useState<ShellTerminalState>(null);
  const [shellTerminalVisible, setShellTerminalVisible] = useState(false);
  const [shellPanelHeight, setShellPanelHeight] = useState(260);
  const [shellTerminalVersion, setShellTerminalVersion] = useState(0);
  // 计数值本身无业务含义，用于让重复点击当前会话也能再次触发终端聚焦。
  const [claudeTerminalFocusRequest, setClaudeTerminalFocusRequest] = useState(0);
  const appTheme = settings?.theme ?? "dark";

  const onError = useCallback((message: string) => setActiveError(message), []);
  const onShellExited = useCallback((projectId: string) => {
    if (shellTerminal?.projectId !== projectId) {
      return;
    }

    setShellTerminalVisible(false);
    setShellTerminal(null);
  }, [shellTerminal]);
  const sessionWorkspace = useSessionWorkspace(setActiveError);
  const structuredSessionId = sessionWorkspace.activeSession?.mode === "structured"
    ? sessionWorkspace.activeSessionId
    : null;
  const terminalSessionId = sessionWorkspace.activeSession?.mode === "structured"
    ? null
    : sessionWorkspace.activeSessionId;
  const {
    terminalHostRef,
    searchTerminal,
    clearTerminalSearch
  } = useClaudeTerminal({
    activeSessionId: terminalSessionId,
    focusRequest: claudeTerminalFocusRequest,
    theme: appTheme,
    onError,
    onSessionUpdated: sessionWorkspace.upsertUpdatedSession
  });
  const structuredClaude = useStructuredClaude({
    activeSessionId: structuredSessionId,
    onError
  });
  const shellHostRef = useProjectShellTerminal({
    shellTerminal,
    shellTerminalVisible,
    shellTerminalVersion,
    theme: appTheme,
    onError,
    onShellExited
  });

  useEffect(() => {
    // 主题挂在根节点，确保通过 Portal 渲染到 body 的 Tooltip 也能使用同一套颜色。
    document.documentElement.dataset.theme = appTheme;
    document.documentElement.style.colorScheme = appTheme;
  }, [appTheme]);

  useEffect(() => {
    if (!hasSettingsApi()) {
      return;
    }

    window.claudeManager
      .settingsGet()
      .then((currentSettings) => {
        setSettings(currentSettings);
        setSidebarCollapsed(currentSettings.sidebarCollapsed);
        setSidebarWidth(currentSettings.sidebarWidth);
      })
      .catch((error: unknown) => setActiveError(errorMessage(error)));
  }, []);

  useEffect(() => {
    if (!hasUpdateApi()) {
      return undefined;
    }

    window.claudeManager
      .updatesGetAvailable()
      .then((update) => {
        if (update) {
          setAvailableUpdate(update);
        }
      })
      .catch((error: unknown) => setActiveError(errorMessage(error)));

    return window.claudeManager.onUpdateAvailable((update) => {
      setAvailableUpdate(update);
    });
  }, []);

  const projectShellAvailable = hasProjectShellApi();

  const toggleProjectShell = async (): Promise<void> => {
    // 同一项目只切换面板可见性；切换项目时先结束旧 shell，避免底部存在多个后台终端。
    if (!sessionWorkspace.activeProject) {
      return;
    }

    setActiveError(null);
    try {
      if (!hasProjectShellApi()) {
        throw new Error("项目终端能力需要重启应用后生效。");
      }

      if (shellTerminal?.projectId === sessionWorkspace.activeProject.id) {
        setShellTerminalVisible((current) => !current);
        return;
      }

      if (shellTerminal?.projectId) {
        await window.claudeManager.shellStop(shellTerminal.projectId);
      }

      const info = await window.claudeManager.shellOpen(sessionWorkspace.activeProject.id);
      setShellTerminal(info);
      setShellTerminalVisible(true);
      setShellTerminalVersion((current) => current + 1);
    } catch (error: unknown) {
      setActiveError(errorMessage(error));
    }
  };

  const openSettingsDialog = async (): Promise<void> => {
    setActiveError(null);
    try {
      if (!hasSettingsApi()) {
        throw new Error("设置能力需要重启应用后生效。");
      }
      if (!hasLogsApi()) {
        throw new Error("系统日志能力需要重启应用后生效。");
      }

      const [currentSettings, logInfo] = await Promise.all([
        settings ? Promise.resolve(settings) : window.claudeManager.settingsGet(),
        window.claudeManager.logsGetInfo()
      ]);
      setSettings(currentSettings);
      setLogPath(logInfo.path);
      setSettingsOpen(true);
    } catch (error: unknown) {
      setActiveError(errorMessage(error));
    }
  };

  const saveSettings = async (
    patch: Pick<
      AppSettings,
      | "defaultEffort"
      | "enableBlockedPromptInstruction"
      | "enableFloatingStatus"
      | "updateFeedUrl"
      | "checkUpdatesAutomatically"
    >
  ): Promise<void> => {
    setActiveError(null);
    try {
      if (!hasSettingsApi()) {
        throw new Error("设置能力需要重启应用后生效。");
      }

      const saved = await window.claudeManager.settingsSave(patch);
      setSettings(saved);
      setAvailableUpdate(null);
      setSettingsOpen(false);
    } catch (error: unknown) {
      setActiveError(errorMessage(error));
    }
  };

  const changeFileOpenMode = async (fileOpenMode: FileOpenMode): Promise<void> => {
    // 先即时更新下拉框，持久化失败时再回滚到旧设置。
    setActiveError(null);
    const previousSettings = settings;
    if (settings) {
      setSettings({
        ...settings,
        fileOpenMode
      });
    }

    try {
      if (!hasSettingsApi()) {
        throw new Error("设置能力需要重启应用后生效。");
      }

      const saved = await window.claudeManager.settingsSave({ fileOpenMode });
      setSettings(saved);
    } catch (error: unknown) {
      setSettings(previousSettings);
      setActiveError(errorMessage(error));
    }
  };

  const changeTheme = async (theme: AppTheme): Promise<void> => {
    // 先刷新界面和终端配色；持久化失败时恢复原主题。
    setActiveError(null);
    const previousSettings = settings;
    if (settings) {
      setSettings({
        ...settings,
        theme
      });
    }

    try {
      if (!hasSettingsApi()) {
        throw new Error("设置能力需要重启应用后生效。");
      }

      const saved = await window.claudeManager.settingsSave({ theme });
      setSettings(saved);
    } catch (error: unknown) {
      setSettings(previousSettings);
      setActiveError(errorMessage(error));
    }
  };

  // 拖动过程只更新界面，结束拖动后再持久化，避免鼠标移动造成高频磁盘写入。
  const persistSidebarWidth = useCallback(async (width: number): Promise<void> => {
    setActiveError(null);
    try {
      if (!hasSettingsApi()) {
        throw new Error("设置能力需要重启应用后生效。");
      }

      const saved = await window.claudeManager.settingsSave({ sidebarWidth: width });
      setSettings(saved);
      setSidebarCollapsed(saved.sidebarCollapsed);
      setSidebarWidth(saved.sidebarWidth);
    } catch (error: unknown) {
      setActiveError(errorMessage(error));
    }
  }, []);

  const toggleSidebarCollapsed = useCallback(async (): Promise<void> => {
    // 收起状态采用乐观更新，保证按钮反馈即时；保存失败时恢复原状态。
    const previousCollapsed = sidebarCollapsed;
    const nextCollapsed = !previousCollapsed;
    setSidebarCollapsed(nextCollapsed);
    setActiveError(null);

    try {
      if (!hasSettingsApi()) {
        throw new Error("设置能力需要重启应用后生效。");
      }

      const saved = await window.claudeManager.settingsSave({ sidebarCollapsed: nextCollapsed });
      setSettings(saved);
      setSidebarCollapsed(saved.sidebarCollapsed);
      setSidebarWidth(saved.sidebarWidth);
    } catch (error: unknown) {
      setSidebarCollapsed(previousCollapsed);
      setActiveError(errorMessage(error));
    }
  }, [sidebarCollapsed]);

  const openUpdateDownload = async (): Promise<void> => {
    if (!availableUpdate) {
      return;
    }

    setActiveError(null);
    try {
      if (!hasUpdateApi()) {
        throw new Error("更新能力需要重启应用后生效。");
      }

      await window.claudeManager.updatesOpenDownload(availableUpdate.dmgUrl);
    } catch (error: unknown) {
      setActiveError(errorMessage(error));
    }
  };

  const openLogs = async (): Promise<void> => {
    setActiveError(null);
    try {
      await window.claudeManager.logsOpen();
    } catch (error: unknown) {
      setActiveError(errorMessage(error));
    }
  };

  const clearLogs = async (): Promise<void> => {
    if (!window.confirm("确认清空当前和历史系统日志吗？")) {
      return;
    }

    setActiveError(null);
    try {
      await window.claudeManager.logsClear();
    } catch (error: unknown) {
      setActiveError(errorMessage(error));
    }
  };

  const closeProjectShell = async (): Promise<void> => {
    const projectId = shellTerminal?.projectId;
    setShellTerminal(null);
    setShellTerminalVisible(false);
    if (!projectId) {
      return;
    }

    try {
      await window.claudeManager.shellStop(projectId);
    } catch (error: unknown) {
      setActiveError(errorMessage(error));
    }
  };
  const activeContextMenu = sessionWorkspace.contextMenu;
  const activeImportDialog = sessionWorkspace.importDialog;
  const activeRenameDialog = sessionWorkspace.renameDialog;

  return (
    <main
      className="app-shell"
      style={{
        gridTemplateColumns: sidebarCollapsed
          ? `${COLLAPSED_SIDEBAR_WIDTH}px minmax(0, 1fr)`
          : `${sidebarWidth}px 6px minmax(0, 1fr)`
      }}
    >
      <Sidebar
        activeSessionId={sessionWorkspace.activeSessionId}
        activeShellProjectId={shellTerminal?.projectId ?? null}
        activityStates={sessionWorkspace.sessionActivityStates}
        busySessionId={sessionWorkspace.busySessionId}
        collapsed={sidebarCollapsed}
        environment={sessionWorkspace.environment}
        expandedProjects={sessionWorkspace.expandedProjects}
        projects={sessionWorkspace.sidebarProjects}
        onAddProject={() => void sessionWorkspace.addProject()}
        onCreateSession={(projectId, mode) => void sessionWorkspace.createSession(projectId, mode)}
        onImportSession={sessionWorkspace.openImportDialog}
        onOpenSession={(session) => {
          setClaudeTerminalFocusRequest((current) => current + 1);
          void sessionWorkspace.openSession(session);
        }}
        onOpenSessionMenu={sessionWorkspace.openSessionMenu}
        onRemoveProject={(project) => void sessionWorkspace.removeProject(project)}
        onStopSession={(sessionId) => void sessionWorkspace.stopSession(sessionId)}
        onToggleCollapsed={() => void toggleSidebarCollapsed()}
        onToggleProject={sessionWorkspace.toggleProject}
      />

      {sidebarCollapsed ? null : (
        <SidebarResizeHandle
          width={sidebarWidth}
          onChange={setSidebarWidth}
          onCommit={(width) => void persistSidebarWidth(width)}
        />
      )}

      <Workspace
        activeError={activeError}
        activeProject={sessionWorkspace.activeProject}
        activeSession={sessionWorkspace.activeSession}
        activeSessionId={sessionWorkspace.activeSessionId}
        availableUpdate={availableUpdate}
        appTheme={appTheme}
        fileOpenMode={settings?.fileOpenMode ?? "idea"}
        projectShellAvailable={projectShellAvailable}
        shellHostRef={shellHostRef}
        shellPanelHeight={shellPanelHeight}
        shellTerminal={shellTerminal}
        shellTerminalVisible={shellTerminalVisible}
        terminalHostRef={terminalHostRef}
        structuredSnapshot={structuredClaude.snapshot}
        onChangeShellPanelHeight={setShellPanelHeight}
        onCloseProjectShell={() => void closeProjectShell()}
        onDismissUpdate={() => setAvailableUpdate(null)}
        onFileOpenModeChange={(mode) => void changeFileOpenMode(mode)}
        onThemeChange={(theme) => void changeTheme(theme)}
        onOpenProjectShell={() => void toggleProjectShell()}
        onOpenSettings={() => void openSettingsDialog()}
        onOpenUpdateDownload={() => void openUpdateDownload()}
        onSearchTerminal={searchTerminal}
        onCloseTerminalSearch={clearTerminalSearch}
        onStructuredSend={structuredClaude.send}
        onStructuredPermissionRespond={structuredClaude.respondPermission}
        onStructuredQuestionRespond={structuredClaude.respondQuestion}
        onStructuredInterrupt={structuredClaude.interrupt}
        onStructuredError={onError}
      />
      {activeContextMenu ? (
        <SessionContextMenu
          session={sessionWorkspace.sessions.find((session) => session.id === activeContextMenu.sessionId) ?? null}
          x={activeContextMenu.x}
          y={activeContextMenu.y}
          onRename={sessionWorkspace.openRenameDialog}
          onDelete={(sessionId) => void sessionWorkspace.removeSession(sessionId)}
        />
      ) : null}
      {activeImportDialog ? (
        <ImportSessionDialog
          projectName={activeImportDialog.projectName}
          submitting={sessionWorkspace.busySessionId === activeImportDialog.projectId}
          onCancel={() => sessionWorkspace.setImportDialog(null)}
          onSubmit={(claudeSessionId) =>
            void sessionWorkspace.importAndResumeSession(activeImportDialog.projectId, claudeSessionId)
          }
        />
      ) : null}
      {activeRenameDialog ? (
        <RenameDialog
          initialTitle={activeRenameDialog.title}
          onCancel={() => sessionWorkspace.setRenameDialog(null)}
          onSubmit={(title) => void sessionWorkspace.renameSession(activeRenameDialog.sessionId, title)}
        />
      ) : null}
      {settingsOpen && settings ? (
        <SettingsDialog
          logPath={logPath}
          settings={settings}
          onCancel={() => setSettingsOpen(false)}
          onClearLogs={() => void clearLogs()}
          onOpenLogs={() => void openLogs()}
          onSubmit={(patch) => void saveSettings(patch)}
        />
      ) : null}
    </main>
  );
}

function hasProjectShellApi(): boolean {
  const manager = window.claudeManager as Partial<Record<"shellOpen" | "shellStop", unknown>>;
  return typeof manager.shellOpen === "function" && typeof manager.shellStop === "function";
}

function hasSettingsApi(): boolean {
  const manager = window.claudeManager as Partial<Record<"settingsGet" | "settingsSave", unknown>>;
  return typeof manager.settingsGet === "function" && typeof manager.settingsSave === "function";
}

function hasUpdateApi(): boolean {
  const manager = window.claudeManager as Partial<
    Record<"onUpdateAvailable" | "updatesGetAvailable" | "updatesOpenDownload", unknown>
  >;
  return (
    typeof manager.onUpdateAvailable === "function" &&
    typeof manager.updatesGetAvailable === "function" &&
    typeof manager.updatesOpenDownload === "function"
  );
}

function hasLogsApi(): boolean {
  const manager = window.claudeManager as Partial<Record<"logsGetInfo" | "logsOpen" | "logsClear", unknown>>;
  return (
    typeof manager.logsGetInfo === "function" &&
    typeof manager.logsOpen === "function" &&
    typeof manager.logsClear === "function"
  );
}
