import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AgentFault, canonicalJson, operationHash } from '../protocol.js';
import type { ClientIdentity } from '../protocol.js';
import { immutableJson } from '../providers/assemble.js';
import { endpointUrl } from '../providers/http.js';
import type { ProviderProfile, ProviderProtocol } from '../providers/types.js';

const profileSchema = z.object({
    schemaVersion: z.literal(1), profileId: z.string().min(1).max(512), revision: z.number().int().nonnegative(),
    label: z.string().min(1).max(200), protocol: z.enum(['compatible_chat', 'gemini', 'openai_responses', 'anthropic', 'progrok']),
    baseUrl: z.string().min(1).max(8192), credentialRef: z.string().min(1).max(512).nullable(),
    credentialGeneration: z.number().int().nonnegative(), quotaScopeId: z.string().min(1).max(512),
    quotaLimitId: z.string().min(1).max(512).nullable().optional().default(null), defaultModel: z.string().min(1).nullable(),
    routePolicy: z.object({ version: z.string().min(1), kind: z.enum(['direct', 'pinned_aggregator']),
        allowedModels: z.array(z.string().min(1)).max(256), allowedRoutes: z.array(z.string().min(1)).max(256), provider: z.string().min(1).optional(),
        requireParameters: z.boolean().optional(), allowFallbacks: z.literal(false), evidenceRef: z.string().min(1) }).strict(),
    parameterDefaults: z.record(z.unknown()), discovery: z.object({ enabled: z.boolean(), pageSize: z.number().int().min(1).max(1000) }).strict(),
    remoteRetention: z.enum(['disabled', 'allowed']), globalModelRulesRef: z.string().nullable(), compressionModelRef: z.string().nullable(),
    information: z.object({ source: z.string().max(2048).optional(), purpose: z.string().max(2048).optional(),
        notes: z.string().max(8192).optional(), lastTestedAt: z.string().datetime({ offset: true }).nullable().optional(),
        updatedAt: z.string().datetime({ offset: true }).optional() }).strict().optional(),
    dispatchPolicy: z.object({ enabled: z.boolean().optional(), expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
        maxCumulativeCost: z.object({ currency: z.string().regex(/^[A-Z]{3}$/),
            amountMicros: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) }).strict().optional() }).strict().optional(),
}).strict();

export function validateProfile(profile: unknown): ProviderProfile {
    const result = profileSchema.safeParse(profile);
    if (!result.success) throw new AgentFault('E_PROFILE_INVALID', 'API配置字段、版本或类型无效');
    endpointUrl(result.data.baseUrl, '');
    if ((result.data.credentialRef === null) !== (result.data.credentialGeneration === 0)) {
        throw new AgentFault('E_PROFILE_INVALID', '凭据引用与代次必须一致');
    }
    const policy = result.data.routePolicy;
    if (policy.kind === 'pinned_aggregator' && (!policy.provider || policy.requireParameters !== true)) {
        throw new AgentFault('E_ROUTE_UNVERIFIED', '聚合路由必须固定供应商并严格支持参数');
    }
    if (result.data.defaultModel && !policy.allowedModels.includes(result.data.defaultModel)) {
        throw new AgentFault('E_MODEL_CONFLICT', '默认模型未列入已确认的路由范围');
    }
    if (Buffer.byteLength(canonicalJson(result.data)) > 65_536) throw new AgentFault('E_PROFILE_LIMIT', '脱敏API配置超过64KiB');
    return immutableJson(result.data as ProviderProfile);
}

export function newProfile(input: { label: string; protocol: ProviderProtocol; baseUrl: string; modelId?: string; profileId?: string }): ProviderProfile {
    return validateProfile({ schemaVersion: 1, profileId: input.profileId ?? randomUUID(), revision: 0, label: input.label,
        protocol: input.protocol, baseUrl: input.baseUrl, credentialRef: null, credentialGeneration: 0,
        quotaScopeId: `unverified-provider:${input.protocol}`, quotaLimitId: null, defaultModel: input.modelId ?? null,
        routePolicy: { version: randomUUID(), kind: 'direct', allowedModels: input.modelId ? [input.modelId] : [],
            allowedRoutes: [], allowFallbacks: false, evidenceRef: 'manual-profile-selection' }, parameterDefaults: {},
        discovery: { enabled: true, pageSize: 100 }, remoteRetention: 'disabled', globalModelRulesRef: null, compressionModelRef: null });
}

export interface ProfileCommandIdentity {
    principalId: string;
    clientId: string;
    clientCommandId: string;
}

export type ProfileCommand = ProfileCommandIdentity & (
    { type: 'put'; profile: ProviderProfile; expectedRevision: number }
    | { type: 'remove'; profileId: string; expectedRevision: number }
    | { type: 'credential'; profileId: string; expectedRevision: number; credentialRef: string; credentialGeneration: number }
);

export interface ProfileResult { profile: ProviderProfile | null; removed: boolean; replayed: boolean }

export interface ProfileState {
    schemaVersion: 1;
    profiles: Record<string, { versions: ProviderProfile[]; removed: boolean }>;
    receipts: Record<string, { operationHash: string; result: ProfileResult }>;
}

export interface ProfilePort {
    execute(command: ProfileCommand): Promise<ProfileResult>;
    get(profileId: string, revision?: number): Promise<ProviderProfile | null>;
    list(): Promise<ProviderProfile[]>;
}

export function emptyProfileState(): ProfileState { return { schemaVersion: 1, profiles: {}, receipts: {} }; }

