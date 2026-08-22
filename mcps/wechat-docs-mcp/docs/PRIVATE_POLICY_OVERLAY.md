# 本机私有策略覆盖

公开 Rules 只定义中性的 subscription、outbound、附件、文档和跨通道合同。每台接收机在 Git 之外维护自己的派生策略，不能把真实联系人、route、conversation、授权消息或机器职责写回公开模板。

## 建议分层

```text
public repository
  binding.example.json
  rules/codex/components/core.template.md
  skills/wechat-docs-collaboration/SKILL.md

receiver private layer
  config/binding.json
  config/owner-authorizations.json
  config/local-rules.md
  secrets/*
```

`binding.json` 保存精确 route、M:N subscriptions、逐 subscription 的 listen/send/context-read capability、逐 route outbound capability，以及独立的 `tencentDocs.monitors` 私有 allowlist。历史上下文读取默认关闭，只有独立 `context_read_capability=true` 且 `policy_ref` 有效时才能使用；listen 不自动扩大为翻阅历史。每条文档策略精确绑定资源、官方只读工具、参数和 `policy_ref`；默认 `paused/listen=false`，启用后创建与每次轮询都会重新核验。`owner-authorizations.json` 保存主人原始消息引用、适用 route/capability、有效期和撤销状态。`local-rules.md` 只描述该机器的联系人优先级、人工协助通道和不可扩张边界。

## 私有历史读取策略

启用局部上下文读取至少同时满足：账本与 private binding 都唯一精确匹配同一 `subscription_id/route_id/conversation_id/generation`；两层均为 active 且 `context_read_capability=true`；两层非空 `policy_ref` constant-time 一致并明确允许该 route 的局部双向上下文；当前活动微信账号与 route owner scope 一致。每次上下文读取与 `attctx_` 解析都会重新读取并核验私有策略，缺失、重复、漂移或撤销立即 fail-closed。返回的 `msgctx_`、`attctx_` 与 continuation 只在本机私有 HMAC key 下有效，不得写入公开日志或跨 subscription 共享。

能力启用遵循 private-first：操作者或发布脚本先备份并原子写入 private binding 的完整 subscription 策略，再调用 capability 工具写账本；账本写入失败时，操作者或发布脚本必须恢复 private binding 备份。撤销采用相反的安全意图顺序：先在 private binding 暂停或关闭该策略，使运行时立即拒绝，再关闭账本 capability；不得通过删除 event、pending 或 ACK 掩盖历史。能力工具只接受已经存在且精确匹配的私有策略，任意非空字符串不能制造授权。

## 私有发送策略

启用微信发送需要三层同时成立：

1. route 的精确身份通过 private binding 与 ledger 双重校验；
2. subscription 的 `send_capability=true` 且 `policy_ref` 指向本机私有策略；
3. 当前不可变草稿携带适用的 owner authorization refs 与 dedupe key。

持久授权可以减少逐次询问，但不能扩大 route 或 capability。来源目标不唯一、授权撤销、执行结果 `UNKNOWN`、需要改变登录状态或自动回滚不可用时，保持安全现场并请求主人介入。

## 派生规则示例

```text
- 微信主要用于获准 route 的信息输入；默认主动联系主人走本机私有 owner-contact 通道。
- 只有 private binding 明确启用的 route/capability 可发送，禁止按显示标题猜目标。
- 历史上下文读取与监听分开授权，只能按锚点读取有限切片，禁止把整库导出当作默认能力。
- 真实 route、账号、conversation、policy_ref 和授权引用不得进入公开提交或日志样例。
- 训练机或其它接收机是否安装微信桥，由各自私有规则决定，公共包不预设。
```

示例只描述结构，不是授权。任何真实值都必须在接收机上单独登记并受文件权限保护。
