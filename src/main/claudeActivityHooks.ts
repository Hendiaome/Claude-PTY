import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { join } from "node:path";
import type { SessionActivityStatus } from "../shared/types";
import { logError, logInfo, logWarn } from "./appLogger";

const MAX_REQUEST_BODY_CHARS = 4_096;
const SESSION_ID_REGEX = /^[A-Za-z0-9_-]{1,128}$/u;
const HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PermissionRequest",
  "Notification",
  "Stop",
  "SessionEnd"
] as const;

type HookEventName = (typeof HOOK_EVENTS)[number];

export type ClaudeActivitySignal = {
  sessionId: string;
  state: SessionActivityStatus;
  source: string;
};

/**
 * 为应用托管的 Claude 会话提供临时 Hook 插件和本地事件入口。
 * Hook 只上报状态元数据，完整 Prompt、工具参数和权限内容不会离开 Hook 进程。
 */
export class ClaudeActivityHooks {
  private readonly token = randomBytes(24).toString("hex");
  private server: Server | undefined;
  private endpoint: string | undefined;

  constructor(
    readonly pluginDir: string,
    private readonly onSignal: (signal: ClaudeActivitySignal) => void
  ) {}

  async start(): Promise<void> {
    if (this.server) {
      return;
    }

    const server = createServer((request, response) => this.handleRequest(request, response));
    await listenOnLoopback(server);
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("Claude 会话状态服务未获得本地端口。");
    }

    this.server = server;
    this.endpoint = `http://127.0.0.1:${address.port}/activity`;
    server.on("error", (error) => logError("session-activity-hook", "server-error", error));
    this.writePluginFiles();
    logInfo("session-activity-hook", "started", {
      pluginDir: this.pluginDir,
      port: address.port
    });
  }

  environmentFor(sessionId: string): NodeJS.ProcessEnv {
    if (!this.endpoint) {
      return {};
    }

    return {
      CLAUDE_PTY_APP_SESSION_ID: sessionId,
      CLAUDE_PTY_ACTIVITY_ENDPOINT: this.endpoint,
      CLAUDE_PTY_ACTIVITY_TOKEN: this.token
    };
  }

  stop(): void {
    if (!this.server) {
      return;
    }
    this.server.close();
    this.server = undefined;
    this.endpoint = undefined;
    logInfo("session-activity-hook", "stopped");
  }

  private writePluginFiles(): void {
    const manifestDir = join(this.pluginDir, ".claude-plugin");
    const hooksDir = join(this.pluginDir, "hooks");
    const scriptsDir = join(this.pluginDir, "scripts");
    const reporterPath = join(scriptsDir, "report-state.cjs");
    mkdirSync(manifestDir, { recursive: true });
    mkdirSync(hooksDir, { recursive: true });
    mkdirSync(scriptsDir, { recursive: true });

    writeFileSync(
      join(manifestDir, "plugin.json"),
      `${JSON.stringify({
        name: "claude-pty-session-activity",
        version: "1.0.0",
        description: "Reports Claude session activity metadata to Claude PTY Manager."
      }, null, 2)}\n`,
      "utf8"
    );
    writeFileSync(reporterPath, REPORTER_SOURCE, "utf8");

    const command = `/usr/bin/env node ${shellQuote(reporterPath)}`;
    const hooks = Object.fromEntries(HOOK_EVENTS.map((event) => [
      event,
      [{
        ...(event === "PreToolUse" ? { matcher: "AskUserQuestion" } : {}),
        hooks: [{ type: "command", command, timeout: 2 }]
      }]
    ]));
    writeFileSync(
      join(hooksDir, "hooks.json"),
      `${JSON.stringify({ description: "Claude PTY session activity hooks", hooks }, null, 2)}\n`,
      "utf8"
    );
  }

  private handleRequest(request: IncomingMessage, response: ServerResponse): void {
    if (request.method !== "POST" || request.url !== "/activity") {
      reply(response, 404);
      return;
    }
    if (!safeEqual(request.headers.authorization, `Bearer ${this.token}`)) {
      logWarn("session-activity-hook", "unauthorized-request");
      reply(response, 401);
      return;
    }

    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
      if (body.length > MAX_REQUEST_BODY_CHARS) {
        reply(response, 413);
        request.destroy();
      }
    });
    request.on("end", () => {
      if (response.headersSent) {
        return;
      }
      try {
        const signal = normalizeHookPayload(JSON.parse(body) as unknown);
        if (!signal) {
          logWarn("session-activity-hook", "invalid-payload");
          reply(response, 400);
          return;
        }
        this.onSignal(signal);
        reply(response, 204);
      } catch (error) {
        logError("session-activity-hook", "request-failed", error);
        reply(response, 400);
      }
    });
    request.on("error", (error) => {
      if (!response.headersSent) {
        logError("session-activity-hook", "request-stream-failed", error);
        reply(response, 400);
      }
    });
  }
}

