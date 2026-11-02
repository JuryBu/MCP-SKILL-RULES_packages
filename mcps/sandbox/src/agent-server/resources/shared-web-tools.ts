import { AgentFault, canonicalJson } from '../protocol.js';
import type { BrokerMcpClient } from '../tools/broker-client.js';
import type { SharedResourceTools } from '../tools/catalog.js';
import type { SharedToolSpec } from '../tools/adapters/types.js';
import { assertOwnedWebArguments, webPersistentToolAllowedArguments, webToolAllowedArguments } from '../tools/adapters/web.js';
import type { BoundToolContext } from '../tools/types.js';
import { ResourceLeaseKeeper } from './leases.js';
import type { ResourceConversationOwner, ResourceRegistry } from './registry.js';
import { createLazyNativeWebResourceFactory } from './web-native-adapter.js';
import { createNativeWebTableResourceAdapter } from './web-table-artifacts.js';
import type { WebTableArtifactOptions } from './web-table-artifacts.js';
import type { TemporaryBudgetPort } from '../media/temporary-budget.js';

const names = ['web_interact', 'web_pipeline'] as const;
const artifactNames = ['web_extract_tables', 'web_download'] as const;
type NativeToolName = typeof names[number];
type ArtifactToolName = typeof artifactNames[number];

function toolName(name: string): NativeToolName {
    if (!names.includes(name as NativeToolName)) throw new AgentFault('TOOL_NOT_ALLOWED', '该网页能力尚未接入持久资源');
    return name as NativeToolName;
}

