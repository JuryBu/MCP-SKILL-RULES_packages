import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import express from "express";
import { z } from "zod";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, CancelledNotificationSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { CoreError, normalizeIdentity } from "./contracts.mjs";
import { formatRecentSnapshotMcp } from "./host-conversation-content.mjs";
import { boardOperations } from "./board-entry-contract.mjs";

const REQUEST_TIMEOUT_MS = 50000;
const MAX_ACTIVE_REQUESTS = 16;
const MAX_CONTROL_REQUESTS = 4;
const MAX_TRACKED_REQUEST_IDS = 1024;
const messages = {
  invalid_input: "调用参数无效，请核对工具参数与大小限制",
  invalid_cursor: "游标无效，请使用当前消息返回的游标",
  caller_mismatch: "来源对话与当前连接授权不一致",
  caller_unverified: "当前入口只能查看共有通讯录；个人通讯录需要能核实具体对话的连接",
  contacts_unavailable: "本机通讯录尚未启用",
  shared_alias_reserved: "此别名已用于本机共有联系人，请另取个人别名",
  contact_alias_conflict: "别名有重名或已用于另一地址，请核对原联系人",
  contact_not_found: "这本通讯录里没有该联系人",
  contact_limit: "个人通讯录已达到容量上限，请先移除不用的联系人",
  message_not_recipient: "当前对话无权收录这封原信的发件人，或原信缺少可核实的发件对话",
  board_not_direct_target: "交流板需要使用交流板入口，不能作为对话收件人",
  board_unavailable: "本机尚未启用交流板",
  board_not_found: "没有可访问的交流板，请核对板代号或地址",
  board_archived: "交流板已归档，请核对已有权限与板状态",
  board_post_conflict: "这条发帖标识已用于另一份内容，请查原帖",
  board_file_too_large: "附件超过交流板单文件限制",
  board_file_hash_conflict: "附件与本机已有同标识文件内容不同，请保留原操作并核对",
  board_quota_exceeded: "交流板已达到文件容量上限，请核对现有用量",
  mixed_channel_recipients_not_allowed: "请把人类聊天窗口和模型对话分开；每次只发一个人类聊天窗口",
  bundle_transport_unavailable: "文件包通道尚未启用，请缩短正文或先启用文件包通道",
  unsupported_op: "当前对端还不支持这项操作",
  remote_timeout: "远端机器在等待窗口内未返回，请沿原请求查询",
  relay_frame_too_large: "消息超过中继单帧限制，请改用文件包",
  relay_rate_limited: "中继群暂时达到频率限制，请按返回的时间等待",
  relay_recipient_disclosure_blocked: "当前中继路线尚未获准公开本次的完整收件人名单",
  relay_route_not_found: "没有找到通往目标机器的获准中继路线",
  relay_route_ambiguous: "通往目标机器的中继路线不唯一，请核对当前写入路线",
  relay_route_drain_expired: "原中继群的排空期已过，请核对原回执",
  relay_route_changed: "中继路线已改变，请沿原请求核对结果",
  relay_dedupe_conflict: "中继去重键对应的原请求与本次参数不同",
  relay_cursor_expired: "中继游标已过期，请核对从哪个位置恢复",
  relay_history_expired: "中继原消息已超过保留期限",
  relay_history_gap: "中继历史有断档，请从原群核对未接收的范围",
  relay_cursor_invalid: "中继游标无效，请使用本次查询返回的游标",
  relay_cursor_scope_mismatch: "中继游标属于另一条路线或查询范围",
  relay_provider_error: "中继提供方未能完成操作，请核对原请求状态",
  relay_outbox_full: "跨机回执队列已满，本次处理确认未提交，请先核对原队列",
  forbidden: "当前连接没有这项操作的授权",
  source_unverified: "消息来源缺少对应授权",
  channel_download_state_unavailable: "附件原操作记录未就绪，已停止新下载，请核对原操作与目录",
  invalid_attachment_ref: "附件引用已失效或属于其它调用者及窗口，请重读原窗口最近记录",
  channel_content_unavailable: "QQ最近内容入口尚未就绪，请核对提供方实际加载状态",
  channel_content_capacity: "附件引用已达到当前容量，请先核对已有操作",
  host_content_unavailable: "宿主近期内容入口未就绪，请核对提供方和授权",
  host_content_unverified: "宿主没有返回可核对的有界内容",
  host_content_busy: "宿主已有一笔只读查询在运行，本次没有发起",
  host_content_timeout: "宿主只读查询超时，本次未返回正文",
  binding_changed: "目标绑定已经变化，请重新解析目标",
  dedupe_conflict: "去重键与已有消息参数不一致，请更换新的 dedupe_key 或保持原请求参数查询",
  invalid_reply: "in_reply_to 只能填写当前对话作为接收方收到的有效入站 message_id（不可填自己发出的消息，且 target 须对应原发送方）；普通发送可省略 in_reply_to",
  reply_not_found: "未找到 in_reply_to 指定的原消息，请核对入站 message_id",
  delivery_mismatch: "处理确认的 delivery_id 与当前接收对话的原投递记录不一致，请先用 get_message 核对",
  processing_conflict: "该消息已完成终态处理确认，不可逆转修改为其它状态",
  invalid_state: "当前投递状态尚不支持该处理确认操作，请先用 get_message 核对投递状态",
  target_not_found: "未找到匹配的目标对话或地址需要明确 surface，请核对 host 与 conversation_id",
  not_found: "没有找到可访问的消息或目标",
  server_closed: "服务正在关闭，等待已经结束",
  request_closed: "请求连接已经关闭",
  request_cancelled: "请求已取消，已持久化的消息可继续查询原投递状态",
  request_timeout: "请求超时，请核对原消息状态后再继续",
  internal_error: "服务暂时无法完成操作，请核对原消息状态",
};

