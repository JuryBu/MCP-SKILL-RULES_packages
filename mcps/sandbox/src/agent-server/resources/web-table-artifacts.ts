import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, realpath, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { AgentFault, canonicalJson } from '../protocol.js';
import type { JsonValue } from '../protocol.js';
import type { InputAttachmentService } from '../media/input-attachments.js';
import type { TemporaryBudgetPort } from '../media/temporary-budget.js';
import type { AttachmentModelSelection, InputAttachmentReference } from '../media/input-types.js';
import type { NativeSendView } from '../providers/types.js';
import { isWithin } from '../security/policy.js';
import type { BrokerMcpClient, BrokerToolDefinition } from '../tools/broker-client.js';
import type { BoundToolContext } from '../tools/types.js';
import { webToolSpecs } from '../tools/adapters/web.js';
import type { OwnedResource, ResourceAdapter, ResourceReceipt, ResourceRegistry, ResourceStorePort } from './registry.js';
import { bindNativeWebArtifactCall, inspectNativeWebAdapterContract, nativeWebToolDefinitions, NativeWebResourceAdapter } from './web-native-adapter.js';

export type WebTableFormat = 'markdown' | 'csv' | 'json';
export interface WebTableArtifactOptions {
    coreIssuerId?: string;
    client: BrokerMcpClient;
    resources: ResourceStorePort;
    attachments: InputAttachmentService;
    backendOutputRoots: readonly string[];
    downloadDirectory?: string;
    temporaryEnabled?: boolean;
    outputBudget?: TemporaryBudgetPort;
}

