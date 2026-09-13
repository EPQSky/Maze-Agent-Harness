# Project Agent Guide

## 交付语言

- 所有面向用户的交付物必须使用简体中文，包括但不限于回复、文档、规格说明、计划、评审报告、交接说明和变更摘要。
- 所有软件开发均应遵循 SOLID、DRY、KISS、YAGNI、清晰分层、关注点分离、显式异常处理、安全配置、依赖最小化和可测试性等通用规范，优先沿用项目既有架构、编码约定与工具链，并根据实际业务复杂度合理采用工厂、策略、适配器、仓储、依赖注入等设计模式，避免为套用原则或模式而过度设计；新增或修改的代码块应使用简体中文提供必要的注释或说明，重点解释业务意图、关键边界和非显而易见的实现原因，避免逐行复述代码。

<!-- vibeforge-lite:start version=0.3.7 -->
## Vibecoding workflow

- Prefer the project-local workflow in `.agents/skills/`; rely on an installed Plugin only when the project explicitly selects Plugin mode.
- Use `$vibe-guide` when the right workflow is unclear.
- Clarify unresolved product, domain, and architecture decisions with `$grill-with-docs`; use `$batch-grill-with-docs` when a batch round is preferred.
- Publish stable decisions through the tracker configured in `docs/agents/issue-tracker.md` with `$to-spec`, then split multi-session work into vertical tickets with `$to-tickets`.
- Implement one approved slice at a time with `$implement`; use `$tdd` when a stable behavior seam exists. Do not commit unless the user or repository policy explicitly asks.
- Use `$execute-spec-tickets` only when the user explicitly wants an approved ticket set executed serially with independent reviews and one scoped commit per completed ticket.
- Before completion, review from the captured base with `$code-review <review-base>` along both Standards and Spec axes, including committed and working-tree changes.
- Use `$handoff` when another task must continue the work.

Project artifacts use `CONTEXT.md` only for stable domain language, `docs/adr/` for durable decisions, `docs/agents/` for workflow conventions, and the configured tracker for specs and tickets.

Local implementation ticket states are `ready-for-agent`, `in-progress`, and `done`.
<!-- vibeforge-lite:end -->
