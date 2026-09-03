# 将生成器和求解器实现为原生 Harness 插件

Generator Plugin 与 Solver Plugin 本身都是可安装、可由 Profile 加载并通过 `apply(ctx)` 注册能力的 DeepSeek Harness 原生插件，也是两个进化智能体自主修改和版本化的完整产物。Maze Arena 只拥有稳定的生成与求解能力约定以及可信评测桥接，不把算法拆成 Harness 外部模块；这使实验直接观察智能体能否持续进化真实 Harness 插件。
