import { BrowserWindow } from "electron";
import { access, open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { SessionRecord } from "../shared/types";
import type { AppStore } from "./store";
import { logError, logInfo } from "./appLogger";
import { getClaudeTranscriptPath } from "./claudeHistory";

const SCAN_INTERVAL_MS = 2500;
const MAX_TRANSCRIPT_BYTES = 1_000_000;
const MAX_TRANSCRIPT_LINES = 1500;
const MAX_TITLE_CHARS = 28;
const FALLBACK_SCAN_INTERVAL_MS = 30_000;

const GENERIC_PROMPTS = new Set([
  "hi",
  "hello",
  "hey",
  "你好",
  "您好",
  "在吗",
  "继续",
  "继续吧",
  "开始",
  "ok",
  "好的",
  "嗯",
  "嗯嗯",
  "continue",
  "continue from where you left off."
]);

/** 从 Claude JSONL 中提取首个有效用户意图，异步更新未手工命名的会话标题。 */
export class SessionTitleService {
  private timer: NodeJS.Timeout | null = null;
  private scanning = false;
  private readonly fallbackScanAfter = new Map<string, number>();
  private projectDirectoryCache: { paths: string[]; expiresAt: number } | undefined;

  constructor(
    private readonly store: AppStore,
    private readonly getMainWindow: () => BrowserWindow | null
  ) {}

  start(): void {
    if (this.timer) {
      return;
    }

    this.scan();
    this.timer = setInterval(() => this.scan(), SCAN_INTERVAL_MS);
  }

  stop(): void {
    if (!this.timer) {
      return;
    }

    clearInterval(this.timer);
    this.timer = null;
  }

  scan(): void {
    if (this.scanning) {
      return;
    }

    this.scanning = true;
    void this.scanSessions()
      .catch(() => undefined)
      .finally(() => {
        this.scanning = false;
      });
  }

  private async scanSessions(): Promise<void> {
    const sessions = this.store.listSessions().filter(shouldAutoTitle);
    const activeSessionIds = new Set(sessions.map((session) => session.id));

    for (const sessionId of this.fallbackScanAfter.keys()) {
      if (!activeSessionIds.has(sessionId)) {
        this.fallbackScanAfter.delete(sessionId);
      }
    }

    for (const session of sessions) {
      try {
        await this.tryUpdateTitle(session);
      } catch (error) {
        logError("session-title", "update-failed", error, { sessionId: session.id });
        // 标题生成失败不应阻塞其他会话或 Electron 主进程。
      }
    }
  }

  private async tryUpdateTitle(session: SessionRecord): Promise<void> {
    const transcriptPath = await this.findTranscriptPath(session);
    if (!transcriptPath) {
      return;
    }

    const title = await extractTitleFromTranscript(transcriptPath);
    if (!title || title === session.title) {
      if (session.transcriptPath !== transcriptPath) {
        this.store.updateSession(session.id, { transcriptPath });
      }
      return;
    }

    const updated = this.store.updateSession(session.id, {
      title,
      titleSource: "auto",
      titleUpdatedAt: new Date().toISOString(),
      transcriptPath
    });

    logInfo("session-title", "auto-updated", {
      sessionId: updated.id,
      transcriptPath
    });
    this.getMainWindow()?.webContents.send("session:updated", updated);
  }

  private async findTranscriptPath(session: SessionRecord): Promise<string | undefined> {
    if (session.transcriptPath && (await pathExists(session.transcriptPath))) {
      return session.transcriptPath;
    }

    const project = this.store.getProject(session.projectId);
    const projectRoot = join(homedir(), ".claude", "projects");
    const fileName = `${session.claudeSessionId}.jsonl`;

    if (project) {
      const candidate = getClaudeTranscriptPath(project.path, session.claudeSessionId);
      if (await pathExists(candidate)) {
        return candidate;
      }
    }

    // 标准目录未命中时才做全局兜底扫描，并限频以免轮询持续遍历磁盘。
    const now = Date.now();
    if ((this.fallbackScanAfter.get(session.id) ?? 0) > now) {
      return undefined;
    }
    this.fallbackScanAfter.set(session.id, now + FALLBACK_SCAN_INTERVAL_MS);

    for (const projectDirectory of await this.getProjectDirectories(projectRoot)) {
      const candidate = join(projectDirectory, fileName);
      if (await pathExists(candidate)) {
        this.fallbackScanAfter.delete(session.id);
        return candidate;
      }
    }

    return undefined;
  }

  private async getProjectDirectories(projectRoot: string): Promise<string[]> {
    const now = Date.now();
    if (this.projectDirectoryCache && this.projectDirectoryCache.expiresAt > now) {
      return this.projectDirectoryCache.paths;
    }

    let paths: string[] = [];
    try {
      const entries = await readdir(projectRoot, { withFileTypes: true });
      paths = entries.filter((entry) => entry.isDirectory()).map((entry) => join(projectRoot, entry.name));
    } catch {
      paths = [];
    }

    this.projectDirectoryCache = {
      paths,
      expiresAt: now + FALLBACK_SCAN_INTERVAL_MS
    };
    return paths;
  }
}

function shouldAutoTitle(session: SessionRecord): boolean {
  return session.titleSource !== "manual" && session.titleSource !== "auto";
}

async function extractTitleFromTranscript(transcriptPath: string): Promise<string | undefined> {
  // 只读文件开头且限制行数，标题生成不会随长会话无限增加磁盘和解析开销。
  let raw = "";

  try {
    const size = (await stat(transcriptPath)).size;
    raw = await readFileStart(transcriptPath, Math.min(size, MAX_TRANSCRIPT_BYTES));
  } catch {
    return undefined;
  }

  let lineCount = 0;

  for (const line of raw.split("\n")) {
    if (!line.trim()) {
      continue;
    }

    lineCount += 1;
    if (lineCount > MAX_TRANSCRIPT_LINES) {
      return undefined;
    }

    const text = extractUserText(line);
    const title = buildTitle(text);
    if (title) {
      return title;
    }
  }

  return undefined;
}

async function readFileStart(filePath: string, maxBytes: number): Promise<string> {
  const fileHandle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await fileHandle.read(buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await fileHandle.close();
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function extractUserText(line: string): string | undefined {
  let parsed: unknown;

  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }

  if (!isRecord(parsed)) {
    return undefined;
  }

  if (parsed.type !== "user" || parsed.isMeta === true) {
    return undefined;
  }

  const message = parsed.message;
  if (!isRecord(message) || message.role !== "user") {
    return undefined;
  }

  const content = message.content;
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return undefined;
  }

  return content
    .map((part) => {
      if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string") {
        return "";
      }

      return part.text;
    })
    .filter(Boolean)
    .join("\n");
}

function buildTitle(text: string | undefined): string | undefined {
  const cleaned = cleanPrompt(text);
  if (!cleaned || isGenericPrompt(cleaned)) {
    return undefined;
  }

  return truncate(cleaned, MAX_TITLE_CHARS);
}

function cleanPrompt(text: string | undefined): string {
  return (text ?? "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/<image[\s\S]*?>/g, " ")
    .replace(/!\[[^\]]*]\([^)]*\)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isGenericPrompt(text: string): boolean {
  const normalized = text.toLowerCase();
  if (GENERIC_PROMPTS.has(normalized)) {
    return true;
  }

  const characters = Array.from(text);
  const asciiCount = characters.filter((char) => /^[\x00-\x7F]$/.test(char)).length;
  const nonAsciiCount = characters.length - asciiCount;

  return nonAsciiCount < 2 && asciiCount < 8;
}

function truncate(text: string, maxChars: number): string {
  const chars = Array.from(text);
  if (chars.length <= maxChars) {
    return text;
  }

  return `${chars.slice(0, maxChars).join("")}...`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
