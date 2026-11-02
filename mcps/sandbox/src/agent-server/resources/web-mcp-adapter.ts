import { createHash } from 'node:crypto';
import { open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { AgentFault, canonicalJson } from '../protocol.js';
import { assertNotProtected, isWithin } from '../security/policy.js';
import type { BrokerMcpClient, BrokerToolDefinition } from '../tools/broker-client.js';
import { validateToolArguments } from '../tools/schema-cache.js';
import type { BoundToolContext } from '../tools/types.js';
import type { OwnedResource, ResourceAdapter, ResourceReceipt, ResourceStorePort } from './registry.js';

export const ownedWebToolNames = ['web_interact', 'web_pipeline', 'web_fetch_screenshot'] as const;
export type OwnedWebToolName = typeof ownedWebToolNames[number];
export type WebResourceReference = { kind: 'owned' } | { kind: 'borrowed'; externalId: string };

export interface WebResourceVerification {
    source: 'self_owned_http_mcp' | 'verified_service';
    evidenceRef: string;
    authenticated: boolean;
    finiteLease: boolean;
    borrowedReferenceRelease: boolean;
}

export interface WebMcpResourceOptions {
    adapterId: string;
    lifecycleTool: string;
    verification: WebResourceVerification;
    resourceStore: ResourceStorePort;
    now?: () => number;
}

export interface WebResourceCall {
    toolName: OwnedWebToolName;
    args: Record<string, unknown>;
    outputRoot: string;
    reference: WebResourceReference;
}

export interface WebResourceOutputReference {
    path: string;
    mimeType?: string;
    sha256: string;
    byteLength: number;
}

export interface WebResourceContractReport { enabled: boolean; missing: string[]; contractHash: string }

const lifecycleActions = ['find_by_request', 'status', 'renew', 'cancel', 'release'];
const scopeFields = ['resourceId', 'issuerId', 'principalId', 'conversationId', 'runId', 'rootRunId', 'runEpoch', 'actionId', 'requestId', 'leaseUntil'];

export function inspectWebResourceContract(tools: readonly BrokerToolDefinition[], options: WebMcpResourceOptions): WebResourceContractReport {
    const missing: string[] = [];
    for (const name of [...ownedWebToolNames, options.lifecycleTool]) {
        const schema = tools.find(tool => tool.name === name)?.inputSchema;
        if (!schema) { missing.push(`${name}:tools/list`); continue; }
        const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
        const scope = properties.resourceContext;
        const required = (scope?.required ?? []) as string[];
        if (!((schema.required ?? []) as string[]).includes('resourceContext') || scopeFields.some(field => !required.includes(field))) {
            missing.push(`${name}:resourceContext`);
        }
        if (name === options.lifecycleTool) {
            const actions = properties.action?.enum as string[] | undefined;
            if (!actions || lifecycleActions.some(action => !actions.includes(action))) missing.push(`${name}:lifecycle-actions`);
        }
    }
    const proof = options.verification;
    if (!options.adapterId || !options.lifecycleTool || !proof.evidenceRef || !['self_owned_http_mcp', 'verified_service'].includes(proof.source)) missing.push('verification:evidence');
    if (!proof.authenticated) missing.push('verification:authenticated');
    if (!proof.finiteLease) missing.push('verification:finiteLease');
    if (!proof.borrowedReferenceRelease) missing.push('verification:borrowedReferenceRelease');
    return { enabled: missing.length === 0, missing,
        contractHash: createHash('sha256').update(canonicalJson({ tools, lifecycleTool: options.lifecycleTool })).digest('hex') };
}

export async function assertWebOutputRoot(outputRoot: string, context: BoundToolContext): Promise<string> {
    if (!path.isAbsolute(outputRoot)) throw new AgentFault('TOOL_NOT_ALLOWED', '网页产物根须由可信核心提供完整路径');
    const canonical = await realpath(outputRoot);
    assertNotProtected(canonical, context);
    if (!(await stat(canonical)).isDirectory()) throw new AgentFault('TOOL_NOT_ALLOWED', '网页产物根须为已存在的获准目录');
    const roots = await Promise.all(context.roots.map(root => realpath(root)));
    if (!roots.some(root => isWithin(canonical, root))) throw new AgentFault('TOOL_NOT_ALLOWED', '网页产物根尚未获准写入');
    return canonical;
}

export class WebMcpResourceAdapter implements ResourceAdapter {
    readonly supports = { authenticated: true, findByRequest: true, finiteLease: true, status: true,
        renew: true, cancel: true, release: true, ephemeralContent: false };
    readonly adapterId: string;
    private readonly outputs = new Map<string, unknown>();
    private readonly schemas = new Map<string, Record<string, unknown>>();

    private constructor(readonly client: BrokerMcpClient, readonly options: WebMcpResourceOptions, readonly contract: WebResourceContractReport,
        tools: readonly BrokerToolDefinition[]) {
        this.adapterId = options.adapterId;
        for (const tool of tools) if (tool.name === options.lifecycleTool || ownedWebToolNames.includes(tool.name as OwnedWebToolName)) {
            this.schemas.set(tool.name, structuredClone(tool.inputSchema));
        }
    }

    static async connect(client: BrokerMcpClient, options: WebMcpResourceOptions): Promise<WebMcpResourceAdapter> {
        const tools: BrokerToolDefinition[] = [];
        const seen = new Set<string>();
        let cursor: string | undefined;
        do {
            const page = await client.listTools(cursor);
            tools.push(...page.tools);
            cursor = page.nextCursor;
            if (cursor && seen.has(cursor)) throw new AgentFault('TOOL_CAPABILITY_UNVERIFIED', '网页MCP目录分页未前进');
            if (cursor) seen.add(cursor);
        } while (cursor);
        const report = inspectWebResourceContract(tools, options);
        if (!report.enabled) throw new AgentFault('TOOL_CAPABILITY_UNVERIFIED', '网页持续资源合同尚未完整验证，入口保持关闭', { missing: report.missing });
        return new WebMcpResourceAdapter(client, { ...options, verification: structuredClone(options.verification) }, report, tools);
    }

    private async invoke(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
        const schema = this.schemas.get(name);
        if (!schema) throw new AgentFault('TOOL_CAPABILITY_UNVERIFIED', '网页工具尚无固定的原生schema');
        validateToolArguments(args, schema);
        return this.client.invoke(name, args, signal);
    }

    private scope(resource: OwnedResource, leaseUntil = resource.leaseUntil): Record<string, unknown> {
        return { resourceId: resource.resourceId, issuerId: resource.issuerId, principalId: resource.principalId,
            conversationId: resource.conversationId, runId: resource.runId, rootRunId: resource.rootRunId,
            runEpoch: resource.runEpoch, actionId: resource.actionId, requestId: resource.requestId, leaseUntil };
    }

    private receipt(result: unknown, resource: OwnedResource, operation: string, leaseUntil = resource.leaseUntil): ResourceReceipt | null {
        const response = result as { isError?: boolean; structuredContent?: { resource?: Record<string, unknown> | null } };
        const receipt = response?.structuredContent?.resource;
        if (receipt === null && operation === 'find_by_request' && response.isError !== true) return null;
        if (response?.isError || !receipt || scopeFields.filter(field => field !== 'leaseUntil').some(field => receipt[field] !== this.scope(resource)[field])
            || typeof receipt.externalId !== 'string' || !receipt.externalId
            || (receipt.started !== null && typeof receipt.started !== 'boolean')
            || typeof receipt.terminalConfirmed !== 'boolean' || typeof receipt.released !== 'boolean'
            || !['owned', 'borrowed'].includes(String(receipt.referenceKind))) {
            throw new AgentFault('RESOURCE_UNRESOLVED', '网页回执缺少可核对的原请求身份或终态', { requestId: resource.requestId }, true);
        }
        const expiry = Date.parse(String(receipt.leaseUntil));
        if (!Number.isFinite(expiry) || expiry > Date.parse(leaseUntil)
            || (!receipt.terminalConfirmed && expiry <= (this.options.now ?? Date.now)())) {
            throw new AgentFault('RESOURCE_UNRESOLVED', '网页回执未确认请求限定的有效租期', { requestId: resource.requestId }, true);
        }
        if (resource.receipt?.evidence.referenceKind && resource.receipt.evidence.referenceKind !== receipt.referenceKind) {
            throw new AgentFault('RESOURCE_IDENTITY_MISMATCH', '网页资源原引用类型发生变化', {}, true);
        }
        return { externalId: receipt.externalId, started: receipt.started as boolean | null,
            terminalConfirmed: receipt.terminalConfirmed, released: receipt.released,
            evidence: { toolName: String(receipt.toolName ?? ''), operation, requestId: resource.requestId,
                leaseUntil: receipt.leaseUntil, referenceKind: receipt.referenceKind, contractHash: this.contract.contractHash,
                ...(resource.receipt?.evidence.outputRoot ? { outputRoot: resource.receipt.evidence.outputRoot } : {}),
                ...(resource.receipt?.evidence.outputRefs ? { outputRefs: structuredClone(resource.receipt.evidence.outputRefs) } : {}) } };
    }

    async create(resource: OwnedResource, parameters: Record<string, unknown>, signal: AbortSignal): Promise<ResourceReceipt> {
        if (resource.retention.mode === 'temporary') throw new AgentFault('TOOL_CAPABILITY_UNVERIFIED', '临时网页会话尚无无正文落盘保证，保持关闭');
        const call = parameters as unknown as WebResourceCall;
        if (!ownedWebToolNames.includes(call.toolName) || !call.args || !path.isAbsolute(call.outputRoot)
            || !call.reference || !['owned', 'borrowed'].includes(call.reference.kind)) throw new AgentFault('INVALID_PARAMS', '网页资源需由可信适配层绑定工具、产物根和引用');
        resource = { ...resource, receipt: { started: null, terminalConfirmed: false, released: false,
            evidence: { toolName: call.toolName, outputRoot: call.outputRoot, referenceKind: call.reference.kind, requestId: resource.requestId } } };
        await this.options.resourceStore.put(resource);
        const result = await this.invoke(call.toolName, { ...call.args,
            resourceContext: { ...this.scope(resource), retention: resource.retention, outputRoot: call.outputRoot, reference: call.reference } }, signal);
        const receipt = this.receipt(result, resource, 'create')!;
        if (receipt.evidence.toolName !== call.toolName || (call.reference.kind === 'borrowed' && receipt.externalId !== call.reference.externalId)) {
            throw new AgentFault('RESOURCE_IDENTITY_MISMATCH', '网页回执的原工具或借用页面发生变化', {}, true);
        }
        const outputRefs = await this.validateOutputs(result, call.outputRoot, true, signal);
        const screenshotRequested = call.toolName === 'web_fetch_screenshot' || ['screenshot', 'snapshot'].includes(String(call.args.action))
            || (Array.isArray(call.args.steps) && call.args.steps.some(step => ['screenshot', 'snapshot'].includes(String(step?.action))));
        if (screenshotRequested
            && (!Array.isArray(outputRefs) || outputRefs.length === 0)) throw new AgentFault('RESOURCE_UNRESOLVED', '网页截图尚无所属产物引用', {}, true);
        receipt.evidence.outputRefs = outputRefs ?? [];
        this.outputs.set(resource.requestId, result);
        return receipt;
    }

    private async validateOutputs(result: unknown, outputRoot: string, checkFiles = true, signal?: AbortSignal): Promise<Record<string, unknown>[] | undefined> {
        const outputRefs = (result as { structuredContent?: { outputRefs?: unknown } }).structuredContent?.outputRefs;
        if (outputRefs === undefined) return undefined;
        if (!Array.isArray(outputRefs)) throw new AgentFault('RESOURCE_UNRESOLVED', '网页产物引用结构待核实', {}, true);
        const references: Record<string, unknown>[] = [];
        for (const output of outputRefs as { path?: unknown; mimeType?: unknown; sha256?: unknown; byteLength?: unknown }[]) {
            if (signal?.aborted) throw new AgentFault('TOOL_CANCELLED', '网页产物核对已取消，原请求保留供查回');
            if (!output || typeof output.path !== 'string' || !path.isAbsolute(output.path) || !isWithin(output.path, outputRoot)) {
                throw new AgentFault('RESOURCE_UNRESOLVED', '网页产物未归入当前获准根', {}, true);
            }
            const canonical = checkFiles ? await realpath(output.path) : path.resolve(output.path);
            if (checkFiles && (!isWithin(canonical, outputRoot) || !(await stat(canonical)).isFile())) {
                throw new AgentFault('RESOURCE_UNRESOLVED', '网页产物引用尚未确认为获准普通文件', {}, true);
            }
            let byteLength = output.byteLength;
            let sha256 = output.sha256;
            if (checkFiles) {
                const file = await open(canonical, 'r');
                try {
                    const before = await file.stat();
                    const checksum = createHash('sha256');
                    let length = 0;
                    for await (const bytes of file.createReadStream({ autoClose: false })) {
                        if (signal?.aborted) throw new AgentFault('TOOL_CANCELLED', '网页产物核对已取消，原请求保留供查回');
                        checksum.update(bytes);
                        length += bytes.length;
                    }
                    const after = await file.stat();
                    if (!before.isFile() || before.size !== length || before.size !== after.size || before.mtimeMs !== after.mtimeMs
                        || before.ctimeMs !== after.ctimeMs || before.dev !== after.dev || before.ino !== after.ino) {
                        throw new AgentFault('RESOURCE_ARTIFACT_CHANGED', '网页产物在核对期间发生变化，原请求和引用保留', {}, true);
                    }
                    const actualHash = checksum.digest('hex');
                    if (sha256 !== undefined && sha256 !== actualHash || byteLength !== undefined && byteLength !== length) {
                        throw new AgentFault('RESOURCE_ARTIFACT_CHANGED', '网页产物与已固定SHA或字节数不同，原引用保留', {}, true);
                    }
                    sha256 = actualHash;
                    byteLength = length;
                } finally { await file.close(); }
            }
            references.push({ path: canonical, ...(typeof output.mimeType === 'string' ? { mimeType: output.mimeType } : {}),
                ...(typeof sha256 === 'string' ? { sha256 } : {}), ...(typeof byteLength === 'number' ? { byteLength } : {}) });
        }
        return references;
    }

    async verifyOutputReferences(resource: OwnedResource, signal?: AbortSignal): Promise<WebResourceOutputReference[]> {
        const outputRoot = resource.receipt?.evidence.outputRoot;
        const outputRefs = resource.receipt?.evidence.outputRefs;
        if (!Array.isArray(outputRefs) || !outputRefs.length) return [];
        if (typeof outputRoot !== 'string') throw new AgentFault('RESOURCE_UNRESOLVED', '网页原件引用缺少原获准产物根', {}, true);
        return await this.validateOutputs({ structuredContent: { outputRefs } }, outputRoot, true, signal) as unknown as WebResourceOutputReference[];
    }

    takeOutput(requestId: string): unknown {
        const result = this.outputs.get(requestId);
        this.outputs.delete(requestId);
        return result;
    }

    private async control(resource: OwnedResource, action: string, leaseUntil = resource.leaseUntil): Promise<ResourceReceipt | null> {
        const result = await this.invoke(this.options.lifecycleTool,
            { action, resourceContext: this.scope(resource, leaseUntil) }, new AbortController().signal);
        const receipt = this.receipt(result, resource, action, leaseUntil);
        if (receipt && typeof receipt.evidence.outputRoot === 'string') {
            const references = await this.validateOutputs(result, receipt.evidence.outputRoot, false);
            if (references?.length) {
                const pinned = resource.receipt?.evidence.outputRefs as Record<string, unknown>[] | undefined;
                receipt.evidence.outputRefs = references.map(reference => {
                    const original = pinned?.find(entry => entry.path === reference.path);
                    if (original && ((reference.sha256 !== undefined && reference.sha256 !== original.sha256)
                        || (reference.byteLength !== undefined && reference.byteLength !== original.byteLength))) {
                        throw new AgentFault('RESOURCE_ARTIFACT_CHANGED', '网页查回的产物身份与已固定引用不同', {}, true);
                    }
                    return original ? structuredClone(original) : reference;
                });
            }
        }
        if (receipt?.released && receipt.terminalConfirmed) this.outputs.delete(resource.requestId);
        return receipt;
    }

    async findByRequest(resource: OwnedResource): Promise<ResourceReceipt | null> { return this.control(resource, 'find_by_request'); }
    async status(resource: OwnedResource): Promise<ResourceReceipt> { return (await this.control(resource, 'status'))!; }
    async renew(resource: OwnedResource, leaseUntil: string): Promise<ResourceReceipt> { return (await this.control(resource, 'renew', leaseUntil))!; }
    async cancel(resource: OwnedResource): Promise<ResourceReceipt> {
        this.outputs.delete(resource.requestId);
        return (await this.control(resource, 'cancel'))!;
    }
    async release(resource: OwnedResource): Promise<ResourceReceipt> {
        this.outputs.delete(resource.requestId);
        return (await this.control(resource, 'release'))!;
    }
}
