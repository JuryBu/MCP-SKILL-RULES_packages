import { AgentFault } from '../protocol.js';
import { Agent } from 'undici';
import type { Dispatcher } from 'undici';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { SharedServiceId } from './adapters/types.js';

export interface BrokerToolDefinition {
    name: string;
    inputSchema: Record<string, unknown>;
}

export interface SharedServiceConfiguration {
    serviceId: SharedServiceId;
    endpoint?: string;
    revision: string;
    enabled: boolean;
}

export interface BrokerMcpClient {
    listTools(cursor?: string, signal?: AbortSignal): Promise<{ tools: BrokerToolDefinition[]; nextCursor?: string }>;
    invoke(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
    close(): Promise<void>;
    isAvailable?(): boolean;
    readonly whenClosed?: Promise<void>;
}

export type BrokerClientFactory = (configuration: SharedServiceConfiguration) => Promise<BrokerMcpClient>;
export type BrokerFetchFactory = (configuration: Readonly<SharedServiceConfiguration>) => typeof globalThis.fetch | Promise<typeof globalThis.fetch>;

export function createBrokerClientFactory(fetchForService: BrokerFetchFactory): BrokerClientFactory {
    return async configuration => {
        validateBrokerConfiguration(configuration);
        const transportFetch = await fetchForService(Object.freeze(structuredClone(configuration)));
        if (typeof transportFetch !== 'function') throw new AgentFault('TOOL_SERVICE_UNAVAILABLE', '共享MCP缺少可信传输工厂');
        return connectBrokerMcpClient(configuration, transportFetch);
    };
}

export function validateBrokerConfiguration(configuration: SharedServiceConfiguration): void {
    if (!['sandbox', 'memory-store', 'web-fetcher', 'exa', 'sequential-thinking'].includes(configuration.serviceId)
        || !configuration.revision || typeof configuration.enabled !== 'boolean') throw new AgentFault('INVALID_PARAMS', '共享MCP配置无效');
    if (configuration.serviceId === 'sequential-thinking') return;
    if (!configuration.endpoint) throw new AgentFault('INVALID_PARAMS', '共享MCP需要可信配置的明确broker端点');
    const endpoint = new URL(configuration.endpoint);
    if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.port !== '14588'
        || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !endpoint.pathname.endsWith('/mcp')) {
        throw new AgentFault('INVALID_PARAMS', '共享MCP仅复用明确配置的本机broker端点');
    }
}

export const createBrokerMcpClient: BrokerClientFactory = async configuration => {
    validateBrokerConfiguration(configuration);
    const dispatcher = new Agent();
    const nativeFetch = globalThis.fetch as unknown as (input: Parameters<typeof globalThis.fetch>[0],
        init: Omit<RequestInit, 'dispatcher'> & { dispatcher: Dispatcher }) => ReturnType<typeof globalThis.fetch>;
    try {
        return await connectBrokerMcpClient(configuration, (input, init) => nativeFetch(input, { ...init, dispatcher }), () => dispatcher.destroy());
    } catch (error) {
        await dispatcher.destroy().catch(() => {});
        throw error;
    }
};

