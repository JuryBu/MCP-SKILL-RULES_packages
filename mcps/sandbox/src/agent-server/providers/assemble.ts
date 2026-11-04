import { createHash, randomUUID } from 'node:crypto';
import { AgentFault, canonicalJson } from '../protocol.js';
import type { JsonObject, JsonValue } from '../protocol.js';
import type { PriceEntry } from '../accounting/usage.js';
import { validatePrice } from '../accounting/usage.js';
import { ProviderFault } from './types.js';
import type { NormalizedResponse, RawProviderResponse } from './types.js';
import type { ProviderAdapter, ProviderAttempt, ProviderProfile, RequestSnapshot, RequestVersions, NativeSendView, NativeBlock, ToolCall, ToolResult } from './types.js';

const ownedRequestSnapshots = new WeakSet<RequestSnapshot>();

export function immutableJson<Value>(value: Value): Value {
    const cloned = JSON.parse(canonicalJson(value)) as Value;
    return freezeOwned(cloned);
}

export function freezeOwned<Value>(cloned: Value): Value {
    const freeze = (entry: unknown): void => {
        if (entry && typeof entry === 'object') {
            for (const child of Object.values(entry)) freeze(child);
            Object.freeze(entry);
        }
    };
    freeze(cloned);
    return cloned;
}

export function sha256(value: string | Uint8Array): string {
    return createHash('sha256').update(value).digest('hex');
}

export function freezeRequest(input: {
    adapter: ProviderAdapter; profile: ProviderProfile; versions: RequestVersions; modelId: string;
    view: NativeSendView; parameters: JsonObject; timeoutMs?: number; deadlineAt: string;
    rootBudgetId?: string;
    pricingSnapshot?: PriceEntry;
    price?: PriceEntry;
    requirePricingSnapshot?: boolean;
    frozenAt?: string;
    stream?: boolean;
}): RequestSnapshot {
    const { adapter, profile, versions, modelId, view } = input;
    if (!versions.runId || !versions.stepId || !versions.actionId || !versions.conversationId
        || !Number.isSafeInteger(versions.runEpoch) || versions.runEpoch < 1) {
        throw new AgentFault('E_REQUEST_IDENTITY', '模型请求缺少有效的执行身份');
    }
    for (const revision of [versions.historyEpoch, versions.appendSeq, versions.viewRevision, versions.workspaceRevision]) {
        if (!Number.isSafeInteger(revision) || revision < 0) throw new AgentFault('E_REQUEST_IDENTITY', '请求版本必须为非负整数');
    }
    if (profile.protocol !== adapter.protocol || view.protocol !== adapter.protocol) {
        throw new AgentFault('E_PROTOCOL_MISMATCH', '发送视图与配置协议不一致');
    }
    if (!Number.isFinite(Date.parse(input.deadlineAt))) throw new AgentFault('E_REQUEST_DEADLINE', '请求必须有有限期限');
    const timeoutMs = input.timeoutMs ?? 900_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new AgentFault('E_REQUEST_DEADLINE', '请求超时必须为正整数');
    const streaming = input.stream ?? view.stream ?? false;
    const encoded = adapter.encode({ ...view, stream: streaming }, modelId, input.parameters);
    if (adapter.protocol === 'openai_responses') encoded.store = profile.remoteRetention === 'allowed';
    if (adapter.protocol === 'compatible_chat' && profile.routePolicy.kind === 'pinned_aggregator') {
        encoded.provider = { only: [profile.routePolicy.provider ?? ''], allow_fallbacks: false, require_parameters: true };
    }
    const body = canonicalJson(encoded);
    if (input.rootBudgetId !== undefined && !input.rootBudgetId) throw new AgentFault('E_REQUEST_IDENTITY', '冻结的根预算身份不能为空');
    if (input.pricingSnapshot && input.price && canonicalJson(input.pricingSnapshot) !== canonicalJson(input.price)) {
        throw new AgentFault('E_PRICE_SCOPE', '冻结价格的新旧字段存在冲突');
    }
    const pricingSnapshot = input.pricingSnapshot ?? input.price;
    if (input.requirePricingSnapshot && !pricingSnapshot) throw new AgentFault('BUDGET_UNBOUNDED', '正式硬预算请求必须冻结完整价格');
    if (pricingSnapshot && pricingSnapshot.priceVersion !== versions.priceVersion) throw new AgentFault('E_PRICE_SCOPE', '冻结价格内容与版本标记不同');
    if (input.frozenAt !== undefined && !Number.isFinite(Date.parse(input.frozenAt))) throw new AgentFault('E_REQUEST_IDENTITY', '冻结时间必须为有效ISO时间');
    const frozenAt = input.frozenAt ?? new Date().toISOString();
    if (pricingSnapshot) validatePrice(pricingSnapshot, Date.parse(frozenAt));
    const fixed = { schemaVersion: 1 as const, ...versions, ...(input.rootBudgetId ? { rootBudgetId: input.rootBudgetId } : {}),
        frozenAt, ...(pricingSnapshot ? { pricingSnapshot } : {}),
        profile, profileRevision: profile.revision,
        credentialGeneration: profile.credentialGeneration, routePolicyVersion: profile.routePolicy.version, modelId,
        effectiveParameters: input.parameters, adapterVersion: adapter.version, serializerVersion: 'canonical-json-v1' as const,
        ...(streaming ? { streaming: true } : {}),
        endpoint: adapter.endpoint(profile, modelId, streaming), bodyHash: sha256(body), timeoutMs, deadlineAt: input.deadlineAt };
    const owned = { ...immutableJson(fixed), body };
    const fields = { ...owned, snapshotHash: sha256(canonicalJson(owned)) };
    const snapshot = Object.freeze(Object.fromEntries(Object.keys(fields).sort()
        .map(key => [key, fields[key as keyof typeof fields]]))) as unknown as RequestSnapshot;
    adapter.validate(snapshot);
    ownedRequestSnapshots.add(snapshot);
    return snapshot;
}

