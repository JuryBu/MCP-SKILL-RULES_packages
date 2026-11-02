import { createHash } from 'node:crypto';
import { AgentFault, canonicalJson } from '../protocol.js';
import type { BrokerMcpClient, BrokerToolDefinition } from '../tools/broker-client.js';
import type { BoundToolContext } from '../tools/types.js';
import { validateToolArguments } from '../tools/schema-cache.js';
import { webPersistentToolAllowedArguments } from '../tools/adapters/web.js';
import type { OwnedResource, ResourceStorePort } from './registry.js';

export interface NativeWebReference {
    kind: 'owned' | 'borrowed';
    externalId?: string;
    backendOwnerId?: string;
}

export interface NativeWebSessionContract {
    normalSessionCalls: boolean;
    enabled: false;
    missing: string[];
    contractHash: string;
}

export function nativeWebRequestHash(toolName: 'web_interact' | 'web_pipeline', args: Record<string, unknown>,
    reference: NativeWebReference, policyRevision: number): string {
    return createHash('sha256').update(canonicalJson({ toolName, args, reference, policyRevision })).digest('hex');
}

export function inspectNativeWebSessionContract(tools: readonly BrokerToolDefinition[]): NativeWebSessionContract {
    const required: Record<string, string[]> = { web_interact: ['ownerId', 'sessionId', 'url', 'action', 'saveMode', 'humanAssistance'],
        web_pipeline: ['ownerId', 'sessionId', 'url', 'steps', 'keepSession', 'saveMode', 'humanAssistance'],
        web_list_sessions: ['ownerId', 'includeAllOwners'], web_close_sessions: ['ownerId', 'sessionId', 'closeAllForOwner'] };
    const nativeMissing: string[] = [];
    for (const [name, fields] of Object.entries(required)) {
        const schema = tools.find(tool => tool.name === name)?.inputSchema;
        if (!schema || fields.some(field => !Object.hasOwn(schema.properties ?? {}, field))) nativeMissing.push(`${name}:native-schema`);
    }
    return { normalSessionCalls: !nativeMissing.length, enabled: false,
        missing: [...nativeMissing, 'authenticated-action-scope', 'inflight-request-status-and-cancel', 'requested-finite-lease-and-renew'],
        contractHash: createHash('sha256').update(canonicalJson(tools)).digest('hex') };
}

