import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createNapCatNotifier, NapCatNotifierError } from "./core.mjs";
import { createTaskRegistry, TaskRegistryError } from "./task-registry.mjs";
import { createTaskRouterController } from "./task-router-controller.mjs";
import { createControlState, ControlStateError } from "./control-state.mjs";
import { createControlPlane } from "./control-plane.mjs";
import { withOutgoingDeliveryTracking } from "./delivery-result.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function sdkCandidates() {
  const candidates = [
    process.env.MCP_SDK_ROOT,
    path.resolve(__dirname, "..", "..", "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm"),
    path.join(
      process.env.USERPROFILE || "",
      ".gemini",
      "antigravity",
      "mcp-memory-store",
      "node_modules",
      "@modelcontextprotocol",
      "sdk",
      "dist",
      "esm",
    ),
  ].filter(Boolean);
  return [...new Set(candidates.map((candidate) => path.resolve(candidate)))];
}

function findSdkRoot() {
  for (const candidate of sdkCandidates()) {
    if (
      fs.existsSync(path.join(candidate, "server", "index.js"))
      && fs.existsSync(path.join(candidate, "server", "stdio.js"))
      && fs.existsSync(path.join(candidate, "types.js"))
    ) {
      return candidate;
    }
  }
  throw new Error("找不到 MCP SDK，请由 broker 注入 MCP_SDK_ROOT");
}

const sdkRoot = findSdkRoot();
const [{ Server }, { StdioServerTransport }, types] = await Promise.all([
  import(pathToFileURL(path.join(sdkRoot, "server", "index.js")).href),
  import(pathToFileURL(path.join(sdkRoot, "server", "stdio.js")).href),
  import(pathToFileURL(path.join(sdkRoot, "types.js")).href),
]);

const {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListResourceTemplatesRequestSchema,
} = types;

const eventProperties = {
  task_id: { type: "string", description: "训练任务 task_id。" },
  event: {
    type: "string",
    enum: ["started", "heartbeat", "paused", "resumed", "stopped", "recovery", "completed", "test"],
    description: "固定训练事件类型。",
  },
  dedupe_key: {
    type: "string",
    description: "调用方生成的唯一去重键；同一事件重试必须复用同一个值。",
  },
  delivery_id: { type: "string", minLength: 1, maxLength: 128, description: "可选稳定送达编号；省略时由 dedupe_key 确定性生成。" },
  run_id: { type: "string", description: "可选运行编号。" },
  progress: { type: "string", description: "可选进度，例如 epoch 3/10 或 step 18000。" },
  checkpoint_at: { type: "string", description: "可选最近完整 checkpoint 时间。" },
  next_check_at: { type: "string", description: "可选下次计划检查时间。" },
  summary: { type: "string", description: "可选简短摘要，最多 500 字符。" },
};

const eventInputSchema = {
  type: "object",
  properties: eventProperties,
  required: ["task_id", "event", "dedupe_key"],
  additionalProperties: false,
};

const readInputSchema = {
  type: "object",
  properties: {
    count: { type: "integer", minimum: 1, maximum: 50, description: "读取条数，默认 20。" },
    message_seq: { type: "string", description: "可选起始消息序号，用于向前分页。" },
    reverse_order: { type: "boolean", description: "是否反向排序，默认 false。" },
    task_id: { type: "string", minLength: 1, maxLength: 128, description: "可选任务 ID；提供时只返回正文中含精确“任务：<task_id>”标记的消息。" },
    include_self_history: { type: "boolean", description: "诊断时显式包含当前账号自己的 self 历史；默认 false，任务扫描不得开启。" },
  },
  additionalProperties: false,
};

const groupFileStatusInputSchema = {
  type: "object",
  properties: {
    target_key: {
      type: "string",
      minLength: 1,
      maxLength: 64,
      description: "可选 binding.controlPlane.targets 里的群聊目标；省略时查询固定 ExampleGroup 群。",
    },
    file_count: {
      type: "integer",
      minimum: 1,
      maximum: 5000,
      description: "读取根目录最近文件数量，默认 100，最多 5000。",
    },
  },
  additionalProperties: false,
};

const canonicalMachineRoleSchema = {
  type: "string",
  enum: ["development", "training"],
};

