import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { EnvironmentCheckResult } from "../shared/types";

const SHELL_PATH = "/bin/zsh";

let cachedEnv: NodeJS.ProcessEnv | undefined;
let cachedClaudePath: string | undefined;
const appendSystemPromptSupport = new Map<string, boolean>();

export function getShellPath(): string {
  return SHELL_PATH;
}

/** 使用登录 shell 环境，保证 GUI 启动时也能找到用户在 ~/.zshrc 中配置的命令。 */
export function getLoginEnv(): NodeJS.ProcessEnv {
  if (cachedEnv) {
    return cachedEnv;
  }

  const baseEnv = { ...process.env };

  try {
    const raw = execFileSync(SHELL_PATH, ["-lc", "source ~/.zshrc >/dev/null 2>&1; /usr/bin/env"], {
      encoding: "utf8",
      env: baseEnv,
      timeout: 5000
    });
    cachedEnv = parseEnv(raw, baseEnv);
  } catch {
    cachedEnv = baseEnv;
  }

  return cachedEnv;
}

/** 从登录环境的 PATH 解析 Claude 命令，并缓存仍然有效的可执行路径。 */
export function resolveClaudePath(): string | undefined {
  if (cachedClaudePath && existsSync(cachedClaudePath)) {
    return cachedClaudePath;
  }

  try {
    const raw = execFileSync(SHELL_PATH, ["-lc", "source ~/.zshrc >/dev/null 2>&1; command -v claude"], {
      encoding: "utf8",
      env: getLoginEnv(),
      timeout: 5000
    }).trim();

    cachedClaudePath = raw || undefined;
    return cachedClaudePath;
  } catch {
    return undefined;
  }
}

/** 每个 Claude 可执行文件只检查一次帮助信息，避免为每次会话重复启动探测进程。 */
export function supportsAppendSystemPrompt(claudePath: string): boolean {
  const cached = appendSystemPromptSupport.get(claudePath);
  if (cached !== undefined) {
    return cached;
  }

  try {
    const help = execFileSync(claudePath, ["--help"], {
      encoding: "utf8",
      env: getLoginEnv(),
      timeout: 5000
    });
    const supported = help.includes("--append-system-prompt");
    appendSystemPromptSupport.set(claudePath, supported);
    return supported;
  } catch {
    appendSystemPromptSupport.set(claudePath, false);
    return false;
  }
}

/** 汇总 Claude、Node 和 shell 的可用性，供侧栏环境提示和会话启动前检查使用。 */
export function checkEnvironment(): EnvironmentCheckResult {
  const claudePath = resolveClaudePath();
  const nodePath = resolveCommandPath("node");

  if (!claudePath) {
    return {
      ok: false,
      nodePath,
      shellPath: SHELL_PATH,
      message: "未找到 claude 命令，请检查 Claude Code CLI 是否安装，以及 PATH 是否能被桌面应用读取。"
    };
  }

  return {
    ok: true,
    claudePath,
    nodePath,
    shellPath: SHELL_PATH
  };
}

function resolveCommandPath(command: string): string | undefined {
  try {
    return execFileSync(SHELL_PATH, ["-lc", `source ~/.zshrc >/dev/null 2>&1; command -v ${command}`], {
      encoding: "utf8",
      env: getLoginEnv(),
      timeout: 5000
    }).trim();
  } catch {
    return undefined;
  }
}

function parseEnv(raw: string, fallback: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...fallback };

  for (const line of raw.split("\n")) {
    const equalsIndex = line.indexOf("=");
    if (equalsIndex <= 0) {
      continue;
    }

    const key = line.slice(0, equalsIndex);
    const value = line.slice(equalsIndex + 1);
    env[key] = value;
  }

  return env;
}
