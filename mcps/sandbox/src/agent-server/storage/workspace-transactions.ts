import { AgentFault, canonicalJson } from '../protocol.js';
import { randomUUID } from 'node:crypto';
import { pathIdentity } from '../security/policy.js';
import type { ApprovalTicket } from '../security/approvals.js';
import type { ApprovalQuery } from '../security/approvals.js';
import { assertPendingTransition, summarizePending, TERMINAL_PENDING_STATES } from '../tools/pending-types.js';
import type { FrozenToolInvocation, PendingToolRecord, PendingToolQuery, PendingToolSummary } from '../tools/pending-types.js';
import type { FileCommitReceipt } from '../workspace/versions.js';
import { fileOperationPaths, validateFileOperationPrepared, validateFileOperationReceipt } from '../workspace/file-operations.js';
import type { FileOperationChange } from '../workspace/file-operations.js';
import type { SqlDatabase, SqlRow } from './internal.js';
import { ObjectFiles, sha256 } from './objects.js';
import type { PreparedObject } from './objects.js';
import { storeKey } from './port.js';
import { approvalStorageId, decodeChangeAction } from './workspace-port.js';
import type { ApprovalSnapshotEntry, ApprovalVersion, StoredRestorePlan, WireChangeAction, WorkspaceCommand, WorkspaceMutationResult,
    WorkspaceQuery, WorkspaceReadResult } from './workspace-port.js';
import type { RestoreHistoryCommit } from './workspace-port.js';

const MAX_BYTES = 32 * 1024 * 1024;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_METADATA_BYTES = 64 * 1024;

export class WorkspaceTransactions {
    constructor(private readonly database: SqlDatabase, private readonly files: ObjectFiles) {}

    execute(command: WorkspaceCommand): WorkspaceMutationResult {
        switch (command.type) {
            case 'change.prepare': return { kind: 'change', action: this.prepare(command.action) };
            case 'change.settle': return { kind: 'change', action: this.settle(command) };
            case 'restore.put': return { kind: 'restore', plan: this.putRestore(command.plan, command.expectedRevision) };
            case 'restore.history': return { kind: 'restore_history', receipt: this.commitRestoreHistory(command.input) };
            case 'approval.commit': return this.commitApprovals(command);
            case 'pending.put': return { kind: 'pending', record: this.putPending(command.record, command.expectedRevision) };
            default: throw new AgentFault('INVALID_PARAMS', '未知的工作区事务命令');
        }
    }

    read(query: WorkspaceQuery): WorkspaceReadResult {
        switch (query.type) {
            case 'change.get': return { kind: 'change', action: this.get(query.conversationId, query.actionId) ?? null };
            case 'change.list': return this.list(query);
            case 'recovery.list': return this.list({ ...query, type: 'change.list', pendingOnly: true });
            case 'workspace.revision': return { kind: 'revision', revision: this.conversation(query.conversationId).workspaceRevision };
            case 'restore.get': return { kind: 'restore', plan: this.getRestore(query.restorePlanId) ?? null };
            case 'pending.get': return { kind: 'pending', record: this.getPending(query.pendingToolId) ?? null };
            case 'pending.list': return this.listPending(query.query);
            case 'approval.list': return this.listApprovals(query.query);
            case 'approval.snapshot': {
                if (query.tickets.length + query.receipts.length > 64) throw new AgentFault('STORAGE_WORKSPACE_LIMIT', '批准快照一次最多64项');
                return { kind: 'approval_snapshot', entries: [...query.tickets.map(key => this.approvalEntry('ticket', key)),
                    ...query.receipts.map(key => this.approvalEntry('receipt', key))] };
            }
            default: throw new AgentFault('INVALID_PARAMS', '未知的工作区读取命令');
        }
    }

    private page(query: { cursor?: string; limit?: number }): { offset: number; limit: number } {
        const offset = query.cursor ? Number(query.cursor) : 0;
        const limit = query.limit ?? 24;
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new AgentFault('INVALID_PARAMS', '等待项分页参数无效');
        return { offset, limit };
    }

    private listApprovals(query: ApprovalQuery): Extract<WorkspaceReadResult, { kind: 'approval_list' }> {
        const { offset, limit } = this.page(query);
        if (this.conversation(query.conversationId).value.principalId !== query.principalId) throw new AgentFault('TOOL_NOT_ALLOWED', '批准列表未绑定该会话主体');
        const runClause = query.runId ? " AND json_extract(value_json,'$.runId') = ?" : '';
        const rows = this.database.prepare(`SELECT value_json FROM server_state WHERE kind = ? AND json_extract(value_json,'$.conversationId') = ? AND json_extract(value_json,'$.principalId') = ?${runClause} ORDER BY id LIMIT ? OFFSET ?`)
            .all('workspaceApprovalTicket', query.conversationId, query.principalId, ...(query.runId ? [query.runId] : []), limit + 1, offset);
        return { kind: 'approval_list', tickets: rows.slice(0, limit).map(row => JSON.parse(String(row.value_json)) as ApprovalTicket),
            nextCursor: rows.length > limit ? String(offset + limit) : null };
    }

    private pendingHeader(pendingToolId: string): (PendingToolSummary & { frozenHash: string; stateHash: string }) | undefined {
        const row = this.database.prepare('SELECT revision,value_json FROM server_state WHERE kind = ? AND id = ?').get('workspacePendingTool', pendingToolId);
        if (!row) return undefined;
        const value = JSON.parse(String(row.value_json)) as PendingToolSummary & { frozenHash: string; stateHash: string };
        if (value.pendingToolId !== pendingToolId || value.revision !== Number(row.revision)) throw new AgentFault('STORAGE_SEGMENT_CORRUPT', '原工具等待项索引无效');
        return value;
    }