export async function createNativeWebTableResourceAdapter(options: WebTableArtifactOptions & { coreIssuerId: string },
    definitions?: readonly BrokerToolDefinition[]) {
    const tools = definitions ?? await nativeWebToolDefinitions(options.client);
    const native = await NativeWebResourceAdapter.connect({ client: options.client, resourceStore: options.resources,
        coreIssuerId: options.coreIssuerId, adapterId: 'web-table-artifacts-v1', toolNames: ['web_extract_tables', 'web_download'], definitions: tools,
        preserveOutputOnCancel: true, temporaryEnabled: options.temporaryEnabled, outputBudget: options.outputBudget });
    const port = await WebTableArtifactPort.connect(options, tools);
    const complete = (receipt: ResourceReceipt | undefined) => receipt?.evidence.emptyArtifact === 'true'
        || (receipt?.evidence.outputRefs as Record<string, unknown>[] | undefined)?.some(reference => typeof reference.artifactId === 'string');
    const accept = async (resource: OwnedResource, receipt: ResourceReceipt, signal?: AbortSignal) => {
        const saved = await options.resources.get(resource.resourceId);
        if (!saved || saved.requestId !== resource.requestId) throw new AgentFault('RESOURCE_IDENTITY_MISMATCH', '表格导入回执的原请求映射已变化');
        const accepted = saved.receipt?.evidence.artifactAbandoned === 'true'
            ? { ...receipt, evidence: { ...receipt.evidence, artifactAbandoned: 'true' } }
            : await port.acceptReceipt(resource, receipt, signal, native.inlineArtifacts(resource.requestId));
        if (complete(accepted)) delete accepted.evidence.artifactErrorCode;
        await options.resources.put({ ...saved, receipt: accepted });
        return accepted;
    };
    const finish = async (resource: OwnedResource, receipt: ResourceReceipt) => {
        const accepted = await accept(resource, receipt);
        if (complete(accepted)) native.discardOutput(resource.requestId);
        return accepted;
    };
    const abandon = async (resource: OwnedResource, releaseOutput = true): Promise<ResourceReceipt> => {
        const receipt = await native.prepareTemporaryClose(resource);
        if (!receipt.released || !receipt.terminalConfirmed) throw new AgentFault('RESOURCE_UNRESOLVED', '原表格尚未确认后端释放，保留原字节及request', { requestId: resource.requestId }, true);
        const saved = await options.resources.get(resource.resourceId);
        if (!saved || saved.requestId !== resource.requestId) throw new AgentFault('RESOURCE_IDENTITY_MISMATCH', '放弃表格原件须沿原资源映射');
        const abandoned = { ...receipt, evidence: { ...receipt.evidence, artifactAbandoned: 'true' } };
        await options.resources.put({ ...saved, receipt: abandoned, state: 'released', cleanupState: 'released' });
        if (releaseOutput) native.discardOutput(resource.requestId, resource);
        return abandoned;
    };
    const adapter: ResourceAdapter = { adapterId: native.adapterId, supports: { ...native.supports,
        ephemeralContent: native.supports.ephemeralContent && port.productionContract.temporaryEnabled },
        async create(resource, parameters, signal) {
            const receipt = await native.create(resource, parameters, signal);
            try { return await accept(resource, receipt, signal); }
            catch (error) {
                const latest = await options.resources.get(resource.resourceId);
                const original = latest?.receipt ?? receipt;
                return { ...original, started: null, terminalConfirmed: false, released: false, evidence: { ...original.evidence,
                    backendReleased: receipt.released && receipt.terminalConfirmed ? 'true' : 'false',
                    artifactErrorCode: error instanceof AgentFault ? error.code : 'RESOURCE_ARTIFACT_IMPORT_FAILED' } };
            }
        },
        async findByRequest(resource) { const receipt = await native.findByRequest(resource); return receipt ? accept(resource, receipt) : null; },
        async status(resource) { return accept(resource, await native.status(resource)); },
        async renew(resource, leaseUntil) {
            return resource.receipt?.evidence.backendReleased === 'true'
                ? accept(resource, { ...resource.receipt, terminalConfirmed: true, released: true })
                : accept(resource, await native.renew(resource, leaseUntil));
        },
        async cancel(resource) { return finish(resource, await native.cancel(resource)); },
        async release(resource) { return finish(resource, await native.release(resource)); },
        async prepareTemporaryClose(resource) {
            const saved = await options.resources.get(resource.resourceId);
            if (!complete(saved?.receipt)) return abandon(resource, false);
            const released = await native.release(saved!);
            const references = saved!.receipt!.evidence.outputRefs as Record<string, unknown>[] | undefined;
            const observed = released.evidence.outputRefs as Record<string, unknown>[] | undefined;
            if (observed?.some((reference, index) => references?.[index] && (reference.sha256 !== references[index].sha256
                || reference.byteLength !== references[index].byteLength))) throw new AgentFault('RESOURCE_ARTIFACT_CHANGED', '关闭回执与原CAS字节引用不同，保留原映射', {}, true);
            const receipt = { ...released, evidence: { ...released.evidence,
                ...(references ? { outputRefs: structuredClone(references) } : {}) } };
            await options.resources.put({ ...saved!, receipt });
            return receipt;
        },
        releaseTemporaryOutput(resource) { native.releaseTemporaryOutput(resource); },
    };
    return { adapter, port, inputSchema: (toolName: 'web_extract_tables' | 'web_download') => native.inputSchema(toolName),
        abandon,
        async execute(registry: ResourceRegistry, toolName: 'web_extract_tables' | 'web_download', args: Record<string, unknown>, context: BoundToolContext) {
            if (registry.store !== options.resources) throw new AgentFault('INVALID_PARAMS', '表格适配器与Registry须共用同一端口');
            const call = await bindNativeWebArtifactCall(toolName, args, context);
            let resource = await registry.create(adapter.adapterId, toolName, call, context);
            const output = native.peekOutput(resource.requestId) as Record<string, unknown> | undefined;
            if (resource.receipt?.evidence.artifactAbandoned === 'true') throw new AgentFault('RESOURCE_ARTIFACT_ABANDONED', '原表格字节已由Core明确放弃，仅保留原请求及SHA元数据', { requestId: resource.requestId });
            const error = resource.receipt?.evidence.artifactErrorCode;
            if (typeof error === 'string') throw new AgentFault(error, '原表格导入尚未完成，原字节与request保留供续接', { requestId: resource.requestId }, true);
            if (!output) resource = await registry.reconcile(resource.resourceId, context);
            const outputRefs = resource.receipt?.evidence.outputRefs as Record<string, unknown>[] | undefined;
            if (!outputRefs?.some(reference => typeof reference.artifactId === 'string') && resource.receipt?.evidence.emptyArtifact !== 'true') {
                throw new AgentFault('RESOURCE_UNRESOLVED', '原表格请求尚无已固定CAS原件，保留原request供核对', { requestId: resource.requestId, field: 'outputRefs' }, true);
            }
            const structured = { ...(output?.structuredContent as Record<string, unknown> | undefined) };
            if (context.retention.mode === 'temporary') delete structured.inlineArtifacts;
            let content = output?.content;
            if (context.retention.mode === 'temporary' && outputRefs?.length) {
                content = [{ type: 'text', text: await port.readText(resource, context) }];
            }
            const result = { ...(output ?? { content: [{ type: 'text', text: '已按原request查回表格原件，未重复网页提取或下载' }] }),
                ...(content ? { content } : {}), structuredContent: { ...structured,
                    ownedResource: { resourceId: resource.resourceId, requestId: resource.requestId, state: resource.state,
                        cleanupState: resource.cleanupState, leaseUntil: resource.leaseUntil, recovered: !output }, outputRefs: outputRefs ?? [] } };
            native.discardOutput(resource.requestId);
            return result;
        } };
}

