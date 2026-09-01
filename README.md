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
