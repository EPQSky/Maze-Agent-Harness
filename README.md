# Maze Arena

本机单用户的迷宫进化实验工作台。

## 环境

- Node.js 22.12 或更高的 Node.js 22 版本
- pnpm 10

## 命令

```bash
corepack enable
pnpm install
pnpm build
pnpm test
pnpm typecheck
pnpm dev
```

开发服务器默认在 `http://localhost:5173` 提供工作台，并将 `/api` 请求代理到 `http://localhost:3000`。Arena Server 默认把 SQLite 数据保存到 `.data/maze-arena.sqlite`，可通过 `ARENA_DATABASE_PATH` 覆盖。

## Harness 模型导出

Server 启动前必须设置 `DSH_HARNESS_EXPORT_PATH` 和精确的 `DSH_HARNESS_VERSION`。导出文件由外部 Harness 配置流程只读生成，顶层结构固定为：

```json
{
  "schemaVersion": 1,
  "harnessVersion": "<精确版本>",
  "credentialRefs": ["dsh-credential://example"],
  "providers": [{
    "id": "provider-id",
    "label": "Provider",
    "models": [{
      "id": "model-id",
      "label": "Model",
      "capabilities": {
        "reasoningEfforts": [],
        "maxContextTokens": 8000,
        "maxOutputTokens": 1000,
        "maxTotalTokens": 9000,
        "providerOptions": {}
      }
    }]
  }]
}
```

`providers` 必须包含至少一个带能力声明的模型。`credentialRefs` 只保存注册引用，不得包含 API Key 等凭据内容。文件缺失、版本不匹配或结构无效时 Server 会关闭失败；确定性 Fake Harness 仅由自动测试显式注入。
