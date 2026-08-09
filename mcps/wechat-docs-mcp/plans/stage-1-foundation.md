# Stage 1：最小可信闭环

开始时间：2026-08-09 16:53 Asia/Shanghai
目标完成时间：2026-08-09 18:20 Asia/Shanghai
下一复核点：2026-08-09 17:10 Asia/Shanghai
事故缓冲：20 分钟，只用于授权、客户端兼容或上游协议差异。

目标是完成 `status → 监听/入账 → 合并 wake → Codex 读取 → 精确 ACK → prepare → owner refs 校验 → 文件传输助手受控发送 → 重启后账本不丢`。微信客户端兼容、商业授权或 App Server 通用唤醒接口若阻塞，必须保留现场并报告，不能绕过。

公开源码、私有配置/secret、SQLite 与附件、安装快照和脱敏夹具严格分层。NapCat 正式运行态不在本阶段写入范围内。
