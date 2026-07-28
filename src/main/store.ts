import { app } from "electron";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AppStoreData, ProjectRecord, SessionMode, SessionRecord } from "../shared/types";
import { logError } from "./appLogger";

const STORE_VERSION = 1;

type SessionPatch = Partial<Omit<SessionRecord, "id">>;

/** 保存项目和会话元数据；这里只删除管理记录，不操作用户磁盘目录或 Claude 历史文件。 */
export class AppStore {
  private readonly storePath: string;
  private data: AppStoreData;

  constructor(storePath = join(app.getPath("userData"), "claude-pty-manager.json")) {
    this.storePath = storePath;
    this.data = this.load();
  }

  get path(): string {
    return this.storePath;
  }

  listProjects(): ProjectRecord[] {
    return this.data.projects.map((project) => ({
      ...project,
      missing: !existsSync(project.path)
    }));
  }

  getProject(projectId: string): ProjectRecord | undefined {
    const project = this.data.projects.find((item) => item.id === projectId);
    if (!project) {
      return undefined;
    }

    return {
      ...project,
      missing: !existsSync(project.path)
    };
  }

  addProject(path: string): ProjectRecord {
    const normalizedPath = path.replace(/\/$/, "");
    const now = new Date().toISOString();
    const existing = this.data.projects.find((project) => project.path === normalizedPath);

    if (existing) {
      existing.updatedAt = now;
      existing.lastOpenedAt = now;
      existing.missing = !existsSync(normalizedPath);
      this.save();
      return { ...existing };
    }

    const project: ProjectRecord = {
      id: randomUUID(),
      path: normalizedPath,
      name: normalizedPath.split("/").filter(Boolean).at(-1) ?? normalizedPath,
      createdAt: now,
      updatedAt: now,
      lastOpenedAt: now,
      missing: !existsSync(normalizedPath)
    };

    this.data.projects.push(project);
    this.save();
    return { ...project };
  }

  removeProject(projectId: string): void {
    this.data.projects = this.data.projects.filter((project) => project.id !== projectId);
    this.data.sessions = this.data.sessions.filter((session) => session.projectId !== projectId);
    this.save();
  }

  removeSession(sessionId: string): void {
    this.data.sessions = this.data.sessions.filter((session) => session.id !== sessionId);
    this.save();
  }

  touchProject(projectId: string): void {
    const project = this.data.projects.find((item) => item.id === projectId);
    if (!project) {
      return;
    }

    const now = new Date().toISOString();
    project.lastOpenedAt = now;
    project.updatedAt = now;
    project.missing = !existsSync(project.path);
    this.save();
  }

  listSessions(projectId?: string): SessionRecord[] {
    return this.data.sessions
      .filter((session) => !projectId || session.projectId === projectId)
      .map((session) => ({ ...session }))
      .sort((a, b) => (b.lastActiveAt ?? b.createdAt).localeCompare(a.lastActiveAt ?? a.createdAt));
  }

  getSession(sessionId: string): SessionRecord | undefined {
    const session = this.data.sessions.find((item) => item.id === sessionId);
    return session ? { ...session } : undefined;
  }

  getSessionByClaudeSessionId(claudeSessionId: string): SessionRecord | undefined {
    const session = this.data.sessions.find((item) => item.claudeSessionId === claudeSessionId);
    return session ? { ...session } : undefined;
  }

  createSession(projectId: string, title: string, mode: SessionMode = "terminal"): SessionRecord {
    const now = new Date().toISOString();
    const session: SessionRecord = {
      id: randomUUID(),
      projectId,
      claudeSessionId: randomUUID(),
      title,
      titleSource: "fallback",
      titleUpdatedAt: now,
      mode,
      status: "creating",
      managedByApp: true,
      createdAt: now,
      updatedAt: now,
      lastActiveAt: now
    };

    this.data.sessions.push(session);
    this.save();
    return { ...session };
  }

