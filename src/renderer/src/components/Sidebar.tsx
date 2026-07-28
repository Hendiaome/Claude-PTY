import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Folder,
  FolderPlus,
  History,
  PanelLeftClose,
  PanelLeftOpen,
  RotateCcw,
  Square,
  SquareTerminal,
  Terminal as TerminalIcon,
  Trash2,
  Workflow
} from "lucide-react";
import type { MouseEvent } from "react";
import type {
  EnvironmentCheckResult,
  ProjectRecord,
  SessionActivityState,
  SessionActivityStatus,
  SessionMode,
  SessionRecord
} from "../../../shared/types";
import { Tooltip } from "./Tooltip";

export type SidebarProject = ProjectRecord & {
  sessions: SessionRecord[];
};

type SidebarProps = {
  collapsed: boolean;
  environment: EnvironmentCheckResult | null;
  projects: SidebarProject[];
  expandedProjects: Set<string>;
  activeSessionId: string | null;
  activeShellProjectId: string | null;
  activityStates: Record<string, SessionActivityState>;
  busySessionId: string | null;
  onAddProject: () => void;
  onToggleCollapsed: () => void;
  onToggleProject: (projectId: string) => void;
  onCreateSession: (projectId: string, mode: SessionMode) => void;
  onImportSession: (project: ProjectRecord) => void;
  onOpenSession: (session: SessionRecord) => void;
  onRemoveProject: (project: ProjectRecord) => void;
  onStopSession: (sessionId: string) => void;
  onOpenSessionMenu: (event: MouseEvent, session: SessionRecord) => void;
};

/** 展示项目与会话树；收起时仅保留最小控制栏，不卸载当前工作区。 */
export function Sidebar({
  collapsed,
  environment,
  projects,
  expandedProjects,
  activeSessionId,
  activeShellProjectId,
  activityStates,
  busySessionId,
  onAddProject,
  onToggleCollapsed,
  onToggleProject,
  onCreateSession,
  onImportSession,
  onOpenSession,
  onRemoveProject,
  onStopSession,
  onOpenSessionMenu
}: SidebarProps): JSX.Element {
  const SidebarToggleIcon = collapsed ? PanelLeftOpen : PanelLeftClose;

  return (
    <aside className={`sidebar${collapsed ? " collapsed" : ""}`}>
      <header className="sidebar-header">
        {collapsed ? null : (
          <div>
            <h1>Claude PTY</h1>
          </div>
        )}
        <div className="sidebar-header-actions">
          <button
            className="icon-button"
            aria-label={collapsed ? "展开会话面板" : "收起会话面板"}
            title={collapsed ? "展开会话面板" : "收起会话面板"}
            onClick={onToggleCollapsed}
          >
            <SidebarToggleIcon size={18} />
          </button>
          {collapsed ? null : (
            <button className="icon-button" title="添加文件夹" onClick={onAddProject}>
              <FolderPlus size={18} />
            </button>
          )}
        </div>
      </header>

      {collapsed ? null : <EnvironmentBanner environment={environment} />}

      {collapsed ? null : <section className="project-list">
        {projects.length === 0 ? (
          <div className="empty-state">
            <FolderPlus size={22} />
            <span>添加一个工作目录开始</span>
          </div>
        ) : (
          projects.map((project) => (
            <ProjectGroup
              activeSessionId={activeSessionId}
              activeShellProjectId={activeShellProjectId}
              activityStates={activityStates}
              busySessionId={busySessionId}
              environment={environment}
              expanded={expandedProjects.has(project.id)}
              key={project.id}
              project={project}
              onCreateSession={onCreateSession}
              onImportSession={onImportSession}
              onOpenSession={onOpenSession}
              onOpenSessionMenu={onOpenSessionMenu}
              onRemoveProject={onRemoveProject}
              onStopSession={onStopSession}
              onToggleProject={onToggleProject}
            />
          ))
        )}
      </section>}
    </aside>
  );
}

