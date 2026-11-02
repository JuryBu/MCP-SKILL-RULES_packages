import { createHash, randomUUID } from 'node:crypto';
import { AgentFault, canonicalJson, failure, operationHash } from './protocol.js';
import type { ClientIdentity, JsonValue, RpcResult } from './protocol.js';
import type { ReceiptKey, StoreKey, StorePort, StoreRecord, StoredReceipt } from './storage/port.js';

interface GlobalCommand extends Record<string, unknown> {
    method: string;
    operationHash: string;
    state: 'executing' | 'completed';
    startedAt: string;
    completedAt: string | null;
}

interface GlobalResult extends Record<string, unknown> {
    totalBytes: number;
    sha256: string;
    chunkBytes: number;
    chunkCount: number;
}

export function globalCommandKey(key: ReceiptKey): StoreKey {
    return { conversationId: null, kind: 'step', id: `service-command:${createHash('sha256').update(canonicalJson(key)).digest('hex')}` };
}

export class GlobalCommands {
    private readonly active = new Map<string, { hash: string; promise: Promise<RpcResult> }>();

    constructor(private readonly store: StorePort) {}

    async inspect(client: ClientIdentity, clientCommandId: string): Promise<JsonValue | undefined> {
        const key: ReceiptKey = { principalId: client.principalId, clientId: client.clientId, serverScope: 'server', clientCommandId };
        const receipt = await this.store.getReceipt(key);
        if (receipt) return { found: true, state: 'completed', result: receipt.result as unknown as JsonValue };
        const recordKey = globalCommandKey(key);
        const record = await this.store.getRecord<GlobalCommand>(recordKey);
        if (!record) return undefined;
        return { found: false, missing: false, accepted: true,
            state: this.active.has(recordKey.id) ? 'executing' : 'outcome_unknown', method: record.value.method,
            startedAt: record.value.startedAt, clientCommandId, mayHaveStarted: true, retryable: false };
    }

