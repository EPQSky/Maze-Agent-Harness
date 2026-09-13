# 12 — 真实 DSH 金丝雀正式验收

**What to build:** 为操作员提供低预算、受监督的正式金丝雀验收，使用已配置的真实 DeepSeek Harness 和模型提供方证明插件确实发生运行载荷变化、可信重建、Docker 配对评测和 Git 审计，并准确报告是否晋级。

**Blocked by:** 04 — 正式启动、停止与状态检查；09 — 闭合一代累积自进化；10 — 展示真实自进化证据；11 — 一致性备份、校验与恢复

**Status:** done

- [x] 验收开始前要求 `doctor`、模型冒烟、正式镜像和完整备份全部通过，并显示预计令牌与成本上限。
- [x] 金丝雀调用真实配置的模型，创建全新 Harness Session，并在允许工作区内产生可安装运行载荷的实际差异。
- [x] 候选由可信步骤重建，并与冠军通过摘要锁定的 Docker Match Profile 完成至少一组可审计配对评测。
- [x] 无论结果为失败、平局或晋级，系统均保存候选提交、代码差异、模型用量、评测结果和准确原因。
- [x] 候选胜出时创建晋级标签并证明下一代起点来自新冠军；未胜出时不得把机制成功误报为算法晋级。
- [x] 验收报告明确区分真实自进化机制已闭环、候选本次是否晋级以及模型不保证持续产生更优算法这三项结论。

## 2026-09-09 正式验收记录

- 正式运行根：`/tmp/maze-ticket12-formal-20260909`；`doctor`、模型冒烟、冻结镜像、完整备份和预算前置均通过。
- 真实 canary：`23f1482a-2056-4741-9d76-c2103f9bf551`；报告：`/tmp/maze-ticket12-formal-20260909/data/maze-arena/canary-reports/23f1482a-2056-4741-9d76-c2103f9bf551.json`。
- 参数：`deepseek-official/deepseek-v4-flash`、`reasoning=off`、`context=256000`、`output=64000`、单次上限 `640000` tokens、成本上限 `5`。
- 结果：smoke 使用 `2488 tokens / 0.00067 / 1 call`；Generator 首次真实 provider 调用以 `provider/UNKNOWN` 失败，Solver 未运行，未产生候选、评测或晋级证据；报告明确为 `mechanismClosed=false`、`promoted=false`、`formalAcceptancePassed=false`。
- 收尾：Server 已安全停止；最终完整备份为 `2026-09-09T03-19-24-195Z-244def8f-fcb1-4acb-a9bc-67494bea28ad`。Ticket 保持 `in-progress`，等待真实 Provider 调用可用后重试，不把 smoke 成功误报为完整验收通过。

## 2026-09-09 Repair 78 续办记录

- 根因复核：旧冻结 runtime payload `b0f573d3165d773a0c213ec0c9905bc3176b21a1eb1e7e4f46c884ecc37c2eab` 的 `dsh-sdk-adapter.js` 未将预算账本 FD 5（及本地失败通道 FD 6）继续传给 DSH 子进程；预算插件写 FD 5 时触发 `EINVAL: invalid argument, write`，外层被归类为 `provider/UNKNOWN`。API Key、网络、模型和 DSH 本体均未被该证据否定。
- 修复后的冻结身份：runtime payload `d6323501c78aed82e65ff27d34bf54f5a912a15dbcde4722a8a77db0e2fc4586`，adapter SHA-256 `08e90c67b46871039660d8317e24b6b053dd43b140121dbd6b7b6a806b06fc02`，Match Profile 镜像 `sha256:971261c24cc850b742248550ccb23be47ed0aa229c1ae8dc3a83d16fe45050ca`；`doctor` 通过。
- 新真实 canary：`fa98b5e4-e19e-481d-a698-229eca2cd5a0`，报告：`/tmp/maze-ticket12-formal-20260909/data/maze-arena/canary-reports/fa98b5e4-e19e-481d-a698-229eca2cd5a0.json`。smoke 通过；Generator/ Solver 真实会话均执行并消耗 `50853 tokens / 0.028104 cost / 11 model calls`，失败已从旧的 `provider/UNKNOWN` 变为明确的 `protocol/RESULT_JSON_INVALID`。Generator 保留 `candidateStatus=invalid` 检查点，未伪造候选、配对评测或晋级；报告为 `mechanismClosed=false`、`promoted=false`、`formalAcceptancePassed=false`。
- 收尾：Server 已执行 `stop`；新增完整备份 `2026-09-09T05-27-27-606Z-25ddf60c-dab4-47e0-80fc-660bdeade34f`，`backup verify` 通过。为支持真实模型未提交候选的合法检查点，备份校验器新增无候选终态规则及回归测试；Ticket 仍保持 `in-progress`，剩余验收项不得勾选。

