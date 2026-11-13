import { fileURLToPath } from 'node:url';
import { AgentFault, canonicalJson } from '../protocol.js';
import { assertModelArguments, pathIdentity } from '../security/policy.js';
import { assertReadablePath } from '../workspace/versions.js';
import { createBrokerMcpClient, validateBrokerConfiguration } from './broker-client.js';
import type { BrokerClientFactory, BrokerMcpClient, SharedServiceConfiguration } from './broker-client.js';
import { ToolSchemaCache, validateToolArguments } from './schema-cache.js';
import { sandboxToolSpecs } from './adapters/sandbox.js';
import { memoryToolSpecs } from './adapters/memory.js';
import { assertWebToolArgumentSchema, disabledWebToolSpecs, oneShotWebScreenshotSpec,
    webToolAllowedArguments, webToolNoModelArgumentFact, webToolSpecs } from './adapters/web.js';
import { exaToolSpecs } from './adapters/exa.js';
import { LocalSequentialThinking } from './adapters/sequential.js';
import type { SharedServiceId, SharedToolSpec } from './adapters/types.js';
import type { BoundToolContext, ModelFunctionSchema, ToolCatalogEntry } from './types.js';
import type { ChildToolCatalogFact } from '../delegation/tool-policy.js';
import type { ResourceConversationOwner } from '../resources/registry.js';

const specs = [...sandboxToolSpecs, ...memoryToolSpecs, ...webToolSpecs, oneShotWebScreenshotSpec,
    ...disabledWebToolSpecs.filter(spec => spec.name !== oneShotWebScreenshotSpec.name), ...exaToolSpecs];
const hiddenArguments = new Set(['ownerId', 'owner', 'principalId', 'conversationId', 'runId', 'rootRunId', 'runEpoch', 'policyRevision',
    'credentialRef', 'authorization', 'authToken', 'apiKey', 'modelChain', 'chain', 'dataChain']);
const localSequentialSchema: Record<string, unknown> = { type: 'object', additionalProperties: false,
    required: ['thought', 'thoughtNumber', 'totalThoughts', 'nextThoughtNeeded'], properties: {
        thought: { type: 'string', maxLength: 8000 }, thoughtNumber: { type: 'integer', minimum: 1, maximum: 128 },
        totalThoughts: { type: 'integer', minimum: 1, maximum: 128 }, nextThoughtNeeded: { type: 'boolean' },
    } };

interface LoadedModelTool { toolId: string; schemaHash: string; function: ModelFunctionSchema }

function requireSuccessfulMcpResult(result: unknown, toolId: string): unknown {
    if (result && typeof result === 'object') {
        const envelope = result as Record<string, unknown>;
        if (envelope.isError === true) {
            throw new AgentFault('TOOL_REMOTE_ERROR', '共享MCP返回工具错误', { toolId, rawResult: result }, true);
        }
    }
    return result;
}

export interface SharedResourceTools {
    readonly specifications: readonly SharedToolSpec[];
    allowedArguments(toolName: string): readonly string[];
    nativeSchema(toolName: string, client: BrokerMcpClient, signal?: AbortSignal): Promise<Record<string, unknown>>;
    execute(toolName: string, args: Record<string, unknown>, context: BoundToolContext, client: BrokerMcpClient): Promise<unknown>;
    release?(context: BoundToolContext): Promise<void>;
    close?(): Promise<void>;
    prepareTemporaryConversationClose?(owner: ResourceConversationOwner): Promise<void>;
    forgetTemporaryConversation?(owner: ResourceConversationOwner): Promise<void>;
}

export class SharedMcpCatalog {
    readonly cache = new ToolSchemaCache();
    private readonly configurations = new Map<SharedServiceId, SharedServiceConfiguration>();
    private readonly clients = new Map<SharedServiceId, Promise<BrokerMcpClient>>();
    private readonly liveClients = new Set<BrokerMcpClient>();
    private readonly nativeSchemas = new Map<string, Record<string, unknown>>();
    private readonly schemaFailures = new Map<string, { code: string; reason: string }>();
    private readonly loadedScopes = new Map<string, { conversationId: string; principalId: string; runId: string; rootRunId: string;
        runEpoch: number; tools: Map<string, LoadedModelTool> }>();
    private readonly sequential = new LocalSequentialThinking();
    private readonly specifications: readonly SharedToolSpec[];
    private readonly resourceToolIds = new Set<string>();
    private closed = false;

