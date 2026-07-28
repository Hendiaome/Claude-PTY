import type { ClaudeManagerApi } from "../../preload";

declare global {
  interface Window {
    claudeManager: ClaudeManagerApi;
  }
}

export {};
