import { useCallback, useEffect, useRef, useState } from "react";
import type {
  StructuredPermissionDecision,
  StructuredQuestionAnswers,
  StructuredSessionSnapshot,
  StructuredStreamingPhase
} from "../../../shared/types";
import { errorMessage } from "./terminalUtils";

type UseStructuredClaudeOptions = {
  activeSessionId: string | null;
  onError: (message: string) => void;
};

type UseStructuredClaudeResult = {
  snapshot: StructuredSessionSnapshot | null;
  send: (text: string) => Promise<void>;
  respondPermission: (requestId: string, decision: StructuredPermissionDecision) => Promise<void>;
  respondQuestion: (requestId: string, answers: StructuredQuestionAnswers | null) => Promise<void>;
  interrupt: () => Promise<void>;
};

/** renderer 只订阅结构化快照，协议解析、历史重建和权限原始输入都留在主进程。 */
export function useStructuredClaude({
  activeSessionId,
  onError
}: UseStructuredClaudeOptions): UseStructuredClaudeResult {
  const [snapshot, setSnapshot] = useState<StructuredSessionSnapshot | null>(null);
  const pendingTextRef = useRef("");
  const pendingResetRef = useRef(false);
  const pendingPhaseRef = useRef<StructuredStreamingPhase | undefined>(undefined);
  const textFrameRef = useRef<number | null>(null);

  useEffect(() => {
    if (!activeSessionId) {
      setSnapshot(null);
      return undefined;
    }

    let active = true;
    pendingTextRef.current = "";
    pendingResetRef.current = false;
    pendingPhaseRef.current = undefined;
    if (textFrameRef.current !== null) {
      window.cancelAnimationFrame(textFrameRef.current);
      textFrameRef.current = null;
    }
    setSnapshot(null);
    window.claudeManager
      .structuredGetSnapshot(activeSessionId)
      .then((next) => {
        if (active) {
          setSnapshot(next);
        }
      })
      .catch((error: unknown) => onError(errorMessage(error)));
    const unsubscribe = window.claudeManager.onStructuredSnapshotUpdated((event) => {
      if (active && event.sessionId === activeSessionId) {
        // 完整事件已经包含截至当前的流式正文，丢弃尚未刷新的增量可避免末尾重复。
        pendingTextRef.current = "";
        pendingResetRef.current = false;
        pendingPhaseRef.current = undefined;
        if (textFrameRef.current !== null) {
          window.cancelAnimationFrame(textFrameRef.current);
          textFrameRef.current = null;
        }
        setSnapshot(event.snapshot);
      }
    });
    const unsubscribeTextDelta = window.claudeManager.onStructuredTextDelta((event) => {
      if (!active || event.sessionId !== activeSessionId) {
        return;
      }
      if (event.reset) {
        pendingResetRef.current = true;
        pendingTextRef.current = "";
        pendingPhaseRef.current = undefined;
      }
      pendingPhaseRef.current = event.phase ?? pendingPhaseRef.current;
      pendingTextRef.current += event.text ?? "";
      if (textFrameRef.current !== null) {
        return;
      }
      // 一帧内的多个 token 合并刷新，历史 items 数组保持引用，避免高频重渲染。
      textFrameRef.current = window.requestAnimationFrame(() => {
        textFrameRef.current = null;
        const appended = pendingTextRef.current;
        const reset = pendingResetRef.current;
        const phase = pendingPhaseRef.current;
        pendingTextRef.current = "";
        pendingResetRef.current = false;
        pendingPhaseRef.current = undefined;
        setSnapshot((current) => {
          if (!current || current.sessionId !== event.sessionId) {
            return current;
          }
          return {
            ...current,
            streamingPhase: reset ? phase : phase ?? current.streamingPhase,
            streamingText: reset
              ? appended || undefined
              : `${current.streamingText ?? ""}${appended}`
          };
        });
      });
    });
    return () => {
      active = false;
      if (textFrameRef.current !== null) {
        window.cancelAnimationFrame(textFrameRef.current);
        textFrameRef.current = null;
      }
      unsubscribe();
      unsubscribeTextDelta();
    };
  }, [activeSessionId, onError]);

  const send = useCallback(async (text: string): Promise<void> => {
    if (!activeSessionId) {
      return;
    }
    try {
      await window.claudeManager.structuredSend(activeSessionId, text);
    } catch (error: unknown) {
      onError(errorMessage(error));
      throw error;
    }
  }, [activeSessionId, onError]);

  const respondPermission = useCallback(async (
    requestId: string,
    decision: StructuredPermissionDecision
  ): Promise<void> => {
    if (!activeSessionId) {
      return;
    }
    try {
      await window.claudeManager.structuredRespondPermission(activeSessionId, requestId, decision);
    } catch (error: unknown) {
      onError(errorMessage(error));
    }
  }, [activeSessionId, onError]);

  const interrupt = useCallback(async (): Promise<void> => {
    if (!activeSessionId) {
      return;
    }
    try {
      await window.claudeManager.structuredInterrupt(activeSessionId);
    } catch (error: unknown) {
      onError(errorMessage(error));
    }
  }, [activeSessionId, onError]);

  const respondQuestion = useCallback(async (
    requestId: string,
    answers: StructuredQuestionAnswers | null
  ): Promise<void> => {
    if (!activeSessionId) {
      return;
    }
    try {
      await window.claudeManager.structuredRespondQuestion(activeSessionId, requestId, answers);
    } catch (error: unknown) {
      onError(errorMessage(error));
      throw error;
    }
  }, [activeSessionId, onError]);

  return { snapshot, send, respondPermission, respondQuestion, interrupt };
}
