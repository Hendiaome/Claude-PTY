import { useState } from "react";
import type { AppSettings, ClaudeEffortLevel } from "../../../shared/types";

const EFFORT_OPTIONS: Array<{ value: ClaudeEffortLevel; label: string }> = [
  { value: "xhigh", label: "XHigh" },
  { value: "max", label: "Max" },
  { value: "high", label: "High" },
  { value: "medium", label: "Medium" },
  { value: "low", label: "Low" }
];

type SettingsDialogProps = {
  logPath: string;
  settings: AppSettings;
  onCancel: () => void;
  onClearLogs: () => void;
  onOpenLogs: () => void;
  onSubmit: (settings: Pick<
    AppSettings,
    | "defaultEffort"
    | "enableBlockedPromptInstruction"
    | "enableFloatingStatus"
    | "updateFeedUrl"
    | "checkUpdatesAutomatically"
  >) => void;
};

/** 编辑会话默认参数和更新策略，同时提供系统日志的打开与清理入口。 */
export function SettingsDialog({
  logPath,
  settings,
  onCancel,
  onClearLogs,
  onOpenLogs,
  onSubmit
}: SettingsDialogProps): JSX.Element {
  const [defaultEffort, setDefaultEffort] = useState<ClaudeEffortLevel>(settings.defaultEffort);
  const [enableBlockedPromptInstruction, setEnableBlockedPromptInstruction] = useState(
    settings.enableBlockedPromptInstruction
  );
  const [enableFloatingStatus, setEnableFloatingStatus] = useState(settings.enableFloatingStatus);
  const [updateFeedUrl, setUpdateFeedUrl] = useState(settings.updateFeedUrl);
  const [checkUpdatesAutomatically, setCheckUpdatesAutomatically] = useState(settings.checkUpdatesAutomatically);

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onCancel}>
      <form
        className="settings-dialog"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit({
            defaultEffort,
            enableBlockedPromptInstruction,
            enableFloatingStatus,
            updateFeedUrl,
            checkUpdatesAutomatically
          });
        }}
      >
        <div className="settings-dialog-header">
          <h3>设置</h3>
        </div>

        <label className="settings-field" htmlFor="default-effort">
          <span>默认推理级别</span>
          <select
            id="default-effort"
            className="settings-input"
            value={defaultEffort}
            onChange={(event) => setDefaultEffort(event.target.value as ClaudeEffortLevel)}
          >
            {EFFORT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <small className="settings-help">新建或恢复 Claude 会话时生效</small>
        </label>

        <label className="settings-check settings-check-with-help">
          <input
            type="checkbox"
            checked={enableBlockedPromptInstruction}
            onChange={(event) => setEnableBlockedPromptInstruction(event.target.checked)}
          />
          <span className="settings-check-copy">
            <span>引导 Claude 使用结构化提问</span>
            <small>新建或恢复会话时生效，旧版 Claude 不支持时会自动跳过</small>
          </span>
        </label>

        <label className="settings-check settings-check-with-help">
          <input
            type="checkbox"
            checked={enableFloatingStatus}
            onChange={(event) => setEnableFloatingStatus(event.target.checked)}
          />
          <span className="settings-check-copy">
            <span>显示会话状态悬浮窗</span>
            <small>始终置顶展示工作中、已完成和等待处理，可自由拖动</small>
          </span>
        </label>

        <label className="settings-field" htmlFor="update-feed-url">
          <span>更新地址</span>
          <input
            id="update-feed-url"
            className="settings-input"
            value={updateFeedUrl}
            placeholder="https://raw.githubusercontent.com/owner/repository/main/latest.json"
            onChange={(event) => setUpdateFeedUrl(event.target.value)}
          />
        </label>

        <label className="settings-check">
          <input
            type="checkbox"
            checked={checkUpdatesAutomatically}
            onChange={(event) => setCheckUpdatesAutomatically(event.target.checked)}
          />
          <span>自动检查更新</span>
        </label>

        <section className="settings-log-section">
          <div className="settings-log-copy">
            <span>系统日志</span>
            <code title={logPath}>{logPath || "日志路径加载中"}</code>
          </div>
          <div className="settings-log-actions">
            <button type="button" className="text-button" onClick={onOpenLogs}>
              打开日志
            </button>
            <button type="button" className="text-button danger" onClick={onClearLogs}>
              清空日志
            </button>
          </div>
        </section>

        <div className="rename-actions">
          <button type="button" className="text-button" onClick={onCancel}>
            取消
          </button>
          <button type="submit" className="text-button primary">
            保存
          </button>
        </div>
      </form>
    </div>
  );
}