function textField(maximum, description) {
  return {
    schema: { type: "string", minLength: 1, maxLength: maximum, ...(description ? { description } : {}) },
    validator: z.string().min(1).max(maximum).refine(value => Boolean(value.trim()) && Buffer.byteLength(value, "utf8") <= maximum),
  };
}

function integerField(minimum, maximum = Number.MAX_SAFE_INTEGER) {
  return { schema: { type: "integer", minimum, maximum }, validator: z.number().int().min(minimum).max(maximum) };
}

function optional(field) {
  return { ...field, optional: true, validator: field.validator.optional() };
}

function nullable(field) {
  return { schema: { anyOf: [field.schema, { type: "null" }] }, validator: field.validator.nullable() };
}

function objectField(fields) {
  return {
    schema: {
      type: "object",
      properties: Object.fromEntries(Object.entries(fields).map(([name, field]) => [name, field.schema])),
      required: Object.entries(fields).filter(([, field]) => !field.optional).map(([name]) => name),
      additionalProperties: false,
    },
    validator: z.object(Object.fromEntries(Object.entries(fields).map(([name, field]) => [name, field.validator]))).strict(),
  };
}

function arrayField(field, maximum) {
  return { schema: { type: "array", items: field.schema, maxItems: maximum }, validator: z.array(field.validator).max(maximum) };
}

function choiceField(choices) {
  return { schema: { type: "string", enum: choices }, validator: z.enum(choices) };
}

function oneOfFields(fields) {
  return { schema: { anyOf: fields.map(field => field.schema) }, validator: z.union(fields.map(field => field.validator)) };
}

const booleanField = { schema: { type: "boolean" }, validator: z.boolean() };
const noteField = {
  schema: { type: "string", minLength: 1, maxLength: 560, description: "可选；进行中或状态流转时的简短进度备注（最多280字符，原始UTF-8不超过1200字节；终态重复确认保持幂等忽略新备注）。" },
  validator: z.string()
    .refine(raw => Buffer.byteLength(raw, "utf8") <= 1200, "note 原始 UTF-8 字节不能超过 1200")
    .transform(value => value.trim())
    .refine(value => value.length >= 1 && [...value].length <= 280, "note 去首尾空白后须在 1~280 字符内"),
};
const SEND_STATUS_HINTS = {
  accepted: "传输已接纳（尚未代表对端处理完成，可按 query_hint.get_message 或 query_hint.wait 查询处理与回复）",
  prepared: "消息已持久化入队，尚未证实对端收到（可按 query_hint.get_message 或 query_hint.wait 跟进投递状态）",
  dispatching: "消息正在投递中，尚未证实对端收到（可按 query_hint.get_message 或 query_hint.wait 跟进投递状态）",
  unknown: "投递结果尚未确认，请保持原去重键并按 query_hint.get_message 或 query_hint.wait 查询原消息状态，勿盲目重发",
  failed_before_send: "消息在发送前已失败，尚未送达对端（可按 query_hint.get_message 查看失败原因）",
  expired: "消息已超过有效期，未继续投递（可按 query_hint.get_message 查看状态）",
  unsupported: "目标当前暂不支持该投递策略，消息已保存（可按 query_hint.get_message 查看状态）",
  failed: "消息投递失败（可按 query_hint.get_message 查看失败原因）",
};
const identityFields = {
  machine_id: textField(128),
  host: textField(64),
  surface: optional(textField(64)),
  conversation_id: textField(256),
};
const callerField = objectField({ ...identityFields, machine_id: optional(textField(128)) });
const boundTargetField = objectField({ ...identityFields, binding_id: textField(128), binding_generation: integerField(1) });
const addressField = objectField({ machine_id: optional(textField(128)), host: textField(64), surface: optional(textField(64)), conversation_id: textField(256) });
const contactField = textField(256);
const contactAddressField = objectField({ contact: contactField });
const targetField = {
  schema: { anyOf: [boundTargetField.schema, addressField.schema, contactAddressField.schema] },
  validator: z.union([boundTargetField.validator, addressField.validator, contactAddressField.validator]),
};
const lookupAddressField = {
  schema: { anyOf: [addressField.schema, contactAddressField.schema] },
  validator: z.union([addressField.validator, contactAddressField.validator]),
};
const receiptField = objectField({
  component: textField(64),
  resource_id: textField(256),
  generation: integerField(1),
  wake_id: textField(256),
  notification_id: optional(nullable(textField(256))),
  event_ids: arrayField({ schema: { anyOf: [{ type: "string" }, { type: "integer" }] }, validator: z.union([z.string(), z.number().int().safe()]) }, 1000),
});

