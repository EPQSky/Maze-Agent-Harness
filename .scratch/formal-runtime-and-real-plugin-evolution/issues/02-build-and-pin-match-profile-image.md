# 02 — 本地构建并锁定 Match Profile 镜像

**What to build:** 让操作员能够从已锁定的 Harness 和 Maze Arena 项目产物在本机构建正式 Match Profile 镜像，记录实际内容摘要，并确保所有正式比赛只使用该不可变镜像身份。

**Blocked by:** 01 — 正式安装清单与 doctor

**Status:** done

- [x] 镜像构建只使用安装清单中已校验的 Harness 身份和当前可信项目构建产物。
- [x] 构建完成后记录 Docker 返回的实际 SHA-256 摘要，并生成 Server 可消费的不可变镜像引用。
- [x] 正式配置拒绝 `latest`、普通版本标签和任何不含 SHA-256 摘要的镜像引用。
- [x] `doctor` 能识别镜像缺失、摘要漂移、构建身份不一致和安全能力不足，并关闭失败。
- [x] 由该镜像启动的 Match Profile 保持禁网、只读、非 root、能力删除和现有 CPU、内存及进程限制。
- [x] 黑盒测试验证正常构建与摘要锁定，并覆盖镜像替换和浮动标签的拒绝路径。
