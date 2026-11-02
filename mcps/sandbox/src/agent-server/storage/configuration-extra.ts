import { createHash } from 'node:crypto';
import { AgentFault, canonicalJson } from '../protocol.js';
import type { ClientIdentity, RpcResult } from '../protocol.js';
import type { ContentWrite, ReceiptKey, StoreKey, StorePort, StoreRecord, StoreTransition } from './port.js';
import { controlKey, requireControl } from '../controller.js';
import type { ControlLease } from '../controller.js';
import type { ConfigurationAuthorization } from '../configuration/contracts.js';

export const configurationHash = (value: unknown): string => createHash('sha256').update(canonicalJson(value)).digest('hex');

export class ConfigurationExtraPort {
    constructor(readonly store: StorePort, private readonly authorization: Pick<ConfigurationAuthorization,
        'authorizeGlobalWrite' | 'authorizeConversationWrite'>) {}

    key(ownerId: string, area: 'settings' | 'instructions', conversationId: string | null = null): StoreKey {
        return { kind: 'control', conversationId, id: `configuration:${area}:${configurationHash(ownerId)}` };
    }

    read<Value>(key: StoreKey): Promise<StoreRecord<Value> | undefined> {
        return this.store.getRecord<Value>(key);
    }

    receiptKey(client: ClientIdentity, clientCommandId: string, conversationId?: string): ReceiptKey {
        return { principalId: client.principalId, clientId: client.clientId, clientCommandId,
            ...(conversationId ? { conversationId } : { serverScope: 'server' }) };
    }

    async replay(client: ClientIdentity, method: string, params: Record<string, unknown>): Promise<RpcResult | undefined> {
        const key = this.receiptKey(client, String(params.clientCommandId), params.conversationId as string | undefined);
        const saved = await this.store.getReceipt(key);
        if (!saved) return undefined;
        if (saved.operationHash !== this.operationHash(method, params)) throw new AgentFault('COMMAND_CONFLICT', '原命令ID已经绑定其它配置操作或参数');
        return saved.result;
    }

    operationHash(method: string, params: Record<string, unknown>): string {
        const { controlLeaseId: discardedLease, controlEpoch: discardedEpoch, ...operation } = params;
        return configurationHash({ method, params: operation });
    }

    async commit<Value>(input: { client: ClientIdentity; method: string; params: Record<string, unknown>;
        previous?: StoreRecord<Value>; key: StoreKey; value?: Value; contents?: ContentWrite[];
        expected?: StoreTransition['expected']; data: unknown }): Promise<RpcResult> {
        const previousRevision = input.previous?.revision ?? 0;
        if (input.params.expectedRevision !== previousRevision) throw new AgentFault('REVISION_CONFLICT', '配置版本已变化，请读取当前版本后重新提交', { revision: previousRevision });
        const conversationId = input.key.conversationId;
        let additionalExpected = input.expected ?? [];
        if (conversationId) {
            const conversation = await this.store.getRecord<{ retention: { mode: string } }>({ conversationId, kind: 'conversation', id: conversationId });
            if (conversation?.value.retention.mode === 'temporary') {
                for (const expected of additionalExpected.filter(entry => entry.key.conversationId !== conversationId)) {
                    const current = await this.store.getRecord(expected.key);
                    if ((current?.revision ?? null) !== expected.revision) throw new AgentFault('REVISION_CONFLICT', '固定正文期间全局来源目录已变化，请重新预览');
                }
                additionalExpected = additionalExpected.filter(entry => entry.key.conversationId === conversationId);
            }
        }
        if (conversationId) await this.authorization.authorizeConversationWrite(input.client, input.params);
        else await this.authorization.authorizeGlobalWrite(input.client, input.params);
        const leaseKey = controlKey(conversationId);
        const control = await this.store.getRecord<ControlLease>(leaseKey);
        requireControl(control, input.params, input.client, Date.now());
        const result: RpcResult = { ok: true, data: input.data, receiptId: String(input.params.clientCommandId) };
        const saved = await this.store.commitTransition({
            expected: [{ key: input.key, revision: input.previous?.revision ?? null },
                { key: leaseKey, revision: control!.revision }, ...additionalExpected],
            ...(input.value === undefined ? {} : { records: [{ key: input.key, revision: previousRevision + 1, value: input.value as Record<string, unknown> }] }),
            contents: input.contents,
            receipt: { key: this.receiptKey(input.client, String(input.params.clientCommandId), input.params.conversationId as string | undefined),
                operationHash: this.operationHash(input.method, input.params), result, createdAt: new Date().toISOString() },
        });
        return saved.receipt?.result ?? result;
    }
}
