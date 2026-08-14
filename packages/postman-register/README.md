# Postman 自动注册与 Enterprise 试用

`@postman2api/postman-register` 是 postman2api 的账号供应工具。它使用 Camoufox 和 Playwright 自动完成一个 Postman 账号的注册、邮箱验证、Enterprise 试用开通与 Postman AI 启用，并将可导入管理台的账号凭据写入本地 JSON 文件。

## 流程概览

一次成功运行会按以下顺序执行：

1. 在 temp-mail.org 创建新的临时邮箱。
2. 在 Postman 注册页填写邮箱、用户名和密码，并等待 Cloudflare 校验通过。
3. 从临时邮箱读取六位验证码，完成账号验证。
4. 完善个人资料并完成 AI 引导。
5. 开通 Enterprise 30 天试用。
6. 进入团队设置。
7. 启用 Postman AI。
8. 收集登录会话并保存账号 Token。

前七项是浏览器自动化阶段；最后一项仅在全部阶段完成后执行。

## 前置条件

- 已安装 [Bun](https://bun.sh/)。
- 可访问 temp-mail.org、Postman 及其验证服务。
- 首次运行需下载 Camoufox 浏览器运行时。
- 建议在独立目录或受控环境运行。输出文件中含有登录凭据和会话 Token。

## 安装

在本目录执行：

```bash
bun install
bunx camoufox-js fetch
```

`camoufox-js fetch` 只需在浏览器运行时尚未下载时执行一次。若仓库根目录已完成该步骤，通常无需重复下载。

## 快速开始

默认以有界面模式运行单次注册，便于观察浏览器行为：

```bash
bun run start
```

成功后，终端会输出 Token 文件路径，默认写入当前目录的 `tokens/`。

## 运行方式

### 单次注册

```bash
bun run start
```

默认只创建一个账号。每次运行都会从新邮箱开始，并自动生成独立的 12 位密码。

### 无界面运行

适合服务器或 CI 环境：

```bash
bun run start:headless
```

无界面模式不利于处理 Cloudflare 人机校验。首次排错时建议先使用有界面模式。

### 批量注册

通过命令行指定轮数：

```bash
bun run start --count 5
```

或使用环境变量：

```bash
POSTMAN_COUNT=5 bun run start
```

每一轮都使用新的 BrowserContext、新临时邮箱和随机密码；批量模式复用同一个 Camoufox Browser 进程，避免轮次之间重复启动导致 `Failed to connect`。每轮结束后只关闭本轮 Context，所有轮次完成后统一关闭 Browser。单轮失败不会中断后续轮次，存在失败时进程退出码为 `1`。

### 本地演示

不访问外部网站时可运行演示：

```bash
bun run start:demo
```

### 类型检查

```bash
bun run typecheck
```

## 配置

所有配置均通过命令行参数或环境变量提供，无需修改源码。

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| `--count N` | `1` | 当前命令的注册轮数，优先级高于 `POSTMAN_COUNT`。 |
| `POSTMAN_COUNT` | `1` | 批量注册轮数。 |
| `POSTMAN_PASSWORD` | 每轮随机生成 | 固定注册密码；未设置时每个账号使用独立的随机密码。 |
| `POSTMAN_TOKENS_DIR` | `tokens` | Token JSON 输出目录，可使用绝对路径或相对当前目录的路径。 |
| `POSTMAN_CF_TIMEOUT` | `180000` | Cloudflare 校验总等待时间，单位毫秒。 |
| `--headless` | 关闭 | 使用无界面浏览器；`start:headless` 已包含此参数。 |

示例：将三个账号的 Token 写入指定目录，并使用固定密码：

```bash
POSTMAN_PASSWORD='ChangeThisPassword123' \
POSTMAN_TOKENS_DIR='./private-tokens' \
bun run start --count 3
```

不要把真实密码或 Token 写入 Git 已跟踪的配置文件。

## 输出与导入

每个成功账号会生成一个独立文件：

```text
tokens/postman-token-YYYYMMDD-HHMMSS-SSS.json
```

文件结构如下：

```json
{
  "email": "xxx@primetor.com",
  "password": "aB3kLm9xZq2w",
  "tokens": {
    "postman_sid": "...",
    "user_id": "...",
    "workspace_id": "...",
    "workspace_subdomain": "xxx-1234567"
  }
}
```

- `postman_sid` 从已登录浏览器的 HttpOnly Cookie 获取。
- `user_id`、`workspace_id` 和 `workspace_subdomain` 从 Postman handshake 会话信息获取。
- 该 JSON 可用于 postman2api 管理台的账号导入；字段约定见仓库根目录的 `docs/postman-account-token.md`。
- 文件同时包含密码与会话 Token，应视作敏感凭据。导入完成后请妥善保存或删除，且不要提交到版本库。

## 失败处理

### 单次模式

单次模式下，任一阶段失败时脚本会打印失败阶段、错误原因和所有标签页 URL，并保持浏览器打开供检查。排查完毕后按 `Ctrl+C`，脚本会先关闭浏览器再退出。

### 批量模式

当 `--count` 大于 `1` 时，每轮结束只关闭本轮 BrowserContext，并继续下一轮；如果检测到 Browser 传输层已经断开，才会关闭失效 Browser，并在下一轮重新启动。浏览器启动失败会自动重试，未捕获异常也会记录日志后跳过该轮，轮间有短暂停顿。请查看终端输出定位失败的阶段；如需观察页面现场，将相同配置改为单次有界面模式重试。

### 常见问题

| 现象 | 建议处理 |
| --- | --- |
| 步骤等待超时 | 网络敏感的等待（页面加载、跨阶段跳转、Cloudflare）默认 10 分钟，页面内元素查找保持秒级快速失败（`src/config.ts` 的 `timeouts`）；如需调整可改这里。 |
| Cloudflare 校验超时 | 使用有界面模式检查挑战页；必要时增大 `POSTMAN_CF_TIMEOUT`（默认 10 分钟），确认网络和浏览器运行时正常。 |
| 未收到验证码邮件 | 脚本会自动轮询；若超时，稍后以新邮箱重新执行，或检查临时邮箱页面是否被拦截。 |
| 提示「创建了太多的邮箱」 | temp-mail 按出口 IP 限流，与浏览器指纹无关（camoufox 每次启动都会换新指纹，但 IP 不变）。设置 `POSTMAN_PROXY="http://user:pass@host:port"` 走代理换 IP，或等待限流窗口过去。 |
| 页面元素找不到 | 页面结构可能已变更。更新 `src/selectors/tempMail.ts` 或 `src/selectors/postman.ts` 中对应候选定位器。 |
| Token 字段不完整 | 确认流程已进入 Postman 工作区并保持登录；使用有界面单次模式查看最终页面和会话状态。 |
| Camoufox 无法启动 | 重新执行 `bunx camoufox-js fetch`，并确认当前环境支持浏览器图形或无界面运行。 |

每次执行均从头开始，不支持从失败步骤断点续跑。

## 项目结构

```text
src/
├── index.ts             # 入口：流程编排、批量执行与错误边界
├── config.ts            # URL、超时、密码和浏览器配置
├── types.ts             # 跨阶段共享的 PlanTrack 状态
├── core/                # 浏览器、日志、等待、监测、快照和 Token 导出
├── selectors/           # temp-mail.org 与 Postman 的页面定位器
└── steps/               # 七个独立的业务自动化阶段
```

页面改版时，优先修改 `src/selectors/` 中的候选定位器；业务步骤和流程编排通常无需调整。具体分层设计见 `docs/DESIGN.md`。

## 已知限制

- temp-mail.org 和 Postman 都可能触发 Cloudflare 校验，Camoufox 只能降低被拦截概率，不能保证自动通过。
- 第三方页面和试用策略可能随时变化，选择器或步骤逻辑需要随之维护。
- 使用临时邮箱、自动注册或自动开通试用前，请确认行为符合相关服务条款和适用政策。
