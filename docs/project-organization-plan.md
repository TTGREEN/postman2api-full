# 项目整理方案（已落地）

> 状态：已执行已确认整改；后续只剩可选深拆。
> 审查时间：2026-08-17 15:57 Asia/Shanghai
> 审查对象：`E:\反代\postman2api`
> 当前基线：`main` / `6c9fa5ffa1e304796c2a970fa59c9a2e3e6b1732`

## 0. 安全备份

本次整理前已创建安全备份，排除了 `.env`、`.env.*`（保留 `.env.example`）、`.git`、`node_modules/`、`dashboard/dist/`、`data/`、`runtime/`、`.test-state/`、`tokens/`、日志和 SQLite 数据库文件。

- 备份目录：`E:\反代\backups\postman2api-safe-backup-20260817-155713`
- 备份压缩包：`E:\反代\backups\postman2api-safe-backup-20260817-155713.zip`
- 备份内容：安全工作树、`tracked-diff.patch`、`git-status.txt`、`untracked-files.txt`、`BACKUP_MANIFEST.json`
- 校验结果：敏感/运行目录命中数为 `0`

## 执行状态

- Phase 1 冻结与分组：已完成，见 `docs/phase1-change-groups.md`。
- Phase 2 目录契约：已启用 `.project-structure.json`，结构审计通过。
- Phase 3 大文件拆分：已完成第一刀，`Header`、`Toast`、登录日志面板、账号测试日志面板已拆至 `dashboard/src/components/AppChrome.tsx`。
- Phase 4 旧 synthetic 自动化实验室：已从产品路由、前端 API、Worker 分支、脚本和测试中下线；真实上游注册路径保留。
- Phase 4 脚本分层：已迁移为 `scripts/workers/`、`scripts/smoke/`、`scripts/e2e/`、`scripts/ops/`、`scripts/labs/`，并修正运行时引用。
- Phase 5 发布包治理：已新增 `scripts/ops/create-release-package.ps1` 和 `release:package`，发布包默认输出到 `E:\反代\反代完整版` / `E:\反代\反代完整版.zip`；如旧 artifact 已存在，会先重命名备份；排除敏感与运行数据；如 `runtime/` 存在可复制浏览器资产则按 manifest 纳入。当前本机 `runtime/` 仅有日志，已被发布规则排除，manifest 记录 `runtimeIncluded=false`。
- 当前验证：`bun run typecheck` PASS；相关 54 项测试 PASS；`bun run build` PASS；结构审计 PASS；发布脚本 DryRun PASS。

## 1. 当前项目判断

- 项目类型：brownfield 前后端混合项目。
- 后端入口：`src/index.ts`，Bun + Hono + SQLite/Drizzle。
- 前端入口：`dashboard/`，Vite + React。
- 自动化子包：`packages/postman-register/`，Postman 注册浏览器自动化。
- 测试根目录：`tests/`，Bun test 为主。
- 运维脚本：`scripts/`。
- 文档：`docs/`。
- 本地/生成/敏感目录：`data/`、`runtime/`、`.test-state/`、`dashboard/dist/`、`node_modules/`、`tokens/`，均不应进入源码整理或发布包。

## 2. 主要问题

### 2.1 工作区改动过大

当前存在大量已修改和未跟踪文件，混合了：

1. 真实上游注册运行时与 Worker。
2. 自动化实验室 UI 与任务历史。
3. Turnstile / Cloudflare 诊断与稳定性改动。
4. 数据库 schema/migration。
5. 测试账本和新增回归测试。
6. 部署/冒烟/实验脚本。

风险：继续直接开发会让后续提交、回滚和定位问题变困难。

### 2.2 大文件边界不清晰

需要优先拆分或建立边界的文件：

- `dashboard/src/App.tsx`：约 1248 行，已经包含过多页面/状态/布局职责。
- `packages/postman-register/src/selectors/postman.ts`：约 937 行，混合注册、验证码、Turnstile、onboarding、upgrade、AI 设置等选择器和等待逻辑。
- `src/automation-lab/registration-runtime.ts`：约 449 行，承担持久化、Worker 协议、进程生命周期、WebSocket 发布、错误处理等多重职责。
- `dashboard/src/index.css`：约 299 行，已开始承载自动化实验室较多样式，后续可按组件拆分或建立分段约定。

### 2.3 发布包和源码边界混淆

父目录存在：

- `E:\反代\反代完整版`
- `E:\反代\反代完整版.zip`

其中包含 `.env`、`node_modules/`、`data/`、`runtime/` 等本地/敏感/生成内容。后续“完整版”应由已验证 commit 生成，不应作为第二套可手工维护源码树。

### 2.4 缺少目录契约

结构审计器曾提示缺少 `.project-structure.json`。当前正式契约已启用；原草案已归档到 `docs/archive/project-structure-draft-20260817.json`。

## 3. 建议目录职责

| 路径 | 职责 | 不应放入 |
|---|---|---|
| `src/` | 后端主应用、API、认证、代理、数据库、自动化实验室运行时 | 前端组件、一次性调试脚本、真实数据库 |
| `dashboard/` | 前端应用源码、Vite 配置、前端本地依赖 | 后端运行时、数据库、发布压缩包 |
| `packages/postman-register/` | Postman 注册自动化子包，可独立 typecheck/运行 | 宿主 API、管理台 UI、真实 token |
| `scripts/` | Worker 入口、smoke、E2E、安装和部署辅助脚本 | 长期业务逻辑、真实凭据、生成数据 |
| `tests/` | 自动化测试和测试夹具 | 真实账号数据、手工运行日志 |
| `docs/` | 架构说明、操作说明、整理方案、契约说明 | 自动生成的大体积报告、真实凭据 |
| `.test-orchestrator/` | 共享测试计划和测试选择契约 | 测试证据、浏览器 profile、数据库 |
| `.test-state/` | 本地测试状态和证据，已忽略 | 需要提交的源代码 |
| `data/` | 本地运行数据库，已忽略 | 测试夹具和发布内容 |
| `runtime/` | 本地运行时资产，已忽略；仅在发布脚本生成 artifact 时按 manifest 纳入 | 源代码、测试状态、真实凭据 |