    private getPending(pendingToolId: string): PendingToolRecord | undefined {
        const header = this.pendingHeader(pendingToolId);
        if (!header) return undefined;
        const state = this.files.read(this.database, header.stateHash) as Omit<PendingToolRecord, 'frozen'> & { frozenHash: string };
        const frozen = this.files.read(this.database, header.frozenHash) as FrozenToolInvocation;
        if (state.pendingToolId !== pendingToolId || state.frozenHash !== header.frozenHash || state.revision !== header.revision
            || state.state !== header.state || frozen.argsHash !== header.argsHash) throw new AgentFault('STORAGE_SEGMENT_CORRUPT', '原工具等待项正文与索引不一致');
        const { frozenHash, ...value } = state;
        return { ...value, frozen };
    }

    private listPending(query: PendingToolQuery): Extract<WorkspaceReadResult, { kind: 'pending_list' }> {
        const { offset, limit } = this.page(query);
        if (this.conversation(query.conversationId).value.principalId !== query.principalId) throw new AgentFault('TOOL_NOT_ALLOWED', '原工具等待项未绑定该会话主体');
        const runClause = query.runId ? " AND json_extract(value_json,'$.runId') = ?" : '';
        const stateClause = query.includeTerminal ? '' : " AND json_extract(value_json,'$.state') IN ('awaiting_approval','executing','cancelling','unknown')";
        const rows = this.database.prepare(`SELECT value_json FROM server_state WHERE kind = ? AND json_extract(value_json,'$.conversationId') = ? AND json_extract(value_json,'$.principalId') = ?${runClause}${stateClause} ORDER BY id LIMIT ? OFFSET ?`)
            .all('workspacePendingTool', query.conversationId, query.principalId, ...(query.runId ? [query.runId] : []), limit + 1, offset);
        const items = rows.slice(0, limit).map(row => {
            const { frozenHash, stateHash, ...summary } = JSON.parse(String(row.value_json));
            return summary as PendingToolSummary;
        });
        return { kind: 'pending_list', items, nextCursor: rows.length > limit ? String(offset + limit) : null };
    }

    private putPending(record: PendingToolRecord, expectedRevision: number | null): PendingToolRecord {
        const frozen = record.frozen;
        const conversation = this.conversation(frozen.conversationId);
        if (frozen.principalId !== conversation.value.principalId || !['archive', 'ttl'].includes(frozen.retention.mode)
            || !record.pendingToolId || !frozen.stepId || !frozen.callId || !frozen.actionId || !frozen.attemptId
            || frozen.argsHash !== sha256(canonicalJson({ name: frozen.name, args: frozen.args }))
            || !Number.isSafeInteger(record.executionEpoch) || record.executionEpoch < frozen.originalRunEpoch
            || !Number.isFinite(Date.parse(record.expiresAt))) throw new AgentFault('INVALID_PARAMS', '原工具等待项身份或冻结参数无效');
        const previous = this.getPending(record.pendingToolId);
        assertPendingTransition(record, previous);
        const next = { ...structuredClone(record), revision: (expectedRevision ?? 0) + 1 };
        if ((previous?.revision ?? null) !== expectedRevision) {
            if (previous && canonicalJson(previous) === canonicalJson(next)) return previous;
            throw new AgentFault('WORKSPACE_CAS_CONFLICT', '原工具等待项版本已变化');
        }
        const prepared = this.files.prepare(frozen, 'pending_tool_origin');
        const { frozen: excluded, ...mutable } = next;
        const state = this.files.prepare({ ...mutable, frozenHash: prepared.hash }, 'pending_tool_state');
        return this.atomic([prepared, state], () => {
            const current = this.pendingHeader(record.pendingToolId);
            if ((current?.revision ?? null) !== expectedRevision) throw new AgentFault('WORKSPACE_CAS_CONFLICT', '原工具等待项版本已变化');
            if (!previous || record.state === 'executing') {
                this.requireLive({ ...frozen, runEpoch: record.executionEpoch });
                const run = this.database.prepare('SELECT deadline_at FROM runs WHERE run_id = ?').get(frozen.runId);
                if (Date.parse(record.expiresAt) <= Date.now() || (run?.deadline_at && Date.parse(String(run.deadline_at)) <= Date.now())) throw new AgentFault('PENDING_TOOL_TIMED_OUT', '原工具动作或根任务已到期');
            }
            if (record.state === 'executing') {
                const ticket = record.approvalId ? this.approvalEntry('ticket', record.approvalId).value as ApprovalTicket | null : null;
                if (!ticket || ticket.pendingToolId !== record.pendingToolId || ticket.closedReason || ticket.decision !== 'approve' || ticket.runEpoch !== record.executionEpoch
                    || ticket.policyRevision !== frozen.policyRevision || ticket.argsHashes[0] !== frozen.argsHash || ticket.actionIds[0] !== frozen.actionId
                    || Date.parse(ticket.expiresAt) <= Date.now() || !record.claimToken) throw new AgentFault('APPROVAL_STALE', '原工具动作尚未取得当前代际的有效批准');
                if (previous?.state === 'executing' && previous.claimToken !== record.claimToken && record.executionEpoch <= previous.executionEpoch) throw new AgentFault('PENDING_TOOL_EXECUTING', '原工具动作仍由已有执行者处理');
            }
            this.database.prepare('INSERT INTO server_state (kind,id,revision,value_json) VALUES (?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET revision=excluded.revision,value_json=excluded.value_json')
                .run('workspacePendingTool', record.pendingToolId, next.revision, this.metadata({ ...summarizePending(next), frozenHash: prepared.hash, stateHash: state.hash }));
            this.reference(frozen.conversationId, 'pendingTool', record.pendingToolId, 'origin', prepared.hash);
            this.reference(frozen.conversationId, 'pendingTool', record.pendingToolId, `state:${next.revision}`, state.hash);
            if (['cancelled', 'timed_out'].includes(record.state)) {
                const row = record.approvalId ? undefined : this.database.prepare("SELECT revision,value_json FROM server_state WHERE kind = ? AND json_extract(value_json,'$.pendingToolId') = ? AND json_extract(value_json,'$.conversationId') = ?")
                    .get('workspaceApprovalTicket', record.pendingToolId, frozen.conversationId);
                const entry = record.approvalId ? this.approvalEntry('ticket', record.approvalId)
                    : row ? { value: JSON.parse(String(row.value_json)), revision: Number(row.revision) } : undefined;
                const ticket = entry?.value as ApprovalTicket | undefined;
                if (ticket && !ticket.closedReason && ticket.pendingToolId === record.pendingToolId) this.putApproval('ticket', ticket.approvalId, (entry!.revision ?? 0) + 1, { ...ticket, closedReason: record.state });
            }
            return next;
        });
    }

