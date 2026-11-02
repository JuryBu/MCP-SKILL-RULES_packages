import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AgentFault } from '../protocol.js';
import type { ProviderProfile } from '../providers/types.js';
import type { StoreKey, StorePort, StoreRecord } from '../storage/port.js';
import { parseModelRules, readModelRuleDocument } from './rules.js';
import type { ModelRuleDocument } from './rules.js';

const MAX_RULE_BYTES = 262144;
const rulesSource = z.enum(['task', 'api_global']);
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const pinBase = {
    schemaVersion: z.literal(1), kind: z.literal('delegation_rules_pin'),
    conversationId: z.string().min(1).max(256), runId: z.string().min(1).max(256),
    principalId: z.string().min(1).max(256), profileId: z.string().min(1).max(256),
    profileRevision: z.number().int().positive(), pinnedRunEpoch: z.number().int().positive(),
    pinnedAt: z.string().datetime(),
};
const readySchema = z.object({ ...pinBase, state: z.literal('ready'), source: rulesSource,
    rulesVersion: z.literal('sandbox-agent-model-rules/v1'), sourceId: z.string().min(1).max(32768),
    revision: hashSchema, hash: hashSchema, rawBytes: z.number().int().min(1).max(MAX_RULE_BYTES),
    contentId: z.string().min(1).max(1024) }).strict();
const unavailableSchema = z.object({ ...pinBase, state: z.literal('unavailable'),
    source: rulesSource.nullable(), code: z.enum(['MODEL_RULES_REQUIRED', 'MODEL_RULES_INVALID']),
    message: z.string().min(1).max(512) }).strict();
const pinSchema = z.discriminatedUnion('state', [readySchema, unavailableSchema]);

export type DelegationRulesPin = z.infer<typeof pinSchema>;
export type ReadyDelegationRulesPin = z.infer<typeof readySchema>;

export interface RuleSnapshotContext {
    conversationId: string;
    runId: string;
    principalId: string;
    runEpoch: number;
    signal?: AbortSignal;
    assertCurrent?(): void | Promise<void>;
}

export interface RuleSnapshotSelection {
    profile: Pick<ProviderProfile, 'profileId' | 'revision'>;
    taskModelRulesRef?: unknown;
    globalModelRulesRef: string | null;
}

export interface FrozenDelegationRules {
    source: 'task' | 'api_global';
    document: ModelRuleDocument;
}

function pinKey(context: RuleSnapshotContext): StoreKey {
    return { conversationId: context.conversationId, kind: 'control', id: `delegation-rules:${context.runId}` };
}

function invalidPin(): AgentFault {
    return new AgentFault('MODEL_RULES_PIN_INVALID', '本次运行的固定模型规则缺失或与所属运行不一致');
}

async function boundRecords(store: StorePort, context: RuleSnapshotContext): Promise<{
    conversation: StoreRecord; run: StoreRecord;
}> {
    context.signal?.throwIfAborted();
    await context.assertCurrent?.();
    const [conversation, run] = await Promise.all([
        store.getRecord({ conversationId: context.conversationId, kind: 'conversation', id: context.conversationId }),
        store.getRecord({ conversationId: context.conversationId, kind: 'run', id: context.runId }),
    ]);
    if (!conversation || !run || conversation.value.principalId !== context.principalId
        || conversation.value.conversationId !== context.conversationId || run.value.conversationId !== context.conversationId
        || run.value.runId !== context.runId || run.value.runEpoch !== context.runEpoch) throw invalidPin();
    return { conversation, run };
}

function decodePin(value: unknown, context: RuleSnapshotContext): DelegationRulesPin {
    const result = pinSchema.safeParse(value);
    if (!result.success || result.data.conversationId !== context.conversationId || result.data.runId !== context.runId
        || result.data.principalId !== context.principalId) throw invalidPin();
    return result.data;
}

async function readReady(store: StorePort, pin: ReadyDelegationRulesPin): Promise<FrozenDelegationRules> {
    const value = await store.readContent(pin.conversationId, pin.contentId);
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.kind !== 'delegation_rules_snapshot'
        || value.schemaVersion !== 1 || value.conversationId !== pin.conversationId || value.runId !== pin.runId
        || value.principalId !== pin.principalId || value.profileId !== pin.profileId || value.profileRevision !== pin.profileRevision
        || value.source !== pin.source || value.sourceId !== pin.sourceId || value.revision !== pin.revision
        || value.hash !== pin.hash || value.rulesVersion !== pin.rulesVersion || value.pinnedAt !== pin.pinnedAt
        || value.rawBytes !== pin.rawBytes || typeof value.text !== 'string'
        || Buffer.byteLength(value.text, 'utf8') !== pin.rawBytes
        || createHash('sha256').update(value.text).digest('hex') !== pin.hash || pin.revision !== pin.hash) throw invalidPin();
    const document = { sourceId: pin.sourceId, revision: pin.revision, text: value.text };
    parseModelRules(document, pin.source);
    return { source: pin.source, document };
}

export async function readPinnedDelegationRules(store: StorePort, context: RuleSnapshotContext): Promise<
    FrozenDelegationRules & { pin: ReadyDelegationRulesPin }
