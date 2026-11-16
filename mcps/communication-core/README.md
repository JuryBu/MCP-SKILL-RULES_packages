# 交流核心

交流核心提供十项MCP工具，用于按宿主和对话ID定位目标、发送消息、等待关联回信、查询状态、读取获准QQ窗口的最近消息和下载其中的附件，以及管理聊天窗口对应的模型对话。核心保存准确来源与目标、待送消息、投递尝试和精确处理确认，宿主连接通过独立接入模块实现。

默认启动入口使用mock隔离接入，测试目标与回执标记为simulated。显式live_test入口支持Antigravity、Codex控制端和NapCat通知、引用回信及可选QQ窗口采集；同一核心可通过stdio门面注册为宿主常驻MCP。Windsurf/Devin Desktop可配置只读进程与目标SQLite状态探测，支持会话slug、Desktop摘要ID和主链上的最近实际调用模型；原生MCP调用者可向已支持的目标发信，核心到WSF的入站尚未接线。客户端契约见[宿主接入模块契约](docs/ADAPTER_CONTRACT.md)，配置见[真实接入说明](docs/LIVE_TESTING.md)。NapCat、微信的原账本、账号、附件和发送授权继续由原组件负责。

## 运行

需要Node.js 24.12或以上。该最低版本的node:sqlite仍输出实验性提示；本项目使用本机SQLite保存通信状态。依赖及协议接口固定在package-lock.json中。

从仓库根安装本模块依赖：

```powershell
npm ci --prefix mcps/communication-core --ignore-scripts --no-audit --no-fund
```

完整隔离演示会建立自己的临时状态与虚构身份，启动独立进程，走MCP收发，再正常退出并用原状态重开：

```powershell
npm run demo --prefix mcps/communication-core
```

手动启动隔离服务时，显式指定配置与独立状态目录：

```powershell
$state = Join-Path ([IO.Path]::GetTempPath()) ('communication-core-isolated-' + [guid]::NewGuid().ToString('N'))
node mcps/communication-core/src/cli.mjs --config mcps/communication-core/examples/isolation.config.json --state-dir $state
```

服务只监听本机地址，启动行给出MCP URL。连接使用私有配置中的Bearer token，可授权一个准确对话，也可通过caller_scope授权同一机器、宿主和surface下的对话。宿主统一入口配置好后，各对话填写自己的真实caller即可使用，无需逐CID登记或逐对话开通。示例token只用于虚构目标，真实授权配置保存在仓库外。

CLI支持Ctrl+C，以及由启动者持有的stdin管道输入shutdown后正常退出。重开时沿用原state-dir，消息与投递身份保持。宿主常驻MCP按下节显式配置，组件启动与宿主工具注册分别维护。

## 常驻MCP与broker

`scripts/broker-stdio.mjs`提供相同的十项工具，只转交到已运行的原HTTP核心。关闭门面会关闭自身连接，核心及原消息库继续由原运行器持有。

宿主使用stdio配置启动该脚本，通过环境变量`COMMUNICATION_CORE_FACADE_REGISTRY`指向仓库外的绝对路径JSON：

```json
{"version":1,"connections":[{"connection_file":"<absolute-private-dir>/source.connection.json"}]}
```

示例中的尖括号内容均为占位值，使用前替换为本机实际配置。每个connection文件包含`endpoint_file`、完整`identity`和独立`token`；宿主统一入口再配置与核心principal一致的`caller_scope`，配置身份中的`conversation_id`为`*`。每次工具调用显式填写真实caller的`machine_id`、`host`、`surface`和具体`conversation_id`，门面据此选择连接，再核对登记与连接版本。来源由本机可信入口声明，当前门面核对的是登记授权，宿主来源鉴别仍依赖该可信入口。

共享broker另有可选`/communication-core/mcp`入口。启用时设置`CODEX_TOOLKIT_ENABLE_COMMUNICATION_CORE_MCP=1`、私有登记表指针及可选`COMMUNICATION_CORE_MCP_ROOT`，仍启动同一stdio门面。现役broker新增静态端点所需的进程加载与共享会话保护须单独核验；宿主可先直接使用stdio，保持原核心和原状态目录。

## 工具

| 工具 | 动作 | 主要输入 |
|---|---|---|
| communication_list_conversations | 分页列出已知且获授权的目标 | caller；可选host、limit、cursor |
| communication_resolve_target | 解析对话地址或旧绑定 | caller、host＋conversation_id，或binding_id |
| communication_send_message | 持久保存并提交原消息 | caller、origin、target、dedupe_key、text、expires_at |
| communication_get_message | 查询原消息与投递状态 | caller、message_id |

| 工具 | 动作 | 主要输入 |
|---|---|---|
| communication_wait | 有界等待回信、处理或投递事件 | caller、message_id、until、after_cursor、wait_ms |
| communication_ack_processing | 确认本人对话处理的精确消息 | caller、message_id、delivery_id、原代次、processing |
| communication_get_status | 查询整宿主或指定对话的状态 | caller、host；指定对话时再带conversation_id，兼容binding_id |
| communication_manage_channel_binding | 管理QQ及预留微信窗口对应的模型对话 | caller、action；按动作提供窗口地址和expected_generation |

| 工具 | 动作 | 主要输入 |
|---|---|---|
| communication_read_channel_messages | 读取获准QQ窗口最近消息，包含普通未@内容 | caller、channel、window_type、window_id；可选count、cursor |
| communication_download_attachment | 按原消息中的受限引用下载附件 | caller、窗口地址、attachment_ref；可选destination_dir、name |