function tool(name, method, description, fields, readOnly) {
  const parameters = objectField({ caller: callerField, ...fields });
  return {
    definition: {
      name: `communication_${name}`,
      description,
      inputSchema: parameters.schema,
      annotations: { readOnlyHint: readOnly, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    method,
    validator: parameters.validator,
  };
}

const sendMessageDescription = "用真实 caller、收件地址 target 和正文 text 发消息。target 支持明确地址、已有绑定或已启用通讯录中的联系人；普通代理消息可省 origin，由实际入口补齐来源。默认 next_model_boundary 中途送入，when_idle 仅明确延后，Codex 默认 hidden。未知结果沿原 ID 查询，保持原去重键。";
const sendMessageFields = {
    origin: optional(objectField({
      kind: textField(64, "普通代理协作填写agent_message；本人消息仅由已授权的渠道入口使用human_message，其它来源类型须已在当前连接授权。"),
      channel: textField(64, "原始来源渠道，例如codex或antigravity；保留实际来源。"),
      source_ref: textField(512, "可核对的原来源引用；代理协作通常填写当前真实对话ID。"),
    })),
    target: targetField,
    dedupe_key: optional(textField(128, "可选；省略时按来源、目标、回复对象、正文与当前分钟桶自动生成去重键，显式传入须非空。")),
    text: textField(262144),
    attachment_refs: optional(arrayField(textField(512), 32)),
    delivery_policy: optional({ schema: { type: "string", enum: ["next_model_boundary", "when_idle"], default: "next_model_boundary", description: "默认能中途插入就插入，原工具继续；仅明确要求延后或宿主确实只支持空闲时用when_idle" }, validator: z.enum(["next_model_boundary", "when_idle"]) }),
    message_visibility: optional({ schema: { type: "string", enum: ["hidden", "visible"], description: "仅用于Codex注入，省略时新消息默认hidden；visible保留全部消息气泡" }, validator: z.enum(["hidden", "visible"]) }),
    reply_required: optional(booleanField),
    expires_at: optional(textField(64, "可选；省略时默认24小时后过期，显式传入须为有效ISO时间。")),
    in_reply_to: optional(nullable(textField(256))),
    origin_receipt_binding: optional(nullable(receiptField)),
    verbose_receipt: optional({ ...booleanField, schema: { type: "boolean", description: "传true返回完整长envelope.text，默认超240字返回预览（text_preview/text_length）。" } }),
};
const multiRecipientTool = tool("send_message", "sendMessage", sendMessageDescription +
  "本机启用群发时，可用 targets 一次注明 1–16 位收件人，与 target 二选一。实际收件对话各有原消息 ID 和处理确认；每次重试保持原去重键与收件人名单。", {
  ...sendMessageFields,
  target: optional(targetField),
  targets: optional({
    schema: { type: "array", minItems: 1, maxItems: 16, items: targetField.schema },
    validator: z.array(targetField.validator).min(1).max(16),
  }),
}, false);
multiRecipientTool.definition.inputSchema.oneOf = [{ required: ["target"] }, { required: ["targets"] }];
multiRecipientTool.validator = multiRecipientTool.validator.refine(input => (input.target !== undefined) !== (input.targets !== undefined));

const tools = [
  tool("send_message", "sendMessage", sendMessageDescription, sendMessageFields, false),
  tool("get_status", "getStatus", "只读查询宿主在线、目标对话运行与中途投递能力；具体对话另含可取得的模型观察及其来源、时间，区分当前配置与最近实际调用。未知明确保留，不从旧回复或本人休息推断状态。", {
    binding_id: optional(textField(128)), machine_id: optional(textField(128)), host: optional(textField(64)), surface: optional(textField(64)), conversation_id: optional(textField(256)), contact: optional(contactField),
  }, true),
  tool("ack_processing", "ackProcessing", "由接收对话确认指定消息的处理状态（必填：caller、message_id、processing；delivery_id与binding_generation可选，省略时由核心按已鉴权接收方自动解析；可选note附简短进度备注），具体状态由核心校验。", {
    message_id: textField(256),
    delivery_id: optional(textField(256)),
    binding_generation: optional(integerField(1)),
    processing: { schema: { type: "string", enum: ["processing", "done", "failed"] }, validator: z.enum(["processing", "done", "failed"]) },
    note: optional(noteField),
  }, false),
  tool("get_message", "getMessage", "读取当前来源或接收方有权访问的消息、投递状态与后续事件游标。", {
    message_id: textField(256),
  }, true),
  tool("wait", "wait", "从消息游标之后分页等待事件。单次等待最多45000毫秒，超时或关闭时结束，回复判定由核心执行。", {
    message_id: textField(256),
    after_cursor: optional(nullable(textField(512))),
    until: optional({ schema: { type: "string", enum: ["reply", "delivery", "processing", "any"] }, validator: z.enum(["reply", "delivery", "processing", "any"]) }),
    wait_ms: optional(integerField(0, 45000)),
    limit: optional(integerField(1, 100)),
  }, true),
  tool("list_conversations", "listConversations", "默认列获准对话绑定。scope=host 时指定宿主，分页列已授权的对话，单页最多50条；可选机器和入口类型。", {
    host: optional(textField(64)), limit: optional(integerField(1, 100)), cursor: optional(nullable(textField(1024))),
    machine_id: optional(textField(128)), surface: optional(textField(64)),
    scope: optional({ schema: { type: "string", enum: ["bindings", "host"], default: "bindings" }, validator: z.enum(["bindings", "host"]) }),
  }, true),
  tool("read_recent_snapshot", "readRecentSnapshot", "只读扫一眼获准的 Codex、反重力或 WSF 对话。跨机读取须两端单独授权到具体对话；按发言者、时间和实际来源整理近期 Markdown。完整历史与搜索使用 memory-store。", {
    target: lookupAddressField,
    last_rounds: optional(integerField(1, 5)),
  }, true),
  tool("resolve_target", "resolveTarget", "按宿主端和对话ID解析目标，或兼容旧binding_id。已启用宿主无需逐对话开通；返回身份及投递接线，实际在线状态另查。", {
    binding_id: optional(textField(128)),
    machine_id: optional(textField(128)), host: optional(textField(64)), surface: optional(textField(64)), conversation_id: optional(textField(256)), contact: optional(contactField),
  }, true),
  tool("read_channel_messages", "readChannelMessages", "只读查询已获准QQ窗口的最近消息，包含未@或未引用的普通内容。无需登记采集，不确认原事件；完整宿主历史继续使用原文读取入口。", {
    channel: { schema: { type: "string", enum: ["qq"] }, validator: z.enum(["qq"]) },
    window_type: { schema: { type: "string", enum: ["private", "group"] }, validator: z.enum(["private", "group"]) },
    window_id: textField(256),
    count: optional(integerField(1, 50)),
    cursor: optional(textField(4096)),
  }, true),
  tool("download_attachment", "downloadAttachment", "下载已从获准QQ窗口最近消息取得的附件引用，核原消息和窗口归属。默认存本任务临时目录，拒绝覆盖；不接受URL或裸文件ID，结果未知不自动重下。", {
    channel: { schema: { type: "string", enum: ["qq"] }, validator: z.enum(["qq"]) },
    window_type: { schema: { type: "string", enum: ["private", "group"] }, validator: z.enum(["private", "group"]) },
    window_id: textField(256),
    attachment_ref: textField(256),
    destination_dir: optional(textField(4096)),
    name: optional(textField(255)),
    retry_failed: optional(booleanField),
    expected_operation_id: optional(textField(128, "显式重试时填写刚才已确认失败的原operation_id；保留未知操作，不自动建立替代请求。")),
  }, false),
  tool("manage_channel_binding", "manageChannelBinding", "当前对话自行登记、查询或移除QQ及已启用微信聊天窗口对应的模型对话。普通发送无需先建立窗口绑定；更新按原代次核对，保留其它对话归属。", {
    action: { schema: { type: "string", enum: ["bind", "get", "list", "remove"] }, validator: z.enum(["bind", "get", "list", "remove"]) },
    channel: optional({ schema: { type: "string", enum: ["qq", "wechat"] }, validator: z.enum(["qq", "wechat"]) }),
    window_type: optional({ schema: { type: "string", enum: ["private", "group"] }, validator: z.enum(["private", "group"]) }),
    window_id: optional(textField(256)),
    expected_generation: optional(integerField(0)),
    limit: optional(integerField(1, 100)), after_key: optional(textField(256)),
  }, false),
];

export { tools as communicationTools };

const contactActions = ["list", "get", "save", "set_note", "rename", "save_sender", "remove"];
const contactNoteField = {
  schema: { type: "string", maxLength: 256 },
  validator: z.string().refine(value => [...value].length <= 256 && Buffer.byteLength(value, "utf8") <= 1024),
};

export const communicationContactsTool = tool("contacts", "contacts", "查本机共有或个人联系人。个人通讯录可保存地址、按原来信存发件人，或用 rename（contact 原名字、alias 新名字）改自己看到的名字，原地址和其他对话不变。回执带本次传入的对话；联系人不变更授权。", {
  action: { schema: { type: "string", enum: contactActions }, validator: z.enum(contactActions) },
  contact: optional(contactField),
  alias: optional(contactField),
  target: optional(addressField),
  note: optional(contactNoteField),
  message_id: optional(textField(256)),
  include_machine_routes: optional(booleanField),
}, false);

const boardAddressField = objectField({ machine_id: optional(textField(128)), board_id: textField(128) });
const boardMemberField = oneOfFields([addressField, contactAddressField, textField(768)]);
const boardSettingsField = objectField({
  default_file_sync_machines: optional(arrayField(textField(128), 64)),
  default_poll_interval_sec: optional(integerField(60, 3600)),
  auto_archive_days: optional(integerField(1, 3650)),
});
const boardFileField = objectField({
  path: textField(4096, "本机已获准上传目录内的文件"),
  name: optional(textField(480)),
  bundle_id: optional(textField(128)),
  bundle_label: optional(textField(512)),
});
const boardTool = tool("board", "board",
  "按本次传入的本机对话 caller 查看或操作交流板（回执原样回显传入对话）。create 和 list 无需填写 board；其他动作可用个人短代号 {contact} 或板地址 {machine_id,board_id}。delete_archived 会永久移除已归档的板，须提供该次归档版本。", {
    action: choiceField(Object.keys(boardOperations)),
    board: optional(oneOfFields([boardAddressField, contactAddressField])),
    title: optional(textField(512)),
    settings: optional(boardSettingsField),
    limit: optional(integerField(1, 100)),
    cursor: optional(textField(1024)),
    members: optional(arrayField(boardMemberField, 128)),
    body: optional(textField(65_536)),
    mentions: optional(arrayField(boardMemberField, 128)),
    files: optional(arrayField(boardFileField, 16)),
    sync_machines: optional(arrayField(textField(128), 64)),
    client_post_id: optional(textField(256)),
    after_seq: optional(integerField(0)),
    seq: optional(integerField(1)),
    max_total_chars: optional(integerField(1, 65_536)),
    author_keys: optional(arrayField(textField(768), 128)),
    delivery_mode: optional(choiceField(["poll", "event"])),
    filter_mode: optional(choiceField(["all", "mute", "only"])),
    filter_targets: optional(arrayField(boardMemberField, 128)),
    expected_archive_version: optional(integerField(1)),
    expected_state_version: optional(integerField(0)),
  }, false);
boardTool.definition.annotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
export { boardTool as communicationBoardTool };

export function communicationToolEntries({ includeContacts = false, includeMultiRecipient = false, includeBoard = false } = {}) {
  return [
    ...(includeMultiRecipient ? [multiRecipientTool, ...tools.slice(1)] : tools),
    ...(includeContacts ? [communicationContactsTool] : []),
    ...(includeBoard ? [boardTool] : []),
  ];
}

export function listCommunicationToolDefinitions(options) {
  return communicationToolEntries(options).map(({ definition }) => structuredClone(definition));
}

function toolFailure(error) {
  const code = error instanceof CoreError && /^[a-z][a-z0-9_]{0,63}$/.test(error.code) ? error.code : "internal_error";
  const message = messages[code] ?? "交流操作未完成，请核对当前消息与绑定状态";
  return { isError: true, structuredContent: { error: { code, message } }, content: [{ type: "text", text: `${message}（${code}）` }] };
}

function abortable(operation, signal) {
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason instanceof CoreError ? signal.reason : new CoreError("request_closed", "请求关闭"));
    if (signal.aborted) return aborted();
    signal.addEventListener("abort", aborted, { once: true });
    Promise.resolve().then(() => {
      if (signal.aborted) throw signal.reason;
      return operation();
    }).then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
}

function stripUndefinedFields(data, omitKeys = []) {
  const omitted = omitKeys.length ? new Set(omitKeys) : null;
  const cleaned = {};
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    if (omitted?.has(key)) continue;
    cleaned[key] = value;
  }
  return cleaned;
}

