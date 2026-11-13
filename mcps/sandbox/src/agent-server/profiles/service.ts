import { createHash } from 'node:crypto';
import { AgentFault, canonicalJson } from '../protocol.js';
import type { ClientIdentity } from '../protocol.js';
import type { CatalogSnapshot, ModelCatalog, ModelEntry } from '../models/catalog.js';
import { ProfileStore } from './profile-store.js';
import type { ProfilePort } from './profile-store.js';
import type { SecretVault } from './secret-vault.js';
import { PROVIDER_RPC_SIGNATURES } from './rpc-signatures.js';
import { readSecretImport } from './secret-import.js';

export interface ProviderServiceContext {
    client: ClientIdentity;
    authorizeGlobalWrite(client: ClientIdentity, params: Record<string, unknown>): Promise<void>;
}

export interface ProfileModelServiceOptions {
    profilePort: ProfilePort;
    credentials?: SecretVault;
    catalog: ModelCatalog;
    refreshModels(profileId: string, signal?: AbortSignal): Promise<CatalogSnapshot>;
}

export function redactProviderRpcParams(method: string, params: Record<string, unknown>): Record<string, unknown> {
    if (method === 'profiles.setSecret' || method === 'profiles.rotateSecret') {
        const { secret: _secret, ...visible } = params;
        return { ...visible, secretConfigured: typeof params.secret === 'string' && params.secret.length > 0 };
    }
    return { ...params };
}

function catalogMetadata(catalog: CatalogSnapshot): Omit<CatalogSnapshot, 'entries'> {
    return { schemaVersion: catalog.schemaVersion, catalogVersion: catalog.catalogVersion, profileId: catalog.profileId,
        profileRevision: catalog.profileRevision, observedAt: catalog.observedAt, expiresAt: catalog.expiresAt };
}