const textInputSchema = {
  type: "object",
  properties: {
    text: { type: "string", minLength: 1, maxLength: 1000, description: "写入固定格式消息中的正文。" },
    dedupe_key: { type: "string", minLength: 1, maxLength: 200, description: "唯一去重键；同一次重试必须复用。" },
    delivery_id: { type: "string", minLength: 1, maxLength: 128, description: "可选稳定送达编号；省略时由 dedupe_key 确定性生成。" },
    task_id: { type: "string", minLength: 1, maxLength: 128, description: "可选任务 ID；提供时发送可按任务精确读取的结构化消息。" },
    source_machine: { ...canonicalMachineRoleSchema, description: "可选来源机器标准角色。" },
    target_machine: { ...canonicalMachineRoleSchema, description: "可选目标机器标准角色。" },
    reply_required: { type: "boolean", description: "结构化任务是否要求业务回复；运输回执 machine_received/conversation_received 不算业务回复。" },
    expected_reply: { type: "string", minLength: 1, maxLength: 240, description: "reply_required=true 时最终必须返回的固定业务回复。预计超过 60 秒可先回 IN_PROGRESS，但不能替代该最终回复。" },
    reply_deadline_at: { type: "string", format: "date-time", description: "可选最终业务回复截止时间。" },
    next_check_at: { type: "string", format: "date-time", description: "可选下一次状态检查时间；用于超过 60 秒的处理中状态。" },
  },
  required: ["text", "dedupe_key"],
  allOf: [{
    if: { required: ["task_id"] },
    then: { required: ["source_machine", "target_machine"] },
  }, {
    if: { anyOf: [
      { required: ["reply_required"] },
      { required: ["expected_reply"] },
      { required: ["reply_deadline_at"] },
      { required: ["next_check_at"] },
    ] },
    then: { required: ["task_id"] },
  }, {
    if: { properties: { reply_required: { const: true } }, required: ["reply_required"] },
    then: { required: ["expected_reply"] },
  }],
  additionalProperties: false,
};

const fileInputSchema = {
  type: "object",
  properties: {
    file_path: { type: "string", minLength: 1, maxLength: 4096, description: "本机待上传文件的绝对路径。" },
    name: { type: "string", minLength: 1, maxLength: 255, description: "可选群文件显示名，不能包含目录。" },
    dedupe_key: { type: "string", minLength: 1, maxLength: 200, description: "唯一去重键；同一次重试必须复用。" },
    delivery_id: { type: "string", minLength: 1, maxLength: 128, description: "可选稳定送达编号；省略时由 dedupe_key 确定性生成，用于跟踪文件索引送达状态。" },
    task_id: { type: "string", minLength: 1, maxLength: 128, description: "可选任务 ID；提供时 source_machine 和 target_machine 也必须提供，上传后会发送可路由的文件索引。" },
    source_machine: { ...canonicalMachineRoleSchema, description: "任务文件来源机器标准角色；task_id 存在时必填。" },
    target_machine: { ...canonicalMachineRoleSchema, description: "任务文件目标机器标准角色；task_id 存在时必填。" },
  },
  required: ["file_path", "dedupe_key"],
  additionalProperties: false,
};

const configuredFileInputSchema = {
  type: "object",
  properties: {
    target_key: { type: "string", minLength: 1, maxLength: 64, description: "binding.controlPlane.targets 中已配置的群聊或私聊目标 key；不会降级到固定训练群。" },
    file_path: { type: "string", minLength: 1, maxLength: 4096, description: "本机待上传文件的绝对路径。" },
    name: { type: "string", minLength: 1, maxLength: 255, description: "可选文件显示名，不能包含目录。" },
    dedupe_key: { type: "string", minLength: 1, maxLength: 200, description: "唯一去重键；同一次重试必须复用。" },
    delivery_id: { type: "string", minLength: 1, maxLength: 128, description: "可选稳定送达编号；省略时由 dedupe_key 确定性生成。" },
  },
  required: ["target_key", "file_path", "dedupe_key"],
  additionalProperties: false,
};

const chatFileInputSchema = fileInputSchema;
const configuredChatFileInputSchema = configuredFileInputSchema;

