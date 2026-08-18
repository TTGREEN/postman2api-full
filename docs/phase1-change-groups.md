# Phase 1 改动分组与执行基线

> 状态：已执行 Phase 1 冻结与分组。
> 时间：2026-08-17 Asia/Shanghai
> 分支：`main`
> HEAD：`6c9fa5ffa1e304796c2a970fa59c9a2e3e6b1732`
> 安全备份：`E:\反代\backups\postman2api-safe-backup-20260817-155713.zip`

## 1. 验证基线

本阶段没有移动或删除代码。已执行当前整理前的最小相关验证：

| 命令 | 结果 |
|---|---|
| `bun run typecheck` | PASS |
| `bun test tests/postman-register-logic.test.ts tests/registration-runtime.test.ts tests/registration-job-view.test.ts tests/automation-lab.test.ts tests/registration-pipeline.test.ts tests/turnstile-verification.test.ts` | PASS，46 pass / 0 fail |

说明：本次验证覆盖注册自动化逻辑、任务历史刷新、注册运行时持久化、旧 synthetic 自动化测试、pipeline 适配器和 Turnstile 服务端校验。

## 2. 推荐提交/整理分组

### Group A：项目治理文档与目录契约

职责：只记录整理计划和目录规则，不改变运行行为。

建议包含：

- `.project-structure.json`（草案已归档到 `docs/archive/project-structure-draft-20260817.json`）
- `docs/project-organization-plan.md`
- `docs/phase1-change-groups.md`

建议提交名：`docs: record project organization plan`

后续动作：确认后复制/收敛为正式 `.project-structure.json`，并运行结构审计。

### Group B：自动化实验室真实任务 UI/API

职责：保留真实上游注册任务、任务历史和实时日志；旧 synthetic 产品入口后续下线。

建议包含：

- `dashboard/src/components/AutomationLab.tsx`
- `dashboard/src/lib/registration-jobs.ts`
- `dashboard/src/lib/api.ts`
- `dashboard/src/App.tsx`
- `dashboard/src/index.css`
- `src/api/registration.ts`
- `src/api/automation-lab.ts`（后续删除/下线 synthetic 时再处理）
- `src/automation-lab/registration-runtime.ts`
- `src/automation-lab/registration-types.ts`
- `src/automation-lab/upstream-registration.ts`
- `src/index.ts`

建议提交名：`feat: add persistent upstream registration jobs`

后续动作：先保留当前可运行状态；后续 Phase 中删除旧 synthetic UI/API 前，要再次定位所有引用。

### Group C：注册 Worker 与账号持久化

职责：Node Worker 启动、崩溃诊断、账号 Token 入库、Bun/Node 边界稳定。

建议包含：

- `scripts/registration-worker.ts`
- `scripts/registration-worker-smoke.ts`
- `src/auth/account-persistence.ts`
- `src/auth/postman-login-runtime.ts`
- `src/auth/postman-login.ts`
- `src/db/index.ts`
- `src/db/migrate.ts`
- `src/db/schema.ts`
- `package.json`
- `tsconfig.json`
- `.env.example`

建议提交名：`feat: persist upstream registration accounts`

后续动作：数据库 schema/migration 改动必须和运行时持久化一起审查，避免 UI 已显示但账户未入库。

### Group D：Postman 注册自动化稳定性

职责：临时邮箱、注册、验证码、profile、upgrade、enable AI、浏览器帧稳定性。

建议包含：

- `packages/postman-register/src/config.ts`
- `packages/postman-register/src/core/accountToken.ts`
- `packages/postman-register/src/core/logger.ts`
- `packages/postman-register/src/core/monitor.ts`
- `packages/postman-register/src/core/sleep.ts`
- `packages/postman-register/src/demo.ts`
- `packages/postman-register/src/index.ts`
- `packages/postman-register/src/selectors/tempMail.ts`
- `packages/postman-register/src/steps/signup.ts`
- `packages/postman-register/src/steps/verify.ts`
- `packages/postman-register/src/steps/upgrade.ts`
- `packages/postman-register/src/steps/enableAi.ts`
- `packages/postman-register/src/types.ts`

建议提交名：`fix: harden upstream registration flow`

后续动作：保持 `packages/postman-register/` 独立；后续减少宿主深层 import，改为包级导出或窄 adapter。

### Group E：Turnstile / 人机校验诊断

职责：Turnstile 诊断、浏览器坐标点击、frame 竞态保护、服务端验证/授权模型。

建议包含：

- `packages/postman-register/src/core/turnstileDiagnostics.ts`
- `packages/postman-register/src/selectors/postman.ts`
- `src/security/human-verification-flow.ts`
- `src/security/turnstile.ts`
- `scripts/turnstile-interaction-lab.ts`
- `scripts/turnstile-siteverify-smoke.ts`

建议提交名：`fix: instrument turnstile challenge handling`

后续动作：拆分 `selectors/postman.ts` 时优先把 Turnstile 逻辑抽为独立模块。

### Group F：测试与测试账本

职责：覆盖新增行为，保留状态感知测试计划。

建议包含：

- `.test-orchestrator/test-plan.json`
- `tests/account-import.test.ts`
- `tests/postman-login-runtime.test.ts`
- `tests/postman-login.test.ts`
- `tests/postman-register-logic.test.ts`
- `tests/temp-email-preview.test.ts`
- `tests/automation-lab.test.ts`
- `tests/human-verification-flow.test.ts`
- `tests/registration-job-view.test.ts`
- `tests/registration-pipeline.test.ts`
- `tests/registration-runtime.test.ts`
- `tests/turnstile-verification.test.ts`

建议提交名：`test: cover registration automation runtime`

