import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { dirname } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogData = Record<string, unknown>;

const MAX_LOG_BYTES = 5 * 1024 * 1024;
const HISTORY_FILE_COUNT = 3;
const MAX_STRING_CHARS = 12_000;
const MAX_COLLECTION_ITEMS = 50;
const MAX_DATA_DEPTH = 5;
const SENSITIVE_KEY_REGEX = /authorization|cookie|password|secret|token|api[-_]?key/iu;

let activeLogger: AppLogger | undefined;

/** 持久化 JSONL 诊断日志，负责轮转、数据裁剪和敏感字段脱敏。 */
export class AppLogger {
  private currentSize = 0;

  constructor(private readonly logPath: string) {
    this.initialize();
  }

  get path(): string {
    return this.logPath;
  }

  debug(scope: string, event: string, data?: LogData): void {
    this.write("debug", scope, event, data);
  }

  info(scope: string, event: string, data?: LogData): void {
    this.write("info", scope, event, data);
  }

  warn(scope: string, event: string, data?: LogData): void {
    this.write("warn", scope, event, data);
  }

  error(scope: string, event: string, error?: unknown, data?: LogData): void {
    this.write("error", scope, event, {
      ...(data ?? {}),
      ...(error === undefined ? {} : { error })
    });
  }

  clear(): boolean {
    try {
      rmSync(this.logPath, { force: true });
      for (let index = 1; index <= HISTORY_FILE_COUNT; index += 1) {
        rmSync(`${this.logPath}.${index}`, { force: true });
      }
      writeFileSync(this.logPath, "", "utf8");
      this.currentSize = 0;
      return true;
    } catch {
      // 日志维护失败不能影响应用主流程。
      return false;
    }
  }

  private initialize(): void {
    try {
      mkdirSync(dirname(this.logPath), { recursive: true });
      this.currentSize = existsSync(this.logPath) ? statSync(this.logPath).size : 0;
      this.rotateIfNeeded(0);
      appendFileSync(this.logPath, "", "utf8");
    } catch {
      this.currentSize = 0;
    }
  }

  private write(level: LogLevel, scope: string, event: string, data?: LogData): void {
    try {
      const entry = {
        time: new Date().toISOString(),
        level,
        scope,
        event,
        pid: process.pid,
        ...(data ? { data: normalizeValue(data, 0, new WeakSet<object>()) } : {})
      };
      const line = `${JSON.stringify(entry)}\n`;
      const lineBytes = Buffer.byteLength(line, "utf8");
      this.rotateIfNeeded(lineBytes);
      appendFileSync(this.logPath, line, "utf8");
      this.currentSize += lineBytes;
    } catch {
      // 日志写入必须保持旁路，禁止反向破坏业务功能。
    }
  }

  private rotateIfNeeded(nextBytes: number): void {
    if (this.currentSize + nextBytes <= MAX_LOG_BYTES) {
      return;
    }

    for (let index = HISTORY_FILE_COUNT; index >= 1; index -= 1) {
      const source = index === 1 ? this.logPath : `${this.logPath}.${index - 1}`;
      const target = `${this.logPath}.${index}`;
      rmSync(target, { force: true });
      if (existsSync(source)) {
        renameSync(source, target);
      }
    }

    writeFileSync(this.logPath, "", "utf8");
    this.currentSize = 0;
  }
}

export function initializeAppLogger(logPath: string): AppLogger {
  activeLogger = new AppLogger(logPath);
  return activeLogger;
}

export function getAppLogger(): AppLogger | undefined {
  return activeLogger;
}

export function logDebug(scope: string, event: string, data?: LogData): void {
  activeLogger?.debug(scope, event, data);
}

export function logInfo(scope: string, event: string, data?: LogData): void {
  activeLogger?.info(scope, event, data);
}

export function logWarn(scope: string, event: string, data?: LogData): void {
  activeLogger?.warn(scope, event, data);
}

export function logError(scope: string, event: string, error?: unknown, data?: LogData): void {
  activeLogger?.error(scope, event, error, data);
}

function normalizeValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  // 统一限制深度、长度和敏感字段，防止诊断日志意外扩大或泄露凭据。
  if (value === null || value === undefined || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    return truncate(value);
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: truncate(value.message),
      stack: value.stack ? truncate(value.stack) : undefined
    };
  }
  if (typeof value !== "object") {
    return String(value);
  }
  if (depth >= MAX_DATA_DEPTH) {
    return "[depth-limit]";
  }
  if (seen.has(value)) {
    return "[circular]";
  }

  seen.add(value);
  if (Array.isArray(value)) {
    const normalized = value
      .slice(0, MAX_COLLECTION_ITEMS)
      .map((item) => normalizeValue(item, depth + 1, seen));
    seen.delete(value);
    return normalized;
  }

  const normalized: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).slice(0, MAX_COLLECTION_ITEMS)) {
    normalized[key] = SENSITIVE_KEY_REGEX.test(key) ? "[redacted]" : normalizeValue(item, depth + 1, seen);
  }
  seen.delete(value);
  return normalized;
}

function truncate(value: string): string {
  if (value.length <= MAX_STRING_CHARS) {
    return value;
  }
  return `${value.slice(0, MAX_STRING_CHARS)}...[truncated]`;
}
