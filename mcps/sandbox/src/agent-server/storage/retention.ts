import { AgentFault } from '../protocol.js';
import type { RetainPolicy } from '../protocol.js';
import type { SqlDatabase } from './internal.js';
import { unlinkSync } from 'node:fs';
import { storagePath } from './objects.js';
import type { StoreRecord, RetentionSweepOptions, RetentionSweepConversation, RetentionSweepResult, RetentionGarbageResult } from './port.js';

export function recordRetention(value: Record<string, unknown>): RetainPolicy {
    const policy = value.retention as RetainPolicy | undefined;
    if (!policy || !['temporary', 'ttl', 'archive'].includes(policy.mode)) {
        throw new AgentFault('RETENTION_MODE_REQUIRED', '会话必须明确指定保存方式');
    }
    if (policy.mode === 'ttl' && (!Number.isSafeInteger(policy.ttlDurationMs)
        || policy.ttlDurationMs! < 60_000 || policy.ttlDurationMs! > 31_536_000_000)) {
        throw new AgentFault('RETENTION_DURATION_REQUIRED', '限时保存必须显式提供1分钟至365天的时长');
    }
    if (policy.mode !== 'ttl' && policy.ttlDurationMs !== undefined) {
        throw new AgentFault('INVALID_PARAMS', '只有限时保存接受时长');
    }
    return policy;
}

export function refreshRetention(database: SqlDatabase, conversationId: string): void {
    const conversation = database.prepare('SELECT mode, ttl_ms, last_run_end, last_close FROM conversations WHERE cid = ?').get(conversationId);
    if (!conversation) return;
    const active = database.prepare("SELECT COUNT(*) AS total FROM runs WHERE cid = ? AND kind = 'task' AND state NOT IN ('succeeded','failed','cancelled')")
        .get(conversationId);
    const lastRunEnd = conversation.last_run_end;
    const anchors = [lastRunEnd, conversation.last_close].filter((value): value is string => typeof value === 'string');
    const anchor = anchors.sort().at(-1);
    const expiresAt = conversation.mode === 'ttl' && anchor
        ? new Date(Date.parse(anchor) + Number(conversation.ttl_ms)).toISOString() : null;
    database.prepare('UPDATE conversations SET active_runs = ?, last_run_end = ?, expires_at = ? WHERE cid = ?')
        .run(Number(active?.total ?? 0), lastRunEnd ?? null, expiresAt, conversationId);
    const root = retentionRoot(database, conversationId);
    let latestAnchor: string | undefined;
    for (const members of retentionFamilyPages(database, root)) {
        const placeholders = members.map(() => '?').join(',');
        const latest = database.prepare(`SELECT MAX(anchor) AS anchor FROM (
            SELECT last_run_end AS anchor FROM conversations WHERE cid IN (${placeholders})
            UNION ALL SELECT last_close AS anchor FROM conversations WHERE cid IN (${placeholders}))`).get(...members, ...members);
        if (latest?.anchor && (!latestAnchor || String(latest.anchor) > latestAnchor)) latestAnchor = String(latest.anchor);
    }
    const rootPolicy = database.prepare('SELECT mode,ttl_ms FROM conversations WHERE cid = ?').get(root);
    if (rootPolicy?.mode === 'ttl') database.prepare('UPDATE conversations SET expires_at = ? WHERE cid = ?')
        .run(latestAnchor ? new Date(Date.parse(latestAnchor) + Number(rootPolicy.ttl_ms)).toISOString() : null, root);
}

export function assertRunMayStart(database: SqlDatabase, conversationId: string, now: string): void {
    const root = retentionRoot(database, conversationId);
    const row = database.prepare('SELECT state, mode, expires_at, active_runs FROM conversations WHERE cid = ?').get(root);
    if (!row) throw new AgentFault('CONVERSATION_NOT_FOUND', '会话不存在');
    if (['expiryPending', 'tombstoned', 'gcPending', 'deleted', 'purging'].includes(String(row.state))) {
        throw new AgentFault('RETENTION_EXPIRED', '会话已经到期或正在清理，不能启动新执行');
    }
    if (row.mode === 'ttl' && row.expires_at && Number(row.active_runs) === 0 && String(row.expires_at) <= now) {
        throw new AgentFault('RETENTION_EXPIRED', '限时会话已经到期，不能启动新执行');
    }
}