type WebTableArtifactScope = Pick<BoundToolContext, 'principalId' | 'conversationId' | 'retention' | 'signal'>;

const formats: Record<WebTableFormat, { mime: string; ext: string }> = {
    markdown: { mime: 'text/markdown', ext: '.md' }, csv: { mime: 'text/csv', ext: '.csv' }, json: { mime: 'application/json', ext: '.json' },
};

export function webTableRequestHash(toolName: 'web_extract_tables' | 'web_download', args: Record<string, unknown>, policyRevision: number): string {
    return createHash('sha256').update(canonicalJson({ toolName, args, policyRevision })).digest('hex');
}

export class WebTableArtifactPort {
    readonly adapterId = 'web-table-artifacts-v1';
    readonly productionContract: { enabled: boolean; missing: string[]; temporaryEnabled: boolean } = {
        enabled: false, missing: ['request-isolated-output', 'native-artifact-sha256'], temporaryEnabled: false };
    constructor(readonly options: WebTableArtifactOptions) {}

    static async connect(options: WebTableArtifactOptions, definitions?: readonly BrokerToolDefinition[]): Promise<WebTableArtifactPort> {
        const tools = definitions ?? await nativeWebToolDefinitions(options.client);
        const contract = inspectNativeWebAdapterContract(tools, options.coreIssuerId ?? '', ['web_extract_tables', 'web_download']);
        if (!contract.enabled) throw new AgentFault('TOOL_CAPABILITY_UNVERIFIED', '表格原生请求及产物schema尚未核全', { missing: contract.missing });
        const port = new WebTableArtifactPort(options);
        port.productionContract.enabled = true;
        port.productionContract.missing = [];
        port.productionContract.temporaryEnabled = options.temporaryEnabled === true && !!options.outputBudget && contract.ephemeralContent === true
            && typeof options.attachments.prepareInline === 'function';
        return port;
    }