    constructor(configurations: readonly SharedServiceConfiguration[] = [], readonly clientFactory: BrokerClientFactory = createBrokerMcpClient,
        readonly resourceTools?: SharedResourceTools) {
        const replacements = new Map<string, SharedToolSpec>();
        for (const spec of resourceTools?.specifications ?? []) {
            const key = this.toolId(spec.serviceId, spec.name);
            if (spec.serviceId !== 'web-fetcher' || !['web_interact', 'web_pipeline', 'web_extract_tables', 'web_download'].includes(spec.name)
                || replacements.has(key)) throw new AgentFault('INVALID_PARAMS', '资源工具接线只接受已分类且无重复的网页能力');
            const fields = resourceTools!.allowedArguments(spec.name);
            if (!fields.length || fields.some(field => typeof field !== 'string' || hiddenArguments.has(field)
                || ['sessionId', 'requestId', 'leaseUntil', 'outputRoot'].includes(field))) {
                throw new AgentFault('INVALID_PARAMS', '资源工具的模型参数须保留核心绑定字段');
            }
            replacements.set(key, spec);
            this.resourceToolIds.add(key);
        }
        this.specifications = [...specs.map(spec => replacements.get(this.toolId(spec.serviceId, spec.name)) ?? spec),
            ...[...replacements.values()].filter(spec => !specs.some(original => this.toolId(original.serviceId, original.name) === this.toolId(spec.serviceId, spec.name)))];
        for (const configuration of configurations) {
            validateBrokerConfiguration(configuration);
            if (this.configurations.has(configuration.serviceId)) throw new AgentFault('INVALID_PARAMS', '共享MCP服务配置重复');
            this.configurations.set(configuration.serviceId, structuredClone(configuration));
        }
    }

    private modelName(serviceId: string, name: string): string { return `mcp_${serviceId.replaceAll('-', '_')}__${name}`; }
    private toolId(serviceId: string, name: string): string { return `${serviceId}.${name}`; }

    list(input: { cursor?: string; limit?: number; includeUnavailable?: boolean } = {}): { entries: ToolCatalogEntry[]; nextCursor: string | null } {
        const limit = input.limit ?? 24;
        if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new AgentFault('INVALID_PARAMS', '工具目录页大小须为1至100');
        const offset = input.cursor ? Number(input.cursor) : 0;
        if (!Number.isSafeInteger(offset) || offset < 0) throw new AgentFault('INVALID_PARAMS', '工具目录cursor无效');
        const all: ToolCatalogEntry[] = [];
        for (const configuration of this.configurations.values()) {
            if (!configuration.enabled) continue;
            if (configuration.serviceId === 'sequential-thinking') {
                const cached = this.cache.get('sequential-thinking', 'sequentialthinking', configuration.revision);
                all.push({ toolId: 'sequential-thinking.sequentialthinking', serviceId: configuration.serviceId,
                    name: this.modelName(configuration.serviceId, 'sequentialthinking'), summary: '本地run级步骤管理，无共享状态和外部模型调用',
                    effectKinds: [], modelEffect: 'none', resourceKind: null, schemaHash: cached?.schemaHash ?? null,
                    adapterVersion: configuration.revision, availability: 'available', reason: 'local' });
            }
            for (const spec of this.specifications.filter(entry => entry.serviceId === configuration.serviceId)) {
                if (spec.disabledReason && !input.includeUnavailable) continue;
                const cached = this.cache.get(spec.serviceId, spec.name, configuration.revision);
                const failure = this.schemaFailures.get(this.toolId(spec.serviceId, spec.name));
                all.push({ toolId: this.toolId(spec.serviceId, spec.name), serviceId: spec.serviceId, name: this.modelName(spec.serviceId, spec.name),
                    summary: spec.summary, effectKinds: spec.effects, modelEffect: 'none', resourceKind: null, schemaHash: cached?.schemaHash ?? null,
                    adapterVersion: configuration.revision, availability: spec.disabledReason ? 'disabled' : cached ? 'available' : failure ? 'unavailable' : 'schema_pending',
                    schemaStatus: cached ? 'verified' : failure?.code === 'TOOL_CAPABILITY_UNVERIFIED' ? 'unsupported' : 'pending',
                    reason: spec.disabledReason ?? (cached ? null : failure?.reason ?? '已明确配置，尚未核对schema；使用tool_describe或tool_load进行检查') });
            }
        }
        return { entries: all.slice(offset, offset + limit), nextCursor: offset + limit < all.length ? String(offset + limit) : null };
    }