export function scanExpired(database: SqlDatabase, now: string, limit = 50): { conversationId: string; policyRevision: number; deferred: boolean }[] {
    const rows = database.prepare(`SELECT cid, policy_rev FROM conversations WHERE mode = 'ttl' AND expires_at <= ? AND state NOT IN ('tombstoned','deleted','purging') AND ${rootRetentionOwner} ORDER BY expires_at,cid LIMIT ?`)
        .all(now, limit);
    const result = rows.map(row => ({ conversationId: String(row.cid), policyRevision: Number(row.policy_rev), deferred: Boolean(retentionBlocker(database, String(row.cid))) }));
    for (const item of result) {
        if (!item.deferred) database.prepare('UPDATE conversations SET state = ? WHERE cid = ? AND policy_rev = ? AND active_runs = 0')
            .run('expiryPending', item.conversationId, item.policyRevision);
    }
    return result;
}

function retentionRoot(database: SqlDatabase, conversationId: string): string {
    let current = conversationId; const visited = new Set<string>();
    while (!visited.has(current) && visited.size < 200) {
        visited.add(current);
        const owner = database.prepare("SELECT value_json FROM server_state WHERE kind = 'retentionOwner' AND id = ?").get(current);
        if (owner) return String(JSON.parse(String(owner.value_json)).rootConversationId);
        const legacy = database.prepare("SELECT json_extract(value_json,'$.options.parentConversationId') AS parent FROM store_records WHERE cid = ? AND kind = 'conversation'").get(current);
        if (typeof legacy?.parent !== 'string' || !legacy.parent) return current;
        current = legacy.parent;
    }
    throw new AgentFault('RETENTION_TRANSITION_BUSY', '保存归属链尚未确认，保留原会话内容');
}

const retentionFamilyCte = `WITH RECURSIVE ownership(cid,parent) AS (
        SELECT id,json_extract(value_json,'$.parentConversationId') FROM server_state WHERE kind = 'retentionOwner'
        UNION SELECT cid,json_extract(value_json,'$.options.parentConversationId') FROM store_records WHERE kind = 'conversation' AND json_extract(value_json,'$.options.parentConversationId') IS NOT NULL),
        family(cid) AS (SELECT ? UNION SELECT ownership.cid FROM ownership JOIN family ON ownership.parent = family.cid)`;

function* retentionFamilyPages(database: SqlDatabase, conversationId: string): Generator<string[]> {
    let cursor = '';
    while (true) {
        const members = database.prepare(`${retentionFamilyCte} SELECT cid FROM family WHERE cid > ? ORDER BY cid LIMIT 200`)
            .all(conversationId, cursor).map(row => String(row.cid));
        if (!members.length) return;
        yield members;
        cursor = members[members.length - 1];
    }
}

const rootRetentionOwner = `NOT EXISTS (SELECT 1 FROM server_state WHERE kind = 'retentionOwner' AND id = conversations.cid)
    AND NOT EXISTS (SELECT 1 FROM store_records WHERE cid = conversations.cid AND kind = 'conversation' AND json_extract(value_json,'$.options.parentConversationId') IS NOT NULL)`;

export function recordRetentionOwnership(database: SqlDatabase, record: StoreRecord): void {
    const options = record.value.options as Record<string, unknown> | undefined;
    const parentId = options?.parentConversationId;
    const previous = database.prepare("SELECT value_json FROM server_state WHERE kind = 'retentionOwner' AND id = ?").get(record.key.id);
    const saved = database.prepare("SELECT value_json FROM store_records WHERE cid = ? AND kind = 'conversation'").get(record.key.id);
    if (saved && JSON.parse(String(saved.value_json)).options?.parentConversationId !== parentId) throw new AgentFault('POLICY_CHANGED', '已保存会话的父级归属不可更改');
    if (previous && JSON.parse(String(previous.value_json)).parentConversationId !== parentId) throw new AgentFault('POLICY_CHANGED', '派生会话的保存归属已经固定');
    if (parentId === undefined) return;
    if (typeof parentId !== 'string' || !parentId || parentId === record.key.id) throw new AgentFault('INVALID_PARAMS', '派生会话需要明确父会话');
    const parent = database.prepare('SELECT mode,ttl_ms,state FROM conversations WHERE cid = ?').get(parentId);
    const parentRecord = database.prepare("SELECT value_json FROM store_records WHERE cid = ? AND kind = 'conversation'").get(parentId);
    const policy = recordRetention(record.value);
    if (!parent || ['deleted', 'purging', 'expiryPending', 'gcPending'].includes(String(parent.state))) throw new AgentFault('RETENTION_EXPIRED', '父会话已经到期或正在清理');
    if (!parentRecord || JSON.parse(String(parentRecord.value_json)).principalId !== record.value.principalId) throw new AgentFault('POLICY_CHANGED', '父子保存归属需要同一已确认主体');
    if (policy.mode !== parent.mode || (policy.ttlDurationMs ?? null) !== parent.ttl_ms) throw new AgentFault('POLICY_CHANGED', '派生会话须继承父会话保存方式与限时时长');
    const root = retentionRoot(database, parentId);
    if (!previous && database.prepare(`${retentionFamilyCte} SELECT 1 FROM family WHERE cid = ? LIMIT 1`).get(root, record.key.id)) throw new AgentFault('INVALID_PARAMS', '派生会话保存归属重复');
    database.prepare("INSERT INTO server_state (kind,id,revision,value_json) VALUES ('retentionOwner',?,1,?) ON CONFLICT(kind,id) DO NOTHING")
        .run(record.key.id, JSON.stringify({ parentConversationId: parentId, rootConversationId: root }));
}

