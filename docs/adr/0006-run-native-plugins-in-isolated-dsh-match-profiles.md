# 在隔离 Harness 比赛 Profile 中运行原生插件

正式使用保持本机单用户部署，可信 Arena Server、进化编排器、SQLite 与插件谱系运行在宿主机；不把控制面放入需要 Docker Socket 或等价容器管理权限的应用容器。正式比赛为每个固定插件版本启动一次性容器和最小 DeepSeek Harness Match Profile，只加载无权威状态的最小协议适配插件及一个 Generator Plugin 或 Solver Plugin，不加载模型适配器或 Agent Loop；整个 Match Profile 子进程均视为不可信。比赛镜像在本机安装时从已锁定的 Harness 源码和项目产物构建，启动配置记录并只接受实际 SHA-256 摘要，禁止使用浮动标签或在启动时从远程自动更新。Arena Server 只向其发送当前动作所需的最小输入，严格验证每个关联输出，并独立持有完整拓扑、隐藏状态、事件和评分权威。该方式保留 Harness 原生插件生命周期与组合语义，同时隔离故障、资源和对手，并确保比赛期间不调用模型；代价是正式安装需要同时管理宿主机服务与摘要锁定的比赛镜像，而不是用单个 Compose 应用容器覆盖全部进程。