const TOOL_RESULT_TEXT_PREFIX = "交流操作结果：\n";
const BOARD_READ_RESPONSE_LIMIT_BYTES = 9 * 1024;

function boardReadDataBudgetFor(caller) {
  const callerBytes = Buffer.byteLength(JSON.stringify({ caller: stripUndefinedFields(caller) }), "utf8") - 1;
  return BOARD_READ_RESPONSE_LIMIT_BYTES - 1 - Buffer.byteLength(TOOL_RESULT_TEXT_PREFIX, "utf8") - callerBytes;
}

export function withSubmittedCaller(result, caller) {
  if (!caller) return result;
  const submitted = stripUndefinedFields(caller);
  const structuredContent = { ...result.structuredContent, caller: submitted };
  const error = result.isError && result.structuredContent?.error;
  const callerText = `本次传入的对话：${JSON.stringify(submitted)}`;
  const content = error
    ? [{ type: "text", text: `${error.message}（${error.code}）\n${callerText}` }]
    : result.structuredContent
      ? [{ type: "text", text: `${TOOL_RESULT_TEXT_PREFIX}${JSON.stringify(structuredContent)}` }]
      : [...(result.content ?? []), { type: "text", text: callerText }];
  return { ...result, structuredContent, content };
}

function projectSendMessageResult(result, verboseReceipt) {
  if (!result || typeof result !== "object" || !result.message || typeof result.message !== "object"
    || !result.delivery || typeof result.delivery !== "object") {
    return result;
  }
  const statusHint = SEND_STATUS_HINTS[result.delivery.status] ?? "消息已记录（可按 query_hint.get_message 或 query_hint.wait 查询当前投递与处理状态）";
  const queryHint = {
    get_message: { message_id: result.message.message_id },
    wait: {
      message_id: result.message.message_id,
      ...(result.next_cursor !== undefined ? { after_cursor: result.next_cursor } : {}),
    },
  };
  const envelope = result.message.envelope;
  let projectedMessage = result.message;
  if (!verboseReceipt && envelope && typeof envelope === "object" && typeof envelope.text === "string" && envelope.text.length > 240) {
    const { text, ...restEnvelope } = envelope;
    let cut = 200;
    const lastCode = text.charCodeAt(cut - 1);
    if (lastCode >= 0xd800 && lastCode <= 0xdbff) cut -= 1;
    projectedMessage = {
      ...result.message,
      envelope: {
        ...restEnvelope,
        text_preview: `${text.slice(0, cut)}...`,
        text_length: text.length,
      },
    };
  }
  return {
    ...result,
    message: projectedMessage,
    status_hint: statusHint,
    query_hint: queryHint,
  };
}