export function applyProfileCommand(previous: ProfileState, command: ProfileCommand): { state: ProfileState; result: ProfileResult } {
    if (previous.schemaVersion !== 1) throw new AgentFault('E_SCHEMA_VERSION', 'API配置存储版本不受支持');
    if (!command.principalId || !command.clientId || !command.clientCommandId) throw new AgentFault('E_COMMAND_IDENTITY', '配置命令缺少可信主体及命令身份');
    const receiptId = canonicalJson([command.principalId, command.clientId, 'profiles', command.clientCommandId]);
    const digest = operationHash(`profiles.${command.type}`, { ...command });
    const receipt = previous.receipts[receiptId];
    if (receipt) {
        if (receipt.operationHash !== digest) throw new AgentFault('E_COMMAND_CONFLICT', '同一命令身份已用于不同内容');
        return { state: structuredClone(previous), result: { ...structuredClone(receipt.result), replayed: true } };
    }
    const state = structuredClone(previous);
    const profileId = command.type === 'put' ? command.profile.profileId : command.profileId;
    const entry = state.profiles[JSON.stringify(profileId)];
    const current = entry?.versions.at(-1);
    if (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0 || (current?.revision ?? 0) !== command.expectedRevision) {
        throw new AgentFault('E_PROFILE_CONFLICT', 'API配置版本已变化，保留现有配置');
    }
    let profile: ProviderProfile | null = null;
    if (command.type === 'remove') {
        if (!entry || entry.removed || !current) throw new AgentFault('E_PROFILE_NOT_FOUND', 'API配置不存在或已停用');
        entry.versions.push(validateProfile({ ...current, revision: current.revision + 1 }));
        entry.removed = true;
    } else if (command.type === 'credential') {
        if (!entry || entry.removed || !current) throw new AgentFault('E_PROFILE_NOT_FOUND', 'API配置不存在或已停用');
        if (!command.credentialRef || command.credentialGeneration !== current.credentialGeneration + 1) {
            throw new AgentFault('E_CREDENTIAL_GENERATION', '凭据轮换必须增加一代并提供新的受保护引用');
        }
        profile = validateProfile({ ...current, revision: current.revision + 1, credentialRef: command.credentialRef,
            credentialGeneration: command.credentialGeneration });
        entry.versions.push(profile);
    } else {
        if (current && (command.profile.credentialRef !== current.credentialRef || command.profile.credentialGeneration !== current.credentialGeneration)) {
            throw new AgentFault('E_CREDENTIAL_CHANNEL', '凭据修改必须通过受保护的专用入口');
        }
        if (!current && (command.profile.credentialRef !== null || command.profile.credentialGeneration !== 0)) {
            throw new AgentFault('E_CREDENTIAL_CHANNEL', '新配置先离线创建，再通过受保护入口设置凭据');
        }
        profile = validateProfile({ ...command.profile, revision: command.expectedRevision + 1 });
        if (current && profile.quotaScopeId !== current.quotaScopeId) {
            throw new AgentFault('E_QUOTA_SCOPE_CONFLICT', '配额组变更必须由核心核实真实账户后另行迁移');
        }
        state.profiles[JSON.stringify(profileId)] = { versions: [...(entry?.versions ?? []), profile], removed: false };
    }
    const result = { profile, removed: command.type === 'remove', replayed: false };
    state.receipts[receiptId] = { operationHash: digest, result };
    return { state, result: structuredClone(result) };
}

export class MemoryProfilePort implements ProfilePort {
    private state = emptyProfileState();
    async execute(command: ProfileCommand): Promise<ProfileResult> {
        const transition = applyProfileCommand(this.state, command);
        this.state = transition.state;
        return transition.result;
    }
    async get(profileId: string, revision?: number): Promise<ProviderProfile | null> {
        const entry = this.state.profiles[JSON.stringify(profileId)];
        if (!entry || (entry.removed && revision === undefined)) return null;
        const profile = revision === undefined ? entry.versions.at(-1) : entry.versions.find(value => value.revision === revision);
        return profile ? structuredClone(profile) : null;
    }
    async list(): Promise<ProviderProfile[]> {
        return structuredClone(Object.values(this.state.profiles).filter(entry => !entry.removed).map(entry => entry.versions.at(-1)!));
    }
}

export class ProfileStore {
    constructor(readonly port: ProfilePort) {}
    validate(profile: unknown): ProviderProfile { return validateProfile(profile); }
    get(profileId: string, revision?: number): Promise<ProviderProfile | null> { return this.port.get(profileId, revision); }
    list(): Promise<ProviderProfile[]> { return this.port.list(); }
    put(profile: ProviderProfile, expectedRevision: number, client: ClientIdentity, clientCommandId: string): Promise<ProfileResult> {
        return this.port.execute({ type: 'put', profile, expectedRevision, principalId: client.principalId, clientId: client.clientId, clientCommandId });
    }
    remove(profileId: string, expectedRevision: number, client: ClientIdentity, clientCommandId: string): Promise<ProfileResult> {
        return this.port.execute({ type: 'remove', profileId, expectedRevision, principalId: client.principalId, clientId: client.clientId, clientCommandId });
    }
    setCredential(input: { profileId: string; expectedRevision: number; credentialRef: string; credentialGeneration: number }, client: ClientIdentity, clientCommandId: string): Promise<ProfileResult> {
        return this.port.execute({ type: 'credential', ...input, principalId: client.principalId, clientId: client.clientId, clientCommandId });
    }
}
