import { shell } from "electron";
import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { TerminalPathOpenRequest } from "../shared/types";
import { getLoginEnv, getShellPath } from "./environment";
import type { SettingsStore } from "./settingsStore";
import { logError, logInfo, logWarn } from "./appLogger";

const MAX_PATH_CHARS = 8_192;
const IDEA_APP_NAME = "IntelliJ IDEA";
const IDEA_CLI_CONFIRM_DELAY_MS = 1_500;
let cachedIdeaCli: string | undefined;

/** 校验终端传来的路径请求，并按用户设置交给 IDEA 或系统打开。 */
export class FileOpenService {
  constructor(private readonly settingsStore: SettingsStore) {}

  async open(rawRequest: unknown): Promise<void> {
    const mode = this.settingsStore.getSettings().fileOpenMode;
    const requestedPath = extractRequestedPath(rawRequest);

    try {
      const request = normalizeRequest(rawRequest);
      const filePath = resolvePath(request.path);
      logInfo("file-open", "request", {
        requestedPath: request.path,
        resolvedPath: filePath,
        line: request.line,
        column: request.column,
        mode
      });

      try {
        await stat(filePath);
      } catch {
        throw new Error(`路径不存在：${filePath}`);
      }

      if (mode === "system") {
        await openWithSystem(filePath);
        logInfo("file-open", "system-opened", { path: filePath });
        return;
      }

      await openWithIdea(filePath, request.line);
      logInfo("file-open", "idea-opened", { path: filePath, line: request.line });
    } catch (error) {
      logError("file-open", "failed", error, { requestedPath, mode });
      throw error;
    }
  }
}

function extractRequestedPath(rawRequest: unknown): string | undefined {
  if (!rawRequest || typeof rawRequest !== "object") {
    return undefined;
  }
  const path = (rawRequest as Record<string, unknown>).path;
  return typeof path === "string" ? path : undefined;
}

function normalizeRequest(rawRequest: unknown): TerminalPathOpenRequest {
  if (!rawRequest || typeof rawRequest !== "object") {
    throw new Error("打开路径参数无效。");
  }

  const record = rawRequest as Record<string, unknown>;
  if (typeof record.path !== "string" || !record.path || record.path.length > MAX_PATH_CHARS) {
    throw new Error("打开路径参数无效。");
  }
  if (!hasRequiredPathDepth(record.path)) {
    throw new Error("仅支持 ~/ 或 / 开头的完整路径。");
  }

  return {
    path: record.path,
    line: normalizePositiveInteger(record.line, "行号"),
    column: normalizePositiveInteger(record.column, "列号")
  };
}

