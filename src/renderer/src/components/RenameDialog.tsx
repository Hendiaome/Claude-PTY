import { useState } from "react";

type RenameDialogProps = {
  initialTitle: string;
  onCancel: () => void;
  onSubmit: (title: string) => void;
};

/** 手工命名成功后会覆盖自动标题来源，后续标题扫描不会再改写。 */
export function RenameDialog({ initialTitle, onCancel, onSubmit }: RenameDialogProps): JSX.Element {
  const [title, setTitle] = useState(initialTitle);
  const trimmedTitle = title.trim();

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onCancel}>
      <form
        className="rename-dialog"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          if (trimmedTitle) {
            onSubmit(trimmedTitle);
          }
        }}
      >
        <label className="rename-label" htmlFor="session-title-input">
          会话名称
        </label>
        <input
          id="session-title-input"
          className="rename-input"
          autoFocus
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              onCancel();
            }
          }}
        />
        <div className="rename-actions">
          <button type="button" className="text-button" onClick={onCancel}>
            取消
          </button>
          <button type="submit" className="text-button primary" disabled={!trimmedTitle}>
            保存
          </button>
        </div>
      </form>
    </div>
  );
}