    async readResult(client: ClientIdentity, clientCommandId: string, offset = 0, maxBytes = 16 * 1024): Promise<JsonValue> {
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 32 * 1024) {
            throw new AgentFault('INVALID_PARAMS', '结果读取范围须为非负偏移与最多32768字节');
        }
        const key = globalCommandKey({ principalId: client.principalId, clientId: client.clientId, serverScope: 'server', clientCommandId });
        const record = await this.store.getRecord<GlobalResult>({ ...key, id: `${key.id}:result` });
        if (!record) throw new AgentFault('NOT_FOUND', '原命令没有分片结果');
        const metadata = record.value;
        if (offset > metadata.totalBytes) throw new AgentFault('INVALID_PARAMS', '结果偏移超过原始长度');
        const next = Math.min(metadata.totalBytes, offset + maxBytes);
        const selected: Buffer[] = [];
        for (let index = Math.floor(offset / metadata.chunkBytes); index * metadata.chunkBytes < next; index++) {
            const chunk = await this.store.getRecord<{ dataBase64: string }>({ ...key, id: `${key.id}:result:${index}` });
            if (!chunk) throw new AgentFault('STORAGE_UNAVAILABLE', '原命令结果分片缺失');
            const bytes = Buffer.from(chunk.value.dataBase64, 'base64');
            selected.push(bytes.subarray(Math.max(0, offset - index * metadata.chunkBytes), Math.min(bytes.length, next - index * metadata.chunkBytes)));
        }
        return { clientCommandId, mime: 'application/json', offset, totalBytes: metadata.totalBytes,
            sha256: metadata.sha256, dataBase64: Buffer.concat(selected).toString('base64'),
            nextOffset: next < metadata.totalBytes ? next : null, complete: next === metadata.totalBytes };
    }

    async execute(method: string, params: Record<string, unknown>, client: ClientIdentity,
        operation: () => Promise<RpcResult>): Promise<RpcResult> {
        const key: ReceiptKey = { principalId: client.principalId, clientId: client.clientId,
            serverScope: 'server', clientCommandId: String(params.clientCommandId) };
        const recordKey = globalCommandKey(key);
        const identity = recordKey.id;
        const hash = operationHash(method, params);
        const running = this.active.get(identity);
        if (running) {
            if (running.hash !== hash) throw new AgentFault('COMMAND_CONFLICT', '同一全局命令ID已有其它方法或参数');
            return running.promise;
        }
        const promise = this.perform(method, key, recordKey, hash, operation);
        this.active.set(identity, { hash, promise });
        try { return await promise; }
        finally { if (this.active.get(identity)?.promise === promise) this.active.delete(identity); }
    }

    private async perform(method: string, key: ReceiptKey, recordKey: StoreKey, hash: string,
        operation: () => Promise<RpcResult>): Promise<RpcResult> {
        const receipt = await this.store.getReceipt(key);
        if (receipt) {
            if (receipt.operationHash !== hash) throw new AgentFault('COMMAND_CONFLICT', '原全局命令已经用于其它方法或参数');
            return receipt.result;
        }
        const previous = await this.store.getRecord<GlobalCommand>(recordKey);
        if (previous) {
            if (previous.value.operationHash !== hash) throw new AgentFault('COMMAND_CONFLICT', '原全局命令的参数已经固定');
            throw new AgentFault('GLOBAL_COMMAND_OUTCOME_UNKNOWN', '原全局命令尚无最终回执，请核对对应配置或目录的实际状态',
                { method, clientCommandId: key.clientCommandId, recoveryMethod: 'server.getReceipt' }, true);
        }
        const started: StoreRecord<GlobalCommand> = { key: recordKey, revision: 1, value: { method,
            operationHash: hash, state: 'executing', startedAt: new Date().toISOString(), completedAt: null } };
        await this.store.commitTransition({ expected: [{ key: recordKey, revision: null }], records: [started] });
        let result: RpcResult;
        try { result = await operation(); }
        catch (error) { result = failure(error); }
        const completedAt = new Date().toISOString();
        let final: RpcResult = { ...result, receiptId: result.receiptId ?? randomUUID() };
        const json = canonicalJson(final);
        const resultRecords: StoreRecord[] = [];
        if (Buffer.byteLength(json) > 60 * 1024) {
            const bytes = Buffer.from(json, 'utf8');
            const chunkBytes = 24 * 1024;
            const metadata: GlobalResult = { totalBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
                chunkBytes, chunkCount: Math.ceil(bytes.length / chunkBytes) };
            const reference = { resultStored: true, clientCommandId: key.clientCommandId, totalBytes: metadata.totalBytes,
                sha256: metadata.sha256, readMethod: 'server.readCommandResult' };
            resultRecords.push({ key: { ...recordKey, id: `${recordKey.id}:result` }, revision: 1, value: metadata });
            for (let index = 0; index < metadata.chunkCount; index++) resultRecords.push({
                key: { ...recordKey, id: `${recordKey.id}:result:${index}` }, revision: 1,
                value: { dataBase64: bytes.subarray(index * chunkBytes, (index + 1) * chunkBytes).toString('base64') } });
            final = final.ok ? { ok: true, receiptId: final.receiptId, data: reference }
                : { ok: false, receiptId: final.receiptId, data: reference, error: { code: 'COMMAND_RESULT_STORED',
                    message: '原命令已完成，完整错误结果可从原命令ID分片读取', retryable: false, mayHaveStarted: true } };
        }
        const saved: StoredReceipt = { key, operationHash: hash, result: final, createdAt: completedAt };
        await this.store.commitTransition({ expected: [{ key: recordKey, revision: started.revision },
            ...resultRecords.map(record => ({ key: record.key, revision: null }))],
            records: [{ ...started, revision: started.revision + 1, value: { ...started.value, state: 'completed', completedAt } }, ...resultRecords], receipt: saved });
        return final;
    }

    async drain(): Promise<void> {
        await Promise.allSettled([...this.active.values()].map(entry => entry.promise));
    }

    get pendingCount(): number { return this.active.size; }
}
