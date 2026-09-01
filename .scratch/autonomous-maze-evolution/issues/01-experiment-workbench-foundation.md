# 01 — 可运行的实验工作台骨架

**What to build:** 建立可运行的 Maze Arena 基础应用。操作员打开 Web 后直接进入实验工作台，能够创建一个本机单用户实验草稿、查看实验列表和详情，并在服务重启后继续看到已保存的数据。本票同时建立后续切片共用的应用边界、共享契约和测试入口。

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] Node.js 22、TypeScript 和 pnpm 单体仓库可以通过一组明确命令完成安装、构建、测试和本地启动。
- [ ] Web 首屏是可操作的实验工作台，而不是营销页；可以创建并查看包含名称、创建时间和草稿状态的实验。
- [ ] Arena Server 通过公共 API 保存和读取实验，SQLite 重启后数据不丢失。
- [ ] 同一 Arena 实例拒绝同时启动两个运行中实验，并返回可识别的领域错误。
- [ ] 使用受控测试替身从 Web/API 到 SQLite 验证创建、查询、重启恢复和并发运行限制。