    private async owned(resource: OwnedResource, context: Pick<WebTableArtifactScope, 'principalId' | 'conversationId'>): Promise<OwnedResource> {
        const saved = await this.options.resources.get(resource.resourceId);
        if (!saved || saved.principalId !== context.principalId || saved.conversationId !== context.conversationId
            || saved.runId !== resource.runId || saved.requestId !== resource.requestId
            || saved.adapterId !== resource.adapterId || saved.issuerId !== resource.issuerId
            || this.options.coreIssuerId && saved.issuerId !== this.options.coreIssuerId) throw new AgentFault('RESOURCE_IDENTITY_MISMATCH', '表格原件须来自当前可信任务映射');
        return saved;
    }

    private async reference(resource: OwnedResource, context: Pick<WebTableArtifactScope, 'principalId' | 'conversationId'>): Promise<InputAttachmentReference> {
        resource = await this.owned(resource, context);
        const outputs = resource.receipt?.evidence.outputRefs as { artifactId?: string; sha256?: string }[] | undefined;
        const source = outputs?.[0];
        if (!source?.artifactId) throw new AgentFault('RESOURCE_UNRESOLVED', '原表格请求尚无已固定附件引用，保持原请求供核对', { requestId: resource.requestId }, true);
        const reference = await this.options.attachments.get(context.conversationId, source.artifactId);
        if (reference.sha256 !== source.sha256) throw new AgentFault('RESOURCE_ARTIFACT_CHANGED', '表格附件与原请求SHA不同', {}, true);
        return reference;
    }

