import { z } from 'zod';
import { AgentFault, canonicalJson } from '../protocol.js';
import type { ClientIdentity, JsonValue, RpcResult } from '../protocol.js';
import type { ConfigurationSettings, InstructionSource } from './contracts.js';
import { ConfigurationExtraPort } from '../storage/configuration-extra.js';
import type { ConfigurationSourceReader } from './source-reader.js';

const source = z.object({ sourceId: z.string().regex(/^[^:\s\u0000-\u001f\u007f]{1,96}$/u), name: z.string().regex(/^[^:\u0000-\u001f\u007f]{1,96}$/u),
    description: z.string().max(1024).default(''), path: z.string().min(1).max(4096), priority: z.number().int().min(-10000).max(10000).default(0),
    enabled: z.boolean().default(true) }).strict();
const sources = z.array(source).max(32).superRefine((entries, context) => {
    if (new Set(entries.map(entry => entry.sourceId)).size !== entries.length) context.addIssue({ code: 'custom', message: '来源ID须唯一' });
});

export const SETTING_SCHEMAS: Record<string, z.ZodTypeAny> = {
    'terminal.enterBehavior': z.enum(['send', 'newline']),
    'terminal.graphics': z.enum(['auto', 'blocks', 'sixel', 'kitty', 'none']),
    'terminal.motion': z.enum(['full', 'reduced', 'off']),
    'terminal.color': z.enum(['auto', 'always', 'never']),
    'terminal.width': z.enum(['narrow', 'wide']),
    'history.pageSize': z.number().int().min(1).max(100),
    'skills.sources': sources,
    'rules.sources': sources,
};

export const DEFAULT_SETTINGS: Readonly<Record<string, JsonValue>> = Object.freeze({
    'terminal.enterBehavior': 'send', 'terminal.graphics': 'auto', 'terminal.motion': 'full',
    'terminal.color': 'auto', 'terminal.width': 'narrow', 'history.pageSize': 50, 'skills.sources': [], 'rules.sources': [],
});

export class ConfigurationSettingsService {
    constructor(readonly port: ConfigurationExtraPort, private readonly reader: ConfigurationSourceReader) {}

    async snapshot(ownerId: string) {
        const key = this.port.key(ownerId, 'settings');
        const record = await this.port.read<ConfigurationSettings>(key);
        const values = Object.fromEntries(Object.keys(DEFAULT_SETTINGS).map(name => [name,
            record?.value.values[name] ?? structuredClone(DEFAULT_SETTINGS[name])]));
        return { key, record, revision: record?.revision ?? 0, values };
    }

    async get(ownerId: string) {
        const state = await this.snapshot(ownerId);
        return { scope: 'global', ownerId, revision: state.revision, values: state.values,
            sources: Object.fromEntries(Object.keys(state.values).map(name => [name,
                state.record?.value.values[name] === undefined ? 'product_default' : 'product_configuration'])),
            providerConfiguration: { method: 'profiles.put', fields: ['compressionModelRef', 'globalModelRulesRef'], credentials: 'hidden' } };
    }

    async sourceCatalog(ownerId: string, kind: 'skill' | 'rule'): Promise<InstructionSource[]> {
        const state = await this.snapshot(ownerId);
        return structuredClone(state.values[kind === 'skill' ? 'skills.sources' : 'rules.sources']) as unknown as InstructionSource[];
    }

    async put(client: ClientIdentity, method: string, params: Record<string, unknown>): Promise<RpcResult> {
        const state = await this.snapshot(client.principalId);
        const changes = params.values as Record<string, unknown>;
        const names = Object.keys(changes);
        if (!names.length || names.length > 8) throw new AgentFault('INVALID_PARAMS', '一次设置更新须包含1至8个本产品字段');
        const values = { ...(state.record?.value.values ?? {}) };
        for (const name of names) {
            const schema = SETTING_SCHEMAS[name];
            if (!schema) throw new AgentFault('CONFIGURATION_SETTING_UNKNOWN', '该字段不属于本产品公开设置', { key: name, supported: Object.keys(SETTING_SCHEMAS) });
            const parsed = schema.safeParse(changes[name]);
            if (!parsed.success) throw new AgentFault('INVALID_PARAMS', '设置值不符合公开类型', { key: name, issues: parsed.error.issues.map(issue => issue.message) });
            if (name.endsWith('.sources')) for (const entry of parsed.data as InstructionSource[]) entry.path = await this.reader.validatePath(entry.path);
            values[name] = parsed.data as JsonValue;
        }
        if (Buffer.byteLength(canonicalJson({ ownerId: client.principalId, values })) > 60 * 1024) {
            throw new AgentFault('CONFIGURATION_METADATA_LIMIT', '本产品设置及来源元数据超过60KiB');
        }
        return this.port.commit({ client, method, params, previous: state.record, key: state.key,
            value: { ownerId: client.principalId, values }, data: { scope: 'global', ownerId: client.principalId,
                revision: state.revision + 1, changedKeys: names, effective: 'next_request', credentials: 'hidden' } });
    }
}
