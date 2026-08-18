# 上游兼容监控

`postman2api` 依赖 Postman Web 的账号状态、额度状态、Agent Mode 配置和聊天响应格式。上游变化通常会先表现为：

- `Postman Agent Mode is not enabled...`
- `INPUT_VALIDATION_ERROR: Forbidden`
- 额度接口字段变化
- SSE 事件字段或错误文案变化
- 请求头、`x-app-version` 或 Agent Mode payload 结构变化

## 本地探针

启动服务后运行：

```bash
bun run smoke:upstream -- --api-key YOUR_API_KEY
```

该命令只检查本地服务健康和 `/v1/models`。如需真实上游最小聊天探针：

```bash
bun run smoke:upstream -- --api-key YOUR_API_KEY --chat --model auto
```

探针不会读取 `.env`、数据库或账号 Token；它只通过正在运行的 HTTP 服务访问公开兼容接口。

## 处理建议

- Agent Mode 未开启：先在面板对账号执行测试或 warmup，再重试请求。
- 额度耗尽：检查 Postman team AI credits 或 pay-as-you-go 设置。
- JSON / SSE 格式变化：补充 `tests/regressions.test.ts` 的错误样本，再修解析器。
- 上游字段变化：先更新 `docs/postman-official-mcp.md` 或 README 的兼容说明，再改请求构造。
