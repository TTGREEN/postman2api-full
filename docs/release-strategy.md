# 发布策略

## 默认同步方式

日常修复只同步源码到 GitHub：

1. 修改源码、文档或测试。
2. 运行 `bun run ci:check`。
3. 提交并推送 `main`。
4. 不生成 `反代完整版`，不生成 zip，不上传 LFS 完整包。

## 完整包

只有维护者明确要求“更新完整版 / 打包 / 发新版包”时，才运行：

```bash
bun run release:package
```

完整包必须保留目标用户已有 `.env` 和 `data/`，不得把 `.env`、数据库、tokens 或日志打进源码分支。

## 分支约定

- `main`：源码、文档、测试、CI、协作模板。
- `release/vX.Y.Z-full-package`：可选完整包 LFS 资产。
- tag `vX.Y.Z`：对应某次源码状态。

不要把完整包 PR 合并回 `main`。