  createImportedSession(
    projectId: string,
    claudeSessionId: string,
    title: string,
    transcriptPath: string
  ): SessionRecord {
    if (this.data.sessions.some((session) => session.claudeSessionId === claudeSessionId)) {
      throw new Error("该 Claude CLI 会话已导入。");
    }

    const now = new Date().toISOString();
    const session: SessionRecord = {
      id: randomUUID(),
      projectId,
      claudeSessionId,
      title,
      titleSource: "fallback",
      titleUpdatedAt: now,
      mode: "terminal",
      status: "creating",
      managedByApp: false,
      createdAt: now,
      updatedAt: now,
      lastActiveAt: now,
      transcriptPath
    };

    this.data.sessions.push(session);
    try {
      this.save();
    } catch (error) {
      this.data.sessions = this.data.sessions.filter((item) => item.id !== session.id);
      throw error;
    }
    return { ...session };
  }

  updateSession(sessionId: string, patch: SessionPatch): SessionRecord {
    const session = this.data.sessions.find((item) => item.id === sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    Object.assign(session, patch, { updatedAt: new Date().toISOString() });
    this.save();
    return { ...session };
  }

  updateSessionActivities(activities: ReadonlyMap<string, string>): void {
    if (activities.size === 0) {
      return;
    }

    const updatedAt = new Date().toISOString();
    let changed = false;

    for (const [sessionId, lastActiveAt] of activities) {
      const session = this.data.sessions.find((item) => item.id === sessionId);
      if (!session || session.lastActiveAt === lastActiveAt) {
        continue;
      }

      session.lastActiveAt = lastActiveAt;
      session.updatedAt = updatedAt;
      changed = true;
    }

    if (changed) {
      this.save();
    }
  }

  renameSession(sessionId: string, title: string): SessionRecord {
    const normalizedTitle = title.replace(/\s+/g, " ").trim();
    if (!normalizedTitle) {
      throw new Error("会话名称不能为空。");
    }

    return this.updateSession(sessionId, {
      title: normalizedTitle,
      titleSource: "manual",
      titleUpdatedAt: new Date().toISOString()
    });
  }

  private load(): AppStoreData {
    if (!existsSync(this.storePath)) {
      return {
        version: STORE_VERSION,
        projects: [],
        sessions: []
      };
    }

    try {
      const raw = readFileSync(this.storePath, "utf8");
      const parsed = JSON.parse(raw) as AppStoreData;

      return {
        version: STORE_VERSION,
        projects: Array.isArray(parsed.projects) ? parsed.projects : [],
        sessions: Array.isArray(parsed.sessions) ? normalizePersistedSessions(parsed.sessions) : []
      };
    } catch (error) {
      const backupPath = `${this.storePath}.broken-${Date.now()}`;
      renameSync(this.storePath, backupPath);
      logError("store", "load-failed", error, { storePath: this.storePath, backupPath });
      return {
        version: STORE_VERSION,
        projects: [],
        sessions: []
      };
    }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.storePath), { recursive: true });
      // 先完整写入临时文件再原子替换，避免进程中断留下半截 JSON。
      const tempPath = `${this.storePath}.tmp`;
      writeFileSync(tempPath, `${JSON.stringify(this.data, null, 2)}\n`, "utf8");
      renameSync(tempPath, this.storePath);
    } catch (error) {
      logError("store", "save-failed", error, { storePath: this.storePath });
      throw error;
    }
  }
}

function normalizePersistedSessions(sessions: SessionRecord[]): SessionRecord[] {
  const now = new Date().toISOString();

  // PTY 进程不会跨应用重启存活，启动时把遗留的中间状态统一收敛为已退出。
  return sessions.map((session) => {
    const withMode: SessionRecord = {
      ...session,
      mode: session.mode === "structured" ? "structured" : "terminal"
    };
    if (withMode.status !== "running" && withMode.status !== "creating" && withMode.status !== "stopping") {
      return withMode;
    }

    const normalized: SessionRecord = {
      ...withMode,
      status: "exited",
      updatedAt: now,
      exitedAt: withMode.exitedAt ?? now
    };

    return normalized;
  });
}
