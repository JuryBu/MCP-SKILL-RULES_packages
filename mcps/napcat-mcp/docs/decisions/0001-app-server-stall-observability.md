# App Server 卡滞观测与恢复边界

状态：接受，2026-08-15。

## 背景

Codex Desktop 曾出现两类外观相似但位置不同的等待：普通用户消息已由 Desktop 送进 App Server，模型请求尚未开始，界面数分钟没有首个思考、正文或工具事件；以及 `list_threads/read_thread/send_message_to_thread` 的单次原生工具调用在送达 App Server 前卡住。内层模型流量看门人只能监督已经到达模型 HTTP 层的请求，无法覆盖前一种本地准备阶段，更看不到后一种原生工具桥等待。

实际链路是：

```text
Codex Desktop
  -> App Server 外层透明中转
  -> 官方 App Server / Codex 回合准备
  -> 本地模型流量看门人
  -> OpenAI
```

## 决定

外层透明中转从收到普通 `turn/start` 开始观察同一 thread/turn 的生命周期。`turn/started` 只证明回合对象存在，不算有内容；item 生命周期、正文或推理增量、工具事件、计划与 diff 更新才算有效进展。60 秒仍没有有效事件时记录 `first_output_deadline_exceeded`，随后恢复、无输出结束或观察连接关闭时记录对应结局。该功能严格只读，不调用 `turn/interrupt`，不重新提交用户消息，不屏蔽官方事件，也不修改官方持久状态。

内层模型流量看门人继续独立记录请求开始、上游首个有效 SSE、重试、失败和完成。两层只在 thread 与 turn 的散列都一致时标为精确关联；信息不完整时明确标为模糊或无关联。新观测只持久化异常，正常轨迹在内存中完成后丢弃。

日志只含散列身份、阶段、耗时、状态和错误类别，禁止写入提示词、回复、OAuth 请求头、工具参数和文件正文。外层与内层各写一个独立 JSONL，避免 Windows 下跨进程争抢同一文件；每个文件 4 MiB、最多 8 份、保留 7 天。

## 为什么不做自动无感中断重试

官方 App Server 提供 `turn/interrupt`，但它会把旧回合持久化为中断状态。仅在代理层隐藏事件并启动新回合，仍可能留下两个 turn、重复用户消息，重新打开历史后暴露；公开协议没有原子“撤销旧回合并用同一身份替换”的接口。若旧回合已经执行工具或状态未知，重放还可能重复副作用。因此当前版本只观测，不把可能破坏对话历史的动作包装成“无感恢复”。

## 原生任务工具卡滞

原生任务工具的单次等待可能卡在 Codex 自己的工具调用桥里，请求尚未到达 App Server。外层透明中转无法取消这张等待单，也不能证明发送是否落盘。Rules 因此要求：长对话优先 `conversation_read_original`；未知体量只做一次有界读取；约 40 秒零返回后停止重试并降级；发送超时一律记为 `UNKNOWN`，先核对目标原文再决定是否重发。

## 依据

- [App Server README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)：`turn/start`、`turn/started`、item 生命周期与 `turn/completed` 的公开语义。
- [App Server protocol common.rs](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/common.rs)：公开通知和方法清单。
- 社区故障样本：[35030](https://github.com/openai/codex/issues/35030)、[30526](https://github.com/openai/codex/issues/30526)、[27395](https://github.com/openai/codex/issues/27395)、[22411](https://github.com/openai/codex/issues/22411)、[23000](https://github.com/openai/codex/issues/23000)、[23244](https://github.com/openai/codex/issues/23244)。这些报告证明线程工具卡滞、断流和取消残留并非单机特例，但没有提供可原子清理单次等待或无痕替换回合的公开接口。

## 后续重新评估条件

只有官方协议新增原子回合替换、可查询的取消确认和工具副作用身份，或能证明失败回合不会持久化、不会重复工具时，才重新评估透明自动恢复。届时仍须先做历史重载、迟到事件丢弃、并发对话隔离和副作用幂等测试。