async function connectBrokerMcpClient(configuration: SharedServiceConfiguration, transportFetch: typeof globalThis.fetch,
    releaseDispatcher?: () => Promise<void>): Promise<BrokerMcpClient> {
    validateBrokerConfiguration(configuration);
    const [{ Client }, { StreamableHTTPClientTransport, StreamableHTTPError }] = await Promise.all([
        import('@modelcontextprotocol/sdk/client/index.js'), import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
    ]);
    let terminationSignal: AbortSignal | undefined;
    const fetch: typeof globalThis.fetch = (input, init) => {
        const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
        const originalSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
        const signal = method.toUpperCase() === 'DELETE' && terminationSignal
            ? originalSignal ? AbortSignal.any([originalSignal, terminationSignal]) : terminationSignal : originalSignal;
        return transportFetch(input, { ...init, ...(signal ? { signal } : {}), redirect: 'error' });
    };
    const primary = new StreamableHTTPClientTransport(new URL(configuration.endpoint!), {
        reconnectionOptions: { maxRetries: 0, maxReconnectionDelay: 1000, initialReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
        fetch,
    });
    let available = true;
    let closed = false;
    let closing: Promise<void> | undefined;
    const operations = new Set<AbortController>();
    const request = async <Result>(run: (signal: AbortSignal) => Promise<Result>, signal?: AbortSignal): Promise<Result> => {
        const controller = new AbortController();
        const abort = () => controller.abort(signal?.reason);
        if (signal?.aborted) abort();
        else signal?.addEventListener('abort', abort, { once: true });
        operations.add(controller);
        try { return await run(controller.signal); }
        finally { operations.delete(controller); signal?.removeEventListener('abort', abort); }
    };
    let resolveClosed!: () => void;
    let rejectClosed!: (error: unknown) => void;
    const whenClosed = new Promise<void>((resolve, reject) => { resolveClosed = resolve; rejectClosed = reject; });
    void whenClosed.catch(() => {});
    const requests = new Map<string | number, { transport: InstanceType<typeof StreamableHTTPClientTransport>;
        reconnectionOptions: { maxRetries: number; maxReconnectionDelay: number; initialReconnectionDelay: number; reconnectionDelayGrowFactor: number } }>();
    const retire = () => {
        available = false;
        if (!requests.size && !closed) void transport.close().catch(() => {});
    };
    const finish = (requestId: string | number) => {
        const entry = requests.get(requestId);
        if (!entry) return;
        requests.delete(requestId);
        entry.reconnectionOptions.maxRetries = 0;
        void entry.transport.close().catch(() => {});
        if (!available && !requests.size) retire();
    };
    const transport: Transport = {
        get sessionId() { return primary.sessionId; },
        start() { return primary.start(); },
        setProtocolVersion(version) { primary.setProtocolVersion(version); },
        async send(message, options) {
            if (closed) throw new AgentFault('TOOL_SERVICE_UNAVAILABLE', '共享MCP连接已关闭');
            if (!('method' in message) || !('id' in message) || message.method === 'initialize') {
                if ('method' in message && message.method === 'notifications/cancelled') {
                    const requestId = message.params?.requestId;
                    try { await primary.send(message, options); }
                    finally { if (typeof requestId === 'string' || typeof requestId === 'number') finish(requestId); }
                    return;
                }
                await primary.send(message, options);
                return;
            }
            if (!available) throw new AgentFault('TOOL_SERVICE_UNAVAILABLE', '共享MCP连接已失效，原动作未发送');
            const requestId = message.id;
            const reconnectionOptions = { maxRetries: 2, maxReconnectionDelay: 1000, initialReconnectionDelay: 200, reconnectionDelayGrowFactor: 2 };
            const requestTransport = new StreamableHTTPClientTransport(new URL(configuration.endpoint!), {
                sessionId: primary.sessionId, fetch, reconnectionOptions,
            });
            if (primary.protocolVersion) requestTransport.setProtocolVersion(primary.protocolVersion);
            const entry = { transport: requestTransport, reconnectionOptions };
            requests.set(requestId, entry);
            requestTransport.onmessage = response => {
                if (closed || requests.get(requestId) !== entry) return;
                transport.onmessage?.(response);
                if ('id' in response && !('method' in response) && response.id === requestId) finish(requestId);
            };
            requestTransport.onerror = error => {
                if (closed || requests.get(requestId) !== entry) return;
                if (error instanceof StreamableHTTPError && (error.code === 404 || error.code === 410)) retire();
                transport.onerror?.(error);
            };
            try {
                await requestTransport.start();
                if (closed || requests.get(requestId) !== entry) return;
                await requestTransport.send(message, options);
            } catch (error) {
                if (requests.get(requestId) === entry) {
                    retire();
                    finish(requestId);
                }
                throw error;
            }
        },
        close() {
            closing ??= (async () => {
                closed = true;
                available = false;
                for (const controller of operations) controller.abort('共享MCP连接关闭');
                const entries = [...requests.values()];
                requests.clear();
                for (const entry of entries) entry.reconnectionOptions.maxRetries = 0;
                const failures: unknown[] = [];
                if (primary.sessionId) {
                    const controller = new AbortController();
                    terminationSignal = controller.signal;
                    const timer = setTimeout(() => controller.abort(new DOMException('共享MCP会话终止超时', 'TimeoutError')), 2000);
                    try { await primary.terminateSession(); }
                    catch (error) {
                        if (!(error instanceof StreamableHTTPError && (error.code === 404 || error.code === 410))) failures.push(error);
                    } finally { clearTimeout(timer); terminationSignal = undefined; }
                }
                const results = await Promise.allSettled([
                    ...entries.map(entry => Promise.resolve().then(() => entry.transport.close())),
                    Promise.resolve().then(() => primary.close()),
                ]);
                failures.push(...results.filter(result => result.status === 'rejected').map(result => result.reason));
                try { await releaseDispatcher?.(); } catch (error) { failures.push(error); }
                try { transport.onclose?.(); } catch (error) { failures.push(error); }
                if (failures.length) {
                    const error = failures.length === 1 ? failures[0] : new AggregateError(failures, '共享MCP资源关闭未全部成功');
                    rejectClosed(error);
                    throw error;
                }
                resolveClosed();
            })();
            return closing;
        },
    };
    primary.onmessage = message => { if (!closed) transport.onmessage?.(message); };
    primary.onerror = error => {
        if (closed) return;
        if (error instanceof StreamableHTTPError && (error.code === 404 || error.code === 410)) retire();
        transport.onerror?.(error);
    };
    const client = new Client({ name: 'sandbox-agent-tools', version: '1' }, { capabilities: {} });
    const timer = setTimeout(() => { void transport.close().catch(() => {}); }, 10000);
    try { await request(signal => client.connect(transport, { signal, timeout: 10000 })); }
    catch { await transport.close().catch(() => {}); throw new AgentFault('TOOL_SERVICE_UNAVAILABLE', '共享MCP连接尚未建立', { serviceId: configuration.serviceId }); }
    finally { clearTimeout(timer); }
    return {
        async listTools(cursor, signal) {
            const page = await request(requestSignal => client.listTools(cursor ? { cursor } : {}, { signal: requestSignal, timeout: 10000 }), signal);
            return { tools: page.tools.map(tool => ({ name: tool.name, inputSchema: tool.inputSchema })), nextCursor: page.nextCursor };
        },
        async invoke(name, args, signal) {
            return request(requestSignal => client.callTool({ name, arguments: args }, undefined, { signal: requestSignal, timeout: 45000 }), signal);
        },
        async close() { await client.close(); await whenClosed; },
        isAvailable() { return available && !closed; },
        whenClosed,
    };
}