    async acceptReceipt(resource: OwnedResource, receipt: ResourceReceipt, signal: AbortSignal = new AbortController().signal,
        inlineArtifacts: readonly Record<string, unknown>[] = []): Promise<ResourceReceipt> {
        if (!this.productionContract.enabled) throw new AgentFault('TOOL_CAPABILITY_UNVERIFIED', '表格真实产物合同尚未启用');
        const scope: WebTableArtifactScope = { principalId: resource.principalId, conversationId: resource.conversationId,
            retention: resource.retention, signal };
        const saved = await this.owned(resource, scope);
        const temporary = resource.retention.mode === 'temporary';
        if (temporary && !this.productionContract.temporaryEnabled) throw new AgentFault('TOOL_CAPABILITY_UNVERIFIED', '临时原件需要已核验后端及原附件inline工厂', { field: 'prepareInline' });
        const outputs = receipt.evidence.outputRefs as Record<string, unknown>[] | undefined;
        if (!outputs?.length) return receipt;
        if (outputs.length !== 1) throw new AgentFault('RESOURCE_UNRESOLVED', '当前表格合同只声明一个完整原件', { field: 'outputRefs' }, true);
        const output = outputs[0];
        const existing = (saved.receipt?.evidence.outputRefs as Record<string, unknown>[] | undefined)?.[0];
        if (typeof existing?.artifactId === 'string' && existing.sha256 === output.sha256 && existing.byteLength === output.byteLength) {
            const reference = await this.options.attachments.get(resource.conversationId, existing.artifactId);
            if (reference.sha256 !== output.sha256 || reference.byteLength !== output.byteLength) throw new AgentFault('RESOURCE_ARTIFACT_CHANGED', '原CAS附件与后端固定字节不同', {}, true);
            return { ...receipt, evidence: { ...receipt.evidence, operation: 'artifact-import',
                outputRoot: saved.receipt?.evidence.outputRoot, referenceKind: 'borrowed', outputRefs: [{ ...output, artifactId: reference.referenceId, mimeType: reference.mediaType }] } };
        }
        if (temporary) {
            const candidate = inlineArtifacts.filter(artifact => artifact.ownerId === receipt.evidence.backendOwnerId
                && artifact.requestId === resource.requestId && artifact.sha256 === output.sha256 && artifact.byteLength === output.byteLength);
            if (candidate.length !== 1 || typeof output.mimeType !== 'string' || output.path !== undefined) {
                throw new AgentFault('RESOURCE_UNRESOLVED', '原临时请求缺少完整inline字节，保留原ID且不重复下载', { field: 'inlineArtifacts', requestId: resource.requestId }, true);
            }
            const artifact = candidate[0];
            const maximum = Math.min(this.options.attachments.limits.maxSourceBytes, this.options.attachments.limits.maxTextBytes);
            const mime = output.mimeType.split(';')[0].trim().toLowerCase();
            if (!mime.startsWith('text/') && !['application/json', 'application/xml', 'application/javascript'].includes(mime)) {
                throw new AgentFault('TOOL_CAPABILITY_UNVERIFIED', '当前临时表格/下载原件只接已支持的UTF-8文本类型', { field: 'mimeType', mimeType: mime });
            }
            if (!Number.isSafeInteger(output.byteLength) || Number(output.byteLength) > maximum
                || typeof artifact.dataBase64 === 'string' && artifact.dataBase64.length > Math.ceil(maximum / 3) * 4
                || typeof artifact.text === 'string' && Buffer.byteLength(artifact.text, 'utf8') > maximum) {
                throw new AgentFault('MEDIA_CONTENT_LIMIT', '临时原件超过现有附件文本或单源限额');
            }
            if (typeof artifact.text !== 'string' && typeof artifact.dataBase64 !== 'string') throw new AgentFault('RESOURCE_UNRESOLVED', '临时原件缺少原始字节', { field: 'inlineArtifacts.dataBase64/text' }, true);
            this.options.outputBudget!.reserve(resource.conversationId, Number(output.byteLength), 'scratch');
            let bytes: Buffer | undefined;
            try {
                bytes = typeof artifact.text === 'string' ? Buffer.from(artifact.text, 'utf8') : Buffer.from(String(artifact.dataBase64), 'base64');
                if (typeof artifact.dataBase64 === 'string' && bytes.toString('base64') !== artifact.dataBase64
                    || bytes.length !== output.byteLength || createHash('sha256').update(bytes).digest('hex') !== output.sha256) {
                    throw new AgentFault('RESOURCE_ARTIFACT_CHANGED', '临时inline原字节与原请求SHA/长度不同', {}, true);
                }
                const reference = await this.options.attachments.prepareInline({ conversationId: resource.conversationId,
                    clientCommandId: `web-table:${resource.requestId}`, sourceId: `web-request:${resource.requestId}`,
                    mime, bytes, expectedSha256: String(output.sha256) },
                { principalId: resource.principalId, clientId: 'owned-web-table-artifact', signal });
                if (reference.sha256 !== output.sha256 || reference.byteLength !== bytes.length) throw new AgentFault('RESOURCE_ARTIFACT_CHANGED', '原临时附件工厂回执与原请求字节不同', {}, true);
                const imported = { ...receipt, evidence: { ...receipt.evidence, operation: 'artifact-import', referenceKind: 'owned',
                    outputRefs: [{ mimeType: reference.mediaType, artifactId: reference.referenceId, sha256: reference.sha256, byteLength: reference.byteLength }] } };
                await this.options.resources.put({ ...saved, receipt: imported });
                return imported;
            } finally {
                bytes?.fill(0);
                this.options.outputBudget!.release(resource.conversationId, Number(output.byteLength), 'scratch');
            }
        }
        if (typeof output.path !== 'string' || typeof output.mimeType !== 'string') throw new AgentFault('RESOURCE_UNRESOLVED', '表格原生回执缺少路径或MIME', { field: 'artifacts' }, true);
        const source = await realpath(output.path);
        const roots = await Promise.all(this.options.backendOutputRoots.map(root => realpath(root)));
        const extension = path.extname(source).toLowerCase();
        const format = Object.values(formats).find(value => value.ext === extension);
        const mimeType = output.mimeType.split(';')[0].trim().toLowerCase();
        if (!roots.some(root => isWithin(source, root)) || !format || ![format.mime, 'application/octet-stream', 'text/plain'].includes(mimeType)) {
            throw new AgentFault('TOOL_CAPABILITY_UNVERIFIED', '表格原件须来自可信后端根且保持已支持的原格式', { field: 'mimeType', mimeType });
        }
        const identity = await this.fileIdentity(source, signal);
        if (identity.sha256 !== output.sha256 || identity.byteLength !== output.byteLength) throw new AgentFault('RESOURCE_ARTIFACT_CHANGED', '表格实际原字节与后端SHA/长度不同', {}, true);
        const capture = { ...saved, receipt: { ...receipt, evidence: { ...receipt.evidence, operation: 'artifact-capture',
            outputRoot: path.dirname(source), referenceKind: 'borrowed', outputRefs: [{ ...output, path: source, mimeType: format.mime }] } } };
        await this.options.resources.put(capture);
        const imported = await this.recover(capture, scope);
        return imported.resource.receipt!;
    }

