# NapCat 本人引用回复接入（默认关闭）

## 当前状态与接入前提

本文件按原维护线交付的schemaVersion1契约接入。provider及events_only扫描已实际加载，私有显式配置已完成新通知捕获、本人自然引用回复、核心精确持久读取、自动送入原AG一次及AG真实QQ答复。产品缺省关闭，启用实例须逐项核provider加载与原通知捕获身份；常驻MCP与Codex路径继续单独接入，先前人工触发读取的证据按其实际方式保留。

`src/owner-replies.mjs` 仍是无网络、文件、发送、扫描或ACK的纯消费端。可选runtime通过已有NapCat MCP transport注入`readPage`，调用`napcat_owner_events_read`；读取复用已绑定组件CID的连接，不发送消息、不确认消息，也不触发发送阶段钩子。测试中使用虚构数据，实际SDK传输和真实QQ另行取证。

主线接入前需要提供原投递的可信路由快照、私有已确认本人 sender allowlist（允许作为主人回复来源的账号集合），并确认既有 HTTP 头实际绑定相同的调用 CID（来源对话 ID）。真实账号须由私有绑定提供，公共源码和测试不读取、猜测或内置真实 owner ID。

accepted delivery的`native_receipt`保存provider、message_id、verified、state_persisted。实际发送结果的`replyRoute`在原消息ID、route key、组件CID及QQ目标逐项匹配，且`ownerEventGeneration`为正安全整数时，另保存有限`reply_route`四字段。消费者要求这份原投递捕获身份与配置快照完全一致；缺失或冲突时零读取，原出站accepted状态保持。旧通知不补造捕获字段或重新发送。

## 只读工具契约

工具为`napcat_owner_events_read`，只返回已保留、准确引用原外发消息的事件。调用不推进扫描、不ACK、不创建事件，wake正文没有替代入口。

| 必填参数 | 类型与含义 |
|---|---|
| `route_key` | 非空字符串，准确原路由 |
| `conversation_id` | 固定组件CID，须与连接头和原路由一致 |
| `original_qq_message_id` | 字符串，原生外发 QQ 消息 ID |
| `expected_route_generation` | 正安全整数，原路由代次 |

可选`cursor`为同一原请求范围内的不透明字符串，`limit`为1—50。内部readPage wrapper从`context.conversationId`添加必填CID，并核它与transport构造时的HTTP头相同；参数白名单拒绝任意CID或账号替换。以下返回体使用虚构值：

```json
{
  "ok": true,
  "route": {
    "route_key": "fictional-route",
    "conversation_id": "fictional-source",
    "target_key": "fictional-owner-target",
    "generation": 9
  },
  "original_qq_message_id": "-88000001",
  "events": [{
    "event_id": "fictional-event",
    "message_id": "88000002",
    "message_seq": 12,
    "quoted_message_id": "-88000001",
    "sender_id": "77000001",
    "text": "虚构的原生回复"
  }],
  "next_cursor": null,
  "partial": false
}
```

QQ消息ID为非零、可带负号、最多20位十进制数字的字符串；sender ID为正数数字字符串；事件ID、路由键、CID、target key的UTF-8大小最多256字节；message_seq为非负安全整数。类型保持原样，契约版本有变化时重新核对。

这里的 `route.conversation_id` 是持有原 owner route 的组件调用 CID，可能是负责转送的维护对话；原消息可以来自另一条 AG 或 Codex 对话。原发送者由核心 message/source_key 核对，路由持有者由可信绑定快照及原渠道返回核对。`route.target_key` 对应 QQ 目标的 `target.conversation_id`，核心 `delivery.target_key` 则是 `identityKey(target)` 产生的完整身份字符串。路由 generation 和核心 binding_generation 分别核对。

provider实际加载后，需以`napcat_owner_route_register(capture_owner_events=true)`显式启用该路由捕获，再从返回的`route.ownerEventGeneration`保存实际代次。该代次独立于旧wake固定generation1。只有此后带捕获身份的原外发通知可读；旧通知、跨代次、保留缺口或字段缺失均明确拒绝，原owner消息路线照常工作。

live_test的napcat_owner配置省略`reply_events`或使用`{"enabled":false}`时保持零读取。启用配置还须提供`target_key`、来自实际注册的`route_generation`及私有`owner_sender_allowlist`；adapter的组件CID沿既有`conversation_id`，QQ目标必须与该adapter全部登记目标一致。配置校验在adapter构造和SQLite创建前完成，不能将示例代次当作实际注册结果。

