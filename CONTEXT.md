# Maze Agent Harness

本项目研究两个进化智能体如何在可信的迷宫竞技环境中自主改进各自的 DeepSeek Harness 原生插件，并通过可重复评测观察双方能力的演进。

## Language

**迷宫竞技场（Maze Arena）**:
执行比赛、验证规则、计分并保存权威事件记录的可信环境；不属于任何参赛方。
_Avoid_: Web 迷宫、裁判插件

**进化编排器（Evolution Orchestrator）**:
代表竞技场启动双方进化智能体、冻结进化代输入、接收候选版本并驱动评测与晋级的可信协调者。
_Avoid_: 主智能体、调度 Agent

**实验（Experiment）**:
一组冻结规则、模型配置、资源预算和初始插件版本下，从基线验收到停止条件满足为止的完整进化运行。
_Avoid_: 项目、Session、单场比赛

**模型配置档（Model Profile）**:
创建实验时选择的模型提供方、模型标识、推理和采样参数、上下文预算及凭据引用；实验启动后保持冻结。
_Avoid_: API Key、Harness Profile、智能体身份

**生成进化智能体（Generator Evolution Agent）**:
只负责分析比赛结果并自主改进生成器插件的智能体。
_Avoid_: 迷宫生成智能体、生成算法

**求解进化智能体（Solver Evolution Agent）**:
只负责分析比赛结果并自主改进求解器插件的智能体。
_Avoid_: 迷宫求解智能体、求解算法

**生成器插件（Generator Plugin）**:
由生成进化智能体自主迭代的 DeepSeek Harness 原生插件，向隔离比赛 Profile 注册确定性的迷宫生成能力。
_Avoid_: 生成智能体、Harness 外部算法模块

**求解器插件（Solver Plugin）**:
由求解进化智能体自主迭代的 DeepSeek Harness 原生插件，向隔离比赛 Profile 注册只能使用局部观察的迷宫求解能力。
_Avoid_: 求解智能体、Harness 外部算法模块

**可安装运行载荷（Installable Runtime Payload）**:
从候选插件包中构建并加载到正式比赛 Profile 的清单、bundle 和运行源码集合；不包含测试、文档或 `lineage/` 策略资料，并使用独立文件数与体积配额。`lineage/` 仅按每次尝试新增条目限制，不受累计载荷配额约束。
_Avoid_: 整个插件仓库、构建缓存、谱系审计资料

**比赛 Profile（Match Profile）**:
加载固定版本的 DeepSeek Harness、无权威状态的最小协议适配插件和一个生成器或求解器插件，但不加载模型适配器或 Agent Loop 的隔离运行组合；整个子进程均视为不可信。
_Avoid_: 进化智能体 Session、普通 headless Profile

**比赛（Match）**:
一对确定版本的生成器插件与求解器插件，在确定规则、输入和资源预算下完成的一次可回放对抗。
_Avoid_: 对话、任务、Session

**配对评测（Paired Evaluation）**:
候选版本与当前冠军在完全相同的当代种子和资源预算下分别运行，以比较版本变化造成的差异。
_Avoid_: A/B 测试、单局胜负

**评测案例（Evaluation Case）**:
由角色、对手版本、种子、规则和资源预算共同确定，并供候选与当前冠军配对运行的最小比较单元。
_Avoid_: 测试用例、迷宫种子

**活跃对手池（Active Opponent Pool）**:
日常候选评测使用的有界版本集合，由基线、当前冠军、近期冠军和确定性选出的历史强敌组成。
_Avoid_: 全部历史、当前对手

**候选版本（Candidate Version）**:
进化智能体产生、尚未通过完整评测与晋级判定的插件版本。
_Avoid_: 新插件、实验代码

**基线版本（Baseline Version）**:
实验开始前通过验收且永久只读的原始 Harness 插件提交，是插件谱系和跨实验比较的共同起点。
_Avoid_: 第一个冠军、模板代码

**冠军版本（Champion Version）**:
当前已通过晋级规则、代表某一参赛方参与后续基准和对抗的插件版本。
_Avoid_: 最新版本、最终版本

**晋级标签（Promotion Tag）**:
由可信进化编排器在候选版本晋级后创建、命名为 `promotion/<experiment-id>/<role>/gNNNN` 并指向对应提交的附注 Git 标签；其标签对象和元数据摘要由 SQLite 保存，以检测删除、移动或替换。
_Avoid_: 分支、冠军引用、候选标签