    async execute(resource: OwnedResource, toolName: 'web_extract_tables' | 'web_download', args: Record<string, unknown>,
        context: BoundToolContext): Promise<{ resource: OwnedResource; reference?: InputAttachmentReference; output?: unknown; recovered: boolean; empty?: boolean }> {
        if (context.retention.mode === 'temporary') throw new AgentFault('TOOL_CAPABILITY_UNVERIFIED', '原表格及下载handler仍写文件，临时模式保持关闭');
        if (resource.adapterId !== this.adapterId || resource.principalId !== context.principalId || resource.conversationId !== context.conversationId || resource.runId !== context.runId
            || resource.rootRunId !== context.rootRunId || resource.runEpoch !== context.runEpoch || resource.actionId !== context.actionId
            || canonicalJson(resource.retention) !== canonicalJson(context.retention)
            || resource.argsHash !== webTableRequestHash(toolName, args, context.policyRevision)) throw new AgentFault('RESOURCE_IDENTITY_MISMATCH', '表格请求须绑定当前动作、归属及业务参数摘要');
        const format = (args.format ?? 'markdown') as WebTableFormat;
        if (!Object.hasOwn(formats, format)) throw new AgentFault('INVALID_PARAMS', '表格只接受markdown/csv/json');
        const url = new URL(String(args.url));
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new AgentFault('TOOL_CAPABILITY_UNVERIFIED', '表格只接受普通HTTP来源');
        await context.assertCurrent?.();
        if (context.signal.aborted) throw new AgentFault('TOOL_CANCELLED', '表格请求已取消');
        let bound: Record<string, unknown>;
        let staging: string | undefined;
        if (toolName === 'web_extract_tables') bound = webToolSpecs.find(spec => spec.name === toolName)!.bind(args, context);
        else {
            if (Object.keys(args).some(field => !['url', 'format', 'timeout'].includes(field))) throw new AgentFault('TOOL_CAPABILITY_UNVERIFIED', '表格下载路径由核心固定');
            if (!this.options.downloadDirectory) throw new AgentFault('TOOL_CAPABILITY_UNVERIFIED', '旧式下载暂存分支尚未配置具体获准目录', { field: 'downloadDirectory' });
            const directory = await realpath(this.options.downloadDirectory);
            const roots = await Promise.all(context.roots.map(root => realpath(root)));
            if (!roots.some(root => isWithin(directory, root))) throw new AgentFault('TOOL_NOT_ALLOWED', '下载暂存根尚未获准');
            staging = path.join(directory, createHash('sha256').update(resource.requestId).digest('hex') + formats[format].ext);
            bound = { url: args.url, ...(args.timeout === undefined ? {} : { timeout: args.timeout }), savePath: staging,
                ownerId: `sandbox-agent:${context.conversationId}:${context.runId}:${resource.requestId}` };
        }
        const allocated = await this.options.resources.allocate(resource);
        resource = await this.owned(allocated.resource, context);
        if (allocated.reused) {
            if (resource.receipt?.evidence.operation === 'empty-artifact') return { resource, recovered: true, empty: true };
            const recovered = await this.recover(resource, context);
            return { ...recovered, recovered: true };
        }
        try {
            if (staging) await (await open(staging, 'wx')).close();
            const output = await this.options.client.invoke(toolName, bound, context.signal);
            if ((output as { isError?: boolean })?.isError) throw new AgentFault('RESOURCE_UNRESOLVED', '原表格或下载返回业务错误，保留原请求', { requestId: resource.requestId }, true);
            const content = (output as { content?: { type?: string; text?: string }[] }).content ?? [];
            const body = content.filter(part => part.type === 'text').map(part => part.text ?? '').join('\n');
            const match = /^完整数据:\s*(.+)$/m.exec(body);
            if (!staging && !match && /^未找到任何表格。/.test(body)) {
                resource = { ...resource, state: 'released', cleanupState: 'released', receipt: { started: true, terminalConfirmed: true,
                    released: true, evidence: { toolName, operation: 'empty-artifact', requestId: resource.requestId, outputRefs: [] } } };
                await this.options.resources.put(resource);
                return { resource, output, recovered: false, empty: true };
            }
            if (!staging && !match) throw new AgentFault('RESOURCE_UNRESOLVED', '表格响应未返回可核原文件路径', { requestId: resource.requestId }, true);
            const source = await realpath(staging ?? match![1].trim());
            const roots = staging ? [await realpath(path.dirname(staging))] : await Promise.all(this.options.backendOutputRoots.map(root => realpath(root)));
            if (!roots.some(root => isWithin(source, root)) || path.extname(source).toLowerCase() !== formats[format].ext) {
                throw new AgentFault('RESOURCE_UNRESOLVED', '表格原文件尚未绑定已知后端产物根与格式', { requestId: resource.requestId }, true);
            }
            const identity = await this.fileIdentity(source, context.signal);
            resource = { ...resource, receipt: { started: true, terminalConfirmed: false, released: false,
                evidence: { toolName, operation: 'artifact-capture', requestId: resource.requestId, outputRoot: path.dirname(source),
                    referenceKind: staging ? 'owned' : 'borrowed', outputRefs: [{ path: source, mimeType: formats[format].mime, ...identity }] } } };
            await this.options.resources.put(resource);
            const imported = await this.recover(resource, context);
            return { ...imported, output, recovered: false };
        } catch (error) {
            const latest = await this.owned(resource, context);
            if (latest.state !== 'released') await this.options.resources.put({ ...latest, state: 'unresolved', cleanupState: 'unconfirmed' });
            throw error;
        }
    }

