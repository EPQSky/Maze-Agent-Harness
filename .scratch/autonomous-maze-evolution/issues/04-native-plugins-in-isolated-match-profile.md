# 04 — 原生插件隔离比赛

**What to build:** 将基线 Generator Plugin 和 Solver Plugin 实现为可安装的 DeepSeek Harness 原生插件，并在一次性不可信 Match Profile 容器中完成真实比赛。Arena Server 只发送当前动作所需的最小输入，独立验证输出并保持全部裁判权威。

**Blocked by:** 02 — 可配置模型与 Harness 适配层；03 — 基线迷宫直播与回放

**Status:** done

- [x] 两个插件包均通过 `dsh.bundle` 安装，在 `apply(ctx)` 中注册且只注册一个角色专用能力，并能正确卸载。
- [x] 正式 Match Profile 不加载模型适配器、Agent Loop、编辑器、命令行或无关工具，容器以非 root、无网络和只读可信挂载运行。
- [x] 最小协议适配插件不持有完整拓扑、隐藏评测、评分或历史状态；Solver Plugin 永远只收到局部观察且不收到生成种子。
- [x] Arena Server 对每个请求只接受一个不超过 16 KiB 的关联输出，并拒绝额外字节、乱序、超限、非法模式和非法领域动作。
- [x] 黑盒测试覆盖插件加载失败、重复能力、stdout 污染、全局状态干扰、超时、非零退出和 OOM，并证明权威状态不受同进程插件影响。
- [x] 可安装运行载荷、辅助工程资料和逐次 `lineage/` 条目分别按冻结配额验证，文档和谱系资料不进入构建产物。
