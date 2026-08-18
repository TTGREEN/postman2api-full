# postman2api 项目协作规则

## 安全边界

- 不读取、打印或提交 `.env`、`.env.*`、`data/`、`runtime/`、`tokens/`、SQLite 数据库、日志和任何账号凭据。
- 不清理、重置或强制覆盖用户运行数据；发布包更新必须保留目标目录已有 `.env` 和 `data/`。
- `E:\反代\postman2api` 是唯一源码树；`E:\反代\反代完整版` 是由发布脚本生成的可部署包，不手工维护为第二套源码。

## 目录契约

- 目录规则以 `.project-structure.json` 为准。
- 后端源码放在 `src/`；前端源码放在 `dashboard/src/`；注册自动化独立子包放在 `packages/postman-register/`。
- 脚本按职责放在 `scripts/workers/`、`scripts/smoke/`、`scripts/e2e/`、`scripts/ops/`、`scripts/labs/`。
- 测试放在 `tests/`；长期说明和整理方案放在 `docs/`。
- 本地运行物和生成物只允许在已忽略目录中存在：`data/`、`runtime/`、`.test-state/`、`dashboard/dist/`、`node_modules/`。

## 验证命令

- 结构审计：`python C:\Users\Administrator\.codex\skills\govern-project-structure\scripts\audit_project_layout.py E:\反代\postman2api`
- 类型检查：`bun run typecheck`
- 核心回归：`bun test tests/regressions.test.ts --timeout 30000`
- 发布包生成：`bun run release:package`

## Postman MCP 规则

- 默认纯聊天模式：`POSTMAN_OFFICIAL_MCP_ENABLED=false`。
- 只有已在 Postman 官方界面配置 MCP 服务时，才允许开启 `POSTMAN_OFFICIAL_MCP_ENABLED=true` 并发送 `clientTools.thirdParty`。
