import type { DatabaseSync } from "node:sqlite";
import { setImmediate as yieldImmediate } from "node:timers/promises";
import type { DevinCompaction, DevinConversationSummary, DevinDesktopMessage, DevinMessageNode, DevinRoundCoverage, DevinRoundRange } from "./devin-types.js";
import { ReadBudget, DevinReadError, asTimestamp, columns, digest, inSnapshot, jsonObject, nodeId } from "./devin-sqlite-store.js";

export interface CliConversation {
    summary: DevinConversationSummary;
    nodes: DevinMessageNode[];
    compactions: DevinCompaction[];
    supplements: DevinDesktopMessage[];
    messageIds: Set<string>;
    toolCallIds: Set<string>;
    hidden: boolean;
    empty: boolean;
    revision: string;
    coverage?: DevinRoundCoverage;
}

interface ChainResult {
    nodes: DevinMessageNode[];
    compactions: DevinCompaction[];
    warnings: string[];
}

interface ValidatedChain extends ChainResult {
    mainChainId?: number;
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
        ? `CASE WHEN message_blob IS NOT NULL THEN CASE WHEN json_type(message_blob)='object' THEN json_object('role', json_extract(message_blob, '$.role'), 'tool_call_id', json_extract(message_blob, '$.tool_call_id'), 'tool_calls', json((SELECT json_group_array(json_object('id',json_extract(call.value,'$.id'))) FROM json_each(message_blob,'$.tool_calls') AS call WHERE call.type='object')), 'metadata', json_object('created_at', json_extract(message_blob, '$.metadata.created_at'), 'extensions', json_object('chisel/client-message-id', json_extract(message_blob, '$.metadata.extensions."chisel/client-message-id"')))) ELSE chat_message END ELSE chat_message END`
        : "chat_message";
    const statement = database.prepare(`WITH RECURSIVE reachable(node_id) AS (
        SELECT ? UNION
        SELECT nodes.parent_node_id FROM reachable CROSS JOIN message_nodes AS nodes ON nodes.node_id=reachable.node_id
            WHERE nodes.session_id=? AND nodes.parent_node_id IS NOT NULL UNION
        SELECT json_extract(nodes.metadata,'$.summarized_from') FROM reachable CROSS JOIN message_nodes AS nodes ON nodes.node_id=reachable.node_id
            WHERE nodes.session_id=? AND json_valid(nodes.metadata) AND json_type(nodes.metadata,'$.summarized_from')='integer'
            LIMIT ?), original AS (SELECT node_id, parent_node_id, created_at, metadata, chat_message,
            ${identityOnly ? "CASE WHEN json_valid(chat_message) THEN jsonb(chat_message) END" : "NULL"} AS message_blob
            FROM message_nodes WHERE session_id=? AND node_id IN (SELECT node_id FROM reachable)),
        selected AS (SELECT node_id, parent_node_id, created_at, metadata, ${messageExpression} AS chat_message FROM original)
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
        const remaining = budget.remainingBytes;
        for (const row of statement.iterate(head, sessionId, sessionId, Math.min(Number.MAX_SAFE_INTEGER, budget.maxNodes + memo.size + 1), sessionId, remaining, remaining)) {
            const id = nodeId(row.node_id);
            if (id === null) throw new DevinReadError("DEVIN_CHAIN_NODE_INVALID", "A Devin node reference is invalid.");
            if (memo.has(id)) continue;
            await budget.take(Number(row.bytes));
            const message = jsonObject(row.chat_message, true);
            const metadata = jsonObject(row.metadata);
            if (row.parent_node_id !== null && nodeId(row.parent_node_id) === null) {
                throw new DevinReadError("DEVIN_CHAIN_NODE_INVALID", "A Devin parent reference is invalid.");
            }
            const originalTime = message.metadata?.created_at;
            memo.set(id, { nodeId: id, parentNodeId: nodeId(row.parent_node_id),
                createdAt: typeof originalTime === "string" || typeof originalTime === "number" ? originalTime : row.created_at as number | string,
                message, metadata });
        }
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
            const node = memo.get(frame.id);
            if (!node) throw new DevinReadError("DEVIN_CHAIN_NODE_MISSING", "A referenced Devin chain node is missing.");
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

export async function findCliIdentityCandidates(filename: string, budget: ReadBudget, messageIds: string[], toolCallIds: string[]): Promise<{ sessionIds: string[]; uncertain: boolean }> {
    return inSnapshot(filename, budget, async database => {
        const userMatch = messageIds.length ? `user_id IN (SELECT value FROM json_each(?))` : "0";
        const toolMatch = toolCallIds.length ? `tool_id IN (SELECT value FROM json_each(?))
                    OR EXISTS (SELECT 1 FROM json_each(tool_ids) AS call WHERE call.value IN (SELECT value FROM json_each(?)))` : "0";
        const userProjection = messageIds.length ? `json_extract(chat_message,'$.metadata.extensions."chisel/client-message-id"')` : "NULL";
        const toolProjection = toolCallIds.length ? `json_extract(chat_message,'$.tool_call_id')` : "NULL";
        const toolIdsProjection = toolCallIds.length ? `(SELECT json_group_array(json_extract(call.value,'$.id'))
            FROM json_each(chat_message,'$.tool_calls') AS call WHERE call.type='object')` : "NULL";
        const query = (comparison: string) => database.prepare(`WITH page AS MATERIALIZED (
            SELECT rowid AS identity_cursor FROM message_nodes
            WHERE rowid ${comparison} ? ORDER BY rowid LIMIT 64),
            projected AS MATERIALIZED (
            SELECT page.identity_cursor, session_id,
                CASE WHEN json_valid(chat_message) THEN json_type(chat_message) END AS message_kind,
                CASE WHEN json_valid(chat_message) THEN ${userProjection} END AS user_id,
                CASE WHEN json_valid(chat_message) THEN ${toolProjection} END AS tool_id,
                CASE WHEN json_valid(chat_message) THEN ${toolIdsProjection} END AS tool_ids,
                CASE WHEN metadata IS NOT NULL AND metadata!='' AND (NOT json_valid(metadata) OR json_type(metadata) NOT IN ('object','null')) THEN 1 ELSE 0 END AS invalid_metadata
            FROM page JOIN message_nodes ON message_nodes.rowid=page.identity_cursor),
            matches AS MATERIALIZED (SELECT identity_cursor, session_id, CASE WHEN message_kind IS NULL OR message_kind!='object' OR invalid_metadata=1
                THEN 1 ELSE 0 END AS uncertain,
                CASE WHEN message_kind='object' THEN
                    ${userMatch} OR ${toolMatch} ELSE 0 END AS matched FROM projected)
            SELECT identity_cursor, session_id, uncertain, matched FROM matches ORDER BY identity_cursor`);
        const firstPage = query(">=");
        const nextPage = query(">");
        firstPage.setReadBigInts(true);
        nextPage.setReadBigInts(true);
        const sessionIds = new Set<string>();
        const seen = new Set<string>();
        let uncertain = false;
        const parameters = [...(messageIds.length ? [JSON.stringify(messageIds)] : []), ...(toolCallIds.length ? [JSON.stringify(toolCallIds), JSON.stringify(toolCallIds)] : [])];
        let cursor = -9223372036854775808n;
        let statement = firstPage;
        for (;;) {
            budget.check();
            let count = 0;
            for (const row of statement.iterate(cursor, ...parameters)) {
                budget.check();
                count++;
                cursor = row.identity_cursor as bigint;
                if (Number(row.uncertain) !== 1 && Number(row.matched) !== 1) continue;
                const sessionId = String(row.session_id);
                const isUncertain = Number(row.uncertain) === 1;
                const identity = JSON.stringify([sessionId, isUncertain]);
                if (seen.has(identity)) continue;
                seen.add(identity);
                await budget.take(Buffer.byteLength(JSON.stringify({ session_id: row.session_id, uncertain: Number(row.uncertain) })));
                uncertain ||= isUncertain;
                sessionIds.add(sessionId);
            }
            if (count < 64) break;
            statement = nextPage;
            await yieldImmediate();
        }
        return { sessionIds: [...sessionIds], uncertain };
    });
}

export function validateDevinRoundRange(request: DevinRoundRange): void {
    const positive = (value: number) => Number.isSafeInteger(value) && value > 0;
    if ("tailRounds" in request ? !positive(request.tailRounds) || "startRound" in request || "endRound" in request
        : !positive(request.startRound) || (request.endRound !== undefined && (!positive(request.endRound) || request.endRound < request.startRound))) {
        throw new DevinReadError("DEVIN_INVALID_RANGE", "Use positive integer tailRounds or 1-based inclusive startRound/endRound.");
    }
}

function roundWindow(chain: ChainResult, request: DevinRoundRange): { nodes: DevinMessageNode[]; coverage: DevinRoundCoverage } {
    validateDevinRoundRange(request);
    const boundaries: number[] = [];
    const summaries = new Set(chain.compactions.map(compaction => compaction.nodeId));
    for (const [index, node] of chain.nodes.entries()) {
        if (node.message.role === "system" || node.metadata.is_system_prefix === true || summaries.has(node.nodeId)) continue;
        if (node.message.role === "user" || !boundaries.length) boundaries.push(index);
    }
    const totalRounds = boundaries.length;
    const startRound = Math.min(totalRounds + 1, "tailRounds" in request ? Math.max(1, totalRounds - request.tailRounds + 1) : request.startRound);
    const endRound = Math.min(totalRounds, "tailRounds" in request ? totalRounds : request.endRound ?? totalRounds);
    const startStep = boundaries[startRound - 1] ?? chain.nodes.length;
    const endStepExclusive = boundaries[endRound] ?? chain.nodes.length;
    return { nodes: chain.nodes.slice(startStep, endStepExclusive), coverage: { unit: "round", startRound, endRound, totalRounds,
        startStep, endStepExclusive, totalSteps: chain.nodes.length, complete: startRound === 1 && endRound === totalRounds } };
}

async function readChainWindow(database: DatabaseSync, sessionId: string, head: number | null, budget: ReadBudget,
    memo: Map<number, DevinMessageNode>, request: DevinRoundRange, validated?: ValidatedChain): Promise<ChainResult & { coverage: DevinRoundCoverage }> {
    if (validated && validated.mainChainId !== (head ?? undefined)) throw new DevinReadError("DEVIN_IDENTITY_CHANGED", "Devin main chain changed before range reading.");
    const headers = validated ?? await readChain(database, sessionId, head, budget, new Map(), true);
    if (headers.warnings.length) throw new DevinReadError("DEVIN_RANGE_UNAVAILABLE", `Cannot establish round boundaries: ${headers.warnings.join(", ")}; use a full read to inspect source diagnostics.`);
    const window = roundWindow(headers, request);
    const statement = database.prepare(`SELECT node_id, length(CAST(chat_message AS BLOB)) AS bytes,
        CASE WHEN length(CAST(chat_message AS BLOB)) <= ? THEN chat_message END AS selected_message
        FROM message_nodes WHERE session_id=? AND node_id IN (SELECT value FROM json_each(?))`);
    const headersById = new Map(window.nodes.map(node => [node.nodeId, node]));
    for (const row of statement.iterate(budget.remainingBytes, sessionId, JSON.stringify(window.nodes.map(node => node.nodeId)))) {
        await budget.take(Number(row.bytes));
        const header = headersById.get(Number(row.node_id))!;
        memo.set(header.nodeId, { ...header, message: jsonObject(row.selected_message, true) });
    }
    const nodes = window.nodes.map(node => memo.get(node.nodeId)!);
    const compactions = headers.compactions.filter(item => memo.has(item.nodeId)).map(item => ({ ...item,
        summary: typeof memo.get(item.nodeId)!.message.content === "string" ? memo.get(item.nodeId)!.message.content : "" }));
    return { nodes, compactions, warnings: ["DEVIN_RANGE_MAIN_CHAIN_ONLY"], coverage: window.coverage };
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
    mainNodes: DevinMessageNode[], memo: Map<number, DevinMessageNode>, budget: ReadBudget, mainOnly = false): Promise<{
        messages: DevinDesktopMessage[]; state: unknown[]; warnings: string[];
    }> {
    const messages: DevinDesktopMessage[] = [];
    const state: unknown[] = [];
    const warnings: string[] = [];
    const toolIds = knownToolIds(mainNodes);
    if (!mainOnly && columns(database, "subagent_heads").has("chain_node_id")) {
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
            FROM tool_call_state WHERE session_id=? ${mainOnly ? "AND tool_call_id IN (SELECT value FROM json_each(?))" : ""} ORDER BY tool_call_id`);
        for (const row of statement.iterate(budget.remainingBytes, budget.remainingBytes, sessionId, ...(mainOnly ? [JSON.stringify([...toolIds])] : []))) {
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
    options: { identityOnly?: boolean; metadataOnly?: boolean; roundRange?: DevinRoundRange; validatedChain?: ValidatedChain; sessionId?: string; conversationIds?: string[]; acceptSummary?: (summary: DevinConversationSummary) => boolean; onConversation?: (conversation: CliConversation) => void; onSession?: () => void; onSessionError?: (id: string, error: unknown) => void } = {}): Promise<CliConversation[]> {
    return inSnapshot(filename, budget, async (database, identity, schema) => {
        const sessionColumns = columns(database, "sessions");
        const nodeColumns = columns(database, "message_nodes");
        if (!["id", "main_chain_id"].every(column => sessionColumns.has(column)) ||
            !["node_id", "parent_node_id", "session_id", "chat_message", "metadata", "created_at"].every(column => nodeColumns.has(column))) {
            throw new DevinReadError("DEVIN_SCHEMA_UNSUPPORTED", "The Devin CLI database does not have the supported sessions/message_nodes schema.");
        }
        const selectedColumns = ["id", "main_chain_id", "working_directory", "workspace_dirs", "title", "created_at", "last_activity_at", "hidden", "metadata"];
        const select = selectedColumns.map(column => sessionColumns.has(column) && !((options.identityOnly || options.metadataOnly) && column === "metadata") ? column : `NULL AS ${column}`).join(", ");
        const results: CliConversation[] = [];
        const ids = options.sessionId !== undefined ? [options.sessionId] : options.conversationIds;
        const sessions = database.prepare(`SELECT ${select} FROM sessions ${ids?.length ? `WHERE id IN (${ids.map(() => "?").join(",")})` : ""} ORDER BY ${sessionColumns.has("last_activity_at") ? "last_activity_at DESC," : ""} id`);
        for (const session of sessions.iterate(...(ids || []))) {
            await budget.take(Buffer.byteLength(JSON.stringify(session)));
            options.onSession?.();
            const sessionId = String(session.id);
            try {
                const empty = !database.prepare("SELECT 1 FROM message_nodes WHERE session_id=? LIMIT 1").get(sessionId);
                const memo = new Map<number, DevinMessageNode>();
                const chain: ChainResult & { coverage?: DevinRoundCoverage } = empty || options.metadataOnly ? { nodes: [], compactions: [], warnings: empty ? ["DEVIN_EMPTY_CONVERSATION"] : [] }
                    : options.roundRange && !options.identityOnly ? await readChainWindow(database, sessionId, nodeId(session.main_chain_id), budget, memo, options.roundRange, options.validatedChain)
                    : await readChain(database, sessionId, nodeId(session.main_chain_id), budget, memo, options.identityOnly);
                const supplement = options.identityOnly || options.metadataOnly ? { messages: [], state: [], warnings: [] }
                    : await cliSupplement(database, sessionId, filename, chain.nodes, memo, budget, Boolean(options.roundRange));
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
                if (options.acceptSummary && !options.acceptSummary(summary)) continue;
                results.push({
                    summary, nodes: chain.nodes, compactions: chain.compactions, supplements: supplement.messages,
                    messageIds: collectMessageIds(chain.nodes), toolCallIds: knownToolIds(chain.nodes), hidden: Number(session.hidden ?? 0) !== 0,
                    empty,
                    revision: digest([identity, schema, session, [...memo.values()], chain.compactions, supplement.state, warnings]),
                    ...(chain.coverage ? { coverage: chain.coverage } : {}),
                });
                options.onConversation?.(results[results.length - 1]);
            } catch (error) {
                budget.check();
                if (!options.onSessionError || !(error instanceof DevinReadError) || /BUDGET|DEADLINE|ABORTED/u.test(error.code)) throw error;
                options.onSessionError(sessionId, error);
            }
        }
        return results;
    });
}
