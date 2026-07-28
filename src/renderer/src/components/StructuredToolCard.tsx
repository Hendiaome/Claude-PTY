import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleEllipsis,
  FileText,
  Pencil,
  Terminal,
  Wrench,
  XCircle
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import type { StructuredToolCall } from "../../../shared/types";
import { StructuredText } from "./StructuredText";

type StructuredToolCardProps = {
  tool: StructuredToolCall;
  onError: (message: string) => void;
};

/** 工具卡片只依赖稳定的 tool_use/tool_result 模型，可独立折叠，不感知 Claude ANSI 输出。 */
export function StructuredToolCard({ tool, onError }: StructuredToolCardProps): JSX.Element {
  const [open, setOpen] = useState(tool.status === "running" || tool.name === "Bash");
  const inputText = useMemo(() => prettyValue(tool.input), [tool.input]);
  const summary = toolSummary(tool);
  const ToolIcon = toolIcon(tool.name);
  const StatusIcon = toolStatusIcon(tool.status);

  useEffect(() => {
    // 工具开始执行时自动展开；完成后尊重用户当前的展开选择。
    if (tool.status === "running") {
      setOpen(true);
    }
  }, [tool.status]);

  return (
    <section className={`structured-tool-card ${tool.status}`}>
      <button
        className="structured-tool-header"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
        <ToolIcon size={15} />
        <span className="structured-tool-name">{toolLabel(tool.name)}</span>
        <span className="structured-tool-summary" title={summary}>{summary}</span>
        <StatusIcon className={tool.status === "running" ? "spin" : ""} size={15} />
      </button>
      {open ? (
        <div className="structured-tool-content">
          <section>
            <div className="structured-tool-section-title">输入</div>
            <pre><StructuredText text={inputText} onError={onError} /></pre>
          </section>
          {tool.output !== undefined ? (
            <section>
              <div className="structured-tool-section-title">输出</div>
              <pre className={tool.status === "error" ? "error" : ""}>
                <StructuredText text={tool.output || "（无输出）"} onError={onError} />
              </pre>
            </section>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function toolSummary(tool: StructuredToolCall): string {
  if (!tool.input || typeof tool.input !== "object") {
    return "";
  }
  const input = tool.input as Record<string, unknown>;
  if (tool.name === "Bash" && typeof input.command === "string") {
    return firstLine(input.command);
  }
  if (["Read", "Edit", "Write"].includes(tool.name) && typeof input.file_path === "string") {
    return input.file_path;
  }
  if (typeof input.path === "string") {
    return input.path;
  }
  if (typeof input.query === "string") {
    return firstLine(input.query);
  }
  return "";
}

function toolIcon(name: string): typeof Wrench {
  if (name === "Bash") {
    return Terminal;
  }
  if (name === "Read") {
    return FileText;
  }
  if (name === "Edit" || name === "Write") {
    return Pencil;
  }
  return Wrench;
}

function toolStatusIcon(status: StructuredToolCall["status"]): typeof CircleEllipsis {
  switch (status) {
    case "running":
      return CircleEllipsis;
    case "success":
      return CheckCircle2;
    case "error":
      return XCircle;
  }
}

function toolLabel(name: string): string {
  // Claude 会把 MCP 工具编码为 mcp__服务名__工具名，界面还原成便于识别的来源和动作。
  const mcpMatch = /^mcp__(.+?)__(.+)$/u.exec(name);
  if (mcpMatch) {
    const serverName = mcpMatch[1].replaceAll("_", "-");
    return `MCP · ${serverName} / ${mcpMatch[2]}`;
  }
  const labels: Record<string, string> = {
    Bash: "终端命令",
    Read: "读取文件",
    Edit: "编辑文件",
    Write: "写入文件",
    Glob: "查找文件",
    Grep: "搜索内容",
    WebFetch: "读取网页",
    WebSearch: "搜索网页",
    Task: "子任务",
    AskUserQuestion: "等待确认"
  };
  return labels[name] ?? name;
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

function firstLine(value: string): string {
  const line = value.split("\n", 1)[0] ?? "";
  return line.length > 120 ? `${line.slice(0, 120)}…` : line;
}
