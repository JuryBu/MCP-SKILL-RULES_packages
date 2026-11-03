import { randomUUID } from 'node:crypto';
import { AgentFault, canonicalJson } from '../protocol.js';
import type { JsonObject, JsonValue } from '../protocol.js';
import { validatePrice } from '../accounting/usage.js';
import type { PriceEntry } from '../accounting/usage.js';
import { immutableJson, objectValue, stringValue } from '../providers/assemble.js';
import { normalizeCompatibleChatMetadata } from '../providers/compatible-chat.js';
import { normalizeProgrokMetadata } from './progrok.js';
import type { ProviderAdapter, ProviderProfile, ProviderProtocol, SendContext } from '../providers/types.js';
import { requireEvidence, validateEvidence } from './evidence.js';
import type { Evidence, EvidenceScope } from './evidence.js';

export interface ParameterSpec {
    type: 'number' | 'integer' | 'string' | 'boolean' | 'object' | 'array';
    enum?: JsonValue[];
    min?: number;
    max?: number;
    default?: JsonValue;
    required?: boolean;
    wirePath: string;
    outputLimitKind?: 'visible_tokens' | 'all_output_tokens';
    outputLimitSourceRef?: string;
    schema?: JsonObject;
}

export interface ModelEntry {
    modelId: string;
    displayName: string;
    protocol: ProviderProtocol;
    routeId: string | null;
    contextWindow: Evidence<number>;
    maxOutputTokens: Evidence<number>;
    inputModalities: Evidence<string[]>;
    outputModalities: Evidence<string[]>;
    tools: Evidence<boolean>;
    streaming: Evidence<boolean>;
    parameters: Record<string, Evidence<ParameterSpec>>;
    pricing: Evidence<PriceEntry>;
    rawMetadata: JsonObject;
    retired: boolean;
    contextLimitMode?: 'combined' | 'separate';
}

export interface CatalogSnapshot {
    schemaVersion: 1;
    catalogVersion: string;
    profileId: string;
    profileRevision: number;
    observedAt: string;
    expiresAt: string;
    entries: ModelEntry[];
}

export interface CatalogPort {
    read(profileId: string): Promise<CatalogSnapshot | null>;
    publish(snapshot: CatalogSnapshot, expectedVersion: string | null): Promise<void>;
}

export class MemoryCatalogPort implements CatalogPort {
    private readonly catalogs = new Map<string, CatalogSnapshot>();
    async read(profileId: string): Promise<CatalogSnapshot | null> {
        const current = this.catalogs.get(profileId);
        return current ? structuredClone(current) : null;
    }
    async publish(snapshot: CatalogSnapshot, expectedVersion: string | null): Promise<void> {
        if ((this.catalogs.get(snapshot.profileId)?.catalogVersion ?? null) !== expectedVersion) {
            throw new AgentFault('E_CATALOG_CONFLICT', '模型目录已被其他刷新更新');
        }
        this.catalogs.set(snapshot.profileId, immutableJson(snapshot));
    }
}

export function modelScope(profile: ProviderProfile, modelId: string, routeId: string | null): EvidenceScope {
    return { endpoint: profile.baseUrl.replace(/\/+$/, ''), modelId, routeId };
}