export function createProfileModelService(options: ProfileModelServiceOptions) {
    const profiles = new ProfileStore(options.profilePort);
    const readOnly = new Set(['profiles.list', 'profiles.get', 'profiles.validate', 'models.list', 'models.get']);
    const handle = async (method: string, supplied: Record<string, unknown>, context: ProviderServiceContext): Promise<unknown> => {
        const schema = PROVIDER_RPC_SIGNATURES[method as keyof typeof PROVIDER_RPC_SIGNATURES];
        if (!schema) throw new AgentFault('METHOD_NOT_FOUND', 'Provider服务没有该控制方法');
        const { controlLeaseId: _lease, controlEpoch: _epoch, ...business } = supplied;
        const parsed = schema.safeParse(business);
        if (!parsed.success) throw new AgentFault('INVALID_PARAMS', 'Provider控制方法参数不完整或类型无效');
        const params = parsed.data as Record<string, unknown>;
        if ((method === 'profiles.setSecret' || method === 'profiles.rotateSecret') && /[\r\n\0]/.test(String(params.secret))) {
            throw new AgentFault('E_SECRET_INVALID', 'API凭据包含不适用的字符');
        }
        if (!readOnly.has(method)) {
            if (typeof context.authorizeGlobalWrite !== 'function') throw new AgentFault('E_GLOBAL_AUTH_REQUIRED', '配置写入需要主线的全局控制授权');
            await context.authorizeGlobalWrite(context.client, supplied);
        }
        if (method === 'profiles.validate') return { profile: profiles.validate(params.profile), valid: true, networkPerformed: false };
        if (method === 'profiles.list') {
            const items = (await profiles.list()).sort((left, right) => left.profileId.localeCompare(right.profileId));
            const cursor = params.cursor === null || params.cursor === undefined ? 0 : Number(params.cursor);
            if (!Number.isSafeInteger(cursor) || cursor < 0 || (params.cursor != null && String(cursor) !== params.cursor)) throw new AgentFault('E_CURSOR_INVALID', '配置列表游标无效');
            const limit = Number(params.limit ?? 50);
            return { profiles: items.slice(cursor, cursor + limit), nextCursor: cursor + limit < items.length ? String(cursor + limit) : null };
        }
        if (method === 'profiles.get') return { profile: await profiles.get(String(params.profileId), params.revision as number | undefined) };
        if (method === 'profiles.put') return profiles.put(profiles.validate(params.profile), Number(params.expectedRevision), context.client, String(params.clientCommandId));
        if (method === 'profiles.remove') return profiles.remove(String(params.profileId), Number(params.expectedRevision), context.client, String(params.clientCommandId));
        if (method === 'models.list') return options.catalog.list(String(params.profileId), params.cursor as string | null | undefined, params.limit as number | undefined);
        if (method === 'models.get') {
            const { catalog, entry } = await options.catalog.get(String(params.profileId), String(params.modelId), params.routeId as string | null | undefined);
            return { catalogVersion: catalog.catalogVersion, catalog: catalogMetadata(catalog), entry };
        }
        if (method === 'models.refresh') {
            const catalog = await options.refreshModels(String(params.profileId));
            return { catalogVersion: catalog.catalogVersion, catalog: catalogMetadata(catalog), entryCount: catalog.entries.length };
        }
        if (method === 'models.declare') {
            const profile = await profiles.get(String(params.profileId));
            if (!profile) throw new AgentFault('E_PROFILE_NOT_FOUND', 'API配置不存在或已停用');
            const catalog = await options.catalog.declare(profile, params.entry as ModelEntry, params.expectedCatalogVersion as string | null);
            return { catalogVersion: catalog.catalogVersion, entry: catalog.entries.find(item => item.modelId === (params.entry as ModelEntry).modelId
                && item.routeId === (params.entry as ModelEntry).routeId) };
        }
        if (!options.credentials) throw new AgentFault('E_SECRET_BACKEND', '后台尚未连接受保护凭据存储');
        const profileId = String(params.profileId);
        const expectedRevision = Number(params.expectedRevision);
        const base = await profiles.get(profileId, expectedRevision);
        if (!base) throw new AgentFault('E_PROFILE_CONFLICT', '凭据设置引用的配置版本不存在');
        if (method === 'profiles.setSecret' && base.credentialRef !== null) throw new AgentFault('E_CREDENTIAL_EXISTS', '已有凭据需要使用轮换入口');
        if (method === 'profiles.rotateSecret' && base.credentialRef === null) throw new AgentFault('E_CREDENTIAL_NOT_FOUND', '尚未设置凭据，请使用首次设置入口');
        const credentialRef = `credential-${createHash('sha256').update(canonicalJson([context.client.principalId,
            context.client.clientId, profileId, params.clientCommandId])).digest('hex')}`;
        const generation = base.credentialGeneration + 1;
        const previous = await options.credentials.describe(credentialRef, generation);
        const current = await profiles.get(profileId);
        if (!previous.configured && current?.revision !== expectedRevision) throw new AgentFault('E_PROFILE_CONFLICT', '凭据写入前API配置版本已变化');
        const secret = method === 'profiles.importSecret' ? await readSecretImport({ sourcePath: String(params.sourcePath),
            format: params.format as 'plain' | 'env' | 'json', field: params.field as string | undefined }) : Buffer.from(String(params.secret), 'utf8');
        try {
            const descriptor = await options.credentials.create(profileId, generation, secret, credentialRef);
            const result = await profiles.setCredential({ profileId, expectedRevision, credentialRef, credentialGeneration: generation },
                context.client, String(params.clientCommandId));
            return method === 'profiles.importSecret' ? { profileId, revision: result.profile?.revision,
                credentialRef: descriptor.credentialRef, credentialGeneration: descriptor.generation, configured: true,
                revoked: descriptor.revoked, replayed: result.replayed } : { ...result, credential: descriptor };
        } finally { secret.fill(0); }
    };
    return { schemas: PROVIDER_RPC_SIGNATURES, handle, profiles };
}
