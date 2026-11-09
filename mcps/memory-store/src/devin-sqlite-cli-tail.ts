import type { DatabaseSync } from "node:sqlite";
import type { DevinCompaction, DevinMessageNode, DevinRelativeCoverage } from "./devin-types.js";
import { ReadBudget, DevinReadError, asTimestamp, jsonObject, nodeId } from "./devin-sqlite-store.js";

export async function readCliTailWindow(database: DatabaseSync, sessionId: string, head: number | null,
    budget: ReadBudget, tailRounds: number, messageRoles?: string[]): Promise<{
        nodes: DevinMessageNode[]; compactions: DevinCompaction[]; warnings: string[]; relativeCoverage: DevinRelativeCoverage;
    }> {
    if (head === null) throw new DevinReadError("DEVIN_RANGE_UNAVAILABLE", "The Devin main chain has no readable head.");
    const header = database.prepare(`SELECT node_id, parent_node_id, created_at,
        CASE WHEN json_valid(metadata) AND json_type(metadata) IN ('object','null') THEN
            json_object('summarized_from',json_extract(metadata,'$.summarized_from'),
                'is_system_prefix',json_extract(metadata,'$.is_system_prefix')) ELSE metadata END AS metadata,
        CASE WHEN json_valid(chat_message) AND json_type(chat_message)='object' THEN
            json_object('role',json_extract(chat_message,'$.role'),'tool_call_id',json_extract(chat_message,'$.tool_call_id'),
                'metadata',json_object('created_at',json_extract(chat_message,'$.metadata.created_at')))
            ELSE NULL END AS message
        FROM message_nodes WHERE session_id=? AND node_id=?`);
    const body = database.prepare(`SELECT length(CAST(chat_message AS BLOB)) AS bytes,
        CASE WHEN length(CAST(chat_message AS BLOB))<=? THEN chat_message END AS message
        FROM message_nodes WHERE session_id=? AND node_id=?`);
    const selected: DevinMessageNode[] = [];
    const complete = new Set<number>();
    const visiting = new Set<number>();
    const frames: Array<{ id: number; exit: boolean }> = [{ id: head, exit: false }];
    let rounds = 0;
    let bounded = false;
    while (frames.length) {
        budget.check();
        const frame = frames.pop()!;
        if (frame.exit) { visiting.delete(frame.id); complete.add(frame.id); continue; }
        if (visiting.has(frame.id)) throw new DevinReadError("DEVIN_CHAIN_CYCLE", "The selected Devin tail contains a chain cycle.");
        if (complete.has(frame.id)) continue;
        const row = header.get(sessionId, frame.id);
        if (!row) throw new DevinReadError("DEVIN_CHAIN_NODE_MISSING", "A selected Devin tail node is missing.");
        await budget.take(Buffer.byteLength(JSON.stringify(row)));
        const metadata = jsonObject(row.metadata);
        if (metadata.is_system_prefix === 1) metadata.is_system_prefix = true;
        const message = jsonObject(row.message, true);
        const parent = nodeId(row.parent_node_id);
        const previous = nodeId(metadata.summarized_from);
        if (row.parent_node_id !== null && parent === null) throw new DevinReadError("DEVIN_CHAIN_NODE_INVALID", "A selected Devin parent reference is invalid.");
        if (metadata.summarized_from !== null && metadata.summarized_from !== undefined && previous === null) {
            throw new DevinReadError("DEVIN_SUMMARY_REFERENCE_INVALID", "A selected Devin summary reference is invalid.");
        }
        if (previous !== null) throw new DevinReadError("DEVIN_TAIL_COMPACTION_REQUIRED", "The selected tail crosses a summary edge and needs ordered range validation.");
        const timestamp = message.metadata?.created_at;
        selected.push({ nodeId: frame.id, parentNodeId: parent,
            createdAt: typeof timestamp === "string" || typeof timestamp === "number" ? timestamp : row.created_at as string | number,
            message, metadata });
        if (message.role === "user" && metadata.is_system_prefix !== true && metadata.is_system_prefix !== 1 && previous === null) {
            if (++rounds === tailRounds) { bounded = parent !== null || previous !== null || frames.length > 0; break; }
        }
        visiting.add(frame.id);
        frames.push({ id: frame.id, exit: true });
        if (parent !== null) frames.push({ id: parent, exit: false });
        if (previous !== null) frames.push({ id: previous, exit: false });
    }
    selected.reverse();
    for (const node of selected) {
        if (messageRoles && !messageRoles.includes(node.message.role)) continue;
        const row = body.get(budget.remainingBytes, sessionId, node.nodeId);
        if (!row) throw new DevinReadError("DEVIN_CHAIN_NODE_MISSING", "A selected Devin message body is missing.");
        await budget.take(Number(row.bytes));
        node.message = jsonObject(row.message, true);
    }
    const compactions = selected.filter(node => nodeId(node.metadata.summarized_from) !== null).map(node => ({
        nodeId: node.nodeId, summarizedFrom: nodeId(node.metadata.summarized_from)!,
        summary: typeof node.message.content === "string" ? node.message.content : "",
        createdAt: asTimestamp(node.createdAt), restored: selected.some(candidate => candidate.nodeId === node.metadata.summarized_from),
    }));
    let count = 0;
    for (const node of selected) {
        if (node.message.role === "system" || node.metadata.is_system_prefix === true || node.metadata.is_system_prefix === 1) continue;
        if (node.message.role === "user" || !count) count++;
    }
    return { nodes: selected, compactions, warnings: ["DEVIN_RANGE_MAIN_CHAIN_ONLY", "DEVIN_RELATIVE_TAIL_WINDOW"],
        relativeCoverage: { unit: "round", startRound: 1, endRound: count, startStep: 0, endStepExclusive: selected.length,
            requestedRangeComplete: !bounded || rounds >= tailRounds } };
}
