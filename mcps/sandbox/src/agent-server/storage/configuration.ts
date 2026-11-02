import { AgentFault, canonicalJson } from '../protocol.js';
import { applyProfileCommand, emptyProfileState } from '../profiles/profile-store.js';
import type { ProfileCommand, ProfilePort, ProfileResult, ProfileState } from '../profiles/profile-store.js';
import type { ProtectedSecret, ProtectedSecretPort } from '../profiles/secret-vault.js';
import type { ProviderProfile } from '../providers/types.js';
import type { SqlDatabase } from './internal.js';
import { ObjectFiles } from './objects.js';
import type { PreparedObject } from './objects.js';
import type { SqliteStore } from './sqlite.js';
import type { CatalogPort, CatalogSnapshot } from '../models/catalog.js';

const identity = (...values: (string | number)[]): string => canonicalJson(values);

interface GlobalRow<Value> { revision: number; value: Value }
interface ProfileHead { latestRevision: number; removed: boolean }
interface ObjectPointer { objectHash: string }

export class SqliteProfilePort implements ProfilePort {
    constructor(private readonly store: SqliteStore) {}
    execute(command: ProfileCommand): Promise<ProfileResult> { return this.store.executeProfile(command); }
    get(profileId: string, revision?: number): Promise<ProviderProfile | null> { return this.store.getProfile(profileId, revision); }
    list(): Promise<ProviderProfile[]> { return this.store.listProfiles(); }
}

export class SqliteProtectedSecretPort implements ProtectedSecretPort {
    constructor(private readonly store: SqliteStore) {}
    get(credentialRef: string, generation: number): Promise<ProtectedSecret | null> { return this.store.getProtectedSecret(credentialRef, generation); }
    put(secret: ProtectedSecret): Promise<void> { return this.store.putProtectedSecret(secret); }
    revoke(credentialRef: string, generation: number): Promise<void> { return this.store.revokeProtectedSecret(credentialRef, generation); }
}

export class SqliteCatalogPort implements CatalogPort {
    constructor(private readonly store: SqliteStore) {}
    read(profileId: string): Promise<CatalogSnapshot | null> { return this.store.readCatalog(profileId); }
    publish(snapshot: CatalogSnapshot, expectedVersion: string | null): Promise<void> { return this.store.publishCatalog(snapshot, expectedVersion); }
}

export function createSqliteConfigurationPorts(store: SqliteStore): { profilePort: SqliteProfilePort; protectedSecretPort: SqliteProtectedSecretPort; catalogPort: SqliteCatalogPort } {
    return { profilePort: new SqliteProfilePort(store), protectedSecretPort: new SqliteProtectedSecretPort(store), catalogPort: new SqliteCatalogPort(store) };
}

export class ConfigurationTransactions {
    constructor(private readonly database: SqlDatabase, private readonly files: ObjectFiles) {}

    getProfile(profileId: string, revision?: number): ProviderProfile | null {
        const head = this.get<ProfileHead>('profileHead', profileId);
        if (!head || (head.value.removed && revision === undefined)) return null;
        return this.get<ProviderProfile>('profileVersion', identity(profileId, revision ?? head.value.latestRevision))?.value ?? null;
    }

    listProfiles(): ProviderProfile[] {
        const rows = this.database.prepare('SELECT id,value_json FROM server_state WHERE kind = ? ORDER BY id LIMIT 513').all('profileHead');
        if (rows.length > 512) throw new AgentFault('STORAGE_CONFIGURATION_LIMIT', '配置列表超过本次有界读取上限');
        return rows.filter(row => !(JSON.parse(String(row.value_json)) as ProfileHead).removed)
            .map(row => this.getProfile(String(row.id))!).filter(Boolean);
    }

    readCatalog(profileId: string): CatalogSnapshot | null {
        const head = this.get<ObjectPointer>('catalogHead', profileId);
        return head ? this.files.read(this.database, head.value.objectHash) as CatalogSnapshot : null;
    }

