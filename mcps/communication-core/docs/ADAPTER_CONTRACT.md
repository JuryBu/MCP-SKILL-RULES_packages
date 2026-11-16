# 宿主接入模块契约

核心通过deliver和query处理投递，通过可选observeReply读取准确原回信，HTTP路径由各宿主维护者决定。消息工具不接受模型或工作模式覆盖。

## 核心调用

```js
await adapter.deliver({ message, delivery, target, signal, onRequestStarted });
await adapter.query({ message, delivery, target, signal });
```

deliver发出原请求，query只查询原delivery。返回包含outcome、同一delivery_id和target_key（通过identityKey计算）；outcome为accepted、busy、failed_before_send或unknown。accepted是宿主受理，模型、页面与业务处理分别取证。

支持精确发送阶段的transport显式声明`submissionTracking=true`，adapter只有在所用transport也声明时才向核心提供该能力。transport完成只读准备、核验取消信号之后，必须在实际变更请求前同步调用`onRequestStarted()`；回调抛错时停止变更。只读查询及状态读取均不调用该回调。已取消的异步准备即使稍后返回，也须再次核信号并停止发送。

核心在声明该契约的发送调用超时或关闭时，只有尚未进入变更边界才保留prepared并按持久退避等待；变更边界之后保持unknown，只查原delivery。未声明该契约的旧adapter继续使用unknown。明确连接拒绝等可核对的未发送结果仍按各transport契约处理。

## Codex独立客户端

CodexDeliveryAdapter接收注入的transport。submit(request,{signal})提交一次，query({delivery_id},{signal})查询原请求。客户端不决定生产URL或凭据，不构造QQ身份。

| request字段 | 内容 |
|---|---|
| delivery_id、message_id | 核心原请求及消息身份 |
| source | 经过核心核验的caller和origin |
| target | 准确宿主/机器/对话、binding_id及原代次 |
| body、delivery_policy | 正文、附件引用与明确投递要求 |
| message_visibility | Codex消息持久保存的hidden或visible；旧缺字段请求还原为visible |

transport返回同一delivery_id、同一完整target及outcome，可附turn_id与injection_method。目标或代次不符、结果缺失、调用异常均保持unknown；由核心按原请求查询。新入口与旧NapCat的字段及持久账本分别维护。

新Codex消息由核心在规范化时保存显示模式，缺省为hidden。旧存量没有该字段时保留原形状、原哈希及visible查询行为。source为有限QQ本人来源时，固定relay、原in_reply_to及forward_of逐项核对，回执还必须与原正文、投递策略和显示模式一致。unknown只查询原身份。

原生turn/start的完成正文可以按原thread/turn观测；turn/steer可能包含本次注入前的助手正文，当前不自动把这些正文当作本次回信，接收者通过明确in_reply_to的工具回复建立关联。

发送工具在原消息与投递身份持久化后即可返回，后续受理进展由communication_wait或原ID查询取得。快照中的事件读取起点保留尚未返回的事件，只有wait返回的next_cursor才表示该批事件已经交给调用者。普通关联回信按原消息ID及双方准确对话身份匹配，原渠道与处理ACK继续显式核原generation和delivery；替代回复者及额外reply代次字段留后续契约扩展。

## 当前运行范围

默认CLI只允许显式mock隔离配置，独立`live_test`入口支持明确配置的真实AG、QQ引用往返及Codex通用HTTP客户端。AG真实空闲、忙碌、缺席恢复、QQ回信自动归还和宿主常驻工具到Codex主线已有证据。Windsurf/Devin已有只读状态和原生MCP调用者出站证据，核心到该宿主的入站、忙中插话与模型切换仍待独立验收。各候选版本的实际加载、页面显示与应用完整重开分别见验证记录。

AG查询与回信共用准确原输入定位：非空原生client ID必须等于原delivery；缺少原生ID时仅接受原发送完整正文。单独引用双ID标记不能确认原输入。原生root/trajectory必须与准确目标一致，重复原输入保持未解决状态。