function text(result: unknown): string {
    const content = (result as { content?: { type?: string; text?: string }[] })?.content;
    return Array.isArray(content) ? content.filter(part => part.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n') : '';
}

export class NativeWebSessionPort {
    private constructor(readonly client: BrokerMcpClient, readonly store: ResourceStorePort,
        readonly contract: NativeWebSessionContract, readonly schemas: ReadonlyMap<string, Record<string, unknown>>,
        readonly adapterId: string) {}

    static async connect(client: BrokerMcpClient, store: ResourceStorePort, adapterId = 'web-native-sessions-v1'): Promise<NativeWebSessionPort> {
        const tools: BrokerToolDefinition[] = [];
        let cursor: string | undefined;
        const seen = new Set<string>();
        do {
            const page = await client.listTools(cursor);
            tools.push(...page.tools);
            cursor = page.nextCursor;
            if (cursor && seen.has(cursor)) throw new AgentFault('TOOL_CAPABILITY_UNVERIFIED', '原生网页目录分页未前进');
            if (cursor) seen.add(cursor);
        } while (cursor);
        const contract = inspectNativeWebSessionContract(tools);
        if (!contract.normalSessionCalls) throw new AgentFault('TOOL_CAPABILITY_UNVERIFIED', '原生网页会话调用尚缺真实参数结构', { missing: contract.missing });
        return new NativeWebSessionPort(client, store, contract, new Map(tools.map(tool => [tool.name, structuredClone(tool.inputSchema)])), adapterId);
    }

    private async invoke(name: string, args: Record<string, unknown>, signal = new AbortController().signal): Promise<unknown> {
        const schema = this.schemas.get(name);
        if (!schema) throw new AgentFault('TOOL_CAPABILITY_UNVERIFIED', '原生网页工具缺少已缓存schema', { name });
        validateToolArguments(args, schema);
        return this.client.invoke(name, args, signal);
    }

    private async owned(resource: OwnedResource, context: BoundToolContext): Promise<OwnedResource> {
        const saved = await this.store.get(resource.resourceId);
        if (!saved || saved.adapterId !== this.adapterId || saved.issuerId !== resource.issuerId || saved.principalId !== context.principalId
            || saved.conversationId !== context.conversationId || saved.rootRunId !== context.rootRunId
            || context.runId !== context.rootRunId && saved.runId !== context.runId) throw new AgentFault('RESOURCE_IDENTITY_MISMATCH', '原生网页映射须来自当前可信执行树');
        return saved;
    }

    private owner(resource: OwnedResource): string {
        return typeof resource.receipt?.evidence.backendOwnerId === 'string' ? resource.receipt.evidence.backendOwnerId
            : `sandbox-agent:${createHash('sha256').update(canonicalJson([resource.issuerId, resource.principalId,
                resource.conversationId, resource.runId, resource.requestId])).digest('hex')}`;
    }

    async findByRequest(resource: OwnedResource, context: BoundToolContext): Promise<OwnedResource | null> {
        resource = await this.owned(resource, context);
        if (resource.state === 'released') return resource;
        const ownerId = this.owner(resource);
        const response = await this.invoke('web_list_sessions', { ownerId, includeAllOwners: false });
        if ((response as { isError?: boolean })?.isError) throw new AgentFault('RESOURCE_UNRESOLVED', '原生会话查询尚未返回成功结果', { requestId: resource.requestId }, true);
        const body = text(response);
        const count = /活跃会话\s*\((\d+)\)/.exec(body);
        const sessions = [...body.matchAll(/^\d+\.\s+(session_[a-f0-9-]+)\s+ownerId=([^\s]+)\s+/gmi)]
            .filter(match => match[2] === ownerId).map(match => match[1]);
        if (!count || Number(count[1]) !== sessions.length || (resource.receipt?.evidence.referenceKind !== 'borrowed' && sessions.length > 1)) {
            throw new AgentFault('RESOURCE_UNRESOLVED', '原生owner查询尚无唯一完整会话结果，保留原requestId', { requestId: resource.requestId }, true);
        }
        const externalId = resource.externalId ? sessions.find(id => id === resource.externalId) : sessions[0];
        if (!externalId) {
            if (!resource.externalId || resource.receipt?.started !== true) return null;
            const released: OwnedResource = { ...resource, state: 'released', cleanupState: 'released', receipt: {
                externalId: resource.externalId, started: true, terminalConfirmed: true, released: true,
                evidence: { ...resource.receipt.evidence, operation: 'native-session-absent' } } };
            await this.store.put(released);
            return released;
        }
        const found: OwnedResource = { ...resource, externalId, state: 'active', cleanupState: 'pending', receipt: {
            externalId, started: true, terminalConfirmed: false, released: false, evidence: {
                ...resource.receipt?.evidence, operation: 'native-owner-query', requestId: resource.requestId,
                backendOwnerId: ownerId, contractHash: this.contract.contractHash } } };
        await this.store.put(found);
        return found;
    }

    async open(resource: OwnedResource, toolName: 'web_interact' | 'web_pipeline', args: Record<string, unknown>,
        context: BoundToolContext, reference: NativeWebReference = { kind: 'owned' }): Promise<{ resource: OwnedResource; output?: unknown; recovered: boolean }> {
        if (context.retention.mode === 'temporary') throw new AgentFault('TOOL_CAPABILITY_UNVERIFIED', '临时原生网页仍缺完整无正文落盘保证');
        if (resource.principalId !== context.principalId || resource.conversationId !== context.conversationId || resource.runId !== context.runId
            || resource.rootRunId !== context.rootRunId || resource.runEpoch !== context.runEpoch || resource.actionId !== context.actionId
            || resource.argsHash !== nativeWebRequestHash(toolName, args, reference, context.policyRevision)) {
            throw new AgentFault('RESOURCE_IDENTITY_MISMATCH', '原生网页须绑定当前动作和完整业务参数摘要');
        }
        if (reference.kind === 'owned') {
            let url: URL;
            try { url = new URL(String(args.url)); } catch { throw new AgentFault('INVALID_PARAMS', '原生网页需要完整HTTP地址'); }
            if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new AgentFault('TOOL_CAPABILITY_UNVERIFIED', '原生网页只接受普通HTTP页面');
        } else if (!reference.externalId || !reference.backendOwnerId || args.url !== undefined) {
            throw new AgentFault('INVALID_PARAMS', '借用网页须由可信调用方同时绑定原session及owner，保持原页不导航');
        }
        const fields = webPersistentToolAllowedArguments(toolName)!;
        if (Object.keys(args).some(field => !fields.includes(field))) throw new AgentFault('TOOL_CAPABILITY_UNVERIFIED', '原生网页只绑定已分类业务参数');
        if (toolName === 'web_interact' && !['content', 'visible', 'find', 'scroll', 'wait', 'screenshot', 'snapshot'].includes(String(args.action))) {
            throw new AgentFault('TOOL_CAPABILITY_UNVERIFIED', '原生网页当前只开放普通读取动作');
        }
        if (toolName === 'web_pipeline' && (!Array.isArray(args.steps) || args.steps.some(step => !step || typeof step !== 'object'
            || !['content', 'visible', 'find', 'scroll', 'wait', 'screenshot', 'snapshot', 'links'].includes(String(step.action))
            || Object.keys(step).some(field => !['action', 'selector', 'value', 'scrollCount', 'waitMs', 'fullPage'].includes(field))))) {
            throw new AgentFault('TOOL_CAPABILITY_UNVERIFIED', '原生pipeline只开放普通读取步骤');
        }
        await context.assertCurrent?.();
        if (context.signal.aborted) throw new AgentFault('TOOL_CANCELLED', '所属原生网页任务已取消');
        const allocated = await this.store.allocate(resource);
        resource = await this.owned(allocated.resource, context);
        if (allocated.reused) {
            const found = resource.state === 'released' ? resource : await this.findByRequest(resource, context);
            if (!found) throw new AgentFault('RESOURCE_UNRESOLVED', '原网页创建尚无法查回，保留原请求且不重新创建', { requestId: resource.requestId }, true);
            return { resource: found, recovered: true };
        }
        const ownerId = reference.kind === 'borrowed' ? reference.backendOwnerId! : this.owner(resource);
        resource.receipt = { started: null, terminalConfirmed: false, released: false,
            evidence: { backendOwnerId: ownerId, referenceKind: reference.kind, toolName, requestId: resource.requestId,
                contractHash: this.contract.contractHash } };
        resource.externalId = reference.kind === 'borrowed' ? reference.externalId : undefined;
        await this.store.put(resource);
        try {
            const output = await this.invoke(toolName, { ...args, ownerId, humanAssistance: 'never', saveMode: 'inline',
                ...(toolName === 'web_pipeline' ? { keepSession: true } : {}),
                ...(reference.kind === 'borrowed' ? { sessionId: reference.externalId } : {}) }, context.signal);
            const found = await this.findByRequest(resource, context);
            if (!found) throw new AgentFault('RESOURCE_UNRESOLVED', '原生网页响应尚无可核会话，保留原请求', { requestId: resource.requestId }, true);
            return { resource: found, output, recovered: false };
        } catch (error) {
            const latest = await this.owned(resource, context);
            if (latest.state !== 'released') await this.store.put({ ...latest, state: 'unresolved', cleanupState: 'unconfirmed' });
            throw error;
        }
    }

    async close(resource: OwnedResource, context: BoundToolContext): Promise<OwnedResource> {
        resource = await this.owned(resource, context);
        if (resource.state === 'released') return resource;
        if (resource.receipt?.evidence.referenceKind === 'borrowed') {
            const released: OwnedResource = { ...resource, state: 'released', cleanupState: 'released', receipt: {
                ...resource.receipt, terminalConfirmed: true, released: true,
                evidence: { ...resource.receipt.evidence, operation: 'local-reference-release' } } };
            await this.store.put(released);
            return released;
        }
        const found = await this.findByRequest(resource, context);
        if (!found) throw new AgentFault('RESOURCE_UNRESOLVED', '原网页创建仍在未知状态，当前关闭入口无法取消未知在途请求', { requestId: resource.requestId }, true);
        if (found.state === 'released') return found;
        await this.invoke('web_close_sessions', { ownerId: this.owner(found), sessionId: found.externalId, closeAllForOwner: false });
        const final = await this.findByRequest(found, context);
        if (!final || final.state !== 'released') throw new AgentFault('RESOURCE_UNRESOLVED', '已请求关闭原session，仍待原owner查询确认', { requestId: resource.requestId }, true);
        return final;
    }

    async closeRun(context: BoundToolContext): Promise<OwnedResource[]> {
        const resources = await this.store.list(context.conversationId, context.rootRunId);
        const results: OwnedResource[] = [];
        for (const resource of resources.reverse()) if (resource.adapterId === this.adapterId
            && (context.runId === context.rootRunId || resource.runId === context.runId)) {
            try { results.push(await this.close(resource, context)); }
            catch {
                const unresolved = { ...resource, state: 'unresolved' as const, cleanupState: 'unconfirmed' as const };
                await this.store.put(unresolved);
                results.push(unresolved);
            }
        }
        return results;
    }
}