function webResourceRecords(database: SqlDatabase, members: string[]): { id: string; value_json: string }[] {
    const placeholders = members.map(() => '?').join(',');
    const selection = `kind = 'control' AND json_extract(value_json,'$.conversationId') IN (${placeholders})
        AND json_extract(value_json,'$.adapterId') IN ('web-native-sessions-v1','web-table-artifacts-v1','native.command')`;
    return database.prepare(`SELECT record_id AS id,value_json FROM store_records WHERE cid IS NULL
        AND record_id GLOB 'web-resource:*' AND ${selection}
        UNION SELECT id,value_json FROM server_state WHERE id GLOB 'web-resource:*' AND ${selection}`)
        .all(...members, ...members) as { id: string; value_json: string }[];
}

function webResourceReleased(resource: { state?: string; cleanupState?: string;
    receipt?: { released?: boolean; terminalConfirmed?: boolean } }): boolean {
    return resource.state === 'released' && resource.cleanupState === 'released'
        && resource.receipt?.released === true && resource.receipt.terminalConfirmed === true;
}

function removeReleasedWebResources(database: SqlDatabase, conversationId: string): void {
    const records = webResourceRecords(database, [conversationId]);
    const pending = new Set(records.filter(record => !webResourceReleased(JSON.parse(record.value_json))).map(record => record.id));
    for (const record of records) {
        if (pending.has(record.id)) continue;
        const resource = JSON.parse(record.value_json) as { resourceId: string };
        database.prepare(`DELETE FROM store_records WHERE cid IS NULL AND kind = 'control'
            AND (record_id = ? OR record_id GLOB 'web-resource-operation:*' AND json_extract(value_json,'$.resourceId') = ?)`)
            .run(record.id, resource.resourceId);
        database.prepare(`DELETE FROM server_state WHERE kind = 'control'
            AND (id = ? OR id GLOB 'web-resource-operation:*' AND json_extract(value_json,'$.resourceId') = ?)`)
            .run(record.id, resource.resourceId);
        const outputPrefix = 'web-resource-command-output:' + resource.resourceId + ':';
        database.prepare("DELETE FROM store_records WHERE cid IS NULL AND kind = 'control' AND substr(record_id,1,?) = ?")
            .run(outputPrefix.length, outputPrefix);
        database.prepare("DELETE FROM server_state WHERE kind = 'control' AND substr(id,1,?) = ?")
            .run(outputPrefix.length, outputPrefix);
    }
}

function retentionBlocker(database: SqlDatabase, root: string): string | undefined {
    let familyPolicy: string | undefined;
    let familyOwner: string | undefined;
    for (const members of retentionFamilyPages(database, root)) {
        const placeholders = members.map(() => '?').join(',');
        for (const policy of database.prepare(`SELECT DISTINCT mode,ttl_ms FROM conversations WHERE cid IN (${placeholders})`).all(...members)) {
            const identity = JSON.stringify([policy.mode, policy.ttl_ms]);
            if (familyPolicy !== undefined && familyPolicy !== identity) return 'family_policy_mismatch';
            familyPolicy = identity;
        }
        for (const owner of database.prepare(`SELECT DISTINCT json_extract(value_json,'$.principalId') AS principal FROM store_records WHERE cid IN (${placeholders}) AND kind = 'conversation'`).all(...members)) {
            const identity = String(owner.principal);
            if (familyOwner !== undefined && familyOwner !== identity) return 'family_owner_mismatch';
            familyOwner = identity;
        }
        const blocker = retentionPageBlocker(database, members);
        if (blocker) return blocker;
    }
    return undefined;
}

