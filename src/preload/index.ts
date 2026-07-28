import { contextBridge, ipcRenderer, webUtils } from "electron";
import { fileURLToPath } from "node:url";
import type {
  AppLogInfo,
  EnvironmentCheckResult,
  AppSettings,
  FloatingStatusSnapshot,
  ProjectRecord,
  SessionActivityState,
  SessionMode,
  SessionRecord,
  SessionSelectionRequestEvent,
  ShellTerminalDataEvent,
  ShellTerminalExitEvent,
  ShellTerminalInfo,
  ShellTerminalOutputResumedEvent,
  TerminalDataEvent,
  TerminalExitEvent,
  TerminalFilePasteEvent,
  TerminalInteractionLogRequest,
  TerminalOutputResumedEvent,
  TerminalPathOpenRequest,
  TerminalRenderRecoveryRequestEvent,
  StructuredPermissionDecision,
  StructuredQuestionAnswers,
  StructuredSessionSnapshot,
  StructuredSnapshotUpdatedEvent,
  StructuredTextDeltaEvent,
  UpdateInfo
} from "../shared/types";

type Unsubscribe = () => void;

const terminalFilePasteCallbacks = new Set<(event: TerminalFilePasteEvent) => void>();

// contextBridge 是 renderer 访问主进程能力的唯一入口，避免直接暴露 ipcRenderer。
const api = {
  environmentCheck: (): Promise<EnvironmentCheckResult> => ipcRenderer.invoke("environment:check"),
  getStorePath: (): Promise<string> => ipcRenderer.invoke("store:path"),
  openStoreFile: (): Promise<string> => ipcRenderer.invoke("app:openStoreFile"),
  settingsGet: (): Promise<AppSettings> => ipcRenderer.invoke("settings:get"),
  settingsSave: (patch: Partial<Omit<AppSettings, "version">>): Promise<AppSettings> =>
    ipcRenderer.invoke("settings:save", patch),
  floatingGetStatus: (): Promise<FloatingStatusSnapshot> => ipcRenderer.invoke("floating:status"),
  floatingSetExpanded: (expanded: boolean, height: number): Promise<void> =>
    ipcRenderer.invoke("floating:setExpanded", expanded, height),
  floatingOpenSession: (sessionId: string): Promise<void> =>
    ipcRenderer.invoke("floating:openSession", sessionId),
  floatingConsumePendingSession: (): Promise<string | undefined> =>
    ipcRenderer.invoke("floating:consumePendingSession"),

  projectsList: (): Promise<ProjectRecord[]> => ipcRenderer.invoke("projects:list"),
  projectsChooseAndAdd: (): Promise<ProjectRecord | undefined> => ipcRenderer.invoke("projects:chooseAndAdd"),
  projectsAdd: (path: string): Promise<ProjectRecord> => ipcRenderer.invoke("projects:add", path),
  projectsRemove: (projectId: string): Promise<void> => ipcRenderer.invoke("projects:remove", projectId),

  sessionsList: (projectId?: string): Promise<SessionRecord[]> => ipcRenderer.invoke("sessions:list", projectId),
  sessionsActivityStates: (): Promise<SessionActivityState[]> => ipcRenderer.invoke("sessions:activityStates"),
  sessionsCreate: (projectId: string, mode: SessionMode = "terminal"): Promise<SessionRecord> =>
    ipcRenderer.invoke("sessions:create", projectId, mode),
  sessionsImportAndResume: (projectId: string, claudeSessionId: string): Promise<SessionRecord> =>
    ipcRenderer.invoke("sessions:importAndResume", projectId, claudeSessionId),
  sessionsResume: (sessionId: string): Promise<SessionRecord> => ipcRenderer.invoke("sessions:resume", sessionId),
  sessionsStop: (sessionId: string): Promise<void> => ipcRenderer.invoke("sessions:stop", sessionId),
  sessionsRename: (sessionId: string, title: string): Promise<SessionRecord> =>
    ipcRenderer.invoke("sessions:rename", sessionId, title),
  sessionsRemove: (sessionId: string): Promise<void> => ipcRenderer.invoke("sessions:remove", sessionId),

  terminalInput: (sessionId: string, data: string): Promise<void> =>
    ipcRenderer.invoke("terminal:input", sessionId, data),
  terminalResize: (sessionId: string, cols: number, rows: number): Promise<void> =>
    ipcRenderer.invoke("terminal:resize", sessionId, cols, rows),
  terminalGetBuffer: (sessionId: string): Promise<string[]> => ipcRenderer.invoke("terminal:buffer", sessionId),
  terminalPathOpen: (request: TerminalPathOpenRequest): Promise<void> =>
    ipcRenderer.invoke("terminal:pathOpen", request),
  terminalInteractionLog: (request: TerminalInteractionLogRequest): void =>
    ipcRenderer.send("diagnostics:terminal-interaction", request),
  // 剪贴板属于主进程能力，preload 只保留受控 IPC 桥接，兼容新版 Electron。
  terminalCopyText: (text: string): Promise<void> => ipcRenderer.invoke("terminal:copyText", text),
  onTerminalFilePaste: (callback: (event: TerminalFilePasteEvent) => void): Unsubscribe => {
    terminalFilePasteCallbacks.add(callback);
    return () => {
      terminalFilePasteCallbacks.delete(callback);
    };
  },

  structuredGetSnapshot: (sessionId: string): Promise<StructuredSessionSnapshot> =>
    ipcRenderer.invoke("structured:snapshot", sessionId),
  structuredSend: (sessionId: string, text: string): Promise<void> =>
    ipcRenderer.invoke("structured:send", sessionId, text),
  structuredRespondPermission: (
    sessionId: string,
    requestId: string,
    decision: StructuredPermissionDecision
  ): Promise<void> => ipcRenderer.invoke("structured:permissionRespond", sessionId, requestId, decision),
  structuredRespondQuestion: (
    sessionId: string,
    requestId: string,
    answers: StructuredQuestionAnswers | null
  ): Promise<void> => ipcRenderer.invoke("structured:questionRespond", sessionId, requestId, answers),
  structuredInterrupt: (sessionId: string): Promise<void> =>
    ipcRenderer.invoke("structured:interrupt", sessionId),

  shellOpen: (projectId: string): Promise<ShellTerminalInfo> => ipcRenderer.invoke("shell:open", projectId),
  shellInput: (projectId: string, data: string): Promise<void> => ipcRenderer.invoke("shell:input", projectId, data),
  shellResize: (projectId: string, cols: number, rows: number): Promise<void> =>
    ipcRenderer.invoke("shell:resize", projectId, cols, rows),
  shellStop: (projectId: string): Promise<void> => ipcRenderer.invoke("shell:stop", projectId),
  shellGetBuffer: (projectId: string): Promise<string[]> => ipcRenderer.invoke("shell:buffer", projectId),
  updatesGetAvailable: (): Promise<UpdateInfo | undefined> => ipcRenderer.invoke("updates:getAvailable"),
  updatesOpenDownload: (url: string): Promise<void> => ipcRenderer.invoke("updates:openDownload", url),
  logsGetInfo: (): Promise<AppLogInfo> => ipcRenderer.invoke("logs:getInfo"),
  logsOpen: (): Promise<void> => ipcRenderer.invoke("logs:open"),
  logsClear: (): Promise<void> => ipcRenderer.invoke("logs:clear"),

  onTerminalData: (callback: (event: TerminalDataEvent) => void): Unsubscribe => {
    const listener = (_event: Electron.IpcRendererEvent, payload: TerminalDataEvent) => callback(payload);
    ipcRenderer.on("terminal:data", listener);
    return () => ipcRenderer.off("terminal:data", listener);
  },
  onTerminalExit: (callback: (event: TerminalExitEvent) => void): Unsubscribe => {
    const listener = (_event: Electron.IpcRendererEvent, payload: TerminalExitEvent) => callback(payload);
    ipcRenderer.on("terminal:exit", listener);
    return () => ipcRenderer.off("terminal:exit", listener);
  },
  onTerminalOutputResumed: (callback: (event: TerminalOutputResumedEvent) => void): Unsubscribe => {
    const listener = (_event: Electron.IpcRendererEvent, payload: TerminalOutputResumedEvent) => callback(payload);
    ipcRenderer.on("terminal:output-resumed", listener);
    return () => ipcRenderer.off("terminal:output-resumed", listener);
  },
  onFloatingStatusUpdated: (callback: (snapshot: FloatingStatusSnapshot) => void): Unsubscribe => {
    const listener = (_event: Electron.IpcRendererEvent, snapshot: FloatingStatusSnapshot) => callback(snapshot);
    ipcRenderer.on("floating:status-updated", listener);
    return () => ipcRenderer.off("floating:status-updated", listener);
  },
  onFloatingSettingsUpdated: (callback: (settings: AppSettings) => void): Unsubscribe => {
    const listener = (_event: Electron.IpcRendererEvent, settings: AppSettings) => callback(settings);
    ipcRenderer.on("floating:settings-updated", listener);
    return () => ipcRenderer.off("floating:settings-updated", listener);
  },
  onSessionSelectRequested: (callback: (event: SessionSelectionRequestEvent) => void): Unsubscribe => {
    const listener = (_event: Electron.IpcRendererEvent, payload: SessionSelectionRequestEvent) => callback(payload);
    ipcRenderer.on("session:select-requested", listener);
    return () => ipcRenderer.off("session:select-requested", listener);
  },
  onShellData: (callback: (event: ShellTerminalDataEvent) => void): Unsubscribe => {
    const listener = (_event: Electron.IpcRendererEvent, payload: ShellTerminalDataEvent) => callback(payload);
    ipcRenderer.on("shell:data", listener);
    return () => ipcRenderer.off("shell:data", listener);
  },
  onShellExit: (callback: (event: ShellTerminalExitEvent) => void): Unsubscribe => {
    const listener = (_event: Electron.IpcRendererEvent, payload: ShellTerminalExitEvent) => callback(payload);
    ipcRenderer.on("shell:exit", listener);
    return () => ipcRenderer.off("shell:exit", listener);
  },
  onShellOutputResumed: (callback: (event: ShellTerminalOutputResumedEvent) => void): Unsubscribe => {
    const listener = (_event: Electron.IpcRendererEvent, payload: ShellTerminalOutputResumedEvent) => callback(payload);
    ipcRenderer.on("shell:output-resumed", listener);
    return () => ipcRenderer.off("shell:output-resumed", listener);
  },
  onUpdateAvailable: (callback: (update: UpdateInfo) => void): Unsubscribe => {
    const listener = (_event: Electron.IpcRendererEvent, payload: UpdateInfo) => callback(payload);
    ipcRenderer.on("update:available", listener);
    return () => ipcRenderer.off("update:available", listener);
  },
  onSessionUpdated: (callback: (session: SessionRecord) => void): Unsubscribe => {
    const listener = (_event: Electron.IpcRendererEvent, payload: SessionRecord) => callback(payload);
    ipcRenderer.on("session:updated", listener);
    return () => ipcRenderer.off("session:updated", listener);
  },
  onSessionActivityState: (callback: (state: SessionActivityState) => void): Unsubscribe => {
    const listener = (_event: Electron.IpcRendererEvent, payload: SessionActivityState) => callback(payload);
    ipcRenderer.on("session:activity-state", listener);
    return () => ipcRenderer.off("session:activity-state", listener);
  },
  onStructuredSnapshotUpdated: (callback: (event: StructuredSnapshotUpdatedEvent) => void): Unsubscribe => {
    const listener = (_event: Electron.IpcRendererEvent, payload: StructuredSnapshotUpdatedEvent) => callback(payload);
    ipcRenderer.on("structured:snapshot-updated", listener);
    return () => ipcRenderer.off("structured:snapshot-updated", listener);
  },
  onStructuredTextDelta: (callback: (event: StructuredTextDeltaEvent) => void): Unsubscribe => {
    const listener = (_event: Electron.IpcRendererEvent, payload: StructuredTextDeltaEvent) => callback(payload);
    ipcRenderer.on("structured:text-delta", listener);
    return () => ipcRenderer.off("structured:text-delta", listener);
  },
  onProjectUpdated: (callback: (project: ProjectRecord) => void): Unsubscribe => {
    const listener = (_event: Electron.IpcRendererEvent, payload: ProjectRecord) => callback(payload);
    ipcRenderer.on("project:updated", listener);
    return () => ipcRenderer.off("project:updated", listener);
  },
  onWindowFocused: (callback: () => void): Unsubscribe => {
    const listener = () => callback();
    ipcRenderer.on("window:focused", listener);
    return () => ipcRenderer.off("window:focused", listener);
  },
  onTerminalRenderRecoveryRequested: (
    callback: (event: TerminalRenderRecoveryRequestEvent) => void
  ): Unsubscribe => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      payload: TerminalRenderRecoveryRequestEvent
    ) => callback(payload);
    ipcRenderer.on("terminal:render-recovery-requested", listener);
    return () => ipcRenderer.off("terminal:render-recovery-requested", listener);
  }
};

