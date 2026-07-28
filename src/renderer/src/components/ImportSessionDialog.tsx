import { useState } from "react";

type ImportSessionDialogProps = {
  projectName: string;
  submitting: boolean;
  onCancel: () => void;
  onSubmit: (sessionId: string) => void;
};

/** 仅收集 Claude CLI Session ID；真实历史校验和恢复由主进程完成。 */
export function ImportSessionDialog({
  projectName,
  submitting,
  onCancel,
  onSubmit
}: ImportSessionDialogProps): JSX.Element {
  const [sessionId, setSessionId] = useState("");
  const trimmedSessionId = sessionId.trim();

  const cancel = (): void => {
    if (!submitting) {
      onCancel();
    }
  };

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={cancel}>
      <form
        className="rename-dialog import-session-dialog"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          if (trimmedSessionId && !submitting) {
            onSubmit(trimmedSessionId);
          }
        }}
      >
        <h3>导入历史会话</h3>
        <p className="import-session-help">
          将在「{projectName}」目录下立即恢复该 Claude CLI 会话，恢复成功后才会加入左侧列表。
        </p>
        <label className="rename-label" htmlFor="claude-session-id-input">
          Claude CLI Session ID
        </label>
        <input
          id="claude-session-id-input"
          className="rename-input session-id-input"
          autoComplete="off"
          autoFocus
          placeholder="输入 Session ID"
          spellCheck={false}
          value={sessionId}
          onChange={(event) => setSessionId(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              cancel();
            }
          }}
        />
        <div className="rename-actions">
          <button type="button" className="text-button" disabled={submitting} onClick={cancel}>
            取消
          </button>
          <button type="submit" className="text-button primary" disabled={!trimmedSessionId || submitting}>
            {submitting ? "恢复中…" : "恢复"}
          </button>
        </div>
      </form>
    </div>
  );
}
