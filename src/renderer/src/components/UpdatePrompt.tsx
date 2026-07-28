import { Download, X } from "lucide-react";
import type { UpdateInfo } from "../../../shared/types";

type UpdatePromptProps = {
  update: UpdateInfo;
  onDownload: () => void;
  onDismiss: () => void;
};

/** 仅展示已由主进程确认的新版本，下载按钮交给系统浏览器打开地址。 */
export function UpdatePrompt({ update, onDownload, onDismiss }: UpdatePromptProps): JSX.Element {
  return (
    <div className="update-prompt">
      <div className="update-prompt-main">
        <Download size={15} />
        <div>
          <strong>发现新版本 {update.version}</strong>
          {update.releaseNotes ? <p>{update.releaseNotes}</p> : null}
        </div>
      </div>
      <div className="update-prompt-actions">
        <button className="text-button primary" onClick={onDownload}>
          下载
        </button>
        <button className="icon-button tiny" title="关闭更新提示" onClick={onDismiss}>
          <X size={13} />
        </button>
      </div>
    </div>
  );
}