    private async fileIdentity(source: string, signal?: AbortSignal): Promise<{ sha256: string; byteLength: number }> {
        const before = await stat(source);
        if (!before.isFile() || before.size > this.options.attachments.limits.maxSourceBytes) throw new AgentFault('MEDIA_CONTENT_LIMIT', '表格原文件超过现有附件单源限额');
        const checksum = createHash('sha256');
        let byteLength = 0;
        for await (const bytes of createReadStream(source)) {
            if (signal?.aborted) throw new AgentFault('TOOL_CANCELLED', '表格原件接收已取消');
            byteLength += bytes.length;
            if (byteLength > this.options.attachments.limits.maxSourceBytes) throw new AgentFault('MEDIA_CONTENT_LIMIT', '表格原文件超过现有附件单源限额');
            checksum.update(bytes);
        }
        const after = await stat(source);
        if (before.size !== byteLength || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
            || before.dev !== after.dev || before.ino !== after.ino) throw new AgentFault('RESOURCE_ARTIFACT_CHANGED', '表格原文件在固定期间变化', {}, true);
        return { sha256: checksum.digest('hex'), byteLength };
    }

    async recover(resource: OwnedResource, context: WebTableArtifactScope): Promise<{ resource: OwnedResource; reference: InputAttachmentReference }> {
        resource = await this.owned(resource, context);
        const output = (resource.receipt?.evidence.outputRefs as Record<string, unknown>[] | undefined)?.[0];
        if (!output) throw new AgentFault('RESOURCE_UNRESOLVED', '原请求尚无可恢复表格原件，保持原请求且不重复下载', { requestId: resource.requestId }, true);
        if (typeof output.artifactId === 'string') return { resource, reference: await this.reference(resource, context) };
        if (canonicalJson(resource.retention) !== canonicalJson(context.retention)) throw new AgentFault('RETENTION_POLICY_STALE', '未完成表格接收须先通过原保存方式工厂恢复');
        const source = typeof output.path === 'string' ? await realpath(output.path) : undefined;
        const root = resource.receipt?.evidence.outputRoot;
        if (!source || typeof root !== 'string' || !isWithin(source, root) || typeof output.mimeType !== 'string') {
            throw new AgentFault('RESOURCE_UNRESOLVED', '原表格文件缺少固定路径、根或MIME', { requestId: resource.requestId }, true);
        }
        const identity = await this.fileIdentity(source, context.signal);
        if (identity.sha256 !== output.sha256 || identity.byteLength !== output.byteLength) throw new AgentFault('RESOURCE_ARTIFACT_CHANGED', '原表格恢复文件与原请求SHA不同', {}, true);
        const reference = await this.options.attachments.prepare({ conversationId: context.conversationId,
            clientCommandId: `web-table:${resource.requestId}`, kind: 'file', source, mime: output.mimeType },
        { principalId: context.principalId, clientId: 'owned-web-table-artifact', signal: context.signal });
        if (reference.sha256 !== identity.sha256 || reference.byteLength !== identity.byteLength) throw new AgentFault('RESOURCE_ARTIFACT_CHANGED', '表格原文件在接收期间变化，原请求和已保存原件保留', {}, true);
        resource = { ...resource, state: 'released', cleanupState: 'released', receipt: { started: true,
            terminalConfirmed: true, released: true, evidence: { ...resource.receipt?.evidence, operation: 'artifact-import',
                outputRefs: [{ ...output, artifactId: reference.referenceId, mimeType: reference.mediaType }] } } };
        await this.options.resources.put(resource);
        if (resource.receipt!.evidence.referenceKind === 'owned') await unlink(source);
        return { resource, reference };
    }

