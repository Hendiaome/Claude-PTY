import type {
  SessionActivityStatus,
  StructuredConversationItem,
  StructuredSlashCommand,
  StructuredSessionSnapshot,
  StructuredToolCall
} from "../shared/types";

const MAX_ITEM_TEXT_CHARS = 500_000;
const MAX_DISPLAY_STRING_CHARS = 200_000;
const MAX_DISPLAY_DEPTH = 6;
const MAX_DISPLAY_COLLECTION_ITEMS = 200;

export type StructuredProtocolApplyResult = {
  changed: boolean;
  activity?: SessionActivityStatus;
  eventType?: string;
  toolNames: string[];
};

/** 创建不含正文的初始快照；正文只在当前进程内存中维护。 */
export function createStructuredSnapshot(sessionId: string): StructuredSessionSnapshot {
  return {
    sessionId,
    items: [],
    permissionRequests: [],
    questionRequests: [],
    busy: false,
    initialized: false,
    slashCommands: []
  };
}

/**
 * 把 Claude stream-json 的稳定消息类型归并为 UI 模型。
 * 这里只消费完整 assistant/user 事件，不依赖增量事件的内部顺序。
 */
export function applyStructuredProtocolMessage(
  snapshot: StructuredSessionSnapshot,
  message: unknown,
  includeUserText = false
): StructuredProtocolApplyResult {
  if (!isRecord(message) || typeof message.type !== "string") {
    return unchanged();
  }

  switch (message.type) {
    case "system":
      return applySystem(snapshot, message);
    case "assistant":
      return applyAssistant(snapshot, message);
    case "user":
      return applyUser(snapshot, message, includeUserText);
    case "result":
      return applyResult(snapshot, message);
    default:
      return { ...unchanged(), eventType: message.type };
  }
}

/** 限制发送到 renderer 的对象体积，同时保留允许工具时使用的原始输入于主进程。 */
export function toStructuredDisplayValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    return truncate(value, MAX_DISPLAY_STRING_CHARS);
  }
  if (typeof value !== "object") {
    return String(value);
  }
  if (depth >= MAX_DISPLAY_DEPTH) {
    return "[内容层级过深]";
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_DISPLAY_COLLECTION_ITEMS)
      .map((item) => toStructuredDisplayValue(item, depth + 1));
  }

  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value).slice(0, MAX_DISPLAY_COLLECTION_ITEMS)) {
    result[key] = toStructuredDisplayValue(child, depth + 1);
  }
  return result;
}

function applySystem(
  snapshot: StructuredSessionSnapshot,
  message: Record<string, unknown>
): StructuredProtocolApplyResult {
  const subtype = typeof message.subtype === "string" ? message.subtype : "unknown";
  if (subtype === "init") {
    snapshot.initialized = true;
    snapshot.slashCommands = normalizeSlashCommands(message.slash_commands);
    applyRuntimeModel(snapshot, message.model);
    return { changed: true, eventType: `system:${subtype}`, toolNames: [] };
  }
  if (subtype === "status" && message.status === "requesting") {
    markBusy(snapshot, "Claude 工作中");
    snapshot.error = undefined;
    return { changed: true, activity: "working", eventType: `system:${subtype}`, toolNames: [] };
  }
  return { ...unchanged(), eventType: `system:${subtype}` };
}

function applyAssistant(
  snapshot: StructuredSessionSnapshot,
  event: Record<string, unknown>
): StructuredProtocolApplyResult {
  // 完整 assistant 事件会替换 renderer 正在展示的临时流式文本，避免正文重复。
  snapshot.streamingText = undefined;
  snapshot.streamingPhase = undefined;
  const message = isRecord(event.message) ? event.message : undefined;
  if (!message) {
    return { ...unchanged(), eventType: "assistant" };
  }
  applyRuntimeModel(snapshot, message.model);
  applyContextUsage(snapshot, message.usage);
  if (!Array.isArray(message.content)) {
    return { ...unchanged(), eventType: "assistant" };
  }

  const eventId = stringValue(event.uuid) ?? stringValue(message.id) ?? `assistant-${Date.now()}`;
  const createdAt = timestampValue(event.timestamp);
  const toolNames: string[] = [];
  let changed = false;

  message.content.forEach((rawBlock, index) => {
    if (!isRecord(rawBlock) || typeof rawBlock.type !== "string") {
      return;
    }

    if (rawBlock.type === "text" && typeof rawBlock.text === "string" && rawBlock.text) {
      changed = appendUniqueItem(snapshot, {
        id: `${eventId}:text:${index}`,
        kind: "assistant",
        text: truncate(rawBlock.text, MAX_ITEM_TEXT_CHARS),
        createdAt
      }) || changed;
      return;
    }

    if (rawBlock.type === "thinking" && typeof rawBlock.thinking === "string" && rawBlock.thinking) {
      changed = appendUniqueItem(snapshot, {
        id: `${eventId}:thinking:${index}`,
        kind: "thinking",
        text: truncate(rawBlock.thinking, MAX_ITEM_TEXT_CHARS),
        createdAt
      }) || changed;
      return;
    }

    if (rawBlock.type !== "tool_use" || typeof rawBlock.id !== "string" || typeof rawBlock.name !== "string") {
      return;
    }

    toolNames.push(rawBlock.name);
    const existing = findTool(snapshot, rawBlock.id);
    if (existing) {
      existing.name = rawBlock.name;
      existing.input = toStructuredDisplayValue(rawBlock.input);
      existing.status = existing.completedAt ? existing.status : "running";
      changed = true;
      return;
    }

    const tool: StructuredToolCall = {
      id: rawBlock.id,
      name: rawBlock.name,
      input: toStructuredDisplayValue(rawBlock.input),
      status: "running",
      startedAt: createdAt
    };
    changed = appendUniqueItem(snapshot, {
      id: `tool:${rawBlock.id}`,
      kind: "tool",
      tool,
      createdAt
    }) || changed;
  });

  if (changed) {
    markBusy(
      snapshot,
      toolNames.length > 0 ? `正在执行 ${toolNames[toolNames.length - 1]}` : "Claude 工作中",
      createdAt
    );
    snapshot.error = undefined;
  }
  return {
    changed,
    activity: changed ? "working" : undefined,
    eventType: "assistant",
    toolNames
  };
}

