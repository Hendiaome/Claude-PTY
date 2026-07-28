import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent } from "react";
import type {
  EnvironmentCheckResult,
  ProjectRecord,
  SessionActivityState,
  SessionMode,
  SessionRecord
} from "../../../shared/types";
import type { SidebarProject } from "../components/Sidebar";
import { logTerminalInteraction } from "./terminalInteractions";
import { errorMessage } from "./terminalUtils";

const LAST_SELECTED_SESSION_KEY = "claude-pty:last-selected-session";

export type ContextMenuState = {
  sessionId: string;
  x: number;
  y: number;
} | null;

export type RenameDialogState = {
  sessionId: string;
  title: string;
} | null;

export type ImportDialogState = {
  projectId: string;
  projectName: string;
} | null;

type UseSessionWorkspaceResult = {
  activeProject: ProjectRecord | null;
  activeSession: SessionRecord | null;
  activeSessionId: string | null;
  busySessionId: string | null;
  contextMenu: ContextMenuState;
  environment: EnvironmentCheckResult | null;
  expandedProjects: Set<string>;
  importDialog: ImportDialogState;
  renameDialog: RenameDialogState;
  sessionActivityStates: Record<string, SessionActivityState>;
  sessions: SessionRecord[];
  sidebarProjects: SidebarProject[];
  addProject: () => Promise<void>;
  createSession: (projectId: string, mode?: SessionMode) => Promise<void>;
  importAndResumeSession: (projectId: string, claudeSessionId: string) => Promise<void>;
  openImportDialog: (project: ProjectRecord) => void;
  openRenameDialog: (session: SessionRecord) => void;
  openSession: (session: SessionRecord) => Promise<void>;
  openSessionMenu: (event: MouseEvent, session: SessionRecord) => void;
  removeProject: (project: ProjectRecord) => Promise<void>;
  removeSession: (sessionId: string) => Promise<void>;
  renameSession: (sessionId: string, title: string) => Promise<void>;
  setImportDialog: (state: ImportDialogState) => void;
  setRenameDialog: (state: RenameDialogState) => void;
  stopSession: (sessionId: string) => Promise<void>;
  toggleProject: (projectId: string) => void;
  upsertUpdatedSession: (session: SessionRecord) => void;
};

