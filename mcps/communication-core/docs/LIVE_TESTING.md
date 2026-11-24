# 宿主与渠道真实接入

真实入口使用仓库外的显式配置、宿主授权和独立状态目录。宿主可注册同一stdio门面为常驻MCP，十一项工具连接原HTTP核心与消息库；默认npm start保持mock隔离入口。原渠道迁移按其维护流程执行。

## 可选的Codex控制入口恢复

可以在Codex私有连接文件中显式加入`source_recovery`，原`base_url`、`token`和`relay`保持。它会执行本机维护者核验过的本地模块代码，模块路径不来自MCP消息；模块须提供`ensureCodexCommunication({mode})`函数。

```json
{
  "source_recovery": {
    "module_path": "<absolute-trusted-dir>/ensure-codex.mjs",
    "sha256": "<actual-64-hex-sha256>"
  }
}
```

模块加载前校验绝对本地`.mjs`路径、文件大小、SHA及固定导出。新业务发送前共享同一准备操作，只有`ok=true`、`status=ready`、原endpoint及合法binding才按就绪处理；精确运行实例、版本和配置核对由可信模块负责。`disabled`跳过自动准备，原endpoint业务路径保留。未配置该字段时沿原行为执行。

连接明确拒绝的GET只准备下一次连接，原业务未知时继续按原ID查询。挂接未知或待复核时保留原receipt/attempt，后继只inspect原结果；模块自身应持久保存控制操作的未知状态。业务取消后不会迟到发送，关闭入口会等待原准备操作结束，整段流程不增加watcher或周期任务。

该模块负责恢复已有宿主的控制入口。整个Codex宿主离线时，核心保存原消息并等待宿主恢复。变更私有连接后，受控重开交流核心加载，同一宿主MCP门面继续连接原核心，无须为这项内部接线再次刷新工具。

## 启动与客户端

交互启动：

```powershell
npm run live -- --config <私有配置.json> --state-dir <本次状态目录>
```

独立监听入口适合由已有进程管理器持有，端点文件只保存本机地址和进程身份，不包含token：

```powershell
node scripts/live-service.mjs --config <私有配置.json> --state-dir <本次状态目录> --endpoint-file <私有端点.json>
```

同一个state-dir只运行一个实例，路径别名及改用其它端点文件也受同一实例锁保护。交互入口可在stdin输入shutdown；独立入口支持进程信号及受控父进程的shutdown IPC。正常关闭后端点标记closed，同配置和状态可重新启动。端点检查和独占检查先于核心启动，原资源完整关闭后才释放独占。

异常退出后，先核原管理任务、进程及端点，再以原配置、状态目录和端点文件加`--recover-terminated`恢复。已公布端口时，程序要求原PID确实不存在、双栈回环原端口均已关闭，并保留旧端点和独占记录。启动尚未公布端口就退出时，仅对身份完整的starting记录、明确消失的PID进行显式恢复。活动PID、PID复用、权限或归属未知、畸形记录及遗留恢复占用均保留原件并拒绝接管。

旧版本已有SQLite而没有实例锁时，先用`registerLegacyRuntime`登记可核准的原活动实例，核归属后停止该实例，再走同路径显式恢复。已关闭的旧实例须提供准确关闭收据和`adoptClosed:true`，并核原PID确实消失；没有这份依据时保持原状态等待核查。登记函数不停止原进程。此迁移只处理本次独立核心，不管理其它宿主或共享服务。

未安装到宿主工具列表时，可用受限SDK客户端做实际工具调用。connection文件包含该来源的token、identity和endpoint_file；request文件的最外层为`{"input": {...}}`，input内包含完整调用参数。该客户端用于核验单次原请求；多对话共用的宿主入口使用下面的stdio门面配置。

```powershell
node scripts/mcp-client.mjs --connection <来源连接.json> --request <原请求.json> --result <结果.json> --until delivery --wait-ms 20000
```

