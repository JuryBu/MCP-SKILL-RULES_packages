import type { DatabaseSync } from "node:sqlite";
import type { DevinCompaction, DevinConversationSummary, DevinDesktopMessage, DevinMessageNode } from "./devin-types.js";
import { ReadBudget, DevinReadError, asTimestamp, columns, digest, inSnapshot, jsonObject, nodeId } from "./devin-sqlite-store.js";

export interface CliConversation {
    summary: DevinConversationSummary;
    nodes: DevinMessageNode[];
    compactions: DevinCompaction[];
    supplements: DevinDesktopMessage[];
    messageIds: Set<string>;
    hidden: boolean;
    empty: boolean;
    revision: string;
}

interface ChainResult {
    nodes: DevinMessageNode[];
    compactions: DevinCompaction[];
    warnings: string[];
}

function collectMessageIds(nodes: DevinMessageNode[]): Set<string> {
    const result = new Set<string>();
    for (const node of nodes) {
        if (node.message.role !== "user") continue;
        const id = node.message.metadata?.extensions?.["chisel/client-message-id"];
        if (typeof id === "string" && id.length) result.add(id);
    }
    return result;
}

async function readChain(database: DatabaseSync, sessionId: string, head: number | null,
    budget: ReadBudget, memo: Map<number, DevinMessageNode>, identityOnly = false): Promise<ChainResult> {
    if (head === null) return { nodes: [], compactions: [], warnings: ["DEVIN_MAIN_CHAIN_MISSING"] };
    const messageExpression = identityOnly
        ? `CASE WHEN json_valid(chat_message) THEN CASE WHEN json_type(chat_message)='object' THEN json_object('role', json_extract(chat_message, '$.role'), 'metadata', json_object('created_at', json_extract(chat_message, '$.metadata.created_at'), 'extensions', json_object('chisel/client-message-id', json_extract(chat_message, '$.metadata.extensions."chisel/client-message-id"')))) ELSE chat_message END ELSE chat_message END`
        : "chat_message";
    const statement = database.prepare(`WITH selected AS (SELECT node_id, parent_node_id, created_at, metadata,
        ${messageExpression} AS chat_message FROM message_nodes WHERE session_id=? AND node_id=?)
        SELECT node_id, parent_node_id, created_at,
        length(CAST(chat_message AS BLOB)) + coalesce(length(CAST(metadata AS BLOB)), 0) AS bytes,
        CASE WHEN length(CAST(chat_message AS BLOB)) + coalesce(length(CAST(metadata AS BLOB)), 0) <= ? THEN chat_message END AS chat_message,
        CASE WHEN length(CAST(chat_message AS BLOB)) + coalesce(length(CAST(metadata AS BLOB)), 0) <= ? THEN metadata END AS metadata
        FROM selected`);
    const nodes: DevinMessageNode[] = [];
    const compactions: DevinCompaction[] = [];
    const complete = new Set<number>();
    const visiting = new Set<number>();
    const frames: Array<{ id: number; exit: boolean }> = [{ id: head, exit: false }];
    try {
        while (frames.length) {
            budget.check();
            const frame = frames.pop()!;
            if (complete.has(frame.id)) continue;
            if (frame.exit) {
                const node = memo.get(frame.id)!;
                visiting.delete(frame.id);
                complete.add(frame.id);
                nodes.push(node);
                const previous = nodeId(node.metadata.summarized_from);
                if (previous !== null) {
                    compactions.push({
                        nodeId: node.nodeId,
                        summarizedFrom: previous,
                        summary: typeof node.message.content === "string" ? node.message.content : "",
                        createdAt: asTimestamp(node.createdAt),
                        restored: complete.has(previous),
                    });
                }
                continue;
            }
            if (visiting.has(frame.id)) throw new DevinReadError("DEVIN_CHAIN_CYCLE", "A Devin parent or summary chain contains a cycle.");
            let node = memo.get(frame.id);
            if (!node) {
                const remaining = budget.remainingBytes;
                const row = statement.get(sessionId, frame.id, remaining, remaining);
                if (!row) throw new DevinReadError("DEVIN_CHAIN_NODE_MISSING", "A referenced Devin chain node is missing.");
                await budget.take(Number(row.bytes));
                const message = jsonObject(row.chat_message, true);
                const metadata = jsonObject(row.metadata);
                if (row.parent_node_id !== null && nodeId(row.parent_node_id) === null) {
                    throw new DevinReadError("DEVIN_CHAIN_NODE_INVALID", "A Devin parent reference is invalid.");
                }
                const originalTime = message.metadata?.created_at;
                node = {
                    nodeId: frame.id,
                    parentNodeId: nodeId(row.parent_node_id),
                    createdAt: typeof originalTime === "string" || typeof originalTime === "number"
                        ? originalTime : row.created_at as number | string,
                    message,
                    metadata,
                };
                memo.set(frame.id, node);
            }
            visiting.add(frame.id);
            frames.push({ id: frame.id, exit: true });
            const previous = node.metadata.summarized_from;
            if (previous !== null && previous !== undefined) {
                const previousId = nodeId(previous);
                if (previousId === null) throw new DevinReadError("DEVIN_SUMMARY_REFERENCE_INVALID", "A Devin summarized_from reference is invalid.");
                frames.push({ id: previousId, exit: false });
            }
            if (node.parentNodeId !== null) frames.push({ id: node.parentNodeId, exit: false });
        }
        return { nodes, compactions, warnings: [] };
    } catch (error) {
        if (!(error instanceof DevinReadError) || !["DEVIN_CHAIN_CYCLE", "DEVIN_CHAIN_NODE_MISSING", "DEVIN_CHAIN_NODE_INVALID", "DEVIN_SUMMARY_REFERENCE_INVALID", "DEVIN_INVALID_JSON"].includes(error.code)) throw error;
        const knownCompactions = [...memo.values()].filter(node => nodeId(node.metadata.summarized_from) !== null).map(node => ({
            nodeId: node.nodeId,
            summarizedFrom: nodeId(node.metadata.summarized_from)!,
            summary: typeof node.message.content === "string" ? node.message.content : "",
            createdAt: asTimestamp(node.createdAt),
            restored: false,
        }));
        return { nodes: [], compactions: knownCompactions, warnings: [error.code] };
    }
}