export function createSharedWebResourceTools(options: {
    registry: ResourceRegistry;
    getClient: () => Promise<BrokerMcpClient>;
    outputBudget?: TemporaryBudgetPort;
    temporaryEnabled?: boolean;
    isTemporaryConversationClosing?: (context: BoundToolContext) => Promise<boolean>;
    artifactOptions?: () => Omit<WebTableArtifactOptions, 'client' | 'resources' | 'coreIssuerId'>;
}): SharedResourceTools {
    const native = createLazyNativeWebResourceFactory({ resourceStore: options.registry.store,
        coreIssuerId: options.registry.issuerId, getClient: options.getClient,
        outputBudget: options.outputBudget, temporaryEnabled: options.temporaryEnabled });
    const keepers = new Map<string, { context: BoundToolContext; keeper: ResourceLeaseKeeper }>();
    let artifactPending: Promise<Awaited<ReturnType<typeof createNativeWebTableResourceAdapter>>> | undefined;
    let artifactClient: BrokerMcpClient | undefined;
    const artifacts = async (client: BrokerMcpClient) => {
        if (!options.artifactOptions) throw new AgentFault('TOOL_CAPABILITY_UNVERIFIED', '表格附件工厂尚未接入');
        if (!artifactPending) {
            artifactClient = client;
            artifactPending = createNativeWebTableResourceAdapter({ ...options.artifactOptions(), client,
                resources: options.registry.store, coreIssuerId: options.registry.issuerId,
                outputBudget: options.outputBudget, temporaryEnabled: options.temporaryEnabled });
            void artifactPending.catch(() => { artifactPending = undefined; artifactClient = undefined; });
        }
        if (artifactClient !== client) throw new AgentFault('TOOL_SCHEMA_STALE', '表格资源须复用原目录连接');
        const value = await artifactPending;
        options.registry.register(value.adapter);
        return value;
    };
    options.registry.registerLoader('web-native-sessions-v1', async () => (await native.get()).adapter);
    if (options.artifactOptions) options.registry.registerLoader('web-table-artifacts-v1', async () =>
        (await artifacts(await options.getClient())).adapter);
    const ready = async (client: BrokerMcpClient) => {
        const value = await native.get();
        if (value.adapter.options.client !== client) throw new AgentFault('TOOL_SCHEMA_STALE', '网页资源须复用原目录连接');
        return value;
    };
    const stop = async (context?: BoundToolContext): Promise<void> => {
        const stopped: Promise<void>[] = [];
        for (const [key, value] of keepers) if (!context || value.context.principalId === context.principalId
            && value.context.rootRunId === context.rootRunId && (context.runId === context.rootRunId
                || value.context.conversationId === context.conversationId && value.context.runId === context.runId)) {
            keepers.delete(key);
            stopped.push(value.keeper.stop());
        }
        await Promise.all(stopped);
    };
    const stopConversation = async (owner: ResourceConversationOwner): Promise<void> => {
        const stopped: Promise<void>[] = [];
        for (const [key, value] of keepers) if (value.context.conversationId === owner.conversationId
            && value.context.principalId === owner.principalId) {
            keepers.delete(key); stopped.push(value.keeper.stop());
        }
        await Promise.all(stopped);
    };
    const prepareTemporaryConversationClose = async (owner: ResourceConversationOwner): Promise<void> => {
        await stopConversation(owner);
        await options.registry.prepareTemporaryConversationClose(owner);
    };
    const start = async (context: BoundToolContext): Promise<void> => {
        const key = canonicalJson([context.principalId, context.conversationId, context.runId]);
        const previous = keepers.get(key);
        if (previous?.context.runEpoch === context.runEpoch) return;
        if (previous) { keepers.delete(key); await previous.keeper.stop(); }
        const keeper = new ResourceLeaseKeeper(options.registry, context, async resource => {
            if (!resource) return;
            const current = await options.registry.store.get(resource.resourceId);
            if (current?.state === 'active') {
                current.state = 'unresolved';
                current.cleanupState = 'unconfirmed';
                await options.registry.store.put(current);
            }
        });
        keepers.set(key, { context, keeper });
        keeper.start();
    };
    const specifications: SharedToolSpec[] = names.map(name => ({ serviceId: 'web-fetcher', name,
        summary: '按需核验原请求与有限租约的普通持续网页读取，任务结束回收所属页面',
        effects: ['read', 'network'], supportsTemporary: options.temporaryEnabled === true,
        bind(args, context) { assertOwnedWebArguments(name, args, context, options.temporaryEnabled === true); return structuredClone(args); } }));
    if (options.artifactOptions) specifications.push(...artifactNames.map((name): SharedToolSpec => ({ serviceId: 'web-fetcher', name,
        summary: '普通网页表格或下载原件按原请求导入附件存储，保留实际字节、格式及SHA',
        effects: ['read', 'network'], supportsTemporary: options.temporaryEnabled === true,
        bind(args) { return structuredClone(args); } })));
    const artifactName = (name: string): ArtifactToolName => {
        if (!artifactNames.includes(name as ArtifactToolName)) throw new AgentFault('TOOL_NOT_ALLOWED', '该工具尚未接入网页原件');
        return name as ArtifactToolName;
    };
    return { specifications,
        allowedArguments(name) {
            if (names.includes(name as NativeToolName)) return webPersistentToolAllowedArguments(toolName(name))!;
            return artifactName(name) === 'web_download' ? ['url', 'timeout'] : webToolAllowedArguments(name)!;
        },
        async nativeSchema(name, client) {
            if (names.includes(name as NativeToolName)) return (await ready(client)).adapter.inputSchema(toolName(name));
            return (await artifacts(client)).inputSchema(artifactName(name));
        },
        async execute(name, args, context, client) {
            if (artifactNames.includes(name as ArtifactToolName)) {
                const value = await artifacts(client);
                await start(context);
                return value.execute(options.registry, artifactName(name), args, context);
            }
            await ready(client);
            const nameChecked = toolName(name);
            assertOwnedWebArguments(nameChecked, args, context, options.temporaryEnabled === true);
            await start(context);
            return native.dispatch({ registry: options.registry, toolName: nameChecked, args, context });
        },
        async release(context) {
            let closing = false;
            try {
                if (context.retention.mode === 'temporary') closing = await options.isTemporaryConversationClosing?.(context) === true;
            } catch (error) {
                await stopConversation(context); throw error;
            }
            if (closing) await prepareTemporaryConversationClose(context);
            else await stop(context);
        },
        prepareTemporaryConversationClose,
        async forgetTemporaryConversation(owner) {
            await stopConversation(owner);
            await options.registry.forgetTemporaryConversation(owner);
        },
        close: () => stop(),
    };
}
