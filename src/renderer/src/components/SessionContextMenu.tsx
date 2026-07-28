import type { SessionRecord } from "../../../shared/types";

type SessionContextMenuProps = {
  session: SessionRecord | null;
  x: number;
  y: number;
  onRename: (session: SessionRecord) => void;
  onDelete: (sessionId: string) => void;
};

/** 会话右键菜单只操作管理记录，运行中会话必须先结束才能删除。 */
export function SessionContextMenu({
  session,
  x,
  y,
  onRename,
  onDelete
}: SessionContextMenuProps): JSX.Element | null {
  if (!session) {
    return null;
  }

  const disabled = session.status === "running" || session.status === "stopping";

  return (
    <div className="context-menu" style={{ left: x, top: y }} role="menu">
      <button className="context-menu-item" onClick={() => onRename(session)}>
        重命名会话
      </button>
      <button
        className="context-menu-item danger"
        disabled={disabled}
        title={disabled ? "先结束运行中的会话" : "删除会话记录"}
        onClick={() => onDelete(session.id)}
      >
        删除会话记录
      </button>
    </div>
  );
}