export function entryFromMetadata(profile: ProviderProfile, metadata: JsonObject, observedAt: string, expiresAt: string): ModelEntry {
    const modelId = stringValue(metadata.id) ?? stringValue(metadata.name)?.replace(/^models\//, '');
    if (!modelId) throw new AgentFault('E_CATALOG_INCOMPLETE', '模型目录条目缺少精确模型ID');
    const scope = modelScope(profile, modelId, null);
    const base = { source: 'api' as const, sourceRef: profile.baseUrl, observedAt, expiresAt, scope,
        version: `metadata-${observedAt}`, confidence: 'declared' as const };
    const unknown = <Value>(): Evidence<Value> => ({ ...base, value: null, status: 'unknown' });
    const count = (value: JsonValue | undefined): Evidence<number> => typeof value === 'number' && Number.isSafeInteger(value) && value > 0
        ? { ...base, value, status: 'supported' } : unknown<number>();
    const entry: ModelEntry = { modelId, displayName: stringValue(metadata.displayName) ?? modelId, protocol: profile.protocol, routeId: null,
        contextWindow: count(profile.protocol === 'gemini' ? metadata.inputTokenLimit : undefined),
        maxOutputTokens: count(profile.protocol === 'gemini' ? metadata.outputTokenLimit : undefined),
        inputModalities: unknown(), outputModalities: unknown(), tools: unknown(), streaming: unknown(), parameters: {},
        pricing: unknown(), rawMetadata: metadata, retired: false, contextLimitMode: profile.protocol === 'gemini' ? 'separate' : 'combined' };
    if (profile.protocol === 'progrok') return normalizeProgrokMetadata(profile, entry);
    return profile.protocol === 'compatible_chat' ? normalizeCompatibleChatMetadata(entry) : entry;
}

export function validateModelEntry(entry: ModelEntry, profile: ProviderProfile): void {
    if (!entry || typeof entry !== 'object' || typeof entry.modelId !== 'string' || !entry.modelId || entry.protocol !== profile.protocol
        || (entry.routeId !== null && typeof entry.routeId !== 'string') || typeof entry.displayName !== 'string'
        || !objectValue(entry.parameters) || !objectValue(entry.rawMetadata) || typeof entry.retired !== 'boolean') {
        throw new AgentFault('E_MODEL_INVALID', '目录模型缺少有效身份、协议或字段定义');
    }
    const scope = modelScope(profile, entry.modelId, entry.routeId);
    const evidence = [entry.contextWindow, entry.maxOutputTokens, entry.inputModalities, entry.outputModalities,
        entry.tools, entry.streaming, entry.pricing, ...Object.values(entry.parameters)];
    for (const item of evidence) {
        validateEvidence<unknown>(item);
        if (canonicalJson(item.scope) !== canonicalJson(scope)) throw new AgentFault('E_EVIDENCE_SCOPE', '目录条目的证据范围不匹配');
    }
    for (const item of [entry.contextWindow, entry.maxOutputTokens]) {
        if (item.status === 'supported' && (!Number.isSafeInteger(item.value) || Number(item.value) < 1)) throw new AgentFault('E_MODEL_INVALID', '模型限制必须为正整数');
    }
    for (const item of [entry.inputModalities, entry.outputModalities]) {
        if (item.status === 'supported' && (!Array.isArray(item.value) || !item.value.length || item.value.some(value => typeof value !== 'string' || !value))) {
            throw new AgentFault('E_MODEL_INVALID', '模型模态声明必须为非空字符串数组');
        }
    }
    for (const item of [entry.tools, entry.streaming]) if (item.status === 'supported' && typeof item.value !== 'boolean') throw new AgentFault('E_MODEL_INVALID', '模型能力开关必须为布尔值');
    if (entry.pricing.status === 'supported') validatePrice(entry.pricing.value!, Date.parse(entry.pricing.observedAt));
    for (const item of Object.values(entry.parameters)) {
        if (item.status !== 'supported') continue;
        const specification = item.value!;
        if (!objectValue(specification) || !['number', 'integer', 'string', 'boolean', 'object', 'array'].includes(specification.type)
            || typeof specification.wirePath !== 'string' || !specification.wirePath
            || (specification.outputLimitKind !== undefined && !['visible_tokens', 'all_output_tokens'].includes(specification.outputLimitKind))
            || (['object', 'array'].includes(specification.type) && !objectValue(specification.schema))
            || (specification.min !== undefined && !Number.isFinite(specification.min))
            || (specification.max !== undefined && !Number.isFinite(specification.max))
            || (specification.min !== undefined && specification.max !== undefined && specification.min > specification.max)
            || (specification.default !== undefined && !parameterMatches(specification.default, specification))) {
            throw new AgentFault('E_PARAMETER_SCHEMA', '模型参数声明缺少合法类型、范围、默认值或原生路径');
        }
    }
}

export class ModelCatalog {
    private readonly refreshes = new Map<string, Promise<CatalogSnapshot>>();
    constructor(readonly port: CatalogPort, private readonly now: () => number = Date.now) {}

    async get(profileId: string, modelId: string, routeId: string | null = null): Promise<{ catalog: CatalogSnapshot; entry: ModelEntry }> {
        const catalog = await this.port.read(profileId);
        const entry = catalog?.entries.find(item => item.modelId === modelId && item.routeId === routeId);
        if (!catalog || !entry) throw new AgentFault('E_MODEL_NOT_FOUND', '本地模型目录没有该模型及路由');
        return { catalog, entry };
    }

    async list(profileId: string, cursor: string | null = null, limit = 50): Promise<{ catalogVersion: string | null; entries: ModelEntry[]; nextCursor: string | null }> {
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new AgentFault('INVALID_PARAMS', '目录页大小须为1至200');
        const catalog = await this.port.read(profileId);
        const index = cursor === null ? 0 : Number(cursor);
        if (!Number.isSafeInteger(index) || index < 0 || (cursor !== null && String(index) !== cursor)) throw new AgentFault('E_CURSOR_INVALID', '目录游标无效');
        const entries = catalog?.entries.slice(index, index + limit) ?? [];
        return { catalogVersion: catalog?.catalogVersion ?? null, entries, nextCursor: catalog && index + limit < catalog.entries.length ? String(index + limit) : null };
    }

    async declare(profile: ProviderProfile, entry: ModelEntry, expectedCatalogVersion: string | null): Promise<CatalogSnapshot> {
        validateModelEntry(entry, profile);
        const evidence: Evidence<unknown>[] = [entry.contextWindow, entry.maxOutputTokens, entry.inputModalities, entry.outputModalities,
            entry.tools, entry.streaming, entry.pricing, ...Object.values(entry.parameters)];
        const pendingEvidence = [...evidence];
        let checkedEvidence = 0;
        while (pendingEvidence.length) {
            const item = pendingEvidence.pop()!;
            checkedEvidence++;
            if (checkedEvidence > 256) throw new AgentFault('E_CATALOG_LIMIT', '模型声明的证据树超过有界上限');
            validateEvidence(item);
            if (canonicalJson(item.scope) !== canonicalJson(modelScope(profile, entry.modelId, entry.routeId))) throw new AgentFault('E_EVIDENCE_SCOPE', '声明中的证据范围不匹配');
            if (!['manual', 'verified_fixture'].includes(item.source) || item.confidence === 'live_verified') {
                throw new AgentFault('E_DECLARATION_SOURCE', '人工声明仅接受manual或verified_fixture来源，实机验证状态由核心另行核实');
            }
            if (Date.parse(item.expiresAt) <= this.now() || Date.parse(item.observedAt) > this.now()) throw new AgentFault('E_CAPABILITY_UNKNOWN', '人工声明证据已经过期或时间无效');
            if (item.conflicts !== undefined) {
                if (!Array.isArray(item.conflicts)) throw new AgentFault('E_EVIDENCE_INVALID', '冲突证据需要结构化列表');
                pendingEvidence.push(...item.conflicts);
            }
        }
        const previous = await this.port.read(profile.profileId);
        if ((previous?.catalogVersion ?? null) !== expectedCatalogVersion) throw new AgentFault('E_CATALOG_CONFLICT', '模型声明所依据的目录版本已变化');
        const originalEntries = previous?.profileRevision === profile.revision ? previous.entries : (previous?.entries ?? []).map(value => ({ ...value, retired: true }));
        const entries = [...originalEntries.filter(value => value.modelId !== entry.modelId || value.routeId !== entry.routeId), immutableJson(entry)];
        if (entries.length > 10_000 || Buffer.byteLength(canonicalJson(entry)) > 1_048_576) throw new AgentFault('E_CATALOG_LIMIT', '人工模型声明超过有界目录上限');
        const expiresAt = new Date(Math.max(previous ? Date.parse(previous.expiresAt) : 0,
            Math.min(...evidence.map(item => Date.parse(item.expiresAt))))).toISOString();
        const snapshot = immutableJson({ schemaVersion: 1 as const, catalogVersion: randomUUID(), profileId: profile.profileId,
            profileRevision: profile.revision, observedAt: new Date(this.now()).toISOString(), expiresAt, entries });
        await this.port.publish(snapshot, expectedCatalogVersion);
        return snapshot;
    }

    refresh(profile: ProviderProfile, adapter: ProviderAdapter, context: SendContext, options: {
        signal?: AbortSignal; enrich?: (entry: ModelEntry) => ModelEntry;
    } = {}): Promise<CatalogSnapshot> {
        const ongoing = this.refreshes.get(profile.profileId);
        if (ongoing) return ongoing;
        const refresh = this.performRefresh(profile, adapter, context, options).finally(() => this.refreshes.delete(profile.profileId));
        this.refreshes.set(profile.profileId, refresh);
        return refresh;
    }

    private async performRefresh(profile: ProviderProfile, adapter: ProviderAdapter, context: SendContext, options: {
        signal?: AbortSignal; enrich?: (entry: ModelEntry) => ModelEntry;
    }): Promise<CatalogSnapshot> {
        if (!profile.discovery.enabled || adapter.protocol !== profile.protocol) throw new AgentFault('E_DISCOVERY_DISABLED', '此配置未启用对应协议的目录发现');
        const previous = await this.port.read(profile.profileId);
        const observedAt = new Date(this.now()).toISOString();
        const expiresAt = new Date(this.now() + 24 * 60 * 60 * 1000).toISOString();
        const entries: ModelEntry[] = [];
        const seenCursors = new Set<string>();
        let cursor: string | null = null;
        for (let pageIndex = 0; pageIndex < 100; pageIndex++) {
            if (options.signal?.aborted) throw new AgentFault('E_CANCELLED', '目录刷新已取消，旧目录保持有效');
            const page = await adapter.discover(profile, cursor, context, options.signal);
            for (const metadata of page.models) {
                const entry = entryFromMetadata(profile, metadata, observedAt, expiresAt);
                const enriched = options.enrich ? options.enrich(entry) : entry;
                validateModelEntry(enriched, profile);
                if (entries.some(item => item.modelId === enriched.modelId && item.routeId === enriched.routeId)) {
                    throw new AgentFault('E_CATALOG_INCOMPLETE', '分页目录含重复身份，保留旧版');
                }
                entries.push(enriched);
                if (entries.length > 10_000) throw new AgentFault('E_CATALOG_LIMIT', '模型目录超过本次有界刷新上限');
            }
            if (page.complete && page.nextCursor === null) {
                if (options.signal?.aborted) throw new AgentFault('E_CANCELLED', '目录刷新已取消，旧目录保持有效');
                for (const old of previous?.entries ?? []) {
                    if (!entries.some(item => item.modelId === old.modelId && item.routeId === old.routeId)) entries.push({ ...old, retired: true });
                }
                const snapshot = immutableJson({ schemaVersion: 1 as const, catalogVersion: randomUUID(), profileId: profile.profileId,
                    profileRevision: profile.revision, observedAt, expiresAt, entries });
                await this.port.publish(snapshot, previous?.catalogVersion ?? null);
                return snapshot;
            }
            if (page.complete || !page.nextCursor || seenCursors.has(page.nextCursor)) throw new AgentFault('E_CATALOG_INCOMPLETE', '目录分页未完整结束，保留旧版');
            cursor = page.nextCursor;
            seenCursors.add(cursor);
        }
        throw new AgentFault('E_CATALOG_LIMIT', '目录分页超过本次有界刷新上限，保留旧版');
    }
}

function parameterMatches(value: JsonValue, specification: ParameterSpec): boolean {
    if (specification.enum && !specification.enum.some(item => canonicalJson(item) === canonicalJson(value))) return false;
    if (specification.type === 'integer' && !(typeof value === 'number' && Number.isSafeInteger(value))) return false;
    if (specification.type === 'number' && !(typeof value === 'number' && Number.isFinite(value))) return false;
    if (['string', 'boolean'].includes(specification.type) && typeof value !== specification.type) return false;
    if (specification.type === 'object' && !objectValue(value)) return false;
    if (specification.type === 'array' && !Array.isArray(value)) return false;
    if (typeof value === 'number' && ((specification.min !== undefined && value < specification.min) || (specification.max !== undefined && value > specification.max))) return false;
    if (specification.schema && !matchesParameterSchema(value, specification.schema)) return false;
    return true;
}

function matchesParameterSchema(value: JsonValue, schema: JsonObject, depth = 0): boolean {
    if (depth > 32) throw new AgentFault('E_PARAMETER_SCHEMA', '参数schema嵌套超过上限');
    const allowed = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'minimum', 'maximum', 'minItems', 'maxItems', 'minLength', 'maxLength', 'description', 'title']);
    for (const name of Object.keys(schema)) if (!allowed.has(name)) throw new AgentFault('E_PARAMETER_SCHEMA', '该参数schema含尚未实现的约束，需明确转换');
    if (Array.isArray(schema.enum) && !schema.enum.some(item => canonicalJson(item) === canonicalJson(value))) return false;
    if (schema.const !== undefined && canonicalJson(schema.const) !== canonicalJson(value)) return false;
    if (schema.type === 'object') {
        const object = objectValue(value);
        if (!object) return false;
        const properties = objectValue(schema.properties) ?? {};
        if (Array.isArray(schema.required) && schema.required.some(name => typeof name !== 'string' || !Object.hasOwn(object, name))) return false;
        for (const [name, child] of Object.entries(object)) {
            const specification = objectValue(properties[name]);
            if (specification) { if (!matchesParameterSchema(child, specification, depth + 1)) return false; }
            else if (schema.additionalProperties === false) return false;
            else if (objectValue(schema.additionalProperties) && !matchesParameterSchema(child, schema.additionalProperties as JsonObject, depth + 1)) return false;
        }
    } else if (schema.type === 'array') {
        if (!Array.isArray(value) || (typeof schema.minItems === 'number' && value.length < schema.minItems)
            || (typeof schema.maxItems === 'number' && value.length > schema.maxItems)) return false;
        const item = objectValue(schema.items);
        if (item && value.some(child => !matchesParameterSchema(child, item, depth + 1))) return false;
    } else if (schema.type === 'string') {
        if (typeof value !== 'string' || (typeof schema.minLength === 'number' && value.length < schema.minLength)
            || (typeof schema.maxLength === 'number' && value.length > schema.maxLength)) return false;
    } else if (schema.type === 'boolean' && typeof value !== 'boolean') return false;
    else if (schema.type === 'null' && value !== null) return false;
    else if (schema.type === 'number' || schema.type === 'integer') {
        if (typeof value !== 'number' || !Number.isFinite(value) || (schema.type === 'integer' && !Number.isSafeInteger(value))
            || (typeof schema.minimum === 'number' && value < schema.minimum) || (typeof schema.maximum === 'number' && value > schema.maximum)) return false;
    } else if (schema.type !== undefined && !['object', 'array', 'string', 'boolean', 'null', 'number', 'integer'].includes(String(schema.type))) {
        throw new AgentFault('E_PARAMETER_SCHEMA', '该参数schema类型尚未实现');
    }
    return true;
}

