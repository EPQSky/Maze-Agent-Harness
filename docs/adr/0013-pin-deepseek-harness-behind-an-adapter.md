# 通过适配层精确锁定 DeepSeek Harness

项目通过独立的 dsh-integration 模块和精确版本调用 DeepSeek Harness，双方使用隔离的 Harness home、相同模型配置及只读凭据注入；Harness 升级作为显式迁移处理。该做法增加了一层适配代码，但限制开发者预览版本的破坏性变化，并防止会话、插件、凭据和配置在两名进化智能体之间串扰。