/** 汇总项目、会话和弹窗状态，并把主进程事件归并成侧栏可直接消费的数据。 */
export function useSessionWorkspace(onError: (message: string | null) => void): UseSessionWorkspaceResult {
  const [environment, setEnvironment] = useState<EnvironmentCheckResult | null>(null);
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [sessionActivityStates, setSessionActivityStates] = useState<Record<string, SessionActivityState>>({});
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set());
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const activeSessionIdRef = useRef<string | null>(null);
  const selectionInitializedRef = useRef(false);
  const [busySessionId, setBusySessionId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(null);
  const [importDialog, setImportDialog] = useState<ImportDialogState>(null);
  const [renameDialog, setRenameDialog] = useState<RenameDialogState>(null);

  // 只持久化内部 Session ID；renderer 重载后仍可恢复用户最后选择的会话。
  const selectSession = useCallback((sessionId: string | null): void => {
    activeSessionIdRef.current = sessionId;
    setActiveSessionId(sessionId);
    persistLastSelectedSession(sessionId);
  }, []);

  const reload = useCallback(async () => {
    const [environmentResult, projectList, sessionList, activityStateList, pendingSessionId] = await Promise.all([
      window.claudeManager.environmentCheck(),
      window.claudeManager.projectsList(),
      window.claudeManager.sessionsList(),
      loadSessionActivityStates(),
      consumePendingFloatingSession()
    ]);

    setEnvironment(environmentResult);
    setProjects(projectList);
    setSessions(sessionList);
    setSessionActivityStates(Object.fromEntries(activityStateList.map((state) => [state.sessionId, state])));
    if (!selectionInitializedRef.current) {
      selectionInitializedRef.current = true;
      const pendingSession = pendingSessionId
        ? sessionList.find((session) => session.id === pendingSessionId)
        : undefined;
      const restored = pendingSession
        ? { session: pendingSession, source: "saved" as const }
        : resolveInitialSession(sessionList);
      selectSession(restored?.session.id ?? null);
      if (restored) {
        logTerminalInteraction({
          event: "session-selection-restored",
          identifier: restored.session.id,
          source: restored.source
        });
      }
    }
    setExpandedProjects((current) => {
      if (current.size > 0) {
        return current;
      }

      return new Set(projectList.map((project) => project.id));
    });
  }, [selectSession]);

  useEffect(() => {
    reload().catch((error: unknown) => onError(errorMessage(error)));
  }, [onError, reload]);

  useEffect(() => {
    return subscribeSessionActivityState((state) => {
      setSessionActivityStates((current) => ({
        ...current,
        [state.sessionId]: state
      }));
    });
  }, []);

  useEffect(() => {
    const manager = window.claudeManager as Partial<{
      onSessionSelectRequested: (listener: (event: { sessionId: string }) => void) => () => void;
    }>;
    if (typeof manager.onSessionSelectRequested !== "function") {
      return undefined;
    }
    return manager.onSessionSelectRequested(({ sessionId }) => {
      void consumePendingFloatingSession();
      selectSession(sessionId);
      const session = sessions.find((item) => item.id === sessionId);
      if (session) {
        setExpandedProjects((current) => new Set([...current, session.projectId]));
      }
    });
  }, [selectSession, sessions]);

  useEffect(() => {
    if (!contextMenu) {
      return undefined;
    }

    const close = (): void => setContextMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("keydown", close);
    window.addEventListener("blur", close);

    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", close);
      window.removeEventListener("blur", close);
    };
  }, [contextMenu]);

  const sidebarProjects = useMemo<SidebarProject[]>(() => {
    return projects.map((project) => ({
      ...project,
      sessions: sessions.filter((session) => session.projectId === project.id)
    }));
  }, [projects, sessions]);

  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeSessionId) ?? null,
    [activeSessionId, sessions]
  );

  const activeProject = useMemo(
    () => projects.find((project) => project.id === activeSession?.projectId) ?? null,
    [activeSession?.projectId, projects]
  );

  const upsertUpdatedSession = useCallback((updatedSession: SessionRecord) => {
    setSessions((current) => upsertSession(current, updatedSession));
  }, []);

  const addProject = async (): Promise<void> => {
    onError(null);
    const project = await window.claudeManager.projectsChooseAndAdd();
    if (!project) {
      return;
    }

    setProjects((current) => upsertProject(current, project));
    setExpandedProjects((current) => new Set([...current, project.id]));
  };

  const createSession = async (projectId: string, mode: SessionMode = "terminal"): Promise<void> => {
    onError(null);
    setBusySessionId(projectId);
    try {
      const session = await window.claudeManager.sessionsCreate(projectId, mode);
      setSessions((current) => upsertSession(current, session));
      if (session.status === "failed") {
        onError(session.error ?? "Claude 会话启动失败。");
      } else {
        selectSession(session.id);
      }
      setExpandedProjects((current) => new Set([...current, projectId]));
    } catch (error: unknown) {
      onError(errorMessage(error));
    } finally {
      setBusySessionId(null);
    }
  };

  const importAndResumeSession = async (projectId: string, claudeSessionId: string): Promise<void> => {
    // 导入接口会在主进程确认 PTY 启动成功后返回，因此成功结果可以直接加入当前列表。
    onError(null);
    setBusySessionId(projectId);
    try {
      const manager = window.claudeManager as Partial<Record<"sessionsImportAndResume", unknown>>;
      if (typeof manager.sessionsImportAndResume !== "function") {
        throw new Error("导入历史会话能力需要重启应用后生效。");
      }

      const session = await window.claudeManager.sessionsImportAndResume(projectId, claudeSessionId);
      if (session.status !== "running") {
        throw new Error(session.error ?? "Claude 历史会话恢复失败。");
      }

      setSessions((current) => upsertSession(current, session));
      selectSession(session.id);
      setExpandedProjects((current) => new Set([...current, projectId]));
      setImportDialog(null);
    } catch (error: unknown) {
      onError(errorMessage(error));
    } finally {
      setBusySessionId(null);
    }
  };

  const openSession = async (session: SessionRecord): Promise<void> => {
    onError(null);
    if (session.status === "running") {
      selectSession(session.id);
      return;
    }

    setBusySessionId(session.id);
    try {
      const resumed = await window.claudeManager.sessionsResume(session.id);
      setSessions((current) => upsertSession(current, resumed));
      if (resumed.status === "failed") {
        onError(resumed.error ?? "Claude 会话恢复失败。");
      } else {
        selectSession(resumed.id);
      }
    } catch (error: unknown) {
      onError(errorMessage(error));
    } finally {
      setBusySessionId(null);
    }
  };

  const stopSession = async (sessionId: string): Promise<void> => {
    onError(null);
    await window.claudeManager.sessionsStop(sessionId);
  };

  const removeSession = async (sessionId: string): Promise<void> => {
    onError(null);
    setContextMenu(null);
    try {
      await window.claudeManager.sessionsRemove(sessionId);
      setSessions((current) => current.filter((session) => session.id !== sessionId));
      setSessionActivityStates((current) => omitActivityStates(current, new Set([sessionId])));
      if (activeSessionIdRef.current === sessionId) {
        selectSession(null);
      }
    } catch (error: unknown) {
      onError(errorMessage(error));
    }
  };

  const removeProject = async (project: ProjectRecord): Promise<void> => {
    // 删除仅针对管理记录；磁盘目录和 Claude 原始历史由用户自行管理。
    const confirmed = window.confirm(
      `确认从会话管理器中移除文件夹「${project.name}」吗？\n\n只删除管理记录，不会删除磁盘目录或 Claude 历史会话。`
    );
    if (!confirmed) {
      return;
    }

    onError(null);
    setBusySessionId(project.id);
    const projectSessionIds = new Set(
      sessions.filter((session) => session.projectId === project.id).map((session) => session.id)
    );

    try {
      await window.claudeManager.projectsRemove(project.id);
      setProjects((current) => current.filter((item) => item.id !== project.id));
      setSessions((current) => current.filter((session) => session.projectId !== project.id));
      setSessionActivityStates((current) => omitActivityStates(current, projectSessionIds));
      setExpandedProjects((current) => {
        const next = new Set(current);
        next.delete(project.id);
        return next;
      });
      const selectedSessionId = activeSessionIdRef.current;
      if (selectedSessionId && projectSessionIds.has(selectedSessionId)) {
        selectSession(null);
      }
      setContextMenu((current) => (current && projectSessionIds.has(current.sessionId) ? null : current));
      setRenameDialog((current) => (current && projectSessionIds.has(current.sessionId) ? null : current));
      setImportDialog((current) => (current?.projectId === project.id ? null : current));
    } catch (error: unknown) {
      onError(errorMessage(error));
    } finally {
      setBusySessionId(null);
    }
  };

  const renameSession = async (sessionId: string, title: string): Promise<void> => {
    onError(null);
    try {
      const updated = await window.claudeManager.sessionsRename(sessionId, title);
      setSessions((current) => upsertSession(current, updated));
      setRenameDialog(null);
    } catch (error: unknown) {
      onError(errorMessage(error));
    }
  };

  const openRenameDialog = (session: SessionRecord): void => {
    setContextMenu(null);
    setRenameDialog({
      sessionId: session.id,
      title: session.title
    });
  };

  const openImportDialog = (project: ProjectRecord): void => {
    onError(null);
    setImportDialog({
      projectId: project.id,
      projectName: project.name
    });
  };

  const openSessionMenu = (event: MouseEvent, session: SessionRecord): void => {
    event.preventDefault();
    setContextMenu({
      sessionId: session.id,
      x: event.clientX,
      y: event.clientY
    });
  };

  const toggleProject = (projectId: string): void => {
    setExpandedProjects((current) => {
      const next = new Set(current);
      if (next.has(projectId)) {
        next.delete(projectId);
      } else {
        next.add(projectId);
      }
      return next;
    });
  };

  return {
    activeProject,
    activeSession,
    activeSessionId,
    busySessionId,
    contextMenu,
    environment,
    expandedProjects,
    importDialog,
    renameDialog,
    sessionActivityStates,
    sessions,
    sidebarProjects,
    addProject,
    createSession,
    importAndResumeSession,
    openImportDialog,
    openRenameDialog,
    openSession,
    openSessionMenu,
    removeProject,
    removeSession,
    renameSession,
    setImportDialog,
    setRenameDialog,
    stopSession,
    toggleProject,
    upsertUpdatedSession
  };
}

