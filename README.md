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

## 正式安装预检

正式运行由操作员提供已经检出并固定提交的 DeepSeek Harness 源码，以及与其对应的 `dsh` 可执行文件；命令不会下载、克隆或升级 Harness：

```bash
pnpm build
pnpm arena install \
  --harness-source /absolute/path/to/deepseek-harness \
  --harness-commit <40-character-git-commit> \
  --dsh-executable /absolute/path/to/dsh \
  --dsh-version '<exact-dsh-version-output>'
pnpm arena image build \
  --base-image 'node@sha256:<64-character-digest>' \
  --image-name maze-arena/match-profile:local
pnpm arena doctor
```

默认安装清单位于 `~/.config/maze-arena/install-manifest.json`，运行数据目录位于 `~/.local/share/maze-arena/`，日志与进程状态目录位于 `~/.local/state/maze-arena/`。命令遵守 `XDG_CONFIG_HOME`、`XDG_DATA_HOME` 和 `XDG_STATE_HOME` 覆盖；清单只记录 Harness 源码提交、可执行文件 SHA-256 和精确版本，不保存 API Key。

`image build` 只接受带完整 SHA-256 摘要的基础镜像，使用已校验的 Harness 提交、`dsh` 可执行文件和当前可信项目构建产物在本机构建 Match Profile 镜像。Docker 返回的实际镜像 ID 会作为不可变引用写入安装清单；正式 `doctor` 会拒绝缺失、被替换或构建身份漂移的镜像，并检查 Docker 的 seccomp 与 cgroup namespace 安全能力。

## Harness 模型导出

先运行 `maze-arena models sync`，再让 Server 通过 `ARENA_MODEL_CATALOG_PATH` 读取同步目录中的 `current/catalog.json`，并设置精确的 `DSH_HARNESS_VERSION`。目录由锁定的 Harness 显式导出并原子发布，顶层结构固定为：

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
