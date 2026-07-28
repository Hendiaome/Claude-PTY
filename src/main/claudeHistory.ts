import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CLAUDE_SESSION_ID_REGEX = /^[A-Za-z0-9][A-Za-z0-9_-]{5,127}$/u;

/** 收紧外部输入的 Session ID，避免它被当成路径片段使用。 */
export function normalizeClaudeSessionId(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Claude CLI Session ID 无效。");
  }

  const sessionId = value.trim();
  if (!CLAUDE_SESSION_ID_REGEX.test(sessionId)) {
    throw new Error("Claude CLI Session ID 仅支持字母、数字、下划线和中划线。");
  }

  return sessionId;
}

/** 按 Claude CLI 的工程目录编码规则定位本地 JSONL 会话文件。 */
export function getClaudeTranscriptPath(projectPath: string, claudeSessionId: string): string {
  return join(
    homedir(),
    ".claude",
    "projects",
    encodeClaudeProjectPath(projectPath),
    `${claudeSessionId}.jsonl`
  );
}

export function claudeTranscriptExists(projectPath: string, claudeSessionId: string): boolean {
  try {
    return statSync(getClaudeTranscriptPath(projectPath, claudeSessionId)).isFile();
  } catch {
    return false;
  }
}

function encodeClaudeProjectPath(projectPath: string): string {
  // Claude 使用仅含字母数字的目录名，路径分隔符、下划线等其他字符都会编码为中划线。
  return projectPath.replace(/\/+$/u, "").replace(/[^A-Za-z0-9]/gu, "-");
}
