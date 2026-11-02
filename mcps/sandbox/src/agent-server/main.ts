#!/usr/bin/env -S node --max-semi-space-size=8
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { AgentFault, PROTOCOL_VERSION, SERVER_VERSION, type ServerDescriptor } from './protocol.js';
import { defaultDataDir, initializeRuntime, processAlive, publishDescriptor, readServerDescriptor } from './discovery.js';
import { listenAgentTransport, type AgentTransport } from './transport.js';
import { createAgentRuntime } from './runtime.js';
import { openAgentStore } from './storage/index.js';
import { createSqliteConfigurationPorts } from './storage/configuration.js';
import { createAgentServices, type RetentionCacheSnapshot } from './server-services.js';
import type { BrokerClientFactory, SharedServiceConfiguration } from './tools/broker-client.js';
import { createRetentionMaintenance } from './retention-maintenance.js';
import type { RetentionSweepResult } from './storage/port.js';

export interface StartServerOptions {
    dataDir?: string;
    idleTimeoutMs?: number;
    deadlineAt?: string;
    configurationSourceRoots?: string[];
    sharedServices?: readonly SharedServiceConfiguration[];
    sharedClientFactory?: BrokerClientFactory;
    temporaryWebResources?: boolean;
    onRetentionSweep?: (observation: { sweep: RetentionSweepResult; cache: RetentionCacheSnapshot }) => void;
}