function normalizeHookPayload(raw: unknown): ClaudeActivitySignal | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const sessionId = typeof record.sessionId === "string" && SESSION_ID_REGEX.test(record.sessionId)
    ? record.sessionId
    : undefined;
  const event = HOOK_EVENTS.includes(record.event as HookEventName)
    ? record.event as HookEventName
    : undefined;
  if (!sessionId || !event) {
    return undefined;
  }

  if (event === "SessionStart" || event === "Stop" || event === "SessionEnd") {
    return { sessionId, state: "idle", source: `hook:${toKebabCase(event)}` };
  }
  if (event === "PermissionRequest") {
    return { sessionId, state: "blocked", source: "hook:permission-request" };
  }
  if (event === "Notification") {
    const notificationType = record.notificationType;
    return notificationType === "permission_prompt" || notificationType === "elicitation_dialog"
      ? { sessionId, state: "blocked", source: `hook:notification-${notificationType}` }
      : undefined;
  }
  if (event === "PreToolUse" && record.toolName === "AskUserQuestion") {
    return { sessionId, state: "blocked", source: "hook:ask-user-question" };
  }

  // 用户完成工具确认后，PostToolUse 会把先前的阻塞状态校准回工作中。
  return { sessionId, state: "working", source: `hook:${toKebabCase(event)}` };
}

function listenOnLoopback(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
}

function safeEqual(actual: string | undefined, expected: string): boolean {
  if (!actual) {
    return false;
  }
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function reply(response: ServerResponse, statusCode: number): void {
  if (response.headersSent) {
    return;
  }
  response.writeHead(statusCode);
  response.end();
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'"'"'`)}'`;
}

function toKebabCase(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/gu, "$1-$2").toLowerCase();
}

const REPORTER_SOURCE = `"use strict";
const http = require("node:http");

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  if (raw.length < 65536) raw += chunk;
});
process.stdin.on("end", () => {
  try {
    const input = JSON.parse(raw || "{}");
    const event = typeof input.hook_event_name === "string" ? input.hook_event_name : "";
    const blockedNotificationTypes = ["permission_prompt", "elicitation_dialog"];
    if (event === "Notification" && !blockedNotificationTypes.includes(input.notification_type)) {
      process.exit(0);
      return;
    }
    const body = JSON.stringify({
      sessionId: process.env.CLAUDE_PTY_APP_SESSION_ID,
      event,
      ...(input.tool_name === "AskUserQuestion" ? { toolName: "AskUserQuestion" } : {}),
      ...(blockedNotificationTypes.includes(input.notification_type)
        ? { notificationType: input.notification_type }
        : {})
    });
    const endpoint = new URL(process.env.CLAUDE_PTY_ACTIVITY_ENDPOINT || "");
    const request = http.request({
      hostname: endpoint.hostname,
      port: endpoint.port,
      path: endpoint.pathname,
      method: "POST",
      headers: {
        Authorization: \`Bearer \${process.env.CLAUDE_PTY_ACTIVITY_TOKEN || ""}\`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body)
      }
    }, (response) => {
      response.resume();
      response.once("end", () => process.exit(0));
    });
    request.setTimeout(500, () => request.destroy());
    request.on("error", () => process.exit(0));
    request.end(body);
  } catch {
    process.exit(0);
  }
});
process.stdin.resume();
`;
