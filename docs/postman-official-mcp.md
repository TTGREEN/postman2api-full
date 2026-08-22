# Postman 官方 MCP 与本项目的关系

Postman 官方 MCP Server 是给外部 AI Agent 使用的工具服务器，用于读写 Postman workspace、collection、environment、API、mock server、monitor 等资源。本项目不是 MCP Server；本项目是 OpenAI / Anthropic 兼容代理服务。


## 官方资料入口

- 官方概览：https://learning.postman.com/docs/reference/postman-api/postman-mcp-server/overview/
- 远程 MCP Server：https://learning.postman.com/docs/reference/postman-api/postman-mcp-server/postman-mcp-remote-server
- 本地 MCP Server：https://learning.postman.com/docs/reference/postman-api/postman-mcp-server/postman-mcp-local-server

## Codex 示例

远程 US minimal（OAuth）：

```bash
codex mcp add postman --remote-url https://mcp.postman.com/minimal
```

远程 US full（OAuth）：

```bash
codex mcp add postman --remote-url https://mcp.postman.com/mcp
```

本地或 API key 模式：

```bash
codex mcp add postman --env POSTMAN_API_KEY=<POSTMAN_API_KEY> -- npx @postman/postman-mcp-server --minimal
codex mcp add postman --env POSTMAN_API_KEY=<POSTMAN_API_KEY> -- npx @postman/postman-mcp-server --code
codex mcp add postman --env POSTMAN_API_KEY=<POSTMAN_API_KEY> -- npx @postman/postman-mcp-server --full
```

## 两种接入方式

### 方式 A：在你的 Agent / IDE 中直接配置 Postman MCP

如果你使用 Codex、Claude Code、Cursor、VS Code 等 MCP 客户端，请在这些客户端里配置 Postman 官方 MCP Server。这样 Agent 可以直接管理 Postman 资源，与 `postman2api` 的聊天代理能力相互独立。

Postman 官方提供远程 MCP 端点，按工具范围分为：

- Minimal：基础 workspace / collection / environment / API 操作
- Code：生成 collection、mock server、environment 等开发资源
- Full：完整 Postman 工具集

也可以使用本地 npm 包方式运行 Postman MCP Server，并通过 Postman API key 鉴权。

### 方式 B：通过本项目端口向 Postman Agent Mode 转发工具

如果你要把本项目封装成统一端口，让 Codex / Claude Code / 自研客户端只调用 `http://127.0.0.1:1930/v1/*`，请求里的 `tools` 会自动转换成 Postman Agent Mode payload 的 `clientTools.thirdParty`，并在上游返回工具调用后，把客户端回传的 `tool` / `tool_result` 结果绑定回同一个 Postman conversation。

这条路径不要求在 Postman 官方界面配置 MCP Server；只需要对应账号的 Agent Mode 可用。

本项目的直接端口模式不要求额外配置 Postman 官方 MCP Server；请求里的工具
schema 会作为 `proxy-tools` 转发。只有当你要使用 Postman 官方 MCP Server
本身管理 workspace 资源时，才需要按方式 A 单独配置它。

本项目会使用 Postman Agent Mode 的官方工具 payload 形态发送：`clientTools.nativeToolsHash` / `excludedTools` / `clientKBTerms.nativeTermsHash` / `excludedKBTerms` / `clientTools.thirdParty["proxy-tools"]`。服务会优先从当前 Postman Web 页面及其全部 JS chunk 中发现最新 `clienttools`、`kbterms` hash 和 `x-app-version` 并缓存；发现失败才使用随版本更新的内置值。当前内置版本为 `12.24.3-260819-0605`。如部署环境无法访问 Postman Web，也可以显式设置 `POSTMAN_NATIVE_TOOLS_HASH`、`POSTMAN_NATIVE_TERMS_HASH`，必要时再设置 `POSTMAN_APP_VERSION`。同时兼容以下入口形态，并统一转成 Postman 的 `proxy-tools`：

- OpenAI Chat Completions：`{ type: "function", function: { name, description, parameters } }`
- Anthropic / custom：`{ type: "custom", name, input_schema }`
- MCP `tools/list`：`{ name, description, inputSchema }`
- namespace 工具：`{ type: "namespace", name, tools: [...] }`，客户端侧仍识别为 `namespace.toolName`；发给 Postman 前会安全化为 `namespace_toolName`，上游返回 tool call 时再映射回客户端原名。

注意：本项目负责“端口协议转换 + 上游转发 + tool result 续写”，不负责保存 MCP API key，也不直接启动本地 MCP Server。真实工具运行时仍由调用客户端或其工具运行时负责；本项目只转发工具 schema、上游 tool call，并把客户端回传的 result 绑定到同一 Postman conversation。带工具且未显式设置 `tool_choice: none` 时，`autoRun` 为 `true`，让 Agent Mode 进入工具调用/续接路径；纯聊天或显式禁用工具时为 `false`。

## 排错

- `Agent Mode setting failed (404)`：该 Postman 环境没有暴露本地尝试调用的设置接口；服务不会再因此拦截聊天，会继续发送真实聊天请求，让上游聊天接口返回权威结果。
- `Agent Mode is not enabled`：服务会自动清理本地开关缓存、重新启用 `ai_user_agent_mode` 并重试一次；若仍出现，说明该账号/团队的 Postman Agent Mode 或组织 AI 权限仍未真正可用。
- `INPUT_VALIDATION_ERROR: Forbidden`：MCP/tools 场景会自动做最小诊断探针，并在错误后追加 `MCP diagnostic`：
  - `pure_chat=fail`：不带工具的纯聊天也失败，优先查账号 Agent Mode、团队 AI 权限、额度或通用上游访问。
  - `pure_chat=pass, noop_tool=fail`：纯聊天可用，但一个最小 `noop` 第三方工具也被拒绝，问题定位在 Postman 上游 MCP/第三方工具转发权限或校验。
  - `pure_chat=pass, noop_tool=pass`：最小工具可用，问题定位在客户端原始工具名、schema 或工具数量 payload。
  - `metadata=bundled`：本次请求使用内置 hash；`metadata=discovered`：已从当前 Postman 页面/JS chunk 发现 hash；`metadata=configured`：使用了显式环境变量覆盖。
  - 所有工具在首次发送前都会被收敛为 Postman 可接受的 object schema：根和嵌套 object 强制 `additionalProperties=false`，移除 `$ref`、`$defs`、`anyOf` / `oneOf` 等复杂结构，并过滤无效 `required` 字段。这样诊断针对的就是实际发送的 payload，不会再重复发送同一个被拒绝的 schema。
  - 诊断探针使用独立的短超时，不复用已断开的客户端请求信号，避免把真实的 `Forbidden` 覆盖成 `Client disconnected`。
- 工具没有执行：确认请求确实带有 `tools`，并确认工具运行时在客户端或 Postman Agent Mode 可访问环境中存在；本项目负责把 schema 和 tool result 通过端口转发，不凭空提供工具实现。
- tool result 后无法继续：优先确认客户端复用了同一个 `x-session-id`，并检查
  `tool_call_id` 是否来自上一轮响应。没有会话头时，服务也会按工具调用 ID 做
  一次短时续接，但多账号负载均衡或多轮工具链仍应使用稳定会话。

## 当前建议

生产中纯聊天请求仍不携带第三方工具列表；带 `tools` 的请求会自动进入端口工具转发路径。
