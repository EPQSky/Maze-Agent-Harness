# 01 — 正式安装清单与 doctor

**What to build:** 为本机单用户正式运行建立可重复的安装清单和 `doctor` 入口，使操作员能够初始化标准用户目录，并在启动任何实验前验证 Node.js、pnpm、Git、Docker、DeepSeek Harness 源码提交、`dsh` 可执行文件及精确版本均符合锁定要求。

**Blocked by:** None — can start immediately

**Status:** done

- [x] 安装入口在标准配置、数据和状态目录中创建所需结构，敏感数据目录权限为 `0700`，且不把可变运行数据写入源码仓库。
- [x] 安装清单记录 Harness 源码目录、固定 Git 提交、`dsh` 可执行文件身份和精确版本，不包含 API Key。
- [x] `doctor` 对支持的 Node.js、pnpm、Git 和 Docker 环境返回成功，并以清晰诊断拒绝缺失工具或不受支持版本。
- [x] `doctor` 校验实际 Harness 源码提交、可执行文件和 `dsh --version`，任一身份漂移都关闭失败。
- [x] 安装和诊断过程不自动下载、克隆或升级第三方 Harness。
- [x] 黑盒测试只通过命令退出码、诊断输出、安装清单和目录权限验证行为。