    publishCatalog(snapshot: CatalogSnapshot, expectedVersion: string | null): void {
        if (snapshot.schemaVersion !== 1 || !snapshot.profileId || !snapshot.catalogVersion || !Array.isArray(snapshot.entries)
            || !Number.isSafeInteger(snapshot.profileRevision) || snapshot.profileRevision < 1
            || !Number.isFinite(Date.parse(snapshot.observedAt)) || !Number.isFinite(Date.parse(snapshot.expiresAt))) {
            throw new AgentFault('E_CATALOG_INVALID', '模型目录版本、有效期或配置身份无效');
        }
        const head = this.get<ObjectPointer & { catalogVersion: string }>('catalogHead', snapshot.profileId);
        if ((head?.value.catalogVersion ?? null) !== expectedVersion) throw new AgentFault('E_CATALOG_CONFLICT', '模型目录已经被其他刷新更新');
        const object = this.files.prepare(snapshot, 'model_catalog');
        const versionId = identity(snapshot.profileId, snapshot.catalogVersion);
        const previous = this.get<ObjectPointer>('catalogVersion', versionId);
        if (previous && previous.value.objectHash !== object.hash) {
            this.files.discardUncommitted(this.database, [object]);
            throw new AgentFault('E_CATALOG_CONFLICT', '已有目录版本不能覆盖为其他原件');
        }
        this.atomic([object], () => {
            const actual = this.get<ObjectPointer & { catalogVersion: string }>('catalogHead', snapshot.profileId);
            if ((actual?.value.catalogVersion ?? null) !== expectedVersion) throw new AgentFault('E_CATALOG_CONFLICT', '提交时目录版本已经变化');
            this.put('catalogVersion', versionId, snapshot.profileRevision, { objectHash: object.hash,
                catalogVersion: snapshot.catalogVersion, profileRevision: snapshot.profileRevision, expiresAt: snapshot.expiresAt });
            this.put('catalogHead', snapshot.profileId, (actual?.revision ?? 0) + 1, { objectHash: object.hash,
                catalogVersion: snapshot.catalogVersion, profileRevision: snapshot.profileRevision, expiresAt: snapshot.expiresAt });
            this.reference('catalogVersion', versionId, object.hash);
        });
    }

    executeProfile(command: ProfileCommand): ProfileResult {
        const state = emptyProfileState();
        const profileId = command.type === 'put' ? command.profile.profileId : command.profileId;
        const head = this.get<ProfileHead>('profileHead', profileId);
        if (head) {
            const current = this.getProfile(profileId, head.value.latestRevision);
            if (!current) throw new AgentFault('STORAGE_SEGMENT_CORRUPT', '配置头引用的版本缺失');
            state.profiles[JSON.stringify(profileId)] = { versions: [current], removed: head.value.removed };
        }
        const receiptId = identity(command.principalId, command.clientId, 'profiles', command.clientCommandId);
        const saved = this.get<ObjectPointer>('profileReceipt', receiptId);
        if (saved) state.receipts[receiptId] = this.files.read(this.database, saved.value.objectHash) as ProfileState['receipts'][string];
        const result = applyProfileCommand(state, command);
        if (result.result.replayed) return result.result;
        if (command.type === 'credential') {
            const secret = this.getProtectedSecret(command.credentialRef, command.credentialGeneration);
            if (!secret || secret.revoked || secret.profileId !== command.profileId) {
                throw new AgentFault('E_CREDENTIAL_NOT_FOUND', '配置只能关联同一配置名下尚有效的受保护凭据引用');
            }
        }
        const receipt = result.state.receipts[receiptId];
        const object = this.files.prepare(receipt, 'profile_receipt');
        return this.atomic([object], () => {
            const actual = this.get<ProfileHead>('profileHead', profileId);
            if ((actual?.value.latestRevision ?? 0) !== command.expectedRevision) throw new AgentFault('E_PROFILE_CONFLICT', '配置版本已经变化');
            const entry = result.state.profiles[JSON.stringify(profileId)];
            const latest = entry.versions.at(-1)!;
            this.put('profileVersion', identity(profileId, latest.revision), latest.revision, latest);
            this.put('profileHead', profileId, latest.revision, { latestRevision: latest.revision, removed: entry.removed });
            this.put('profileReceipt', receiptId, 1, { objectHash: object.hash });
            this.reference('profileReceipt', receiptId, object.hash);
            return result.result;
        });
    }

