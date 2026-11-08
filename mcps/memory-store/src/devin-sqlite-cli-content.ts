import type { DatabaseSync } from "node:sqlite";
import type { DevinMessageNode, DevinCompaction } from "./devin-types.js";
import { ReadBudget, DevinReadError, jsonObject } from "./devin-sqlite-store.js";

export async function readCliMessageBodies(database: DatabaseSync, sessionId: string, nodes: DevinMessageNode[],
    budget: ReadBudget, memo: Map<number, DevinMessageNode>, messageRoles?: string[]): Promise<DevinMessageNode[]> {
    const statement = database.prepare(`SELECT node_id,
        length(CAST(chat_message AS BLOB)) + coalesce(length(CAST(metadata AS BLOB)), 0) AS bytes,
        CASE WHEN length(CAST(chat_message AS BLOB)) + coalesce(length(CAST(metadata AS BLOB)), 0) <= ? THEN chat_message END AS message,
        CASE WHEN length(CAST(chat_message AS BLOB)) + coalesce(length(CAST(metadata AS BLOB)), 0) <= ? THEN metadata END AS metadata
        FROM message_nodes WHERE session_id=? AND node_id=?`);
    for (const node of nodes) {
        budget.check();
        if (messageRoles && !messageRoles.includes(node.message.role)) continue;
        const remaining = budget.remainingBytes;
        const row = statement.get(remaining, remaining, sessionId, node.nodeId);
        if (!row) throw new DevinReadError("DEVIN_CHAIN_NODE_MISSING", "A selected Devin message body is missing.");
        await budget.take(Number(row.bytes), false);
        memo.set(node.nodeId, { ...node, message: jsonObject(row.message, true), metadata: jsonObject(row.metadata) });
    }
    return nodes.map(node => memo.get(node.nodeId) ?? node);
}

export function hydrateCliCompactions(compactions: DevinCompaction[], nodes: DevinMessageNode[]): DevinCompaction[] {
    const messages = new Map(nodes.map(node => [node.nodeId, node.message]));
    return compactions.map(compaction => ({ ...compaction,
        summary: typeof messages.get(compaction.nodeId)?.content === "string" ? messages.get(compaction.nodeId)!.content : compaction.summary }));
}