直到reply可等待关联回复；直到delivery用于取得实际投递结果，返回后继续检查delivery_status。超时或unknown沿原message/delivery查询，不换去重键重复提交。脚本不会安装工具、扩大目标授权或打印token。

## 配置边界

顶层`adapter_mode`为`live_test`，`host`只允许本机回环。`targets`中的静态目标须列入`allowed_conversation_ids`，身份、接入模块及binding代次相互匹配。动态宿主对话通过`conversation_routes`提供接线，并由principal的`allowed_target_scopes`授权；该范围精确到`machine_id`、`host`和`surface`。原有`allowed_targets`继续授权指定静态绑定，QQ私聊或已授权群出站使用这些渠道目标。密钥及真实账号、群和对话ID保存在仓库外。

宿主目录与近期内容使用独立的私有读授权。`allowed_host_lists`登记准许的`machine_id`、`host`和`surface`；`allowed_host_snapshots`另登记准许读正文的具体对话或明确的整端范围。启用整端读取前核实读入口和所配置桌面资料的账户归属。反重力接入可选`conversation_index_file`，只配置已获准的本机原生`conversation_summaries.db`绝对路径；只开核过的一次性副本做分页，原宿主目录保持。Codex需先在本机控制口启用独立读取凭据和可读范围，再在Core的私有连接文件设置`content_read_token`；读凭据与原投递凭据分开。原生未确认整轮可见性时保留能核实的状态和时间。

验收读取入口时，核对该进程实际能选到的连接范围，来源以已登记的可信宿主入口为准。反重力测试应包括桌面主对话、无头命令行与子代理行、已载入及未载入的授权目标。未载入目标只有在桌面目录存在、唯一原生来源返回同一身份后才尝试尾步查询；请求不保留定位响应正文。并行修改目录导致分页无法核对时，保留原读取边界，按原目录重新查询。

Codex 私有只读来源应按轮核完原生条目和可见性，终态轮次的 `body_visibility` 为 `verified`，可展示正文的 `visibility` 为 `visible`。原生分页未读完、读预算不足、轮次进行中或可见性未知时，此轮仅传状态与可取得的时间；其它已核准轮次仍可展示。对照同一份快照中不同轮次的这两种实际输出。

宿主统一入口的principal配置`caller_scope`，`identity`使用同一机器、宿主及surface，配置中的`conversation_id`为`*`，`origin_kinds`为`["agent_message"]`。门面的connection文件使用相同identity、token和caller_scope，例如：

```json
{
  "endpoint_file": "<absolute-private-dir>/endpoint.json",
  "identity": {
    "machine_id": "<machine-id>",
    "host": "codex",
    "surface": "desktop",
    "conversation_id": "*"
  },
  "caller_scope": {
    "machine_id": "<machine-id>",
    "host": "codex",
    "surface": "desktop"
  },
  "token": "<private-token>"
}
```

所有尖括号内容均需替换。每次工具调用的caller仍填写当前真实`machine_id`、`host`、`surface`和具体`conversation_id`；宿主统一入口内各对话可直接使用，无需逐CID登记。对话的消息读取、去重键和处理确认按实际caller区分。旧的单对话授权继续有效，门面选连接时优先匹配宿主范围。

