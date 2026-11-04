import { createHash } from 'node:crypto';
import { AgentFault, canonicalJson } from '../protocol.js';
import { measureCanonicalJsonBytes } from '../media/temporary-budget.js';
import type { TemporaryBudgetPort } from '../media/temporary-budget.js';
import type { BrokerMcpClient, BrokerToolDefinition } from '../tools/broker-client.js';
import type { BoundToolContext } from '../tools/types.js';
import type { SharedToolSpec } from '../tools/adapters/types.js';
import { assertOwnedWebArguments, assertNativeWebTableArguments, verifiedPersistentWebToolSpecs } from '../tools/adapters/web.js';
import { validateToolArguments } from '../tools/schema-cache.js';
import type { OwnedResource, ResourceAdapter, ResourceReceipt, ResourceRegistry, ResourceStorePort } from './registry.js';
import { NativeWebSessionPort, inspectNativeWebSessionContract, type NativeWebReference } from './web-native-sessions.js';

export interface NativeWebAdapterContract {
    leaseMode?: 'native' | 'core';
    upstreamMissing?: string[];
    ephemeralContent?: boolean;
    missingEphemeral?: string[];
    enabled: boolean;
    missing: string[];
    contractHash: string;
    callerSource: 'core_bound_caller';
    remoteAuthentication: 'not_provided';
}

export interface NativeWebAdapterOptions {
    client: BrokerMcpClient;
    resourceStore: ResourceStorePort;
    coreIssuerId: string;
    adapterId?: string;
    toolNames?: readonly NativeWebToolName[];
    definitions?: readonly BrokerToolDefinition[];
    preserveOutputOnCancel?: boolean;
    temporaryEnabled?: boolean;
    outputBudget?: TemporaryBudgetPort;
}

export type NativeWebToolName = 'web_interact' | 'web_pipeline' | 'web_extract_tables' | 'web_download';

interface NativeWebCall extends Record<string, unknown> {
    toolName: NativeWebToolName;
    args: Record<string, unknown>;
    reference: NativeWebReference;
    hardLeaseUntil: string;
    caller: { source: 'core_bound_caller'; principalId: string; conversationId: string; runId: string;
        rootRunId: string; actionId: string; runEpoch: number };
}

interface NativeReceipt {
    ephemeralContent?: boolean;
    outcome?: string;
    empty?: boolean;
    artifacts?: { ownerId: string; requestId: string; path?: string; inline?: boolean; mimeType: string; sha256: string; byteLength: number }[];
    ownerId: string;
    requestId: string;
    backendInstanceId: string;
    state: 'pending' | 'active' | 'closing' | 'released';
    sessionId?: string;
    leaseUntil: string;
    hardLeaseUntil: string;
    started: boolean;
    terminalConfirmed: boolean;
    released: boolean;
}