## 按宿主和对话ID发送

已启用宿主的目标直接写`host`和`conversation_id`。`machine_id`省略时使用caller所在机器，`surface`通常为`desktop`；私聊、群或其它surface存在歧义时显式填写。宿主接线和发送授权由私有配置提供，各目标对话无需逐个开通。目录列出静态配置和运行中已登记的目标，已知准确地址时可直接发送。

下面是`communication_send_message`的完整参数模板。所有尖括号内容都需替换，`expires_at`填写实际有效的ISO时间：

```json
{
  "caller": {
    "machine_id": "<caller-machine-id>",
    "host": "antigravity",
    "surface": "desktop",
    "conversation_id": "<actual-caller-cid>"
  },
  "origin": {
    "kind": "agent_message",
    "channel": "antigravity",
    "source_ref": "example-request-001"
  },
  "target": {"host": "codex", "conversation_id": "<target-cid>"},
  "dedupe_key": "example-request-001",
  "text": "请核对这次请求并回复结果。",
  "expires_at": "<future-ISO-time>"
}
```

也可先调用`communication_resolve_target`，其返回的target包含`adapter_id`、`capabilities`和`evidence`等元数据。发送时只取schema允许的地址字段，或取`machine_id`、`host`、`surface`、`conversation_id`、`binding_id`、`binding_generation`这六项绑定字段；将完整解析结果传给send会因额外字段被拒绝。

普通QQ私聊和已授权群发送使用已有QQ目标授权，无需建立窗口模型绑定。QQ地址中的`conversation_id`对应渠道登记的target_key，准确私聊或群由原渠道配置确定。`channel_windows`用于把聊天窗口映射到接收人类来信的模型对话，配置方法见[聊天窗口与模型对话](docs/CHANNEL_WINDOWS.md)。

## 消息与回执

同源同dedupe_key的相同请求返回原message_id和delivery_id，改变内容会冲突。发送前持久保存原请求；写后断连或结果未知时保持unknown，并查询原delivery。宿主已接受的正文在重开后保持原身份。

宿主受理、模型获得消息、页面显示和业务处理分别保存。普通回信携带in_reply_to，只有原接收者及匹配目标的回复才能满足等待；业务done由接收对话单独确认。原渠道回执映射保留task或subscription、generation、wake和明确事件集合，核心不自动执行原渠道ACK。

默认消息正文上限为256KiB，附件通过受限引用传递；等待最长45秒，返回恢复游标。模型HTTP传输、恢复和容量由原模型代理维护。发送默认`next_model_boundary`，在宿主支持的下一接收边界中途送入，原工具继续执行；仅明确要求延后时选择`when_idle`。能力不足时保留待办并报告原因。

Codex新消息的`message_visibility`默认`hidden`，可显式选`visible`。hidden沿宿主原有投影隐藏同轮中途气泡，空闲开启新轮时保留首条简短消息，模型仍收到正文；visible保留全部气泡。显示以简短来源和正文为主，完整来源与追踪字段保存在原记录中。旧存量缺少该字段时按原visible行为查询，同键恢复保持原身份。

`communication_get_status`可查询整宿主，或加入具体CID查询该对话。结果分别给出传输、控制入口和接收能力，指定对话另含可取得的当前模型配置及最近调用观察，各自保留来源和时间。`unknown`表示该项本次未取得可核对结果，模型观察失败保留已取得的在线和运行状态。字段及示例见[状态查询说明](docs/LIVE_TESTING.md#状态查询)。

QQ最近内容直接复用NapCat的已配置目标历史与下载接口，包含未@或未引用的普通消息。读取无需绑定窗口或开启持续采集，也不会确认原事件。完整宿主历史、搜索和未知对话ID仍由已有原文读取服务提供；QQ权限、游标与附件恢复边界见[最近内容与附件](docs/CHANNEL_CONTENT.md)。

## 验证

```powershell
npm run check --prefix mcps/communication-core
npm test --prefix mcps/communication-core
npm run demo --prefix mcps/communication-core
```

隔离验证覆盖直接寻址、来源与发送许可、消息去重、未知受理、精确处理确认、回信身份、有界等待、状态查询、窗口归属及重开恢复。1191项属于窗口采集版本，模型观察与QQ内容版本为1317/1317；随后加入WSF只读状态及发现资源修复的完整回归为1372/1372，93个模块语法检查通过，各次构建与后续变更分别见[验证记录](docs/VERIFICATION.md)。未绑定窗口get的MCP空结果封装已有正式HTTP回归；原生MCP已完成窗口登记、读取、分页列表和撤销，并确认原生路由打开后关闭。另有独立检查、合成原生窗口和同版冷启恢复证据。真实Windows登录、系统重启及自然新QQ窗口消息到Codex的样本仍待验证，历史真实AG、Codex与QQ引用回信按各自原件范围保留。

本次实际运行结果及剩余边界见[独立测试版验证](docs/VERIFICATION.md)。

专用真实宿主入口、受限客户端和各接入类型见[真实接入说明](docs/LIVE_TESTING.md)。原mock入口保持独立，真实配置和凭据放仓库外。

MCP实现使用[TypeScript SDK 1.27.1](https://github.com/modelcontextprotocol/typescript-sdk/tree/v1.27.1)，持久化使用[Node.js SQLite接口](https://nodejs.org/docs/latest-v24.x/api/sqlite.html)。