function normalizePositiveInteger(value: unknown, label: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label}无效。`);
  }
  return value;
}

function resolvePath(filePath: string): string {
  if (filePath.startsWith("~/")) {
    return resolve(homedir(), filePath.slice(2));
  }
  return resolve(filePath);
}

function hasRequiredPathDepth(filePath: string): boolean {
  if (filePath.startsWith("~/")) {
    return filePath.slice(2).includes("/");
  }
  return filePath.startsWith("/") && !filePath.startsWith("//") && filePath.slice(1).includes("/");
}

async function openWithSystem(filePath: string): Promise<void> {
  const error = await shell.openPath(filePath);
  if (error) {
    throw new Error(`系统打开失败：${error}`);
  }
}

async function openWithIdea(filePath: string, line: number | undefined): Promise<void> {
  if (!line) {
    // 不带行号时交给 macOS 启动已安装的 IDEA，避免直接执行 App Bundle 内部二进制。
    const args = ["-a", IDEA_APP_NAME, filePath];
    logInfo("file-open", "idea-open-command", { command: "open", args });
    await spawnAndWaitForExit("open", args);
    return;
  }

  // 跳转行号优先使用真正的 IDEA CLI；找不到时再回退到 idea:// 协议。
  const ideaCli = await resolveIdeaCli();
  if (ideaCli) {
    const args = ["--line", String(line), filePath];
    logInfo("file-open", "idea-cli-command", { command: ideaCli, args });
    await spawnWithConfirmation(ideaCli, args, IDEA_CLI_CONFIRM_DELAY_MS);
    return;
  }

  const ideaUrl = new URL("idea://open");
  ideaUrl.searchParams.set("file", filePath);
  ideaUrl.searchParams.set("line", String(line));
  logInfo("file-open", "idea-url-open", { url: ideaUrl.toString() });
  await shell.openExternal(ideaUrl.toString());
}

async function resolveIdeaCli(): Promise<string | undefined> {
  if (cachedIdeaCli && (await isExecutable(cachedIdeaCli))) {
    logInfo("file-open", "idea-cli-resolved-from-cache", { executable: cachedIdeaCli });
    return cachedIdeaCli;
  }

  const pathCommand = await resolveIdeaFromPath();
  if (pathCommand && (await isAppBundleExecutable(pathCommand))) {
    logWarn("file-open", "idea-app-binary-ignored", { executable: pathCommand });
    return undefined;
  }
  if (pathCommand && (await isExecutable(pathCommand))) {
    cachedIdeaCli = pathCommand;
    logInfo("file-open", "idea-cli-resolved-from-path", { executable: pathCommand });
    return pathCommand;
  }
  if (pathCommand) {
    logWarn("file-open", "idea-cli-not-executable", { executable: pathCommand });
  } else {
    logInfo("file-open", "idea-cli-not-found-in-path");
  }

  return undefined;
}

async function isAppBundleExecutable(filePath: string): Promise<boolean> {
  if (filePath.includes(".app/Contents/MacOS/")) {
    return true;
  }

  try {
    return (await realpath(filePath)).includes(".app/Contents/MacOS/");
  } catch {
    return false;
  }
}

function resolveIdeaFromPath(): Promise<string | undefined> {
  return new Promise((resolveCommand) => {
    execFile(
      getShellPath(),
      ["-lc", "source ~/.zshrc >/dev/null 2>&1; command -v idea"],
      {
        encoding: "utf8",
        env: getLoginEnv(),
        timeout: 5_000
      },
      (error, stdout) => {
        if (error) {
          resolveCommand(undefined);
          return;
        }

        const commandPath = stdout.trim();
        resolveCommand(commandPath || undefined);
      }
    );
  });
}

async function isExecutable(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function spawnAndWaitForExit(command: string, args: string[]): Promise<void> {
  return new Promise((resolveSpawn, rejectSpawn) => {
    const child = spawn(command, args, {
      stdio: "ignore",
      env: getLoginEnv()
    });

    child.once("error", (error) => {
      logError("file-open", "idea-process-error", error, { command, args });
      rejectSpawn(error);
    });
    child.once("spawn", () => {
      logInfo("file-open", "idea-process-started", { command, args, pid: child.pid });
    });
    child.once("exit", (code, signal) => {
      const data = { command, args, pid: child.pid, code, signal };
      if (code === 0 && signal === null) {
        logInfo("file-open", "idea-process-exited", data);
        resolveSpawn();
      } else {
        logWarn("file-open", "idea-process-exited", data);
        rejectSpawn(new Error(`IDEA 打开命令执行失败：exitCode=${code ?? "null"}, signal=${signal ?? "null"}`));
      }
    });
  });
}

function spawnWithConfirmation(command: string, args: string[], confirmDelayMs: number): Promise<void> {
  return new Promise((resolveSpawn, rejectSpawn) => {
    let settled = false;
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
      env: getLoginEnv()
    });

    const confirmTimer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.unref();
      logInfo("file-open", "idea-cli-confirmed-running", { command, args, pid: child.pid, confirmDelayMs });
      resolveSpawn();
    }, confirmDelayMs);
    confirmTimer.unref?.();

    child.once("error", (error) => {
      clearTimeout(confirmTimer);
      logError("file-open", "idea-cli-error", error, { command, args });
      if (!settled) {
        settled = true;
        rejectSpawn(error);
      }
    });
    child.once("spawn", () => {
      logInfo("file-open", "idea-cli-started", { command, args, pid: child.pid });
    });
    child.once("exit", (code, signal) => {
      clearTimeout(confirmTimer);
      const data = { command, args, pid: child.pid, code, signal };
      if (settled) {
        if (code === 0 && signal === null) {
          logInfo("file-open", "idea-cli-exited", data);
        } else {
          logWarn("file-open", "idea-cli-exited", data);
        }
        return;
      }

      settled = true;
      if (code === 0 && signal === null) {
        logInfo("file-open", "idea-cli-exited", data);
        resolveSpawn();
      } else {
        logWarn("file-open", "idea-cli-exited", data);
        rejectSpawn(new Error(`IDEA CLI 执行失败：exitCode=${code ?? "null"}, signal=${signal ?? "null"}`));
      }
    });
  });
}
