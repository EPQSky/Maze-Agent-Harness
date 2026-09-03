# 04 — 正式启动、停止与状态检查

**What to build:** 让操作员通过 `start`、`stop` 和 `status` 管理使用生产 Web 构建、真实 Server 配置及标准用户数据目录的本机 Maze Arena，而不依赖 Vite 开发服务器或 Fake Harness。

**Blocked by:** 02 — 本地构建并锁定 Match Profile 镜像；03 — 显式同步 Harness 模型目录

**Status:** ready-for-agent

- [ ] `start` 在完整 `doctor` 预检通过后启动生产 Server 和 Web，并只绑定回环地址。
- [ ] 正式进程使用标准数据、状态和配置目录，加载摘要锁定镜像及有效模型目录，不读取源码仓库中的开发数据库。
- [ ] `status` 报告进程、HTTP 健康状态、数据库位置、Harness 身份、模型目录版本和镜像摘要。
- [ ] `stop` 等待服务安全关闭，并且不会在活动原子步骤中途破坏数据库或插件谱系。
- [ ] 重复执行 `start`、`stop` 和 `status` 具有稳定幂等结果，并能处理陈旧进程标识和异常退出。
- [ ] 正式日志提供可诊断错误，同时净化 API Key、凭据环境变量和其他已知秘密。