function retentionPageBlocker(database: SqlDatabase, members: string[]): string | undefined {
    const placeholders = members.map(() => '?').join(',');
    const policies = database.prepare(`SELECT DISTINCT mode,ttl_ms FROM conversations WHERE cid IN (${placeholders})`).all(...members);
    if (policies.length > 1) return 'family_policy_mismatch';
    if (Number(database.prepare(`SELECT COUNT(DISTINCT json_extract(value_json,'$.principalId')) AS total FROM store_records WHERE cid IN (${placeholders}) AND kind = 'conversation'`).get(...members)?.total ?? 0) > 1) return 'family_owner_mismatch';
    if (database.prepare(`SELECT 1 FROM runs WHERE cid IN (${placeholders}) AND (state NOT IN ('succeeded','failed','cancelled') OR cleanup_state NOT IN ('released','not_needed')) LIMIT 1`).get(...members)) return 'run_cleanup_pending';
    if (database.prepare(`SELECT 1 FROM resources WHERE cid IN (${placeholders}) AND state NOT IN ('released','not_needed') LIMIT 1`).get(...members)) return 'resource_cleanup_pending';
    for (const record of webResourceRecords(database, members)) {
        const resource = JSON.parse(record.value_json) as { state?: string; cleanupState?: string;
            receipt?: { released?: boolean; terminalConfirmed?: boolean } };
        if (!webResourceReleased(resource)) return 'web_resource_cleanup_pending';
    }
    if (database.prepare(`SELECT 1 FROM store_records WHERE cid IN (${placeholders}) AND kind = 'conversation'
        AND json_extract(value_json,'$.cleanupState') IN ('pending','running','unconfirmed') LIMIT 1`).get(...members)) return 'conversation_cleanup_pending';
    return undefined;
}

function queueConversationFiles(database: SqlDatabase, conversationId: string): void {
    database.prepare(`INSERT INTO server_state (kind,id,revision,value_json)
        SELECT 'retentionGcObject',objects.hash,1,json_object('sourceConversationId',?,'path',objects.path)
        FROM objects WHERE hash IN (
            SELECT target_id FROM refs WHERE cid = ? AND target_kind = 'object'
            UNION SELECT content_hash FROM workspace_changes WHERE cid = ?
            UNION SELECT content_hash FROM restore_plans WHERE cid = ?
            UNION SELECT object_hash FROM content_items WHERE cid = ?)
        ON CONFLICT(kind,id) DO NOTHING`).run(conversationId, conversationId, conversationId, conversationId, conversationId);
    database.prepare(`INSERT INTO server_state (kind,id,revision,value_json)
        SELECT 'retentionGcSegment',segment_id,1,json_object('sourceConversationId',?,'path',path)
        FROM segments WHERE cid = ? ON CONFLICT(kind,id) DO NOTHING`).run(conversationId, conversationId);
}