## 消费端接口与原投递核验

```js
import { createOwnerReplyReader } from "../src/owner-replies.mjs";

const readOwnerReply = createOwnerReplyReader({
  enabled: false,
  callerConversationId: "fictional-source",
  binding: {
    delivery_id: "fictional-delivery",
    message_id: "fictional-message",
    route: {
      route_key: "fictional-route",
      conversation_id: "fictional-source",
      target_key: "fictional-owner-target",
      generation: 9,
    },
  },
  ownerSenderAllowlist: [],
  readPage: undefined,
});
```

`await readOwnerReply({ message, delivery, target, signal })` 接收现有 observer 的原始输入形状。`enabled` 默认 false，只有严格布尔值 true 才开启；私有 allowlist 缺失、为空、类型不符或未注入 `readPage` 时，返回明确的无观测结果且不调用 reader。缺少可信原路由绑定、未显式提供组件调用CID或该CID与原路由持有者不同，也保持零调用。路由与 allowlist 在创建时复制，外部数组和对象后续修改不改变已捕获范围。

每次读取核原message/delivery、来源完整身份、QQ目标、binding ID/代次、adapter及envelope/snapshot一致性。delivery.status与evidence.outcome须为accepted，顶层outcome可缺省，显式矛盾值拒绝。原QQ ID只取持久native_receipt，并要求kind=receipt、provider=napcat_owner、verified/state_persisted均true，以及reply_route四字段匹配。核心UUID、wake和其它provider没有替代入口。

本地接口为`readPage(parameters,{conversationId,targetKey,signal})`，parameters含route、原QQ ID、预期代次及可选分页，context提供固定组件CID、QQ目标与取消信号。参数/context冻结，实际`NapcatMcpTransport.readOwnerEvents`核固定CID后添加conversation_id，reader再逐项核返回范围。

## 分页、身份与大小边界

每次调用从第一页开始，游标仅在本次读取保存，不接受外部续读游标。每页固定原route、原QQ ID、组件CID、target及捕获代次。provider已核跨范围cursor拒绝和只读状态不变，生产实际schema与原任务保全也已独立核验。

`partial=true`须给有效next_cursor，partial=false须明确next_cursor=null。缺字段、无终页、循环游标、重复event/native message/sequence均拒绝整次观测。全部页面完整通过才返回回复，后页出错时丢弃前页结果。

| 限制 | 当前硬上限 |
|---|---|
| 页面 / 全部事件 | 4 页 / 100 条 |
| 单条正文 / 全部正文 | 16 KiB / 64 KiB，按 UTF-8 字节 |
| 单个 cursor | 4096 UTF-8 字节 |
| 私有本人 allowlist | 32 个字符串 ID |

所有事件都核原外发引用、原生字段和预算，空正文也照常核验。合法非本人事件被忽略，只有命中私有allowlist的本人事件能成为回复；其它成员在同一通知下的引用不会遮住已核本人回信。错误引用、原生字段异常、超限和跨代次仍拒绝整次观测。

取消前零调用；读取中取消会传递 AbortSignal 并结束本地等待，不开始后续页，返回后清理本模块注册的监听器。已注入 reader 的外部执行是否真正停止由接入方实现，本模块不会启动重试或其它取消副作用。

## 返回给核心的内容

成功时返回标准原生 reply 的四个字段：`native_message_id` 为选中事件的原生 QQ `message_id`，`native_conversation_id` 为准确 QQ 目标，`source_step_index` 为同一事件的原生 `message_seq`，`text` 保持该事件的正文原样。完整结果有多条非空回复时，保留服务端页面顺序中的首条匹配事件，序号仅作原生标识与去重；不自行按其数值推断时间顺序，也不拼接正文或生成 turn/trajectory ID。

额外来源字段严格限定为 `native_source`：provider、四项 route、original_qq_message_id，以及 event 中的 event_id、message_id、message_seq、quoted_message_id、sender_id。未知页面字段、额外事件字段、原 wake、transport 错误和内部正文都不复制到来源信息。

核心对QQ原生回信另核native_source与原accepted receipt的QQ ID和reply_route，事件native ID、序号及quote须与正文回信完全一致，只保存上述有限字段。未知诊断、凭据和任意嵌套对象被剥除；AG/Codex继续沿各自原生身份校验。

