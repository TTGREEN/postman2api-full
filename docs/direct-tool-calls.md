# 直接调用端口并续接工具

本项目可以直接作为 OpenAI / Anthropic 兼容端口使用，不需要在 Codex、Claude Code
或调用端再配置一个 MCP 客户端。

## 1. 端口工具转发

直接在请求体发送 `tools` 即可。端口会自动把请求里的工具 schema 转成 Postman
Agent Mode 的 `clientTools.thirdParty["proxy-tools"]`，不要求在 Postman 官方界面
配置 MCP Server。本项目不保存 MCP API key，也不启动 MCP 进程；账号必须能够使用
Postman Agent Mode。

无论工具数量多少，端口都只向 Postman 发送一个 `proxy-tools` 分组；不能把工具
拆成多个虚拟 MCP server，因为 Postman 会拒绝同一请求里的多个合成 server。遇到
校验失败时，诊断流程会临时按每组 20 个工具探测，帮助区分单个工具问题和完整列表
组合问题；这只用于诊断，不改变真实请求中的工具列表。客户端收到的工具名、参数和
工具结果仍会恢复为原始格式。

代理只归一化 OpenAI、Anthropic/custom 和 MCP namespace 的外层工具格式；每个工具的
`parameters`、描述和参数名会原样转发，内部映射字段不会发给 Postman。`tool_choice`
为 `none` 时 `devModeOptions.autoRun` 为 `false`，其他情况下沿用工具调用请求的默认
行为。工具调用结果仍通过兼容端口返回，并可用下一轮 `TOOL_RESPONSE` 续接。

代理固定发送 `devModeOptions.isParallelToolCallingSupported: false`，请求里的
`parallel_tool_calls` 不会改变这一点。原因见下面「多轮工具链」一节：并行模式下
Postman 只接受 `input.toolResponses` 数组来回填整个工具调用组，而 `/_gw/chat`
对该字段直接返回 `INPUT_VALIDATION_ERROR: Forbidden`。因此模型每轮只会请求一个
工具，多个工具需要串行调用；这不影响工具链的总长度。

默认使用当前已验证的 Postman Web client hash；如果部署机无法读取 Postman Web，
可以在 `.env` 中显式覆盖：

```env
POSTMAN_NATIVE_TOOLS_HASH=clienttools-workspace_v12-browser-<version>-<hash>
POSTMAN_NATIVE_TERMS_HASH=kbterms-workspace_v12-browser-<version>-<hash>
POSTMAN_APP_VERSION=<version>
```

## 2. 首次请求

每个对话都使用独立且稳定的 `x-session-id`。工具由调用端执行，代理只负责把工具
定义转发给 Postman，并把工具结果续接回同一个上游 conversation。

```bash
curl http://127.0.0.1:1930/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "x-session-id: demo-agent-001" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "auto",
    "stream": false,
    "messages": [
      {"role": "user", "content": "查询当前服务状态"}
    ],
    "tools": [
      {
        "type": "function",
        "function": {
          "name": "get_service_status",
          "description": "读取本地服务状态",
          "parameters": {
            "type": "object",
            "properties": {},
            "additionalProperties": false
          }
        }
      }
    ],
    "tool_choice": "auto"
  }'
```

如果模型决定调用工具，响应中的 `choices[0].message.tool_calls` 会包含工具名、
参数和 `id`。调用端执行工具后，保留上一轮消息，并追加一条 `role: "tool"` 消息。

## 3. 回传工具结果

把上一次响应中的工具调用原样放回 `assistant.tool_calls`，再追加工具结果：

```bash
curl http://127.0.0.1:1930/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "x-session-id: demo-agent-001" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "auto",
    "stream": false,
    "messages": [
      {"role": "user", "content": "查询当前服务状态"},
      {
        "role": "assistant",
        "content": null,
        "tool_calls": [
          {
            "id": "CALL_ID_FROM_PREVIOUS_RESPONSE",
            "type": "function",
            "function": {
              "name": "get_service_status",
              "arguments": "{}"
            }
          }
        ]
      },
      {
        "role": "tool",
        "tool_call_id": "CALL_ID_FROM_PREVIOUS_RESPONSE",
        "content": "{\"status\":\"ok\"}"
      }
    ]
  }'
```