function pinRecovery(database: SqlDatabase, conversationId: string, now: string): void {
    database.prepare(`INSERT OR IGNORE INTO refs (cid,owner_kind,owner_id,slot,target_kind,target_id)
        SELECT ?,'retentionRecovery',attempt_id,'object:' || hash,'object',hash FROM (
            SELECT journal.attempt_id,attempt_object_hash AS hash FROM provider_attempt_journal journal JOIN attempts USING(attempt_id) WHERE attempts.cid = ? AND journal.state IN ('dispatching','unknown')
            UNION SELECT journal.attempt_id,snapshot_object_hash FROM provider_attempt_journal journal JOIN attempts USING(attempt_id) WHERE attempts.cid = ? AND journal.state IN ('dispatching','unknown')
            UNION SELECT journal.attempt_id,response_object_hash FROM provider_attempt_journal journal JOIN attempts USING(attempt_id) WHERE attempts.cid = ? AND journal.state IN ('dispatching','unknown')
            UNION SELECT journal.attempt_id,raw_object_hash FROM provider_attempt_journal journal JOIN attempts USING(attempt_id) WHERE attempts.cid = ? AND journal.state IN ('dispatching','unknown')
            UNION SELECT journal.attempt_id,failure_object_hash FROM provider_attempt_journal journal JOIN attempts USING(attempt_id) WHERE attempts.cid = ? AND journal.state IN ('dispatching','unknown')) WHERE hash IS NOT NULL`)
        .run(conversationId, conversationId, conversationId, conversationId, conversationId, conversationId);
    database.prepare(`INSERT OR IGNORE INTO refs (cid,owner_kind,owner_id,slot,target_kind,target_id)
        SELECT cid,'retentionRecovery',action_id,'workspace','object',content_hash FROM workspace_changes WHERE cid = ? AND state IN ('prepared','unknown')`).run(conversationId);
    database.prepare(`INSERT OR IGNORE INTO refs (cid,owner_kind,owner_id,slot,target_kind,target_id)
        SELECT cid,'retentionRecovery',restore_plan_id,'restore','object',content_hash FROM restore_plans
        WHERE cid = ? AND state IN ('committing','pending') AND EXISTS (SELECT 1 FROM workspace_changes WHERE cid = ? AND state IN ('prepared','unknown'))`).run(conversationId, conversationId);
    const unknown = database.prepare("SELECT COUNT(*) AS total FROM attempts JOIN provider_attempt_journal USING(attempt_id) WHERE attempts.cid = ? AND provider_attempt_journal.state IN ('dispatching','unknown')").get(conversationId);
    database.prepare("INSERT INTO server_state (kind,id,revision,value_json) VALUES ('retentionRecovery',?,1,?) ON CONFLICT(kind,id) DO NOTHING")
        .run(conversationId, JSON.stringify({ conversationId, deletedAt: now, financialLedgerRetained: true, unknownProviderAttempts: Number(unknown?.total ?? 0) }));
}

