import { PanelBottomClose, PanelBottomOpen, Settings } from "lucide-react";
import type { AppTheme, FileOpenMode, ProjectRecord, SessionRecord } from "../../../shared/types";

type WorkspaceToolbarProps = {
  activeProject: ProjectRecord | null;
  activeSession: SessionRecord | null;
  appTheme: AppTheme;
  fileOpenMode: FileOpenMode;
  projectShellAvailable: boolean;
  projectShellProjectId: string | null;
  projectShellVisible: boolean;
  onFileOpenModeChange: (mode: FileOpenMode) => void;
  onThemeChange: (theme: AppTheme) => void;
  onOpenProjectShell: () => void;
  onOpenSettings: () => void;
};

/** 汇总文件 Link 打开方式、当前项目终端入口、设置入口和会话状态。 */
export function WorkspaceToolbar({
  activeProject,
  activeSession,
  appTheme,
  fileOpenMode,
  projectShellAvailable,
  projectShellProjectId,
  projectShellVisible,
  onFileOpenModeChange,
  onThemeChange,
  onOpenProjectShell,
  onOpenSettings
}: WorkspaceToolbarProps): JSX.Element {
  const projectShellDisabled = !activeProject || activeProject.missing || !projectShellAvailable;
  const activeProjectShellVisible = Boolean(
    activeProject && projectShellProjectId === activeProject.id && projectShellVisible
  );
  const ProjectShellIcon = activeProjectShellVisible ? PanelBottomClose : PanelBottomOpen;

  return (
    <div className="workspace-toolbar">
      <label className="toolbar-select file-open-mode" title="终端文件链接的默认打开方式">
        <span>打开</span>
        <select
          aria-label="终端文件链接打开方式"
          value={fileOpenMode}
          onChange={(event) => onFileOpenModeChange(event.target.value as FileOpenMode)}
        >
          <option value="idea">IDEA</option>
          <option value="system">系统</option>
        </select>
      </label>
      <label className="toolbar-select theme-mode" title="应用与终端配色主题">
        <span>主题</span>
        <select
          aria-label="应用配色主题"
          value={appTheme}
          onChange={(event) => onThemeChange(event.target.value as AppTheme)}
        >
          <option value="dark">深色</option>
          <option value="light">暖色</option>
        </select>
      </label>
      <button
        className={`icon-button${activeProjectShellVisible ? " active" : ""}`}
        title={projectShellTitle(activeProject, projectShellAvailable, projectShellProjectId, projectShellVisible)}
        disabled={projectShellDisabled}
        onClick={onOpenProjectShell}
      >
        <ProjectShellIcon size={17} />
      </button>
      <button className="icon-button" title="设置" onClick={onOpenSettings}>
        <Settings size={17} />
      </button>
      {activeSession ? <StatusBadge status={activeSession.status} /> : null}
    </div>
  );
}

function projectShellTitle(
  activeProject: ProjectRecord | null,
  projectShellAvailable: boolean,
  projectShellProjectId: string | null,
  projectShellVisible: boolean
): string {
  if (!projectShellAvailable) {
    return "项目终端能力需要重启应用后生效";
  }

  if (!activeProject) {
    return "先选择一个会话";
  }

  if (activeProject.missing) {
    return "当前会话目录不存在";
  }

  if (projectShellProjectId === activeProject.id) {
    return projectShellVisible ? "隐藏项目终端" : "显示项目终端";
  }

  return "打开当前会话目录终端";
}

function StatusBadge({ status }: { status: SessionRecord["status"] }): JSX.Element {
  return <span className={`status-badge ${status}`}>{statusLabel(status)}</span>;
}

function statusLabel(status: SessionRecord["status"]): string {
  switch (status) {
    case "creating":
      return "创建中";
    case "running":
      return "运行中";
    case "stopping":
      return "结束中";
    case "exited":
      return "已退出";
    case "failed":
      return "失败";
  }
}
