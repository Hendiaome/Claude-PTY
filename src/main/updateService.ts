import { app, BrowserWindow, shell } from "electron";
import * as http from "node:http";
import * as https from "node:https";
import type { IncomingMessage } from "node:http";
import type { UpdateCheckResult, UpdateInfo } from "../shared/types";
import type { SettingsStore } from "./settingsStore";
import { logError, logInfo, logWarn } from "./appLogger";

const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
const MAX_RESPONSE_BYTES = 1024 * 1024;

type UpdateFeedRecord = Record<string, unknown>;

/** 定时读取更新源，只提示比当前应用更高的版本，并避免同一版本重复通知。 */
export class UpdateService {
  private timer: NodeJS.Timeout | undefined;
  private lastNotifiedVersion: string | undefined;
  private latestUpdate: UpdateInfo | undefined;

  constructor(
    private readonly settingsStore: SettingsStore,
    private readonly getMainWindow: () => BrowserWindow | null
  ) {}

  start(): void {
    this.stop();
    this.latestUpdate = undefined;
    this.lastNotifiedVersion = undefined;

    const settings = this.settingsStore.getSettings();
    if (!settings.checkUpdatesAutomatically || !settings.updateFeedUrl) {
      return;
    }

    void this.checkAndNotify();
    this.timer = setInterval(() => {
      void this.checkAndNotify();
    }, UPDATE_CHECK_INTERVAL_MS);
    this.timer.unref?.();
  }

  restart(): void {
    this.start();
  }

  stop(): void {
    if (!this.timer) {
      return;
    }

    clearInterval(this.timer);
    this.timer = undefined;
  }

  async checkForUpdates(): Promise<UpdateCheckResult> {
    const checkedAt = new Date().toISOString();
    const settings = this.settingsStore.getSettings();
    if (!settings.updateFeedUrl) {
      return {
        ok: true,
        checkedAt
      };
    }

    try {
      const raw = await fetchText(settings.updateFeedUrl);
      const update = parseUpdateInfo(raw, checkedAt);
      if (compareVersions(update.version, app.getVersion()) <= 0) {
        logInfo("update", "up-to-date", { currentVersion: app.getVersion(), feedVersion: update.version });
        return {
          ok: true,
          checkedAt
        };
      }

      logInfo("update", "available", { currentVersion: app.getVersion(), version: update.version });
      return {
        ok: true,
        update,
        checkedAt
      };
    } catch (error) {
      logError("update", "check-failed", error);
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        checkedAt
      };
    }
  }

  async openDownload(url: string): Promise<void> {
    const parsedUrl = new URL(url);
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      throw new Error("下载地址仅支持 HTTP 或 HTTPS。");
    }

    logInfo("update", "download-open-requested", {
      protocol: parsedUrl.protocol,
      host: parsedUrl.host,
      pathname: parsedUrl.pathname
    });
    try {
      await shell.openExternal(url);
      logInfo("update", "download-opened", { host: parsedUrl.host, pathname: parsedUrl.pathname });
    } catch (error) {
      logError("update", "download-open-failed", error, { host: parsedUrl.host, pathname: parsedUrl.pathname });
      throw error;
    }
  }

  getAvailableUpdate(): UpdateInfo | undefined {
    return this.latestUpdate ? { ...this.latestUpdate } : undefined;
  }

  private async checkAndNotify(): Promise<void> {
    const result = await this.checkForUpdates();
    if (!result.ok) {
      logWarn("update", "automatic-check-failed", { error: result.error });
    }
    if (!result.update) {
      this.latestUpdate = undefined;
      return;
    }

    this.latestUpdate = result.update;
    if (this.lastNotifiedVersion === result.update.version) {
      return;
    }

    this.lastNotifiedVersion = result.update.version;
    this.getMainWindow()?.webContents.send("update:available", result.update);
  }
}

/** 解析项目维护的 JSON 更新清单，并兼容历史字段名称。 */
function parseUpdateInfo(raw: string, checkedAt: string): UpdateInfo {
  const parsed = JSON.parse(raw.trim()) as UpdateFeedRecord;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("更新接口返回内容不是 JSON 对象。");
  }

  const version = pickString(parsed, ["version", "latestVersion", "latest", "tagName", "tag"]);
  const dmgUrl = pickString(parsed, ["dmgUrl", "downloadUrl", "url", "macDmgUrl", "macArm64DmgUrl"]);
  const releaseNotes = pickString(parsed, ["releaseNotes", "notes", "changelog", "description"]);

  if (!version) {
    throw new Error("更新接口缺少 version 字段。");
  }

  if (!dmgUrl) {
    throw new Error("更新接口缺少 dmgUrl/downloadUrl/url 字段。");
  }

  return {
    version,
    dmgUrl,
    releaseNotes,
    mandatory: typeof parsed.mandatory === "boolean" ? parsed.mandatory : undefined,
    checkedAt
  };
}

function pickString(record: UpdateFeedRecord, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return undefined;
}

function compareVersions(left: string, right: string): number {
  const leftParts = normalizeVersion(left);
  const rightParts = normalizeVersion(right);
  const maxLength = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < maxLength; index += 1) {
    const leftPart = leftParts[index] ?? 0;
    const rightPart = rightParts[index] ?? 0;
    if (leftPart !== rightPart) {
      return leftPart > rightPart ? 1 : -1;
    }
  }

  return 0;
}

function normalizeVersion(version: string): number[] {
  const cleaned = version.trim().replace(/^v/iu, "");
  const matches = cleaned.match(/\d+/gu);
  return matches ? matches.map((item) => Number(item)) : [0];
}

/** 限制协议、重定向次数、超时和响应大小，避免更新检查成为无界网络入口。 */
function fetchText(url: string, redirectCount = 0): Promise<string> {
  if (redirectCount > 3) {
    return Promise.reject(new Error("更新接口重定向次数过多。"));
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return Promise.reject(new Error("更新地址不是有效 URL。"));
  }

  const client = parsedUrl.protocol === "http:" ? http : parsedUrl.protocol === "https:" ? https : undefined;
  if (!client) {
    return Promise.reject(new Error("更新地址仅支持 HTTP 或 HTTPS。"));
  }

  return new Promise((resolve, reject) => {
    const request = client.get(
      parsedUrl,
      {
        headers: {
          Accept: "application/json, text/plain, */*",
          "User-Agent": `Claude PTY Manager/${app.getVersion()}`
        },
        timeout: 12_000
      },
      (response) => {
        const location = response.headers.location;
        if (isRedirect(response) && location) {
          response.resume();
          fetchText(new URL(location, parsedUrl).toString(), redirectCount + 1).then(resolve).catch(reject);
          return;
        }

        if (!response.statusCode || response.statusCode >= 400) {
          response.resume();
          reject(new Error(`更新接口请求失败：HTTP ${response.statusCode ?? "unknown"}`));
          return;
        }

        collectResponse(response).then(resolve).catch(reject);
      }
    );

    request.on("timeout", () => {
      request.destroy(new Error("更新接口请求超时。"));
    });
    request.on("error", reject);
  });
}

function isRedirect(response: IncomingMessage): boolean {
  return Boolean(response.statusCode && response.statusCode >= 300 && response.statusCode < 400);
}

function collectResponse(response: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    response.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_RESPONSE_BYTES) {
        reject(new Error("更新接口返回内容过大。"));
        response.destroy();
        return;
      }

      chunks.push(chunk);
    });
    response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    response.on("error", reject);
  });
}
