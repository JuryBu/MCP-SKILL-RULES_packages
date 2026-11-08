import { promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir } from 'node:os';
import { AgentFault, canonicalJson, failure, operationHash, validateParams } from './protocol.js';
import { reconcileRunFailureView } from './run-failure-view.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import type { ClientIdentity, JsonObject, JsonValue, RpcResult } from './protocol.js';
import type { RuntimeAuthority } from './discovery.js';
import { createAgentWorkspacePorts } from './storage/index.js';
import type { AgentStore } from './storage/index.js';
import { createAgentProviderPorts } from './storage/temporary-provider.js';
import { createSqliteConfigurationPorts } from './storage/configuration.js';
import { SecretVault, NativeDpapiBackend } from './profiles/secret-vault.js';
import { createProfileModelService } from './profiles/service.js';
import { PROVIDER_RPC_SIGNATURES } from './profiles/rpc-signatures.js';
import { createProviderServices } from './providers/services.js';
import { readProviderBalance } from './providers/balance.js';
import type { ProviderBalance } from './providers/balance.js';
import type { CatalogPort } from './models/catalog.js';
import type { NormalizedResponse, ProviderProfile } from './providers/types.js';
import type { QuotaLimitDefinition } from './accounting/budget-ledger.js';
import type { createAgentRuntime, ExecutorContext } from './runtime.js';
import { ExecutorFailure } from './runtime.js';
import { createProviderExecutor } from './execution.js';
import type { ExecutionPlan } from './execution.js';
import { ToolRouter } from './tools/router.js';
import type { BoundToolContext, TrustedToolContext } from './tools/types.js';
import { ApprovalLedger } from './security/approvals.js';
import { createContextServerAdapter } from './context/server-adapter.js';
import { recordHistoryHit } from './context/feedback.js';
import { injectSummaryText } from './context/service.js';
import { createToolDeliveryStore } from './context/tool-delivery.js';
import type { StorePort } from './storage/port.js';
import type { RetentionSweepResult } from './storage/port.js';
import { MediaService } from './media/service.js';
import { createSqliteMediaPort } from './storage/media-port.js';
import type { MediaRpcStore } from './storage/media-port.js';
import { createConfigurationService, createConfigurationRequestBridge } from './configuration/index.js';
import { GlobalCommands } from './global-commands.js';
import { SharedMcpCatalog } from './tools/catalog.js';
import { ResourceRegistry } from './resources/registry.js';
import { WebResourceStore } from './resources/web-resource-store.js';
import { createSharedWebResourceTools } from './resources/shared-web-tools.js';
import type { BrokerClientFactory, SharedServiceConfiguration } from './tools/broker-client.js';
import type { GeminiTokenCountResult } from './providers/gemini-count-tokens.js';
import type { ContextEstimate, ExecutionLease } from './context/contracts.js';
import type { CoreRestorePort } from './workspace/restore.js';
import { createWorkspaceServerAdapter } from './workspace/server-adapter.js';
import { settlementForResponse } from './accounting/settlement.js';
import { releaseExecutionResources } from './execution-cleanup.js';
import { isStoppedUnknownWait, reconcileRunCleanup } from './cleanup-reconciliation.js';
import type { RunCleanupInput } from './cleanup-reconciliation.js';
import { appendCouncilUser } from '../council/api-input.js';
import { InputAttachmentService } from './media/input-attachments.js';
import type { AttachmentModelSelection } from './media/input-types.js';
import { convertMcpToolResult, hasMcpToolImages, renderMcpToolResults } from './media/tool-results.js';
import { INPUT_ATTACHMENT_RPC_METHOD_SPECS, dispatchInputAttachment } from './media/input-rpc.js';
import { DelegationTools } from './tools/delegation.js';
import { withInternalChildBudgets } from './delegation/journal.js';
import { childRootBudget, assertChildModel, assertChildContextBudget } from './delegation/execution-plan.js';
import { pinDelegationRules, readPinnedDelegationRules } from './delegation/rule-snapshot.js';
import { selectChildTools } from './delegation/tool-policy.js';
import type { PreparedChild } from './delegation/contracts.js';
import { createDelegationCatalog } from './models/delegation-catalog.js';
import { selectedInputSource } from './selected-input.js';
import { estimateNativeTextView, nativeViewHasMedia } from './context/input-estimate.js';
import type { ContextViewEstimator } from './context/contracts.js';
import { controlKey, requireControl } from './controller.js';
import type { ControlLease } from './controller.js';
import type { ContextDispatchSnapshot } from './storage/context-transactions.js';
import { ConversationLifecycleService, CONVERSATION_LIFECYCLE_RPC_METHOD_SPECS,
    createMigratingConversationLifecycleStorage, dispatchConversationLifecycle, readLifecycleNativeOrigin } from './conversation-lifecycle/index.js';

type Runtime = ReturnType<typeof createAgentRuntime>;

function mediaStore(value: unknown): value is MediaRpcStore {
    return Boolean(value && typeof value === 'object' && 'executeMedia' in value && typeof value.executeMedia === 'function'
        && 'queryMedia' in value && typeof value.queryMedia === 'function');
}

export interface ServerServiceOptions {
    authority: RuntimeAuthority;
    store: AgentStore;
    runtime: Runtime;
    catalogPort: CatalogPort;
    publish?: (context: ExecutorContext, response: NormalizedResponse) => Promise<JsonValue[]>;
    tools?: ToolRouter;
    sharedServices?: readonly SharedServiceConfiguration[];
    sharedClientFactory?: BrokerClientFactory;
    temporaryWebResources?: boolean;
    configurationSourceRoots?: readonly string[];
}

export const DEFAULT_SHARED_SERVICES: readonly SharedServiceConfiguration[] = Object.freeze([
    { serviceId: 'sandbox', endpoint: 'http://127.0.0.1:14588/sandbox/mcp', revision: 'builtin-read-pack-1', enabled: true },
    { serviceId: 'memory-store', endpoint: 'http://127.0.0.1:14588/memory-store/mcp', revision: 'builtin-read-pack-1', enabled: true },
    { serviceId: 'web-fetcher', endpoint: 'http://127.0.0.1:14588/web-fetcher/mcp', revision: 'builtin-read-pack-1', enabled: true },
    { serviceId: 'exa', endpoint: 'http://127.0.0.1:14588/exa/mcp', revision: 'builtin-read-pack-1', enabled: true },
    { serviceId: 'sequential-thinking', revision: 'builtin-read-pack-1', enabled: true },
]);