function makeServer(core, principalId, requestSignal, sharedFacade = false) {
  const server = new Server({ name: "communication-core-mcp", version: "0.1.0" }, { capabilities: { tools: {} } });
  const features = {
    includeContacts: Boolean(core.addressBook),
    includeMultiRecipient: Boolean(core.messageBatches),
    includeBoard: core.canUseBoardTool?.(principalId, sharedFacade) === true,
  };
  const entries = communicationToolEntries(features);
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listCommunicationToolDefinitions(features) }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    let submittedCaller;
    try {
      const entry = entries.find(candidate => candidate.definition.name === request.params.name);
      if (!entry) throw new CoreError("invalid_input", "未知工具");
      const parsed = entry.validator.safeParse(request.params.arguments);
      if (!parsed.success) throw new CoreError("invalid_input", "工具参数无效");
      if (entry === communicationContactsTool || entry === boardTool) submittedCaller = parsed.data.caller;
      const signal = AbortSignal.any([requestSignal, extra.signal]);
      const verboseReceipt = entry.method === "sendMessage" && parsed.data.verbose_receipt === true;
      const coreArgs = stripUndefinedFields(parsed.data, entry.method === "sendMessage" ? ["verbose_receipt"] : []);
      const context = { principal_id: principalId, signal, shared_facade: sharedFacade };
      if (entry === boardTool && coreArgs.action === "read" && submittedCaller) {
        context.boardReadDataBudgetBytes = boardReadDataBudgetFor(submittedCaller);
      }
      const value = await abortable(() => core[entry.method](context, coreArgs), signal);
      const rawResult = value === null && entry.method === "manageChannelBinding" && parsed.data.action === "get" ? { binding: null } : value;
      if (!rawResult || typeof rawResult !== "object" || Array.isArray(rawResult)) throw new Error("Invalid result");
      if (entry.method === "readRecentSnapshot") return formatRecentSnapshotMcp(rawResult);
      if (entry.method === "sendMessage" && coreArgs.targets !== undefined) {
        return { structuredContent: rawResult, content: [{ type: "text", text: `本次共有 ${rawResult.recipient_count} 位收件人，逐人投递与处理状态、原消息 ID 见结构化回执。` }] };
      }
      const result = entry.method === "sendMessage" ? projectSendMessageResult(rawResult, verboseReceipt) : rawResult;
      if (submittedCaller) return withSubmittedCaller({ structuredContent: result }, submittedCaller);
      const serialized = JSON.stringify(result);
      return { structuredContent: result, content: [{ type: "text", text: `${TOOL_RESULT_TEXT_PREFIX}${serialized}` }] };
    } catch (error) {
      return withSubmittedCaller(toolFailure(error), submittedCaller);
    }
  });
  return server;
}

