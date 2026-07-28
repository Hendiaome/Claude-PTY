# 安全策略

## 支持范围

安全修复优先面向最新发布版本和当前主分支。旧版本可能需要先升级才能获得修复。

## 报告漏洞

请不要通过公开 Issue 报告尚未修复的安全漏洞。优先使用 GitHub 的 [Private vulnerability reporting](https://github.com/Hendiaome/Claude-PTY/security/advisories/new) 提交报告。

报告建议包含：

- 受影响版本和 macOS 版本。
- 可复现步骤或最小示例。
- 预期影响和可能的攻击条件。
- 已经尝试过的缓解方法。

请勿附带真实账号凭据、Claude 会话正文、公司代码或未经脱敏的完整系统日志。

## 安全边界说明

Claude PTY Manager 是本地开发工具，会使用当前用户权限启动 Claude Code、PTY 和项目 Shell。能够诱导用户批准危险命令、访问恶意项目或运行不可信 Claude 插件的场景，不等同于应用本身绕过操作系统权限，但仍欢迎报告可由应用设计缓解的风险。

Claude Code、MCP 服务和第三方插件的漏洞应同时报告给对应维护方。