function object(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function inspectNativeWebAdapterContract(tools: readonly BrokerToolDefinition[], coreIssuerId: string,
    toolNames: readonly NativeWebToolName[] = ['web_interact', 'web_pipeline']): NativeWebAdapterContract {
    const required: Record<string, Record<string, string>> = {
        web_interact: { ownerId: 'string', requestId: 'string', leaseUntil: 'string', hardLeaseUntil: 'string', sessionId: 'string', action: 'string', saveMode: 'string', humanAssistance: 'string' },
        web_pipeline: { ownerId: 'string', requestId: 'string', leaseUntil: 'string', hardLeaseUntil: 'string', sessionId: 'string', steps: 'array', keepSession: 'boolean', saveMode: 'string', humanAssistance: 'string' },
        web_extract_tables: { ownerId: 'string', requestId: 'string', leaseUntil: 'string', hardLeaseUntil: 'string', url: 'string', format: 'string', saveMode: 'string', humanAssistance: 'string' },
        web_download: { ownerId: 'string', requestId: 'string', leaseUntil: 'string', hardLeaseUntil: 'string', url: 'string' },
        web_list_sessions: { ownerId: 'string', requestId: 'string', includeAllOwners: 'boolean' },
        web_close_sessions: { ownerId: 'string', requestId: 'string', sessionId: 'string', closeAllForOwner: 'boolean' },
    };
    const missing: string[] = [];
    if (!coreIssuerId) missing.push('core-bound-caller:issuer');
    for (const [name, fields] of Object.entries(required)) {
        if (!['web_list_sessions', 'web_close_sessions', 'web_interact', ...toolNames].includes(name)) continue;
        const properties = tools.find(tool => tool.name === name)?.inputSchema.properties as Record<string, Record<string, unknown>> | undefined;
        for (const [field, type] of Object.entries(fields)) if (properties?.[field]?.type !== type) missing.push(`${name}:${field}`);
        if (name === 'web_interact' && !((properties?.action?.enum ?? []) as string[]).includes('renew')) missing.push(`${name}:renew`);
        if (name === 'web_interact' || name === 'web_pipeline') {
            if (!((properties?.saveMode?.enum ?? []) as string[]).includes('inline')) missing.push(`${name}:saveMode=inline`);
            if (!((properties?.humanAssistance?.enum ?? []) as string[]).includes('never')) missing.push(`${name}:humanAssistance=never`);
        }
        if (name === 'web_extract_tables') {
            if (!['markdown', 'csv', 'json'].every(value => ((properties?.format?.enum ?? []) as string[]).includes(value))) missing.push(`${name}:format`);
            if (!['file', 'inline'].every(value => ((properties?.saveMode?.enum ?? []) as string[]).includes(value))) missing.push(`${name}:saveMode`);
            if (!((properties?.humanAssistance?.enum ?? []) as string[]).includes('never')) missing.push(`${name}:humanAssistance=never`);
        }
    }
    const missingEphemeral: string[] = [];
    for (const name of toolNames) {
        const properties = tools.find(tool => tool.name === name)?.inputSchema.properties as Record<string, Record<string, unknown>> | undefined;
        if (properties?.ephemeralContent?.type !== 'boolean') missingEphemeral.push(`${name}:ephemeralContent`);
        if (!((properties?.saveMode?.enum ?? []) as string[]).includes('inline')) missingEphemeral.push(`${name}:saveMode=inline`);
    }
    const normal = inspectNativeWebSessionContract(tools);
    const coreManaged = Boolean(coreIssuerId) && normal.normalSessionCalls
        && toolNames.every(name => name === 'web_interact' || name === 'web_pipeline') && missing.length > 0
        && missing.every(field => /:(?:requestId|leaseUntil|hardLeaseUntil|renew)$/.test(field));
    return { enabled: !missing.length || coreManaged, missing: coreManaged ? [] : missing,
        leaseMode: coreManaged ? 'core' : 'native', upstreamMissing: missing,
        ephemeralContent: !missing.length && !missingEphemeral.length, missingEphemeral,
        contractHash: createHash('sha256').update(canonicalJson(tools)).digest('hex'),
        callerSource: 'core_bound_caller', remoteAuthentication: 'not_provided' };
}

export async function nativeWebToolDefinitions(client: BrokerMcpClient, signal?: AbortSignal): Promise<BrokerToolDefinition[]> {
    const tools: BrokerToolDefinition[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
        const page = await client.listTools(cursor, signal);
        tools.push(...page.tools);
        cursor = page.nextCursor;
        if (cursor && cursors.has(cursor)) throw new AgentFault('TOOL_CAPABILITY_UNVERIFIED', '原生网页schema目录分页未前进');
        if (cursor) cursors.add(cursor);
    } while (cursor);
    return tools;
}

export async function bindNativeWebResourceCall(toolName: 'web_interact' | 'web_pipeline', args: Record<string, unknown>,
    context: BoundToolContext, reference: NativeWebReference = { kind: 'owned' }, hardLeaseUntil = context.deadlineAt): Promise<NativeWebCall> {
    assertOwnedWebArguments(toolName, args, context, true);
    if (!context.principalId || typeof context.assertCurrent !== 'function') throw new AgentFault('TOOL_CAPABILITY_UNVERIFIED', '持续网页需要Core绑定主体和当前动作核验', { field: 'core_bound_caller' });
    const hardExpiry = Date.parse(hardLeaseUntil ?? '');
    if (!Number.isFinite(hardExpiry) || hardExpiry <= Date.now()) throw new AgentFault('TOOL_CAPABILITY_UNVERIFIED', '持续网页需要Core批准且尚未到期的有限hardLeaseUntil', { field: 'hardLeaseUntil' });
    if (reference.kind === 'borrowed') {
        if (context.retention.mode === 'temporary') throw new AgentFault('TOOL_CAPABILITY_UNVERIFIED', '临时网页不得借用持久浏览器上下文', { field: 'reference' });
        if (!reference.externalId || !reference.backendOwnerId || args.url !== undefined) throw new AgentFault('INVALID_PARAMS', '借用网页仅接受Core绑定的原session/owner，保持原页不导航');
    } else {
        let url: URL;
        try { url = new URL(String(args.url)); } catch { throw new AgentFault('INVALID_PARAMS', '持续网页需要完整HTTP地址'); }
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new AgentFault('TOOL_CAPABILITY_UNVERIFIED', '持续网页当前只接受普通HTTP页面');
    }
    await context.assertCurrent();
    return { toolName, args: structuredClone(args), reference: structuredClone(reference), hardLeaseUntil: new Date(hardExpiry).toISOString(),
        caller: { source: 'core_bound_caller', principalId: context.principalId, conversationId: context.conversationId,
            runId: context.runId, rootRunId: context.rootRunId, actionId: context.actionId, runEpoch: context.runEpoch } };
}

export async function bindNativeWebArtifactCall(toolName: 'web_extract_tables' | 'web_download', args: Record<string, unknown>,
    context: BoundToolContext, hardLeaseUntil = context.deadlineAt): Promise<NativeWebCall> {
    if (toolName === 'web_extract_tables') assertNativeWebTableArguments(args, context);
    else if (Object.keys(args).some(field => !['url', 'timeout'].includes(field))) throw new AgentFault('TOOL_CAPABILITY_UNVERIFIED', '下载只接受普通URL和timeout，产物路径由Core及后端固定');
    if (!context.principalId || typeof context.assertCurrent !== 'function') throw new AgentFault('TOOL_CAPABILITY_UNVERIFIED', '表格原件需要Core绑定主体和当前动作', { field: 'core_bound_caller' });
    const hard = Date.parse(hardLeaseUntil ?? '');
    if (!Number.isFinite(hard) || hard <= Date.now()) throw new AgentFault('TOOL_CAPABILITY_UNVERIFIED', '表格原件需要尚未到期的可信hard期限', { field: 'hardLeaseUntil' });
    let url: URL;
    try { url = new URL(String(args.url)); } catch { throw new AgentFault('INVALID_PARAMS', '表格原件需要完整HTTP地址'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new AgentFault('TOOL_CAPABILITY_UNVERIFIED', '表格原件只接受普通HTTP来源');
    await context.assertCurrent();
    if (context.signal.aborted) throw new AgentFault('TOOL_CANCELLED', '原表格任务已取消');
    return { toolName, args: structuredClone(args), reference: { kind: 'owned' }, hardLeaseUntil: new Date(hard).toISOString(),
        caller: { source: 'core_bound_caller', principalId: context.principalId, conversationId: context.conversationId,
            runId: context.runId, rootRunId: context.rootRunId, actionId: context.actionId, runEpoch: context.runEpoch } };
}

export class NativeWebResourceAdapter implements ResourceAdapter {
    readonly adapterId: string;
    readonly supports: ResourceAdapter['supports'];
    private readonly outputs = new Map<string, { output: unknown; resourceId: string; principalId: string; conversationId: string; bytes: number }>();
    private readonly schemas: ReadonlyMap<string, Record<string, unknown>>;
    private normalSessions?: NativeWebSessionPort;
    private readonly expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();

    private constructor(readonly options: NativeWebAdapterOptions, readonly contract: NativeWebAdapterContract, tools: readonly BrokerToolDefinition[]) {
        this.adapterId = options.adapterId ?? 'web-native-sessions-v1';
        this.supports = { authenticated: true, findByRequest: true, finiteLease: true, status: true, renew: true, cancel: true,
            release: true, ephemeralContent: options.temporaryEnabled === true && contract.ephemeralContent === true && !!options.outputBudget };
        this.schemas = new Map(tools.map(tool => [tool.name, structuredClone(tool.inputSchema)]));
    }

    static async connect(options: NativeWebAdapterOptions): Promise<NativeWebResourceAdapter> {
        const tools = options.definitions ?? await nativeWebToolDefinitions(options.client);
        const contract = inspectNativeWebAdapterContract(tools, options.coreIssuerId, options.toolNames);
        if (!contract.enabled) throw new AgentFault('TOOL_CAPABILITY_UNVERIFIED', '真实原生网页尚缺请求/租期schema，持续入口保持unavailable', { missing: contract.missing });
        const adapter = new NativeWebResourceAdapter(options, contract, tools);
        if (contract.leaseMode === 'core') adapter.normalSessions = await NativeWebSessionPort.connect(options.client, options.resourceStore, adapter.adapterId);
        return adapter;
    }

    inputSchema(toolName: NativeWebToolName): Record<string, unknown> {
        const schema = this.schemas.get(toolName);
        if (!schema) throw new AgentFault('TOOL_CAPABILITY_UNVERIFIED', '原生网页缺少connect时已验证的schema', { toolName });
        return structuredClone(schema);
    }

    private async owned(resource: OwnedResource): Promise<void> {
        const saved = await this.options.resourceStore.get(resource.resourceId);
        if (!saved || saved.issuerId !== this.options.coreIssuerId || resource.issuerId !== saved.issuerId
            || ['principalId', 'conversationId', 'runId', 'rootRunId', 'runEpoch', 'actionId', 'requestId', 'argsHash', 'adapterId']
                .some(field => (saved as unknown as Record<string, unknown>)[field] !== (resource as unknown as Record<string, unknown>)[field])
            || resource.adapterId !== this.adapterId) throw new AgentFault('RESOURCE_IDENTITY_MISMATCH', '原生网页资源须来自同Store的Core绑定身份和原动作');
    }

    private owner(resource: OwnedResource): string {
        return typeof resource.receipt?.evidence.backendOwnerId === 'string' ? resource.receipt.evidence.backendOwnerId
            : `sandbox-agent:${createHash('sha256').update(canonicalJson([resource.issuerId, resource.principalId, resource.conversationId, resource.runId, resource.requestId])).digest('hex')}`;
    }

    private async invoke(name: string, args: Record<string, unknown>, signal = new AbortController().signal): Promise<unknown> {
        const schema = this.schemas.get(name);
        if (!schema) throw new AgentFault('TOOL_CAPABILITY_UNVERIFIED', '原生网页缺少已核验schema', { name });
        validateToolArguments(args, schema);
        return this.options.client.invoke(name, args, signal);
    }

    private clearExpiry(resourceId: string): void {
        clearTimeout(this.expiryTimers.get(resourceId));
        this.expiryTimers.delete(resourceId);
    }

    private armExpiry(resource: OwnedResource, retry = false): void {
        this.clearExpiry(resource.resourceId);
        const timer = setTimeout(() => {
            this.expiryTimers.delete(resource.resourceId);
            void (async () => {
                const current = await this.options.resourceStore.get(resource.resourceId);
                if (!current || current.state === 'released') return;
                await this.owned(current);
                if (Date.parse(current.leaseUntil) > Date.now()) { this.armExpiry(current); return; }
                const closed = await this.normalSessions!.close(current, current);
                if (closed.receipt?.released && closed.receipt.terminalConfirmed) this.discardOutput(current.requestId);
            })().catch(() => { this.armExpiry(resource, true); });
        }, retry ? 30000 : Math.max(1, Math.min(2147483647, Date.parse(resource.leaseUntil) - Date.now())));
        timer.unref();
        this.expiryTimers.set(resource.resourceId, timer);
    }

    private async normalReceipt(resource: OwnedResource, leaseUntil = resource.leaseUntil): Promise<ResourceReceipt | null> {
        const found = await this.normalSessions!.findByRequest(resource, resource);
        if (!found?.receipt) return null;
        const receipt: ResourceReceipt = { ...found.receipt, evidence: { ...found.receipt.evidence,
            requestId: resource.requestId, leaseUntil,
            hardLeaseUntil: resource.receipt?.evidence.hardLeaseUntil ?? resource.leaseUntil,
            contractHash: this.contract.contractHash, leaseMode: 'core', remoteLeaseEnforced: 'false',
            backendIdleExpiry: 'upstream-default', callerSource: 'core_bound_caller', remoteAuthentication: 'not_provided' } };
        if (receipt.released) this.clearExpiry(resource.resourceId);
        else this.armExpiry({ ...found, leaseUntil });
        return receipt;
    }

    private parse(resource: OwnedResource, result: unknown, ownerId = this.owner(resource), hardLeaseUntil?: string): ResourceReceipt | null {
        const structured = object(object(result)?.structuredContent);
        const expectedInstance = resource.receipt?.evidence.backendInstanceId;
        if (expectedInstance && structured?.backendInstanceId && structured.backendInstanceId !== expectedInstance) {
            throw new AgentFault('RESOURCE_UNRESOLVED', '网页后端实例已改变，原请求终态保留未知', { requestId: resource.requestId }, true);
        }
        const entries = structured?.requests;
        if (!Array.isArray(entries)) throw new AgentFault('RESOURCE_UNRESOLVED', '原生网页响应缺少structuredContent.requests', { field: 'requests' }, true);
        const matches = entries.filter(entry => entry?.ownerId === ownerId && entry?.requestId === resource.requestId) as NativeReceipt[];
        if (!matches.length) return null;
        const receipt = matches[0];
        if (resource.retention.mode === 'temporary' && receipt.ephemeralContent !== true && (receipt.started || !receipt.released)) {
            throw new AgentFault('RESOURCE_UNRESOLVED', '临时原请求尚未确认无正文落盘分支', { requestId: resource.requestId, field: 'ephemeralContent' }, true);
        }
        const hard = Date.parse(hardLeaseUntil ?? String(resource.receipt?.evidence.hardLeaseUntil ?? receipt.hardLeaseUntil));
        if (matches.length !== 1 || !receipt.backendInstanceId || expectedInstance && receipt.backendInstanceId !== expectedInstance
            || !['pending', 'active', 'closing', 'released'].includes(receipt.state) || typeof receipt.started !== 'boolean'
            || !Number.isFinite(Date.parse(receipt.leaseUntil)) || !Number.isFinite(Date.parse(receipt.hardLeaseUntil))
            || Date.parse(receipt.leaseUntil) > Date.parse(receipt.hardLeaseUntil) || (!receipt.released || receipt.started) && Date.parse(receipt.hardLeaseUntil) > hard
            || receipt.released !== (receipt.state === 'released') || receipt.terminalConfirmed !== receipt.released
            || receipt.state === 'active' && !receipt.sessionId) throw new AgentFault('RESOURCE_UNRESOLVED', '原生网页回执字段、身份或期限尚不完整', { requestId: resource.requestId }, true);
        if (receipt.artifacts !== undefined && !Array.isArray(receipt.artifacts)) throw new AgentFault('RESOURCE_UNRESOLVED', '原生表格artifacts须为结构化原件数组', { field: 'artifacts' }, true);
        const outputRefs = receipt.artifacts?.map(artifact => {
            if (artifact.ownerId !== ownerId || artifact.requestId !== resource.requestId
                || (resource.retention.mode === 'temporary' ? artifact.inline !== true || artifact.path !== undefined : typeof artifact.path !== 'string')
                || typeof artifact.mimeType !== 'string' || !/^[a-f0-9]{64}$/i.test(artifact.sha256)
                || !Number.isSafeInteger(artifact.byteLength) || artifact.byteLength < 0) {
                throw new AgentFault('RESOURCE_UNRESOLVED', '原生表格回执缺少所属请求、原字节SHA或长度', { field: 'artifacts' }, true);
            }
            return { ...(artifact.path ? { path: artifact.path } : { inline: true }), mimeType: artifact.mimeType, sha256: artifact.sha256.toLowerCase(), byteLength: artifact.byteLength };
        });
        return { externalId: receipt.sessionId, started: receipt.started, terminalConfirmed: receipt.terminalConfirmed, released: receipt.released,
            evidence: { ...resource.receipt?.evidence, operation: `native-request-${receipt.state}`, requestId: resource.requestId,
                ...(outputRefs ? { outputRefs } : {}), ...(receipt.outcome ? { backendOutcome: receipt.outcome } : {}), ...(receipt.empty ? { emptyArtifact: 'true' } : {}),
                backendOwnerId: ownerId, backendInstanceId: receipt.backendInstanceId, leaseUntil: receipt.leaseUntil,
                hardLeaseUntil: receipt.hardLeaseUntil, contractHash: this.contract.contractHash,
                callerSource: 'core_bound_caller', remoteAuthentication: 'not_provided' } };
    }

    async create(resource: OwnedResource, parameters: Record<string, unknown>, signal: AbortSignal): Promise<ResourceReceipt> {
        await this.owned(resource);
        if (!this.options.outputBudget) throw new AgentFault('TOOL_CAPABILITY_UNVERIFIED', '网页原输出尚未接入Core根临时内存预算', { field: 'outputBudget' });
        const call = parameters as NativeWebCall;
        const temporary = resource.retention.mode === 'temporary';
        if (temporary && !this.supports.ephemeralContent) throw new AgentFault('TOOL_CAPABILITY_UNVERIFIED', '临时网页原生schema尚未核全', { missing: this.contract.missingEphemeral });
        if (!(this.options.toolNames ?? ['web_interact', 'web_pipeline']).includes(call.toolName) || !call.caller || call.caller.source !== 'core_bound_caller'
            || ['principalId', 'conversationId', 'runId', 'rootRunId', 'actionId', 'runEpoch'].some(field =>
                (call.caller as unknown as Record<string, unknown>)[field] !== (resource as unknown as Record<string, unknown>)[field])) {
            throw new AgentFault('RESOURCE_IDENTITY_MISMATCH', '原生网页参数须由当前Core绑定调用方提供');
        }
        if (!Number.isFinite(Date.parse(call.hardLeaseUntil)) || Date.parse(resource.leaseUntil) > Date.parse(call.hardLeaseUntil)) {
            throw new AgentFault('TOOL_CAPABILITY_UNVERIFIED', '实际资源租期须在Core批准的有限hard预算内', { field: 'hardLeaseUntil' });
        }
        const ownerId = call.reference.kind === 'borrowed' ? call.reference.backendOwnerId! : this.owner(resource);
        resource.receipt = { started: null, terminalConfirmed: false, released: false, evidence: { toolName: call.toolName,
            requestId: resource.requestId, backendOwnerId: ownerId, hardLeaseUntil: call.hardLeaseUntil,
            referenceKind: call.reference.kind, callerSource: 'core_bound_caller', remoteAuthentication: 'not_provided', contractHash: this.contract.contractHash } };
        await this.options.resourceStore.put(resource);
        if (this.normalSessions) this.armExpiry(resource);
        const args = { ...call.args, ownerId,
            ...(!this.normalSessions ? { requestId: resource.requestId, leaseUntil: resource.leaseUntil, hardLeaseUntil: call.hardLeaseUntil } : {}),
            ...(temporary ? { ephemeralContent: true, saveMode: 'inline', ...(call.toolName !== 'web_download' ? { humanAssistance: 'never' } : {}) }
                : call.toolName !== 'web_download' ? { saveMode: call.toolName === 'web_extract_tables' ? 'file' : 'inline', humanAssistance: 'never' } : {}),
            ...(call.toolName === 'web_pipeline' ? { keepSession: true } : {}),
            ...(call.reference.kind === 'borrowed' ? { sessionId: call.reference.externalId } : {}) };
        const output = await this.invoke(call.toolName, args, signal);
        const receipt = this.normalSessions ? await this.normalReceipt(resource) : this.parse(resource, output, ownerId, call.hardLeaseUntil);
        if (!receipt) throw new AgentFault('RESOURCE_UNRESOLVED', '原网页创建尚无原request回执', { requestId: resource.requestId }, true);
        receipt.evidence.referenceKind = call.reference.kind;
        receipt.evidence.toolName = call.toolName;
        const bytes = measureCanonicalJsonBytes(output);
        this.options.outputBudget.reserve(resource.conversationId, bytes);
        this.discardOutput(resource.requestId);
        this.outputs.set(resource.requestId, { output, resourceId: resource.resourceId, principalId: resource.principalId,
            conversationId: resource.conversationId, bytes });
        await this.options.resourceStore.put({ ...resource, receipt });
        return receipt;
    }

    async findByRequest(resource: OwnedResource): Promise<ResourceReceipt | null> {
        await this.owned(resource);
        if (this.normalSessions) return this.normalReceipt(resource);
        return this.parse(resource, await this.invoke('web_list_sessions', { ownerId: this.owner(resource), requestId: resource.requestId, includeAllOwners: false }));
    }

    async status(resource: OwnedResource): Promise<ResourceReceipt> {
        const receipt = await this.findByRequest(resource);
        if (!receipt) throw new AgentFault('RESOURCE_UNRESOLVED', '原request在当前后端未查回，保留未知状态', { requestId: resource.requestId }, true);
        return receipt;
    }

    async renew(resource: OwnedResource, leaseUntil: string): Promise<ResourceReceipt> {
        await this.owned(resource);
        const hard = resource.receipt?.evidence.hardLeaseUntil;
        if (typeof hard !== 'string' || Date.parse(leaseUntil) > Date.parse(hard)) throw new AgentFault('RESOURCE_LEASE_BUDGET', '续租将超过原先批准的hard预算', { field: 'leaseUntil', hardLeaseUntil: hard });
        if (this.normalSessions) {
            const receipt = await this.normalReceipt(resource, leaseUntil);
            if (!receipt) throw new AgentFault('RESOURCE_UNRESOLVED', '原会话尚未查回，保留原请求且停止续租', { requestId: resource.requestId }, true);
            return receipt;
        }
        const receipt = this.parse(resource, await this.invoke('web_interact', { ownerId: this.owner(resource), requestId: resource.requestId, action: 'renew', leaseUntil }));
        if (!receipt) throw new AgentFault('RESOURCE_UNRESOLVED', '续租缺少原request回执', { requestId: resource.requestId }, true);
        return receipt;
    }

    async cancel(resource: OwnedResource): Promise<ResourceReceipt> {
        await this.owned(resource);
        if (this.normalSessions) {
            const closed = await this.normalSessions.close(resource, resource);
            if (!closed.receipt) throw new AgentFault('RESOURCE_UNRESOLVED', '原会话关闭尚无回执', { requestId: resource.requestId }, true);
            if (closed.receipt.released && closed.receipt.terminalConfirmed) {
                this.clearExpiry(resource.resourceId);
                if (!this.options.preserveOutputOnCancel) this.discardOutput(resource.requestId);
            }
            return closed.receipt;
        }
        const receipt = this.parse(resource, await this.invoke('web_close_sessions', { ownerId: this.owner(resource), requestId: resource.requestId, closeAllForOwner: false }));
        if (!receipt) throw new AgentFault('RESOURCE_UNRESOLVED', '取消缺少原request终态', { requestId: resource.requestId }, true);
        if (!this.options.preserveOutputOnCancel && receipt.released && receipt.terminalConfirmed) this.discardOutput(resource.requestId);
        return receipt;
    }

    async release(resource: OwnedResource): Promise<ResourceReceipt> {
        await this.owned(resource);
        if (resource.receipt?.released && resource.receipt.terminalConfirmed) {
            if (!this.options.preserveOutputOnCancel) this.discardOutput(resource.requestId);
            return structuredClone(resource.receipt);
        }
        return this.cancel(resource);
    }

    async prepareTemporaryClose(resource: OwnedResource): Promise<ResourceReceipt> {
        await this.owned(resource);
        if (resource.receipt?.released && resource.receipt.terminalConfirmed) return structuredClone(resource.receipt);
        const receipt = this.parse(resource, await this.invoke('web_close_sessions', {
            ownerId: this.owner(resource), requestId: resource.requestId, closeAllForOwner: false }));
        if (!receipt) throw new AgentFault('CLEANUP_UNCONFIRMED', '临时原请求尚无关闭回执，原字节及映射保留', { requestId: resource.requestId }, true);
        return receipt;
    }

    releaseTemporaryOutput(resource: OwnedResource): void { this.discardOutput(resource.requestId, resource); }

    peekOutput(requestId: string): unknown { return this.outputs.get(requestId)?.output; }

    discardOutput(requestId: string, resource?: OwnedResource): void {
        const retained = this.outputs.get(requestId);
        if (!retained) return;
        if (resource && (resource.requestId !== requestId || retained.resourceId !== resource.resourceId
            || retained.principalId !== resource.principalId || retained.conversationId !== resource.conversationId
            || resource.issuerId !== this.options.coreIssuerId || resource.adapterId !== this.adapterId)) {
            throw new AgentFault('RESOURCE_IDENTITY_MISMATCH', '释放临时原输出须保留原CID、主体和资源身份');
        }
        this.options.outputBudget!.release(retained.conversationId, retained.bytes);
        this.outputs.delete(requestId);
    }

    takeOutput(requestId: string): unknown { const result = this.peekOutput(requestId); this.discardOutput(requestId); return result; }

    inlineArtifacts(requestId: string): readonly Record<string, unknown>[] {
        const values = object(object(this.peekOutput(requestId))?.structuredContent)?.inlineArtifacts;
        return Array.isArray(values) ? values : [];
    }
}

export interface NativeWebDispatch {
    adapter: NativeWebResourceAdapter;
    registry: ResourceRegistry;
    toolName: 'web_interact' | 'web_pipeline';
    args: Record<string, unknown>;
    context: BoundToolContext;
    reference?: NativeWebReference;
    hardLeaseUntil?: string;
}

export async function dispatchNativeWebResource(input: NativeWebDispatch): Promise<Record<string, unknown>> {
    if (input.registry.store !== input.adapter.options.resourceStore) throw new AgentFault('INVALID_PARAMS', '原生网页与Registry须共用原ResourceStorePort');
    const call = await bindNativeWebResourceCall(input.toolName, input.args, input.context, input.reference, input.hardLeaseUntil);
    let resource = await input.registry.create(input.adapter.adapterId, input.toolName, call, input.context);
    const output = input.adapter.takeOutput(resource.requestId);
    if (output === undefined) resource = await input.registry.reconcile(resource.resourceId, input.context);
    return { ...(object(output) ?? { content: [{ type: 'text', text: '已沿原request查回网页资源，未重复创建页面' }] }),
        structuredContent: { ...object(object(output)?.structuredContent), ownedResource: { resourceId: resource.resourceId,
            requestId: resource.requestId, leaseUntil: resource.leaseUntil, state: resource.state, cleanupState: resource.cleanupState,
            externalId: resource.externalId, ownerId: resource.receipt?.evidence.backendOwnerId,
            recovered: output === undefined, callerSource: 'core_bound_caller', remoteAuthentication: 'not_provided' } } };
}

export function createLazyNativeWebResourceFactory(options: Omit<NativeWebAdapterOptions, 'client'> & { getClient: () => Promise<BrokerMcpClient> }) {
    let adapter: NativeWebResourceAdapter | undefined;
    let pending: Promise<NativeWebResourceAdapter> | undefined;
    const registries = new WeakSet<ResourceRegistry>();
    const get = async (): Promise<{ adapter: NativeWebResourceAdapter; specs: SharedToolSpec[] }> => {
        if (!adapter) {
            pending ??= options.getClient().then(client => NativeWebResourceAdapter.connect({ ...options, client }));
            try { adapter = await pending; } finally { pending = undefined; }
        }
        return { adapter, specs: verifiedPersistentWebToolSpecs(adapter) };
    };
    return { get, async dispatch(input: Omit<NativeWebDispatch, 'adapter'>): Promise<Record<string, unknown>> {
        const ready = await get();
        if (!registries.has(input.registry)) { input.registry.register(ready.adapter); registries.add(input.registry); }
        return dispatchNativeWebResource({ ...input, adapter: ready.adapter });
    } };
}
