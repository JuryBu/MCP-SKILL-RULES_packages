import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { acquireProcessGuard } from "./processGuard.js";
import {
  startCleanupScheduler,
  startAutoCollectScheduler,
  subagentCleanup,
  subagentDispose,
  subagentCollect,
  subagentCurrent,
  subagentInterrupt,
  subagentList,
  subagentModels,
  subagentMoveQueuedMessage,
  subagentPoll,
  subagentReconcile,
  subagentReply,
  subagentSpawn,
  subagentWait,
} from "./tools.js";

const server = new McpServer({
  name: "windsurf-subagent",
  version: "0.1.0",
});

await acquireProcessGuard();

server.registerTool("subagent_current", {
  title: "Find Current WSF Cascade",
  description: "List recent/running Windsurf Cascade IDs so the model does not invent main_id values.",
  inputSchema: {
    query: z.string().optional(),
    limit: z.number().optional(),
  },
}, async (args) => await subagentCurrent(args));

server.registerTool("subagent_models", {
  title: "List WSF Subagent Models",
  description: "List current cached Windsurf Cascade models and semantic model_profile candidates.",
  inputSchema: {
    purpose: z.enum(["cowork", "explore", "frontend", "fronted", "review", "unblock", "brainstorm"]).optional(),
    detail: z.enum(["summary", "detail", "full"]).optional(),
    include_available: z.boolean().optional(),
    refresh: z.boolean().optional(),
    include_unverified: z.boolean().optional(),
    candidate_limit: z.number().optional(),
  },
}, async (args) => await subagentModels(args));

server.registerTool("subagent_spawn", {
  title: "Spawn WSF Subagent",
  description: "Create an independent Windsurf Cascade subagent and return immediately with job_id.",
  inputSchema: {
    prompt: z.string(),
    main_id: z.string().optional(),
    model: z.string().optional(),
    model_profile: z.enum(["cowork", "explore", "frontend", "fronted", "review", "unblock", "brainstorm"]).optional(),
    mode: z.enum(["code", "plan", "ask", "no_tool", "explore", "auto"]).optional(),
    label: z.string().optional(),
    with_context: z.boolean().optional(),
    ref_ids: z.array(z.string()).optional(),
    images: z.array(z.union([
      z.string(),
      z.object({
        base64Data: z.string(),
        mimeType: z.string(),
        caption: z.string().optional(),
      }),
    ])).optional(),
    allow_subagent: z.boolean().optional(),
    timeout_sec: z.number().optional(),
    collect_mode: z.enum(["queue", "interrupt", "force"]).optional(),
    auto_collect: z.boolean().optional(),
    max_depth: z.number().optional(),
    max_concurrent: z.number().optional(),
    owner_conversation_id: z.string().optional(),
    parent_job_id: z.string().nullable().optional(),
    root_job_id: z.string().optional(),
    depth: z.number().optional(),
  },
}, async (args) => await subagentSpawn(args));

server.registerTool("subagent_poll", {
  title: "Poll WSF Subagent",
  description: "Read subagent status, step count, and result preview.",
  inputSchema: {
    job_id: z.string(),
  },
}, async (args) => await subagentPoll(args));

server.registerTool("subagent_wait", {
  title: "Wait For WSF Subagent",
  description: "Short-wait for a registered subagent to finish without exceeding broker/MCP timeout windows.",
  inputSchema: {
    job_id: z.string(),
    wait_ms: z.number().optional(),
    poll_ms: z.number().optional(),
    collect: z.boolean().optional(),
    collect_mode: z.enum(["queue", "interrupt", "force"]).optional(),
    collect_timeout_ms: z.number().optional(),
    confirm_timeout_ms: z.number().optional(),
    fallback_to_queue: z.boolean().optional(),
  },
}, async (args) => await subagentWait(args));

server.registerTool("subagent_list", {
  title: "List WSF Subagents",
  description: "List active, done, archived, or all registered subagent jobs.",
  inputSchema: {
    filter: z.enum(["active", "done", "archived", "all"]).optional(),
    detail: z.enum(["summary", "full"]).optional(),
    include_deleted: z.boolean().optional(),
    include_archived: z.boolean().optional(),
    limit: z.number().optional(),
  },
}, async (args) => await subagentList(args));

server.registerTool("subagent_collect", {
  title: "Collect WSF Subagent",
  description: "Queue or interrupt a registered main cascade with the subagent result.",
  inputSchema: {
    job_id: z.string(),
    main_id: z.string().optional(),
    mode: z.enum(["queue", "interrupt", "force"]).optional(),
    timeout_ms: z.number().optional(),
    confirm_timeout_ms: z.number().optional(),
    fallback_to_queue: z.boolean().optional(),
  },
}, async (args) => await subagentCollect(args));

server.registerTool("subagent_reply", {
  title: "Reply To WSF Subagent",
  description: "Send a follow-up message to the same registered subagent cascade, preserving its context and starting a new turn.",
  inputSchema: {
    job_id: z.string(),
    message: z.string(),
    model: z.string().optional(),
    model_profile: z.enum(["cowork", "explore", "frontend", "fronted", "review", "unblock", "brainstorm"]).optional(),
    mode: z.enum(["code", "plan", "ask", "no_tool", "explore", "auto"]).optional(),
    images: z.array(z.union([
      z.string(),
      z.object({
        base64Data: z.string(),
        mimeType: z.string(),
        caption: z.string().optional(),
      }),
    ])).optional(),
  },
}, async (args) => await subagentReply(args));

server.registerTool("subagent_interrupt", {
  title: "Interrupt WSF Cascade",
  description: "Interrupt an explicitly authorized target cascade, optionally consuming a queued message.",
  inputSchema: {
    target_id: z.string(),
    main_id: z.string().optional(),
    queue_id: z.string().optional(),
  },
}, async (args) => await subagentInterrupt(args));

server.registerTool("subagent_reconcile", {
  title: "Reconcile WSF Subagents",
  description: "Scan jobs.json against LS state and repair timeout/missing/stale queue records.",
  inputSchema: {},
}, async () => await subagentReconcile());

server.registerTool("subagent_cleanup", {
  title: "Cleanup WSF Subagents",
  description: "Archive idle done/timeout jobs by TTL and optionally prune old archive files after exporting a backup.",
  inputSchema: {
    idle_ttl_sec: z.number().optional(),
    dry_run: z.boolean().optional(),
    max_archive_per_run: z.number().optional(),
    retain_archives: z.number().optional(),
    hard_delete_archives: z.boolean().optional(),
  },
}, async (args) => await subagentCleanup(args));

server.registerTool("subagent_move_queued", {
  title: "Move WSF Queued Message",
  description: "Move a registered queued collect message to a new queue index.",
  inputSchema: {
    job_id: z.string(),
    to_index: z.number(),
  },
}, async (args) => await subagentMoveQueuedMessage(args));

server.registerTool("subagent_dispose", {
  title: "Dispose WSF Subagent",
  description: "Archive or delete a registered subagent. Delete always archives first.",
  inputSchema: {
    job_id: z.string(),
    mode: z.enum(["archive", "delete"]).optional(),
    cascade_tree: z.boolean().optional(),
  },
}, async (args) => await subagentDispose(args));

const transport = new StdioServerTransport();
await server.connect(transport);
startCleanupScheduler();
startAutoCollectScheduler();