function headerCount(request, name) {
  let count = 0;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index].toLowerCase() === name) count += 1;
  }
  return count;
}

function httpFailure(response, status, code, message) {
  if (response.destroyed || response.writableEnded) return;
  if (response.headersSent) return response.destroy();
  response.status(status).json({ jsonrpc: "2.0", id: null, error: { code: -32000, message, data: { code } } });
}

function tokenDigest(token) {
  return createHash("sha256").update(token, "utf8").digest();
}

function requestKey(principalId, requestId) {
  const valid = typeof requestId === "string" ? Buffer.byteLength(requestId, "utf8") <= 512 : Number.isSafeInteger(requestId);
  return valid ? JSON.stringify([principalId, typeof requestId, requestId]) : null;
}

function credentialsFor(principals) {
  if (!Array.isArray(principals) || principals.length < 1 || principals.length > 256) throw new CoreError("invalid_config", "需要有界的连接授权列表");
  const identities = new Set();
  const tokens = new Set();
  return principals.map(principal => {
    if (!principal || typeof principal.id !== "string" || !principal.id.trim() || Buffer.byteLength(principal.id) > 128) throw new CoreError("invalid_config", "连接授权ID无效");
    normalizeIdentity(principal.identity);
    if (typeof principal.token !== "string" || !/^[A-Za-z0-9._~+/-]+=*$/.test(principal.token) || principal.token.length > 4096) throw new CoreError("invalid_config", "连接令牌格式无效");
    const digest = tokenDigest(principal.token);
    const tokenKey = digest.toString("hex");
    if (identities.has(principal.id) || tokens.has(tokenKey)) throw new CoreError("invalid_config", "连接授权ID或令牌重复");
    identities.add(principal.id);
    tokens.add(tokenKey);
    return { principalId: principal.id, digest };
  });
}