const protectedRoots = new Set(['model', 'messages', 'contents', 'input', 'tools', 'stream', 'provider', 'headers', 'systemInstruction', 'cachedContent']);

export function resolveParameters(entry: ModelEntry, profile: ProviderProfile, overrides: JsonObject, now = Date.now()): JsonObject {
    const scope = modelScope(profile, entry.modelId, entry.routeId);
    const values: JsonObject = {};
    for (const [name, evidence] of Object.entries(entry.parameters)) {
        if (evidence.status === 'supported' && evidence.value?.default !== undefined) values[name] = evidence.value.default;
    }
    Object.assign(values, profile.parameterDefaults, overrides);
    const output: JsonObject = {};
    for (const [name, value] of Object.entries(values)) {
        const evidence = entry.parameters[name];
        if (!evidence) throw new AgentFault('E_PARAMETER_UNSUPPORTED', `模型目录没有参数${name}的定义`);
        const specification = requireEvidence(evidence, scope, now);
        if (!['number', 'integer', 'string', 'boolean', 'object', 'array'].includes(specification.type)
            || (['object', 'array'].includes(specification.type) && !specification.schema)) {
            throw new AgentFault('E_PARAMETER_SCHEMA', `参数${name}缺少可核对的完整类型约束`);
        }
        if (!parameterMatches(value, specification)) throw new AgentFault('E_PARAMETER_INVALID', `参数${name}不符合模型目录约束`);
        const path = specification.wirePath.split('.');
        if (!path.length || path.some(part => !/^[A-Za-z][A-Za-z0-9_]*$/.test(part) || ['constructor', 'prototype', '__proto__'].includes(part)) || protectedRoots.has(path[0])) {
            throw new AgentFault('E_PARAMETER_CONFLICT', `参数${name}试图覆盖核心请求字段`);
        }
        let target = output;
        for (const segment of path.slice(0, -1)) {
            if (target[segment] === undefined) target[segment] = {};
            const object = objectValue(target[segment]);
            if (!object) throw new AgentFault('E_PARAMETER_CONFLICT', '参数映射的原生路径发生冲突');
            target = object;
        }
        if (Object.hasOwn(target, path.at(-1)!)) throw new AgentFault('E_PARAMETER_CONFLICT', '多个参数映射到同一个原生字段');
        target[path.at(-1)!] = value;
    }
    for (const [name, evidence] of Object.entries(entry.parameters)) {
        if (evidence.value?.required && values[name] === undefined) throw new AgentFault('E_PARAMETER_INVALID', `缺少模型必需参数${name}`);
    }
    return immutableJson(output);
}