const downloadInputSchema = {
  type: "object",
  properties: {
    file_id: { type: "string", minLength: 1, maxLength: 2048, description: "从固定 ExampleGroup 群消息附件或任务文件索引中读取到的原始 file_id/fileUuid。" },
    message_seq: { type: "string", minLength: 1, maxLength: 64, description: "可选文件附件消息或旧 TASK_FILE_INDEX 消息序号；NapCat 重启、缓存失效或旧索引使用内部 ID 时用于刷新历史并恢复真实 fileUuid。" },
    real_seq: { type: "string", minLength: 1, maxLength: 64, description: "可选真实群历史序号；聊天附件跨机下载时用于定位同一条真实群消息。" },
    busid: { type: "integer", minimum: 0, description: "可选群文件 busid；从附件或任务文件索引中原样传入。" },
    file_transport: { type: "string", enum: ["group_file_upload", "chat_attachment"], description: "可选文件来源：群文件区上传或聊天气泡附件；来自 TASK_FILE_INDEX 的 file_transport。" },
    file_name: { type: "string", minLength: 1, maxLength: 255, description: "可选远端文件名；file_id 在接收端缓存失效时用于按名称恢复当前可下载 UUID。" },
    file_bytes: { type: "integer", minimum: 1, description: "可选远端文件字节数；与 file_name 一起用于避免同名文件误匹配。" },
    destination_dir: { type: "string", minLength: 1, maxLength: 4096, description: "本机保存目录的绝对路径；目录不存在时自动创建。" },
    name: { type: "string", minLength: 1, maxLength: 255, description: "可选本地文件名，不能包含目录；目标已存在时拒绝覆盖。" },
  },
  required: ["file_id", "destination_dir"],
  additionalProperties: false,
};

const taskRegisterInputSchema = {
  type: "object",
  properties: {
    task_id: { type: "string", minLength: 1, maxLength: 128, description: "双方约定的稳定任务 ID。" },
    conversation_id: { type: "string", minLength: 1, maxLength: 256, description: "本机需要被唤醒的 Codex conversationId。" },
    local_role: { ...canonicalMachineRoleSchema, description: "本机标准角色。" },
    source_machine: { ...canonicalMachineRoleSchema, description: "任务消息来源机器标准角色。" },
    target_machine: { ...canonicalMachineRoleSchema, description: "任务消息目标机器标准角色。" },
    trusted_peer_qq: { type: "string", pattern: "^[0-9]{5,20}$", description: "该任务允许触发唤醒的对端 QQ 号。" },
    wake_cooldown_ms: {
      type: "integer",
      minimum: 30000,
      maximum: 120000,
      default: 60000,
      description: "存在活动唤醒时，两次成功自动唤醒之间的最短间隔；默认 60000（60 秒），最大 120000（120 秒）。没有活动唤醒时，新待办会立即触发。",
    },
  },
  required: ["task_id", "conversation_id", "local_role", "source_machine", "target_machine", "trusted_peer_qq"],
  additionalProperties: false,
};

const taskUpdateInputSchema = {
  type: "object",
  properties: {
    task_id: { type: "string", minLength: 1, maxLength: 128 },
    expected_generation: { type: "integer", minimum: 1, description: "当前路由代次；不匹配时拒绝更新。" },
    conversation_id: { type: "string", minLength: 1, maxLength: 256 },
    local_role: canonicalMachineRoleSchema,
    source_machine: canonicalMachineRoleSchema,
    target_machine: canonicalMachineRoleSchema,
    trusted_peer_qq: { type: "string", pattern: "^[0-9]{5,20}$" },
    wake_cooldown_ms: {
      type: "integer",
      minimum: 30000,
      maximum: 120000,
      description: "仅调整当前任务在已有活动唤醒时的自动唤醒间隔；范围 30000～120000，单独修改时不增加 generation。",
    },
  },
  required: ["task_id", "expected_generation"],
  additionalProperties: false,
};

const taskIdentityInputSchema = {
  type: "object",
  properties: {
    task_id: { type: "string", minLength: 1, maxLength: 128 },
    expected_generation: { type: "integer", minimum: 1, description: "参数名必须是 expected_generation，值原样使用当前 [NAPCAT_TASK_WAKE] 唤醒提示中的 generation。" },
  },
  required: ["task_id", "expected_generation"],
  additionalProperties: false,
};

const taskCloseInputSchema = {
  type: "object",
  properties: {
    task_id: { type: "string", minLength: 1, maxLength: 128 },
    expected_generation: { type: "integer", minimum: 1 },
    confirm_pending_empty: { type: "boolean", description: "调用方已核对本机没有未处理消息和 active wake。" },
    confirm_peer_ready: { type: "boolean", description: "最终结束时确认可信对端知情；迁移时确认 successor task 已完成双边握手。" },
    final_close: { type: "boolean", description: "任务确实永久结束时设为 true；不能与 successor_task_id 同时使用。" },
    successor_task_id: { type: "string", minLength: 1, maxLength: 128, description: "迁移时填写已登记且已握手的新 task_id；旧 task 只在新路由就绪后关闭。" },
  },
  required: ["task_id", "expected_generation", "confirm_pending_empty", "confirm_peer_ready"],
  oneOf: [
    { required: ["final_close"], properties: { final_close: { const: true } } },
    { required: ["successor_task_id"] },
  ],
  additionalProperties: false,
};