## 2026-09-09 收尾核对

- Backup 聚焦回归 `61/61` 通过；Backup typecheck/build、`git diff --check` 与四份受保护 ADR SHA-256 校验通过。
- 状态账本已记录最新 canary、10 个 Provider usage item、Generator invalid checkpoint、Solver `RESULT_JSON_INVALID`、运行时身份和最终备份；累计真实外呼为 `200387 tokens / 0.126953 cost / 54 model calls`，未记录凭据值。
- 失败边界已明确：旧 runtime 的 FD 透传缺陷已修复；当前阻断是官方 DSH 要求完整结果必须是严格 JSON 对象，而 Solver 返回内容不满足 `parseFinalJson`，所以系统拒绝进入可信重建、Docker 配对评测和晋级。

## 2026-09-09 Repair 78 settings 恢复重试

- 正式临时根恢复了受保护的用户级 `settings.yaml` 与凭据环境文件；重新安装并冻结 `@deepseek-ai/dsh@0.1.2-rc.1`，模型目录同步、`doctor` 和 Docker Match Profile smoke 均通过。新 runtime payload 为 `095f2044105c6ff3fe86505e27844e3769b19783d57bfecdf137c7a5a5586bd3`，镜像为 `sha256:582cc4ecc7806a271fb5528ada792cec5cf50b20943862ec583b3db1ed8b840b`，模型 release 为 `52b03dc79a0b22c922c562723d936fe0577e95ef8954c0bf7a2f6cd68591f130`。
- 新真实 canary：`4fbe31f7-58f9-4fe3-a8bb-7f0a4b8f543a`；报告：`/tmp/maze-ticket12-formal-20260909/data/maze-arena/canary-reports/4fbe31f7-58f9-4fe3-a8bb-7f0a4b8f543a.json`。Generator 与 Solver 均创建全新真实 Provider Session，冒烟通过；Generator 消耗 `37109 tokens / 0.021845 cost / 7 calls`，Solver 消耗 `31773 tokens / 0.019032 cost / 6 calls`，含 smoke 总计 `71370 tokens / 0.041547 cost / 14 calls`，`withinLimit=true`、`reconciled=true`。
- 结果：两个角色都返回“未提交候选”，未产生源码差异、可安装运行载荷、可信重建、Docker 配对评测或晋级；报告为 `mechanismClosed=false`、`promoted=false`、`formalAcceptancePassed=false`，并明确保留“不保证模型持续产生更优算法”的声明。SQLite 对账显示 canary 已 `closed`，13 个 usage receipt 与报告一致，`candidate_results=0`、`promotion_tags=0`。
- 收尾：前台 Server 已安全停止；最终完整备份 `2026-09-09T12-18-08-323Z-e2be9948-29fc-45d9-bbbe-871aa5286ff8` 已创建并通过 `backup verify`。配置缺失和旧 runtime FD 问题均已排除，Ticket 仍保持 `in-progress`，剩余阻断是模型本次未提交候选，不能勾选其余验收项。

## 2026-09-09 Repair 78 reasoning 重试

