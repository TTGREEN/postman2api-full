> **仅供学习研究使用。** 本项目按现状提供，仅用于研究和教育目的。请只连接你本人拥有或已获授权使用的 Postman 账号，并妥善保管会话 Token 与 API Key。

# postman2api

`postman2api` 是一个自托管的 Bun 服务，通过 OpenAI 兼容与 Anthropic 兼容的 API 暴露基于 Postman 的 AI 对话工作流。它附带本地管理面板，支持账号管理、多账号池、会话感知路由与流式响应。

## 账号注册模块（已知问题）

自动注册 Postman 账号（单次与批量）由 [`@postman2api/postman-register`](packages/postman-register/) 包提供，这是一个基于 Camoufox/Playwright 的浏览器自动化工具。使用方法见[其 README](packages/postman-register/README.md)。

> **已知问题——欢迎通过 Pull Request 提交修复**
>
> 整个流程依赖线上页面结构与浏览器行为，目前尚不稳定：
>
> - **元素检测失败会终结整个流程。** 页面结构变化或加载比预期慢时，选择器找不到目标元素，单次流程会立即终止。
> - **批量注册经常无法连续循环。** 使用 `--count N` 时，部分轮次会因上一轮残留状态或未捕获的异常提前中断，很少能跑满全部轮数。
> - **意外终止。** Cloudflare 人机校验、验证码轮询超时、浏览器崩溃等情况可能在没有按预期兜底处理的情况下直接退出进程。
>
> 如果你修复了以上任何问题（可以从 `packages/postman-register/src/selectors/` 的候选定位器和 `packages/postman-register/src/index.ts` 的批量编排入手），请提交一个 Pull Request。

## 功能特性

- OpenAI 兼容的 `POST /v1/chat/completions`
- Anthropic 兼容的 `POST /v1/messages`
- OpenAI 风格的 `GET /v1/models` 模型发现
- Postman 账号的浏览器登录与手动 JSON 导入
- 会话粘性、最少在途请求的账号选择，支持额度与限流故障转移
- 额度安全流式输出、SQLite 状态存储、WebSocket 面板实时更新

## 环境要求

- Bun
- Node.js 22 或更高版本（默认的 Camoufox 登录后端需要）
- 使用浏览器登录时需要桌面显示环境

Camoufox 由根目录的 `postinstall` 脚本安装。首次 `bun install` 时浏览器下载可能需要更长时间。

## 快速开始

```bash
bun install
cd dashboard && bun install && cd ..
cp .env.example .env
bun run build
bun run migrate
bun start
```

在 <http://localhost:1930> 打开管理面板。

| 用途 | URL |
| --- | --- |
| 管理面板 | `http://localhost:1930/` |
| 健康检查 | `http://localhost:1930/health` |
| 模型列表 | `http://localhost:1930/v1/models` |
| OpenAI 聊天补全 | `http://localhost:1930/v1/chat/completions` |
| Anthropic 消息 | `http://localhost:1930/v1/messages` |

使用 API 前，请先替换 `.env` 中的示例 `API_KEY` 与 `ENCRYPTION_KEY`。不要将该服务暴露到不受信任的网络；管理面板与管理接口仅面向可信的本地或私有环境。

## 连接账号

服务至少需要一个可用的 Postman 账号才能处理聊天请求。

### 浏览器登录

1. 打开管理面板，进入账号标签页。
2. 输入已有账号邮箱，选择登录流程。
3. 点击 **打开登录浏览器**，在可见的浏览器窗口中完成登录。
4. 服务获取会话与工作区身份期间，请保持窗口打开。

服务不会读取或保存账号密码。浏览器登录最多等待五分钟完成。该方式适用于已有账号，不会完成注册引导流程。

### 通过 JSON 导入账号

使用面板的导入功能导入单个或多个账号。每条记录需要邮箱和四个 Token 值：

```json
{
  "version": 1,
  "accounts": [
    {
      "email": "name@example.com",
      "enabled": true,
      "tokens": {
        "postman_sid": "SESSION_VALUE",
        "user_id": "USER_ID",
        "workspace_id": "WORKSPACE_ID",
        "workspace_subdomain": "TEAM_SUBDOMAIN"
      }
    }
  ]
}
```

导入接口接受上述带版本的批量对象，也接受单个账号对象。邮箱相同的已有记录会被更新。各字段的获取方式见 [Token 获取与导入指南](docs/postman-account-token.md)。切勿将真实的 `postman_sid` 提交到版本库、写入日志或分享给他人。

## API 使用

所有 `/v1/*` 接口都需要面板设置中配置的 Key 或 `API_KEY`。通过 `Authorization: Bearer ...` 发送；Anthropic 接口也接受 `x-api-key`。

### OpenAI 兼容聊天

```bash
curl http://localhost:1930/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-5",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'
```

### Anthropic 兼容消息

```bash
curl http://localhost:1930/v1/messages \
  -H "x-api-key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-sonnet-4-20250514",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'
```

Anthropic 模型别名会尽可能做归一化。例如 `claude-sonnet-4-20250514` 会映射为 `claude-sonnet-4-5`。

### 模型列表

```bash
curl http://localhost:1930/v1/models \
  -H "Authorization: Bearer YOUR_API_KEY"
```