export function resolveRuntimeOutputBudget(entry: ModelEntry, profile: ProviderProfile, requested: number, now = Date.now()): number {
    if (!Number.isSafeInteger(requested) || requested < 1) throw new AgentFault('E_CONTEXT_LIMIT', '运行输出预算须为正安全整数');
    const scope = modelScope(profile, entry.modelId, entry.routeId);
    if (entry.maxOutputTokens.status !== 'unknown') return Math.min(requested, requireEvidence(entry.maxOutputTokens, scope, now));
    const evidence = entry.parameters.maxOutputTokens;
    if (!evidence) throw new AgentFault('E_CAPABILITY_UNKNOWN', '未知模型输出上限需要有效的运行输出参数声明');
    const specification = requireEvidence(evidence, scope, now);
    if (!specification.outputLimitKind || specification.type !== 'integer' || !parameterMatches(requested, specification)) {
        throw new AgentFault('E_CAPABILITY_UNKNOWN', '运行输出参数缺少明确的限制语义或合法整数范围');
    }
    return requested;
}

export function validateCapabilities(entry: ModelEntry, profile: ProviderProfile, input: {
    inputModalities: string[]; outputModalities: string[]; usesTools: boolean; inputTokenUpperBound: number;
    maxOutputTokens: number; now?: number;
}): void {
    validateModelEntry(entry, profile);
    if (entry.retired) throw new AgentFault('E_MODEL_RETIRED', '该模型已从当前目录退出，需要重新核实');
    const scope = modelScope(profile, entry.modelId, entry.routeId);
    const now = input.now ?? Date.now();
    const allowedInput = requireEvidence(entry.inputModalities, scope, now);
    const allowedOutput = requireEvidence(entry.outputModalities, scope, now);
    if (input.inputModalities.some(type => !allowedInput.includes(type)) || input.outputModalities.some(type => !allowedOutput.includes(type))) {
        throw new AgentFault('E_MODALITY_UNSUPPORTED', '当前模型没有所需输入或输出模态的有效支持');
    }
    if (input.usesTools && !requireEvidence(entry.tools, scope, now)) throw new AgentFault('E_PARAMETER_UNSUPPORTED', '模型未支持工具调用');
    const context = requireEvidence(entry.contextWindow, scope, now);
    const maximum = resolveRuntimeOutputBudget(entry, profile, input.maxOutputTokens, now);
    if (![input.inputTokenUpperBound, input.maxOutputTokens, context, maximum].every(value => Number.isSafeInteger(value) && value >= 0)
        || input.maxOutputTokens < 1 || input.maxOutputTokens > maximum
        || (entry.contextLimitMode === 'separate' ? input.inputTokenUpperBound > context : input.inputTokenUpperBound + input.maxOutputTokens > context)) {
        throw new AgentFault('E_CONTEXT_LIMIT', '完整请求与最大输出超过已核实的模型限制');
    }
}