- 在同一冻结 runtime、模型 release 和 Match Profile 下追加两次串行真实重试：`662f7d21-285b-471e-b680-0ecc0ef10bc3` 使用 `reasoning=high`，Generator 在 `38545 tokens / 0.030805 cost / 6 calls` 后以 `provider/UNKNOWN` 失败，Solver 未运行；`373ebf87-45b6-4e84-9451-878d67d9d035` 使用 `reasoning=low`，Generator/ Solver 均真实执行但都未提交候选，分别消耗 `35896 / 0.027127 / 6` 与 `23437 / 0.014473 / 5`。
- 两次重试合计 `102935 tokens / 0.075656 cost / 19 calls`，各自 `withinLimit=true`、`reconciled=true`；报告分别为 `/tmp/maze-ticket12-formal-20260909/data/maze-arena/canary-reports/662f7d21-285b-471e-b680-0ecc0ef10bc3.json` 和 `/tmp/maze-ticket12-formal-20260909/data/maze-arena/canary-reports/373ebf87-45b6-4e84-9451-878d67d9d035.json`。两次均 `mechanismClosed=false`、`promoted=false`、`formalAcceptancePassed=false`，未产生候选、可信重建、Docker 配对评测或晋级。
- 收尾备份：`2026-09-09T12-26-23-151Z-af52d791-3501-4e80-bcb2-40e1888a54fa` 与 `2026-09-09T12-32-17-108Z-1645532d-c6e2-4e75-8518-395efba73b97` 均通过 `backup verify`；累计真实外呼更新为 `374692 tokens / 0.244156 cost / 87 calls`，未记录凭据值。Ticket 仍保持 `in-progress`，当前真实阻断是模型未形成候选或 provider 返回 UNKNOWN，不能把机制闭环误报为算法晋级。

## 2026-09-09 Repair 78 最终真实重试

- 在同一正式临时根下再次使用冻结的 `@deepseek-ai/dsh@0.1.2-rc.1`、模型 release `52b03dc79a0b22c922c562723d936fe0577e95ef8954c0bf7a2f6cd68591f130`、runtime payload `c28dfe8bd5bc1416d5dc1ef72d4754816881d504ed2c91d55ed6010a58bf614a` 和 Match Profile 镜像 `sha256:3df697b1121480f899102663ecd283decfc0a531cf62c2d5c485ddfda405fde9` 完成正式 canary `6d1c70f8-363c-42c0-a0a4-0d289b3b7478`（experiment `2d32d2b9-a8db-4edc-9fdd-7f853a556240`）。`doctor`、模型冒烟和完整备份前置均通过；权威报告为 `/tmp/maze-ticket12-formal-20260909/data/maze-arena/canary-reports/6d1c70f8-363c-42c0-a0a4-0d289b3b7478.json`。
- Generator 与 Solver 均创建全新 `real-provider` Session 并完成真实外呼，但都返回“未提交候选”：Generator `24342 tokens / 0.025431 cost / 4 calls`，Solver `36683 tokens / 0.025748 cost / 6 calls`；含 smoke 总计 `63606 tokens / 0.053769 cost / 11 calls`，`withinLimit=true`、`reconciled=true`。SQLite 关闭状态与 10 个角色 Provider usage item、2 个 generation checkpoint、`candidate_results=0`、`promotion_tags=0` 对账一致；无源码差异、可信重建、Docker 配对评测或晋级。
- 报告明确为 `mechanismClosed=false`、`promoted=false`、`formalAcceptancePassed=false`，并保留“模型不保证持续产生更优算法”的非保证声明。最终完整备份 `2026-09-09T15-10-52-271Z-b0b1c00b-fb7d-4c55-967a-7819a23856fc` 已创建并通过 `backup verify`；Server 已安全停止。累计真实外呼更新为 `438298 tokens / 0.297925 cost / 98 calls`，未记录凭据值。Ticket 继续保持 `in-progress`，不能勾选剩余验收项或宣称正式验收完成。

## Repair 79 本地通道收敛与独立复审

- 修复 DSH SDK 子进程 `stdin` 的异步 `error` 事件收敛；同步写失败与异步管道失败都会拒绝 pending RPC、终止子进程并保持稳定错误分类，不再留下未处理拒绝。
- 预算插件 FD5 的 `writeSync` 与 `readSync` 失败统一转换为可信 `ARENA_LEDGER_CLOSED` 本地事实；隔离父进程新增预算响应写回辅助，覆盖同步抛错和异步 callback 错误且只触发一次失败处理。
- 聚焦验证通过：DSH Integration `178 passed / 3 skipped`、隔离层 `75/75`、typecheck、build 和 `git diff --check` 均通过；未调用外部模型、未读取凭据原文、未启动正式 Server。
- 独立 Review85：Standards `passed`、Spec `passed`、阻断 `0`；覆盖当前 tracked/untracked diff、FD4/5/6、预算账本、Provider usage、备份恢复、canary 报告与晋级门槛。
- 真实验收结论不变：最新真实 canary 仍为 `mechanismClosed=false`、`promoted=false`、`formalAcceptancePassed=false`，因为模型未形成候选，未进入可信重建、Docker 配对评测或晋级；Ticket 继续保持 `in-progress`。