function applyUser(
  snapshot: StructuredSessionSnapshot,
  event: Record<string, unknown>,
  includeUserText: boolean
): StructuredProtocolApplyResult {
  const message = isRecord(event.message) ? event.message : undefined;
  if (!message) {
    return { ...unchanged(), eventType: "user" };
  }

  const content = message.content;
  const eventId = stringValue(event.uuid) ?? `user-${Date.now()}`;
  const createdAt = timestampValue(event.timestamp);
  let changed = false;

  if (includeUserText && typeof content === "string" && content) {
    changed = appendUniqueItem(snapshot, {
      id: `${eventId}:text`,
      kind: "user",
      text: truncate(content, MAX_ITEM_TEXT_CHARS),
      createdAt
    });
  }

  if (!Array.isArray(content)) {
    return { changed, eventType: "user", toolNames: [] };
  }

  content.forEach((rawBlock, index) => {
    if (!isRecord(rawBlock)) {
      return;
    }
    if (includeUserText && rawBlock.type === "text" && typeof rawBlock.text === "string" && rawBlock.text) {
      changed = appendUniqueItem(snapshot, {
        id: `${eventId}:text:${index}`,
        kind: "user",
        text: truncate(rawBlock.text, MAX_ITEM_TEXT_CHARS),
        createdAt
      }) || changed;
      return;
    }
    if (rawBlock.type !== "tool_result" || typeof rawBlock.tool_use_id !== "string") {
      return;
    }

    const tool = findTool(snapshot, rawBlock.tool_use_id);
    if (!tool) {
      return;
    }
    const isError = rawBlock.is_error === true;
    tool.output = truncate(formatToolOutput(rawBlock.content), MAX_ITEM_TEXT_CHARS);
    tool.status = isError ? "error" : "success";
    tool.completedAt = createdAt;
    changed = true;
  });

  if (changed && snapshot.busy) {
    snapshot.activityLabel = "Claude 工作中";
  }
  return { changed, eventType: "user", toolNames: [] };
}

function applyResult(
  snapshot: StructuredSessionSnapshot,
  event: Record<string, unknown>
): StructuredProtocolApplyResult {
  applyResultModelUsage(snapshot, event.modelUsage);
  snapshot.streamingText = undefined;
  snapshot.streamingPhase = undefined;
  snapshot.busy = false;
  snapshot.busyStartedAt = undefined;
  snapshot.activityLabel = undefined;
  snapshot.lastCompletedAt = timestampValue(event.timestamp);
  const isError = event.is_error === true;
  if (isError) {
    const errorText = resultErrorText(event);
    snapshot.error = errorText;
    appendUniqueItem(snapshot, {
      id: `result:${stringValue(event.uuid) ?? Date.now()}`,
      kind: "notice",
      text: errorText,
      tone: "error",
      createdAt: timestampValue(event.timestamp)
    });
  } else {
    snapshot.error = undefined;
  }
  return { changed: true, activity: "idle", eventType: "result", toolNames: [] };
}

/** 从 Claude 的运行时模型标识中拆出模型和上下文上限，例如 opus[1m]。 */
function applyRuntimeModel(snapshot: StructuredSessionSnapshot, value: unknown): void {
  const rawModel = stringValue(value);
  if (!rawModel || rawModel === "<synthetic>") {
    return;
  }
  const match = /^(.*)\[(\d+(?:\.\d+)?)([kmg])\]$/iu.exec(rawModel);
  snapshot.model = match?.[1] || rawModel;
  if (!match) {
    return;
  }
  const multiplier = match[3].toLowerCase() === "g"
    ? 1_000_000_000
    : match[3].toLowerCase() === "m"
      ? 1_000_000
      : 1_000;
  const contextWindow = Number(match[2]) * multiplier;
  if (Number.isFinite(contextWindow) && contextWindow > 0) {
    snapshot.contextWindowTokens = Math.round(contextWindow);
  }
}

