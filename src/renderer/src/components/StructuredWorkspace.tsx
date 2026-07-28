import { CheckCircle2, CircleStop, Command, LoaderCircle, Send, ShieldAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import type {
  SessionRecord,
  StructuredImeSuppressionTrigger,
  StructuredPermissionDecision,
  StructuredQuestionAnswers,
  StructuredSessionSnapshot,
  StructuredSlashCommand
} from "../../../shared/types";
import { StructuredText } from "./StructuredText";
import { StructuredToolCard } from "./StructuredToolCard";
import { StructuredQuestionCard } from "./StructuredQuestionCard";

type StructuredWorkspaceProps = {
  session: SessionRecord;
  snapshot: StructuredSessionSnapshot | null;
  onSend: (text: string) => Promise<void>;
  onRespondPermission: (requestId: string, decision: StructuredPermissionDecision) => Promise<void>;
  onRespondQuestion: (requestId: string, answers: StructuredQuestionAnswers | null) => Promise<void>;
  onInterrupt: () => Promise<void>;
  onError: (message: string) => void;
};

/** 结构化会话页面：对话正文、工具卡片、权限确认和输入框均不依赖 xterm。 */
export function StructuredWorkspace({
  session,
  snapshot,
  onSend,
  onRespondPermission,
  onRespondQuestion,
  onInterrupt,
  onError
}: StructuredWorkspaceProps): JSX.Element {
  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [selectedCommandIndex, setSelectedCommandIndex] = useState(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const shouldStickToBottomRef = useRef(true);
  const compositionRef = useRef(false);
  const compositionEndedAtRef = useRef(0);
  const permissionPending = Boolean(snapshot?.permissionRequests.length);
  const questionPending = Boolean(snapshot?.questionRequests.length);
  const interactionPending = permissionPending || questionPending;
  const processRunning = session.status === "running";
  const busy = snapshot?.busy === true;
  const commandMatches = matchingSlashCommands(snapshot?.slashCommands ?? [], draft);
  const commandMenuOpen = commandMatches.length > 0 && processRunning && !busy && !interactionPending;
  const activeCommandIndex = Math.min(selectedCommandIndex, Math.max(0, commandMatches.length - 1));
  const elapsedSeconds = useElapsedSeconds(snapshot?.busyStartedAt, busy);
  const activity = activityView(snapshot, processRunning, elapsedSeconds);
  const runtimeDetails = structuredRuntimeDetails(snapshot);

  useEffect(() => {
    setDraft("");
    setSelectedCommandIndex(0);
    shouldStickToBottomRef.current = true;
  }, [session.id]);

  useEffect(() => {
    // 输入的命令前缀变化后从首个匹配项开始，避免选择索引落到列表之外。
    setSelectedCommandIndex(0);
  }, [draft, snapshot?.slashCommands]);

  useEffect(() => {
    if (!shouldStickToBottomRef.current) {
      return;
    }
    const element = scrollRef.current;
    if (element) {
      element.scrollTop = element.scrollHeight;
    }
  }, [snapshot?.items.length, snapshot?.permissionRequests.length, snapshot?.questionRequests.length, snapshot?.streamingPhase, snapshot?.streamingText?.length]);

  const submit = async (): Promise<void> => {
    const text = draft.trim();
    if (!text || submitting || !processRunning || busy || interactionPending) {
      return;
    }
    setSubmitting(true);
    try {
      await onSend(text);
      setDraft("");
      shouldStickToBottomRef.current = true;
    } catch {
      // Hook 已把错误显示到工作区，保留草稿便于用户修正后重试。
    } finally {
      setSubmitting(false);
    }
  };

  const chooseCommand = (command: StructuredSlashCommand): void => {
    setDraft(`${command.name} `);
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  return (
    <div className="structured-workspace">
      <div
        className="structured-message-list"
        ref={scrollRef}
        onScroll={(event) => {
          const element = event.currentTarget;
          shouldStickToBottomRef.current =
            element.scrollHeight - element.scrollTop - element.clientHeight < 80;
        }}
      >
        {!snapshot ? (
          <div className="structured-empty"><LoaderCircle className="spin" size={20} />正在加载结构化会话</div>
        ) : snapshot.items.length === 0 && !snapshot.streamingText && !snapshot.streamingPhase && !interactionPending ? (
          <div className="structured-empty">
            <span>结构化模式已就绪</span>
            <small>Claude 的文本、命令和文件操作会分别显示；输入 / 可以查看当前版本支持的命令。</small>
          </div>
        ) : (
          snapshot.items.map((item) => {
            if (item.kind === "tool") {
              return <StructuredToolCard key={item.id} tool={item.tool} onError={onError} />;
            }
            if (item.kind === "thinking") {
              return (
                <details className="structured-thinking" key={item.id}>
                  <summary>思考过程</summary>
                  <pre>{item.text}</pre>
                </details>
              );
            }
            if (item.kind === "notice") {
              return <div className={`structured-notice ${item.tone}`} key={item.id}>{item.text}</div>;
            }
            return (
              <article className={`structured-message ${item.kind}`} key={item.id}>
                <div className="structured-message-role">{item.kind === "user" ? "你" : "Claude"}</div>
                <div className="structured-message-text">
                  <StructuredText text={item.text} onError={onError} />
                </div>
              </article>
            );
          })
        )}

        {snapshot?.streamingPhase === "thinking" ? (
          <article className="structured-thinking-live" aria-live="polite">
            <LoaderCircle className="spin" size={16} />
            <span>Claude 正在思考</span>
            <i aria-hidden="true"><b /><b /><b /></i>
          </article>
        ) : null}

        {snapshot?.streamingText ? (
          <article className="structured-message assistant streaming">
            <div className="structured-message-role">Claude · 回复中</div>
            <div className="structured-message-text">
              {/* 流式阶段只渲染纯文本，完整消息到达后再做路径识别，避免每个 token 全文重扫。 */}
              <span>{snapshot.streamingText}</span>
              <span className="structured-stream-cursor" aria-hidden="true" />
            </div>
          </article>
        ) : null}

        {snapshot?.permissionRequests.map((request) => (
          <section className="structured-permission" key={request.requestId}>
            <div className="structured-permission-title">
              <ShieldAlert size={17} />
              <span>{request.title || `${request.toolName} 请求执行权限`}</span>
            </div>
            {request.description ? <p>{request.description}</p> : null}
            <pre><StructuredText text={prettyValue(request.input)} onError={onError} /></pre>
            <div className="structured-permission-actions">
              <button
                className="text-button"
                onClick={() => void onRespondPermission(request.requestId, "deny")}
              >
                拒绝
              </button>
              <button
                className="text-button primary"
                onClick={() => void onRespondPermission(request.requestId, "allow")}
              >
                允许
              </button>
            </div>
          </section>
        ))}
        {snapshot?.questionRequests.map((request) => (
          <StructuredQuestionCard
            key={request.requestId}
            request={request}
            onRespond={onRespondQuestion}
            onError={onError}
          />
        ))}
      </div>

      {commandMenuOpen ? (
        <div className="structured-command-menu" role="listbox" aria-label="Claude 命令">
          <div className="structured-command-menu-title">
            <Command size={14} />
            <span>Claude 命令</span>
            <small>Tab 补全，Enter 执行</small>
          </div>
          {commandMatches.map((command, index) => (
            <button
              className={index === activeCommandIndex ? "selected" : ""}
              key={command.name}
              role="option"
              aria-selected={index === activeCommandIndex}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => chooseCommand(command)}
            >
              <code>{command.name}</code>
              {command.argumentHint ? <span>{command.argumentHint}</span> : null}
              {command.description ? <small>{command.description}</small> : null}
            </button>
          ))}
        </div>
      ) : null}

      <div className={`structured-activity-bar ${activity.tone}`}>
        <div className="structured-activity-state">
          {activity.tone === "working" ? (
            <LoaderCircle className="spin" size={14} />
          ) : activity.tone === "blocked" ? (
            <ShieldAlert size={14} />
          ) : activity.tone === "completed" ? (
            <CheckCircle2 size={14} />
          ) : activity.tone === "error" ? (
            <CircleStop size={14} />
          ) : (
            <Command size={14} />
          )}
          <span>{activity.label}</span>
        </div>
        {runtimeDetails.length > 0 ? (
          <div className="structured-runtime-meta" aria-label="Claude 运行信息">
            {runtimeDetails.map((detail) => (
              <span key={detail.key} title={detail.title}>{detail.label}</span>
            ))}
          </div>
        ) : null}
      </div>

      <div className="structured-composer">
        <textarea
          ref={textareaRef}
          aria-label="输入 Claude 消息"
          placeholder={
            !processRunning
              ? "会话已退出，点击左侧会话恢复"
              : questionPending
                ? "请先回答上方问题"
                : permissionPending
                ? "请先处理上方权限请求"
                : busy
                  ? "Claude 工作中，可中断后重新输入"
                  : "输入消息或 /命令，Enter 发送，Shift + Enter 换行"
          }
          value={draft}
          disabled={!processRunning || interactionPending}
          onChange={(event) => setDraft(event.target.value)}
          onCompositionStart={() => {
            compositionRef.current = true;
          }}
          onCompositionEnd={() => {
            compositionRef.current = false;
            compositionEndedAtRef.current = performance.now();
          }}
          onKeyDown={(event) => {
            const nativeEvent = event.nativeEvent;
            const suppressionTrigger: StructuredImeSuppressionTrigger | undefined = compositionRef.current
              ? "composition"
              : nativeEvent.isComposing
                ? "native-composing"
                : nativeEvent.keyCode === 229
                  ? "keycode-229"
                  : event.key === "Enter" && performance.now() - compositionEndedAtRef.current < 80
                    ? "recent-composition-end"
                    : undefined;
            // 输入法确认候选词也会触发 Enter；组合阶段必须完整交还给输入法处理。
            if (suppressionTrigger) {
              if (event.key === "Enter") {
                window.claudeManager.terminalInteractionLog({
                  event: "structured-ime-enter-suppressed",
                  identifier: session.id,
                  trigger: suppressionTrigger
                });
              }
              return;
            }
            if (commandMenuOpen && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
              event.preventDefault();
              const offset = event.key === "ArrowDown" ? 1 : -1;
              setSelectedCommandIndex((current) =>
                (current + offset + commandMatches.length) % commandMatches.length
              );
              return;
            }
            if (commandMenuOpen && event.key === "Tab") {
              event.preventDefault();
              chooseCommand(commandMatches[activeCommandIndex]);
              return;
            }
            if (
              commandMenuOpen &&
              event.key === "Enter" &&
              !event.shiftKey &&
              draft.trim() !== commandMatches[activeCommandIndex].name
            ) {
              event.preventDefault();
              chooseCommand(commandMatches[activeCommandIndex]);
              return;
            }
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void submit();
            }
          }}
        />
        <div className="structured-composer-actions">
          {busy ? (
            <button className="icon-button" title="中断当前处理" onClick={() => void onInterrupt()}>
              <CircleStop size={17} />
            </button>
          ) : null}
          <button
            className="icon-button active"
            aria-label="发送"
            title="发送"
            disabled={!draft.trim() || submitting || !processRunning || busy || interactionPending}
            onClick={() => void submit()}
          >
            {submitting ? <LoaderCircle className="spin" size={17} /> : <Send size={17} />}
          </button>
        </div>
      </div>
    </div>
  );
}

type StructuredActivityView = {
  tone: "muted" | "working" | "blocked" | "completed" | "error";
  label: string;
};

type StructuredRuntimeDetail = {
  key: "model" | "effort" | "context";
  label: string;
  title: string;
};

function activityView(
  snapshot: StructuredSessionSnapshot | null,
  processRunning: boolean,
  elapsedSeconds: number | null
): StructuredActivityView {
  if (!processRunning) {
    return { tone: "muted", label: "结构化会话已退出" };
  }
  if (!snapshot) {
    return { tone: "working", label: "正在连接 Claude" };
  }
  const permission = snapshot.permissionRequests[0];
  if (permission) {
    return { tone: "blocked", label: `等待你处理 · ${permission.toolName} 权限` };
  }
  const question = snapshot.questionRequests[0];
  if (question) {
    return { tone: "blocked", label: `等待你回答 · ${question.questions.length} 个问题` };
  }
  if (snapshot.busy) {
    const elapsed = elapsedSeconds === null ? "" : ` · ${formatElapsed(elapsedSeconds)}`;
    return { tone: "working", label: `${snapshot.activityLabel ?? "Claude 工作中"}${elapsed}` };
  }
  if (snapshot.error) {
    return { tone: "error", label: "本轮处理失败" };
  }
  if (snapshot.lastCompletedAt) {
    return { tone: "completed", label: "本轮已完成" };
  }
  // initialized 只代表 Slash 命令元数据是否到达，不能用于判断 Claude 进程是否可输入。
  return { tone: "muted", label: "结构化模式已就绪" };
}

/** 只展示 Claude 当前进程回报的运行信息，缺失字段不使用静态模型规格兜底。 */
function structuredRuntimeDetails(snapshot: StructuredSessionSnapshot | null): StructuredRuntimeDetail[] {
  if (!snapshot) {
    return [];
  }
  const details: StructuredRuntimeDetail[] = [];
  if (snapshot.model) {
    details.push({ key: "model", label: snapshot.model, title: "当前模型" });
  }
  if (snapshot.effort) {
    details.push({ key: "effort", label: `推理 ${snapshot.effort}`, title: "本会话启动时的推理级别" });
  }
  const contextLabel = formatContextUsage(snapshot.contextUsedTokens, snapshot.contextWindowTokens);
  if (contextLabel) {
    details.push({ key: "context", label: contextLabel, title: "当前上下文用量 / 上下文窗口" });
  }
  return details;
}

function formatContextUsage(used: number | undefined, limit: number | undefined): string | undefined {
  if (used && limit) {
    return `上下文 ${formatTokenCount(used)} / ${formatTokenCount(limit)}`;
  }
  if (limit) {
    return `上下文 ${formatTokenCount(limit)}`;
  }
  if (used) {
    return `上下文 ${formatTokenCount(used)}`;
  }
  return undefined;
}

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${compactNumber(tokens / 1_000_000)}M`;
  }
  if (tokens >= 1_000) {
    return `${compactNumber(tokens / 1_000)}K`;
  }
  return `${Math.round(tokens)}`;
}

function compactNumber(value: number): string {
  return (value >= 100 ? value.toFixed(0) : value.toFixed(1)).replace(/\.0$/u, "");
}

/** 计时只驱动状态文案，不触碰会话快照或正文数据。 */
function useElapsedSeconds(startedAt: string | undefined, active: boolean): number | null {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    setNow(Date.now());
    if (!active || !startedAt) {
      return undefined;
    }
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [active, startedAt]);

  if (!active || !startedAt) {
    return null;
  }
  const start = Date.parse(startedAt);
  return Number.isFinite(start) ? Math.max(0, Math.floor((now - start) / 1_000)) : null;
}

function matchingSlashCommands(commands: StructuredSlashCommand[], draft: string): StructuredSlashCommand[] {
  if (!/^\/[^\s]*$/u.test(draft)) {
    return [];
  }
  const query = draft.toLocaleLowerCase();
  return commands
    .filter((command) => command.name.toLocaleLowerCase().startsWith(query))
    .sort((left, right) => Number(right.name.toLocaleLowerCase() === query) - Number(left.name.toLocaleLowerCase() === query))
    .slice(0, 8);
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) {
    return `${seconds} 秒`;
  }
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${`${seconds % 60}`.padStart(2, "0")}`;
}

function prettyValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value ?? "");
  }
}