    private metadata(value: unknown): string {
        const json = canonicalJson(value);
        if (Buffer.byteLength(json) > MAX_METADATA_BYTES) throw new AgentFault('STORAGE_WORKSPACE_LIMIT', '工作区元数据超过64KiB预算');
        return json;
    }

    private conversation(conversationId: string): { key: string; revision: number; workspaceRevision: number; value: Record<string, unknown>; row: SqlRow } {
        const key = storeKey({ conversationId, kind: 'conversation', id: conversationId });
        const row = this.database.prepare('SELECT revision,value_json FROM store_records WHERE record_key = ?').get(key);
        const header = this.database.prepare('SELECT mode,policy_rev,history_epoch,state,version FROM conversations WHERE cid = ?').get(conversationId);
        if (!row || !header) throw new AgentFault('CONVERSATION_NOT_FOUND', '工作区所属持久会话不存在');
        const value = JSON.parse(String(row.value_json)) as Record<string, unknown>;
        const workspaceRevision = Number(value.workspaceRevision ?? 0);
        if (!Number.isSafeInteger(workspaceRevision) || workspaceRevision < 0) throw new AgentFault('STORAGE_SEGMENT_CORRUPT', '工作区版本记录无效');
        return { key, revision: Number(row.revision), workspaceRevision, value, row: header };
    }

    private requireLive(action: Pick<WireChangeAction, 'conversationId' | 'runId' | 'runEpoch' | 'policyRevision'>): void {
        const conversation = this.conversation(action.conversationId);
        const run = this.database.prepare('SELECT cid,run_epoch,state FROM runs WHERE run_id = ?').get(action.runId);
        if (conversation.row.state !== 'open' || Number(conversation.row.policy_rev) !== action.policyRevision || !run
            || run.cid !== action.conversationId || Number(run.run_epoch) !== action.runEpoch
            || !['running', 'waiting', 'paused', 'recovering'].includes(String(run.state))) {
            throw new AgentFault('POLICY_CHANGED', '工作区动作的执行代际或授权已经变化');
        }
    }

    private get(conversationId: string, actionId: string): WireChangeAction | undefined {
        const row = this.database.prepare('SELECT cid,run_id,state,content_hash FROM workspace_changes WHERE action_id = ?').get(actionId);
        if (!row || row.cid !== conversationId) return undefined;
        const action = this.files.read(this.database, String(row.content_hash)) as WireChangeAction;
        if (action.actionId !== actionId || action.conversationId !== conversationId || action.runId !== row.run_id || action.state !== row.state) {
            throw new AgentFault('STORAGE_SEGMENT_CORRUPT', '修改记录与索引不一致');
        }
        return action;
    }

