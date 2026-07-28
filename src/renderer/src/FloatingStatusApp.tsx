import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import {
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  LoaderCircle
} from "lucide-react";
import type {
  AppSettings,
  FloatingSessionSummary,
  FloatingStatusNotice,
  FloatingStatusSnapshot,
  SessionActivityStatus
} from "../../shared/types";

const AUTO_COLLAPSE_DELAY_MS = 7_000;
const MAX_VISIBLE_SESSIONS = 5;

/** 桌面悬浮状态条：聚合多会话状态，并在完成或阻塞时临时展开提醒。 */
export function FloatingStatusApp(): ReactElement {
  const [snapshot, setSnapshot] = useState<FloatingStatusSnapshot>({ sessions: [] });
  const [notice, setNotice] = useState<FloatingStatusNotice | undefined>();
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const manualExpandedRef = useRef(false);
  const lastNoticeAtRef = useRef<string | undefined>(undefined);
  const collapseTimerRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    const applySettings = (settings: AppSettings): void => {
      document.documentElement.dataset.theme = settings.theme;
      document.documentElement.style.colorScheme = settings.theme;
    };
    const applySnapshot = (next: FloatingStatusSnapshot): void => {
      setSnapshot(next);

      // 默认保持紧凑；有会话正在工作或等待处理时，自动展开方便及时查看。
      const hasActiveSession = next.sessions.some(
        (session) => session.state === "working" || session.state === "blocked"
      );
      if (hasActiveSession) {
        clearCollapseTimer(collapseTimerRef);
        collapseTimerRef.current = undefined;
        if (!manualExpandedRef.current) {
          setExpanded(true);
        }
      } else if (!next.notice && !manualExpandedRef.current) {
        // 活跃会话结束且没有完成提醒时，恢复默认的紧凑状态。
        clearCollapseTimer(collapseTimerRef);
        collapseTimerRef.current = undefined;
        setExpanded(false);
      }

      if (!next.notice || next.notice.createdAt === lastNoticeAtRef.current) {
        return;
      }
      lastNoticeAtRef.current = next.notice.createdAt;
      setNotice(next.notice);
      if (manualExpandedRef.current) {
        return;
      }
      clearCollapseTimer(collapseTimerRef);
      setExpanded(true);
      collapseTimerRef.current = window.setTimeout(() => {
        setExpanded(false);
        setNotice(undefined);
        collapseTimerRef.current = undefined;
      }, AUTO_COLLAPSE_DELAY_MS);
    };

    Promise.all([
      window.claudeManager.floatingGetStatus(),
      window.claudeManager.settingsGet()
    ])
      .then(([initialSnapshot, settings]) => {
        applySettings(settings);
        applySnapshot(initialSnapshot);
      })
      .catch((reason: unknown) => setError(errorMessage(reason)));
    const unsubscribeStatus = window.claudeManager.onFloatingStatusUpdated(applySnapshot);
    const unsubscribeSettings = window.claudeManager.onFloatingSettingsUpdated(applySettings);
    return () => {
      clearCollapseTimer(collapseTimerRef);
      unsubscribeStatus();
      unsubscribeSettings();
    };
  }, []);

  const counts = useMemo(() => countStates(snapshot.sessions), [snapshot.sessions]);
  const visibleSessions = snapshot.sessions.slice(0, MAX_VISIBLE_SESSIONS);
  const expandedHeight = calculateExpandedHeight(
    visibleSessions.length,
    Boolean(notice),
    error !== null,
    snapshot.sessions.length > MAX_VISIBLE_SESSIONS
  );

  useEffect(() => {
    window.claudeManager
      .floatingSetExpanded(expanded, expanded ? expandedHeight : 56)
      .catch((reason: unknown) => setError(errorMessage(reason)));
  }, [expanded, expandedHeight]);

  const toggleExpanded = (): void => {
    clearCollapseTimer(collapseTimerRef);
    collapseTimerRef.current = undefined;
    const nextExpanded = !expanded;
    manualExpandedRef.current = nextExpanded;
    setExpanded(nextExpanded);
    if (!nextExpanded) {
      setNotice(undefined);
    }
  };

  return (
    <main className={`floating-status-shell${expanded ? " expanded" : ""}`}>
      <div className="floating-status-header">
        <div className="floating-drag-zone">
          <span className={`floating-app-icon ${dominantState(counts)}`}>
            <Bot size={18} strokeWidth={2.1} />
          </span>
          <div className="floating-summary-copy">
            <strong>{summaryLabel(counts)}</strong>
            <span>{summaryDetail(counts)}</span>
          </div>
        </div>
        <div className="floating-counts" aria-label="会话状态统计">
          {counts.blocked > 0 ? <StatusCount state="blocked" count={counts.blocked} /> : null}
          {counts.working > 0 ? <StatusCount state="working" count={counts.working} /> : null}
          {counts.idle > 0 ? <StatusCount state="idle" count={counts.idle} /> : null}
        </div>
        <button className="floating-toggle" title={expanded ? "收起" : "展开会话状态"} onClick={toggleExpanded}>
          {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </button>
      </div>

      {expanded ? (
        <section className="floating-status-details">
          {notice ? <NoticeBanner notice={notice} sessions={snapshot.sessions} /> : null}
          {error ? <div className="floating-inline-error">{error}</div> : null}
          {visibleSessions.length === 0 ? (
            <div className="floating-empty">暂无运行中的 Claude 会话</div>
          ) : (
            <div className="floating-session-list">
              {visibleSessions.map((session) => (
                <FloatingSessionRow key={session.sessionId} session={session} />
              ))}
            </div>
          )}
          {snapshot.sessions.length > MAX_VISIBLE_SESSIONS ? (
            <div className="floating-more">另有 {snapshot.sessions.length - MAX_VISIBLE_SESSIONS} 个运行会话</div>
          ) : null}
        </section>
      ) : null}
    </main>
  );
}