后续动作：旧 synthetic 产品接口删除时，同步迁移或删除 `tests/automation-lab.test.ts` 中的产品入口测试，只保留测试夹具能力。

### Group G：E2E / 运维 / 实验脚本

职责：手动或半自动验证脚本，不进入核心运行时。

建议包含：

- `scripts/automation-lab-e2e.ps1`
- `scripts/automation-lab-e2e.ts`
- `scripts/automation-lab-worker.ts`（旧 synthetic 下线时优先评估删除）

建议提交名：`chore: add automation lab verification scripts`

后续动作：脚本分层时迁移到 `scripts/e2e/`、`scripts/workers/`、`scripts/labs/` 等目录，迁移前先审计引用。

## 3. 立即执行顺序建议

1. 先处理 Group A，建立治理基线。
2. 再处理 Group B + C，冻结真实上游注册主路径。
3. 再处理 Group D + E，拆分和稳定浏览器自动化逻辑。
4. 再处理 Group F，调整测试结构和测试账本。
5. 最后处理 Group G，并下线旧 synthetic 模块。

## 4. 不建议混合的事项

- 不要把删除旧 synthetic 模块和拆 `postman.ts` 放在同一提交。
- 不要把发布包脚本和 runtime 浏览器资产复制策略混在核心注册修复里。
- 不要在同一批里既移动脚本目录又改脚本行为。
- 不要把 `runtime/`、`data/`、`.test-state/` 纳入源码提交。

## 5. 当前原始状态快照

### `git status --short`

```text
 M .env.example
 M .test-orchestrator/test-plan.json
 M dashboard/src/App.tsx
 M dashboard/src/index.css
 M dashboard/src/lib/api.ts
 M package.json
 M packages/postman-register/src/config.ts
 M packages/postman-register/src/core/accountToken.ts
 M packages/postman-register/src/core/logger.ts
 M packages/postman-register/src/core/monitor.ts
 M packages/postman-register/src/demo.ts
 M packages/postman-register/src/index.ts
 M packages/postman-register/src/selectors/postman.ts
 M packages/postman-register/src/selectors/tempMail.ts
 M packages/postman-register/src/steps/enableAi.ts
 M packages/postman-register/src/steps/signup.ts
 M packages/postman-register/src/steps/upgrade.ts
 M packages/postman-register/src/steps/verify.ts
 M packages/postman-register/src/types.ts
 M src/auth/postman-login-runtime.ts
 M src/auth/postman-login.ts
 M src/db/index.ts
 M src/db/migrate.ts
 M src/db/schema.ts
 M src/index.ts
 M tests/account-import.test.ts
 M tests/postman-login-runtime.test.ts
 M tests/postman-login.test.ts
 M tests/postman-register-logic.test.ts
 M tests/temp-email-preview.test.ts
 M tsconfig.json
?? .project-structure.json
?? dashboard/src/components/
?? dashboard/src/lib/registration-jobs.ts
?? docs/project-organization-plan.md
?? packages/postman-register/src/core/sleep.ts
?? packages/postman-register/src/core/turnstileDiagnostics.ts
?? scripts/automation-lab-e2e.ps1
?? scripts/automation-lab-e2e.ts
?? scripts/automation-lab-worker.ts
?? scripts/registration-worker-smoke.ts
?? scripts/registration-worker.ts
?? scripts/turnstile-interaction-lab.ts
?? scripts/turnstile-siteverify-smoke.ts
?? src/api/automation-lab.ts
?? src/api/registration.ts
?? src/auth/account-persistence.ts
?? src/automation-lab/
?? src/security/
?? tests/automation-lab.test.ts
?? tests/human-verification-flow.test.ts
?? tests/registration-job-view.test.ts
?? tests/registration-pipeline.test.ts
?? tests/registration-runtime.test.ts
?? tests/turnstile-verification.test.ts
```

### `git diff --stat`

```text
 .env.example                                       |   4 +
 .test-orchestrator/test-plan.json                  |  76 +++-
 dashboard/src/App.tsx                              | 167 +------
 dashboard/src/index.css                            |  75 ++++
 dashboard/src/lib/api.ts                           | 138 +++++-
 package.json                                       |   2 +-
 packages/postman-register/src/config.ts            |   4 +-
 packages/postman-register/src/core/accountToken.ts |   3 +-
 packages/postman-register/src/core/logger.ts       |   6 +
 packages/postman-register/src/core/monitor.ts      |  61 ++-
 packages/postman-register/src/demo.ts              |   2 +-
 packages/postman-register/src/index.ts             |   4 +-
 packages/postman-register/src/selectors/postman.ts | 495 ++++++++++++++++-----
 .../postman-register/src/selectors/tempMail.ts     |   6 +
 packages/postman-register/src/steps/enableAi.ts    |  12 +-
 packages/postman-register/src/steps/signup.ts      |   9 +-
 packages/postman-register/src/steps/upgrade.ts     |  49 +-
 packages/postman-register/src/steps/verify.ts      |  25 +-
 packages/postman-register/src/types.ts             |   5 +
 src/auth/postman-login-runtime.ts                  |  16 +-
 src/auth/postman-login.ts                          |  94 +++-
 src/db/index.ts                                    |  31 ++
 src/db/migrate.ts                                  |  35 +-
 src/db/schema.ts                                   |  37 ++
 src/index.ts                                       |  13 +
 tests/account-import.test.ts                       |  18 +-
 tests/postman-login-runtime.test.ts                |   7 +-
 tests/postman-login.test.ts                        |   9 +
 tests/postman-register-logic.test.ts               | 366 ++++++++++++++-
 tests/temp-email-preview.test.ts                   |  23 +
 tsconfig.json                                      |   2 +-
 31 files changed, 1496 insertions(+), 298 deletions(-)
```