async function nativeVault(authority: RuntimeAuthority, store: AgentStore): Promise<SecretVault | undefined> {
    if (process.platform !== 'win32' || process.arch !== 'x64') return undefined;
    const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
    const manifestPath = join(packageRoot, 'dist', 'native', 'agent-native-manifest.json');
    let manifest: { schemaVersion?: number; supported?: boolean; artifacts?: { path: string; sha256: string }[] };
    try { manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')); }
    catch { return undefined; }
    const artifact = manifest.artifacts?.find(item => item.path === 'dist/native/agent-secret-vault.exe');
    if (manifest.schemaVersion !== 1 || manifest.supported !== true || !artifact) return undefined;
    const { protectedSecretPort } = createSqliteConfigurationPorts(store.persistent);
    return new SecretVault(protectedSecretPort, new NativeDpapiBackend({ executablePath: join(packageRoot, artifact.path), sha256: artifact.sha256 }));
}

function count(value: unknown, fallback: number, label: string): number {
    const result = value ?? fallback;
    if (!Number.isSafeInteger(result) || Number(result) < 1) throw new AgentFault('BUDGET_UNBOUNDED', `${label}须为有限正整数`);
    return Number(result);
}

function modalities(view: import('./providers/types.js').NativeSendView): string[] {
    const result = new Set(['text']);
    const visit = (value: unknown, depth: number): void => {
        if (!value || typeof value !== 'object' || depth > 12) return;
        if (Array.isArray(value)) { for (const item of value) visit(item, depth + 1); return; }
        const object = value as Record<string, unknown>;
        const mime = typeof object.mimeType === 'string' ? object.mimeType : typeof object.mime_type === 'string' ? object.mime_type : null;
        if (mime) result.add(mime.split('/')[0]);
        if (object.type === 'image_url' || object.type === 'input_image') result.add('image');
        for (const [name, item] of Object.entries(object)) if (name !== 'data' && name !== 'dataBase64') visit(item, depth + 1);
    };
    visit(view, 0);
    return [...result];
}

export interface RetentionCacheSnapshot {
    runtime: { clearedConversationIds: string[]; deferredConversationIds: string[] };
    context: { sourcePorts: number; sourceBytes: number; indexConversations: number; indexItems: number };
    deferredContextConversationIds: string[];
    tokenCountEntries: number;
}

const lifecycleRecoveries = new WeakMap<AgentStore, Promise<unknown>>();

export async function createAgentServices(options: ServerServiceOptions) {
    const { accountingPort, journal } = createAgentProviderPorts(options.store);
    const { profilePort } = createSqliteConfigurationPorts(options.store.persistent);
    const vault = await nativeVault(options.authority, options.store);
    const provider = createProviderServices({ accountingPort, profilePort, catalogPort: options.catalogPort, credentialAccess: vault });
    const metadataAbort = new AbortController();
    const globalCommands = new GlobalCommands(options.store);
    const profiles = createProfileModelService({ profilePort, credentials: vault, catalog: provider.models,
        refreshModels: profileId => provider.refreshModels(profileId, metadataAbort.signal) });
    const protectedPaths = [options.authority.runtimeDir, join(options.authority.dataDir, 'store'),
        join(homedir(), '.codex', 'auth.json'), join(homedir(), '.codex', 'secrets'),
        join(homedir(), '.config', 'sandbox-agent', 'credentials')];
    const workspace = createAgentWorkspacePorts(options.store);
    const resources = options.tools?.resources ?? new ResourceRegistry(new WebResourceStore(options.store.persistent,
        { adapterIds: ['web-native-sessions-v1', 'web-table-artifacts-v1', 'native.command'], temporaryBudget: options.store.temporaryMemoryBudget.scope('command-resource-receipts') }), options.authority.principalId);
    let shared = options.tools?.shared;
    if (!options.tools) {
        const webResources = createSharedWebResourceTools({ registry: resources, getClient: () => shared!.webResourceClient(),
            outputBudget: options.store.temporaryMemoryBudget.scope('web-resource-output'), temporaryEnabled: options.temporaryWebResources,
            isTemporaryConversationClosing: async context => {
                const record = await options.store.getRecord<{ principalId: string; state: string; retention: { mode: string } }>({
                    conversationId: context.conversationId, kind: 'conversation', id: context.conversationId });
                return record?.value.principalId === context.principalId && record.value.retention.mode === 'temporary'
                    && record.value.state === 'closing';
            },
            artifactOptions: () => ({ attachments: inputAttachments,
                backendOutputRoots: ['pages', 'downloads'].map(name => join(tmpdir(), 'mcp-web-fetcher', name)),
                downloadDirectory: join(tmpdir(), 'mcp-web-fetcher', 'downloads') }) });
        shared = new SharedMcpCatalog(options.sharedServices ?? DEFAULT_SHARED_SERVICES, options.sharedClientFactory, webResources);
    }
    const tools = options.tools ?? new ToolRouter({ protectedPaths, journal: workspace.journal, pendingTools: workspace.pendingTools,
        approvals: new ApprovalLedger(workspace.approvalStore), resources, shared });
    await options.runtime.setApprovalLedger(tools.approvals, tools.pendingTools);
    const dispatcher = provider.createDispatcher(withInternalChildBudgets(journal, options.runtime.internalChildren));
    const tokenCounts = new Map<string, { createdAt: number; value: Promise<GeminiTokenCountResult> }>();
    const tokenCountCooldowns = new Map<string, number>();
    const balanceCache = new Map<string, { expiresAt: number; value: Promise<ProviderBalance> }>();
    const conversationWrites = new AsyncLocalStorage<{ client: ClientIdentity; params: Record<string, unknown> }>();
    const contextWriteCommands = new Map<string, { hash: string; promise: Promise<RpcResult> }>();
    const configuration = createConfigurationService({ store: options.store,
        sourceRoots: options.configurationSourceRoots ?? [join(options.authority.dataDir, 'configuration')],
        authorizeGlobalWrite: (client, params) => options.runtime.authorizeGlobalWrite(client, params),
        authorizeConversationWrite: (client, params) => options.runtime.authorizeConversationWrite(client, params),
        authorizeConversationRead: async (client, conversationId) => {
            const result = await options.runtime.dispatch('conversations.get', { conversationId }, client);
            if (!result.ok) throw new AgentFault(result.error!.code, result.error!.message);
            return result;
        } });
    const configurationBridge = createConfigurationRequestBridge(configuration.resolveInstructions);
    const expiredContextCaches = new Set<string>();
    let workspaceHistory: Pick<StorePort, 'readHistory'> = options.store;
    let readRestoreFact: (context: ExecutorContext) => Promise<Record<string, unknown> | null> = async () => null;
    const contextStore = new Proxy(options.store, { get(target, property) {
        if (property === 'readHistory') return (query: import('./storage/port.js').HistoryQuery) => workspaceHistory.readHistory(query);
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
    } });
    let cancelMaintenance: (execution: ExecutionLease) => Promise<'resources_released' | 'unconfirmed'> = async () => 'unconfirmed';
    let inputAttachments: InputAttachmentService;
    const inputSelections = new WeakMap<ExecutionPlan, AttachmentModelSelection>();
    const contextService = createContextServerAdapter({ store: contextStore, provider, dispatcher, journal,
        readTaskPlan: async context => tools.readTaskPlan(await toolContext(context)),
        authorizeControlWrite: async conversationId => {
            const authorization = conversationWrites.getStore();
            if (!authorization || authorization.params.conversationId !== conversationId) throw new AgentFault('CONTROL_REQUIRED', '压缩控制写入需要原会话调用方');
            await options.runtime.authorizeConversationWrite(authorization.client, authorization.params);
            const record = await options.store.getRecord<ControlLease>(controlKey(conversationId));
            requireControl(record, authorization.params, authorization.client, Date.now());
            return { key: record!.key, revision: record!.revision };
        },
        maintenanceBudget: { lifecycle: {
            createRun: input => {
                const authorization = conversationWrites.getStore();
                if (!authorization) throw new AgentFault('CONTROL_REQUIRED', '维护压缩必须来自已验证的会话控制调用');
                return options.runtime.createMaintenanceRun(input, authorization, execution => cancelMaintenance(execution));
            },
            prepareRun: async input => {
                const authorization = conversationWrites.getStore();
                if (!authorization || authorization.params.conversationId !== input.execution.conversationId) {
                    throw new AgentFault('CONTROL_REQUIRED', '维护恢复需要原会话控制调用');
                }
                if (input.recoveredAttemptId) {
                    const link = await options.store.getRecord({ conversationId: input.execution.conversationId,
                        kind: 'step', id: `context:dispatch:${input.recoveredAttemptId}` });
                    const providerAttemptId = link?.value.providerAttemptId;
                    const saved = typeof providerAttemptId === 'string' ? await journal.readAttempt(providerAttemptId) : undefined;
                    const snapshot = saved?.attempt.snapshot as (import('./providers/types.js').RequestSnapshot & ContextDispatchSnapshot) | undefined;
                    const conversation = await options.store.getRecord({ conversationId: input.execution.conversationId,
                        kind: 'conversation', id: input.execution.conversationId });
                    if (link?.value.kind !== 'context_dispatch' || link.value.attemptId !== input.recoveredAttemptId
                        || saved?.state !== 'committed' || !saved.response || !snapshot || !conversation
                        || snapshot.conversationId !== input.execution.conversationId || snapshot.runId !== input.execution.runId
                        || snapshot.runEpoch !== input.execution.runEpoch || snapshot.rootBudgetId !== input.execution.rootBudgetId
                        || snapshot.compressionRequestAttemptId !== input.recoveredAttemptId
                        || snapshot.historyEpoch !== conversation.value.historyEpoch
                        || snapshot.effectiveCompressionModelFingerprint !== input.config.modelFingerprint) {
                        throw new AgentFault('OUTCOME_UNKNOWN', '维护恢复需要可核对的原Provider完整回执，原预算和候选继续保留', undefined, true);
                    }
                }
                await options.runtime.resumeMaintenanceRun(input, authorization, execution => cancelMaintenance(execution));
                return input.config;
            },
            finishRun: input => options.runtime.finishMaintenanceRun(input),
        } },
        resolveView: async (context, plan) => {
            const nativeGemini = plan.profile.protocol === 'gemini' && plan.profile.routePolicy.kind === 'direct';
            const countText = nativeGemini && new URL(plan.profile.baseUrl).origin === 'https://generativelanguage.googleapis.com';
            const estimateView: ContextViewEstimator = async (view, details) => {
                const hasMedia = nativeViewHasMedia(view);
                const counterKey = `${plan.profile.profileId}:${plan.profile.revision}:${plan.profile.credentialGeneration}:${plan.modelId}`;
                if ((!countText || Date.now() < (tokenCountCooldowns.get(counterKey) ?? 0)) && !hasMedia) return estimateNativeTextView(view, details);
                const viewHash = createHash('sha256').update(canonicalJson(view)).digest('hex');
                const parametersHash = createHash('sha256').update(canonicalJson(plan.parameters)).digest('hex');
                const key = `${context.snapshot.conversationId}:${context.snapshot.runId}:${context.snapshot.runEpoch}:${plan.profile.revision}:${plan.profile.credentialGeneration}:${plan.modelId}:${parametersHash}:${viewHash}`;
                let entry = tokenCounts.get(key);
                if (!entry || Date.now() - entry.createdAt > 60_000) {
                    const value = provider.countRequestTokens(plan.profile.profileId, plan.modelId, view, context.signal, plan.deadlineAt, plan.parameters).then(async counted => {
                        await options.store.commitTransition({ expected: [], contents: [{ conversationId: context.snapshot.conversationId,
                            contentId: `context-count:${randomUUID()}`, kind: 'context_token_count', indexHistory: false,
                            value: { inputTokens: counted.inputTokens, raw: counted.raw, source: counted.source, viewHash } as unknown as JsonValue }] });
                        return counted;
                    });
                    entry = { createdAt: Date.now(), value };
                    tokenCounts.set(key, entry);
                    void value.catch(() => { if (tokenCounts.get(key)?.value === value) tokenCounts.delete(key); });
                    while (tokenCounts.size > 32) tokenCounts.delete(tokenCounts.keys().next().value!);
                }
                let counted: GeminiTokenCountResult;
                try {
                    counted = await entry.value;
                    tokenCountCooldowns.delete(counterKey);
                } catch (error) {
                    if (context.signal.aborted || hasMedia || !(error instanceof AgentFault) || error.code !== 'E_COUNT_TOKENS_TIMEOUT') throw error;
                    tokenCountCooldowns.set(counterKey, Date.now() + 60_000);
                    while (tokenCountCooldowns.size > 32) tokenCountCooldowns.delete(tokenCountCooldowns.keys().next().value!);
                    await options.store.commitTransition({ expected: [], contents: [{ conversationId: context.snapshot.conversationId,
                        contentId: `context-count-timeout:${randomUUID()}`, kind: 'context_token_count_timeout', indexHistory: false,
                        value: { code: error.code, message: error.message, viewHash,
                            runId: context.snapshot.runId, runEpoch: context.snapshot.runEpoch, rootBudgetId: plan.rootBudgetId,
                            profileId: plan.profile.profileId, profileRevision: plan.profile.revision,
                            credentialGeneration: plan.profile.credentialGeneration, modelId: plan.modelId,
                            executionDeadlineAt: plan.deadlineAt,
                            requestDeadlineAt: typeof error.details?.requestDeadlineAt === 'string' ? error.details.requestDeadlineAt : null,
                            elapsedMs: Date.now() - entry.createdAt, observedAt: new Date().toISOString(),
                            fallback: 'native_view_utf8_upper_bound' } }] });
                    return estimateNativeTextView(view, details);
                }
                return { rules: 0, schema: 0, native: counted.inputTokens, summary: 0, retained: 0,
                    media: 0, protocol: 0, confidence: 'actual', totalInputTokens: counted.inputTokens,
                    tokenCountEvidence: { source: 'provider_native_count_tokens', scope: 'complete_native_input', protocol: plan.adapter.protocol,
                        profileId: counted.source.profileId, profileRevision: counted.source.profileRevision,
                        credentialGeneration: counted.source.credentialGeneration, modelId: counted.source.modelId,
                        adapterVersion: plan.adapter.version, viewHash, parametersHash: createHash('sha256').update(canonicalJson(plan.parameters)).digest('hex'),
                        requestHash: counted.source.requestHash, countRequestBodyHash: counted.source.requestBodyHash,
                        sourceRef: counted.source.endpoint, observedAt: counted.source.observedAt, deadlineAt: counted.source.deadlineAt } };
            };
            const fact = await readRestoreFact(context);
            const conversation = await options.store.getRecord<{ principalId: string }>({ conversationId: context.snapshot.conversationId,
                kind: 'conversation', id: context.snapshot.conversationId });
            if (!conversation) throw new AgentFault('NOT_FOUND', '请求准备所属会话已关闭');
            const roots = context.conversationOptions.writeRoots ?? context.conversationOptions.workspaceRoots ?? [];
            if (!Array.isArray(roots) || roots.some(root => typeof root !== 'string')) throw new AgentFault('WORKSPACE_REQUIRED', '写入根须由主调用方明确配置');
            const workspaceInstructions = ['Trusted workspace configuration:',
                `Approved writable roots: ${canonicalJson(roots)}.`,
                roots.length ? `Default working directory: ${roots[0]}. Use absolute file paths and pass this directory explicitly to run_command unless the task requires another approved root.`
                    : 'No writable workspace has been approved. Ask the caller to select one before writing or executing workspace commands.',
                'Do not guess a workspace directory or request access to a whole drive to locate the selected workspace.'];
            const suppliedInstructions = context.conversationOptions.instructions;
            const baseView = await configurationBridge.resolveBaseView({ ownerId: conversation.value.principalId,
                conversationId: context.snapshot.conversationId, protocol: plan.adapter.protocol,
                additionalInstructions: [...workspaceInstructions,
                    ...(suppliedInstructions === undefined ? [] : [typeof suppliedInstructions === 'string' ? suppliedInstructions : canonicalJson(suppliedInstructions)])].join('\n') });
            return { baseView: fact ? injectSummaryText(baseView, `Workspace restore fact: ${canonicalJson(fact)}`) : baseView,
                appendUser: context.conversationOptions.discussionOnly === true ? appendCouncilUser
                    : async (view: import('./providers/types.js').NativeSendView, content: JsonValue) => inputAttachments.appendUser(
                        context.snapshot.conversationId, view, content, inputSelections.get(plan)
                            ?? { profile: plan.profile, entry: (await provider.models.get(plan.profile.profileId, plan.modelId)).entry,
                                selectionSource: selectedInputSource(context) }, context.signal),
                renderToolResults: async (view, results) => renderMcpToolResults({
                    conversationId: context.snapshot.conversationId, view, results, attachments: inputAttachments,
                    selection: inputSelections.get(plan)
                        ?? { profile: plan.profile, entry: (await provider.models.get(plan.profile.profileId, plan.modelId)).entry,
                            selectionSource: selectedInputSource(context) }, signal: context.signal }),
                ...(nativeGemini ? { estimateView } : {}) };
        } });
    tools.setHistory({
        readHistory: query => workspaceHistory.readHistory(query),
        readArtifact: query => options.store.readArtifact(query),
        inspect: conversationId => contextService.compactionPort.inspect(conversationId),
        readSummary: input => contextService.compactionPort.readSummary(input),
        markHit: async (hit, context) => {
            await context.assertCurrent?.();
            if (context.signal.aborted) throw new AgentFault('TOOL_CANCELLED', '历史命中记录已取消');
            const capture = await contextService.compactionPort.inspect(context.conversationId);
            if (hit.conversationId !== context.conversationId || hit.historyEpoch !== capture.historyEpoch
                || hit.viewRevision !== capture.viewRevision) throw new AgentFault('PARENT_STALE', '历史查回来源已经变化，请重新查回当前原文或摘要');
            if (!hit.summaryId && hit.roundIds.length !== 1) throw new AgentFault('INVALID_PARAMS', '历史命中须对应一个明确原轮或摘要');
            if (hit.summaryId) {
                const node = capture.view.nodes.find(entry => entry.nodeId === hit.summaryId && entry.hash === hit.summaryHash)
                    ?? await contextService.compactionPort.readSummary({ conversationId: context.conversationId,
                        historyEpoch: capture.historyEpoch, nodeId: hit.summaryId, hash: hit.summaryHash, signal: context.signal });
                if (!node || node.hash !== hit.summaryHash || node.firstSeq !== hit.firstSeq || node.lastSeq !== hit.lastSeq
                    || canonicalJson(node.roundIds) !== canonicalJson(hit.roundIds)) {
                    throw new AgentFault('SOURCE_GAP', '历史命中须对应查回摘要的实际版本与原轮范围');
                }
            }
            return recordHistoryHit(contextStore, { conversationId: context.conversationId, historyEpoch: capture.historyEpoch,
                currentStep: capture.stepSeq, hitId: hit.hitId, signal: context.signal,
                ...(hit.summaryId ? { nodeId: hit.summaryId } : { roundId: hit.roundIds[0] }) });
        },
    });
    await options.runtime.setAccountingPort(accountingPort);
    cancelMaintenance = async execution => {
        const current = await contextService.compactionPort.readExecutionForCleanup(execution.conversationId);
        if (current && (current.runId !== execution.runId || current.runEpoch !== execution.runEpoch)) return 'unconfirmed';
        const result = await contextService.service.compactor!.cancel(execution.conversationId, { human: false });
        return result.state === 'unknown' ? 'unconfirmed' : 'resources_released';
    };
    const mediaPersistence = mediaStore(options.store.persistent) ? createSqliteMediaPort(options.store.persistent) : undefined;
    const media = new MediaService({ durable: mediaPersistence, temporaryBudget: options.store.temporaryMemoryBudget.scope('media'),
        retention: async conversationId => {
            const conversation = await options.store.getRecord<{ retention: import('./protocol.js').RetainPolicy }>({
                conversationId, kind: 'conversation', id: conversationId });
            if (!conversation) throw new AgentFault('NOT_FOUND', '媒体所属会话已关闭');
            return conversation.value.retention;
        } });
    const lifecycleStorage = createMigratingConversationLifecycleStorage({
        store: options.store, persistent: options.store.persistent, journal, media, workspace,
        runMutation: operation => options.store.withConversationLifecycleMutation(operation),
        onRouteApplied: (ids, mode) => options.store.applyConversationLifecycleRoutes(ids, mode),
    });
    let lifecycleRecovery = lifecycleRecoveries.get(options.store);
    if (!lifecycleRecovery) {
        lifecycleRecovery = lifecycleStorage.recoverColdStart();
        lifecycleRecoveries.set(options.store, lifecycleRecovery);
    }
    await lifecycleRecovery;
    const lifecycle = new ConversationLifecycleService({ store: options.store, storage: lifecycleStorage,
        authorizeRead: (client, params) => options.runtime.assertConversationIdle(String(params.conversationId), client, true),
        authorizeWrite: async (client, params) => {
            await options.runtime.authorizeConversationWrite(client, params);
            const conversationId = String(params.conversationId);
            const lease = await options.store.getRecord<ControlLease>(controlKey(conversationId));
            requireControl(lease, params, client, Date.now());
            return { key: lease!.key, revision: lease!.revision };
        },
        requireIdle: async (conversation, client) => { await options.runtime.assertConversationIdle(conversation.value.conversationId, client, true); },
    });
    inputAttachments = new InputAttachmentService({ store: options.store, media, limits: { maxViewBytes: 32 * 1024 * 1024 },
        readNativeSource: async (source, signal) => {
            if (signal?.aborted) throw new AgentFault('E_ATTACHMENT_CANCELLED', '本次原生来源读取已取消，原记录保持原样');
            const branched = await readLifecycleNativeOrigin(options.store, source);
            if (signal?.aborted) throw new AgentFault('E_ATTACHMENT_CANCELLED', '本次原生来源读取已取消，原记录保持原样');
            if (branched) return branched;
            const recorded = await journal.readAttempt(source.attemptId);
            if (signal?.aborted) throw new AgentFault('E_ATTACHMENT_CANCELLED', '本次原生来源读取已取消，原记录保持原样');
            if (recorded?.state !== 'committed' || !recorded.response
                || recorded.attempt.attemptId !== source.attemptId
                || recorded.attempt.snapshot.conversationId !== source.conversationId
                || recorded.attempt.snapshot.runId !== source.runId) {
                throw new AgentFault('E_REFERENCE_NATIVE_SOURCE_REQUIRED', '原生响应与所选媒体的对话、运行或尝试身份不同，原件保持原样');
            }
            return { value: recorded.response as unknown as JsonValue, protocol: recorded.attempt.snapshot.profile.protocol,
                modelId: recorded.attempt.snapshot.modelId };
        } });
    const delegation = new DelegationTools({ runtime: options.runtime.internalChildren,
        catalog: createDelegationCatalog(provider),
        globalModelRulesRef: async profileId => (await provider.profiles.get(profileId))?.globalModelRulesRef ?? null,
        frozenRules: context => readPinnedDelegationRules(options.store, context),
        selectContext: async (refs, context) => {
            await context.assertCurrent?.();
            const selection = await inputAttachments.resolveSelection(refs, context.conversationId,
                { principalId: context.principalId, clientId: 'internal-selected-context-read', signal: context.signal }, context.signal);
            await context.assertCurrent?.();
            return selection;
        } });
    tools.setDelegation(delegation);
    options.runtime.internalChildren.setToolSelectionPolicy(input => selectChildTools(input, shared?.childToolFacts() ?? []));
    let closed = false;
    let executorActivated = false;

    const toolContext = async (context: Pick<ExecutorContext, 'snapshot' | 'conversationOptions' | 'signal'>
        & Partial<Pick<ExecutorContext, 'checkpoint' | 'assertCurrent'>>, identity?: { stepId: string; actionId: string; attemptId: string }): Promise<TrustedToolContext> => {
        const conversation = await options.store.getRecord<{ principalId: string; retention: import('./protocol.js').RetainPolicy; policyRevision: number;
            callerHost: string | null; callerConversationId: string | null }>({ conversationId: context.snapshot.conversationId, kind: 'conversation', id: context.snapshot.conversationId });
        if (!conversation) throw new AgentFault('NOT_FOUND', '工具动作所属会话已关闭');
        const configuredRoots = context.conversationOptions.writeRoots ?? context.conversationOptions.workspaceRoots ?? [];
        if (!Array.isArray(configuredRoots) || configuredRoots.some(root => typeof root !== 'string')) throw new AgentFault('WORKSPACE_REQUIRED', '写入根须由主调用方明确配置');
        const command = context.conversationOptions.commandApproval;
        return { conversationId: context.snapshot.conversationId, runId: context.snapshot.runId,
            rootRunId: String(context.snapshot.rootRunId ?? context.snapshot.runId), runEpoch: context.snapshot.runEpoch,
            roundId: context.snapshot.activeRoundId ?? context.snapshot.runId, principalId: conversation.value.principalId,
            roots: configuredRoots as string[], signal: context.signal, retention: conversation.value.retention,
            deadlineAt: typeof context.snapshot.deadlineAt === 'string' ? context.snapshot.deadlineAt : undefined,
            policyRevision: conversation.value.policyRevision, callerHost: conversation.value.callerHost ?? undefined,
            callerConversationId: conversation.value.callerConversationId ?? undefined,
            actionId: identity?.actionId, attemptId: identity?.attemptId,
            protectedPaths,
            ...(command && typeof command === 'object' ? { command: command as TrustedToolContext['command'] } : {}),
            ...(context.assertCurrent ? { assertCurrent: () => context.assertCurrent!() }
                : context.checkpoint ? { assertCurrent: () => context.checkpoint!('executing_tools') } : {}) };
    };

    type WorkspaceAuthority = { client: ClientIdentity; params: Record<string, unknown>; bound: BoundToolContext };
    const workspaceAuthorities = new WeakMap<BoundToolContext, WorkspaceAuthority>();
    const workspaceAuthorityKey = Symbol('workspace-authority');
    const restoreRuns = new Map<string, { execution: ExecutionLease; abort: AbortController; settled: Promise<void>; release(): void }>();
    const resolveWorkspaceContext = async (params: Record<string, unknown>, client: ClientIdentity,
        request?: { access: 'read' | 'write'; purpose: string; restorePlanId?: string }): Promise<BoundToolContext> => {
        const reading = request?.access === 'read';
        if (reading) {
            const allowed = await options.runtime.dispatch('conversations.get', { conversationId: params.conversationId }, client);
            if (!allowed.ok) throw new AgentFault(allowed.error!.code, allowed.error!.message);
        }
        const conversation = reading ? (await options.store.getRecord({ conversationId: String(params.conversationId), kind: 'conversation',
            id: String(params.conversationId) }))!.value as unknown as import('./runtime.js').ConversationData : await options.runtime.authorizeConversationWrite(client, params);
        let runId = typeof params.runId === 'string' ? params.runId : conversation.activeRunId;
        if (!runId) {
            let cursor: string | undefined;
            let latest: { runId: string; runEpoch: number } | undefined;
            do {
                const page = await options.store.listRecords({ conversationId: conversation.conversationId, kind: 'run', limit: 200, cursor });
                for (const entry of page.items) if (!latest || Number(entry.value.runEpoch) > latest.runEpoch) latest = {
                    runId: String(entry.value.runId), runEpoch: Number(entry.value.runEpoch) };
                cursor = page.hasMore ? page.nextCursor ?? undefined : undefined;
            } while (cursor);
            runId = latest?.runId ?? null;
        }
        if (!runId) throw new AgentFault('NOT_FOUND', '恢复操作需要原会话内的运行身份');
        let run = await options.store.getRecord({ conversationId: conversation.conversationId, kind: 'run', id: runId });
        if (!run) throw new AgentFault('NOT_FOUND', '恢复操作的原运行不存在');
        let restoreAbort: AbortController | undefined;
        if (request?.purpose === 'commit' && ['succeeded', 'failed', 'cancelled'].includes(String(run.value.state))) {
            if (!request.restorePlanId) throw new AgentFault('INVALID_PARAMS', '首次恢复提交需要原预览ID');
            const abort = new AbortController();
            let release = () => {};
            const settled = new Promise<void>(resolveSettled => { release = resolveSettled; });
            const execution = await options.runtime.createMaintenanceRun({ conversationId: conversation.conversationId,
                operationId: `restore:${request.restorePlanId}`, purpose: 'workspace_restore' }, { client, params }, async () => {
                abort.abort('restore cancelled'); await settled; return 'resources_released';
            });
            restoreRuns.set(`${conversation.conversationId}:${request.restorePlanId}`, { execution, abort, settled, release });
            runId = execution.runId;
            run = await options.store.getRecord({ conversationId: conversation.conversationId, kind: 'run', id: runId });
            if (!run) throw new AgentFault('NOT_FOUND', '恢复维护运行尚未持久登记');
            restoreAbort = abort;
        }
        const snapshot = run.value as unknown as import('./protocol.js').RunSnapshot;
        const context = await toolContext({ snapshot, conversationOptions: { ...conversation.options, ...(run.value.options as Record<string, unknown> ?? {}) },
            signal: restoreAbort?.signal ?? new AbortController().signal }, { stepId: snapshot.activeStepId ?? runId, actionId: randomUUID(), attemptId: randomUUID() }) as BoundToolContext;
        const authorization = { client: structuredClone(client), params: structuredClone(params), bound: context };
        if (!reading) {
            workspaceAuthorities.set(context, authorization);
            Object.defineProperty(context, workspaceAuthorityKey, { value: authorization, enumerable: true });
        }
        context.assertCurrent = async () => {
            const latest = reading ? conversation : await options.runtime.authorizeConversationWrite(client, params);
            const current = await options.store.getRecord(run.key);
            if (!current || current.value.runEpoch !== context.runEpoch || latest.policyRevision !== context.policyRevision
                || current.value.effectState === 'unknown') throw new AgentFault('STALE_RUN_EPOCH', '恢复上下文的原执行或授权已经变化');
        };
        return context;
    };
    const quiesceWorkspace: CoreRestorePort['quiesce'] = async (input, context) => {
        const authorization = workspaceAuthorities.get(context) ?? (context as BoundToolContext & { [workspaceAuthorityKey]?: WorkspaceAuthority })[workspaceAuthorityKey];
        if (!authorization) throw new AgentFault('CONTROL_REQUIRED', '工作区停止点需要核心生成的可信恢复上下文');
        if (await workspace.journal.revision(context.conversationId) !== input.expectedWorkspaceRevision) {
            throw new AgentFault('VERSION_CONFLICT', '恢复前文件修改记录版本已经变化');
        }
        const currentConversation = await options.store.getRecord({ conversationId: context.conversationId, kind: 'conversation', id: context.conversationId });
        const runtimeInput = context.retention.mode === 'temporary' ? { ...input,
            expectedWorkspaceRevision: Number(currentConversation?.value.workspaceRevision ?? 0) } : input;
        const guard = await options.runtime.quiesceWorkspace(runtimeInput, context, authorization, async () => {
            const cancellation = await contextService.service.compactor!.cancel(context.conversationId, { human: false });
            if (cancellation.state === 'unknown') return false;
            return await tools.release(context) !== 'unconfirmed';
        });
        authorization.bound.runEpoch = context.runEpoch;
        return guard;
    };

    const workspaceService = createWorkspaceServerAdapter({ store: options.store, ports: workspace,
        authorizeConversationWrite: options.runtime.authorizeConversationWrite,
        resolveReadContext: async input => {
            const allowed = await options.runtime.dispatch('conversations.get', { conversationId: input.conversationId }, input.client);
            if (!allowed.ok) throw new AgentFault(allowed.error!.code, allowed.error!.message);
            const conversation = await options.store.getRecord({ conversationId: input.conversationId, kind: 'conversation', id: input.conversationId });
            return { conversationId: input.conversationId, principalId: input.client.principalId, signal: input.signal,
                retention: conversation!.value.retention as import('./protocol.js').RetainPolicy };
        },
        resolveBoundContext: input => resolveWorkspaceContext(input.params, input.client, input), quiesce: quiesceWorkspace,
    });
    workspaceHistory = workspaceService.historyStore;
    await options.runtime.setHistoryReader(workspaceService.historyStore);
    readRestoreFact = context => workspaceService.readRestoreFact({ conversationId: context.snapshot.conversationId,
        principalId: (context.snapshot.initiator as ClientIdentity | undefined)?.principalId ?? options.authority.principalId, signal: context.signal });

    const plan = async (context: ExecutorContext): Promise<ExecutionPlan> => {
        const profileId = context.conversationOptions.profileId;
        if (typeof profileId !== 'string' || !profileId) throw new AgentFault('E_PROFILE_REQUIRED', '先选择本次使用的API配置');
        const childPlan = context.snapshot.parentRunId ? context.snapshot.delegationPlan as PreparedChild | undefined : undefined;
        const profile = await provider.profiles.get(profileId, childPlan?.profileRevision);
        if (!profile) throw new AgentFault('E_PROFILE_NOT_FOUND', 'API配置不存在或已停用');
        const modelId = typeof context.conversationOptions.modelId === 'string' ? context.conversationOptions.modelId : profile.defaultModel;
        if (!modelId) throw new AgentFault('E_MODEL_REQUIRED', '先选择本次使用的模型');
        assertChildModel(context, profile, modelId);
        if (!childPlan && (context.conversationOptions.allowInternalAgents === true || context.conversationOptions.allowSubagents === true)) {
            const ruleContext = await toolContext(context);
            if (typeof ruleContext.principalId !== 'string' || typeof ruleContext.runEpoch !== 'number') {
                throw new AgentFault('MODEL_RULES_PIN_REQUIRED', '固定模型规则需要所属主体和运行代次');
            }
            await pinDelegationRules(options.store, { ...ruleContext, principalId: ruleContext.principalId, runEpoch: ruleContext.runEpoch }, { profile,
                taskModelRulesRef: context.conversationOptions.modelRulesRef, globalModelRulesRef: profile.globalModelRulesRef ?? null });
        }
        const { catalog, entry } = await provider.models.get(profileId, modelId);
        const budget = context.snapshot.budget;
        const parameters = context.conversationOptions.parameters && typeof context.conversationOptions.parameters === 'object'
            ? context.conversationOptions.parameters as JsonObject : {};
        const maxOutputTokens = count(budget.maxOutputTokens ?? parameters.maxOutputTokens ?? profile.parameterDefaults.maxOutputTokens,
            Math.min(4096, entry.maxOutputTokens.value ?? 4096), '最大输出token');
        const maxModelCalls = count(budget.maxModelCalls, 128, '模型调用次数');
        const deadlineAt = typeof budget.deadlineAt === 'string' ? budget.deadlineAt : String(context.snapshot.deadlineAt ?? '');
        const rootBudgetId = String(context.snapshot.rootRunId ?? context.snapshot.runId);
        const metered = budget.costMode === 'metered';
        const quotaLimitId = metered ? undefined : typeof budget.quotaLimitId === 'string' ? budget.quotaLimitId
            : (profile as ProviderProfile & { quotaLimitId?: string | null }).quotaLimitId;
        if (!metered && !quotaLimitId) throw new AgentFault('E_GLOBAL_BUDGET_REQUIRED', '先配置并选择跨全部任务的供应商费用总上限');
        const currency = typeof budget.currency === 'string' ? budget.currency : entry.pricing.value?.currency ?? (metered ? 'XXX' : undefined);
        if (!currency) throw new AgentFault('E_CURRENCY_UNKNOWN', '根预算需要明确币种');
        const inheritedBudget = await childRootBudget(context, accountingPort);
        if (inheritedBudget) {
            if (inheritedBudget.currency !== currency || inheritedBudget.quotaLimitId !== quotaLimitId) {
                throw new AgentFault('CHILD_BUDGET_REQUIRED', '子任务须沿用原根预算的币种与供应商总额度');
            }
        } else await accountingPort.execute({ type: 'create_budget', definition: { rootBudgetId, mode: metered ? 'metered' : budget.costMode === 'estimated' ? 'estimated' : 'hard',
            currency, maxCostMicros: typeof budget.maxCostMicros === 'number' ? budget.maxCostMicros : null,
            maxModelCalls, maxOutputTokens, deadlineAt, sourceRef: `run:${rootBudgetId}`, quotaLimitId: quotaLimitId ?? undefined } });
        const configuredTools = context.conversationOptions.tools;
        const toolNames = context.conversationOptions.toolsEnabled === false ? [] : Array.isArray(configuredTools)
            ? configuredTools.filter((tool): tool is string => typeof tool === 'string')
            : entry.tools.status === 'supported' && entry.tools.value === true ? null : [];
        if (shared && toolNames) {
            const preload: string[] = [];
            for (const name of toolNames) {
                if (name.startsWith('mcp_') || /^(?:sandbox|memory-store|web-fetcher|exa|sequential-thinking)\./u.test(name)) {
                    const described = await shared.describe(name, context.signal);
                    const index = toolNames.indexOf(name);
                    toolNames[index] = described.function.name;
                    preload.push(described.function.name);
                }
            }
            if (preload.length) {
                const loaded = await tools.execute('tool_load', { names: preload }, await toolContext(context));
                if (!loaded.ok) throw new AgentFault(loaded.error!.code, loaded.error!.message, loaded.error!.details,
                    loaded.error!.mayHaveStarted, loaded.error!.retryable);
            }
        }
        const selected: ExecutionPlan = { profile, adapter: provider.adapterFor(profile.protocol), modelId, rootBudgetId, deadlineAt,
            parameters: { ...parameters, maxOutputTokens }, maxOutputTokens, maxModelCalls, toolNames,
            catalogVersion: catalog.catalogVersion, capabilityVersion: 'catalog-validated-at-send', priceVersion: entry.pricing.value?.priceVersion ?? null };
        inputSelections.set(selected, { profile, entry, selectionSource: selectedInputSource(context) });
        return selected;
    };

    const toolDeliveries = createToolDeliveryStore(options.store);
    const providerExecutor = createProviderExecutor({ plan, dispatcher, tools, toolContext,
        renderToolResults: (context, selected, view, results) => renderMcpToolResults({
            conversationId: context.snapshot.conversationId, view, results, attachments: inputAttachments,
            selection: inputSelections.get(selected), signal: context.signal }),
        transformToolResult: async (context, selected, result, identity) => {
            const delivery = await toolDeliveries.preserve({ conversationId: context.snapshot.conversationId,
                runId: context.snapshot.runId, runEpoch: context.snapshot.runEpoch, stepId: identity.stepId,
                callId: result.callId }, result, {}, async received => {
                if (!hasMcpToolImages(received)) return received;
                const trusted = identity.toolContext;
                if (typeof trusted.principalId !== 'string' || typeof trusted.runEpoch !== 'number') {
                    throw new AgentFault('E_TOOL_IMAGE_OWNER_REQUIRED', '工具图片需要所属主体和运行代次');
                }
                return convertMcpToolResult({ result: received, attachments: inputAttachments, selection: inputSelections.get(selected),
                    signal: context.signal, owner: { conversationId: context.snapshot.conversationId, runId: context.snapshot.runId,
                        rootRunId: String(context.snapshot.rootRunId ?? context.snapshot.runId), runEpoch: trusted.runEpoch,
                        actionId: identity.actionId, stepId: identity.stepId, attemptId: identity.attemptId,
                        callId: received.callId, toolName: received.name, principalId: trusted.principalId } });
            });
            return delivery.sent;
        },
        prepareView: (context, selected, input) => configurationBridge.prepareView(() => contextService.prepareView(context, selected, input)),
        postStep: contextService.postStep,
        prepareRequest: async (context, selected, input) => {
            const { entry } = await provider.models.get(selected.profile.profileId, selected.modelId);
            if (entry.contextWindow.value === null) throw new AgentFault('E_CONTEXT_LIMIT_UNKNOWN', '当前模型缺少可核实的上下文上界');
            const estimate = contextService.readPreparedEstimate({ conversationId: context.snapshot.conversationId,
                view: input.view, modelId: selected.modelId });
            if (!estimate || !['actual', 'conservative'].includes(estimate.confidence)) {
                throw new AgentFault('E_CONTEXT_ESTIMATE_REQUIRED', '当前原生视图缺少匹配版本的实际计数或保守占用上界');
            }
            assertChildContextBudget(context, estimate.inputTokens);
            const outputModalities = Array.isArray(selected.parameters.responseModalities)
                ? selected.parameters.responseModalities.map(value => String(value).toLowerCase()) : ['text'];
            const prepared = await provider.prepareRequest({ rootBudgetId: selected.rootBudgetId, profileId: selected.profile.profileId, modelId: selected.modelId,
                parameters: selected.parameters, view: input.view, versions: input.versions,
                inputModalities: modalities(input.view), outputModalities, inputTokenUpperBound: estimate.inputTokens,
                inputUpperBoundReliable: true, maxOutputTokens: selected.maxOutputTokens, deadlineAt: selected.deadlineAt });
            assertChildModel(context, prepared.snapshot.profile, prepared.snapshot.modelId);
            return prepared;
        },
        publish: options.publish ?? ((context, response) => media.publish(context, response)),
        release: context => releaseExecutionResources(
            () => contextService.finishExecution(context),
            async () => tools.release(await toolContext(context))),
    });

    const executor: typeof providerExecutor = { ...providerExecutor, async execute(context) {
        let cancellation: Promise<'released' | 'unconfirmed'> | undefined;
        const abort = (): void => {
            cancellation ??= (async () => {
                const execution = await contextService.compactionPort.readExecutionForCleanup(context.snapshot.conversationId);
                if (!execution || execution.runId !== context.snapshot.runId || execution.runEpoch !== context.snapshot.runEpoch
                    || execution.rootBudgetId !== String(context.snapshot.rootRunId ?? context.snapshot.runId)) return 'released' as const;
                const result = await contextService.service.compactor!.cancel(context.snapshot.conversationId, { human: false });
                return result.state === 'unknown' ? 'unconfirmed' as const : 'released' as const;
            })().catch(() => 'unconfirmed' as const);
        };
        context.signal.addEventListener('abort', abort, { once: true });
        if (context.signal.aborted) abort();
        try {
            const outcome = await providerExecutor.execute(context);
            return await cancellation === 'unconfirmed' ? { ...outcome, status: 'outcome_unknown', effectState: 'unknown', cleanupState: 'unconfirmed' } : outcome;
        } catch (error) {
            if (await cancellation !== 'unconfirmed') throw error;
            return { status: 'outcome_unknown', effectState: 'unknown', cleanupState: 'unconfirmed',
                stopReason: error instanceof AgentFault ? error.code : 'EXECUTION_ERROR',
                ...(error instanceof ExecutorFailure ? { failure: { error: error.originalError.toJSON(), acceptance: error.facts.acceptance,
                    cleanupEvidence: 'unconfirmed' as const, actionId: error.facts.actionId ?? null, attemptId: error.facts.attemptId ?? null } }
                    : error instanceof AgentFault ? { failure: { error: error.toJSON(), acceptance: 'unknown' as const,
                        cleanupEvidence: 'unconfirmed' as const, actionId: null, attemptId: null } } : {}) };
        }
        finally { context.signal.removeEventListener('abort', abort); await cancellation; }
    } };

    const dispatch = async (method: string, params: Record<string, unknown>, client: ClientIdentity): Promise<RpcResult> => {
        try {
            if (closed) throw new AgentFault('INVALID_STATE', '核心正在关闭');
            if (method === 'server.info') {
                const result = await options.runtime.dispatch(method, params, client);
                if (!result.ok) return result;
                const info = result.data as JsonObject;
                const capabilities = info.capabilities as JsonObject;
                return { ...result, data: { ...info, capabilities: { ...capabilities,
                    automaticModelExecution: true,
                    executorActivation: capabilities.executor ? 'active' : 'on_profile_run' } } };
            }
            if (method === 'runs.get') {
                const result = await options.runtime.dispatch(method, params, client);
                return reconcileRunFailureView(result, { readBudget: rootBudgetId => accountingPort.read(rootBudgetId),
                    readAttempt: attemptId => journal.readAttempt(attemptId) });
            }
            const configurationResult = await configuration.dispatch(method, params, client);
            if (configurationResult) return configurationResult;
            if (Object.hasOwn(CONVERSATION_LIFECYCLE_RPC_METHOD_SPECS, method)) {
                return await dispatchConversationLifecycle(lifecycle, method, params,
                    { ...client, signal: metadataAbort.signal }) as RpcResult;
            }
            const inputMethod = INPUT_ATTACHMENT_RPC_METHOD_SPECS[method];
            if (inputMethod) {
                params = inputMethod.schema.parse(params);
                const allowed = await options.runtime.dispatch('conversations.get', { conversationId: params.conversationId }, client);
                if (!allowed.ok) return allowed;
                const caller = { principalId: client.principalId, clientId: client.clientId, signal: metadataAbort.signal };
                if (!inputMethod.writes) return { ok: true, data: await dispatchInputAttachment(inputAttachments, method, params, caller) as unknown as JsonValue };
                await options.runtime.authorizeConversationWrite(client, params);
                const key = { principalId: client.principalId, clientId: client.clientId, conversationId: String(params.conversationId), clientCommandId: String(params.clientCommandId) };
                const hash = operationHash(method, params);
                const receipt = await options.store.getReceipt(key);
                if (receipt) {
                    if (receipt.operationHash !== hash) throw new AgentFault('COMMAND_CONFLICT', '原附件准备命令已绑定其它参数');
                    return receipt.result;
                }
                const commandKey = canonicalJson(key);
                const pending = contextWriteCommands.get(commandKey);
                if (pending) {
                    if (pending.hash !== hash) throw new AgentFault('COMMAND_CONFLICT', '进行中的附件准备命令使用不同参数');
                    return await pending.promise;
                }
                const promise = (async (): Promise<RpcResult> => {
                    const result = { ok: true as const, data: await dispatchInputAttachment(inputAttachments, method, params, caller) as unknown as JsonValue };
                    const saved = await options.store.commitTransition({ expected: [], receipt: { key, operationHash: hash, result, createdAt: new Date().toISOString() } });
                    return saved.receipt?.result ?? result;
                })();
                contextWriteCommands.set(commandKey, { hash, promise });
                try { return await promise; }
                finally { if (contextWriteCommands.get(commandKey)?.promise === promise) contextWriteCommands.delete(commandKey); }
            }
            if (Object.hasOwn(workspaceService.methodSpecs, method)) {
                let result: Record<string, unknown> | undefined;
                let failed: unknown;
                try { result = await workspaceService.handle(method, params, { client, signal: metadataAbort.signal }) as Record<string, unknown>;
                    return { ok: true, data: result as JsonValue }; }
                catch (error) { failed = error; throw error; }
                finally {
                    if (method === 'changes.commit' && typeof params.restorePlanId === 'string') {
                        const key = `${String(params.conversationId)}:${params.restorePlanId}`;
                        const own = restoreRuns.get(key);
                        if (own) {
                            const cleanupUnknown = failed instanceof AgentFault && ['CLEANUP_UNCONFIRMED', 'OUTCOME_UNKNOWN'].includes(failed.code);
                            try { await options.runtime.finishMaintenanceRun({ execution: own.execution,
                                result: result?.state === 'complete' ? 'published' : failed instanceof AgentFault && !failed.mayHaveStarted && !cleanupUnknown ? 'failed' : 'unknown' }); }
                            finally { own.release(); restoreRuns.delete(key); }
                        }
                    }
                }
            }
            if (['conversations.compact', 'conversations.cancelCompaction', 'conversations.restartCompaction', 'conversations.recoverCompaction'].includes(method)) {
                if (method !== 'conversations.compact') params = validateParams(method, params);
                params = structuredClone(params);
                client = { ...client };
                if (method === 'conversations.compact' && params.mode === 'preview') {
                    const allowed = await options.runtime.dispatch('conversations.get', { conversationId: params.conversationId }, client);
                    if (!allowed.ok) return allowed;
                    return { ok: true, data: await contextService.compact({ conversationId: String(params.conversationId), mode: 'preview' }) as unknown as JsonValue };
                }
                await options.runtime.authorizeConversationWrite(client, params);
                if (typeof params.clientCommandId !== 'string' || !params.clientCommandId) throw new AgentFault('INVALID_PARAMS', '压缩控制需要原客户端命令ID');
                const key = { principalId: client.principalId, clientId: client.clientId, conversationId: String(params.conversationId), clientCommandId: params.clientCommandId };
                const hash = operationHash(method, params);
                const receipt = await options.store.getReceipt(key);
                if (receipt) {
                    if (receipt.operationHash !== hash) throw new AgentFault('COMMAND_CONFLICT', '同一压缩命令已经使用不同参数');
                    return receipt.result;
                }
                const commandKey = canonicalJson(key);
                const pending = contextWriteCommands.get(commandKey);
                if (pending) {
                    if (pending.hash !== hash) throw new AgentFault('COMMAND_CONFLICT', '进行中的压缩命令使用不同参数');
                    return await pending.promise;
                }
                const promise = conversationWrites.run({ client, params }, async (): Promise<RpcResult> => {
                    await options.runtime.authorizeConversationWrite(client, params);
                    const input = { conversationId: String(params.conversationId),
                        ...(typeof params.candidateId === 'string' ? { candidateId: params.candidateId } : {}),
                        ...(typeof params.expectedHistoryEpoch === 'number' ? { expectedHistoryEpoch: params.expectedHistoryEpoch } : {}),
                        ...(typeof params.expectedRunEpoch === 'number' ? { expectedRunEpoch: params.expectedRunEpoch } : {}) };
                    let result: RpcResult;
                    try {
                        const data = method === 'conversations.cancelCompaction' ? await contextService.cancelCompaction(input)
                            : method === 'conversations.restartCompaction' ? await contextService.restartCompaction(input)
                            : method === 'conversations.recoverCompaction' ? await contextService.recoverCompaction({ ...input, candidateId: String(params.candidateId) })
                            : await contextService.compact({ conversationId: input.conversationId, mode: 'manual', operationId: params.clientCommandId as string,
                                ...(params.budget ? { budget: params.budget as import('./protocol.js').JsonObject } : {}) });
                        result = { ok: true, data: data as unknown as JsonValue };
                    } catch (error) { result = failure(error); }
                    await options.runtime.authorizeConversationWrite(client, params);
                    const saved = await options.store.commitTransition({ expected: [], receipt: { key, operationHash: hash, result, createdAt: new Date().toISOString() } });
                    return saved.receipt?.result ?? result;
                });
                contextWriteCommands.set(commandKey, { hash, promise });
                try { return await promise; }
                finally { if (contextWriteCommands.get(commandKey)?.promise === promise) contextWriteCommands.delete(commandKey); }
            }
            if (method === 'server.getReceipt' && typeof params.conversationId === 'string') {
                const lost = await lifecycle.readColdLossReceipt(params.conversationId, String(params.targetClientCommandId), client);
                if (lost) return lost;
            }
            if (method === 'server.getReceipt' && !params.conversationId) {
                const status = await globalCommands.inspect(client, String(params.targetClientCommandId));
                if (status) return { ok: true, data: status };
            }
            if (method === 'server.readCommandResult') return { ok: true,
                data: await globalCommands.readResult(client, String(params.targetClientCommandId), params.offset as number | undefined,
                    params.maxBytes as number | undefined) };
            if (method === 'server.tools.list') {
                const entries = [...tools.list(), ...(shared?.list({ limit: 100, includeUnavailable: true }).entries ?? [])];
                const offset = params.cursor === undefined ? 0 : Number(params.cursor);
                const limit = Number(params.limit ?? 24);
                if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
                    throw new AgentFault('INVALID_PARAMS', '工具目录需要非负游标及1至100条的页大小');
                }
                return { ok: true, data: { items: entries.slice(offset, offset + limit),
                    nextCursor: offset + limit < entries.length ? String(offset + limit) : null, hasMore: offset + limit < entries.length } };
            }
            if (method === 'server.tools.describe') {
                const name = String(params.toolId);
                if (name.startsWith('mcp_') || /^(?:sandbox|memory-store|web-fetcher|exa|sequential-thinking)\./u.test(name)) {
                    if (!shared) throw new AgentFault('TOOL_SERVICE_UNAVAILABLE', '本核心尚未配置共享MCP');
                    return { ok: true, data: await shared.describe(name, metadataAbort.signal) as unknown as JsonValue };
                }
                const schema = tools.describe(name);
                return { ok: true, data: { toolId: `local.${schema.name}`, function: schema as unknown as JsonValue,
                    schemaHash: createHash('sha256').update(canonicalJson(schema.parameters)).digest('hex') } };
            }
            if (Object.hasOwn(PROVIDER_RPC_SIGNATURES, method)) {
                const perform = async (): Promise<RpcResult> => ({ ok: true,
                    data: await profiles.handle(method, params, { client, authorizeGlobalWrite: options.runtime.authorizeGlobalWrite }) });
                if (['profiles.list', 'profiles.get', 'profiles.validate', 'models.list', 'models.get'].includes(method)) return await perform();
                await options.runtime.authorizeGlobalWrite(client, params);
                return await globalCommands.execute(method, params, client, perform);
            }
            if (method === 'budgets.configureLimit') {
                await options.runtime.authorizeGlobalWrite(client, params);
                return await globalCommands.execute(method, params, client, async () => ({ ok: true,
                    data: await accountingPort.execute({ type: 'create_quota_limit', definition: params.definition as QuotaLimitDefinition }) }));
            }
            if (method === 'usage.overview') {
                const conversationId = typeof params.conversationId === 'string' ? params.conversationId : undefined;
                let profileId = typeof params.profileId === 'string' ? params.profileId : undefined;
                const rootBudgetIds = new Set<string>();
                if (conversationId) {
                    const authorized = await options.runtime.dispatch('conversations.get', { conversationId }, client);
                    if (!authorized.ok) return authorized;
                    const conversation = authorized.data as { options?: { profileId?: string } };
                    profileId ??= conversation.options?.profileId;
                    let cursor: string | undefined;
                    do {
                        const page = await options.store.listRecords<{ rootRunId: string; runId: string }>({
                            kind: 'run', conversationId, cursor, limit: 100 });
                        for (const record of page.items) rootBudgetIds.add(record.value.rootRunId ?? record.value.runId);
                        cursor = page.hasMore ? page.nextCursor ?? undefined : undefined;
                    } while (cursor);
                }
                const profile = profileId ? await provider.profiles.get(profileId) : null;
                const balanceKey = profile ? `${profile.profileId}:${profile.revision}:${profile.credentialGeneration}` : '';
                let balance = profile ? balanceCache.get(balanceKey) : undefined;
                if (profile && (!balance || balance.expiresAt <= Date.now())) {
                    balance = { expiresAt: Date.now() + 30_000, value: vault ? readProviderBalance(profile, vault)
                        : Promise.resolve({ status: 'unavailable', source: profile.label, balances: [], message: '凭据服务暂不可用' }) };
                    balanceCache.set(balanceKey, balance);
                    while (balanceCache.size > 64) balanceCache.delete(balanceCache.keys().next().value!);
                }
                const [conversationUsage, providerUsage, account] = await Promise.all([
                    options.store.persistent.readUsage({ rootBudgetIds: [...rootBudgetIds] }),
                    options.store.persistent.readUsage(profile ? { quotaScopeId: profile.quotaScopeId } : {}),
                    balance?.value ?? Promise.resolve({ status: 'unsupported', source: '未选择服务商', balances: [] }),
                ]);
                return { ok: true, data: { asOf: new Date().toISOString(), ...(profileId ? { profileId } : {}),
                    account,
                    conversation: conversationUsage,
                    providerUsage: { scope: 'local_tool', costs: providerUsage.costs,
                        amountStatus: providerUsage.amountStatus } } };
            }
            if (method === 'budgets.get') return { ok: true, data: await accountingPort.read(String(params.rootBudgetId)) };
            if (method === 'budgets.reconcileResponses') {
                await options.runtime.authorizeGlobalWrite(client, params);
                return await globalCommands.execute(method, params, client, async () => {
                    const items: JsonValue[] = [];
                    for (const attemptId of [...new Set(params.attemptIds as string[])]) {
                        try {
                            const stored = await journal.readAttempt(attemptId);
                            if (!stored) throw new AgentFault('NOT_FOUND', '找不到原费用尝试');
                            const ownerConversation = await options.store.getRecord<{ retention: import('./protocol.js').RetainPolicy }>({
                                conversationId: stored.attempt.snapshot.conversationId, kind: 'conversation', id: stored.attempt.snapshot.conversationId });
                            if (!ownerConversation || ownerConversation.value.retention.mode === 'temporary') {
                                items.push({ attemptId, status: 'retained', reason: 'temporary_financial_record_requires_original_port' });
                                continue;
                            }
                            const allowed = await options.runtime.dispatch('conversations.get', { conversationId: stored.attempt.snapshot.conversationId }, client);
                            if (!allowed.ok) { items.push({ attemptId, status: 'unavailable', error: allowed.error as unknown as JsonValue }); continue; }
                            const before = await accountingPort.read(stored.attempt.rootBudgetId);
                            const reservation = before.reservations.find(item => item.attemptId === attemptId);
                            if (!reservation) throw new AgentFault('NOT_FOUND', '原费用预留不存在');
                            if (stored.state !== 'committed' || !stored.response || reservation.postResponseUpperBound || reservation.state === 'settled') {
                                items.push({ attemptId, status: reservation.postResponseUpperBound ? 'already_reconciled' : 'retained',
                                    state: reservation.state, heldMicros: reservation.heldMicros });
                                continue;
                            }
                            const usageRevision = Math.max(0, ...before.charges.filter(charge => charge.attemptId === attemptId).map(charge => charge.usageRevision)) + 1;
                            const settlement = settlementForResponse({ attempt: stored.attempt, response: stored.response,
                                currency: before.budget.currency, usageRevision });
                            if (!settlement.postResponseUpperBound) {
                                items.push({ attemptId, status: 'retained', state: reservation.state, heldMicros: reservation.heldMicros });
                                continue;
                            }
                            const snapshot = stored.attempt.snapshot;
                            const price = snapshot.pricingSnapshot ?? snapshot.price;
                            await accountingPort.execute({ type: 'settle', ...settlement,
                                charges: settlement.charges.map(charge => ({ ...charge, usage: { settlement: charge.usage,
                                    priceSourceRef: price?.sourceRef ?? null, frozenAt: snapshot.frozenAt, snapshotHash: snapshot.snapshotHash,
                                    basis: charge.kind === 'calculated' ? 'frozen_price_reported_usage' : 'provider_reported_cost' } })) });
                            const after = await accountingPort.read(stored.attempt.rootBudgetId);
                            const actual = after.reservations.find(item => item.attemptId === attemptId)!;
                            items.push({ attemptId, status: 'reconciled', state: actual.state, beforeHeldMicros: reservation.heldMicros,
                                heldMicros: actual.heldMicros, usageRevision, actualAmountKnown: actual.state === 'settled' });
                        } catch (error) { items.push({ attemptId, status: 'failed', error: failure(error).error as unknown as JsonValue }); }
                    }
                    return { ok: true, data: { items, allProcessed: items.every(item => (item as Record<string, JsonValue>).status !== 'failed') } };
                });
            }
            if (method === 'conversations.countTokens') {
                const conversationId = String(params.conversationId);
                const allowed = await options.runtime.dispatch('conversations.get', { conversationId }, client);
                if (!allowed.ok) return allowed;
                const timeoutMs = Number(params.timeoutMs ?? 120_000);
                const deadlineAt = new Date(Date.now() + timeoutMs).toISOString();
                const controller = new AbortController();
                const cancel = () => controller.abort(metadataAbort.signal.reason ?? new AgentFault('E_COUNT_TOKENS_CLOSED', '计数核心已关闭'));
                metadataAbort.signal.addEventListener('abort', cancel, { once: true });
                if (metadataAbort.signal.aborted) cancel();
                const timer = setTimeout(() => controller.abort(new AgentFault('E_COUNT_TOKENS_TIMEOUT', '输入准备或原生计数超过本次等待期限',
                    { requestPurpose: 'input_token_count', generationDispatch: 'not_started', executionDeadlineAt: deadlineAt })), timeoutMs);
                const aborted = new Promise<never>((_resolve, reject) => {
                    if (controller.signal.aborted) reject(controller.signal.reason);
                    else controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
                });
                const work = async () => {
                controller.signal.throwIfAborted();
                const conversation = await options.store.getRecord<{ options: Record<string, unknown> }>({
                    conversationId, kind: 'conversation', id: conversationId });
                controller.signal.throwIfAborted();
                const selected = conversation?.value.options;
                if (typeof selected?.profileId !== 'string') throw new AgentFault('E_PROFILE_REQUIRED', '先选择本次使用的API配置');
                const profile = await provider.profiles.get(selected.profileId);
                controller.signal.throwIfAborted();
                if (!profile) throw new AgentFault('E_PROFILE_NOT_FOUND', 'API配置不存在或已停用');
                if (profile.protocol !== 'gemini' || profile.routePolicy.kind !== 'direct') throw new AgentFault('E_COUNT_TOKENS_UNAVAILABLE', '当前原生计数仅支持Gemini协议直接路由');
                const modelId = typeof selected.modelId === 'string' ? selected.modelId : profile.defaultModel;
                if (!modelId) throw new AgentFault('E_MODEL_REQUIRED', '先选择本次计数使用的模型');
                const { entry } = await provider.models.get(profile.profileId, modelId);
                controller.signal.throwIfAborted();
                const view = await inputAttachments.appendUser(conversationId, { protocol: 'gemini', contents: [] },
                    params.input as JsonValue, { profile, entry }, controller.signal);
                controller.signal.throwIfAborted();
                const counted = await provider.countRequestTokens(profile.profileId, modelId, view, controller.signal,
                    deadlineAt, (selected.parameters ?? {}) as JsonObject);
                return { ok: true, data: { ...counted, scope: 'provided_input_only', automaticHistoryIncluded: false,
                    generationRequests: 0, historyWrites: 0, budgetMutations: 0 } as unknown as JsonValue };
                };
                try { return await Promise.race([work(), aborted]); }
                finally { clearTimeout(timer); metadataAbort.signal.removeEventListener('abort', cancel); }
            }
            if (method === 'conversations.context') {
                const allowed = await options.runtime.dispatch('conversations.get', { conversationId: params.conversationId }, client);
                if (!allowed.ok) return allowed;
                return { ok: true, data: await contextService.status({ conversationId: String(params.conversationId),
                    ...(typeof params.candidateId === 'string' ? { candidateId: params.candidateId } : {}) }) };
            }
            if (method === 'conversations.readArtifact' && (String(params.artifactId).startsWith('attachment:')
                || String(params.artifactId).startsWith('media:'))) {
                const allowed = await options.runtime.dispatch('conversations.get', { conversationId: params.conversationId }, client);
                if (!allowed.ok) return allowed;
                return { ok: true, data: await inputAttachments.read({ conversationId: String(params.conversationId), artifactId: String(params.artifactId),
                    offset: params.offset as number | undefined, maxBytes: params.maxBytes as number | undefined }) as unknown as JsonValue };
            }
            if (method === 'conversations.listArtifacts') {
                const allowed = await options.runtime.dispatch('conversations.get', { conversationId: params.conversationId }, client);
                if (!allowed.ok) return allowed;
                return { ok: true, data: await media.list({ conversationId: String(params.conversationId), cursor: params.cursor as string | undefined,
                    limit: params.limit as number | undefined, maxBytes: params.maxBytes as number | undefined }) };
            }
            if (method === 'runs.start' || method === 'runs.startInteractive' || method === 'runs.resume') {
                const allowed = await options.runtime.dispatch('conversations.get', { conversationId: params.conversationId }, client);
                if (!allowed.ok) return allowed;
                const conversation = await options.store.getRecord<{ options: Record<string, unknown> }>({ conversationId: String(params.conversationId),
                    kind: 'conversation', id: String(params.conversationId) });
                const run = method === 'runs.resume' ? await options.store.getRecord<{ options?: Record<string, unknown> }>({
                    conversationId: String(params.conversationId), kind: 'run', id: String(params.runId) }) : undefined;
                const selected = { ...conversation?.value.options, ...run?.value.options,
                    ...(params.options && typeof params.options === 'object' ? params.options as Record<string, unknown> : {}) };
                if (typeof selected.profileId === 'string' && selected.profileId) {
                    if (!executorActivated) { await options.runtime.setExecutor(executor); executorActivated = true; }
                } else throw new AgentFault('E_PROFILE_REQUIRED', '先选择本次使用的API配置');
            }
            return options.runtime.dispatch(method, params, client);
        } catch (error) { return failure(error); }
    };

    return { executor, dispatch, provider, profiles, tools, journal, accountingPort, media, inputAttachments, contextService, workspaceService, resolveWorkspaceContext, quiesceWorkspace, lifecycle,
        hasMetadataWrites: () => contextWriteCommands.size > 0 || restoreRuns.size > 0 || lifecycle.hasActiveWork(),
        applyRetentionSweep: async (result: RetentionSweepResult): Promise<RetentionCacheSnapshot> => {
            for (const group of result.conversations) if (group.state === 'deleted'
                || group.state === 'deferred' && group.reason === 'family_page_pending') {
                for (const conversationId of group.conversationIds) expiredContextCaches.add(conversationId);
            }
            const runtime = await options.runtime.applyRetentionSweep(result);
            for (const conversationId of [...expiredContextCaches].slice(0, 200)) {
                if (!contextService.releaseConversation(conversationId)) continue;
                for (const key of tokenCounts.keys()) if (key.startsWith(`${conversationId}:`)) tokenCounts.delete(key);
                expiredContextCaches.delete(conversationId);
            }
            return { runtime, context: contextService.cacheSnapshot(), deferredContextConversationIds: [...expiredContextCaches],
                tokenCountEntries: tokenCounts.size };
        },
        reconcileRunCleanup: (input: RunCleanupInput) => closed ? Promise.resolve('unconfirmed' as const) : reconcileRunCleanup(input, {
            readBudget: rootBudgetId => accountingPort.read(rootBudgetId),
            readAttempt: attemptId => journal.readAttempt(attemptId),
            releaseTools: async cleanup => cleanup.preserveUnknownOutcome === true
                ? tools.confirmReleased(await toolContext({ ...cleanup, signal: AbortSignal.abort('unknown wait ended') }))
                : tools.release(await toolContext({ ...cleanup, signal: AbortSignal.abort('cleanup reconciliation') })),
            releaseContext: async cleanup => {
                if (cleanup.preserveUnknownOutcome !== true) return contextService.reconcileCleanup({
                    conversationId: cleanup.snapshot.conversationId, runId: cleanup.snapshot.runId });
                const rootBudgetId = String(cleanup.snapshot.rootRunId ?? cleanup.snapshot.runId);
                if (isStoppedUnknownWait(cleanup.snapshot)) {
                    const state = await contextService.service.compactor!.context(cleanup.snapshot.conversationId);
                    const pending = state.candidate?.pendingRequest;
                    if (pending) {
                        const budget = await accountingPort.read(rootBudgetId);
                        const reservation = budget.reservations.find(item => item.attemptId === pending.attemptId);
                        const recorded = reservation ? await journal.readAttempt(reservation.attemptId) : undefined;
                        if (!reservation || reservation.state !== 'unknown' || reservation.rootBudgetId !== rootBudgetId
                            || !recorded || recorded.state !== 'unknown' || recorded.attempt.attemptId !== pending.attemptId
                            || recorded.attempt.rootBudgetId !== rootBudgetId || recorded.attempt.snapshot.actionId !== pending.actionId
                            || recorded.attempt.snapshot.conversationId !== cleanup.snapshot.conversationId
                            || recorded.attempt.snapshot.runId !== cleanup.snapshot.runId
                            || recorded.attempt.snapshot.runEpoch !== cleanup.snapshot.runEpoch - 1) return false;
                    }
                }
                return contextService.confirmUnknownCleanup({ conversationId: cleanup.snapshot.conversationId, runId: cleanup.snapshot.runId,
                    runEpoch: cleanup.snapshot.runEpoch, rootBudgetId });
            },
        }),
        onConversationClosed: async (conversation: { conversationId: string; retention: import('./protocol.js').RetainPolicy }) => {
            let resourceOwner: { conversationId: string; principalId: string } | undefined;
            if (conversation.retention.mode === 'temporary' && (shared?.resourceTools?.prepareTemporaryConversationClose
                || shared?.resourceTools?.forgetTemporaryConversation)) {
                if (!shared.resourceTools.prepareTemporaryConversationClose || !shared.resourceTools.forgetTemporaryConversation) {
                    throw new AgentFault('CLEANUP_UNCONFIRMED', '临时资源关闭接线不完整，原字节及映射保留');
                }
                const record = await options.store.getRecord<{ principalId: string; state: string; retention: { mode: string } }>({
                    conversationId: conversation.conversationId, kind: 'conversation', id: conversation.conversationId });
                if (!record || record.value.retention.mode !== 'temporary' || record.value.state !== 'closing') {
                    throw new AgentFault('CLEANUP_UNCONFIRMED', '尚未确认Core明确关闭该临时CID，原字节及映射保留');
                }
                resourceOwner = { conversationId: conversation.conversationId, principalId: record.value.principalId };
                await shared.prepareTemporaryConversationClose(resourceOwner);
            }
            if (!contextService.releaseConversation(conversation.conversationId)) {
                throw new AgentFault('CLEANUP_UNCONFIRMED', '所属上下文仍有未确认的压缩动作，原文继续保留');
            }
            await media.onConversationClosed(conversation);
            if (resourceOwner) await shared!.forgetTemporaryConversation(resourceOwner);
            for (const key of tokenCounts.keys()) if (key.startsWith(`${conversation.conversationId}:`)) tokenCounts.delete(key);
        },
        close: async (): Promise<void> => {
            closed = true;
            workspaceService.close();
            metadataAbort.abort();
            await Promise.allSettled([...contextWriteCommands.values()].map(command => command.promise));
            await lifecycle.close();
            await globalCommands.drain();
            try { await shared?.close(); }
            finally { await provider.close(); tokenCounts.clear(); balanceCache.clear(); expiredContextCaches.clear(); }
        },
        capabilities: { credentials: Boolean(vault), persistentAccounting: true, mediaPersistence: Boolean(mediaPersistence),
            providerProtocols: ['compatible_chat', 'gemini', 'openai_responses', 'anthropic'] } };
}