function FloatingSessionRow({ session }: { session: FloatingSessionSummary }): ReactElement {
  const StateIcon = stateIcon(session.state);
  return (
    <button
      className={`floating-session-row ${session.state}`}
      title={`打开 ${session.projectName} · ${session.title}`}
      onClick={() => {
        window.claudeManager.floatingOpenSession(session.sessionId).catch(() => undefined);
      }}
    >
      <StateIcon className={session.state === "working" ? "spin" : ""} size={16} />
      <span className="floating-session-copy">
        <strong>{session.title}</strong>
        <span>{session.projectName}</span>
      </span>
      <span className={`floating-state-label ${session.state}`}>{stateLabel(session.state)}</span>
    </button>
  );
}

function NoticeBanner({
  notice,
  sessions
}: {
  notice: FloatingStatusNotice;
  sessions: FloatingSessionSummary[];
}): ReactElement {
  const session = sessions.find((item) => item.sessionId === notice.sessionId);
  const blocked = notice.kind === "blocked";
  return (
    <div className={`floating-notice ${notice.kind}`}>
      {blocked ? <CircleAlert size={16} /> : <CheckCircle2 size={16} />}
      <span>
        <strong>{session?.title ?? "Claude 会话"}</strong>
        {blocked ? "正在等待处理" : "已完成本轮任务"}
      </span>
    </div>
  );
}

function StatusCount({ state, count }: { state: SessionActivityStatus; count: number }): ReactElement {
  return <span className={`floating-count ${state}`}>{count}</span>;
}

function countStates(sessions: FloatingSessionSummary[]): Record<SessionActivityStatus, number> {
  const counts: Record<SessionActivityStatus, number> = { idle: 0, working: 0, blocked: 0 };
  for (const session of sessions) {
    counts[session.state] += 1;
  }
  return counts;
}

function dominantState(counts: Record<SessionActivityStatus, number>): SessionActivityStatus {
  return counts.blocked > 0 ? "blocked" : counts.working > 0 ? "working" : "idle";
}

function summaryLabel(counts: Record<SessionActivityStatus, number>): string {
  if (counts.blocked > 0) {
    return `${counts.blocked} 个会话等待处理`;
  }
  if (counts.working > 0) {
    return `${counts.working} 个会话工作中`;
  }
  if (counts.idle > 0) {
    return `${counts.idle} 个会话已完成`;
  }
  return "Claude 会话状态";
}

function summaryDetail(counts: Record<SessionActivityStatus, number>): string {
  const total = counts.idle + counts.working + counts.blocked;
  return total > 0 ? `共 ${total} 个运行会话` : "暂无运行会话";
}

function stateLabel(state: SessionActivityStatus): string {
  return state === "blocked" ? "等待处理" : state === "working" ? "工作中" : "已完成";
}

function stateIcon(state: SessionActivityStatus): typeof CheckCircle2 {
  return state === "blocked" ? CircleAlert : state === "working" ? LoaderCircle : CheckCircle2;
}

function calculateExpandedHeight(
  sessionCount: number,
  hasNotice: boolean,
  hasError: boolean,
  hasMore: boolean
): number {
  return 68
    + sessionCount * 48
    + (hasNotice ? 52 : 0)
    + (hasError ? 34 : 0)
    + (sessionCount === 0 ? 50 : 0)
    + (hasMore ? 24 : 0);
}

function clearCollapseTimer(timerRef: { current: number | undefined }): void {
  if (timerRef.current !== undefined) {
    window.clearTimeout(timerRef.current);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