function ProjectGroup({
  activeSessionId,
  activeShellProjectId,
  activityStates,
  busySessionId,
  environment,
  expanded,
  project,
  onCreateSession,
  onImportSession,
  onOpenSession,
  onOpenSessionMenu,
  onRemoveProject,
  onStopSession,
  onToggleProject
}: {
  activeSessionId: string | null;
  activeShellProjectId: string | null;
  activityStates: Record<string, SessionActivityState>;
  busySessionId: string | null;
  environment: EnvironmentCheckResult | null;
  expanded: boolean;
  project: SidebarProject;
  onCreateSession: (projectId: string, mode: SessionMode) => void;
  onImportSession: (project: ProjectRecord) => void;
  onOpenSession: (session: SessionRecord) => void;
  onOpenSessionMenu: (event: MouseEvent, session: SessionRecord) => void;
  onRemoveProject: (project: ProjectRecord) => void;
  onStopSession: (sessionId: string) => void;
  onToggleProject: (projectId: string) => void;
}): JSX.Element {
  // 项目级动作同时受环境、目录、会话状态和底部终端状态约束，提示文字复用同一判断结果。
  const projectActionBusy = busySessionId === project.id;
  const hasActiveSession = project.sessions.some(
    (session) => session.status === "creating" || session.status === "running" || session.status === "stopping"
  );
  const hasTransitioningSession = project.sessions.some(
    (session) => session.status === "creating" || session.status === "stopping"
  );
  const projectShellRunning = activeShellProjectId === project.id;
  const blockedSessionCount = project.sessions.filter(
    (session) => session.status === "running" && activityStates[session.id]?.state === "blocked"
  ).length;
  const claudeActionUnavailableReason = project.missing
    ? "项目路径不存在"
    : !environment
      ? "Claude CLI 环境检测中"
      : !environment.ok
        ? "Claude CLI 不可用"
        : projectActionBusy
          ? "文件夹操作进行中"
          : null;
  const createDisabled = claudeActionUnavailableReason !== null;
  const createTitle = claudeActionUnavailableReason ?? "新建原生终端会话";
  const structuredCreateTitle = claudeActionUnavailableReason ?? "新建结构化会话（尝鲜，不保证稳定）";
  const importDisabled = createDisabled || hasTransitioningSession;
  const importTitle =
    claudeActionUnavailableReason ??
    (hasTransitioningSession ? "会话正在启动或结束，请稍后再导入" : "导入并恢复历史会话");
  const removeDisabled = projectActionBusy || hasActiveSession || projectShellRunning;
  const removeTitle = projectShellRunning
    ? "请先关闭该文件夹的项目终端"
    : hasActiveSession
      ? "请先结束该文件夹内运行中的 Claude 会话"
      : projectActionBusy
        ? "文件夹操作进行中"
        : "移除文件夹记录（不删除磁盘目录）";

  return (
    <div className="project-group">
      <div className="project-row">
        <button className="project-toggle" title={expanded ? "收起" : "展开"} onClick={() => onToggleProject(project.id)}>
          {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </button>
        <button className="project-main" title={project.path} onClick={() => onToggleProject(project.id)}>
          <Folder size={16} />
          <span className="project-name">{project.name}</span>
          {!expanded && blockedSessionCount > 0 ? (
            <span className="project-blocked-badge" title={`${blockedSessionCount} 个会话等待处理`}>
              {blockedSessionCount}
            </span>
          ) : null}
          {project.missing ? <AlertTriangle className="warning-icon" size={15} /> : null}
        </button>
        <div className="project-actions">
          {/* 两类会话保留一致尺寸，通过图标与语义色突出更易读的结构化模式。 */}
          <Tooltip content={createTitle} focusableWhenDisabled={createDisabled}>
            <button
              className="icon-button small project-action-button project-action-terminal"
              aria-label="新建原生终端会话"
              disabled={createDisabled}
              onClick={() => onCreateSession(project.id, "terminal")}
            >
              <SquareTerminal size={16} strokeWidth={1.9} />
            </button>
          </Tooltip>
          <Tooltip content={structuredCreateTitle} focusableWhenDisabled={createDisabled}>
            <button
              className="icon-button small project-action-button project-action-structured"
              aria-label="新建结构化会话（尝鲜）"
              disabled={createDisabled}
              onClick={() => onCreateSession(project.id, "structured")}
            >
              <Workflow size={16} strokeWidth={2} />
            </button>
          </Tooltip>
          <Tooltip content={importTitle} focusableWhenDisabled={importDisabled}>
            <button
              className="icon-button small"
              aria-label="导入并恢复历史会话"
              disabled={importDisabled}
              onClick={() => onImportSession(project)}
            >
              <History size={15} />
            </button>
          </Tooltip>
          <Tooltip content={removeTitle} focusableWhenDisabled={removeDisabled}>
            <button
              className="icon-button small danger"
              aria-label="移除文件夹记录"
              disabled={removeDisabled}
              onClick={() => onRemoveProject(project)}
            >
              <Trash2 size={15} />
            </button>
          </Tooltip>
        </div>
      </div>

      {expanded ? (
        <SessionList
          activeSessionId={activeSessionId}
          activityStates={activityStates}
          sessions={project.sessions}
          onOpenSession={onOpenSession}
          onOpenSessionMenu={onOpenSessionMenu}
          onStopSession={onStopSession}
        />
      ) : null}
    </div>
  );
}

function SessionList({
  activeSessionId,
  activityStates,
  sessions,
  onOpenSession,
  onOpenSessionMenu,
  onStopSession
}: {
  activeSessionId: string | null;
  activityStates: Record<string, SessionActivityState>;
  sessions: SessionRecord[];
  onOpenSession: (session: SessionRecord) => void;
  onOpenSessionMenu: (event: MouseEvent, session: SessionRecord) => void;
  onStopSession: (sessionId: string) => void;
}): JSX.Element {
  return (
    <div className="session-list">
      {sessions.length === 0 ? (
        <div className="session-empty">暂无会话</div>
      ) : (
        sessions.map((session) => (
          <SessionRow
            active={session.id === activeSessionId}
            activityState={activityStates[session.id]}
            key={session.id}
            session={session}
            onOpenSession={onOpenSession}
            onOpenSessionMenu={onOpenSessionMenu}
            onStopSession={onStopSession}
          />
        ))
      )}
    </div>
  );
}

function SessionRow({
  active,
  activityState,
  session,
  onOpenSession,
  onOpenSessionMenu,
  onStopSession
}: {
  active: boolean;
  activityState?: SessionActivityState;
  session: SessionRecord;
  onOpenSession: (session: SessionRecord) => void;
  onOpenSessionMenu: (event: MouseEvent, session: SessionRecord) => void;
  onStopSession: (sessionId: string) => void;
}): JSX.Element {
  const stateView = sessionStateView(session, activityState);
  // 整行支持鼠标和键盘打开，内部停止按钮必须阻止冒泡，避免同时触发恢复。
  return (
    <div
      className={`session-row ${active ? "active" : ""} ${stateView.status}`}
      title={`${session.claudeSessionId} · ${session.mode === "structured" ? "结构化" : "原生终端"} · ${stateView.label}`}
      role="button"
      tabIndex={0}
      onClick={() => onOpenSession(session)}
      onContextMenu={(event) => onOpenSessionMenu(event, session)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpenSession(session);
        }
      }}
    >
      <StatusDot status={stateView.status} />
      <span className="session-title">{session.title}</span>
      <span className={`session-state ${stateView.status}`}>{stateView.label}</span>
      <span className="session-action">
        {session.status === "running" ? (
          <button
            className="icon-button tiny"
            title="结束会话"
            onClick={(event) => {
              event.stopPropagation();
              onStopSession(session.id);
            }}
          >
            <Square size={12} />
          </button>
        ) : session.status === "stopping" ? (
          <Square size={13} />
        ) : (
          <RotateCcw size={13} />
        )}
      </span>
    </div>
  );
}