export function assembleResponse(attemptId: string, raw: RawProviderResponse,
    normalize: (attemptId: string, raw: RawProviderResponse) => NormalizedResponse): NormalizedResponse {
    try { return normalize(attemptId, raw); }
    catch (error) {
        throw new ProviderFault(error instanceof AgentFault ? error.code : 'E_RESPONSE_INVALID', '原生响应无法按当前协议安全组装，原文与费用事实保留',
            { acceptance: 'accepted', rawResponse: raw });
    }
}

export function verifySnapshot(snapshot: RequestSnapshot, adapter: ProviderAdapter): void {
    const { snapshotHash, ...fixed } = snapshot;
    const pricingSnapshot = snapshot.pricingSnapshot ?? snapshot.price;
    if (snapshot.adapterVersion !== adapter.version || snapshot.profile.protocol !== adapter.protocol
        || snapshot.bodyHash !== sha256(snapshot.body) || snapshotHash !== sha256(canonicalJson(fixed))
        || snapshot.endpoint !== adapter.endpoint(snapshot.profile, snapshot.modelId, snapshot.streaming === true)
        || snapshot.profileRevision !== snapshot.profile.revision
        || snapshot.credentialGeneration !== snapshot.profile.credentialGeneration
        || snapshot.routePolicyVersion !== snapshot.profile.routePolicy.version
        || (pricingSnapshot && pricingSnapshot.priceVersion !== snapshot.priceVersion)
        || (snapshot.pricingSnapshot && snapshot.price && canonicalJson(snapshot.pricingSnapshot) !== canonicalJson(snapshot.price))) {
        throw new AgentFault('E_SNAPSHOT_MISMATCH', '冻结请求的内容或版本已经变化');
    }
}

export function prepareAttempt(snapshot: RequestSnapshot, rootBudgetId: string, attemptId: string = randomUUID()): ProviderAttempt {
    if (!rootBudgetId || !attemptId) throw new AgentFault('E_REQUEST_IDENTITY', '请求必须关联根预算与尝试身份');
    if (snapshot.rootBudgetId !== undefined && snapshot.rootBudgetId !== rootBudgetId) throw new AgentFault('E_BUDGET_CONFLICT', '尝试不能改用冻结快照以外的根预算');
    const fields = immutableJson({ attemptId, rootBudgetId, createdAt: new Date().toISOString() });
    const owned = ownedRequestSnapshots.has(snapshot) ? snapshot : immutableJson(snapshot);
    const attempt = Object.freeze({ ...fields, snapshot: owned });
    ownedRequestSnapshots.add(owned);
    return attempt;
}