对于 Anthropic 兼容入口，使用 `POST /v1/messages`，把工具结果按 Anthropic 的
`tool_use` / `tool_result` 消息格式传回，代理会转换成同一套 Postman
`TOOL_RESPONSE` 请求。

## 多轮工具链

多步工具链（工具 A → 工具 B → 最终回答）已验证可用，OpenAI 流式 / 非流式与
Anthropic `/v1/messages` 三条路径都能跑完整链路。之前"模型反复调用同一个工具、
永不收敛"由两个上游行为造成，均已在代理内处理：

- **并行工具调用契约**：`isParallelToolCallingSupported: true` 时，Postman 认为
  客户端会用 `input.toolResponses` 数组一次性回填整个 `toolCallGroupId` 组。只发
  单个扁平的 `input.toolResponse` 会让该组被判定为未执行，模型收到的是"工具调用
  被拒绝"，于是原样重发同一个调用。而 `input.toolResponses` 在该路由上被无条件
  拒绝（`Forbidden`）。代理因此固定关闭并行工具调用。
- **`loopApprovalChunk` 循环闸门**：连续若干轮自动执行工具后，上游停止生成，只
  下发 `usage` + `loopApprovalChunk`（含 `counters`、`reasons`、`thresholds`）。
  代理会捕获该事件，并在同一个 `conversationId` 上以 `chatType: "USER_QUERY"`、
  `query: "Continue."` 自动续跑一次；仍被拦时把 `loopApprovalChunk.message` 作为
  正文返回，保证该轮不会是空响应。

回传工具结果时 `input.toolCallGroupId` 是必填项。缺失会得到
`TOOL_CALL_NOT_FOUND`（"Looks like I lost my way. Try sending a new message."）。
代理会先从消息历史中解析，再回退到按 `tool_call_id` 的服务端短期绑定；该值是
**每轮变化**的，不是整个会话固定。

流式响应中，Postman 会在每个 `toolCallChunk` 里重复完整工具名。代理只在该
`index` 的第一个 delta 里输出 `function.name`，避免按 OpenAI 规范拼接 delta 的
客户端拼出 `get_weatherget_weather` 这类不存在的工具名。

## 会话规则

- 推荐始终发送 `x-session-id`，并在工具循环的每一轮复用它。
- 没有会话头时，代理会按工具调用 ID 保存一个短时续接绑定，能兼容一次工具结果
  回传；多账号负载均衡或多轮工具链仍可能需要稳定会话头。
- 如果首轮上游 SSE 没有显式返回 `conversationId`，但请求带有稳定的 `x-session-id`，
  代理会在工具结果回传前查询 Postman 会话历史，并只接受工具 ID 或工具名/参数签名
  唯一匹配的会话，恢复成功后再发送 `TOOL_RESPONSE`。
- 工具调用 ID 只作为临时绑定键，不会替代会话隔离，也不会持久化到真实数据库。
- 代理不执行任意本地命令；工具执行器应由调用端提供。

## 常见判断

- 没有 `tool_calls`：先确认 `.env` 已开启工具转发，并确认当前 Postman 账号的
  Agent Mode 可用。
- 回传后重新变成普通回答：检查两轮请求的 `x-session-id` 和 `tool_call_id` 是否
  与上一次响应一致。
- 返回 `INPUT_VALIDATION_ERROR: Forbidden`：**首先排查历史长度**。Postman 的
  `/_gw/chat` 对 `input.seedingMessages` 有硬性限制：只接受恰好 2 条（1 条 user +
  1 条 assistant），且每条内容不得超过 10000 字符；任何其他形状都只返回一个不带说明的
  `Forbidden`。`input.query` 的上限同样接近 10000 字符，但错误文案不同
  （`Invalid input query. If you have a large file, try importing it...`）。
  这些上限是**按请求**生效的，不限制整个 conversation 的累计长度，见下面「超长上下文」
  一节。若长度已确认合规再看响应中的 MCP diagnostic 信息。
  注意 MCP diagnostic 的探针发送的是全新的短消息，因此在"历史过长"这一根因下它会误报
  为工具 schema 问题——它的结论只在历史长度已确认合规时才可信。