const taskListInputSchema = {
  type: "object",
  properties: {
    task_id: { type: "string", minLength: 1, maxLength: 128 },
    status: { type: "string", enum: ["open", "closed"] },
  },
  additionalProperties: false,
};

const taskStatusInputSchema = {
  type: "object",
  properties: {
    task_id: { type: "string", minLength: 1, maxLength: 128 },
  },
  required: ["task_id"],
  additionalProperties: false,
};

const taskAckInputSchema = {
  type: "object",
  properties: {
    task_id: { type: "string", minLength: 1, maxLength: 128 },
    expected_generation: { type: "integer", minimum: 1, description: "参数名必须是 expected_generation，值原样使用当前 [NAPCAT_TASK_WAKE] 唤醒提示中的 generation。" },
    message_seq: { type: "integer", minimum: 0, maximum: 9007199254740991, description: "兼容升级前已发出的旧唤醒；新唤醒应使用 processed_message_seqs。" },
    processed_message_seqs: {
      type: "array",
      minItems: 1,
      uniqueItems: true,
      items: { type: "integer", minimum: 0, maximum: 9007199254740991 },
      description: "只列本次实际处理完成的一条或多条 QQ message_seq；未完成项不得列入，只能选择 wake_id 覆盖的消息。",
    },
    wake_id: { type: "string", minLength: 1, maxLength: 256, description: "[NAPCAT_TASK_WAKE] 提示中的 wake_id；新协议唤醒必须原样回传。" },
  },
  required: ["task_id", "expected_generation"],
  anyOf: [
    { required: ["processed_message_seqs", "wake_id"] },
    { required: ["message_seq"] },
  ],
  additionalProperties: false,
};

const deliveryStatusInputSchema = {
  type: "object",
  properties: {
    delivery_id: { type: "string", minLength: 1, maxLength: 128 },
  },
  additionalProperties: false,
};

const connectionRequestInputSchema = {
  type: "object",
  properties: {
    request_id: { type: "string", minLength: 1, maxLength: 128 },
    proposed_task_id: { type: "string", minLength: 1, maxLength: 128 },
    previous_task_id: { type: "string", minLength: 1, maxLength: 128 },
    reply_to_request_id: { type: "string", minLength: 1, maxLength: 128 },
    target_machine: canonicalMachineRoleSchema,
    source_conversation_id: { type: "string", minLength: 1, maxLength: 256 },
    target_conversation_id: { type: "string", minLength: 1, maxLength: 256 },
    reason: { type: "string", minLength: 1, maxLength: 600 },
  },
  required: ["proposed_task_id", "target_machine", "source_conversation_id"],
  anyOf: [
    { required: ["target_conversation_id"] },
    { required: ["reply_to_request_id"] },
    { required: ["previous_task_id"] },
  ],
  additionalProperties: false,
};

const ownerRouteInputSchema = {
  type: "object",
  properties: {
    route_key: { type: "string", minLength: 1, maxLength: 256 },
    conversation_id: { type: "string", minLength: 1, maxLength: 256 },
    task_id: { type: "string", minLength: 1, maxLength: 128 },
    target_key: { type: "string", minLength: 1, maxLength: 64 },
  },
  required: ["route_key", "conversation_id"],
  additionalProperties: false,
};

const ownerRouteMigrateInputSchema = {
  type: "object",
  properties: {
    route_key: { type: "string", minLength: 1, maxLength: 256 },
    expected_conversation_id: { type: "string", minLength: 1, maxLength: 256, description: "迁移前已关闭 route 的精确 conversation_id。" },
    expected_task_id: {
      anyOf: [
        { type: "string", minLength: 1, maxLength: 128 },
        { type: "null" },
      ],
      description: "迁移前已关闭 route 的精确 task_id；旧值为空时必须显式传 null。",
    },
    expected_target_key: { type: "string", minLength: 1, maxLength: 256, description: "迁移前已关闭 route 的精确 target_key。" },
    conversation_id: { type: "string", minLength: 1, maxLength: 256, description: "迁移后的新 conversation_id，必须与旧值不同。" },
  },
  required: ["route_key", "expected_conversation_id", "expected_task_id", "expected_target_key", "conversation_id"],
  additionalProperties: false,
};

const ownerAlertInputSchema = {
  type: "object",
  properties: {
    route_key: { type: "string", minLength: 1, maxLength: 256 },
    summary: { type: "string", minLength: 1, maxLength: 800 },
    reply_hint: { type: "string", minLength: 1, maxLength: 80 },
    level: { type: "string", enum: ["INFO", "MILESTONE", "ACTION", "WARNING", "FAILED", "COMPLETED"] },
    dedupe_key: { type: "string", minLength: 1, maxLength: 200 },
  },
  required: ["route_key", "summary", "dedupe_key"],
  additionalProperties: false,
};