    async render(resource: OwnedResource, context: BoundToolContext, view: NativeSendView, selection: AttachmentModelSelection): Promise<NativeSendView> {
        const reference = await this.reference(resource, context);
        return this.options.attachments.appendUser(context.conversationId, view,
            { text: `原表格请求 ${resource.requestId}，原件SHA256 ${reference.sha256}`, references: [reference] } as unknown as JsonValue,
            selection, context.signal);
    }

    async read(resource: OwnedResource, context: BoundToolContext, offset = 0, maxBytes = 192 * 1024) {
        const reference = await this.reference(resource, context);
        return this.options.attachments.read({ conversationId: context.conversationId, artifactId: reference.referenceId, offset, maxBytes });
    }

    async readText(resource: OwnedResource, context: BoundToolContext): Promise<string> {
        const parts: Buffer[] = [];
        let offset = 0;
        try {
            while (true) {
                const page = await this.read(resource, context, offset, this.options.attachments.limits.chunkBytes);
                if (page.totalBytes > this.options.attachments.limits.maxTextBytes) throw new AgentFault('MEDIA_CONTENT_LIMIT', '临时原件超过原附件文本限额');
                const bytes = Buffer.from(page.dataBase64, 'base64');
                parts.push(bytes);
                offset += bytes.length;
                if (page.complete) break;
                if (!bytes.length || page.nextOffset !== offset) throw new AgentFault('RESOURCE_ARTIFACT_CHANGED', '原临时附件分页未正常前进');
            }
            const bytes = Buffer.concat(parts);
            try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
            finally { bytes.fill(0); }
        } finally { for (const bytes of parts) bytes.fill(0); }
    }
}
