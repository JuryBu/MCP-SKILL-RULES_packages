import { createHash } from 'node:crypto';
import { AgentFault } from '../protocol.js';
import { canonicalJson } from '../protocol.js';
import type { ClientIdentity, RpcResult } from '../protocol.js';
import { ConfigurationExtraPort, configurationHash } from '../storage/configuration-extra.js';
import type { ContentWrite } from '../storage/port.js';
import type { InstructionPin, InstructionSelection, InstructionSource, ResolvedInstructions } from './contracts.js';
import { ConfigurationSourceReader, MAX_INSTRUCTION_BYTES } from './source-reader.js';
import { ConfigurationSettingsService } from './settings.js';

const order = (left: InstructionPin, right: InstructionPin): number => left.priority - right.priority
    || (left.qualifiedName < right.qualifiedName ? -1 : left.qualifiedName > right.qualifiedName ? 1 : 0);

export class ConfigurationInstructions {
    constructor(readonly port: ConfigurationExtraPort, private readonly settings: ConfigurationSettingsService,
        private readonly reader: ConfigurationSourceReader) {}

    async snapshot(ownerId: string, conversationId: string) {
        const key = this.port.key(ownerId, 'instructions', conversationId);
        const record = await this.port.read<InstructionSelection>(key);
        return { key, record, revision: record?.revision ?? 0,
            selection: record?.value ?? { ownerId, skills: [], rules: [] } };
    }

    async list(ownerId: string, conversationId: string, kind: 'skill' | 'rule', cursor?: string, limit = 50) {
        const state = await this.snapshot(ownerId, conversationId);
        const catalog = await this.settings.sourceCatalog(ownerId, kind);
        const pins = kind === 'skill' ? state.selection.skills : state.selection.rules;
        const fingerprint = configurationHash({ ownerId, conversationId, kind, revision: state.revision, catalog });
        let offset = 0;
        if (cursor) {
            try {
                const saved = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
                if (saved.fingerprint !== fingerprint || !Number.isSafeInteger(saved.offset) || saved.offset < 0) throw new Error();
                offset = saved.offset;
            } catch { throw new AgentFault('STORAGE_CURSOR_STALE', '规则或技能目录已变化，请重新列出'); }
        }
        const entries = catalog.map(source => {
            const pinned = pins.find(pin => pin.sourceId === source.sourceId);
            return { ...source, ownerId, qualifiedName: `${source.sourceId}:${source.name}`, sourcePath: source.path,
                status: pinned ? 'loaded' : 'available', loaded: Boolean(pinned), version: pinned?.version ?? null,
                sha256: pinned?.sha256 ?? null, bytes: pinned?.bytes ?? null, loadedRange: pinned ? 'whole_document' : 'metadata_only' };
        });
        const items: unknown[] = entries;
        for (const pinned of pins) if (!catalog.some(source => source.sourceId === pinned.sourceId)) {
            items.push({ ...pinned, status: 'loaded_source_removed', loaded: true, loadedRange: 'whole_document' });
        }
        const nextOffset = offset + limit;
        return { revision: state.revision, ownerId, items: items.slice(offset, nextOffset), hasMore: nextOffset < items.length,
            nextCursor: nextOffset < items.length ? Buffer.from(JSON.stringify({ fingerprint, offset: nextOffset })).toString('base64url') : null };
    }

    private async source(ownerId: string, kind: 'skill' | 'rule', name: string): Promise<InstructionSource> {
        const catalog = await this.settings.sourceCatalog(ownerId, kind);
        const found = catalog.find(entry => kind === 'skill' ? `${entry.sourceId}:${entry.name}` === name : entry.sourceId === name);
        if (!found) throw new AgentFault('CONFIGURATION_SOURCE_NOT_FOUND', '请从当前身份的显式来源目录选择完整名称', { name });
        return found;
    }