function loadSessionActivityStates(): Promise<SessionActivityState[]> {
  const manager = window.claudeManager as Partial<{
    sessionsActivityStates: () => Promise<SessionActivityState[]>;
  }>;
  return typeof manager.sessionsActivityStates === "function"
    ? manager.sessionsActivityStates()
    : Promise.resolve([]);
}

function consumePendingFloatingSession(): Promise<string | undefined> {
  const manager = window.claudeManager as Partial<{
    floatingConsumePendingSession: () => Promise<string | undefined>;
  }>;
  return typeof manager.floatingConsumePendingSession === "function"
    ? manager.floatingConsumePendingSession()
    : Promise.resolve(undefined);
}

function subscribeSessionActivityState(callback: (state: SessionActivityState) => void): () => void {
  const manager = window.claudeManager as Partial<{
    onSessionActivityState: (listener: (state: SessionActivityState) => void) => () => void;
  }>;
  return typeof manager.onSessionActivityState === "function"
    ? manager.onSessionActivityState(callback)
    : () => undefined;
}

function omitActivityStates(
  states: Record<string, SessionActivityState>,
  sessionIds: Set<string>
): Record<string, SessionActivityState> {
  return Object.fromEntries(Object.entries(states).filter(([sessionId]) => !sessionIds.has(sessionId)));
}