> {
    await boundRecords(store, context);
    const record = await store.getRecord(pinKey(context));
    if (!record) throw new AgentFault('MODEL_RULES_PIN_REQUIRED', '本次运行开始前尚未固定模型规则，内部派发未启动');
    const pin = decodePin(record.value, context);
    if (pin.state === 'unavailable') throw new AgentFault(pin.code, pin.message, { runId: pin.runId, pinnedAt: pin.pinnedAt });
    const frozen = await readReady(store, pin);
    await boundRecords(store, context);
    return { ...frozen, pin };
}

export async function pinDelegationRules(store: StorePort, context: RuleSnapshotContext,
    selection: RuleSnapshotSelection): Promise<DelegationRulesPin> {
    const key = pinKey(context);
    let prepared: { pin: DelegationRulesPin; text?: string } | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
        const { conversation, run } = await boundRecords(store, context);
        const existing = await store.getRecord(key);
        if (existing) {
            const pin = decodePin(existing.value, context);
            if (pin.state === 'ready') await readReady(store, pin);
            return pin;
        }
        const expected = [{ key: conversation.key, revision: conversation.revision }, { key: run.key, revision: run.revision }, { key, revision: null as number | null }];
        let firstPreparedInput = run.value.activeStepId == null;
        let recordedStep = false;
        if (typeof run.value.activeStepId === 'string') {
            const stepKey: StoreKey = { conversationId: context.conversationId, kind: 'step', id: run.value.activeStepId };
            const [step, input] = await Promise.all([store.getRecord(stepKey), typeof run.value.activeInputId === 'string'
                ? store.getRecord({ conversationId: context.conversationId, kind: 'input', id: run.value.activeInputId }) : undefined]);
            recordedStep = Boolean(step);
            firstPreparedInput = !step && Boolean(input && input.value.runId === context.runId && input.value.state === 'consumed'
                && input.value.roundId === run.value.activeRoundId && input.value.consumedAtStepId === run.value.activeStepId);
            expected.push({ key: stepKey, revision: step?.revision ?? null });
            if (input) expected.push({ key: input.key, revision: input.revision });
        }
        if (!firstPreparedInput || run.value.lastSuccessfulAttemptId != null || run.value.hasCommittedEffects === true
            || run.value.failure != null || !['queued', 'running'].includes(String(run.value.state))) {
            throw new AgentFault('MODEL_RULES_PIN_REQUIRED', '本次运行缺少首请求之前固定的模型规则，请用新运行采用当前规则',
                { runId: context.runId, state: run.value.state, firstPreparedInput, recordedStep });
        }
        if (!prepared) {
            const base = { schemaVersion: 1 as const, kind: 'delegation_rules_pin' as const,
                conversationId: context.conversationId, runId: context.runId, principalId: context.principalId,
                profileId: selection.profile.profileId, profileRevision: selection.profile.revision,
                pinnedRunEpoch: context.runEpoch, pinnedAt: new Date().toISOString() };
            const taskRef = selection.taskModelRulesRef;
            const source = taskRef !== undefined && taskRef !== null ? 'task' : selection.globalModelRulesRef !== null ? 'api_global' : null;
            const ref = source === 'task' ? taskRef : selection.globalModelRulesRef;
            try {
                if (source === null) throw new AgentFault('MODEL_RULES_REQUIRED', '需要明确的本次模型规则或API全局模型规则');
                if (typeof ref !== 'string' || !ref || Buffer.byteLength(ref, 'utf8') > 32768) {
                    throw new AgentFault('MODEL_RULES_INVALID', '模型规则引用须为明确且有界的文件');
                }
                const document = await readModelRuleDocument(ref);
                const rules = parseModelRules(document, source);
                const hash = rules.hash;
                const pin = readySchema.parse({ ...base, state: 'ready', source, rulesVersion: 'sandbox-agent-model-rules/v1',
                    sourceId: document.sourceId, revision: document.revision, hash, rawBytes: Buffer.byteLength(document.text, 'utf8'),
                    contentId: `delegation-rules:${context.runId}:${hash}` });
                prepared = { pin, text: document.text };
            } catch (error) {
                if (!(error instanceof AgentFault) || !['MODEL_RULES_REQUIRED', 'MODEL_RULES_INVALID'].includes(error.code)) throw error;
                prepared = { pin: unavailableSchema.parse({ ...base, state: 'unavailable', source, code: error.code, message: error.message }) };
            }
        }
        context.signal?.throwIfAborted();
        const pin = prepared.pin;
        try {
            await store.commitTransition({ expected, records: [{ key, revision: 1, value: { ...pin } }],
            ...(pin.state === 'ready' ? { contents: [{ conversationId: context.conversationId, contentId: pin.contentId,
                kind: 'delegation_rules_snapshot', indexHistory: false, value: { ...pin, kind: 'delegation_rules_snapshot', text: prepared.text! } }] } : {}) });
            return pin;
        } catch (error) {
            if (!(error instanceof AgentFault) || error.code !== 'REVISION_CONFLICT' || attempt === 2) throw error;
        }
    }
    throw invalidPin();
}