**策略记录（Strategy Journal）**:
由某一进化智能体在 `lineage/` 中只追加维护并纳入版本谱系的长期实验记忆，记录其假设、计划、修改意图和后续方向；权威评测结果由 SQLite 保存并通过候选身份关联。
_Avoid_: Session 历史、思维链

**插件谱系（Plugin Lineage）**:
某一参赛方从基线版本开始形成的不可变候选提交及冠军引用历史。
_Avoid_: 主仓库历史、Harness Session 历史

**基线验收（Baseline Validation）**:
正式自治运行前，由操作员监督确认插件协议、隔离、评测、事件记录和晋级流程均可正确工作的准备阶段。
_Avoid_: 第零代、人工晋级

**进化代（Evolution Generation）**:
以冻结的双方冠军版本为起点，双方分别产生候选版本并完成评测，最后统一执行晋级判定的一轮自主改进。
_Avoid_: 回合、比赛轮次

**晋级（Promotion）**:
候选版本通过全部硬性门禁并在同组评测中明确优于当前冠军后，成为新冠军版本的状态变化。
_Avoid_: 发布、部署、采用最新版本

**公开评测集（Public Evaluation Suite）**:
向进化智能体公开完整比赛轨迹和指标、用于诊断与改进的固定评测集合。
_Avoid_: 训练集

**隐藏评测集（Hidden Evaluation Suite）**:
具有稳定 `evaluationSuiteId`，不向进化智能体披露种子和完整轨迹、仅以汇总结果参与晋级判定的评测集合。
_Avoid_: 私有测试、秘密迷宫

**密封组（Seal Group）**:
由所有共享同一 `evaluationSuiteId` 的原实验和比较克隆组成的生命周期边界；组内任一解封对全组不可逆生效，并永久终止所有成员及后续副本的进化资格。
_Avoid_: 单个实验状态、访问控制组、实验标签

**兼容性指纹（Compatibility Fingerprint）**:
由引擎、Match Profile、竞技场桥接协议、评分、迷宫规格和资源策略版本共同形成，决定两个实验的结果能否直接比较。
_Avoid_: 应用版本、Git commit

**评测缓存（Evaluation Cache）**:
仅保存已通过确定性复检的完整比赛结果，并由全部比赛输入与兼容性信息共同寻址的可信缓存。
_Avoid_: Web 缓存、临时结果

**合法迷宫（Valid Maze）**:
满足竞技场规定的网格、入口、出口和资源约束，且全部单元格属于同一连通分量的迷宫。
_Avoid_: 可生成迷宫

**结构新颖度（Structural Novelty）**:
以迷宫通道边集合相对历史迷宫的距离衡量的拓扑差异，只在合法性和对抗难度之后参与生成器比较。
_Avoid_: 随机性、视觉差异

**比赛事件（Match Event）**:
竞技场按单调序号保存的权威状态变化；直播与回放均由同一事件序列投影得到。
_Avoid_: UI 帧、日志行

**实验审计事件（Experiment Audit Event）**:
记录实验启动、候选失败、晋级、暂停和终止等控制事实，并允许包含真实发生时间的权威事件。
_Avoid_: 比赛步骤、控制台日志

**展示局（Showcase Match）**:
每个进化代中被选中用于实时动画展示的公开比赛；其播放方式不改变正式评测和计分。
_Avoid_: 决胜局、唯一评测局

**非评分展示局（Unrated Exhibition Match）**:
由操作员在任意归档生成器和求解器之间发起的公开对战，可直播和回放但不改变任何实验结果。
_Avoid_: 补赛、人工评测

**解封（Unseal）**:
密封组内所有实验停止后，由所有者显式公开隐藏评测事实的不可逆操作；解封状态对整个密封组生效，组内实验及后续副本均不能继续进化。
_Avoid_: 查看回放、查看公开评测

**比较克隆（Comparison Clone）**:
复用基线、兼容性指纹、`evaluationSuiteId` 和密封评测套件，但采用独立模型配置与审计链的新实验；它继承原密封组状态，不能独立解封或重新密封。
_Avoid_: 继续实验、复制数据库

**延续分支（Continuation Fork）**:
从选定冠军版本开始并使用新隐藏主种子的新实验，可采用不同冻结配置继续探索。
_Avoid_: 恢复实验、强制继续