export function purgeExpiredConversation(database: SqlDatabase, conversationId: string, now: string): RetentionSweepConversation {
    const root = database.prepare('SELECT mode,state,expires_at,policy_rev FROM conversations WHERE cid = ?').get(conversationId);
    if (!root) throw new AgentFault('CONVERSATION_NOT_FOUND', '限时清理会话不存在');
    if (retentionRoot(database, conversationId) !== conversationId) throw new AgentFault('RETENTION_TRANSITION_BUSY', '派生会话随父级保存归属统一清理');
    const result: RetentionSweepConversation = { conversationId, policyRevision: Number(root.policy_rev), expiresAt: root.expires_at === null ? null : String(root.expires_at), state: 'deleted', conversationIds: [] };
    if (root.state === 'deleted') return result;
    if (root.mode !== 'ttl' || !root.expires_at || String(root.expires_at) > now) throw new AgentFault('RETENTION_NOT_DUE', '会话尚未到达限时清理时点');
    const blocker = retentionBlocker(database, conversationId);
    if (blocker) return { ...result, state: 'deferred', reason: blocker };
    const checkpoint = database.prepare("SELECT value_json FROM server_state WHERE kind = 'retentionPurgeCursor' AND id = ?").get(conversationId);
    const cursor = checkpoint ? String(JSON.parse(String(checkpoint.value_json)).cursor) : '';
    const children = database.prepare(`${retentionFamilyCte} SELECT cid FROM family WHERE cid <> ? AND cid > ? ORDER BY cid LIMIT 200`)
        .all(conversationId, conversationId, cursor).map(row => String(row.cid));
    const complete = children.length < 200;
    const members = complete ? [...children, conversationId] : children;
    database.exec('BEGIN IMMEDIATE');
    try {
        database.prepare("UPDATE conversations SET state = 'purging' WHERE cid = ?").run(conversationId);
        for (const member of members) {
            queueConversationFiles(database, member);
            pinRecovery(database, member, now);
            removeReleasedWebResources(database, member);
            database.prepare("UPDATE conversations SET state = 'purging' WHERE cid = ?").run(member);
            database.prepare(`DELETE FROM provider_tool_intents WHERE attempt_id IN (SELECT journal.attempt_id FROM provider_attempt_journal journal JOIN attempts USING(attempt_id) WHERE attempts.cid = ? AND journal.state NOT IN ('dispatching','unknown'))`).run(member);
            database.prepare(`DELETE FROM provider_tool_batches WHERE attempt_id IN (SELECT journal.attempt_id FROM provider_attempt_journal journal JOIN attempts USING(attempt_id) WHERE attempts.cid = ? AND journal.state NOT IN ('dispatching','unknown'))`).run(member);
            database.prepare("DELETE FROM provider_attempt_journal WHERE attempt_id IN (SELECT attempt_id FROM attempts WHERE cid = ?) AND state NOT IN ('dispatching','unknown')").run(member);
            for (const table of ['candidates', 'workspace_changes', 'restore_plans', 'content_items', 'items', 'history_rounds', 'search_chunks', 'state_items', 'receipts', 'events', 'resources', 'store_records']) {
                database.prepare(`DELETE FROM ${table} WHERE cid = ?`).run(member);
            }
            database.prepare("DELETE FROM refs WHERE cid = ? AND owner_kind <> 'retentionRecovery'").run(member);
            database.prepare("DELETE FROM manifests WHERE cid = ? AND NOT EXISTS (SELECT 1 FROM refs WHERE target_kind = 'manifest' AND target_id = manifests.manifest_id) AND NOT EXISTS (SELECT 1 FROM candidates WHERE manifest_id = manifests.manifest_id)").run(member);
            database.prepare("DELETE FROM server_state WHERE kind NOT IN ('retentionRecovery','retentionOwner') AND json_extract(value_json,'$.conversationId') = ?").run(member);
            database.prepare('DELETE FROM leases WHERE target_id = ? OR target_id IN (SELECT run_id FROM runs WHERE cid = ?)').run(member, member);
            database.prepare(`UPDATE runs SET active_round_id = NULL,active_step_id = NULL,snapshot_json = json_object('conversationId',cid,'runId',run_id,'rootRunId',root_run_id,'parentRunId',parent_run_id,'runEpoch',run_epoch,'kind',kind,'state',state,'effectState',effect_state,'cleanupState',cleanup_state,'retentionExpired',json('true')) WHERE cid = ?`).run(member);
            database.prepare("UPDATE conversations SET state = 'deleted',active_runs = 0,history_root = NULL,view_root = NULL,version = version + 1 WHERE cid = ?").run(member);
        }
        if (complete) database.prepare("DELETE FROM server_state WHERE kind = 'retentionPurgeCursor' AND id = ?").run(conversationId);
        else database.prepare("INSERT INTO server_state(kind,id,revision,value_json) VALUES('retentionPurgeCursor',?,1,?) ON CONFLICT(kind,id) DO UPDATE SET revision=revision+1,value_json=excluded.value_json")
            .run(conversationId, JSON.stringify({ rootConversationId: conversationId, cursor: children[children.length - 1] }));
        database.exec('COMMIT');
    } catch (error) { database.exec('ROLLBACK'); throw error; }
    return { ...result, conversationIds: members, ...(complete ? {} : { state: 'deferred' as const, reason: 'family_page_pending' }) };
}

const unreferencedObject = `NOT EXISTS (SELECT 1 FROM refs WHERE target_kind = 'object' AND target_id = objects.hash)
    AND NOT EXISTS (SELECT 1 FROM server_refs WHERE target_id = objects.hash)
    AND NOT EXISTS (SELECT 1 FROM object_dependencies WHERE payload_hash = objects.hash)
    AND NOT EXISTS (SELECT 1 FROM content_items WHERE object_hash = objects.hash)
    AND NOT EXISTS (SELECT 1 FROM items WHERE object_hash = objects.hash)
    AND NOT EXISTS (SELECT 1 FROM manifests WHERE object_hash = objects.hash)
    AND NOT EXISTS (SELECT 1 FROM receipts WHERE result_hash = objects.hash)
    AND NOT EXISTS (SELECT 1 FROM events WHERE payload_hash = objects.hash)
    AND NOT EXISTS (SELECT 1 FROM workspace_changes WHERE content_hash = objects.hash)
    AND NOT EXISTS (SELECT 1 FROM restore_plans WHERE content_hash = objects.hash)
    AND NOT EXISTS (SELECT 1 FROM provider_attempt_journal WHERE objects.hash IN (attempt_object_hash,snapshot_object_hash,response_object_hash,raw_object_hash,failure_object_hash))
    AND NOT EXISTS (SELECT 1 FROM provider_tool_intents WHERE object_hash = objects.hash)
    AND NOT EXISTS (SELECT 1 FROM provider_tool_batches WHERE object_hash = objects.hash)`;

