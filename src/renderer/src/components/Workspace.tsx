import { AlertTriangle, ChevronDown, ChevronUp, Search, Terminal as TerminalIcon, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import type {
  AppTheme,
  FileOpenMode,
  ProjectRecord,
  SessionRecord,
  StructuredPermissionDecision,
  StructuredQuestionAnswers,
  StructuredSessionSnapshot,
  UpdateInfo
} from "../../../shared/types";
import type { TerminalSearchDirection } from "../hooks/useClaudeTerminal";
import { UpdatePrompt } from "./UpdatePrompt";
import { WorkspaceToolbar } from "./WorkspaceToolbar";
import { StructuredWorkspace } from "./StructuredWorkspace";

export type ShellTerminalState = {
  projectId: string;
  cwd: string;
} | null;

const SHELL_PANEL_MIN_HEIGHT = 140;
const SHELL_PANEL_TOP_RESERVED_HEIGHT = 180;
const SHELL_PANEL_MAX_HEIGHT_RATIO = 0.65;

type WorkspaceProps = {
  activeError: string | null;
  activeProject: ProjectRecord | null;
  activeSession: SessionRecord | null;
  activeSessionId: string | null;
  appTheme: AppTheme;
  availableUpdate: UpdateInfo | null;
  fileOpenMode: FileOpenMode;
  projectShellAvailable: boolean;
  shellTerminal: ShellTerminalState;
  shellTerminalVisible: boolean;
  shellPanelHeight: number;
  shellHostRef: RefObject<HTMLDivElement | null>;
  terminalHostRef: RefObject<HTMLDivElement | null>;
  structuredSnapshot: StructuredSessionSnapshot | null;
  onChangeShellPanelHeight: (height: number) => void;
  onDismissUpdate: () => void;
  onFileOpenModeChange: (mode: FileOpenMode) => void;
  onThemeChange: (theme: AppTheme) => void;
  onOpenProjectShell: () => void;
  onOpenSettings: () => void;
  onOpenUpdateDownload: () => void;
  onCloseProjectShell: () => void;
  onSearchTerminal: (query: string, direction: TerminalSearchDirection) => boolean;
  onCloseTerminalSearch: () => void;
  onStructuredSend: (text: string) => Promise<void>;
  onStructuredPermissionRespond: (
    requestId: string,
    decision: StructuredPermissionDecision
  ) => Promise<void>;
  onStructuredQuestionRespond: (
    requestId: string,
    answers: StructuredQuestionAnswers | null
  ) => Promise<void>;
  onStructuredInterrupt: () => Promise<void>;
  onStructuredError: (message: string) => void;
};

/** 主工作区同时承载 Claude 会话、更新/错误提示和可选的底部项目终端。 */
export function Workspace({
  activeError,
  activeProject,
  activeSession,
  activeSessionId,
  appTheme,
  availableUpdate,
  fileOpenMode,
  projectShellAvailable,
  shellTerminal,
  shellTerminalVisible,
  shellPanelHeight,
  shellHostRef,
  terminalHostRef,
  structuredSnapshot,
  onChangeShellPanelHeight,
  onDismissUpdate,
  onFileOpenModeChange,
  onThemeChange,
  onOpenProjectShell,
  onOpenSettings,
  onOpenUpdateDownload,
  onCloseProjectShell,
  onSearchTerminal,
  onCloseTerminalSearch,
  onStructuredSend,
  onStructuredPermissionRespond,
  onStructuredQuestionRespond,
  onStructuredInterrupt,
  onStructuredError
}: WorkspaceProps): JSX.Element {
  const workspaceRef = useRef<HTMLElement | null>(null);
  const terminalSearchInputRef = useRef<HTMLInputElement | null>(null);
  const [terminalSearchOpen, setTerminalSearchOpen] = useState(false);
  const [terminalSearchQuery, setTerminalSearchQuery] = useState("");
  const [terminalSearchFound, setTerminalSearchFound] = useState<boolean | null>(null);
  const visibleShellTerminal = shellTerminalVisible ? shellTerminal : null;
  const shellPanelShown = Boolean(visibleShellTerminal);
  const structuredMode = activeSession?.mode === "structured";

  useEffect(() => {
    // 搜索结果属于当前会话，切换会话后关闭搜索并清理旧高亮。
    setTerminalSearchOpen(false);
    setTerminalSearchQuery("");
    setTerminalSearchFound(null);
    if (!structuredMode) {
      onCloseTerminalSearch();
    }
  }, [activeSessionId, onCloseTerminalSearch, structuredMode]);

  const openTerminalSearch = (): void => {
    setTerminalSearchOpen(true);
    window.requestAnimationFrame(() => {
      terminalSearchInputRef.current?.focus();
      terminalSearchInputRef.current?.select();
    });
  };
  const closeTerminalSearch = (): void => {
    setTerminalSearchOpen(false);
    setTerminalSearchFound(null);
    onCloseTerminalSearch();
  };
  const runTerminalSearch = (direction: TerminalSearchDirection): void => {
    if (!terminalSearchQuery) {
      setTerminalSearchFound(null);
      return;
    }
    setTerminalSearchFound(onSearchTerminal(terminalSearchQuery, direction));
  };

  const startShellPanelResize = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      // 高度受可视区域和顶部保留空间双重限制，避免底部终端覆盖主会话。
      if (event.button !== 0) {
        return;
      }

      event.preventDefault();
      const startY = event.clientY;
      const startHeight = shellPanelHeight;
      const maxHeight = getShellPanelMaxHeight(workspaceRef.current);
      const previousCursor = document.body.style.cursor;
      const previousUserSelect = document.body.style.userSelect;
      document.body.style.cursor = "row-resize";
      document.body.style.userSelect = "none";

      const onMouseMove = (moveEvent: MouseEvent): void => {
        const nextHeight = clamp(startHeight + startY - moveEvent.clientY, SHELL_PANEL_MIN_HEIGHT, maxHeight);
        onChangeShellPanelHeight(nextHeight);
      };
      const onMouseUp = (): void => {
        document.body.style.cursor = previousCursor;
        document.body.style.userSelect = previousUserSelect;
        window.removeEventListener("mousemove", onMouseMove);
        window.removeEventListener("mouseup", onMouseUp);
      };

      window.addEventListener("mousemove", onMouseMove);
      window.addEventListener("mouseup", onMouseUp);
    },
    [onChangeShellPanelHeight, shellPanelHeight]
  );

  return (
    <section className="workspace" ref={workspaceRef}>
      <header className="workspace-header">
        <div className="workspace-title">
          <TerminalIcon size={18} />
          <div>
            <h2>{activeSession ? activeSession.title : "未选择会话"}</h2>
            <p>{activeProject ? activeProject.path : "从左侧项目创建或恢复 Claude 会话"}</p>
          </div>
        </div>
        <WorkspaceToolbar
          activeProject={activeProject}
          activeSession={activeSession}
          appTheme={appTheme}
          fileOpenMode={fileOpenMode}
          projectShellAvailable={projectShellAvailable}
          projectShellProjectId={shellTerminal?.projectId ?? null}
          projectShellVisible={shellPanelShown}
          onFileOpenModeChange={onFileOpenModeChange}
          onThemeChange={onThemeChange}
          onOpenProjectShell={onOpenProjectShell}
          onOpenSettings={onOpenSettings}
        />
      </header>

      {availableUpdate ? (
        <UpdatePrompt update={availableUpdate} onDownload={onOpenUpdateDownload} onDismiss={onDismissUpdate} />
      ) : null}

      {activeError ? (
        <div className="error-banner">
          <AlertTriangle size={16} />
          <span>{activeError}</span>
        </div>
      ) : null}

      <div className={`terminal-frame${structuredMode ? " structured" : ""}`}>
        {!activeSessionId ? (
          <div className="terminal-placeholder">
            <TerminalIcon size={32} />
            <span>选择一个会话后，Claude 内容会显示在这里</span>
          </div>
        ) : null}
        {activeSessionId && !structuredMode ? (
          terminalSearchOpen ? (
            <div className="terminal-search-panel">
              <Search size={14} />
              <input
                ref={terminalSearchInputRef}
                aria-label="搜索终端输出"
                placeholder="搜索终端输出"
                value={terminalSearchQuery}
                onChange={(event) => {
                  setTerminalSearchQuery(event.target.value);
                  setTerminalSearchFound(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    closeTerminalSearch();
                  } else if (event.key === "Enter") {
                    event.preventDefault();
                    runTerminalSearch(event.shiftKey ? "previous" : "next");
                  }
                }}
              />
              {terminalSearchFound === false ? <span className="terminal-search-empty">未找到</span> : null}
              <button
                className="icon-button tiny"
                aria-label="上一个匹配项"
                title="上一个匹配项（Shift + Enter）"
                disabled={!terminalSearchQuery}
                onClick={() => runTerminalSearch("previous")}
              >
                <ChevronUp size={13} />
              </button>
              <button
                className="icon-button tiny"
                aria-label="下一个匹配项"
                title="下一个匹配项（Enter）"
                disabled={!terminalSearchQuery}
                onClick={() => runTerminalSearch("next")}
              >
                <ChevronDown size={13} />
              </button>
              <button
                className="icon-button tiny"
                aria-label="关闭终端搜索"
                title="关闭搜索（Esc）"
                onClick={closeTerminalSearch}
              >
                <X size={13} />
              </button>
            </div>
          ) : (
            <button
              className="icon-button terminal-search-button"
              aria-label="搜索终端输出"
              title="搜索终端输出"
              onClick={openTerminalSearch}
            >
              <Search size={15} />
            </button>
          )
        ) : null}
        {structuredMode && activeSession ? (
          <StructuredWorkspace
            session={activeSession}
            snapshot={structuredSnapshot}
            onSend={onStructuredSend}
            onRespondPermission={onStructuredPermissionRespond}
            onRespondQuestion={onStructuredQuestionRespond}
            onInterrupt={onStructuredInterrupt}
            onError={onStructuredError}
          />
        ) : null}
        <div className={`terminal-host${structuredMode ? " hidden" : ""}`} ref={terminalHostRef} />
      </div>

      {shellPanelShown ? (
        <div
          className="shell-resize-handle"
          role="separator"
          aria-orientation="horizontal"
          aria-label="调整项目终端高度"
          title="拖动调整项目终端高度"
          onMouseDown={startShellPanelResize}
        />
      ) : null}

      {visibleShellTerminal ? (
        <section className="shell-panel" style={{ flexBasis: shellPanelHeight, height: shellPanelHeight }}>
          <div className="shell-panel-header">
            <div className="shell-panel-title" title={visibleShellTerminal.cwd}>
              <TerminalIcon size={14} />
              <span>项目终端</span>
              <span className="shell-panel-path">{visibleShellTerminal.cwd}</span>
            </div>
            <button className="icon-button tiny" title="停止项目终端" onClick={onCloseProjectShell}>
              <X size={13} />
            </button>
          </div>
          <div className="shell-terminal-host" ref={shellHostRef} />
        </section>
      ) : null}
    </section>
  );
}

function getShellPanelMaxHeight(workspace: HTMLElement | null): number {
  if (!workspace) {
    return 420;
  }

  const workspaceHeight = workspace.getBoundingClientRect().height;
  const ratioMaxHeight = Math.floor(workspaceHeight * SHELL_PANEL_MAX_HEIGHT_RATIO);
  const reservedMaxHeight = Math.floor(workspaceHeight - SHELL_PANEL_TOP_RESERVED_HEIGHT);
  return Math.max(SHELL_PANEL_MIN_HEIGHT, Math.min(ratioMaxHeight, reservedMaxHeight));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