    getProtectedSecret(credentialRef: string, generation: number): ProtectedSecret | null {
        const row = this.get<ObjectPointer & { revoked: boolean }>('protectedSecret', identity(credentialRef, generation));
        if (!row) return null;
        const secret = this.files.read(this.database, row.value.objectHash) as ProtectedSecret;
        return { ...secret, revoked: row.value.revoked };
    }

    putProtectedSecret(secret: ProtectedSecret): void {
        const fields = new Set(['credentialRef', 'generation', 'profileId', 'purpose', 'format', 'ciphertextBase64', 'createdAt', 'revoked']);
        if (Object.keys(secret).some(field => !fields.has(field)) || secret.format !== 'dpapi-current-user-v1'
            || !/^[A-Za-z0-9_-]{1,128}$/.test(secret.credentialRef) || !Number.isSafeInteger(secret.generation) || secret.generation < 1
            || !secret.profileId || secret.profileId.length > 512 || !secret.purpose || secret.purpose.length > 512
            || typeof secret.revoked !== 'boolean' || !Number.isFinite(Date.parse(secret.createdAt))
            || typeof secret.ciphertextBase64 !== 'string' || secret.ciphertextBase64.length < 4 || secret.ciphertextBase64.length > 256 * 1024
            || Buffer.from(secret.ciphertextBase64, 'base64').toString('base64') !== secret.ciphertextBase64) {
            throw new AgentFault('E_SECRET_INVALID', '受保护凭据的格式、引用或密文大小无效');
        }
        const existing = this.getProtectedSecret(secret.credentialRef, secret.generation);
        if (existing) {
            if (canonicalJson(existing) !== canonicalJson(secret)) throw new AgentFault('E_CREDENTIAL_CONFLICT', '该凭据引用已有不同密文或状态');
            return;
        }
        const object = this.files.prepare(secret, 'dpapi_protected_secret');
        const id = identity(secret.credentialRef, secret.generation);
        this.atomic([object], () => {
            if (this.get('protectedSecret', id)) throw new AgentFault('E_CREDENTIAL_CONFLICT', '该受保护凭据引用已经存在');
            this.put('protectedSecret', id, 1, { objectHash: object.hash, credentialRef: secret.credentialRef,
                generation: secret.generation, profileId: secret.profileId, format: secret.format, revoked: secret.revoked });
            this.reference('protectedSecret', id, object.hash);
        });
    }

    revokeProtectedSecret(credentialRef: string, generation: number): void {
        const id = identity(credentialRef, generation);
        this.atomic([], () => {
            const row = this.get<ObjectPointer & { revoked: boolean }>('protectedSecret', id);
            if (!row) throw new AgentFault('E_CREDENTIAL_NOT_FOUND', '受保护凭据引用不存在');
            if (!row.value.revoked) this.put('protectedSecret', id, row.revision + 1, { ...row.value, revoked: true });
        });
    }

    private get<Value>(kind: string, id: string): GlobalRow<Value> | undefined {
        const row = this.database.prepare('SELECT revision,value_json FROM server_state WHERE kind = ? AND id = ?').get(kind, id);
        return row ? { revision: Number(row.revision), value: JSON.parse(String(row.value_json)) as Value } : undefined;
    }

    private put(kind: string, id: string, revision: number, value: unknown): void {
        const json = canonicalJson(value);
        if (Buffer.byteLength(json) > 64 * 1024) throw new AgentFault('STORAGE_METADATA_LIMIT', '全局配置元数据超过64KiB');
        this.database.prepare('INSERT INTO server_state (kind,id,revision,value_json) VALUES (?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET revision=excluded.revision,value_json=excluded.value_json')
            .run(kind, id, revision, json);
    }

    private reference(kind: string, id: string, hash: string): void {
        this.database.prepare('INSERT OR IGNORE INTO server_refs (owner_kind,owner_id,slot,target_kind,target_id) VALUES (?,?,?,?,?)')
            .run(kind, id, 'value', 'object', hash);
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
                try { this.database.exec('ROLLBACK'); } catch { throw new AgentFault('STORAGE_COMMIT_UNKNOWN', '配置提交状态未知，请查询原命令', undefined, true); }
            }
            this.files.discardUncommitted(this.database, objects);
            throw error;
        }
    }
}
