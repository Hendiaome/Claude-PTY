import { CLAUDE_STATUS_DICTIONARY } from "./claudeStatusDictionary";
import type { ClaudeStatusVerb } from "./claudeStatusDictionary";

const ANSI_SEQUENCE_SOURCE = String.raw`\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))`;
const ANSI_SEQUENCE_REGEX = new RegExp(ANSI_SEQUENCE_SOURCE, "gu");
const LINE_SEPARATOR_REGEX = /(\r\n|\r|\n)/u;
const LINE_BREAK_REGEX = /^\r\n$|^\r$|^\n$/u;
const STATUS_WORD_SOURCE = Object.keys(CLAUDE_STATUS_DICTIONARY).map(escapeRegExp).join("|");
const STATUS_LINE_REGEX = new RegExp(
  String.raw`^[\s>+*·•✻✢✶✳✽○●◇◆▪▫┃│└├┌╭╰-]*(${STATUS_WORD_SOURCE})(?:…|\.{3})\s*\([^\r\n)]*\btokens?\b[^\r\n)]*\)`,
  "u"
);

/** 仅翻译完整的 Claude 状态行，保留 ANSI 控制序列和普通终端输出原样。 */
export function translateClaudeStatusOutput(data: string): string {
  if (!data || (!data.includes("…") && !data.includes("..."))) {
    return data;
  }

  return data
    .split(LINE_SEPARATOR_REGEX)
    .map((part) => (LINE_BREAK_REGEX.test(part) ? part : translateClaudeStatusSegment(part)))
    .join("");
}

function translateClaudeStatusSegment(segment: string): string {
  const plainSegment = stripAnsi(segment);
  const match = STATUS_LINE_REGEX.exec(plainSegment);
  const status = match?.[1] as ClaudeStatusVerb | undefined;
  if (!status) {
    return segment;
  }

  const translatedStatus = CLAUDE_STATUS_DICTIONARY[status];
  const statusRegex = new RegExp(
    `${escapeRegExp(status)}(?=(?:${ANSI_SEQUENCE_SOURCE})*(?:…|\\.{3}))`,
    "u"
  );

  return segment.replace(statusRegex, translatedStatus);
}

function stripAnsi(text: string): string {
  return text.replace(ANSI_SEQUENCE_REGEX, "");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
