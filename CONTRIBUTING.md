# 贡献指南

感谢参与 `postman2api`。本项目适合通过小而可验证的 Pull Request 持续改进。

## 开发流程

1. 从 `main` 新建分支：`fix/...`、`feat/...`、`docs/...`。
2. 修改前先确认不会读取或提交 `.env`、`data/`、`runtime/`、`tokens/`、数据库、日志或账号凭据。
3. 保持 PR 聚焦：一个 PR 解决一个问题或一个小功能。
4. 提交前运行：

```bash
bun run ci:check
```

该命令会执行目录契约审计、API 文档校验、TypeScript 类型检查和核心回归测试。

## 必须通过的检查

- `bun run audit:layout`
- `bun run validate:api`
- `bun run typecheck`
- `bun test tests/regressions.test.ts --timeout 30000`

如果改动浏览器自动化或真实上游行为，请补充对应 smoke 说明，但不要在 PR 中提交真实账号数据。

## 发布包规则

- `main` 只保留源码、文档、测试和协作配置。
- 不要把 `反代完整版.zip`、`runtime/`、`node_modules/`、数据库或 `.env` 合并进 `main`。
- 完整包只在维护者明确要求时生成，并放在独立发布分支或 Release 资产中。

## MCP / 工具调用改动

默认保持 `POSTMAN_OFFICIAL_MCP_ENABLED=false`。只有确认 Postman 官方界面已配置 MCP 服务时，才应启用并测试工具元数据转发。
