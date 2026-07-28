export type SessionStatus = "creating" | "running" | "stopping" | "exited" | "failed";
export type SessionActivityStatus = "idle" | "working" | "blocked";
export type SessionTitleSource = "fallback" | "auto" | "manual";
export type SessionMode = "terminal" | "structured";
export type ClaudeEffortLevel = "low" | "medium" | "high" | "max" | "xhigh";
export type FileOpenMode = "idea" | "system";
export type AppTheme = "dark" | "light";

export type AppWindowState = {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized: boolean;
};

export type FloatingWindowPosition = {
  x: number;
  y: number;
};

export type FloatingSessionSummary = {
  sessionId: string;
  title: string;
  projectName: string;
  state: SessionActivityStatus;
  updatedAt: string;
};

export type FloatingStatusNotice = {
  sessionId: string;
  kind: "completed" | "blocked";
  createdAt: string;
};

export type FloatingStatusSnapshot = {
  sessions: FloatingSessionSummary[];
  notice?: FloatingStatusNotice;
};

export type SessionSelectionRequestEvent = {
  sessionId: string;
};

// 持久化领域模型：项目是工作目录记录，会话同时关联应用 ID 和 Claude CLI Session ID。
export type ProjectRecord = {
  id: string;
  path: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt?: string;
  missing: boolean;
};

export type SessionRecord = {
  id: string;
  projectId: string;
  claudeSessionId: string;
  title: string;
  titleSource?: SessionTitleSource;
  titleUpdatedAt?: string;
  // 旧记录在 AppStore 加载时会补成 terminal，保证升级后仍走原 PTY 链路。
  mode: SessionMode;
  status: SessionStatus;
  managedByApp: boolean;
  createdAt: string;
  updatedAt: string;
  lastActiveAt?: string;
  startedAt?: string;
  exitedAt?: string;
  exitCode?: number;
  transcriptPath?: string;
  error?: string;
};

export type StructuredToolStatus = "running" | "success" | "error";

export type StructuredToolCall = {
  id: string;
  name: string;
  input: unknown;
  output?: string;
  status: StructuredToolStatus;
  startedAt: string;
  completedAt?: string;
};

export type StructuredConversationItem =
  | {
      id: string;
      kind: "user" | "assistant" | "thinking";
      text: string;
      createdAt: string;
    }
  | {
      id: string;
      kind: "tool";
      tool: StructuredToolCall;
      createdAt: string;
    }
  | {
      id: string;
      kind: "notice";
      text: string;
      tone: "muted" | "error";
      createdAt: string;
    };

export type StructuredPermissionRequest = {
  requestId: string;
  toolUseId?: string;
  toolName: string;
  input: unknown;
  title?: string;
  description?: string;
  createdAt: string;
};

export type StructuredQuestionOption = {
  label: string;
  description?: string;
  preview?: string;
};

export type StructuredQuestion = {
  question: string;
  header?: string;
  options: StructuredQuestionOption[];
  multiSelect: boolean;
};

export type StructuredQuestionRequest = {
  requestId: string;
  toolUseId?: string;
  questions: StructuredQuestion[];
  createdAt: string;
};

export type StructuredQuestionAnswers = Record<string, string>;

export type StructuredSlashCommand = {
  name: string;
  description?: string;
  argumentHint?: string;
};

export type StructuredStreamingPhase = "thinking" | "responding";

// 结构化正文只保留在主进程内存和 Claude 自身历史文件中，不写入应用日志或配置文件。
export type StructuredSessionSnapshot = {
  sessionId: string;
  items: StructuredConversationItem[];
  permissionRequests: StructuredPermissionRequest[];
  questionRequests: StructuredQuestionRequest[];
  // 流式正文和阶段单独增量同步，避免每个片段都复制整份历史快照。
  streamingText?: string;
  streamingPhase?: StructuredStreamingPhase;
  // 工作起点和阶段文案用于右侧实时反馈，不从对话正文猜测状态。
  busy: boolean;
  busyStartedAt?: string;
  activityLabel?: string;
  lastCompletedAt?: string;
  // 运行元数据来自本次 Claude 进程和 stream-json，不能用当前全局设置反推历史会话。
  model?: string;
  effort?: ClaudeEffortLevel;
  contextUsedTokens?: number;
  contextWindowTokens?: number;
  initialized: boolean;
  slashCommands: StructuredSlashCommand[];
  error?: string;
};

export type StructuredSnapshotUpdatedEvent = {
  sessionId: string;
  snapshot: StructuredSessionSnapshot;
};

export type StructuredTextDeltaEvent = {
  sessionId: string;
  text?: string;
  phase?: StructuredStreamingPhase;
  reset?: boolean;
};