function releaseResolvedRecovery(database: SqlDatabase): void {
    const rows = database.prepare(`SELECT DISTINCT attempts.cid FROM attempts JOIN provider_attempt_journal journal USING(attempt_id)
        JOIN conversations USING(cid) WHERE conversations.state = 'deleted' AND journal.state NOT IN ('dispatching','unknown')
        AND EXISTS (SELECT 1 FROM server_state WHERE kind = 'retentionRecovery' AND id = attempts.cid) LIMIT 50`).all();
    for (const row of rows) {
        const conversationId = String(row.cid);
        database.exec('BEGIN IMMEDIATE');
        try {
            queueConversationFiles(database, conversationId);
            pinRecovery(database, conversationId, new Date().toISOString());
            database.prepare(`DELETE FROM refs WHERE cid = ? AND owner_kind = 'retentionRecovery' AND owner_id IN (
                SELECT journal.attempt_id FROM provider_attempt_journal journal JOIN attempts USING(attempt_id) WHERE attempts.cid = ? AND journal.state NOT IN ('dispatching','unknown'))`).run(conversationId, conversationId);
            for (const table of ['provider_tool_intents', 'provider_tool_batches']) database.prepare(`DELETE FROM ${table} WHERE attempt_id IN (
                SELECT journal.attempt_id FROM provider_attempt_journal journal JOIN attempts USING(attempt_id) WHERE attempts.cid = ? AND journal.state NOT IN ('dispatching','unknown'))`).run(conversationId);
            database.prepare("DELETE FROM provider_attempt_journal WHERE attempt_id IN (SELECT attempt_id FROM attempts WHERE cid = ?) AND state NOT IN ('dispatching','unknown')").run(conversationId);
            database.prepare("DELETE FROM refs WHERE cid = ? AND owner_kind <> 'retentionRecovery'").run(conversationId);
            database.exec('COMMIT');
        } catch (error) { database.exec('ROLLBACK'); throw error; }
    }
}

function releaseResolvedWebRecovery(database: SqlDatabase): void {
    const rows = database.prepare(`WITH owned(value_json) AS (
        SELECT value_json FROM store_records WHERE cid IS NULL AND kind = 'control' AND record_id GLOB 'web-resource:*'
        UNION SELECT value_json FROM server_state WHERE kind = 'control' AND id GLOB 'web-resource:*')
        SELECT DISTINCT conversations.cid FROM owned
        JOIN conversations ON conversations.cid = json_extract(owned.value_json,'$.conversationId')
        WHERE json_extract(owned.value_json,'$.adapterId') IN ('web-native-sessions-v1','web-table-artifacts-v1','native.command')
        AND conversations.state = 'deleted' AND json_extract(owned.value_json,'$.state') = 'released'
        AND json_extract(owned.value_json,'$.cleanupState') = 'released'
        AND json_extract(owned.value_json,'$.receipt.released') = 1
        AND json_extract(owned.value_json,'$.receipt.terminalConfirmed') = 1
        ORDER BY conversations.cid LIMIT 50`).all();
    for (const row of rows) {
        database.exec('BEGIN IMMEDIATE');
        try { removeReleasedWebResources(database, String(row.cid)); database.exec('COMMIT'); }
        catch (error) { database.exec('ROLLBACK'); throw error; }
    }
}