export async function startAgentServer(options: StartServerOptions = {}): Promise<{
    descriptor: ServerDescriptor;
    close(): Promise<void>;
}> {
    const major = Number(process.versions.node.split('.')[0]);
    if (major < 24) throw new AgentFault('AGENT_RUNTIME_UNSUPPORTED', 'Agent Server需要专用Node 24或更新的已验运行时');
    const dataDir = resolve(options.dataDir ?? defaultDataDir());
    const previous = await readServerDescriptor(dataDir);
    if (previous && previous.pid !== process.pid && processAlive(previous.pid)) {
        throw new AgentFault('SERVER_ALREADY_RUNNING', '已有核心进程，保留原实例并使用原描述');
    }
    const authority = await initializeRuntime(dataDir);
    if (process.platform !== 'win32' && previous && !processAlive(previous.pid)) {
        try { await fs.unlink(authority.endpoint); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    const descriptor: ServerDescriptor = { schemaVersion: 1, serverInstanceId: randomUUID(), pid: process.pid,
        processStartedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(), endpoint: authority.endpoint,
        protocolVersion: PROTOCOL_VERSION, serverVersion: SERVER_VERSION, credentialRef: authority.credentialRef,
        principalId: authority.principalId, dataDir };
    const store = await openAgentStore({ dataDir: join(dataDir, 'store') });
    let services: Awaited<ReturnType<typeof createAgentServices>> | undefined;
    const runtime = createAgentRuntime({ store, onConversationClosed: async conversation => services?.onConversationClosed(conversation),
        reconcileRunCleanup: input => services?.reconcileRunCleanup(input) ?? Promise.resolve('unconfirmed'),
        ...(typeof store.persistent.sweepRetention === 'function' ? { internalChildRetentionOwnership: 'parent-cascade-v1' as const } : {}) });
    let transport: AgentTransport | undefined;
    let idleTimer: NodeJS.Timeout | undefined;
    let deadlineTimer: NodeJS.Timeout | undefined;
    let lastActiveAt = performance.now();
    let activeRequests = 0;
    let idleCheckPending = false;
    let closing: Promise<void> | null = null;
    let retentionMaintenance: ReturnType<typeof createRetentionMaintenance> | undefined;

    const close = (): Promise<void> => {
        if (closing) return closing;
        closing = (async () => {
            if (idleTimer) clearInterval(idleTimer);
            if (deadlineTimer) clearTimeout(deadlineTimer);
            await retentionMaintenance?.stop();
            process.removeListener('SIGINT', handleSignal);
            process.removeListener('SIGTERM', handleSignal);
            await services?.close();
            await runtime.close();
            await transport?.close();
            const published = await readServerDescriptor(dataDir);
            if (published?.serverInstanceId === descriptor.serverInstanceId) await fs.unlink(join(authority.runtimeDir, 'server.json'));
            authority.secret.fill(0);
        })();
        return closing;
    };
    const handleSignal = (): void => { void close().catch(() => { process.exitCode = 1; }); };

    try {
        const { catalogPort } = createSqliteConfigurationPorts(store.persistent);
        services = await createAgentServices({ authority, store, runtime, catalogPort, configurationSourceRoots: options.configurationSourceRoots,
            sharedServices: options.sharedServices, sharedClientFactory: options.sharedClientFactory,
            temporaryWebResources: options.temporaryWebResources });
        transport = await listenAgentTransport({ authority, descriptor,
            runtime: { dispatch: async (method, params, client) => {
                activeRequests++;
                try { return await services!.dispatch(method, params, client); }
                finally { activeRequests--; lastActiveAt = performance.now(); }
            }, subscribe: runtime.subscribe }, onShutdown: handleSignal });
        await publishDescriptor(authority, descriptor);
        lastActiveAt = performance.now();
        retentionMaintenance = createRetentionMaintenance({
            sweep: () => store.persistent.sweepRetention({ limit: 10, maxFiles: 100 }),
            afterSweep: async result => {
                const cache = await services!.applyRetentionSweep(result);
                try { options.onRetentionSweep?.({ sweep: structuredClone(result), cache: structuredClone(cache) }); }
                catch (error) { console.error('[sandbox-agent] retention observer failed:', error instanceof AgentFault ? error.code : String(error)); }
            },
            blocked: () => Boolean(closing) || Boolean(services?.hasMetadataWrites()),
            onError: error => console.error('[sandbox-agent] retention maintenance failed:', error instanceof AgentFault ? error.code : String(error)),
        });
        void retentionMaintenance.tick();
        const idleTimeoutMs = options.idleTimeoutMs ?? 15 * 60_000;
        idleTimer = setInterval(() => {
            if (closing || idleCheckPending || retentionMaintenance?.busy()) return;
            idleCheckPending = true;
            void Promise.resolve(runtime.hasActiveWork()).then(active => {
                if (closing) return;
                lastActiveAt = Math.max(lastActiveAt, transport?.lastActivityAt() ?? 0);
                if (active || activeRequests > 0) lastActiveAt = performance.now();
                else if (performance.now() - lastActiveAt >= idleTimeoutMs) handleSignal();
            }).catch(() => { process.exitCode = 1; }).finally(() => { idleCheckPending = false; });
        }, Math.min(5000, Math.max(100, idleTimeoutMs)));
        idleTimer.unref();
        if (options.deadlineAt) {
            const deadline = Date.parse(options.deadlineAt);
            if (!Number.isFinite(deadline)) throw new AgentFault('INVALID_PARAMS', 'deadlineAt必须是ISO时间');
            const delay = deadline - Date.now();
            if (delay <= 0) throw new AgentFault('EXECUTION_WINDOW_CLOSED', '本次执行窗口已经结束');
            deadlineTimer = setTimeout(handleSignal, Math.min(delay, 2_147_483_647));
            deadlineTimer.unref();
        }
        process.once('SIGINT', handleSignal);
        process.once('SIGTERM', handleSignal);
        return { descriptor, close };
    } catch (error) {
        await close();
        throw error;
    }
}

function parseArguments(argv: string[]): StartServerOptions {
    const options: StartServerOptions = {};
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === '--data-dir') options.dataDir = argv[++index];
        else if (argument === '--configuration-source-root') {
            const directory = argv[++index];
            if (!directory) throw new AgentFault('INVALID_PARAMS', 'configuration-source-root需要明确目录');
            (options.configurationSourceRoots ??= []).push(resolve(directory));
        }
        else if (argument === '--deadline-at') options.deadlineAt = argv[++index];
        else if (argument === '--idle-ms') options.idleTimeoutMs = Number(argv[++index]);
        else throw new AgentFault('INVALID_PARAMS', '未知核心启动参数', { argument });
    }
    if (options.idleTimeoutMs !== undefined && (!Number.isFinite(options.idleTimeoutMs) || options.idleTimeoutMs < 100)) {
        throw new AgentFault('INVALID_PARAMS', 'idle-ms须至少100毫秒');
    }
    return options;
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (entry === import.meta.url) {
    startAgentServer(parseArguments(process.argv.slice(2))).then(({ descriptor }) => {
        process.stdout.write(JSON.stringify({ type: 'agent-server-ready', descriptor }) + '\n');
    }).catch(error => {
        const result = error instanceof AgentFault ? error.toJSON() : { code: 'SERVER_START_FAILED', message: '核心启动失败，原配置与数据已保留' };
        process.stderr.write(JSON.stringify({ type: 'agent-server-error', error: result }) + '\n');
        process.exitCode = 1;
    });
}
