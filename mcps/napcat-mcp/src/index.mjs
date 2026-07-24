import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createNapCatNotifier, NapCatNotifierError } from "./core.mjs";

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
  },
  additionalProperties: false,
};

const textInputSchema = {
  type: "object",
  properties: {
    text: { type: "string", minLength: 1, maxLength: 1000, description: "写入固定格式消息中的正文。" },
    dedupe_key: { type: "string", minLength: 1, maxLength: 200, description: "唯一去重键；同一次重试必须复用。" },
    task_id: { type: "string", minLength: 1, maxLength: 128, description: "可选任务 ID；提供时发送可按任务精确读取的结构化消息。" },
    source_machine: { type: "string", minLength: 1, maxLength: 64, description: "可选来源机器标签，例如 development 或 training。" },
    target_machine: { type: "string", minLength: 1, maxLength: 64, description: "可选目标机器标签，例如 training 或 development。" },
  },
  required: ["text", "dedupe_key"],
  additionalProperties: false,
};

const fileInputSchema = {
  type: "object",
  properties: {
    file_path: { type: "string", minLength: 1, maxLength: 4096, description: "本机待上传文件的绝对路径。" },
    name: { type: "string", minLength: 1, maxLength: 255, description: "可选群文件显示名，不能包含目录。" },
    dedupe_key: { type: "string", minLength: 1, maxLength: 200, description: "唯一去重键；同一次重试必须复用。" },
  },
  required: ["file_path", "dedupe_key"],
  additionalProperties: false,
};

const downloadInputSchema = {
  type: "object",
  properties: {
    file_id: { type: "string", minLength: 1, maxLength: 2048, description: "从固定绑定群消息附件中读取到的 file_id。" },
    destination_dir: { type: "string", minLength: 1, maxLength: 4096, description: "本机保存目录的绝对路径；目录不存在时自动创建。" },
    name: { type: "string", minLength: 1, maxLength: 255, description: "可选本地文件名，不能包含目录；目标已存在时拒绝覆盖。" },
  },
  required: ["file_id", "destination_dir"],
  additionalProperties: false,
};

const tools = [
  {
    name: "napcat_status",
    description: "只读检查 NapCat OneBot 连通性、登录账号和已绑定群，不发送消息。",
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
    description: "只读获取 binding 固定群的最近消息及文件附件元数据；可按结构化 task_id 精确过滤，群号不能由调用方指定。",
    inputSchema: readInputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "napcat_download_file",
    description: "通过最近消息返回的 file_id 下载固定群文件到本机绝对目录；不能指定群号或下载 URL，也不会覆盖已有文件。",
    inputSchema: downloadInputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "napcat_preview_training_event",
    description: "只生成固定格式训练通知正文和目标摘要，不发送消息。",
    inputSchema: eventInputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "napcat_send_training_event",
    description: "向 binding 绑定的固定群发送训练事件。该工具会产生真实 QQ 群消息，发送前核对账号、群名和成员数，并使用 dedupe_key 防止重复。",
    inputSchema: eventInputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "napcat_preview_text",
    description: "预览固定群文本消息，不发送。",
    inputSchema: textInputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "napcat_send_text",
    description: "向 binding 固定群发送带 Codex 标识的文本消息；提供 task_id 时写入来源/目标机器和任务标记，便于另一台机器精确读取。不能指定群号，发送后执行消息核验与去重。",
    inputSchema: textInputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "napcat_preview_file",
    description: "读取本机文件大小并计算 SHA256，预览固定群上传目标，不上传文件。",
    inputSchema: fileInputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "napcat_send_file",
    description: "向 binding 固定群上传一个本机文件；不能指定群号，上传后用群文件列表核验并按 dedupe_key 去重。",
    inputSchema: fileInputSchema,
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
  const safe = {
    ok: false,
    code: error instanceof NapCatNotifierError ? error.code : "UNEXPECTED_ERROR",
    message: error?.message || String(error),
    outcomeUnknown: Boolean(error?.outcomeUnknown),
    details: error instanceof NapCatNotifierError ? error.details : null,
  };
  console.error(`[napcat-mcp] ${safe.code}: ${safe.message}`);
  return textResult(safe, true);
}

const notifier = createNapCatNotifier({ cwd: path.resolve(__dirname, "..") });
const server = new Server(
  { name: "codex-napcat-training-notifier", version: "0.1.0" },
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
    if (name === "napcat_download_file") {
      return textResult({ ok: true, ...(await notifier.downloadFile(args)) });
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
      return textResult({ ok: true, ...(await notifier.sendTextMessage(args)) });
    }
    if (name === "napcat_preview_file") {
      return textResult({ ok: true, ...(await notifier.previewFile(args)) });
    }
    if (name === "napcat_send_file") {
      return textResult({ ok: true, ...(await notifier.sendFile(args)) });
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
