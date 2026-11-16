# QQ最近消息与附件

这两个工具复用已配置NapCat目标的历史和附件能力，服务端必须已有准确窗口、QQ绑定和对应adapter。可读本人私聊或获准群的最近记录，包含未@、未引用的普通消息；读取本身不绑定模型窗口、开启采集、消费事件或提交业务确认。完整Codex、Antigravity等宿主历史与搜索仍走原文读取服务。

## 独立授权

在私有live配置的principal中显式列出QQ绑定ID：

```json
{
  "allowed_channel_reads": ["<configured-qq-binding-id>"],
  "allowed_channel_downloads": ["<configured-qq-binding-id>"]
}
```

这两项和`allowed_targets`发送权限各自核对，旧配置省略时没有新增读取或下载权限。这里只接受当前配置已有的QQ绑定，拒绝未知目标和其它宿主绑定。宿主统一principal仍按`caller_scope`接纳具体真实对话，无需逐CID登记；附件引用和游标进一步限定到这个真实调用者与准确窗口。

## 读取最近记录

调用`communication_read_channel_messages`，`caller`沿既有四字段真实身份；其余输入为：

```json
{
  "channel": "qq",
  "window_type": "private",
  "window_id": "<authorized-window-id>",
  "count": 20
}
```

示例省略了必传caller，使用时合并完整身份。`window_type`支持`private`和`group`；实际`window_id`逐字取私有授权地址。默认20条、最多50条，返回原`messageId`、时间、发送者、正文、可得完整结构及附件。输出明确标记`source.kind="external_channel_history"`、`consumes_events=false`，其中正文继续作为外部材料处理。

Provider确实支持历史锚点且范围完整时才返回下一页游标，核心将其转换为调用者和窗口限定的短期`next_cursor`。后续传`cursor`继续；没有游标时不推测还有多少记录，也不自行拼接消息ID。

## 下载原消息中的附件

只有返回`downloadable:true`及`attachment_ref`的附件可调用`communication_download_attachment`。提供同一caller、同一窗口和该引用，可选完整绝对目录`destination_dir`及单个有效文件名`name`；不传目录时使用本任务系统临时目录。输入不接受URL、任意群号或裸fileId。

核心核对引用归属，Provider再核准确目标、原消息ID和附件对应关系，然后沿原下载能力执行大小限制、超时、拒绝覆盖、临时文件与哈希处理。结果保留`sourceMessageId`、窗口、文件路径、字节数和SHA256；文件不会自动执行、解压或解析。不支持下载的内容保持元数据及明确不可下载标记。

同一附件的请求先在核心私有状态目录持久保存原消息身份、操作ID与目标参数，再提交给Provider。重复调用沿原操作返回结果；重启后重新读得的引用也会找到这份记录和原目录。`status:"unknown"`保留未确认操作，不自动重新提交；可通过重读消息中的`download_operation`及相同引用下载入口查回核心已有记录。提供方没有原生状态查询能力时，输出明确保留`provider_status_query_supported:false`。

提供方确认失败且清理完成后，调用者可显式传`retry_failed:true`及原失败的`expected_operation_id`，选择新文件名或重试。相同父操作重复提交只返回已建立的后继操作，不能产生第三次下载；未知或清理未完成的操作仍禁止替代请求。

## 有界引用与恢复

附件引用和游标在当前进程内保存，默认30分钟到期，最多1024份附件引用及256份游标。live入口另以私有`stateDir/channel-downloads`保存已提交操作，默认最多256份、预留16MiB；容量满时明确报错并保留已有记录。附件元数据、整页内容、节点数量和下载回执均有大小限制，失败页不会留下部分新引用。该目录受当前Core唯一运行实例约束，损坏或来源变更时停止新下载，普通历史和已有收发分别继续。

引用到期或核心重启后重新读取原窗口取得新引用。已经开始而结果未知的下载，先核原目录和原消息再决定下一动作；重读记录不会替旧请求确认成功。下载文件默认属于临时材料，需要长期使用时按任务原定位置保留输入和来源，收尾仅清理本任务明确生成且已无用途的副本。