export type StructuredPermissionDecision = "allow" | "deny";

export type EnvironmentCheckResult = {
  ok: boolean;
  claudePath?: string;
  nodePath?: string;
  shellPath: string;
  message?: string;
};

// PTY 跨进程事件只携带路由标识和原始终端数据，不在 renderer 保存进程对象。
export type TerminalBuffer = {
  sessionId: string;
  chunks: string[];
};

export type TerminalDataEvent = {
  sessionId: string;
  data: string;
};

export type TerminalExitEvent = {
  sessionId: string;
  exitCode?: number;
};

export type TerminalOutputResumedEvent = {
  sessionId: string;
};

// 任务活动状态独立于 PTY 进程状态，不持久化，避免应用重启后展示过期状态。
export type SessionActivityState = {
  sessionId: string;
  state: SessionActivityStatus;
  updatedAt: string;
};

export type TerminalResize = {
  sessionId: string;
  cols: number;
  rows: number;
};

export type ShellTerminalInfo = {
  projectId: string;
  cwd: string;
};

export type ShellTerminalDataEvent = {
  projectId: string;
  data: string;
};

export type ShellTerminalExitEvent = {
  projectId: string;
  exitCode?: number;
};

export type ShellTerminalOutputResumedEvent = {
  projectId: string;
};

// 用户设置由主进程规范化并持久化，renderer 只持有当前快照。
export type AppSettings = {
  version: 1;
  defaultEffort: ClaudeEffortLevel;
  enableBlockedPromptInstruction: boolean;
  fileOpenMode: FileOpenMode;
  theme: AppTheme;
  sidebarCollapsed: boolean;
  sidebarWidth: number;
  windowState: AppWindowState;
  enableFloatingStatus: boolean;
  floatingWindowPosition?: FloatingWindowPosition;
  updateFeedUrl: string;
  checkUpdatesAutomatically: boolean;
};

export type TerminalPathOpenRequest = {
  path: string;
  line?: number;
  column?: number;
};

// Finder 文件粘贴和交互日志只传必要元数据，不传终端正文。
export type TerminalFilePasteEvent = {
  paths: string[];
};

export type TerminalImeNavigationTrigger =
  | "ctrl-a"
  | "ctrl-b"
  | "ctrl-e"
  | "ctrl-f"
  | "ctrl-n"
  | "ctrl-p"
  | "arrow-down"
  | "arrow-left"
  | "arrow-right"
  | "arrow-up"
  | "end"
  | "home";

export type StructuredImeSuppressionTrigger =
  | "composition"
  | "native-composing"
  | "keycode-229"
  | "recent-composition-end";

export type TerminalRenderRecoveryTrigger = "output-resumed" | "power-resumed" | "window-focus";

export type TerminalRenderRecoveryRequestEvent = {
  trigger: "power-resumed";
};

export type TerminalInteractionLogRequest =
  | {
      event: "focus-restored";
      identifier: string;
      trigger: "window-focus";
    }
  | {
      event: "file-paths-pasted";
      identifier: string;
      fileCount: number;
    }
  | {
      event: "session-selection-restored";
      identifier: string;
      source: "saved" | "running-fallback";
    }
  | {
      event: "terminal-selection-copied";
      identifier: string;
      charCount: number;
    }
  | {
      event: "terminal-input-selection-deleted";
      identifier: string;
      charCount: number;
    }
  | {
      event: "terminal-ime-buffer-reset";
      identifier: string;
      surface: "claude" | "shell";
      trigger: TerminalImeNavigationTrigger;
      previousLength: number;
      selectionStart: number;
      selectionEnd: number;
      cursorColumn: number;
    }
  | {
      event: "terminal-render-recovered";
      identifier: string;
      surface: "claude" | "shell";
      trigger: TerminalRenderRecoveryTrigger;
      cols: number;
      rows: number;
      ptyResizeRequested: boolean;
      pulseCols?: number;
    }
  | {
      event: "terminal-search-performed";
      identifier: string;
      direction: "next" | "previous";
      found: boolean;
    }
  | {
      event: "structured-ime-enter-suppressed";
      identifier: string;
      trigger: StructuredImeSuppressionTrigger;
    };

export type AppLogInfo = {
  path: string;
};

export type UpdateInfo = {
  version: string;
  dmgUrl: string;
  releaseNotes?: string;
  mandatory?: boolean;
  checkedAt: string;
};

export type UpdateCheckResult = {
  ok: boolean;
  update?: UpdateInfo;
  error?: string;
  checkedAt: string;
};

export type AppStoreData = {
  version: 1;
  projects: ProjectRecord[];
  sessions: SessionRecord[];
};