function EnvironmentBanner({ environment }: { environment: EnvironmentCheckResult | null }): JSX.Element {
  if (!environment) {
    return (
      <div className="environment-banner muted">
        <TerminalIcon size={15} />
        <span>环境检测中</span>
      </div>
    );
  }

  if (!environment.ok) {
    return (
      <div className="environment-banner error" title={environment.message}>
        <AlertTriangle size={15} />
        <span>Claude CLI 不可用</span>
      </div>
    );
  }

  return (
    <div className="environment-banner ok" title={environment.claudePath}>
      <CheckCircle2 size={15} />
      <span>Claude CLI 已就绪</span>
    </div>
  );
}

function StatusDot({ status }: { status: SessionRecord["status"] | SessionActivityStatus }): JSX.Element {
  return <span className={`status-dot ${status}`} />;
}

function sessionStateView(
  session: SessionRecord,
  activityState?: SessionActivityState
): { status: SessionRecord["status"] | SessionActivityStatus; label: string } {
  if (session.status === "running") {
    const activity = activityState?.state ?? "idle";
    const labels: Record<SessionActivityStatus, string> = {
      idle: "已完成",
      working: "工作中",
      blocked: "等待处理"
    };
    const label = session.mode === "structured"
      ? `结构化 · ${labels[activity]}`
      : labels[activity];
    return { status: activity, label };
  }

  const labels: Record<SessionRecord["status"], string> = {
    creating: "启动中",
    running: "运行中",
    stopping: "正在结束",
    exited: "已退出",
    failed: "启动失败"
  };
  const label = session.mode === "structured"
    ? `结构化 · ${labels[session.status]}`
    : labels[session.status];
  return { status: session.status, label };
}