`conversation_routes`的每项指定机器、宿主、surface、`adapter_id`和投递能力，当前支持Antigravity及Codex宿主接线。已启用且获授权的宿主可直接用`host`和CID解析或发送；省略机器时使用caller所在机器。目录保存静态目标和已登记的动态地址。解析结果中的`adapter_id`、`capabilities`、`evidence`用于说明接线，send只接收schema列出的地址或六项绑定字段，完整示例见[README](../README.md#按宿主和对话id发送)。

| 接入类型 | 目标host | 配置与当前能力 |
|---|---|---|
| antigravity | antigravity | 按本机进程及准确root定位LS，保留原模型配置，投递和原生最终正文观测 |
| codex_proxy | codex | connection_file保存明确回环控制地址及token，按原delivery查询准确来源、目标和完成turn正文 |
| napcat_owner | qq | 明确NapCat地址、出站及events_only路由；引用回信自动回原宿主，窗口采集另行配置 |

Antigravity当前通过SendUserCascadeMessage投递，代理身份写明在正文中，使用NEXT_INVOCATION或WHEN_IDLE的准确枚举。原生final依据stopReason确认，进度步骤另行记录。SendAgentMessage的独立协作角色仍需另外验证。

Codex使用原代理维护线提供的/v1/communication/deliveries及其查询、replies入口。逐页核对来源、原消息和binding代次，自动观测仅关联完成的turn/start；同轮中途steer的答复通过准确in_reply_to工具回信关联。SDK复用原代理控制连接，控制实例上线与核心客户端测试分别验收。

NapCat账号、目标、发送核验、去重和原渠道回复仍由原组件维护。经过原组件核验并持久保存的出站回执，可保存严格数字格式的原QQ消息编号；其它外部返回字段按白名单剥除。受理未知时保留原身份，只有准确查询取得明确证据才推进，不通过重新发送来查询。

核心使用独立events_only路由取得原外发引用、真实sender、原生消息和捕获代次，再核私有本人身份及冻结的原发送方绑定。原QQ事件与待转交消息同事务保存，自动回送准确原AG或Codex对话，原维护wake保持独立。业务答复要回原QQ渠道；模型只在宿主窗口回复时，QQ回信仍待发送。

新Codex消息默认message_visibility=hidden，显式visible保留全部气泡。hidden沿既有显示规则隐藏同轮中途气泡、保留空闲新轮首条简短消息；旧缺字段的存量保持原visible及原ID。只有原投递、原绑定、原代次及明确request_sent=false的busy证据完整时才允许安全重试；unknown先查原delivery，取得该未发送证明后才恢复待送。

发送默认`delivery_policy=next_model_boundary`，宿主支持时在下一接收边界中途送入，原工具继续执行；仅明确延后时使用`when_idle`。普通QQ出站使用已授权渠道目标，窗口与模型的对应关系用于接收人类来信，配置和关闭方式见[聊天窗口与模型对话](CHANNEL_WINDOWS.md)。

## 状态查询

`communication_get_status`只读查询当前状态。下面是查询整宿主的完整参数模板；替换占位值后使用，加入`conversation_id`可查询指定对话，也可单独使用旧`binding_id`：

```json
{
  "caller": {
    "machine_id": "<caller-machine-id>",
    "host": "codex",
    "surface": "desktop",
    "conversation_id": "<actual-caller-cid>"
  },
  "host": "codex"
}
```

整宿主查询只取宿主快照，`conversation_exists`、`conversation_running`和`can_deliver`保持`unknown`；`delivery_modes`中已配置关闭的模式保留false，其余保持unknown。指定CID后，服务再核对该对话的存在、运行状态、直接输入条件和投递能力。

| 字段 | 含义 |
|---|---|
| host_online | 本次只读探测是否确认宿主接口在线 |
| transport_ready | 当前传输是否就绪；Codex核对可用客户端及上下游连接 |
| control_enabled | Codex原生控制入口是否启用 |
| control_ready | Codex控制入口是否通过当前端点、配置与实例绑定核对 |

| 字段 | 含义 |
|---|---|
| host_can_receive | 宿主发送接线、在线、传输及所需控制条件的综合接收能力 |
| conversation_exists、conversation_running | 指定CID的存在与当前运行状态 |
| can_deliver、delivery_modes | 指定CID是否满足投递条件，以及各模式的实际可用状态 |
| configured_delivery_modes | 配置声明的投递能力 |

字段使用true、false或`"unknown"`。unknown表示本次证据不足，例如未配置读取器、字段缺失、探测超时或宿主返回了未知枚举；结合`observed_at`、`source`及可用的`code`、`reason`、`raw_status`核对原因。各字段按自身含义阅读，例如发送接线关闭时`host_can_receive=false`，宿主接口仍可能在线。conversation_running取本次宿主返回的运行状态。

Codex通过私有连接中的`status_source`加载经路径和SHA校验的只读状态模块；v2分别提供原生启用状态与实例核对结果，缺失值保持unknown。Antigravity通过LS只读接口取状态。可选`status_hosts:["windsurf"]`提供Windsurf/Devin Desktop只读状态；WSF原生MCP调用者可在获准范围内向已支持目标发送，核心到WSF的入站尚未接线，其`host_can_receive=false`。具体部署的状态读取器及版本须在该部署的验收记录中核对。

Windsurf/Devin Desktop读取器核对安装位置、UI主进程和ACP子进程身份，支持CLI会话slug与Desktop的40位摘要ID。指定slug时以确定性摘要和本地显式映射交叉核对，SQLite只按会话与节点索引读取存在、持久模型选择和白名单调用元数据，不导出聊天正文、不扫描或复制会话库。正常只读连接包含已提交WAL；SQLite协调可能更新既有SHM文件的读标记或时间。无法核实的进程、映射、锁或字段保留unknown，单个锁文件不作为正在运行的证据。

### 模型观察

指定对话时，`model_observation.current_selection`表示本次取得的该对话当前模型配置，`last_invocation`表示有限尾部步骤中最近可核对的实际调用。两者分别返回`model`、`source`、字段路径和可取得的提供方、推理档位及时间；取不到的那一项返回`model:"unknown"`及具体原因。整宿主查询不选择某条对话代替，模型项保留`model_conversation_required`。

Codex当前配置来自现有thread inspect的`thread.model`、`modelProvider`和`reasoningEffort`，摘要未给出最近调用时保留该项未知。AG最近调用只读取身份已核对轨迹的最多32个尾部步骤，保留原模型枚举、步骤身份和创建时间；另用只读`GetCascadeModelConfigData`查询当前目录，唯一匹配时附友好名称。可取得的当前模型配置单独核对具体CID，不采用全局默认值替代。

Windsurf的磁盘模型选择附在`current_selection.raw_model`并标明持久来源，当前GUI选择缺少独立证据时`current_selection.model`保持unknown。`last_invocation`从指定会话的`main_chain_id`沿主链最多回溯32个节点，只投影模型、原请求与调用时间等白名单元数据，核对最近一组同请求调用记录的一致性，遇到前一不同请求时结束；其它分支和其它会话不参与选择。返回来源字段、节点和调用起止时间，缺失、已检查记录冲突或超出预算时该项保持unknown。该读取不负责全历史请求去重。宿主离线时仍可核对保存的目标是否存在；真实运行态及接收能力按各自证据返回。新Devin ACP与旧LS对话接口的能力分开，实际入站和忙碌插话仍须另验，模型观察不会开启发送能力。

模型读取有独立短期限，一项超时只改变对应模型观察，已经得到的宿主在线、对话运行和投递结果继续返回。完整历史和搜索继续由原文读取服务负责。QQ最近内容和附件的独立授权见[最近内容与附件](CHANNEL_CONTENT.md)。

## 验证与证据

live-probe验证独立MCP收发和重开；live-busy-probe只在真实工具处于运行状态时发送一次补充；受控preflight故障可用live-probe的显式选项验证原身份恢复。故障输入、结果、SQLite、原生正文和必要工具输出应持久保留，排除thinking、凭据及无关历史。

定位失败发生在变更RPC之前时，消息保持可恢复的prepared并按持久化退避重试；变更RPC之后受理未知时，只查原请求。模型回信和业务processing各自保存，当前最终正文观测不会自动确认done。

当前冻结候选、合成原生窗口及双冷启恢复的记录见[验证记录](VERIFICATION.md)。真实Windows登录、系统重启及自然新QQ窗口消息到Codex的样本仍待验证。