    private async pinnedText(conversationId: string, pin: InstructionPin): Promise<string> {
        const value = await this.port.store.readContent(conversationId, pin.contentId) as { text?: unknown } | undefined;
        if (typeof value?.text !== 'string' || createHash('sha256').update(value.text).digest('hex') !== pin.sha256) {
            throw new AgentFault('CONFIGURATION_SOURCE_CORRUPT', '已选定的规则或技能正文缺失或哈希不符', { sourceId: pin.sourceId, version: pin.version });
        }
        return value.text;
    }

    async get(ownerId: string, conversationId: string, kind: 'skill' | 'rule', name: string) {
        const state = await this.snapshot(ownerId, conversationId);
        const pins = kind === 'skill' ? state.selection.skills : state.selection.rules;
        const pinned = pins.find(pin => kind === 'skill' ? pin.qualifiedName === name : pin.sourceId === name);
        if (pinned) return { revision: state.revision, ...pinned, loaded: true, text: await this.pinnedText(conversationId, pinned) };
        const source = await this.source(ownerId, kind, name);
        const body = await this.reader.read(source);
        return { revision: state.revision, ...source, ownerId, kind, qualifiedName: `${source.sourceId}:${source.name}`,
            sourcePath: body.path, sha256: body.sha256, version: body.version, bytes: body.bytes, text: body.text, loaded: false };
    }

    private async pin(ownerId: string, conversationId: string, kind: 'skill' | 'rule', source: InstructionSource) {
        const body = await this.reader.read(source);
        const contentId = `configuration:${kind}:${configurationHash({ ownerId, sourceId: source.sourceId, version: body.version })}`;
        const pin: InstructionPin = { kind, sourceId: source.sourceId, qualifiedName: `${source.sourceId}:${source.name}`, name: source.name,
            ownerId, sourcePath: body.path, priority: source.priority, version: body.version, sha256: body.sha256, bytes: body.bytes, contentId };
        const content: ContentWrite = { conversationId, contentId, kind: 'configuration_instruction', indexHistory: false,
            value: { text: body.text, sha256: body.sha256 } };
        return { pin, content };
    }

    private checkSize(selection: InstructionSelection): void {
        if (selection.skills.length > 32 || selection.rules.length > 32
            || [...selection.rules, ...selection.skills].reduce((total, pin) => total + pin.bytes
                + Buffer.byteLength(`[${pin.kind} ${pin.qualifiedName} ${pin.version}]\n`) + 2, 0) > MAX_INSTRUCTION_BYTES) {
            throw new AgentFault('CONFIGURATION_INSTRUCTION_LIMIT', '已选规则和技能的稳定前缀最多64KiB，请停用部分来源');
        }
        if (Buffer.byteLength(canonicalJson(selection)) > 60 * 1024) throw new AgentFault('CONFIGURATION_METADATA_LIMIT', '所选来源的路径和版本元数据超过60KiB');
    }

    async skill(client: ClientIdentity, method: string, params: Record<string, unknown>): Promise<RpcResult> {
        const conversationId = String(params.conversationId);
        const state = await this.snapshot(client.principalId, conversationId);
        const catalog = await this.settings.snapshot(client.principalId);
        const selection = structuredClone(state.selection);
        const name = String(params.qualifiedName);
        const contents: ContentWrite[] = [];
        selection.skills = selection.skills.filter(pin => pin.qualifiedName !== name);
        if (method.endsWith('.load')) {
            const source = await this.source(client.principalId, 'skill', name);
            const loaded = await this.pin(client.principalId, conversationId, 'skill', source);
            if (params.expectedSha256 && loaded.pin.sha256 !== params.expectedSha256) throw new AgentFault('CONFIGURATION_SOURCE_CHANGED', '技能正文已变化，请重新预览后加载');
            selection.skills.push(loaded.pin);
            contents.push(loaded.content);
        } else if (!state.selection.skills.some(pin => pin.qualifiedName === name)) {
            await this.source(client.principalId, 'skill', name);
        }
        selection.skills.sort(order);
        this.checkSize(selection);
        return this.port.commit({ client, method, params, key: state.key, previous: state.record, value: selection, contents,
            expected: [{ key: catalog.key, revision: catalog.record?.revision ?? null }],
            data: { revision: state.revision + 1, qualifiedName: name, loaded: method.endsWith('.load'), effective: 'next_request' } });
    }

