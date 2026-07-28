# 参与贡献

感谢你参与 Claude PTY Manager。

## 开始之前

- 请先搜索已有 Issue，避免重复提交。
- Bug 报告请说明 macOS、应用、Claude Code 和 Node.js 版本，并提供可复现步骤。
- 分享日志、截图或示例项目之前，请删除真实代码、账号、本地路径和其他敏感信息。
- 安全漏洞不要提交公开 Issue，请使用 [SECURITY.md](SECURITY.md) 中的私下报告方式。

## 本地开发

```bash
npm ci
npm run dev
```

提交改动前至少运行：

```bash
npm run build
git diff --check
```

## Pull Request

1. 从最新代码创建独立分支。
2. 一个 Pull Request 聚焦一个明确问题。
3. 保持原生终端模式兼容；结构化模式的改动不能破坏 PTY 主链路。
4. 新增复杂逻辑时添加少量必要注释，说明原因、边界或兼容策略。
5. 涉及日志时只记录状态和统计信息，不记录 Prompt、回复正文、代码、命令参数或问题答案。
6. 在说明中列出验证方式、影响范围和已知限制。

项目目前没有完整自动化测试套件。涉及 PTY、窗口恢复、输入法、锁屏或 Claude 协议的改动，请同时完成对应的手工验证。
