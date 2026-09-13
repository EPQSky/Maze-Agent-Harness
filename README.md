# Maze Arena

本机单用户的迷宫进化实验工作台。

## 环境

- Node.js 22.12 或更高的 Node.js 22 版本
- pnpm 10
- 支持非特权用户 PID namespace 的 Linux，以及 util-linux `/usr/bin/unshare`

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

正式运行只在操作员显式执行 `install` 时通过 npm 安装精确版本的官方 DSH 包。当前正式验收版本为 `@deepseek-ai/dsh@0.1.2-rc.1`：

```bash
pnpm build
pnpm arena install --dsh-version 0.1.2-rc.1
pnpm arena image build \
  --base-image 'node@sha256:<64-character-digest>' \
  --image-name maze-arena/match-profile:local
pnpm arena models sync
pnpm arena doctor
pnpm arena start
pnpm arena status
pnpm arena stop
```

默认安装清单位于 `~/.config/maze-arena/install-manifest.json`，用户凭据文件位于 `~/.config/maze-arena/env`，运行数据目录位于 `~/.local/share/maze-arena/`，日志与进程状态目录位于 `~/.local/state/maze-arena/`。命令遵守 `XDG_CONFIG_HOME`、`XDG_DATA_HOME` 和 `XDG_STATE_HOME` 覆盖；清单记录 npm 包名、精确包版本、私有冻结 runtime 载荷摘要和入口 SHA-256，不保存 API Key。`latest`、dist-tag、SemVer 范围以及 `file:`、Git、URL 来源均被拒绝。

npm 下载只允许发生在显式 `install`。`doctor`、`models sync`、`image build`、`start` 和实验运行不会下载或升级 DSH，也不要求 Harness 源码、Git checkout 或外部 `dsh`；它们只复用 Arena 私有的内容寻址冻结 runtime。

`image build` 只接受带完整 SHA-256 摘要的基础镜像，使用冻结 Harness runtime 和当前可信项目构建产物在本机构建 Match Profile 镜像。Docker 返回的实际镜像 ID 会作为不可变引用写入安装清单；正式 `doctor` 会拒绝缺失、被替换或构建身份漂移的镜像，并检查 Docker 的 seccomp 与 cgroup namespace 安全能力。

`start` 必须在完整 `doctor` 预检通过后启动生产 Server 和已构建 Web，并只监听 `127.0.0.1`。`status` 报告进程、HTTP、数据库、Harness、模型目录与镜像身份；`stop` 会等待活动原子步骤安全结束。重复执行这些命令是幂等的，默认端口为 `3000`，可通过 `MAZE_ARENA_PORT` 选择其他本机端口。

每次正式 Harness 调用都运行在独立 PID namespace 中；namespace init 退出时由内核终止其中全部派生工具进程。`doctor` 无法建立该边界时会关闭失败，系统不会降级为仅依赖进程组的运行方式。

## Harness 模型导出

先运行 `maze-arena models sync`，再让 Server 通过 `ARENA_MODEL_CATALOG_PATH` 读取同步目录中的 `current/catalog.json`，并设置精确的 `DSH_HARNESS_VERSION`。目录由锁定的 Harness 显式导出并原子发布，顶层结构固定为：

```json
{
  "schemaVersion": 1,
  "harnessVersion": "<精确版本>",
  "credentialRefs": ["dsh-credential://EXAMPLE_CRED"],
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

## 自定义模型与凭据

模型、端点和凭据环境变量名配置在 `~/.local/share/maze-arena/harness/settings.yaml`。该文件使用官方 DSH 支持的严格 JSON 子集；例如配置一个 OpenAI 兼容端点：

```json
{
  "llm-pi-ai": {
    "providers": {
      "my-provider": {
        "displayName": "My Provider",
        "apiKeyEnv": "MY_MODEL_API_KEY",
        "baseURL": "https://gateway.example/v1",
        "api": "openai-completions",
        "models": [
          {
            "id": "my-model",
            "name": "My Model",
            "contextWindow": 32000,
            "maxTokens": 4000
          }
        ]
      }
    }
  },
  "maze-arena-cost-policy": {
    "id": "pi-ai-configured-cost-v1",
    "multipliers": {
      "my-provider/my-model": 1
    }
  }
}
```

API Key 写入安装时创建的 `~/.config/maze-arena/env`：

```dotenv
MY_MODEL_API_KEY=replace-with-your-key
```

该文件只接受当前冻结模型目录已登记的 `apiKeyEnv` 名称以及对应的 `NAME=value` 字面量、空行和注释。凭据名必须使用全大写 POSIX 名称并以 `_API_KEY` 或 `_CRED` 结尾；Arena、DSH、Node、包管理器、动态加载器、TLS/HTTP 工具等保留运行命名空间即使满足后缀也会被拒绝。文件不执行 `export`、引号、变量展开、命令替换或多行 shell 语法，必须是当前用户拥有的普通文件且权限严格为 `0600`；同名进程环境变量优先于文件值。修改 `settings.yaml` 中的模型或凭据名称后，必须先重新同步冻结目录再启动：

```bash
chmod 600 ~/.config/maze-arena/env
pnpm arena stop
pnpm arena models sync
pnpm arena start
```

实验或金丝雀中的 Provider、Model 和凭据引用分别使用 `my-provider`、`my-model` 和 `dsh-credential://MY_MODEL_API_KEY`。凭据不会写入模型目录、安装清单、进程状态、日志、备份或命令行；正式 DSH 会话只通过私有 FD 4 接收当前模型所需的值。
