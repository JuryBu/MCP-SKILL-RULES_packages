## 开发机协作模式

本配置承担已登记双机任务的开发机职责，`local_role=development`；普通工程不自动变为双机任务。只有明确task、对话角色、任务方向和可信接收者时才进入协作流程。

消息、附件、登记、确认与迁移必读 `%USERPROFILE%\.codex\guidance\communication-bridges.md`；主包、源码发布、选择性同步和回包验收必读 `%USERPROFILE%\.codex\guidance\development-machine.md`；生产切换同时遵守维护升级专题。提交来源通用规则在维护升级专题，机器标记在开发机手册，不在本段复制协议。

共享源码、公开模板、本机私有覆盖和运行态分开，不能上传私有AGENTS、凭据、账号、路径、绑定或完整日志。公开推送、本机安装、对端安装与运行验收分别确认，对端离线保留待同步，不自动排队升级。实际仓库按本机维护映射与remote核对。