    private resolve(name: string): { configuration: SharedServiceConfiguration; spec: SharedToolSpec } {
        for (const spec of this.specifications) if (name === this.toolId(spec.serviceId, spec.name) || name === this.modelName(spec.serviceId, spec.name)) {
            const configuration = this.configurations.get(spec.serviceId);
            if (!configuration?.enabled) break;
            if (spec.disabledReason) throw new AgentFault('TOOL_CAPABILITY_UNVERIFIED', spec.disabledReason);
            return { configuration, spec };
        }
        throw new AgentFault('TOOL_NOT_ALLOWED', '该共享工具未在明确配置的白名单中启用');
    }

    childToolFacts(): ChildToolCatalogFact[] {
        const facts: ChildToolCatalogFact[] = [];
        let cursor: string | undefined;
        do {
            const page = this.list({ cursor, limit: 100, includeUnavailable: true });
            for (const entry of page.entries) {
                const sequential = entry.serviceId === 'sequential-thinking';
                const spec = this.specifications.find(candidate => this.toolId(candidate.serviceId, candidate.name) === entry.toolId);
                const temporary = sequential || spec?.supportsTemporary === true;
                const available = entry.availability === 'available';
                const native = this.nativeSchemas.get(entry.toolId)?.properties as Record<string, unknown> | undefined;
                const webFact = spec?.serviceId === 'web-fetcher' ? this.resourceToolIds.has(entry.toolId)
                    ? { scope: 'all_allowed_arguments' as const, modelEffect: 'none' as const, allowedArguments: this.resourceTools!.allowedArguments(spec.name) }
                    : webToolNoModelArgumentFact(spec.name) : undefined;
                const classified = sequential || entry.serviceId === 'exa' || entry.toolId === 'sandbox.sandbox_status'
                    || entry.toolId === 'sandbox.smart_search' && Boolean(native && Object.hasOwn(native, 'mode'))
                    || Boolean(webFact);
                const availability = entry.availability === 'schema_pending' ? 'unknown' : entry.availability;
                facts.push({ ...entry, availability, retentionAvailability: {
                    temporary: available && temporary ? 'available' : 'unavailable',
                    ttl: available ? 'available' : availability, archive: available ? 'available' : availability },
                    ...(available && classified && entry.schemaHash && (sequential || spec && !spec.disabledReason) ? { argumentPolicy: {
                        scope: 'all_allowed_arguments', modelEffect: 'none', schemaHash: entry.schemaHash,
                        adapterVersion: entry.adapterVersion,
                        sourceRef: `sandbox-agent:bound-adapter:${entry.toolId}@${entry.adapterVersion}` } } : {}) });
            }
            cursor = page.nextCursor ?? undefined;
        } while (cursor);
        return facts;
    }

    private client(configuration: SharedServiceConfiguration, allowReplacement = true): Promise<BrokerMcpClient> {
        if (this.closed) throw new AgentFault('TOOL_SERVICE_UNAVAILABLE', '本工具连接已关闭');
        let pending = this.clients.get(configuration.serviceId);
        if (!pending) {
            pending = Promise.resolve().then(() => this.clientFactory(configuration)).then(async client => {
                if (this.closed) {
                    await client.close();
                    throw new AgentFault('TOOL_SERVICE_UNAVAILABLE', '本工具连接已关闭');
                }
                this.liveClients.add(client);
                void client.whenClosed?.then(() => this.liveClients.delete(client), () => {});
                return client;
            });
            this.clients.set(configuration.serviceId, pending);
            void pending.catch(() => { if (this.clients.get(configuration.serviceId) === pending) this.clients.delete(configuration.serviceId); });
        }
        return pending.then(client => {
            if (client.isAvailable?.() !== false) return client;
            if (!allowReplacement) throw new AgentFault('TOOL_SERVICE_UNAVAILABLE', '共享MCP新连接已失效');
            if (this.clients.get(configuration.serviceId) === pending) this.clients.delete(configuration.serviceId);
            return this.client(configuration, false);
        });
    }

    webResourceClient(): Promise<BrokerMcpClient> {
        const configuration = this.configurations.get('web-fetcher');
        if (!configuration?.enabled) throw new AgentFault('TOOL_SERVICE_UNAVAILABLE', '网页资源服务尚未启用');
        return this.client(configuration);
    }