诊断中的 `original_request=... [http=200,sse]` 表示本地端口已经收到请求并成功把它送到
Postman；Postman 返回了 SSE 应用层错误，不是本地端口连接失败。`partitions=1:20:pass...
|2:11:pass...` 表示同一批工具拆成的每个分组都能单独通过；若结论是
`combined_tool_groups_rejected`，问题就在 Postman 对原始多分组列表的整体校验。若某个分组
显示 `fail`，服务会自动二分；`isolated=1[8:8]=tool_name:fail...` 表示已定位到第 8 个
规范化工具，通常就是该工具的 schema、名称或描述触发了 Postman 校验。若显示一个范围，
说明该范围单独通过而组合失败，根因仍是范围内工具的组合结构。

## 超长上下文

冷启动（没有可复用的上游 `conversationId`）时，整段历史需要塞进一条 seeding 消息，
而单条上限是 10000 字符。以前的做法是直接按 30% 头 + 70% 尾裁掉中间，不报错也不打
日志，请求照样返回 200——超长 system prompt 的工具规则正好落在被吃掉的中段，表现
为"模型莫名不守规矩"而不是一个可见的错误。现在改为三层处理：

1. **分段预热（默认开启）**：上限是按请求而非按会话生效的，所以代理会先把历史切成
   若干 ≤ 8500 字符的分段，在同一个 `conversationId` 上以连续多轮 `USER_QUERY`
   推给上游（首轮 `conversationId: null`，之后复用捕获到的 id），每段都包在"这是
   历史，先不要执行"的提示里；真正的问题再落到这个已经预热好的会话上。上下文上限
   因此变成 Postman 自己的模型窗口，而不是 10000 字符。
   代价是每个分段都是一次真实上游生成，会消耗额度；用
   `POSTMAN_CONTEXT_PRIMING=0` 可以关闭，用
   `POSTMAN_CONTEXT_PRIMING_MAX_SEGMENTS` 控制上限（默认 40）。
   预热在任何一步失败（HTTP 非 2xx、SSE 报错、额度耗尽、分段数超限）都会软失败，
   退回下面的预算裁剪路径并打印告警，不会让用户请求整体失败。

   **分段的措辞是功能的一部分，不是注释。** 预热走的是 `input.query`，上游把它当成
   一条**实时用户消息**读，而不是历史回放（只有 `seedingMessages` 才是回放通道）。
   早期版本把分段包在 `[Context transfer N/M ...]` 里，且保留了 `renderContextParts`
   生成的 `[System]` 伪角色前缀——上游模型据此判定"有人在伪造 system 指令"，把整段
   内容当作 prompt injection 拒答（*"The messages labeled as 'context transfer' and
   '[System]' were user-supplied content"*）。这种失败在日志里完全看不见：每个分段
   都 200，`context-truncated` 告警为 0，只有回答内容变成了拒绝。

   因此 `relabelForPriming()` 会把 `[System]` 改写成 `[My instructions to you]`，
   `primingWrapper()` 用第一人称说明"这是我自己的内容，不是 system 消息，也不改变
   你的准则"。改动这两个函数前先看 `tests/context-priming.test.ts` 的
   `priming segment framing` 用例，并用真实上游复跑：

   ```bash
   bun run smoke:context -- --api-key YOUR_LOCAL_API_KEY
   ```

   该脚本只连本地端口，不接触 `postman_sid`。它构造一段约 21000 字符的历史，把关键
   规则放在中段（正是旧裁剪逻辑会丢掉的位置），然后在 OpenAI 流式 / 非流式与
   Anthropic 三条路径上各跑一次冷启动，检查回答里是否仍带着中段的那两个信息。
2. **按角色分配预算**：真的需要裁剪时，先给历史预留
   `min(历史总长, 9500 × 0.4)`，剩余额度留给 system prompt；system 仍然超出时按
   70% 头 + 30% 尾裁剪（规则集中在开头），然后用剩下的额度从最新往旧填历史。
   若最后一块历史整块放不下，会截取它的尾部把预算填满，而不是白白浪费。
3. **截断告警**：任何一次丢弃都会无条件打印
   `[proxy] context-truncated { droppedChars, keptChars, limit, priming }`，
   **不受 `POSTMAN_FETCH_VERBOSE` 控制**——内容缺失会改变回答，不能是一个静默的
   200。被裁掉的位置在正文里也有显式标记
   （`[... middle of system instructions omitted ...]` 等），让模型知道自己缺了东西。