    private list(query: Extract<WorkspaceQuery, { type: 'change.list' }>): Extract<WorkspaceReadResult, { kind: 'changes' }> {
        const limit = query.limit ?? 24;
        const maxBytes = query.maxBytes ?? MAX_BYTES;
        const offset = query.cursor === undefined ? 0 : Number(query.cursor);
        if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0
            || !Number.isInteger(maxBytes) || maxBytes < 1024 || maxBytes > MAX_BYTES) throw new AgentFault('INVALID_PARAMS', '工作区分页参数无效');
        this.conversation(query.conversationId);
        const clause = query.pendingOnly ? " AND state IN ('prepared','unknown')" : '';
        const rows = this.database.prepare(`SELECT action_id FROM workspace_changes WHERE cid = ?${clause} ORDER BY rowid LIMIT ? OFFSET ?`)
            .all(query.conversationId, limit + 1, offset);
        const actions: WireChangeAction[] = [];
        let bytes = 0;
        for (const row of rows.slice(0, limit)) {
            const action = this.get(query.conversationId, String(row.action_id))!;
            const size = Buffer.byteLength(canonicalJson(action));
            if (bytes + size > maxBytes) {
                if (!actions.length) throw new AgentFault('STORAGE_WORKSPACE_LIMIT', '该动作超过本次分页预算，请按actionId读取');
                break;
            }
            bytes += size;
            actions.push(action);
        }
        return { kind: 'changes', actions, nextCursor: actions.length < rows.length ? String(offset + actions.length) : null };
    }

    private validateAction(action: WireChangeAction): void {
        if (action.state !== 'prepared' || !action.actionId || !action.conversationId || !action.runId || !action.roundId || !action.attemptId
            || !Number.isSafeInteger(action.runEpoch) || action.runEpoch < 1 || !Number.isSafeInteger(action.policyRevision)
            || !/^[a-f0-9]{64}$/.test(action.argsHash) || !/^[a-f0-9]{64}$/.test(action.beforeVersion.versionToken ?? '')) throw new AgentFault('INVALID_PARAMS', 'prepared动作身份或版本无效');
        pathIdentity(action.path);
        if (!['archive', 'ttl'].includes(action.retention.mode)) throw new AgentFault('WORKSPACE_JOURNAL_REQUIRED', '临时修改正文须使用内存工作区记录');
        if (action.retention.mode !== this.conversation(action.conversationId).row.mode) throw new AgentFault('POLICY_CHANGED', '修改记录的保存方式已变化');
        const decode = (text: string) => {
            if (text.length > Math.ceil(MAX_FILE_BYTES / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)) throw new AgentFault('STORAGE_WORKSPACE_LIMIT', '修改字节格式或大小超出预算');
            const bytes = Buffer.from(text, 'base64');
            if (bytes.length > MAX_FILE_BYTES) throw new AgentFault('STORAGE_WORKSPACE_LIMIT', '修改字节超过8MiB');
            return bytes;
        };
        const after = decode(action.afterBase64);
        const before = action.beforeBase64 === null ? null : decode(action.beforeBase64);
        if (validateFileOperationPrepared({ ...action, before, after })) return;
        if (pathIdentity(action.beforeVersion.canonicalPath) !== pathIdentity(action.path)
            || action.beforeVersion.kind !== (action.beforeVersion.exists ? 'file' : 'missing')) throw new AgentFault('VERSION_CONFLICT', 'prepared文件身份与目标路径不一致');
        if (before === null) {
            if (action.beforeVersion.exists || action.beforeVersion.byteLength !== 0 || action.beforeVersion.sha256 !== null) throw new AgentFault('INVALID_PARAMS', '已有文件的修改记录缺少原字节');
        } else {
            if (!action.beforeVersion.exists || before.length !== action.beforeVersion.byteLength || sha256(before) !== action.beforeVersion.sha256) {
                throw new AgentFault('VERSION_CONFLICT', 'prepared原字节与文件版本不一致');
            }
        }
    }

    private pendingPath(conversationId: string, filePath: string): string { return sha256(canonicalJson([conversationId, pathIdentity(filePath)])); }

    private prepare(action: WireChangeAction): WireChangeAction {
        this.validateAction(action);
        const previous = this.get(action.conversationId, action.actionId);
        if (previous) {
            if (previous.argsHash !== action.argsHash || previous.runId !== action.runId || previous.afterBase64 !== action.afterBase64
                || previous.beforeBase64 !== action.beforeBase64 || previous.beforeVersion.versionToken !== action.beforeVersion.versionToken
                || pathIdentity(previous.path) !== pathIdentity(action.path)
                || canonicalJson((previous as unknown as FileOperationChange).fileOperation ?? null)
                    !== canonicalJson((action as unknown as FileOperationChange).fileOperation ?? null)) throw new AgentFault('COMMAND_ID_REUSED', '原修改动作的参数已变化');
            return previous;
        }
        const saved = this.files.prepare(action, 'workspace_change');
        return this.atomic([saved], () => {
            this.requireLive(action);
            const paths = fileOperationPaths(action as unknown as FileOperationChange);
            for (const candidate of paths) {
                const key = this.pendingPath(action.conversationId, candidate);
                const pending = this.database.prepare('SELECT value_json FROM server_state WHERE kind = ? AND id = ?').get('workspacePendingPath', key);
                if (pending) throw new AgentFault('RESTORE_PENDING', '该文件仍有prepared或未知修改，先查询原动作', { actionId: (JSON.parse(String(pending.value_json)) as { actionId: string }).actionId });
            }
            this.database.prepare('INSERT INTO workspace_changes (action_id,cid,run_id,round_id,attempt_id,policy_revision,workspace_revision_before,workspace_revision_after,state,content_hash,version) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
                .run(action.actionId, action.conversationId, action.runId, action.roundId, action.attemptId, action.policyRevision,
                    action.workspaceRevisionBefore, null, 'prepared', saved.hash, 1);
            for (const candidate of paths) this.database.prepare('INSERT INTO server_state (kind,id,revision,value_json) VALUES (?,?,?,?)')
                .run('workspacePendingPath', this.pendingPath(action.conversationId, candidate), 1,
                    this.metadata({ conversationId: action.conversationId, actionId: action.actionId, path: candidate }));
            this.reference(action.conversationId, 'workspaceChange', action.actionId, 'prepared', saved.hash);
            return structuredClone(action);
        });
    }

    private validateReceipt(action: WireChangeAction, receipt: FileCommitReceipt): void {
        if (validateFileOperationReceipt(decodeChangeAction(action), receipt)) return;
        const after = Buffer.from(action.afterBase64, 'base64');
        const creation = action.toolId === 'local.restore_created_file' ? action.restoreCreatedFrom : undefined;
        const expectedAfter = creation
            ? action.beforeVersion.exists && after.length === 0 && action.beforeVersion.sha256 === creation.expectedSha256
                && receipt.restoredCreationActionId === creation.creationActionId
                && receipt.commitMode === 'restore_created_exclusive_delete' && receipt.bytesWritten === 0
                && receipt.afterVersion.exists === false && receipt.afterVersion.kind === 'missing'
                && receipt.afterVersion.sha256 === null && receipt.afterVersion.byteLength === 0
            : receipt.afterVersion.exists === true && receipt.afterVersion.kind === 'file'
                && receipt.afterVersion.sha256 === sha256(after) && receipt.afterVersion.byteLength === after.length;
        if (!receipt.receiptId || receipt.effectState !== 'applied' || receipt.cleanupState !== 'released'
            || pathIdentity(receipt.path) !== pathIdentity(action.path) || receipt.beforeVersion.versionToken !== action.beforeVersion.versionToken
            || !expectedAfter
            || !/^[a-f0-9]{64}$/.test(receipt.afterVersion.versionToken ?? '')) throw new AgentFault('VERSION_CONFLICT', '原生提交回执与prepared字节或版本不一致', undefined, true);
    }

    private settle(command: Extract<WorkspaceCommand, { type: 'change.settle' }>): WireChangeAction {
        const observed = this.database.prepare('SELECT content_hash,version FROM workspace_changes WHERE action_id = ? AND cid = ?').get(command.actionId, command.conversationId);
        const previous = this.get(command.conversationId, command.actionId);
        if (!previous) throw new AgentFault('CHANGE_PREPARE_FAILED', '修改缺少持久prepared记录', undefined, true);
        if (previous.state === 'applied') {
            if (command.receipt && command.receipt.afterVersion.versionToken !== previous.afterVersion?.versionToken) throw new AgentFault('COMMAND_ID_REUSED', '同一动作收到不同提交版本', undefined, true);
            if (command.receipt && (previous as unknown as FileOperationChange).fileOperation
                && (command.receipt.receiptId !== previous.receipt?.receiptId
                    || command.receipt.destinationAfterVersion?.versionToken !== previous.receipt?.destinationAfterVersion?.versionToken)) throw new AgentFault('COMMAND_ID_REUSED', '同一文件操作收到不同两端回执', undefined, true);
            return previous;
        }
        if (command.receipt) this.validateReceipt(previous, command.receipt);
        else if (!command.errorCode) throw new AgentFault('INVALID_PARAMS', '提交结果需要原生回执或明确错误状态');
        const conversation = this.conversation(command.conversationId);
        const next: WireChangeAction = { ...previous, state: command.receipt ? 'applied' : command.unknown ? 'unknown' : 'failed',
            ...(command.receipt ? { receipt: structuredClone(command.receipt), afterVersion: structuredClone(command.receipt.afterVersion),
                workspaceRevisionBefore: conversation.workspaceRevision, workspaceRevisionAfter: conversation.workspaceRevision + 1 }
                : { errorCode: command.errorCode }) };
        const saved = this.files.prepare(next, 'workspace_change');
        return this.atomic([saved], () => {
            const row = this.database.prepare('SELECT content_hash,version FROM workspace_changes WHERE action_id = ? AND cid = ?').get(command.actionId, command.conversationId);
            if (!row || !observed || row.content_hash !== observed.content_hash || Number(row.version) !== Number(observed.version)) throw new AgentFault('WORKSPACE_CAS_CONFLICT', '原修改记录已变化');
            if (command.receipt) this.advanceWorkspace(command.conversationId, conversation.workspaceRevision);
            this.database.prepare('UPDATE workspace_changes SET state = ?,content_hash = ?,workspace_revision_before = ?,workspace_revision_after = ?,version = ? WHERE action_id = ? AND cid = ? AND version = ?')
                .run(next.state, saved.hash, next.workspaceRevisionBefore, next.workspaceRevisionAfter ?? null, Number(row.version) + 1,
                    command.actionId, command.conversationId, Number(row.version));
            if (next.state !== 'unknown') {
                for (const candidate of fileOperationPaths(next as unknown as FileOperationChange)) {
                    const key = this.pendingPath(command.conversationId, candidate);
                    const pending = this.database.prepare('SELECT value_json FROM server_state WHERE kind = ? AND id = ?').get('workspacePendingPath', key);
                    if (pending && (JSON.parse(String(pending.value_json)) as { actionId: string }).actionId === next.actionId) {
                        this.database.prepare('DELETE FROM server_state WHERE kind = ? AND id = ?').run('workspacePendingPath', key);
                    }
                }
            }
            this.reference(next.conversationId, 'workspaceChange', next.actionId, `result:${Number(row.version) + 1}`, saved.hash);
            return next;
        });
    }

    private advanceWorkspace(conversationId: string, expected: number): void {
        const conversation = this.conversation(conversationId);
        if (conversation.workspaceRevision !== expected) throw new AgentFault('WORKSPACE_CAS_CONFLICT', '工作区版本已经变化');
        conversation.value.workspaceRevision = expected + 1;
        conversation.value.updatedAt = new Date().toISOString();
        const changed = this.database.prepare('UPDATE store_records SET revision = ?,value_json = ? WHERE record_key = ? AND revision = ?')
            .run(conversation.revision + 1, this.metadata(conversation.value), conversation.key, conversation.revision);
        if (Number(changed.changes) !== 1) throw new AgentFault('WORKSPACE_CAS_CONFLICT', '会话版本已经变化');
        this.database.prepare('UPDATE conversations SET version = ? WHERE cid = ?').run(conversation.revision + 1, conversationId);
    }

    private getRestore(restorePlanId: string): StoredRestorePlan | undefined {
        const row = this.database.prepare('SELECT content_hash,version,state FROM restore_plans WHERE restore_plan_id = ?').get(restorePlanId);
        if (!row) return undefined;
        const plan = this.files.read(this.database, String(row.content_hash)) as StoredRestorePlan;
        if (plan.restorePlanId !== restorePlanId || plan.revision !== Number(row.version) || plan.state !== row.state) throw new AgentFault('STORAGE_SEGMENT_CORRUPT', '撤回计划与索引不一致');
        return plan;
    }

    private putRestore(plan: StoredRestorePlan, expectedRevision: number | null): StoredRestorePlan {
        if (!plan.restorePlanId || !plan.conversationId || !plan.principalId || !['files_only', 'round_restart'].includes(plan.mode)
            || !['preview', 'committing', 'complete', 'pending'].includes(plan.state) || !Array.isArray(plan.actionIds) || plan.actionIds.length > 1024) throw new AgentFault('INVALID_PARAMS', '撤回计划结构无效');
        const current = this.conversation(plan.conversationId);
        if (plan.principalId !== current.value.principalId) throw new AgentFault('TOOL_NOT_ALLOWED', '撤回计划未绑定该会话的可信主体');
        const original = this.getRestore(plan.restorePlanId);
        const next = { ...structuredClone(plan), revision: (expectedRevision ?? 0) + 1 };
        if ((original?.revision ?? null) !== expectedRevision) {
            if (original && canonicalJson(original) === canonicalJson(next)) return original;
            throw new AgentFault('WORKSPACE_CAS_CONFLICT', '撤回计划版本已变化');
        }
        if (!original && (plan.state !== 'preview' || Number(current.row.history_epoch) !== plan.historyEpoch
            || current.workspaceRevision !== plan.workspaceRevision || Number(current.row.policy_rev) !== plan.policyRevision)) throw new AgentFault('VERSION_CONFLICT', '撤回预览的会话版本已变化');
        if (original && (original.conversationId !== plan.conversationId || original.principalId !== plan.principalId || original.mode !== plan.mode
            || original.historyEpoch !== plan.historyEpoch || original.policyRevision !== plan.policyRevision || canonicalJson(original.actionIds) !== canonicalJson(plan.actionIds))) throw new AgentFault('COMMAND_ID_REUSED', '撤回计划身份或选择范围已变化');
        if (original) {
            const fixedData = (value: StoredRestorePlan) => {
                const { state, results, historyReceipt, commandId, revision, ...fixed } = value.data;
                return canonicalJson(fixed);
            };
            const transitions: Record<string, string[]> = { preview: ['preview', 'committing', 'pending'], committing: ['committing', 'pending', 'complete'],
                pending: ['pending', 'complete'], complete: ['complete'] };
            if (fixedData(original) !== fixedData(plan) || !transitions[original.state].includes(plan.state)
                || (original.data.commandId && original.data.commandId !== plan.data.commandId)) throw new AgentFault('COMMAND_ID_REUSED', '撤回计划的固定内容或提交标识发生变化');
        }
        const saved = this.files.prepare(next, 'workspace_restore_plan');
        return this.atomic([saved], () => {
            const row = this.database.prepare('SELECT version FROM restore_plans WHERE restore_plan_id = ?').get(plan.restorePlanId);
            if ((row ? Number(row.version) : null) !== expectedRevision) throw new AgentFault('WORKSPACE_CAS_CONFLICT', '撤回计划版本已变化');
            if (row) this.database.prepare('UPDATE restore_plans SET state = ?,content_hash = ?,version = ? WHERE restore_plan_id = ? AND version = ?')
                .run(next.state, saved.hash, next.revision, plan.restorePlanId, expectedRevision!);
            else this.database.prepare('INSERT INTO restore_plans (restore_plan_id,cid,mode,history_epoch,workspace_revision,state,content_hash,version) VALUES (?,?,?,?,?,?,?,?)')
                .run(plan.restorePlanId, plan.conversationId, plan.mode, plan.historyEpoch, plan.workspaceRevision, next.state, saved.hash, next.revision);
            this.reference(plan.conversationId, 'workspaceRestore', plan.restorePlanId, `revision:${next.revision}`, saved.hash);
            return next;
        });
    }

    private commitRestoreHistory(input: RestoreHistoryCommit): Record<string, unknown> {
        const plan = this.getRestore(input.restorePlanId);
        if (!plan || plan.conversationId !== input.conversationId || plan.principalId !== input.principalId
            || plan.mode !== input.mode || plan.historyEpoch !== input.expectedHistoryEpoch
            || canonicalJson(plan.actionIds) !== canonicalJson(input.actionIds)) throw new AgentFault('TOOL_NOT_ALLOWED', '历史提交与原恢复预览的身份或范围不同');
        const factKey = storeKey({ conversationId: input.conversationId, kind: 'step', id: `workspace:restore-history:${input.restorePlanId}` });
        const existing = this.database.prepare('SELECT value_json FROM store_records WHERE record_key = ?').get(factKey);
        if (existing) {
            const receipt = JSON.parse(String(existing.value_json)) as Record<string, unknown>;
            if (receipt.workspaceRevision !== input.workspaceRevision || receipt.targetRoundId !== input.targetRoundId
                || canonicalJson(receipt.files) !== canonicalJson(input.files)) throw new AgentFault('COMMAND_ID_REUSED', '原历史回执与本次提交参数不同');
            return receipt;
        }
        if (!['committing', 'pending'].includes(plan.state) || canonicalJson(plan.data.results) !== canonicalJson(input.files)
            || input.files.some(file => !['restored', 'skipped_conflict'].includes(file.status))) throw new AgentFault('RESTORE_PENDING', '恢复文件尚未结清，历史保持原状');
        const conversation = this.conversation(input.conversationId);
        if (conversation.value.principalId !== input.principalId || conversation.row.state !== 'open'
            || Number(conversation.row.history_epoch) !== input.expectedHistoryEpoch || Number(conversation.row.policy_rev) !== input.policyRevision
            || conversation.workspaceRevision !== input.workspaceRevision) throw new AgentFault('VERSION_CONFLICT', '历史提交前会话或工作区版本发生变化');
        const target = input.mode === 'round_restart' ? this.database.prepare("SELECT MIN(seq) AS seq FROM items WHERE cid = ? AND round_id = ? AND history_indexed = 1 AND history_view = 'raw' AND history_effective = 1")
            .get(input.conversationId, input.targetRoundId ?? '') : undefined;
        if (input.mode === 'round_restart' && (!input.targetRoundId || target?.seq === null || target?.seq === undefined)) throw new AgentFault('NOT_FOUND', '目标轮没有可回溯的有效原文');
        const boundary = Number(target?.seq ?? 0);
        const now = new Date().toISOString();
        const inputRows = input.mode === 'round_restart' ? this.database.prepare("SELECT record_key,revision,value_json FROM store_records WHERE cid = ? AND kind = 'input'").all(input.conversationId) : [];
        const rounds = new Set(input.mode === 'round_restart' ? this.database.prepare('SELECT DISTINCT round_id FROM items WHERE cid = ? AND seq >= ? AND history_indexed = 1 AND history_effective = 1')
            .all(input.conversationId, boundary).map(row => String(row.round_id)) : []);
        const resetInputs = inputRows.map(row => ({ row, value: JSON.parse(String(row.value_json)) as Record<string, unknown> }))
            .filter(entry => entry.value.state === 'consumed' && rounds.has(String(entry.value.roundId)));
        const draftContentIds = input.mode === 'round_restart' ? this.database.prepare('SELECT content_id,history_json FROM items WHERE cid = ? AND round_id = ? AND history_indexed = 1 ORDER BY seq')
            .all(input.conversationId, input.targetRoundId ?? '').filter(row => JSON.parse(String(row.history_json)).role === 'user').map(row => row.content_id) : [];
        const receipt: Record<string, unknown> = { restorePlanId: input.restorePlanId, mode: input.mode,
            historyEpoch: input.expectedHistoryEpoch + (input.mode === 'round_restart' ? 1 : 0), workspaceRevision: input.workspaceRevision,
            viewRevision: Number(conversation.value.viewRevision ?? 0) + (input.mode === 'round_restart' ? 1 : 0),
            targetRoundId: input.targetRoundId, draftContentIds, draftInputIds: resetInputs.filter(entry => entry.value.roundId === input.targetRoundId).map(entry => entry.value.inputId),
            unconsumedInputIds: resetInputs.filter(entry => entry.value.roundId !== input.targetRoundId).map(entry => entry.value.inputId),
            queueResumeRequired: input.mode === 'round_restart', files: input.files, committedAt: now };
        this.metadata(receipt);
        return this.atomic([], () => {
            const latest = this.conversation(input.conversationId);
            if (latest.revision !== conversation.revision) throw new AgentFault('WORKSPACE_CAS_CONFLICT', '历史事务提交前会话发生变化');
            if (input.mode === 'round_restart') {
                this.database.prepare("UPDATE items SET history_effective = 0 WHERE cid = ? AND (seq >= ? OR history_view = 'summary')").run(input.conversationId, boundary);
                this.database.prepare("UPDATE candidates SET state = 'discarded',error_code = 'HISTORY_STALE' WHERE cid = ? AND history_epoch = ?")
                    .run(input.conversationId, input.expectedHistoryEpoch);
                const contextRows = this.database.prepare("SELECT record_key,revision,value_json FROM store_records WHERE cid = ? AND kind = 'step'").all(input.conversationId);
                for (const row of contextRows) {
                    const value = JSON.parse(String(row.value_json)) as Record<string, unknown>;
                    if (value.kind === 'context_state') Object.assign(value, { compressionGeneration: randomUUID(), execution: null, candidateId: null,
                        viewContentId: null, checkpoint: null, checkpointContentId: null, historyCheckpoint: null });
                    else if (value.kind === 'context_candidate') Object.assign(value, { state: 'discarded', errorCode: 'HISTORY_STALE' });
                    else continue;
                    this.database.prepare('UPDATE store_records SET revision = ?,value_json = ? WHERE record_key = ? AND revision = ?')
                        .run(Number(row.revision) + 1, this.metadata(value), row.record_key, Number(row.revision));
                    this.database.prepare('UPDATE state_items SET version = ?,state = ? WHERE cid = ? AND kind = ? AND state_id = ?')
                        .run(Number(row.revision) + 1, String(value.state ?? 'ready'), input.conversationId, 'step', (JSON.parse(String(row.record_key)) as string[])[2]);
                }
                for (const { row, value } of resetInputs) {
                    const draft = value.roundId === input.targetRoundId;
                    Object.assign(value, { state: draft ? 'withdrawn' : 'queued', roundId: null, targetRoundId: null, consumedAtStepId: null, restorePlanId: input.restorePlanId });
                    this.database.prepare('UPDATE store_records SET revision = ?,value_json = ? WHERE record_key = ? AND revision = ?')
                        .run(Number(row.revision) + 1, this.metadata(value), row.record_key, Number(row.revision));
                    this.database.prepare('UPDATE state_items SET version = ?,state = ? WHERE cid = ? AND kind = ? AND state_id = ?')
                        .run(Number(row.revision) + 1, String(value.state), input.conversationId, 'input', String(value.inputId));
                }
            }
            const next = { ...conversation.value, historyEpoch: receipt.historyEpoch, viewRevision: receipt.viewRevision,
                lastWorkspaceRestore: receipt, updatedAt: now };
            this.database.prepare('UPDATE store_records SET revision = ?,value_json = ? WHERE record_key = ? AND revision = ?')
                .run(conversation.revision + 1, this.metadata(next), conversation.key, conversation.revision);
            this.database.prepare('UPDATE conversations SET history_epoch = ?,view_revision = ?,version = ? WHERE cid = ?')
                .run(Number(receipt.historyEpoch), Number(receipt.viewRevision), conversation.revision + 1, input.conversationId);
            this.database.prepare('INSERT INTO store_records (record_key,scope_id,cid,kind,record_id,revision,value_json) VALUES (?,?,?,?,?,?,?)')
                .run(factKey, input.conversationId, input.conversationId, 'step', `workspace:restore-history:${input.restorePlanId}`, 1, this.metadata(receipt));
            this.database.prepare('INSERT INTO state_items (cid,kind,state_id,version,state) VALUES (?,?,?,?,?)')
                .run(input.conversationId, 'step', `workspace:restore-history:${input.restorePlanId}`, 1, 'complete');
            return receipt;
        });
    }

    private approvalEntry(kind: 'ticket' | 'receipt', key: string): ApprovalSnapshotEntry {
        if (!key || key.length > MAX_METADATA_BYTES) throw new AgentFault('INVALID_PARAMS', '批准记录标识无效');
        const identity = approvalStorageId(kind, key);
        const row = this.database.prepare('SELECT revision,value_json FROM server_state WHERE kind = ? AND id = ?').get(identity.kind, identity.id);
        if (!row) return { kind, key, revision: null, value: null };
        const value = JSON.parse(String(row.value_json));
        if (kind === 'receipt' && value.key !== key) throw new AgentFault('STORAGE_SEGMENT_CORRUPT', '批准回执标识不一致');
        return { kind, key, revision: Number(row.revision), value: kind === 'receipt' ? { hash: value.hash, value: value.value } : value };
    }

    private validateTicket(ticket: ApprovalTicket, previous?: ApprovalTicket): void {
        const conversation = this.conversation(ticket.conversationId);
        const run = this.database.prepare('SELECT cid,run_epoch,state FROM runs WHERE run_id = ?').get(ticket.runId);
        if (conversation.value.principalId !== ticket.principalId || Number(conversation.row.policy_rev) !== ticket.policyRevision || !run
            || run.cid !== ticket.conversationId || Number(run.run_epoch) !== ticket.runEpoch || ['succeeded', 'failed', 'cancelled'].includes(String(run.state))) throw new AgentFault('APPROVAL_STALE', '批准所属执行或授权已经变化');
        if (!ticket.approvalId || !['pending', 'approve', 'deny'].includes(ticket.decision) || !Number.isFinite(Date.parse(ticket.expiresAt))
            || !Number.isSafeInteger(ticket.maxUses) || !Number.isSafeInteger(ticket.uses) || ticket.maxUses < 1 || ticket.uses < 0 || ticket.uses > ticket.maxUses
            || !ticket.actionIds.length || ticket.actionIds.length > 64 || ticket.actionIds.length !== ticket.argsHashes.length
            || ticket.argsHashes.some(hash => !/^[a-f0-9]{64}$/.test(hash))) throw new AgentFault('INVALID_PARAMS', '批准票据字段无效');
        if (Date.parse(ticket.expiresAt) <= Date.now()) throw new AgentFault('APPROVAL_STALE', '批准票据已过期');
        if (previous) {
            const immutable = (value: ApprovalTicket) => canonicalJson({ ...value, uses: 0, decision: 'pending', runEpoch: 0, pendingToolId: null });
            if (immutable(previous) !== immutable(ticket) || ticket.uses < previous.uses || (previous.decision !== 'pending' && previous.decision !== ticket.decision)) throw new AgentFault('APPROVAL_STALE', '批准票据的身份、范围或已答复决定变化');
        } else if (ticket.decision !== 'pending' || ticket.uses !== 0) throw new AgentFault('INVALID_PARAMS', '新批准票据必须从pending开始');
        if (ticket.pendingToolId) {
            const pending = this.pendingHeader(ticket.pendingToolId);
            if (!pending || pending.conversationId !== ticket.conversationId || pending.principalId !== ticket.principalId || pending.runId !== ticket.runId
                || pending.actionId !== ticket.actionIds[0] || pending.argsHash !== ticket.argsHashes[0] || pending.policyRevision !== ticket.policyRevision
                || TERMINAL_PENDING_STATES.includes(pending.state)) throw new AgentFault('APPROVAL_STALE', '批准票据未绑定可继续的原工具动作');
        }
        if (previous && (previous.runEpoch !== ticket.runEpoch || previous.pendingToolId !== ticket.pendingToolId)) {
            if (!ticket.pendingToolId || (previous.pendingToolId && previous.pendingToolId !== ticket.pendingToolId) || ticket.runEpoch < previous.runEpoch) throw new AgentFault('APPROVAL_STALE', '批准票据的代际转移缺少原动作依据');
        }
    }

    private commitApprovals(command: Extract<WorkspaceCommand, { type: 'approval.commit' }>): Extract<WorkspaceMutationResult, { kind: 'approval' }> {
        if (command.expected.length > 64 || command.tickets.length + command.receipts.length > 64) throw new AgentFault('STORAGE_WORKSPACE_LIMIT', '批准事务一次最多64项');
        const expected = new Map(command.expected.map(entry => [canonicalJson([entry.kind, entry.key]), entry]));
        if (expected.size !== command.expected.length) throw new AgentFault('INVALID_PARAMS', '批准CAS快照存在重复标识');
        const requireExpected = (kind: ApprovalVersion['kind'], key: string) => {
            if (!expected.has(canonicalJson([kind, key]))) throw new AgentFault('INVALID_PARAMS', '批准写入缺少CAS读取版本');
        };
        return this.atomic([], () => {
            for (const entry of command.expected) if (this.approvalEntry(entry.kind, entry.key).revision !== entry.revision) throw new AgentFault('WORKSPACE_CAS_CONFLICT', '批准快照版本已变化');
            const conversations = new Set(command.tickets.map(ticket => ticket.conversationId));
            for (const entry of command.expected) if (entry.kind === 'ticket') {
                const value = this.approvalEntry('ticket', entry.key).value as ApprovalTicket | null;
                if (value) conversations.add(value.conversationId);
            }
            if (command.receipts.length && conversations.size !== 1) throw new AgentFault('INVALID_PARAMS', '批准回执事务须绑定一个明确会话');
            for (const ticket of command.tickets) {
                requireExpected('ticket', ticket.approvalId);
                const previous = this.approvalEntry('ticket', ticket.approvalId);
                this.validateTicket(ticket, previous.value as ApprovalTicket | undefined);
                this.putApproval('ticket', ticket.approvalId, (previous.revision ?? 0) + 1, ticket);
            }
            for (const receipt of command.receipts) {
                if (!/^[a-f0-9]{64}$/.test(receipt.hash)) throw new AgentFault('INVALID_PARAMS', '批准回执参数哈希无效');
                requireExpected('receipt', receipt.key);
                const previous = this.approvalEntry('receipt', receipt.key);
                if (previous.value && canonicalJson(previous.value) !== canonicalJson({ hash: receipt.hash, value: receipt.value })) throw new AgentFault('COMMAND_ID_REUSED', '批准回执的命令标识已用于其他结果');
                this.putApproval('receipt', receipt.key, (previous.revision ?? 0) + 1, { ...receipt, conversationId: [...conversations][0] });
            }
            return { kind: 'approval', committed: true };
        });
    }

    purgeConversationMetadata(conversationId: string): void {
        this.database.prepare("DELETE FROM server_state WHERE kind IN ('workspacePendingPath','workspaceApprovalTicket','workspaceApprovalReceipt','workspacePendingTool') AND json_extract(value_json,'$.conversationId') = ?")
            .run(conversationId);
    }

    private putApproval(kind: 'ticket' | 'receipt', key: string, revision: number, value: unknown): void {
        const identity = approvalStorageId(kind, key);
        this.database.prepare('INSERT INTO server_state (kind,id,revision,value_json) VALUES (?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET revision=excluded.revision,value_json=excluded.value_json')
            .run(identity.kind, identity.id, revision, this.metadata(value));
    }

    private reference(conversationId: string, ownerKind: string, ownerId: string, slot: string, hash: string): void {
        this.database.prepare('INSERT OR IGNORE INTO refs (cid,owner_kind,owner_id,slot,target_kind,target_id) VALUES (?,?,?,?,?,?)')
            .run(conversationId, ownerKind, ownerId, slot, 'object', hash);
    }

    private atomic<Value>(objects: PreparedObject[], operation: () => Value): Value {
        let active = false;
        try {
            this.database.exec('BEGIN IMMEDIATE');
            active = true;
            for (const object of objects) this.files.insert(this.database, object);
            const result = operation();
            this.database.exec('COMMIT');
            active = false;
            return result;
        } catch (error) {
            if (active) {
                try { this.database.exec('ROLLBACK'); }
                catch { throw new AgentFault('STORAGE_COMMIT_UNKNOWN', '工作区事务结果待查询，保留原动作标识', undefined, true); }
            }
            this.files.discardUncommitted(this.database, objects);
            throw error;
        }
    }
}