## 4. 分批整理路线

### Phase 1：冻结当前可运行状态

目标：在不改结构的前提下，把当前工作区变成可审查状态。

建议动作：

1. 保留本次安全备份。
2. 跑并记录当前已通过的最小验证：`bun run typecheck`、注册运行时测试、任务历史视图测试、Postman 注册逻辑测试。
3. 按主题拆分提交或至少生成分组 diff：
   - 注册自动化核心。
   - 自动化实验室 UI/API/任务历史。
   - Turnstile 诊断和人机校验稳定性。
   - 数据库迁移/schema。
   - 测试与脚本。

### Phase 2：启用目录契约

目标：让结构规则变成可审计资产。

建议动作：

1. 正式契约维护在 `.project-structure.json`。`docs/archive/project-structure-draft-20260817.json` 仅保留历史参考。
2. 在 README 或 AGENTS 中记录审计命令：
   - `python C:\Users\Administrator\.codex\skills\govern-project-structure\scripts\audit_project_layout.py E:\反代\postman2api`
3. 后续结构变化先更新契约，再运行结构审计。

### Phase 3：拆大文件，不改变行为

目标：降低后续改动风险。

建议优先级：

1. `dashboard/src/App.tsx`
   - 已有 `dashboard/src/components/AutomationLab.tsx`，继续把账号、设置、统计、布局组件拆出。
   - 保留 `App.tsx` 为路由/顶层状态协调。
2. `packages/postman-register/src/selectors/postman.ts`
   - 拆为：`selectors/signup.ts`、`selectors/verify.ts`、`selectors/turnstile.ts`、`selectors/onboarding.ts`、`selectors/upgrade.ts`。
   - 保留 `selectors/postman.ts` 作为短期 re-export 兼容层，后续再删。
3. `src/automation-lab/registration-runtime.ts`
   - 拆出 Worker 协议解析、持久化 snapshot、进程生命周期管理。

每次拆分只做移动/导出，不改行为；每次拆完跑受影响测试。

### Phase 4：下线旧本地模拟模块与脚本分层

目标：先删除/下线旧本地模拟自动化入口，再降低 `scripts/` 混杂度。

确认决策：旧 `automation-lab` synthetic UI/接口彻底下线。执行时已定位并移除旧路由、旧 UI、旧 worker 和旧测试入口；保留真实上游注册路径。测试需要的模拟能力不再作为产品功能暴露。

建议映射：

| 当前文件类型 | 建议归类 |
|---|---|
| `*-worker.ts` | `scripts/workers/` |
| `*-smoke.ts` | `scripts/smoke/` |
| `*-e2e.ts` / `*.ps1` | `scripts/e2e/` |
| `install-*` / `run-*` / `health-*` | `scripts/ops/` |
| `turnstile-*-lab.ts` | `scripts/labs/` |

执行结果：已删除旧 synthetic UI/API/worker/test 入口；真实上游注册任务仍走 `/api/registration` 和 `src/automation-lab/registration-runtime.ts`。脚本已完成分层，运行时 Worker 路径同步到 `scripts/workers/registration-worker.ts`。

### Phase 5：发布包治理

目标：避免“完整版”成为第二套源码。

执行结果：

1. 已新增 `scripts/ops/create-release-package.ps1`。
2. 已新增 `package.json` 脚本：`bun run release:package`。
3. 发布脚本排除：`.env`、`.env.*`、`.git`、`node_modules/`、`dashboard/node_modules/`、`data/`、`.test-state/`、`tokens/`、SQLite 数据库和日志。
4. 发布脚本可复制本地 `runtime/` 浏览器资产，并在 `RELEASE_MANIFEST.json` 记录是否包含、文件数、总大小和目录哈希；旧输出目录/zip 存在时先备份再生成。当前本机 `runtime/` 只有日志文件，发布脚本按规则排除，因此本次生成包 manifest 为 `runtimeIncluded=false`。
5. 发布包内生成 `一键部署.ps1`，负责安装依赖、构建前端、初始化数据库；不复制真实运行数据库或凭据。

## 5. 后续可选深拆

- `packages/postman-register/src/selectors/postman.ts` 仍建议继续拆为 signup / verify / turnstile / onboarding / upgrade 选择器模块。
- `src/automation-lab/registration-runtime.ts` 仍可继续拆出 Worker 协议、持久化 snapshot、进程生命周期管理。
- `dashboard/src/index.css` 可按自动化实验室、账号页、通用布局分段或拆文件。
- `反代完整版` 应继续由发布脚本生成，不作为第二套源码手工维护。

## 6. 已确认决策

1. “自动化实验室本地模拟旧模块”彻底下线：旧 `automation-lab` synthetic UI/接口、worker、测试入口已删除；真实上游注册任务、真实任务历史、Worker 运行时保留。测试层如需模拟，应只作为测试夹具/adapter，不再作为产品 UI 或公开接口暴露。
2. `packages/postman-register/` 继续作为独立子包：后续整理应减少宿主 `src/` 对其 `src/*` 深层路径的直接依赖，逐步改成包级导出或明确的 integration adapter。
3. 后续发布包需要包含本地 `runtime/` 浏览器资产：`runtime/` 仍不作为源码提交内容，但发布脚本应支持把已验证的本地浏览器运行时复制进 release artifact，并在 manifest 中记录来源、大小、校验和和排除策略。