export function objectValue(value: unknown): JsonObject | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null;
}

export function arrayObjects(value: unknown): JsonObject[] {
    return Array.isArray(value) ? value.map(objectValue).filter((entry): entry is JsonObject => entry !== null) : [];
}

export function stringValue(value: unknown): string | null {
    return typeof value === 'string' ? value : null;
}

export function checkToolResults(calls: ToolCall[], results: ToolResult[]): void {
    if (calls.length !== results.length || new Set(results.map(result => result.callId)).size !== results.length) {
        throw new AgentFault('E_TOOL_PAIRING', '工具结果必须与本步的全部调用一一对应');
    }
    for (const call of calls) {
        if (!results.some(result => result.callId === call.callId && result.name === call.name)) {
            throw new AgentFault('E_TOOL_PAIRING', '工具结果的调用身份或名称不匹配');
        }
    }
}

export function requireRoute(snapshot: RequestSnapshot): void {
    const policy = snapshot.profile.routePolicy;
    if (policy.allowFallbacks !== false || !policy.evidenceRef || !policy.allowedModels.includes(snapshot.modelId)) {
        throw new AgentFault('E_ROUTE_UNVERIFIED', '模型路由缺少固定模型及禁止回退的有效配置');
    }
    if (policy.kind === 'pinned_aggregator' && (!policy.provider || policy.requireParameters !== true)) {
        throw new AgentFault('E_ROUTE_UNVERIFIED', '聚合路由必须固定供应商并要求参数完整支持');
    }
}

export function validateTools(view: NativeSendView): void {
    const names = new Set<string>();
    for (const tool of view.tools ?? []) {
        if (!/^[a-zA-Z0-9_-]{1,128}$/.test(tool.name) || names.has(tool.name) || !objectValue(tool.parameters)) {
            throw new AgentFault('E_TOOL_SCHEMA', '工具名称或参数定义无效');
        }
        names.add(tool.name);
    }
}

export function parseArguments(value: JsonValue | undefined): JsonObject | null {
    if (typeof value !== 'string') return objectValue(value);
    try { return objectValue(JSON.parse(value)); } catch { return null; }
}

export function mediaBlock(part: JsonObject, input: {
    index: number; candidateIndex: number; nativeRef: string; mime: string; dataBase64?: string; uri?: string;
}): NativeBlock {
    const type = input.mime.startsWith('image/') ? 'image' : input.mime.startsWith('audio/') ? 'audio'
        : input.mime.startsWith('video/') ? 'video' : 'file';
    const block: NativeBlock = { ...input, type, native: part, materialization: input.dataBase64 !== undefined ? 'inline' : 'remote_pending' };
    if (input.dataBase64 !== undefined) {
        const encoded = input.dataBase64;
        if (!encoded || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 === 1) {
            throw new AgentFault('E_MEDIA_INVALID', '供应商媒体块不是有效Base64');
        }
        const bytes = Buffer.from(encoded, 'base64');
        if (bytes.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) {
            throw new AgentFault('E_MEDIA_INVALID', '供应商媒体块的Base64编码不完整');
        }
        block.byteLength = bytes.byteLength;
        block.sha256 = sha256(bytes);
    }
    const signature = stringValue(part.thoughtSignature ?? part.thought_signature);
    if (signature) block.thoughtSignature = signature;
    return block;
}

export function gateDeclaredTools(response: import('./types.js').NormalizedResponse, names: string[]): import('./types.js').NormalizedResponse {
    if (response.toolCalls.every(call => names.includes(call.name))) return response;
    return freezeOwned({ ...response, canExecuteTools: false, stop: { ...response.stop, kind: 'unknown' },
        problems: [...response.problems, 'E_TOOL_UNDECLARED'] });
}
