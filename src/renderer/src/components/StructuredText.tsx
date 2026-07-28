import type { JSX, ReactNode } from "react";
import { findTerminalPathMatches } from "../hooks/terminalPathLinks";
import { errorMessage } from "../hooks/terminalUtils";

type StructuredTextProps = {
  text: string;
  className?: string;
  onError?: (message: string) => void;
};

/** 在普通 React 文本中复用终端路径识别规则，确保两种会话模式的文件 Link 行为一致。 */
export function StructuredText({ text, className, onError }: StructuredTextProps): JSX.Element {
  const matches = findTerminalPathMatches(text);
  if (matches.length === 0) {
    return <span className={className}>{text}</span>;
  }

  const nodes: ReactNode[] = [];
  let cursor = 0;
  matches.forEach((match, index) => {
    if (match.start > cursor) {
      nodes.push(text.slice(cursor, match.start));
    }
    nodes.push(
      <button
        className="structured-path-link"
        key={`${match.start}-${match.end}-${index}`}
        title="按当前默认打开方式打开文件"
        onClick={() => {
          window.claudeManager
            .terminalPathOpen({ path: match.path, line: match.line, column: match.column })
            .catch((error: unknown) => onError?.(errorMessage(error)));
        }}
      >
        {match.text}
      </button>
    );
    cursor = match.end;
  });
  if (cursor < text.length) {
    nodes.push(text.slice(cursor));
  }
  return <span className={className}>{nodes}</span>;
}