当前模型 ID 包括 `gpt-5.6-sol`、`gpt-5.6-terra`、`gpt-5.6-luna`、`gpt-5.5`、`gpt-5.4`、`claude-opus-4-8`、`claude-opus-4-7`、`claude-opus-4-5`、`claude-sonnet-4-6`、`claude-sonnet-4-5`、`claude-haiku-4-5` 和 `auto`。可用模型最终取决于所连接的 Postman 账号与工作区。

## 会话、负载均衡与流式输出

账号采用最少在途请求的负载均衡策略。稳定的会话标识会让对话保持在同一个 Postman 账号上，服务重启后依然如此，从而保留上游对话状态。

- OpenAI/Codex 客户端：识别请求体中的 `session_id` 或 `x-session-id` 请求头。
- Anthropic 兼容客户端：识别原生会话元数据或请求头。
- 其他客户端：每个会话发送唯一的 `x-session-id`。

不要为所有终端用户复用一个会话 ID。没有可识别会话的请求保持无状态，按请求均衡分配。`prompt_cache_key` 这类缓存路由值不是会话标识。

被限流的账号会依据上游的 `Retry-After` 值进入账号级冷却，并尝试切换到其他可用账号。如果 SSE 响应过程中报告额度耗尽，服务会缓冲上游输出、丢弃不完整内容，并在模型内容到达客户端之前重试。缓冲或重试期间会发送 SSE 注释心跳。

## 配置

复制 `.env.example` 为 `.env`，根据部署需要调整取值。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `1930` | HTTP 服务与面板端口。 |
| `DASHBOARD_PORT` | `1931` | 保留的面板开发设置；生产资源由 `PORT` 提供。 |
| `API_KEY` | 示例值 | `/v1/*` 接口所需的 Key，除非在面板设置中修改。 |
| `ENCRYPTION_KEY` | 示例值 | 用于加密存储的敏感账号数据。请设置一个强随机唯一值。 |
| `DATABASE_PATH` | `./data/postman2api.db` | SQLite 数据库路径。 |
| `TTFB_TIMEOUT_MS` | `45000` | 等待上游响应头的最大时间。 |
| `STREAM_READ_TIMEOUT_MS` | `300000` | 上游流式分块之间的最大空闲时间。 |
| `PROVIDER_REQUEST_TIMEOUT_MS` | `120000` | 提供商调用的兜底超时。 |
| `QUOTA_SAFE_STREAM_BUFFER_BYTES` | `16777216` | 额度安全流式缓冲的最大字节数。 |
| `STREAM_KEEPALIVE_INTERVAL_MS` | `10000` | 缓冲或重试期间的 SSE 注释心跳间隔。 |
| `POSTMAN_FETCH_VERBOSE` | `false` | 输出生命周期诊断日志，不包含鉴权头或请求/响应体。 |
| `POSTMAN_OFFICIAL_MCP_ENABLED` | `false` | 只有已在 Postman 官方界面配置 MCP 服务时才开启；默认纯聊天不发送 MCP/工具元数据。 |
| `BATCHER_PROXY_URL` | 未设置 | 浏览器自动化使用的可选代理。 |
| `LOGIN_BROWSER_BACKEND` | `camoufox` | 登录浏览器后端：`camoufox` 或 `playwright`。 |

面板设置（包括 API Key）存储在 SQLite 中，并覆盖对应的环境变量默认值。

## 浏览器后端

Camoufox 是默认的登录后端。使用以下命令修复或预取浏览器缓存：

```bash
bun run browser:camoufox:fetch
```

对于明确不使用浏览器登录的 CI 或镜像构建，可显式跳过下载：

```bash
CAMOUFOX_SKIP_BROWSER_DOWNLOAD=1 bun install
```

之后（不带该变量）运行上面的 fetch 命令，再使用 Camoufox 登录。

改用 Playwright Chromium：

```bash
bunx playwright install chromium
LOGIN_BROWSER_BACKEND=playwright bun start
```

后端选择是显式的：Camoufox 不可用时不会静默切换到 Playwright。

## 开发与验证

```bash
# 自动重载运行 API
bun run dev

# 构建生产面板资源
bun run build

# 检查 TypeScript
bun run typecheck

# 运行测试
bun test

# 仅运行流式取消测试
bun run test:stream
```

浏览器冒烟检查不会登录或持久化会话：

```bash
bun run browser:camoufox:smoke
bun run browser:camoufox:smoke:node
# 可选：对公开的 Postman 登录页做网络检查
bun run browser:camoufox:smoke:postman
```

## 架构

```text
API client
    |
    v
Hono API --> session-aware account pool --> Postman provider
    |                  |                         |
    |                  v                         v
    |             SQLite storage             Postman API
    v
React dashboard <------ WebSocket updates
```

技术栈为 Bun、TypeScript、Hono、Drizzle + SQLite、React/Vite，以及 Camoufox 或 Playwright。无需 Python 运行时。

## 相关文档

- [Postman 账号 Token 获取与 JSON 导入](docs/postman-account-token.md)
- [Postman 账号注册技能](docs/postman-register-skill.md)
- [Camoufox 自动化示例](examples/camoufox-automation/README.md)