## 2026-09-09 Repair 78 最终复审修正

- 固定基线复审发现 canary 报告和硬预算仍把总模型调用额度写成 `17`，但正式 smoke adapter 明确允许最多 `2` 次模型调用，双角色 evolve 各 `8` 次时合法总上限应为 `18`。该问题不会改变最新 canary `6d1c70f8-363c-42c0-a0a4-0d289b3b7478` 的真实结论，因为本次只消耗 `11` calls；但若后续 smoke 用满 `2` calls 且双角色各用满 `8` calls，旧上限会把完整验收误判为超预算。
- 已将 canary 总模型调用上限改为 `2 + 8 * 2 = 18` 的单一常量，并新增回归覆盖 `2` 次 smoke、Generator `8` 次、Solver `8` 次刚好通过，第 `19` 次才触发 `budget_exceeded`。聚焦验证通过：Server canary `39/39`、DSH adapter `91 passed / 3 skipped`、Server typecheck、Server build、tracked/staged `git diff --check`。

## Repair 80 Session 生命周期与预算收敛复核

- `runEvolutionAttempt` 现在为每个 repair attempt 创建独立的 `harness-home-rN` 和全新 Harness Session；仅候选 workspace 在 repair 间复用。每个 Session 都在 `finally` 中关闭，避免 DSH home 中的状态、缓存或协议上下文跨 repair 串联。回归测试验证四次 repair 使用四个 home、同一 workspace，且每个 Session 恰好关闭一次。
- 当公开门禁已失败但剩余模型调用额度不足以启动下一次修复时，Evolution 将该次尝试收敛为 `invalid-candidate`，保留原门禁诊断并追加“剩余模型调用额度不足以继续候选修复”；不再继续外呼，也不运行隐藏评测或伪造候选结果。
- 本轮验证：Evolution `20/20`、Evolution typecheck、Control Plane `30/30`、Server canary/app `105/105`、Server build、DSH Integration `105 passed / 4 skipped`、DSH Integration typecheck、tracked/staged `git diff --check` 均通过。
- 固定 Review Base `7dcd78def2f463a623614b77592419f5d02be1e5` 的复核未发现新的 Standards/Spec 阻断；真实 canary `6d1c70f8-363c-42c0-a0a4-0d289b3b7478` 仍是唯一正式运行结论，`mechanismClosed=false`、`promoted=false`、`formalAcceptancePassed=false`。由于 Generator 与 Solver 本次均未提交候选，Ticket 仍保持 `in-progress`，不得勾选剩余验收项或宣称算法晋级。

## 2026-09-13 Repair 83 真实 DeepSeek canary 正式通过

- 正式运行根：`/tmp/maze-ticket12-formal-run83`；实时 API 报告已从 `http://127.0.0.1:39506/api/canaries/6cc6e27a-bcc7-46dd-a2c0-cddd91c85edd` 获取并与缓存报告逐字节核对。持久报告：`/tmp/maze-ticket12-formal-run83/data/maze-arena/canary-reports/6cc6e27a-bcc7-46dd-a2c0-cddd91c85edd.json`，目录 `0700`、文件 `0600`。
- 前置全部通过：`doctor=true`、模型冒烟 `2505 tokens / 0.000786 cost / 1 call`、不可变 Match Profile 镜像 `sha256:2636526ec7158ca62b380dd2f9e3e2e664d534631ef1d0566805e337d68cd37b`，前置完整备份 `2026-09-13T05-17-53-948Z-1419e377-9954-4afd-94d0-efa04861701c`。运行时固定为 `@deepseek-ai/dsh@0.1.2-rc.1`、模型 release `52b03dc79a0b22c922c562723d936fe0577e95ef8954c0bf7a2f6cd68591f130`、runtime payload `080186bbd99f217aa92d470d929b1dd6f93f4096efab5b03cccd5715109eb2ef`。
- 真实调用总账：`36144 tokens / 0.026097 cost / 8 model calls`，本次上限 `640000 tokens / 4.5 cost`，硬调用上限 `18`，`withinLimit=true`、`reconciled=true`；未记录凭据原文。
- Generator 新候选 `886094d73cc0d064ad85adc7582f2a56346cd6cd`，真实 Provider Session `f6d8136a-083a-465b-8781-4a92e8d236b2`，源码差异摘要 `1774b3a12bed8314f754383070a8d278f4819d78c1a53e93e9248c1459e8f490`，可信构建摘要 `746aa172a13d1921f67c6e3c1e649b4e144cb9e8e96062dc34e717640a31b6f9`；与冠军完成 `8` 个公开、`24` 个隐藏 Docker 评测，结果 `tie`，未创建晋级标签，下一代仍从冠军 `621c144e0010a10f905f6154f1ddb9a81b6bea04` 起步。
- Solver 新候选 `a222838db8f31c1fe857b430e0483d3ea0d07856`，真实 Provider Session `f86677d8-926a-42ba-8d99-10b3a2bf6e10`，源码差异摘要 `3569122b29430bcd99e62ad1cf200416005cda30d9caea64d990e386b0681f96`，可信构建摘要 `d5a8855b98f6b063a56be05331a7467f63bcacc293ca86c3a3c42410d5dcedd7`；与冠军完成 `8` 个公开、`24` 个隐藏 Docker 评测，结果 `tie`，未创建晋级标签，下一代仍从冠军 `896dfde2dbd59ef58740b4cd3c46b236448c0f2f` 起步。
- 权威终态：`status=closed`、`mechanismClosed=true`、`promoted=false`、`formalAcceptancePassed=true`，结论为“真实自进化机制已闭环，本次候选未晋级”。最终完整备份 `2026-09-13T05-51-09-912Z-de10bd7c-1aa2-4d7f-be8b-3417cfb51a72` 已执行 `backup verify` 并通过。该结果只证明真实链路与晋级判定可审计，不保证模型持续产生更优算法。