contextBridge.exposeInMainWorld("claudeManager", api);
installRendererDiagnostics();
installTerminalFilePasteBridge();

export type ClaudeManagerApi = typeof api;

function installRendererDiagnostics(): void {
  // renderer 的未捕获异常统一送到主进程，确保生产包也能落入持久化日志。
  window.addEventListener("error", (event) => {
    ipcRenderer.send("diagnostics:renderer-error", {
      type: "error",
      message: event.message,
      stack: event.error instanceof Error ? event.error.stack : undefined,
      source: event.filename,
      line: event.lineno,
      column: event.colno
    });
  });

  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    ipcRenderer.send("diagnostics:renderer-error", {
      type: "unhandledrejection",
      message: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined
    });
  });
}

function installTerminalFilePasteBridge(): void {
  // 文件真实路径只能通过 preload 的 webUtils 安全提取，renderer 只接收提取后的结果。
  window.addEventListener(
    "paste",
    (event) => {
      if (!isClaudeTerminalTarget(event.target)) {
        return;
      }

      const paths = clipboardFilePaths(event.clipboardData);
      if (paths.length === 0) {
        // 没有文件路径时不拦截，继续交给 xterm 处理普通文本粘贴。
        return;
      }

      event.preventDefault();
      event.stopImmediatePropagation();
      const payload: TerminalFilePasteEvent = { paths };
      for (const callback of terminalFilePasteCallbacks) {
        callback(payload);
      }
    },
    true
  );
}

function isClaudeTerminalTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest(".terminal-host"));
}

function clipboardFilePaths(dataTransfer: DataTransfer | null): string[] {
  if (!dataTransfer) {
    return [];
  }

  const files =
    dataTransfer.files.length > 0
      ? Array.from(dataTransfer.files)
      : Array.from(dataTransfer.items)
          .filter((item) => item.kind === "file")
          .map((item) => item.getAsFile())
          .filter((file): file is File => Boolean(file));
  const paths = files.flatMap((file) => {
    try {
      const path = webUtils.getPathForFile(file);
      return path ? [path] : [];
    } catch {
      return [];
    }
  });
  if (paths.length > 0) {
    return [...new Set(paths)];
  }

  return [...new Set(filePathsFromUriList(dataTransfer.getData("text/uri-list")))];
}

function filePathsFromUriList(uriList: string): string[] {
  return uriList
    .split(/\r?\n/gu)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .flatMap((line) => {
      try {
        const url = new URL(line);
        return url.protocol === "file:" ? [fileURLToPath(url)] : [];
      } catch {
        return [];
      }
    });
}