function workspaceUris(workingDirectory: unknown, extra: unknown): string[] {
    let parsed: unknown = [];
    try { if (typeof extra === "string") parsed = JSON.parse(extra); } catch {
        throw new DevinReadError("DEVIN_INVALID_JSON", "A Devin workspace_dirs value contains invalid JSON.");
    }
    return [...new Set([workingDirectory, ...(Array.isArray(parsed) ? parsed : [])].filter((item): item is string => typeof item === "string" && item.length > 0))];
}

function knownToolIds(nodes: DevinMessageNode[]): Set<string> {
    const result = new Set<string>();
    for (const node of nodes) {
        if (typeof node.message.tool_call_id === "string") result.add(node.message.tool_call_id);
        if (Array.isArray(node.message.tool_calls)) {
            for (const call of node.message.tool_calls) if (typeof call?.id === "string") result.add(call.id);
        }
    }
    return result;
}

async function cliSupplement(database: DatabaseSync, sessionId: string, filename: string,
    mainNodes: DevinMessageNode[], memo: Map<number, DevinMessageNode>, budget: ReadBudget): Promise<{
        messages: DevinDesktopMessage[]; state: unknown[]; warnings: string[];
    }> {
    const messages: DevinDesktopMessage[] = [];
    const state: unknown[] = [];
    const warnings: string[] = [];
    const toolIds = knownToolIds(mainNodes);
    if (columns(database, "subagent_heads").has("chain_node_id")) {
        const heads = database.prepare("SELECT agent_id, chain_node_id, updated_at FROM subagent_heads WHERE session_id=? ORDER BY agent_id");
        for (const head of heads.iterate(sessionId)) {
            await budget.take(Buffer.byteLength(JSON.stringify(head)));
            state.push(head);
            const chain = await readChain(database, sessionId, nodeId(head.chain_node_id), budget, memo);
            warnings.push(...chain.warnings.map(warning => `DEVIN_SUBAGENT_${warning}`));
            state.push(chain.nodes, chain.compactions);
            for (const id of knownToolIds(chain.nodes)) toolIds.add(id);
            messages.push({
                position: messages.length,
                kind: "subagent",
                sourcePath: filename,
                payload: {
                    kind: "subagent", id: `subagent:${head.agent_id}`, agentId: String(head.agent_id),
                    parentConversationId: sessionId, source: "devin-cli-subagent-head", status: "unknown",
                    task: chain.nodes.find(node => node.message.role === "user")?.message.content,
                    updatedAt: asTimestamp(head.updated_at), partial: chain.warnings.length > 0,
                    rawNodes: chain.nodes,
                    compactions: chain.compactions,
                    childMessages: chain.nodes.filter(node => node.message.role !== "system").map(node => ({
                        kind: node.message.role === "assistant" ? "agent_message" : node.message.role === "tool" ? "tool_call" : "user_message",
                        id: `subagent:${head.agent_id}/node:${node.nodeId}`,
                        parentId: `subagent:${head.agent_id}`,
                        content: [{ content: { type: "text", text: node.message.content }, _meta: { "cognition.ai/timestamp": node.createdAt } }],
                        rawMessage: node.message,
                    })),
                },
            });
        }
    }
    if (columns(database, "tool_call_state").has("tool_call_id")) {
        const statement = database.prepare(`SELECT tool_call_id,
            coalesce(length(CAST(tool_call_json AS BLOB)),0) + coalesce(length(CAST(tool_call_update_json AS BLOB)),0) AS bytes,
            CASE WHEN coalesce(length(CAST(tool_call_json AS BLOB)),0) + coalesce(length(CAST(tool_call_update_json AS BLOB)),0) <= ? THEN tool_call_json END AS tool_call_json,
            CASE WHEN coalesce(length(CAST(tool_call_json AS BLOB)),0) + coalesce(length(CAST(tool_call_update_json AS BLOB)),0) <= ? THEN tool_call_update_json END AS tool_call_update_json
            FROM tool_call_state WHERE session_id=? ORDER BY tool_call_id`);
        for (const row of statement.iterate(budget.remainingBytes, budget.remainingBytes, sessionId)) {
            await budget.take(Number(row.bytes));
            const initial = jsonObject(row.tool_call_json);
            const update = jsonObject(row.tool_call_update_json);
            state.push([row.tool_call_id, initial, update]);
            if (toolIds.has(String(row.tool_call_id))) {
                messages.push({
                    position: messages.length, kind: "tool_call", sourcePath: filename,
                    payload: { kind: "tool_call", id: String(row.tool_call_id), source: "devin-cli-tool-state",
                        content: { ...initial, ...update, toolCallId: String(row.tool_call_id), _meta: { ...initial._meta, ...update._meta } } },
                });
            }
        }
    }
    return { messages, state, warnings };
}