export async function createMcpHttpServer({ core, principals, host = "127.0.0.1", port = 0, maxBodyBytes = 1048576 }) {
  if (!["127.0.0.1", "localhost"].includes(host)) throw new CoreError("invalid_config", "服务只能绑定本机回环地址");
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535 || !Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1 || maxBodyBytes > 1048576) throw new CoreError("invalid_config", "端口或载荷上限无效");
  if (!core || tools.some(entry => typeof core[entry.method] !== "function")) throw new CoreError("invalid_config", "交流核心接口不完整");
  const credentials = credentialsFor(principals);
  const app = express();
  app.disable("x-powered-by");
  const server = createServer({ maxHeaderSize: 16384 }, app);
  server.maxConnections = 32;
  server.maxHeadersCount = 64;
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 1000;
  const requests = new Set();
  const activeRequests = new Set();
  const requestBindings = new Map();
  const sockets = new Set();
  const pruneRequestBindings = () => {
    const now = Date.now();
    for (const [key, binding] of requestBindings) {
      if (binding.entries.size === 0 && binding.expiresAt <= now) requestBindings.delete(key);
    }
  };
  const bindRequest = (entry, principalId, requestId) => {
    const key = requestKey(principalId, requestId);
    if (key === null) return "invalid_request_id";
    pruneRequestBindings();
    let binding = requestBindings.get(key);
    if (binding) binding.ambiguous = true;
    else {
      if (requestBindings.size >= MAX_TRACKED_REQUEST_IDS) return "busy";
      binding = { entries: new Set(), ambiguous: false, expiresAt: 0 };
      requestBindings.set(key, binding);
    }
    binding.entries.add(entry);
    entry.requestKey = key;
    return null;
  };
  server.on("connection", socket => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  let closing = false;
  let closePromise;
  let authorities;
  app.use((request, response, next) => {
    response.set({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    if (closing) return httpFailure(response, 503, "server_closed", "服务正在关闭");
    const authority = request.headers.host?.toLowerCase();
    if (headerCount(request, "host") !== 1 || !authorities.has(authority)) return httpFailure(response, 403, "invalid_host", "Host不在本机服务范围内");
    const origin = request.headers.origin;
    if (headerCount(request, "origin") > 1 || (origin !== undefined && ![...authorities].some(allowed => origin === `http://${allowed}`))) return httpFailure(response, 403, "invalid_origin", "Origin不在本机服务范围内");
    const authorization = request.headers.authorization;
    const match = typeof authorization === "string" && /^Bearer ([A-Za-z0-9._~+/-]+=*)$/i.exec(authorization);
    const supplied = tokenDigest(match ? match[1] : "");
    let principalId;
    for (const credential of credentials) {
      if (timingSafeEqual(supplied, credential.digest)) principalId = credential.principalId;
    }
    if (!match || headerCount(request, "authorization") !== 1 || !principalId) {
      response.set("WWW-Authenticate", "Bearer");
      return httpFailure(response, 401, "unauthorized", "需要当前连接的有效Bearer令牌");
    }
    if (requests.size >= MAX_ACTIVE_REQUESTS + MAX_CONTROL_REQUESTS) return httpFailure(response, 503, "busy", "服务请求已满，请稍后重试");
    const controller = new AbortController();
    let finished;
    const entry = { controller, response, done: new Promise(resolve => { finished = resolve; }) };
    let cleaned = false;
    const timer = setTimeout(() => {
      controller.abort(new CoreError("request_timeout", "请求超时"));
      httpFailure(response, 504, "request_timeout", "请求超出等待期限");
      void entry.cleanup();
    }, REQUEST_TIMEOUT_MS);
    timer.unref();
    entry.cleanup = async () => {
      if (cleaned) return entry.done;
      cleaned = true;
      clearTimeout(timer);
      controller.abort(new CoreError("request_closed", "请求已关闭"));
      try {
        if (entry.mcp) await entry.mcp.close();
        else if (entry.transport) await entry.transport.close();
      } catch {} finally {
        activeRequests.delete(entry);
        if (entry.requestKey) {
          const binding = requestBindings.get(entry.requestKey);
          binding?.entries.delete(entry);
          if (binding) binding.expiresAt = Date.now() + REQUEST_TIMEOUT_MS;
        }
        requests.delete(entry);
        finished();
      }
    };
    requests.add(entry);
    response.once("finish", () => { void entry.cleanup(); });
    response.once("close", () => { void entry.cleanup(); });
    response.locals.entry = entry;
    response.locals.principalId = principalId;
    next();
  });
  app.post("/mcp", (request, response, next) => {
    if (!request.is("application/json")) return httpFailure(response, 415, "invalid_content_type", "请求需要application/json格式");
    next();
  }, express.json({ limit: maxBodyBytes, strict: true, inflate: false }), async (request, response) => {
    const entry = response.locals.entry;
    if (entry.controller.signal.aborted) return;
    try {
      const body = request.body;
      const cancellation = body?.jsonrpc === "2.0" && body.method === "notifications/cancelled" && !Object.hasOwn(body, "id") ? CancelledNotificationSchema.safeParse(body) : null;
      if (cancellation?.success) {
        pruneRequestBindings();
        const key = requestKey(response.locals.principalId, cancellation.data.params.requestId);
        const binding = requestBindings.get(key);
        if (binding && !binding.ambiguous && binding.entries.size === 1) {
          const [original] = binding.entries;
          original.controller.abort(new CoreError("request_cancelled", "请求已取消"));
        }
      } else {
        if (activeRequests.size >= MAX_ACTIVE_REQUESTS) return httpFailure(response, 503, "busy", "服务请求已满，请稍后重试");
        activeRequests.add(entry);
        if (body?.jsonrpc === "2.0" && body.method === "tools/call" && Object.hasOwn(body, "id")) {
          const failure = bindRequest(entry, response.locals.principalId, body.id);
          if (failure) return httpFailure(response, failure === "busy" ? 503 : 400, failure, "请求ID无效或取消关联容量已满");
        }
      }
      entry.mcp = makeServer(core, response.locals.principalId, entry.controller.signal, request.headers["x-communication-core-shared-facade"] !== undefined);
      entry.transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      await entry.mcp.connect(entry.transport);
      if (entry.controller.signal.aborted) return await entry.cleanup();
      await entry.transport.handleRequest(request, response, request.body);
    } catch {
      httpFailure(response, 500, "internal_error", "服务暂时无法完成请求");
      await entry.cleanup();
    }
  });
  app.all("/mcp", (request, response) => {
    response.set("Allow", "POST");
    httpFailure(response, 405, "method_not_allowed", "独立服务只接收MCP POST请求");
  });
  app.use((request, response) => httpFailure(response, 404, "not_found", "没有对应的服务入口"));
  app.use((error, request, response, next) => {
    const oversized = error?.type === "entity.too.large";
    httpFailure(response, oversized ? 413 : 400, oversized ? "payload_too_large" : "invalid_json", oversized ? "请求载荷超出大小限制" : "请求JSON或编码无效");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port }, () => {
      const bound = server.address();
      authorities = new Set([`127.0.0.1:${bound.port}`, `localhost:${bound.port}`]);
      if (bound.port === 80) { authorities.add("127.0.0.1"); authorities.add("localhost"); }
      server.removeListener("error", reject);
      resolve();
    });
  });
  return {
    url: `http://${host}:${server.address().port}/mcp`,
    address: server.address(),
    close() {
      if (closePromise) return closePromise;
      closing = true;
      closePromise = (async () => {
        const stopped = new Promise(resolve => server.close(resolve));
        const pending = [...requests];
        for (const entry of pending) entry.controller.abort(new CoreError("server_closed", "服务关闭"));
        let graceTimer;
        await Promise.race([Promise.all(pending.map(entry => entry.done)), new Promise(resolve => { graceTimer = setTimeout(resolve, 100); })]);
        clearTimeout(graceTimer);
        for (const entry of pending) {
          httpFailure(entry.response, 503, "server_closed", "服务正在关闭");
          await entry.cleanup();
        }
        server.closeAllConnections();
        for (const socket of sockets) socket.destroy();
        await stopped;
        requestBindings.clear();
      })();
      return closePromise;
    },
  };
}
