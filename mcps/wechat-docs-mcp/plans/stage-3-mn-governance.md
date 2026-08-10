# Stage 3：M:N 订阅、受控发送与文档合并

开始时间：2026-08-10 07:13 Asia/Shanghai
目标完成时间：2026-08-10 09:45 Asia/Shanghai
下一复核点：2026-08-10 08:20 Asia/Shanghai
事故缓冲：30 分钟，只用于兼容迁移、并发状态或离线候选验证。

## 目标

把 V1 的「一个 route 绑定一个 conversation」模型升级为 M:N：route 只表示一个精确微信会话资源，Codex conversation 通过独立 subscription/session 连接 route。微信事件每个 route 只物化一次，再向该 route 的所有 active subscription 独立投递、合并唤醒和精确 ACK。

同时完成安全文字发送骨架、附件按需接口、腾讯文档变化合并观察器，以及公开规则和本机派生规则模板。当前阶段只生成离线候选，不启用生产 outbound，不执行真实微信发送。

## 冻结合同

- 每个 subscription 只属于一个确定的 `(route_id, conversation_id, generation)` 组合；route 与 conversation 均可拥有多个 subscription。
- 新事件向 route 的所有 active subscription 建立独立 delivery，使用 `UNIQUE(subscription_id,event_id)` 防止同一 subscription 重复投递。
- 每个 subscription 独立读取、ACK、暂停和关闭；一个 subscription 的 ACK 不得清除其它 subscription 的未读 delivery。
- 新 subscription 从当前 route ingestion baseline 建链，不回放旧历史。
- route 身份由 `ownerAccountKey + username + chat_type` 精确确认，标题只作展示。
- outbound 每次显式指定唯一 route，不 fan-out；草稿、授权引用、TTL、内容哈希、dedupe、单次消费和数据库确认缺一不可。
- Tencent Docs 变化按文档/表单聚合，quiet window 为 5 分钟，max batch 为 15 分钟。

## 实施边界

- 兼容迁移不得清空或替换既有 `events.sqlite3`，必须先 SQLite backup，并提供回滚验证。
- 生产服务、broker、NapCat、微信客户端、route binding 和正式账本均不在本阶段写入范围；本机私有层只允许在备份后追加已核实的主人授权索引，不改变 route、schema 或 outbound 开关。
- 真实账号、route、conversation、授权引用、路径、消息和 token 不得进入公开源码、文档或夹具。
- UI 可见发送是默认设计；隐藏窗口消息仅可作为显式 experimental capability，默认关闭。

## 成功标准

- V1 形态账本可无损迁移成 route + subscription + delivery 模型，并能从备份恢复。
- 一个事件可向多个 active subscription 各投递一次，且 ACK、pause、close 互不影响。
- 发送状态仅使用 `PREPARED / APPROVED / EXECUTING / SEND_ATTEMPTED / VERIFIED / FAILED / UNKNOWN`，未经数据库确认不得声称成功。
- 同一 dedupe key 在进程重载后也不能再次执行，`UNKNOWN` 不自动重试。
- 附件接口记录来源、大小和 SHA-256，不自动执行或解压。
- 文档变化满足 5 分钟静默窗口和 15 分钟最长批次。
- 针对性测试、完整测试、公开脱敏扫描和离线 release 候选均通过。