## 2026-09-13 Repair 81 终态报告持久化收敛

- 复核发现 Repair 83 报告虽已由 API 和缓存文件生成，但 `real_dsh_canaries` 仍停留在 `state=active`、`completed_at=null`、`terminal_report_json=null`；原因是终态回调只关闭租约，未把动态报告写回 SQLite。
- `CanaryAcceptanceRepository` 新增幂等终态关闭与报告持久化：仅允许已关闭且 `completedAt` 非空的同一 canary 写入；重复写入必须字节一致，冲突直接拒绝。Server 在终态备份前先完成该写入，重启恢复和前置失败路径也复用同一收尾逻辑；报告写入失败会记录结构化错误并保留后续备份与重启重试机会。
- 使用现有 Repair 83 证据执行本地恢复（未再次调用模型、未读取凭据原文）：SQLite 已为 `closed`，`completed_at=2026-09-13T06:28:17.162Z`，`terminal_report_json` 长度 `9510`，与 `/tmp/maze-ticket12-formal-run83/data/maze-arena/canary-reports/6cc6e27a-bcc7-46dd-a2c0-cddd91c85edd.json` 字节一致；`36144 tokens / 0.026097 cost / 8 calls`、7 条 usage receipt、2 个候选和 0 个晋级标签保持对账一致。
- 回归验证：Canary Acceptance `40/40`、Server 全量 `148/148`、Server typecheck/build、`git diff --check` 通过；独立复审待收尾。Repair 83 的权威结论保持 `formalAcceptancePassed=true`、`mechanismClosed=true`、`promoted=false`。

## 2026-09-13 Repair 87/88 终态恢复与备份重试修复

- 启动恢复现在区分“没有 runtime 记录”的孤儿与“已有 `paused/completed/failed/cancelled` 终态 runtime 但尚未收尾”的活动 canary；后者按正常终态关闭并生成报告，不写入 `preflight_failure`，`running` runtime 继续交给自治运行器恢复。
- 终态收口统一为“先持久化报告，再创建 `experiment-terminal` 备份”。终态备份成功事实写入带幂等键的审计；canary 事件绑定 `canaryId` 与报告 SHA-256，旧版仅有 `trigger` 的审计会在必要时自动补备份。报告已存在但成功审计缺失时，重启会重试；同一进程内失败不会重复制造备份。
- 控制路由、运行器终态回调和启动扫描复用同一收口逻辑，避免重复备份及“报告缺失仍发布备份”。新增回归覆盖终态 runtime、报告写入失败、终态备份跨重启重试与成功后不重复。
- 验证通过：canary `45/45`、Server 全量 `154/154`、Server build/typecheck、目标终态回归、`git diff --check`；独立复审结论 `passed`，无新的 P1/P2 阻断。未再次调用 DeepSeek，未读取凭据原文，未提交 Git。
