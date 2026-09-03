# 在隔离 Harness 比赛 Profile 中运行原生插件

正式比赛为每个固定插件版本启动一次性容器和最小 DeepSeek Harness Match Profile，只加载无权威状态的最小协议适配插件及一个 Generator Plugin 或 Solver Plugin，不加载模型适配器或 Agent Loop；整个 Match Profile 子进程均视为不可信。Arena Server 只向其发送当前动作所需的最小输入，严格验证每个关联输出，并独立持有完整拓扑、隐藏状态、事件和评分权威。该方式保留 Harness 原生插件生命周期与组合语义，同时隔离故障、资源和对手，并确保比赛期间不调用模型。