export async function readCliConversations(filename: string, budget: ReadBudget,
    options: { identityOnly?: boolean; sessionId?: string } = {}): Promise<CliConversation[]> {
    return inSnapshot(filename, budget, async (database, identity, schema) => {
        const sessionColumns = columns(database, "sessions");
        const nodeColumns = columns(database, "message_nodes");
        if (!["id", "main_chain_id"].every(column => sessionColumns.has(column)) ||
            !["node_id", "parent_node_id", "session_id", "chat_message", "metadata", "created_at"].every(column => nodeColumns.has(column))) {
            throw new DevinReadError("DEVIN_SCHEMA_UNSUPPORTED", "The Devin CLI database does not have the supported sessions/message_nodes schema.");
        }
        const selectedColumns = ["id", "main_chain_id", "working_directory", "workspace_dirs", "title", "created_at", "last_activity_at", "hidden", "metadata"];
        const select = selectedColumns.map(column => sessionColumns.has(column) && !(options.identityOnly && column === "metadata") ? column : `NULL AS ${column}`).join(", ");
        const results: CliConversation[] = [];
        const sessions = database.prepare(`SELECT ${select} FROM sessions ${options.sessionId === undefined ? "" : "WHERE id=?"} ORDER BY id`);
        for (const session of sessions.iterate(...(options.sessionId === undefined ? [] : [options.sessionId]))) {
            await budget.take(Buffer.byteLength(JSON.stringify(session)));
            const sessionId = String(session.id);
            const empty = !database.prepare("SELECT 1 FROM message_nodes WHERE session_id=? LIMIT 1").get(sessionId);
            const memo = new Map<number, DevinMessageNode>();
            const chain = empty ? { nodes: [], compactions: [], warnings: ["DEVIN_EMPTY_CONVERSATION"] }
                : await readChain(database, sessionId, nodeId(session.main_chain_id), budget, memo, options.identityOnly);
            const supplement = options.identityOnly ? { messages: [], state: [], warnings: [] }
                : await cliSupplement(database, sessionId, filename, chain.nodes, memo, budget);
            const warnings = [...new Set([...chain.warnings, ...supplement.warnings])];
            const summary: DevinConversationSummary = {
                id: sessionId, canonicalId: sessionId, sessionId, aliases: [sessionId],
                title: typeof session.title === "string" ? session.title : sessionId,
                cwd: typeof session.working_directory === "string" ? session.working_directory : undefined,
                workspaceUris: workspaceUris(session.working_directory, session.workspace_dirs),
                createdAt: asTimestamp(session.created_at), updatedAt: asTimestamp(session.last_activity_at),
                sourcePath: filename, desktopPaths: [], sourceKind: "devin-cli", matchedMessageIds: 0,
                mainChainId: nodeId(session.main_chain_id) ?? undefined, partial: warnings.length > 0, warnings,
            };
            results.push({
                summary, nodes: chain.nodes, compactions: chain.compactions, supplements: supplement.messages,
                messageIds: collectMessageIds(chain.nodes), hidden: Number(session.hidden ?? 0) !== 0,
                empty,
                revision: digest([identity, schema, session, [...memo.values()], chain.compactions, supplement.state, warnings]),
            });
        }
        return results;
    });
}