    async describe(name: string, signal?: AbortSignal): Promise<{ toolId: string; schemaHash: string; function: ModelFunctionSchema }> {
        try {
            const description = await this.describeSchema(name, signal);
            this.schemaFailures.delete(description.toolId);
            return description;
        } catch (error) {
            const spec = this.specifications.find(entry => name === this.toolId(entry.serviceId, entry.name)
                || name === this.modelName(entry.serviceId, entry.name));
            if (spec && error instanceof AgentFault && !['TOOL_CANCELLED', 'INVALID_PARAMS'].includes(error.code)) {
                this.schemaFailures.set(this.toolId(spec.serviceId, spec.name), { code: error.code, reason: error.message });
            }
            throw error;
        }
    }

    private async describeSchema(name: string, signal?: AbortSignal): Promise<{ toolId: string; schemaHash: string; function: ModelFunctionSchema }> {
        if (this.closed) throw new AgentFault('TOOL_SERVICE_UNAVAILABLE', '本工具连接已关闭');
        const sequential = this.configurations.get('sequential-thinking');
        if (sequential?.enabled && ['sequential-thinking.sequentialthinking', this.modelName('sequential-thinking', 'sequentialthinking')].includes(name)) {
            const cached = this.cache.get(sequential.serviceId, 'sequentialthinking', sequential.revision) ?? this.cache.put(sequential.serviceId, 'sequentialthinking', sequential.revision, localSequentialSchema);
            return { toolId: 'sequential-thinking.sequentialthinking', schemaHash: cached.schemaHash,
                function: { type: 'function', name: this.modelName(sequential.serviceId, 'sequentialthinking'), description: '本地run级步骤管理，零外部模型调用', parameters: cached.schema } };
        }
        const { configuration, spec } = this.resolve(name);
        const ownedResource = this.resourceToolIds.has(this.toolId(spec.serviceId, spec.name));
        let cached = this.cache.get(spec.serviceId, spec.name, configuration.revision);
        if (!cached) {
            const client = await this.client(configuration);
            let cursor: string | undefined;
            let found: Record<string, unknown> | undefined;
            if (ownedResource) {
                found = await this.resourceTools!.nativeSchema(spec.name, client, signal);
            }
            for (let pageNumber = 0; !ownedResource && !found && pageNumber < 8; pageNumber++) {
                const page = await client.listTools(cursor, signal);
                if (page.tools.length > 500) throw new AgentFault('TOOL_CAPABILITY_UNVERIFIED', '共享服务目录超过本次接入预算');
                found = page.tools.find(tool => tool.name === spec.name)?.inputSchema;
                if (found || !page.nextCursor) break;
                if (page.nextCursor === cursor) throw new AgentFault('TOOL_CAPABILITY_UNVERIFIED', '共享服务目录分页未前进');
                cursor = page.nextCursor;
            }
            if (!found) throw new AgentFault('TOOL_SERVICE_UNAVAILABLE', '已配置服务尚未提供该白名单工具', { toolId: this.toolId(spec.serviceId, spec.name) });
            const schema = structuredClone(found);
            const properties = (schema.properties ?? {}) as Record<string, unknown>;
            const webFields = ownedResource ? this.resourceTools!.allowedArguments(spec.name)
                : spec.serviceId === 'web-fetcher' ? webToolAllowedArguments(spec.name) : undefined;
            if (webFields && !ownedResource) assertWebToolArgumentSchema(spec.name, found);
            schema.properties = Object.fromEntries(Object.entries(properties).filter(([key]) =>
                !hiddenArguments.has(key) && (!webFields || webFields.includes(key))));
            schema.required = ((schema.required ?? []) as string[]).filter(key => Object.hasOwn(schema.properties as object, key));
            schema.additionalProperties = false;
            cached = this.cache.put(spec.serviceId, spec.name, configuration.revision, schema);
            this.nativeSchemas.set(this.toolId(spec.serviceId, spec.name), structuredClone(found));
            if (this.nativeSchemas.size > 64) this.nativeSchemas.delete(this.nativeSchemas.keys().next().value!);
        }
        return { toolId: this.toolId(spec.serviceId, spec.name), schemaHash: cached.schemaHash,
            function: { type: 'function', name: this.modelName(spec.serviceId, spec.name), description: spec.summary, parameters: cached.schema } };
    }

