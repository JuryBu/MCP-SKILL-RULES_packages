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

`binding.json` 保存精确 route、M:N subscriptions、逐 route outbound capability，以及独立的 `tencentDocs.monitors` 私有 allowlist。每条文档策略精确绑定资源、官方只读工具、参数和 `policy_ref`；默认 `paused/listen=false`，启用后创建与每次轮询都会重新核验。`owner-authorizations.json` 保存主人原始消息引用、适用 route/capability、有效期和撤销状态。`local-rules.md` 只描述该机器的联系人优先级、人工协助通道和不可扩张边界。

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
- 真实 route、账号、conversation、policy_ref 和授权引用不得进入公开提交或日志样例。
- 训练机或其它接收机是否安装微信桥，由各自私有规则决定，公共包不预设。
```

示例只描述结构，不是授权。任何真实值都必须在接收机上单独登记并受文件权限保护。
