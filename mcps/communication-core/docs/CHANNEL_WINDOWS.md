# 聊天窗口与模型对话

`channel_windows`登记可用的QQ聊天窗口，`communication_manage_channel_binding`把其中一个窗口映射到当前调用者的模型对话。普通QQ私聊和已授权群发送使用原渠道目标与发送许可，可直接发送；窗口模型映射用于把窗口内符合条件的人类来信交给模型。

当前真实入口支持QQ私聊和群窗口，接收模型为Antigravity或Codex。工具schema预留`wechat`，真实入口的接入类型和原生窗口消费者目前只实现QQ；微信接入需要对应渠道实现和验证。

## 先配置准确的窗口

维护者先从私有渠道登记核对准确的`window_id`、窗口类型及出站目标，再加入私有配置的`channel_windows`。QQ私聊的window_id为准确对方账号，群窗口为准确群ID；值必须是合法的数字字符串。私有渠道登记可提供这些地址，公开示例只使用占位值。

| 配置字段 | 用途 |
|---|---|
| channel、component | 渠道及负责该窗口的原组件 |
| window_type、window_id | `private`或`group`及准确窗口地址 |
| binding_id | 已配置的QQ渠道目标绑定 |

该QQ目标的host和surface须与窗口渠道、类型一致。目标的`conversation_id`使用原渠道登记的target_key，窗口的`window_id`使用实际账号或群ID。QQ窗口来源还要求对应`napcat_owner`接入启用`reply_events`，其target_key与该QQ目标一致，并提供准确的本人sender允许列表。

`list`只读取当前caller已保存的映射记录。返回`bindings: []`时，先核对私有窗口配置和本对话是否已绑定；此调用没有发现账号、群或新窗口的功能。

## 由当前对话管理映射

每次调用填写真实caller四字段：`machine_id`、`host`、`surface`和具体`conversation_id`。bind的模型目标由该caller解析，窗口映射保留完整归属。

以下为首次绑定的完整参数模板，调用工具为`communication_manage_channel_binding`，尖括号内容需替换为实际值：

```json
{
  "caller": {
    "machine_id": "<caller-machine-id>",
    "host": "codex",
    "surface": "desktop",
    "conversation_id": "<actual-caller-cid>"
  },
  "action": "bind",
  "channel": "qq",
  "window_type": "private",
  "window_id": "<configured-window-id>",
  "expected_generation": 0
}
```

| action | 参数及结果 |
|---|---|
| bind | 指定窗口和expected_generation，保存其到当前模型对话的映射 |
| get | 指定channel、window_type、window_id，读取本对话映射或已释放记录，未绑定时返回`{"binding":null}` |
| list | 读取本对话记录，可用channel、window_type、window_id过滤，并用limit、after_key分页 |
| remove | 指定窗口及expected_generation，释放本对话持有的映射并保留删除代次 |

`expected_generation`用于CAS（写入前比较预期代次与当前代次）。从未创建的记录使用0；已有记录先get，bind或remove时填写返回的generation整数。同内容重绑保持代次，实际变更或删除后代次增加；释放后再次认领沿用删除记录的最新代次。get和list只接受各自动作的查询参数。

get查到已有映射或已释放记录时，仍直接返回平铺record；只有未绑定的get使用`{"binding":null}`。list继续返回`bindings`及分页字段，bind和remove沿用原记录形状。

其它对话持有的有效窗口返回归属冲突，get和list隐藏其模型目标。已释放记录可返回有限字段及最新generation，供后续认领。分页过滤后可能出现空页，`has_more=true`时继续使用`next_after_key`。

## 绑定、原生采集和实际来信

`window_ingress_enabled`省略时为false。此时可以保存模型映射；启用原生采集须在私有配置中显式设为true，并具备下节的Provider能力。

| 要核对的结果 | 对应证据 |
|---|---|
| 模型映射已保存 | 返回的target、owner_key、generation及deleted状态 |
| 原生窗口路由已打开 | capture中consumer_enabled为true、status为ready、native_status为open及对应代次 |
| 实际人类消息已送达 | 原生event_id、sender和正文，与核心message_id、delivery_id及目标接收记录对应 |

bind和remove保存映射后再同步原生路由，get和list返回已有记录及采集摘要。Provider不可用时，已保存的映射保留，`capture.status`和`last_error`记录受阻状态，未确认的原生状态为`capture.native_status=unconfirmed`。同步结果未知时保留原注册去重键和代次，先查询原结果。明确未发送的受阻操作可在恢复条件满足后，用最新映射代次再次bind或remove触发同步。

采集摘要还包括`provider_generation`、`confirmed_mapping_generation`、`pending_operation`和`gap`。游标或历史过期时保留gap，维护者核查缺失范围后处理；旧游标及原事件身份继续留存。

## QQ原生能力与Provider要求

Provider是提供原生QQ窗口路由和事件的渠道组件。启用窗口采集时，它须支持以下四个接口，Core的NapCat传输层调用对应MCP工具：

| Core接口 | Provider MCP工具 |
|---|---|
| registerOwnerWindowRoute | napcat_owner_window_route_register |
| getOwnerWindowRoute | napcat_owner_window_route_get |
| closeOwnerWindowRoute | napcat_owner_window_route_close |
| readOwnerWindowEvents | napcat_owner_window_events_read |

窗口路由使用独立身份，注册要求`capture_owner_events=true`、`reply_delivery=events_only`和`window_capture=true`。Core映射generation与Provider路由generation分别保存，事件读取和关闭核对原路由、组件对话及原生预期代次。

当前Provider首次打开或重新打开窗口时，读取最近最多50条历史作为基线，之后采集符合条件的新消息。本人sender须命中私有允许列表，群消息还须@本机账号；私聊严格匹配已授权对方。引用已登记通知的消息优先交给原quote回信路径，窗口路径保留独立的原生窗口来源。

窗口事件缓存按JSON大小限制为1MiB，每页最多50条事件。正文未完整保留、缓存淘汰或游标过期时，Provider返回对应错误，Core保留阻塞或缺口。Core消息正文默认上限仍为256KiB。原生窗口事件和核心消息均保存准确来源、冻结映射及代次，重复读取沿原事件去重。

## 关闭新采集与恢复

将`window_ingress_enabled`设为false并按维护流程加载配置后，服务保留`channel_windows`、模型映射和原窗口来源。已有原生路由先按原游标取完已捕获页，再确认关闭；关闭结果未知时继续查询原操作，`capture.native_status=closed`可用于核对实际关闭结果。

已进入核心队列的旧pending消息继续使用采集时冻结的来源、目标和代次，prepared沿原message/delivery恢复，unknown只查询原投递。修改或释放当前映射后，旧事件仍按各自冻结的映射处理。

首次新窗口记录落盘后，恢复须保留能读取新状态的解析器（parser）、相关依赖，以及Core SQLite和Provider状态的最新完整账本，继续使用原配置、状态目录和端点。停止新采集时保留这些恢复资料，不用早期状态快照覆盖当前账本。部署与回退前需核对窗口记录、游标、消息、投递和去重状态的完整性。

已完成的原生窗口登记与撤销、合成原生接线和恢复检查，以及待补的自然新QQ到Codex样本，见[验证记录](VERIFICATION.md)。