    private scopeKey(context: BoundToolContext): string {
        return canonicalJson({ conversationId: context.conversationId, principalId: context.principalId, runId: context.runId,
            rootRunId: context.rootRunId, runEpoch: context.runEpoch, policyRevision: context.policyRevision,
            roots: context.roots.map(pathIdentity).sort(), protectedPaths: (context.protectedPaths ?? []).map(pathIdentity).sort(), retention: context.retention });
    }

    modelPublicationReason(name: string, context: BoundToolContext): string | null {
        if (['sequential-thinking.sequentialthinking', this.modelName('sequential-thinking', 'sequentialthinking')].includes(name)) return null;
        const { spec } = this.resolve(name);
        return context.retention.mode === 'temporary' && !spec.supportsTemporary
            ? '此工具尚未验证临时会话路由；当前临时会话保持未加载，可由主调用方选择支持的保存方式' : null;
    }

    async load(names: readonly string[], context: BoundToolContext): Promise<LoadedModelTool[]> {
        if (this.closed) throw new AgentFault('TOOL_SERVICE_UNAVAILABLE', '本工具连接已关闭');
        if (!Array.isArray(names) || names.length < 1 || names.length > 32 || names.some(name => typeof name !== 'string' || !name)) {
            throw new AgentFault('INVALID_PARAMS', '共享工具加载需要明确选择1至32个名称');
        }
        if (context.signal.aborted) throw new AgentFault('TOOL_CANCELLED', '工具加载已取消');
        await context.assertCurrent?.();
        const descriptions: LoadedModelTool[] = [];
        for (const name of [...new Set(names)]) {
            if (!['sequential-thinking.sequentialthinking', this.modelName('sequential-thinking', 'sequentialthinking')].includes(name)) {
                const { spec } = this.resolve(name);
                if (context.retention.mode === 'temporary' && !spec.supportsTemporary) {
                    throw new AgentFault('TOOL_CAPABILITY_UNVERIFIED', '该共享工具尚未验证无正文落盘路由，临时会话保持关闭');
                }
            }
            descriptions.push(await this.describe(name, context.signal));
        }
        await context.assertCurrent?.();
        if (context.signal.aborted || this.closed) throw new AgentFault('TOOL_CANCELLED', '工具加载提交前已取消');
        const key = this.scopeKey(context);
        const scope = this.loadedScopes.get(key) ?? { conversationId: context.conversationId, principalId: context.principalId,
            runId: context.runId, rootRunId: context.rootRunId, runEpoch: context.runEpoch, tools: new Map<string, LoadedModelTool>() };
        for (const description of descriptions) scope.tools.set(description.function.name, structuredClone(description));
        this.loadedScopes.set(key, scope);
        return structuredClone(descriptions);
    }

    modelFunctionSchemas(context?: BoundToolContext): ModelFunctionSchema[] {
        if (!context || this.closed) return [];
        return structuredClone([...(this.loadedScopes.get(this.scopeKey(context))?.tools.values() ?? [])].map(entry => entry.function));
    }

    modelSchemaHashes(context: BoundToolContext): Readonly<Record<string, string>> {
        if (this.closed) return Object.freeze({});
        return Object.freeze(Object.fromEntries([...(this.loadedScopes.get(this.scopeKey(context))?.tools.values() ?? [])]
            .map(entry => [entry.function.name, entry.schemaHash])));
    }

    releaseLoadedTools(context: BoundToolContext): void {
        for (const [key, scope] of this.loadedScopes) if (scope.conversationId === context.conversationId && scope.principalId === context.principalId
            && scope.runId === context.runId && scope.rootRunId === context.rootRunId && scope.runEpoch === context.runEpoch) this.loadedScopes.delete(key);
    }

    isIndependentRead(name: string, args: Record<string, unknown>): boolean {
        if (['sandbox.sandbox_status', 'mcp_sandbox__sandbox_status'].includes(name)) {
            return (args.action === undefined || ['overview', 'envs'].includes(String(args.action)))
                && !['gcMode', 'gcScope', 'quarantineId'].some(key => key in args);
        }
        if (['sandbox.smart_search', 'mcp_sandbox__smart_search'].includes(name)) {
            const searches = Array.isArray(args.queries) ? args.queries : [args];
            return (args.mode === undefined || args.mode === 'exact') && !args.taskId && !args.cancel
                && searches.every(query => query && typeof query === 'object'
                    && ((query as Record<string, unknown>).mode === undefined || (query as Record<string, unknown>).mode === 'exact'));
        }
        return ['exa.web_search_exa', 'exa.web_fetch_exa', 'mcp_exa__web_search_exa', 'mcp_exa__web_fetch_exa'].includes(name);
    }