    async reload(client: ClientIdentity, method: string, params: Record<string, unknown>): Promise<RpcResult> {
        const conversationId = String(params.conversationId);
        const state = await this.snapshot(client.principalId, conversationId);
        const catalog = await this.settings.snapshot(client.principalId);
        const sources = await this.settings.sourceCatalog(client.principalId, 'rule');
        const wanted = params.sourceIds === undefined ? sources.filter(source => source.enabled).map(source => source.sourceId) : params.sourceIds as string[];
        if (new Set(wanted).size !== wanted.length) throw new AgentFault('INVALID_PARAMS', '规则来源选择须唯一');
        const loaded = [];
        for (const sourceId of wanted) loaded.push(await this.pin(client.principalId, conversationId, 'rule', await this.source(client.principalId, 'rule', sourceId)));
        const selection = { ...structuredClone(state.selection), rules: loaded.map(entry => entry.pin).sort(order) };
        this.checkSize(selection);
        const previewToken = configurationHash({ conversationId, ownerId: client.principalId, revision: state.revision, catalogRevision: catalog.revision,
            rules: selection.rules });
        const preview = { revision: state.revision, nextRevision: state.revision + 1, previewToken, effective: 'next_request',
            previous: state.selection.rules, selected: selection.rules, dryRun: params.dryRun !== false };
        if (params.dryRun === false && params.previewToken !== previewToken) {
            throw new AgentFault('CONFIGURATION_PREVIEW_CHANGED', '请先预览当前规则并携同一previewToken提交');
        }
        return this.port.commit({ client, method, params, key: state.key, previous: state.record,
            ...(params.dryRun === false ? { value: selection, contents: loaded.map(entry => entry.content) } : {}),
            expected: [{ key: catalog.key, revision: catalog.record?.revision ?? null }],
            data: params.dryRun === false ? { ...preview, revision: state.revision + 1 } : preview });
    }

    async resolveInstructions(input: { ownerId: string; conversationId: string; additionalInstructions?: unknown }): Promise<ResolvedInstructions> {
        const state = await this.snapshot(input.ownerId, input.conversationId);
        if (input.additionalInstructions !== undefined && typeof input.additionalInstructions !== 'string') throw new AgentFault('INVALID_PARAMS', '会话指令须为文本');
        const sections: string[] = [];
        if (input.additionalInstructions) sections.push(input.additionalInstructions as string);
        const pins = [...state.selection.rules.slice().sort(order), ...state.selection.skills.slice().sort(order)];
        for (const pin of pins) sections.push(`[${pin.kind} ${pin.qualifiedName} ${pin.version}]\n${await this.pinnedText(input.conversationId, pin)}`);
        const text = sections.join('\n\n');
        if (Buffer.byteLength(text) > MAX_INSTRUCTION_BYTES) throw new AgentFault('CONFIGURATION_INSTRUCTION_LIMIT', '会话指令、规则及技能合计超过64KiB');
        const versions = (kind: InstructionPin['kind']) => Object.fromEntries(pins.filter(pin => pin.kind === kind).map(pin => [pin.qualifiedName, pin.version]));
        return { schemaVersion: 1, conversationId: input.conversationId, revision: state.revision, text,
            prefixHash: configurationHash({ text, versions: versions('skill'), rules: versions('rule') }),
            skillVersions: versions('skill'), ruleVersions: versions('rule'), sources: structuredClone(pins) };
    }
}