export function collectRetentionGarbage(database: SqlDatabase, dataDir: string, maxFiles: number): RetentionGarbageResult {
    releaseResolvedRecovery(database);
    releaseResolvedWebRecovery(database);
    const result: RetentionGarbageResult = { objectsRemoved: 0, segmentsRemoved: 0, bytesRemoved: 0, pending: 0, retained: 0, failures: [] };
    for (let index = 0; index < maxFiles; index++) {
        const now = new Date().toISOString();
        const object = database.prepare(`SELECT objects.hash AS id,objects.path,objects.stored_bytes AS bytes FROM objects JOIN server_state ON server_state.kind = 'retentionGcObject' AND server_state.id = objects.hash WHERE ${unreferencedObject} AND COALESCE(json_extract(server_state.value_json,'$.retryAfter'),'') <= ? LIMIT 1`).get(now);
        const segment = object ? undefined : database.prepare(`SELECT segment_id AS id,path,stored_bytes AS bytes FROM segments JOIN server_state ON server_state.kind = 'retentionGcSegment' AND server_state.id = segments.segment_id WHERE NOT EXISTS (SELECT 1 FROM items WHERE items.segment_id = segments.segment_id) AND NOT EXISTS (SELECT 1 FROM refs WHERE target_kind = 'segment' AND target_id = segments.segment_id) AND COALESCE(json_extract(server_state.value_json,'$.retryAfter'),'') <= ? LIMIT 1`).get(now);
        const row = object ?? segment;
        if (!row) break;
        const kind = object ? 'retentionGcObject' : 'retentionGcSegment';
        const table = object ? 'objects' : 'segments'; const key = object ? 'hash' : 'segment_id';
        const storedPath = String(row.path).replaceAll('\\', '/');
        const valid = object ? /^objects\/[a-f0-9]{2}\/[a-f0-9]{64}(?:\.media-json)?$/.test(storedPath)
            : /^segments\/[a-f0-9]{64}\/[a-f0-9-]+\.sah$/.test(storedPath);
        try {
            if (!valid) throw new AgentFault('STORAGE_SEGMENT_CORRUPT', '回收待办路径不属于托管对象或历史段');
            database.prepare(`UPDATE ${table} SET state = 'gcPending' WHERE ${key} = ?`).run(row.id);
            try { unlinkSync(storagePath(dataDir, String(row.path))); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
            database.exec('BEGIN IMMEDIATE');
            try {
                database.prepare(`DELETE FROM ${table} WHERE ${key} = ?`).run(row.id);
                database.prepare('DELETE FROM server_state WHERE kind = ? AND id = ?').run(kind, row.id);
                database.exec('COMMIT');
            } catch (error) { database.exec('ROLLBACK'); throw error; }
            if (object) result.objectsRemoved++; else result.segmentsRemoved++;
            result.bytesRemoved += Number(row.bytes);
        } catch (error) {
            result.failures.push({ kind, id: String(row.id), code: error instanceof AgentFault ? error.code : (error as NodeJS.ErrnoException).code ?? 'STORAGE_DURABILITY_FAILED' });
            database.prepare("UPDATE server_state SET value_json = json_set(value_json,'$.retryAfter',?) WHERE kind = ? AND id = ?")
                .run(new Date(Date.now() + 30000).toISOString(), kind, row.id);
        }
    }
    database.prepare("DELETE FROM server_state WHERE kind = 'retentionGcObject' AND NOT EXISTS (SELECT 1 FROM objects WHERE hash = server_state.id)").run();
    database.prepare("DELETE FROM server_state WHERE kind = 'retentionGcSegment' AND NOT EXISTS (SELECT 1 FROM segments WHERE segment_id = server_state.id)").run();
    result.pending = Number(database.prepare("SELECT COUNT(*) AS total FROM server_state WHERE kind IN ('retentionGcObject','retentionGcSegment')").get()?.total ?? 0);
    const readyObjects = Number(database.prepare(`SELECT COUNT(*) AS total FROM objects JOIN server_state ON server_state.kind = 'retentionGcObject' AND server_state.id = objects.hash WHERE ${unreferencedObject}`).get()?.total ?? 0);
    const readySegments = Number(database.prepare("SELECT COUNT(*) AS total FROM segments JOIN server_state ON server_state.kind = 'retentionGcSegment' AND server_state.id = segments.segment_id WHERE NOT EXISTS (SELECT 1 FROM items WHERE items.segment_id = segments.segment_id) AND NOT EXISTS (SELECT 1 FROM refs WHERE target_kind = 'segment' AND target_id = segments.segment_id)").get()?.total ?? 0);
    result.retained = Math.max(0, result.pending - readyObjects - readySegments);
    return result;
}

export function sweepRetention(database: SqlDatabase, dataDir: string, options: RetentionSweepOptions = {}): RetentionSweepResult {
    const limit = options.limit ?? 10; const maxFiles = options.maxFiles ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50 || !Number.isSafeInteger(maxFiles) || maxFiles < 1 || maxFiles > 200) throw new AgentFault('INVALID_PARAMS', '限时扫描批量须为1至50，文件回收批量须为1至200');
    const scannedAt = new Date().toISOString();
    const rows = database.prepare(`SELECT cid FROM conversations WHERE mode = 'ttl' AND expires_at <= ? AND state <> 'deleted' AND ${rootRetentionOwner} ORDER BY expires_at,cid LIMIT ?`).all(scannedAt, limit);
    const conversations = rows.map(row => purgeExpiredConversation(database, String(row.cid), scannedAt));
    return { scannedAt, conversations, garbage: collectRetentionGarbage(database, dataDir, maxFiles) };
}