function upsertProject(projects: ProjectRecord[], project: ProjectRecord): ProjectRecord[] {
  const exists = projects.some((item) => item.id === project.id);
  if (!exists) {
    return [...projects, project];
  }

  return projects.map((item) => (item.id === project.id ? project : item));
}

function upsertSession(sessions: SessionRecord[], session: SessionRecord): SessionRecord[] {
  const exists = sessions.some((item) => item.id === session.id);
  const next = exists ? sessions.map((item) => (item.id === session.id ? session : item)) : [session, ...sessions];
  return next.sort((a, b) => (b.lastActiveAt ?? b.createdAt).localeCompare(a.lastActiveAt ?? a.createdAt));
}

function resolveInitialSession(
  sessions: SessionRecord[]
): { session: SessionRecord; source: "saved" | "running-fallback" } | undefined {
  const savedSessionId = readLastSelectedSession();
  const savedSession = savedSessionId
    ? sessions.find((session) => session.id === savedSessionId)
    : undefined;
  if (savedSession) {
    return { session: savedSession, source: "saved" };
  }

  const runningSession = sessions.find((session) => session.status === "running");
  return runningSession ? { session: runningSession, source: "running-fallback" } : undefined;
}

function readLastSelectedSession(): string | null {
  try {
    return window.localStorage.getItem(LAST_SELECTED_SESSION_KEY);
  } catch {
    return null;
  }
}

function persistLastSelectedSession(sessionId: string | null): void {
  try {
    if (sessionId) {
      window.localStorage.setItem(LAST_SELECTED_SESSION_KEY, sessionId);
    } else {
      window.localStorage.removeItem(LAST_SELECTED_SESSION_KEY);
    }
  } catch {
    // 本地存储不可用时仅失去跨重载恢复能力，不影响会话本身。
  }
}
