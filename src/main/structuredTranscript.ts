import { open, stat } from "node:fs/promises";
import type { StructuredSessionSnapshot } from "../shared/types";
import { applyStructuredProtocolMessage } from "./structuredProtocol";

const MAX_TRANSCRIPT_TAIL_BYTES = 4_000_000;
const MAX_TRANSCRIPT_LINES = 4_000;

/**
 * 恢复结构化会话时只读 Claude JSONL 的尾部，并复用实时协议解析器重建最近卡片。
 * 这样应用不复制历史文件，也不会因为超长会话一次性加载无限正文。
 */
export async function loadStructuredTranscript(
  transcriptPath: string,
  snapshot: StructuredSessionSnapshot
): Promise<number> {
  let size: number;
  try {
    size = (await stat(transcriptPath)).size;
  } catch {
    return 0;
  }

  const start = Math.max(0, size - MAX_TRANSCRIPT_TAIL_BYTES);
  const length = size - start;
  const handle = await open(transcriptPath, "r");
  let raw = "";
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    raw = buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }

  const lines = raw.split("\n");
  if (start > 0) {
    // 从文件中间开始时首行可能是不完整 JSON，直接丢弃。
    lines.shift();
  }

  let parsedCount = 0;
  for (const line of lines.slice(-MAX_TRANSCRIPT_LINES)) {
    if (!line.trim()) {
      continue;
    }
    try {
      const event = JSON.parse(line) as unknown;
      const result = applyStructuredProtocolMessage(snapshot, event, true);
      if (result.changed) {
        parsedCount += 1;
      }
    } catch {
      // 单行损坏不影响其余历史恢复，Claude 仍以原 JSONL 作为权威历史。
    }
  }
  snapshot.busy = false;
  snapshot.initialized = false;
  snapshot.permissionRequests = [];
  return parsedCount;
}