    async execute(name: string, args: unknown, context: BoundToolContext): Promise<unknown> {
        if (this.closed) throw new AgentFault('TOOL_SERVICE_UNAVAILABLE', '本工具连接已关闭');
        assertModelArguments(args);
        const descriptor = await this.describe(name, context.signal);
        if (!context.toolSchemaHash || context.toolSchemaHash !== descriptor.schemaHash) throw new AgentFault('TOOL_SCHEMA_STALE', '工具执行需要最终模型请求固定的schemaHash，请刷新定义后用于下一请求');
        validateToolArguments(args, descriptor.function.parameters);
        if (descriptor.toolId === 'sequential-thinking.sequentialthinking') return this.sequential.execute(args as Record<string, unknown>, context);
        const { configuration, spec } = this.resolve(name);
        if (context.retention.mode === 'temporary' && !spec.supportsTemporary) throw new AgentFault('TOOL_CAPABILITY_UNVERIFIED', '该共享工具尚未验证无正文落盘路由，临时会话保持关闭');
        const raw = spec.bind(args as Record<string, unknown>, context);
        if (typeof raw.url === 'string' && raw.url.startsWith('file:')) await assertReadablePath(fileURLToPath(raw.url), context);
        if (this.resourceToolIds.has(descriptor.toolId)) {
            await context.assertCurrent?.();
            if (context.signal.aborted) throw new AgentFault('TOOL_CANCELLED', '网页资源开始前已取消');
            try { return requireSuccessfulMcpResult(await this.resourceTools!.execute(spec.name, raw, context, await this.client(configuration)), descriptor.toolId); }
            catch (error) {
                if (error instanceof AgentFault) throw error;
                throw new AgentFault('TOOL_RESULT_UNKNOWN', '网页资源调用未获得可确认结果，保留原请求并先核状态', { toolId: descriptor.toolId }, true);
            }
        }
        const nativeSchema = this.nativeSchemas.get(descriptor.toolId);
        if (!nativeSchema) throw new AgentFault('TOOL_SCHEMA_STALE', '共享工具原生schema已淘汰，请重新描述');
        if (spec.serviceId === 'web-fetcher') assertWebToolArgumentSchema(spec.name, nativeSchema);
        const known = (nativeSchema.properties ?? {}) as Record<string, unknown>;
        const bound = Object.fromEntries(Object.entries(raw).filter(([key]) => Object.hasOwn(known, key)));
        validateToolArguments(bound, nativeSchema);
        await context.assertCurrent?.();
        if (context.signal.aborted) throw new AgentFault('TOOL_CANCELLED', '共享工具开始前已取消');
        try {
            return requireSuccessfulMcpResult(await (await this.client(configuration)).invoke(spec.name, bound, context.signal), descriptor.toolId);
        }
        catch (error) {
            if (error instanceof AgentFault) throw error;
            throw new AgentFault('TOOL_RESULT_UNKNOWN', '共享工具调用未获得可确认结果，保留原动作并先核状态', { toolId: descriptor.toolId }, true);
        }
    }

    releaseLocalRun(conversationId: string, runId: string): void { this.sequential.release(conversationId, runId); }

    async releaseResourceLeases(context: BoundToolContext): Promise<void> { await this.resourceTools?.release?.(context); }

    async prepareTemporaryConversationClose(owner: ResourceConversationOwner): Promise<void> {
        await this.resourceTools?.prepareTemporaryConversationClose?.(owner);
    }

    async forgetTemporaryConversation(owner: ResourceConversationOwner): Promise<void> {
        await this.resourceTools?.forgetTemporaryConversation?.(owner);
    }

    async close(): Promise<void> {
        this.closed = true;
        let leaseFailed = false;
        let leaseError: unknown;
        try { await this.resourceTools?.close?.(); } catch (error) { leaseFailed = true; leaseError = error; }
        this.sequential.clear();
        this.loadedScopes.clear();
        this.cache.clear();
        this.nativeSchemas.clear();
        this.schemaFailures.clear();
        const pendingClients = [...this.clients.values()];
        const clients = new Set(this.liveClients);
        this.clients.clear();
        await Promise.all(pendingClients.map(async pending => { try { clients.add(await pending); } catch {} }));
        await Promise.all([...clients].map(async client => { try { await client.close(); } catch {} }));
        this.liveClients.clear();
        if (leaseFailed) throw leaseError;
    }
}