const tools = [
  {
    name: "napcat_status",
    description: "只读检查 NapCat OneBot 连通性、登录账号和已绑定 ExampleGroup 群，不发送消息。",
    inputSchema: {
      type: "object",
      properties: {
        include_group: {
          type: "boolean",
          description: "是否同时查询并核对已绑定群，默认 true。",
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "napcat_discover_target",
    description: "只读按 binding 中固定的群名和成员数查找候选群，用于首次配置，不发送消息也不写 binding。",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "napcat_read_recent",
    description: "只读获取 binding 固定 ExampleGroup 群的最近消息及文件附件元数据；可按结构化 task_id 精确过滤，群号不能由调用方指定。",
    inputSchema: readInputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "napcat_group_file_status",
    description: "只读核对固定 ExampleGroup 群或配置群目标的群文件系统信息和根目录文件列表，用于诊断 upload_group_file/rich media transfer failed；不发送文件、不写去重账本。",
    inputSchema: groupFileStatusInputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "napcat_download_file",
    description: "通过最近消息或任务文件索引返回的原始 file_id/fileUuid 下载固定 ExampleGroup 群文件；首次 URL 查询失败时会刷新对应群历史后重试，不能指定群号或下载 URL，也不会覆盖已有文件。",
    inputSchema: downloadInputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "napcat_task_register",
    description: "在本机 broker 账本登记 task_id 与当前 Codex conversationId；同一任务不得静默换绑，发送端和接收端都应在任务开始时调用。",
    inputSchema: taskRegisterInputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "napcat_task_update",
    description: "用 expected_generation 原子更新任务路由或单条任务的唤醒间隔；路由实际变化时 generation 加一，但存在待处理消息或活动唤醒时会拒绝换绑，避免清空账本；仅改 wake_cooldown_ms 时不换代。",
    inputSchema: taskUpdateInputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "napcat_task_close",
    description: "谨慎关闭本机任务路由。关闭会停止该 task 的后续唤醒；必须确认账本为空、可信对端已就绪，并明确永久结束或已完成握手的 successor task。",
    inputSchema: taskCloseInputSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "napcat_task_list",
    description: "只读查看本机 task_id、conversationId、路由代次、消息游标与唤醒租约，可按任务或状态过滤。",
    inputSchema: taskListInputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "napcat_task_status",
    description: "只读获取一个 task_id 的完整本机路由状态；任务不存在时返回 null。",
    inputSchema: taskStatusInputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "napcat_task_router_status",
    description: "只读查看本机后台任务扫描器是否存活、最近扫描时间、下次扫描时间和错误状态。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "napcat_task_ack",
    description: "目标对话按消息精确确认处理结果。参数 expected_generation 必须原样使用唤醒提示中的 generation，wake_id 也必须原样回传；processed_message_seqs 只列实际处理完成项，未列消息继续待处理。message_seq 不保证数字递增。",
    inputSchema: taskAckInputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "napcat_delivery_status",
    description: "查看结构化消息的自动运输回执。pending 表示仅本机已发送；machine_received 表示对端机器已扫描到；conversation_received 表示可信任务消息已按绑定持久化进目标对话任务账本。任务 wake cooldown 只延迟 UI 提醒；这些状态都不等于业务处理完成 ACK。",
    inputSchema: deliveryStatusInputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "napcat_connection_request",
    description: "在旧 task 意外关闭或失联时发送建立连接请求。首次请求携带双方 conversationId 并由接收端本地持久保存；反向重连可用 reply_to_request_id 或 previous_task_id 恢复对端地址，不把 conversationId 重复塞进后续业务消息。只唤醒并请求确认，不替对端登记、绑定或接受 task。",
    inputSchema: connectionRequestInputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "napcat_owner_route_register",
    description: "把内部 route_key 登记到当前 Codex conversationId 和 binding 中预先配置的主人通知目标；首次登记或关闭后重开时自动以目标当前最近消息建立历史基线，避免旧私聊回放。route_key 用于本地回复路由，不展示给主人，也不允许调用方直接传 QQ 或群号。",
    inputSchema: ownerRouteInputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "napcat_owner_route_close",
    description: "关闭主人通知 route_key，之后不再把 QQ 回复注入该 Codex 对话。",
    inputSchema: { type: "object", properties: { route_key: { type: "string", minLength: 1, maxLength: 256 } }, required: ["route_key"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "napcat_owner_route_migrate",
    description: "显式迁移同一 route_key 的目标 Codex 对话。仅允许 existing route 已关闭且 bufferedOwnerMessages（缓冲消息）为空时执行，必须精确提供旧 conversation/target/task 身份；保留入站游标与历史基线，清除 closedAt 后重新打开。普通 napcat_owner_route_register 仍保持不可变字段，不能静默迁移。",
    inputSchema: ownerRouteMigrateInputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "napcat_owner_alert",
    description: "通过 binding 中预先配置的私聊或群聊目标，发送简短自然的主人通知。默认在末尾自动追加简短回复提示，也可用 reply_hint 自定义自然措辞。主人在私聊中必须引用该通知；群聊中必须引用该通知并 @ 本机 QQ，系统才会把回复精确送回对应 Codex 对话。单独图片、文件、转发或表情先持久缓冲，等后续明确文字时合并唤醒。内部 route_key 不展示给主人。",
    inputSchema: ownerAlertInputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "napcat_preview_training_event",
    description: "只生成固定格式训练通知正文和目标摘要，不发送消息。",
    inputSchema: eventInputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "napcat_send_training_event",
    description: "向 binding 绑定的固定 ExampleGroup 群发送训练事件。该工具会产生真实 QQ 群消息，发送前核对账号、群名和成员数，并使用 dedupe_key 防止重复。",
    inputSchema: eventInputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "napcat_preview_text",
    description: "预览固定 ExampleGroup 群文本消息，不发送。",
    inputSchema: textInputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "napcat_send_text",
    description: "向 binding 固定 ExampleGroup 群发送带 Codex 标识的文本消息；提供 task_id 时写入来源/目标机器和任务标记，便于另一台机器精确读取。不能指定群号，发送后执行消息核验与去重。",
    inputSchema: textInputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "napcat_preview_file",
    description: "读取本机文件大小并计算 SHA256，预览固定 ExampleGroup 群上传目标和可选任务路由信息，不上传文件。",
    inputSchema: fileInputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "napcat_send_file",
    description: "向 binding 固定 ExampleGroup 群上传一个本机文件；提供 task_id 时追加含 file_id 与 SHA256 的结构化索引，供对端任务自动唤醒、读取和下载。",
    inputSchema: fileInputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "napcat_preview_configured_file",
    description: "读取本机文件大小并计算 SHA256，预览 binding.controlPlane.targets 里指定的群聊或私聊目标；不会继承或降级到固定 ExampleGroup。",
    inputSchema: configuredFileInputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "napcat_send_configured_file",
    description: "向 binding.controlPlane.targets 里指定的群聊或私聊目标上传一个本机文件；group 走群文件上传与群文件列表核验，private 走私聊文件上传并从私聊历史尽力回读核验；不会发送跨机任务索引，也不会改用固定 ExampleGroup。",
    inputSchema: configuredFileInputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "napcat_preview_chat_file",
    description: "读取本机文件大小与 SHA256，预览把文件作为固定 ExampleGroup 群聊天区可见文件气泡发送；这是 send_group_msg 文件消息段，不是 napcat_send_file 的群文件区 upload_group_file。",
    inputSchema: chatFileInputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "napcat_send_chat_file",
    description: "向固定 ExampleGroup 群发送一个聊天区可见文件气泡；提供 task_id 时追加 file_transport=chat_attachment 的任务文件索引。核验按附件名、字节数、file_id 和真实群历史序号执行，不再按原始 CQ 文本逐字比较。",
    inputSchema: chatFileInputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "napcat_preview_configured_chat_file",
    description: "读取本机文件大小与 SHA256，预览向 binding.controlPlane.targets 中指定群聊或私聊发送聊天附件；不会继承或降级到固定 ExampleGroup，也不会发送跨机任务索引。",
    inputSchema: configuredChatFileInputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "napcat_send_configured_chat_file",
    description: "向 binding.controlPlane.targets 中指定群聊或私聊发送聊天区文件附件；群聊走 send_group_msg 文件消息段，私聊走 send_private_msg 文件消息段。失败或 UNKNOWN 不会降级到固定 ExampleGroup，不会发送跨机任务索引。",
    inputSchema: configuredChatFileInputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
];

function textResult(value, isError = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

function errorResult(error) {
  const knownError = error instanceof NapCatNotifierError || error instanceof TaskRegistryError || error instanceof ControlStateError;
  const safe = {
    ok: false,
    code: knownError ? error.code : "UNEXPECTED_ERROR",
    message: error?.message || String(error),
    outcomeUnknown: Boolean(error?.outcomeUnknown),
    details: knownError ? error.details : null,
  };
  console.error(`[napcat-mcp] ${safe.code}: ${safe.message}`);
  return textResult(safe, true);
}

const notifier = createNapCatNotifier({ cwd: path.resolve(__dirname, "..") });
const taskRegistryStatePath = process.env.NAPCAT_TASK_REGISTRY_PATH
  || path.resolve(__dirname, "..", "state", "task-registry.json");
const taskRegistry = createTaskRegistry({
  statePath: taskRegistryStatePath,
    wakeLeaseMs: Number(process.env.NAPCAT_TASK_WAKE_LEASE_MS || 300000),
    wakeCooldownMs: Math.min(Number(process.env.NAPCAT_TASK_WAKE_COOLDOWN_MS || 60000), 120000),
});
const taskRouterController = createTaskRouterController({ rootDir: path.resolve(__dirname, "..") });
const controlState = createControlState({
  statePath: process.env.NAPCAT_CONTROL_STATE_PATH
    || path.join(path.dirname(taskRegistryStatePath), "control-state.json"),
});
const controlPlane = createControlPlane({
  notifier,
  state: controlState,
  bridge: { wake: async () => { throw new Error("入站唤醒只由 task router 执行"); } },
});
const server = new Server(
  { name: "codex-napcat-training-notifier", version: "0.3.18" },
  {
    capabilities: {
      tools: { listChanged: false },
      resources: { listChanged: false, subscribe: false },
    },
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params.name;
  const args = request.params.arguments || {};
  try {
    if (name === "napcat_status") {
      return textResult({ ok: true, ...(await notifier.status(args)) });
    }
    if (name === "napcat_discover_target") {
      return textResult({ ok: true, ...(await notifier.discoverTarget()) });
    }
    if (name === "napcat_read_recent") {
      return textResult({ ok: true, ...(await notifier.readRecentMessages(args)) });
    }
    if (name === "napcat_group_file_status") {
      return textResult({ ok: true, ...(await notifier.groupFileStatus(args)) });
    }
    if (name === "napcat_download_file") {
      return textResult({ ok: true, ...(await notifier.downloadFile(args)) });
    }
    if (name === "napcat_task_register") {
      const task = taskRegistry.register({
        taskId: args.task_id,
        conversationId: args.conversation_id,
        localRole: args.local_role,
        sourceMachine: args.source_machine,
        targetMachine: args.target_machine,
        trustedPeerQq: args.trusted_peer_qq,
        wakeCooldownMs: args.wake_cooldown_ms,
      });
      return textResult({ ok: true, task, router: taskRouterController.ensureStarted() });
    }
    if (name === "napcat_task_update") {
      const updates = [
        "conversation_id",
        "local_role",
        "source_machine",
        "target_machine",
        "trusted_peer_qq",
        "wake_cooldown_ms",
      ];
      if (!updates.some((field) => Object.hasOwn(args, field))) {
        throw new TaskRegistryError("INVALID_ARGUMENT", "napcat_task_update 至少需要一个更新字段");
      }
      const task = taskRegistry.update({
        taskId: args.task_id,
        expectedGeneration: args.expected_generation,
        ...(Object.hasOwn(args, "conversation_id") ? { conversationId: args.conversation_id } : {}),
        ...(Object.hasOwn(args, "local_role") ? { localRole: args.local_role } : {}),
        ...(Object.hasOwn(args, "source_machine") ? { sourceMachine: args.source_machine } : {}),
        ...(Object.hasOwn(args, "target_machine") ? { targetMachine: args.target_machine } : {}),
        ...(Object.hasOwn(args, "trusted_peer_qq") ? { trustedPeerQq: args.trusted_peer_qq } : {}),
        ...(Object.hasOwn(args, "wake_cooldown_ms") ? { wakeCooldownMs: args.wake_cooldown_ms } : {}),
      });
      return textResult({ ok: true, task, router: taskRouterController.ensureStarted() });
    }
    if (name === "napcat_task_close") {
      return textResult({ ok: true, task: taskRegistry.close({
        taskId: args.task_id,
        expectedGeneration: args.expected_generation,
        confirmPendingEmpty: args.confirm_pending_empty,
        confirmPeerReady: args.confirm_peer_ready,
        ...(args.final_close === true ? { finalClose: true } : {}),
        ...(args.successor_task_id ? { successorTaskId: args.successor_task_id } : {}),
      }) });
    }
    if (name === "napcat_task_list") {
      return textResult({ ok: true, tasks: taskRegistry.list({
        ...(args.task_id ? { taskId: args.task_id } : {}),
        ...(args.status ? { status: args.status } : {}),
      }) });
    }
    if (name === "napcat_task_status") {
      return textResult({ ok: true, task: taskRegistry.get(args.task_id) });
    }
    if (name === "napcat_task_router_status") {
      return textResult({ ok: true, router: taskRouterController.status() });
    }
    if (name === "napcat_task_ack") {
      const task = taskRegistry.acknowledgeWake({
        taskId: args.task_id,
        expectedGeneration: args.expected_generation,
        seq: args.message_seq,
        wakeId: args.wake_id,
        processedMessageSeqs: args.processed_message_seqs,
      });
      return textResult({ ok: true, task });
    }
    if (name === "napcat_delivery_status") {
      return textResult({
        ok: true,
        ...(args.delivery_id
          ? { delivery: controlPlane.getDeliveryStatus(args.delivery_id) }
          : { deliveries: controlPlane.listDeliveryStatuses() }),
      });
    }
    if (name === "napcat_connection_request") {
      const result = await controlPlane.sendConnectionRequest(args);
      return textResult({ ok: true, ...result, router: taskRouterController.ensureStarted() });
    }
    if (name === "napcat_owner_route_register") {
      const route = await controlPlane.registerOwnerRoute(args);
      return textResult({ ok: true, route, router: taskRouterController.ensureStarted() });
    }
    if (name === "napcat_owner_route_close") {
      return textResult({ ok: true, route: controlPlane.closeOwnerRoute(args) });
    }
    if (name === "napcat_owner_route_migrate") {
      return textResult({ ok: true, route: controlPlane.migrateOwnerRoute(args), router: taskRouterController.ensureStarted() });
    }
    if (name === "napcat_owner_alert") {
      return textResult({ ok: true, ...(await controlPlane.sendOwnerAlert(args)) });
    }
    if (name === "napcat_preview_training_event") {
      return textResult({ ok: true, ...notifier.previewTrainingEvent(args) });
    }
    if (name === "napcat_send_training_event") {
      return textResult({ ok: true, ...(await notifier.sendTrainingEvent(args)) });
    }
    if (name === "napcat_preview_text") {
      return textResult({ ok: true, ...notifier.previewTextMessage(args) });
    }
    if (name === "napcat_send_text") {
      let result = await notifier.sendTextMessage(args);
      if (args.task_id && args.source_machine && args.target_machine) {
        result = withOutgoingDeliveryTracking(
          result,
          args,
          (delivery) => controlPlane.trackOutgoingDelivery(delivery),
        );
      }
      return textResult({ ok: true, ...result });
    }
    if (name === "napcat_preview_file") {
      return textResult({ ok: true, ...(await notifier.previewFile(args)) });
    }
    if (name === "napcat_send_file") {
      const result = await notifier.sendFile(args);
      if (args.task_id && args.source_machine && args.target_machine && result.taskIndex) {
        result.taskIndex = withOutgoingDeliveryTracking(
          result.taskIndex,
          args,
          (delivery) => controlPlane.trackOutgoingDelivery(delivery),
        );
      }
      return textResult({ ok: true, ...result });
    }
    if (name === "napcat_preview_configured_file") {
      return textResult({ ok: true, ...(await notifier.previewConfiguredFile(args)) });
    }
    if (name === "napcat_send_configured_file") {
      return textResult({ ok: true, ...(await notifier.sendConfiguredFile(args)) });
    }
    if (name === "napcat_preview_chat_file") {
      return textResult({ ok: true, ...(await notifier.previewChatFile(args)) });
    }
    if (name === "napcat_send_chat_file") {
      const result = await notifier.sendChatFile(args);
      if (args.task_id && args.source_machine && args.target_machine && result.taskIndex) {
        result.taskIndex = withOutgoingDeliveryTracking(
          result.taskIndex,
          args,
          (delivery) => controlPlane.trackOutgoingDelivery(delivery),
        );
      }
      return textResult({ ok: true, ...result });
    }
    if (name === "napcat_preview_configured_chat_file") {
      return textResult({ ok: true, ...(await notifier.previewConfiguredChatFile(args)) });
    }
    if (name === "napcat_send_configured_chat_file") {
      return textResult({ ok: true, ...(await notifier.sendConfiguredChatFile(args)) });
    }
    throw new NapCatNotifierError("UNKNOWN_TOOL", `未知工具：${name}`);
  } catch (error) {
    return errorResult(error);
  }
});

server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [] }));
server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates: [] }));
server.setRequestHandler(ReadResourceRequestSchema, async () => {
  throw new Error("NapCat 通知 MCP 不提供 resources");
});

const transport = new StdioServerTransport();
await server.connect(transport);