空回复、未支持、取消、无效数据和读取错误统一返回 `{ status: "unsupported", reason: "固定原因代码", reply: null }`。例如 disabled、owner_allowlist_required、read_page_unavailable、no_reply、cancelled；构造时的属性读取异常返回 invalid_setup，调用异常返回 read_failed，均不暴露原错误、响应或异常正文。主线可将该结构映射为 adapter.observeReply 的 null。成功对象可直接交给现有核心的原生回复校验。

消费端只报告已核原生事实，不改变 processing、业务处理状态、扫描位置或渠道 ACK。

## 自动送回发起对话

原生回信保存后，核心还需要把它作为本人QQ消息投递给原发起模型。`reply_forwarding`省略时只提供持久读取；显式规则让新QQ出站冻结准确来源、返回目标绑定与代次，以下是虚构配置：

```json
{
  "reply_forwarding": [{
    "id": "fictional-owner-return",
    "source_principal_id": "fictional-ag-principal",
    "from_binding_id": "fictional-qq-binding",
    "to_binding_id": "fictional-ag-binding",
    "ttl_ms": 86400000
  }]
}
```

本人allowlist沿已启用QQ reader的可信配置注入，返回目标必须对应原发送principal的完整身份，规则只支持QQ到Antigravity。Codex的人类来源回信契约与真实控制入口另行验收。内部转交principal没有HTTP token，原AG连接不能伪造本人QQ来源。

准确原生reply和待转交message/delivery在同一SQLite事务提交，正文、原QQ引用及有限native_source保持，`origin.kind=human_message`，`in_reply_to`关联原出站消息。返回目标离线时保留原待送身份，重开继续原投递；受理未知只查询原delivery，到期和绑定变化保留明确结果。转交的原生回复继续作为该转交消息的结果保存，核心不会递归再投QQ。

修复已存在的真实回信时，规则可通过`adopt_reply_events`明确列出原`message_id`和`native_event_id`，启动时严格核原持久reply与本人来源，只恢复这些事件。重开复用已生成的转交message/delivery，不普遍扫描或重放旧通知。

提供方已支持新建独立核心route的`reply_delivery="events_only"`：捕获和精确读取保持，维护Codex不再收到该route的wake。旧维护route继续收自己的回复，已有route不转换模式；本线已在backend和scanner实际同版后注册新route，保存真实返回代次。回退旧提供方前按正常close关闭本线新route，防止旧scanner把它重新当维护wake。

## 本次验收范围与后续工作

运行 `node --test test/owner-replies.test.mjs` 验证默认零调用、持久原生回执、完整身份、准确 quote、私有 allowlist、分页完整性、游标循环、重复事件、各项大小限制、取消、错误脱敏、处理状态保持，以及当前 core 对标准 reply 字段的接收。测试全部虚构并拦截常见网络入口，不读取真实配置、账号、群消息，不发送或 ACK。

2026-11-15 在 Windows、Node v24.12.0 下完成以下离线验收，执行均经过 Sandbox：

```text
node --test --test-concurrency=1 test/contracts.test.mjs test/owner-replies.test.mjs
tests 51 / pass 51 / fail 0 / cancelled 0 / skipped 0

node --check src/owner-replies.mjs
node --check test/owner-replies.test.mjs
两项语法检查通过
```

其中 owner-replies 为 47 项，已有 contracts 回归为 4 项。新增用实际持久delivery结构核缺省顶层outcome，以及来源代理CID和维护route CID分离；全部页面验证完成后按provider原顺序选择首条匹配，序号只作原生来源事实。网络拦截器的尝试次数断言为0；默认关闭、无私有allowlist、缺少readPage的替身读取次数均为0。测试全程只用内存，没有创建任务临时目录或文件；Sandbox自身的执行与输出材料按其托管策略管理。

上列51项为最初纯消费端固定快照。运行接线另有103项transport纯内存回归、12项原状态SQLite检查及live配置检查。2026-11-16最终冻结全量659项、49模块语法检查通过，13项转交SQLite检查覆盖同事务失败、离线、unknown、重开、到期、绑定变化、本人撤销及精确恢复；原6消息状态副本经正常runtime初始化/重开和零外部factory验证，只产生一个对应原事件的转交，临时副本已删。原真实回信后续实际自动进入准确AG一次并自然接话，AG自行经新events_only出站发QQ得到原生回执。常驻工具与Codex链仍待完成，完整同版结果统一记录在VERIFICATION。