/** assistant usage 是当前请求的上下文快照，比 result 中跨轮累计的 modelUsage 更适合展示占用量。 */
function applyContextUsage(snapshot: StructuredSessionSnapshot, value: unknown): void {
  if (!isRecord(value)) {
    return;
  }
  const contextUsed = [
    value.input_tokens,
    value.cache_creation_input_tokens,
    value.cache_read_input_tokens,
    value.output_tokens
  ].reduce<number>((total, tokenCount) => total + nonNegativeNumber(tokenCount), 0);
  if (contextUsed > 0) {
    snapshot.contextUsedTokens = Math.round(contextUsed);
  }
}

/** result.modelUsage 提供 Claude 实际采用的上下文窗口，优先匹配当前主模型。 */
function applyResultModelUsage(snapshot: StructuredSessionSnapshot, value: unknown): void {
  if (!isRecord(value)) {
    return;
  }
  const candidates = Object.entries(value).filter((entry): entry is [string, Record<string, unknown>] =>
    isRecord(entry[1]) && nonNegativeNumber(entry[1].contextWindow) > 0
  );
  const selected = candidates.find(([model]) => runtimeModelName(model) === snapshot.model) ?? candidates[0];
  if (!selected) {
    return;
  }
  applyRuntimeModel(snapshot, selected[0]);
  snapshot.contextWindowTokens = Math.round(nonNegativeNumber(selected[1].contextWindow));
}

function runtimeModelName(value: string): string {
  return /^(.*)\[(\d+(?:\.\d+)?)([kmg])\]$/iu.exec(value)?.[1] || value;
}

function nonNegativeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** Claude 版本间命令元数据可能是字符串或对象，这里统一成 renderer 可直接展示的结构。 */
export function normalizeSlashCommands(value: unknown): StructuredSlashCommand[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const commands = new Map<string, StructuredSlashCommand>();
  value.slice(0, 300).forEach((raw) => {
    const rawName = typeof raw === "string"
      ? raw
      : isRecord(raw)
        ? stringValue(raw.name) ?? stringValue(raw.command)
        : undefined;
    if (!rawName) {
      return;
    }
    const name = rawName.startsWith("/") ? rawName : `/${rawName}`;
    if (!/^\/[^\s]{1,120}$/u.test(name)) {
      return;
    }
    const record = isRecord(raw) ? raw : undefined;
    commands.set(name, {
      name,
      description: record ? stringValue(record.description) : undefined,
      argumentHint: record
        ? stringValue(record.argument_hint) ?? stringValue(record.argumentHint)
        : undefined
    });
  });
  return [...commands.values()];
}

function markBusy(snapshot: StructuredSessionSnapshot, label: string, startedAt?: string): void {
  snapshot.busy = true;
  snapshot.busyStartedAt ??= startedAt ?? new Date().toISOString();
  snapshot.activityLabel = label;
}

function findTool(snapshot: StructuredSessionSnapshot, toolUseId: string): StructuredToolCall | undefined {
  for (let index = snapshot.items.length - 1; index >= 0; index -= 1) {
    const item = snapshot.items[index];
    if (item.kind === "tool" && item.tool.id === toolUseId) {
      return item.tool;
    }
  }
  return undefined;
}

function appendUniqueItem(snapshot: StructuredSessionSnapshot, item: StructuredConversationItem): boolean {
  if (snapshot.items.some((existing) => existing.id === item.id)) {
    return false;
  }
  snapshot.items.push(item);
  return true;
}

function formatToolOutput(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (isRecord(item) && item.type === "text" && typeof item.text === "string") {
          return item.text;
        }
        return safeStringify(toStructuredDisplayValue(item));
      })
      .filter(Boolean)
      .join("\n");
  }
  return safeStringify(toStructuredDisplayValue(value));
}

function resultErrorText(event: Record<string, unknown>): string {
  if (Array.isArray(event.errors)) {
    const errors = event.errors.filter((value): value is string => typeof value === "string" && Boolean(value));
    if (errors.length > 0) {
      return truncate(errors.join("\n"), MAX_ITEM_TEXT_CHARS);
    }
  }
  if (typeof event.result === "string" && event.result) {
    return truncate(event.result, MAX_ITEM_TEXT_CHARS);
  }
  return "Claude 本轮处理失败。";
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value ?? "");
  }
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars)}\n…内容已截断…`;
}

function timestampValue(value: unknown): string {
  return typeof value === "string" && value ? value : new Date().toISOString();
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function unchanged(): StructuredProtocolApplyResult {
  return { changed: false, toolNames: [] };
}
