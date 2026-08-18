# Postman 官方 MCP 与本项目的关系

Postman 官方 MCP Server 是给外部 AI Agent 使用的工具服务器，用于读写 Postman workspace、collection、environment、API、mock server、monitor 等资源。本项目不是 MCP Server；本项目是 OpenAI / Anthropic 兼容代理服务。

## 两种接入方式

### 方式 A：在你的 Agent / IDE 中直接配置 Postman MCP

如果你使用 Codex、Claude Code、Cursor、VS Code 等 MCP 客户端，请在这些客户端里配置 Postman 官方 MCP Server。这样 Agent 可以直接管理 Postman 资源，与 `postman2api` 的聊天代理能力相互独立。

Postman 官方提供远程 MCP 端点，按工具范围分为：

- Minimal：基础 workspace / collection / environment / API 操作
- Code：生成 collection、mock server、environment 等开发资源
- Full：完整 Postman 工具集

也可以使用本地 npm 包方式运行 Postman MCP Server，并通过 Postman API key 鉴权。

### 方式 B：让本项目向 Postman Agent Mode 转发工具元数据

本项目支持把 OpenAI / Anthropic 请求中的 `tools` 转换成 Postman Agent Mode payload 的 `clientTools.thirdParty`。该路径默认关闭：

```env
POSTMAN_OFFICIAL_MCP_ENABLED=false
```

只有满足以下条件才开启：

1. 你已经在 Postman 官方界面为对应 workspace / account 配好 MCP 或工具服务。
2. 你确认该账号的 Agent Mode 可用。
3. 客户端请求确实需要 `tools`。

开启：

```env
POSTMAN_OFFICIAL_MCP_ENABLED=true
```

开启后，本项目会把客户端传入的 OpenAI function tools 映射到 Postman Agent Mode 的第三方工具描述；它不会替你启动本地 MCP Server，也不会保存 MCP API key。

## 排错

- `Agent Mode is not enabled`：先对账号执行测试或 warmup，确认 `ai_user_agent_mode` 已启用。
- `INPUT_VALIDATION_ERROR: Forbidden`：通常是 Agent Mode / 工具元数据 / 上游字段不匹配，先关闭 `POSTMAN_OFFICIAL_MCP_ENABLED` 验证纯聊天。
- 工具没有执行：确认工具执行端在 Postman 官方 MCP 配置或外部 MCP 客户端中存在；本项目只转发工具 schema，不代替外部工具运行时。

## 当前建议

生产默认保持 `POSTMAN_OFFICIAL_MCP_ENABLED=false`。先保证纯聊天稳定，再逐步测试 MCP / tools。
