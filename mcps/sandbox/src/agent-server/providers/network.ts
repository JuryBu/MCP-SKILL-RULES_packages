import { spawnSync } from 'node:child_process';
import { isIP } from 'node:net';
import { Agent, ProxyAgent } from 'undici';
import type { Dispatcher } from 'undici';
import { parseWindowsProxyServer } from '../../council/agy-runtime.js';

type ProxyEnvironmentKey = 'HTTP_PROXY' | 'http_proxy' | 'HTTPS_PROXY' | 'https_proxy' | 'ALL_PROXY' | 'all_proxy';
type ProxySource = ProxyEnvironmentKey | 'windows_system' | 'none';
type NativeFetchInit = Omit<RequestInit, 'dispatcher'> & { dispatcher: Dispatcher };
type NativeFetchWithDispatcher = (
    input: Parameters<typeof globalThis.fetch>[0], init: NativeFetchInit,
) => ReturnType<typeof globalThis.fetch>;

export interface ProviderWindowsProxySettings {
    enabled: boolean;
    server?: string;
    override?: string;
    pacConfigured: boolean;
}

export interface ProviderNetworkRoute {
    readonly route: 'direct' | 'proxy';
    readonly source: ProxySource;
    readonly reason: 'loopback' | 'no_proxy' | 'configured_proxy' | 'no_proxy_configured';
    readonly proxyConfigured: boolean;
}

export interface ProviderNetworkOptions {
    env?: Readonly<NodeJS.ProcessEnv>;
    platform?: NodeJS.Platform;
    windowsProxySettings?: ProviderWindowsProxySettings;
    timeoutMs?: number;
    standaloneTimeoutMs?: number;
    connectTimeoutMs?: number;
    headersTimeoutMs?: number;
    bodyTimeoutMs?: number;
    onRoute?: (route: ProviderNetworkRoute) => void;
}

export interface ProviderNetwork {
    readonly fetch: typeof globalThis.fetch;
    readonly diagnostics: readonly string[];
    routeFor(url: string | URL): ProviderNetworkRoute;
    close(): Promise<void>;
}

export class ProviderNetworkError extends Error {
    constructor(readonly code: 'E_NETWORK_CONFIGURATION' | 'E_PROXY_CONFIGURATION' | 'E_NETWORK_URL' | 'E_NETWORK_CLOSED', message: string) {
        super(message);
        this.name = 'ProviderNetworkError';
    }
}

interface ProxySetting {
    address?: string;
    source: ProxySource;
}

function boundedTimeout(value: number | undefined, fallback: number): number {
    const timeout = value ?? fallback;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 2_147_483_647) {
        throw new ProviderNetworkError('E_NETWORK_CONFIGURATION', '网络超时必须为有效的正整数毫秒数');
    }
    return timeout;
}

function readWindowsProxySettings(platform: NodeJS.Platform): ProviderWindowsProxySettings {
    if (platform !== 'win32') return { enabled: false, pacConfigured: false };
    const base = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
    const readValue = (name: string): string | undefined => {
        try {
            const result = spawnSync('reg.exe', ['query', base, '/v', name], {
                encoding: 'utf8', windowsHide: true, timeout: 1000, maxBuffer: 64 * 1024,
            });
            if (result.error) throw new Error();
            if (result.status !== 0) return undefined;
            const line = result.stdout.split(/\r?\n/u).find(value => new RegExp(`\\s${name}\\s`, 'iu').test(value));
            return line?.match(/REG_\w+\s+(.+)$/iu)?.[1]?.trim();
        } catch {
            throw new ProviderNetworkError('E_NETWORK_CONFIGURATION', '读取 Windows 系统固定代理失败');
        }
    };
    const enabled = readValue('ProxyEnable');
    return { enabled: enabled === '0x1' || enabled === '1', server: readValue('ProxyServer'),
        override: readValue('ProxyOverride'), pacConfigured: Boolean(readValue('AutoConfigURL')) };
}

function proxyAddress(value: string | undefined): string | undefined {
    if (!value?.trim()) return undefined;
    try {
        const raw = value.trim();
        if (/[\r\n]/u.test(raw)) throw new Error();
        const parsed = new URL(/^[a-z][a-z\d+.-]*:\/\//iu.test(raw) ? raw : `http://${raw}`);
        if (!['http:', 'https:'].includes(parsed.protocol) || parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error();
        return parsed.href;
    } catch {
        throw new ProviderNetworkError('E_PROXY_CONFIGURATION', '供应商代理须为有效的 HTTP 或 HTTPS 代理地址');
    }
}

function environmentProxy(env: Readonly<NodeJS.ProcessEnv>, keys: ProxyEnvironmentKey[], system?: string): ProxySetting {
    for (const key of keys) {
        if (env[key]?.trim()) return { address: proxyAddress(env[key]), source: key };
    }
    const address = proxyAddress(system);
    return { address, source: address ? 'windows_system' : 'none' };
}

function requestUrl(value: string | URL): URL {
    try {
        const parsed = new URL(value);
        if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error();
        return parsed;
    } catch {
        throw new ProviderNetworkError('E_NETWORK_URL', '供应商请求须使用不含地址内凭据的 HTTP 或 HTTPS URL');
    }
}

function normalizedHost(value: string): string {
    const host = value.replace(/^\[|\]$/gu, '').replace(/\.$/u, '').toLowerCase();
    if (isIP(host) === 6) {
        try { return new URL(`http://[${host}]`).hostname.slice(1, -1); } catch {}
    }
    return host;
}

function loopback(hostname: string): boolean {
    const host = normalizedHost(hostname);
    return host === 'localhost' || host.endsWith('.localhost') || host === '::1'
        || (isIP(host) === 4 && /^127\./u.test(host)) || /^::ffff:7f[\da-f]{2}:[\da-f]{1,4}$/u.test(host);
}

function noProxyTarget(entry: string): { host: string; port?: string } | undefined {
    if (isIP(entry)) return { host: normalizedHost(entry) };
    const matched = entry.match(/^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/u);
    if (!matched?.[1]) return undefined;
    const host = normalizedHost(matched[1]);
    if (matched[2] === undefined) return { host };
    const port = Number(matched[2]);
    return Number.isSafeInteger(port) && port >= 0 && port <= 65535 ? { host, port: String(port) } : undefined;
}

function matchesNoProxy(url: URL, entries: string[]): boolean {
    const host = normalizedHost(url.hostname);
    const port = url.port || (url.protocol === 'https:' ? '443' : '80');
    return entries.some(entry => {
        if (entry === '*') return true;
        if (entry.toLowerCase() === '<local>') return loopback(host)
            || (!url.hostname.includes('.') && !host.includes(':') && isIP(host) === 0);
        const target = noProxyTarget(entry);
        if (!target || (target.port !== undefined && target.port !== port)) return false;
        let pattern = target.host;
        if (pattern.startsWith('*')) pattern = pattern.slice(1);
        return pattern.startsWith('.') ? host.endsWith(pattern) : host === pattern;
    });
}

export function createProviderNetwork(options: ProviderNetworkOptions = {}): ProviderNetwork {
    const timeoutMs = options.timeoutMs === undefined ? undefined : boundedTimeout(options.timeoutMs, 300_000);
    const standaloneTimeoutMs = boundedTimeout(options.standaloneTimeoutMs, 300_000);
    const connectTimeoutMs = Math.min(boundedTimeout(options.connectTimeoutMs, 10_000), timeoutMs ?? Infinity);
    const headersTimeoutMs = boundedTimeout(options.headersTimeoutMs, 600_000);
    const bodyTimeoutMs = boundedTimeout(options.bodyTimeoutMs, 600_000);
    const env = options.env ?? process.env;
    const system = options.windowsProxySettings ?? readWindowsProxySettings(options.platform ?? process.platform);
    const diagnostics: string[] = [];
    if (system.pacConfigured) diagnostics.push('检测到系统 PAC，供应商网络仅支持固定代理，PAC 未执行');
    const fixed = system.enabled && !system.pacConfigured ? parseWindowsProxyServer(system.server) : {};
    const parts = system.server?.split(';').map(part => part.trim()).filter(Boolean) ?? [];
    const common = parts.length === 1 && !parts[0].includes('=') ? fixed.all : undefined;
    if (system.enabled && !system.pacConfigured && parts.some(part => /^(?:socks|ftp)\s*=/iu.test(part))) {
        diagnostics.push('系统代理中的 SOCKS 或 FTP 专用项未用于供应商 HTTP 请求');
    }
    const proxies = {
        'http:': environmentProxy(env, ['HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'], fixed.http ?? common),
        'https:': environmentProxy(env, ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy'], fixed.https ?? common),
    };
    const noProxy = [env.NO_PROXY?.trim() || env.no_proxy, system.override]
        .flatMap(value => value?.split(/[,;\s]+/u).filter(Boolean) ?? []);
    const selectRoute = (url: URL): { route: ProviderNetworkRoute; address?: string } => {
        const proxy = proxies[url.protocol as keyof typeof proxies];
        const reason = loopback(url.hostname) ? 'loopback' : matchesNoProxy(url, noProxy) ? 'no_proxy'
            : proxy.address ? 'configured_proxy' : 'no_proxy_configured';
        const route = Object.freeze({ route: reason === 'configured_proxy' ? 'proxy' as const : 'direct' as const,
            source: proxy.source, reason, proxyConfigured: Boolean(proxy.address) });
        return { route, address: route.route === 'proxy' ? proxy.address : undefined };
    };
    const dispatchers = new Map<string, Dispatcher>();
    const shutdown = new AbortController();
    const nativeFetch = globalThis.fetch as unknown as NativeFetchWithDispatcher;
    let closed = false;
    let closing: Promise<void> | undefined;
    const fetchImpl: typeof globalThis.fetch = async (input, init) => {
        if (closed) throw new ProviderNetworkError('E_NETWORK_CLOSED', '供应商网络已经关闭');
        const url = requestUrl(input instanceof Request ? input.url : input);
        const selected = selectRoute(url);
        const request = new Request(input, init);
        const callerSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
        const totalTimeoutMs = timeoutMs ?? (callerSignal ? undefined : standaloneTimeoutMs);
        const signals = [request.signal, shutdown.signal];
        if (totalTimeoutMs !== undefined) signals.push(AbortSignal.timeout(totalTimeoutMs));
        const signal = AbortSignal.any(signals);
        signal.throwIfAborted();
        const key = selected.address ?? 'direct';
        let dispatcher = dispatchers.get(key);
        if (!dispatcher) {
            const limits = { connectTimeout: connectTimeoutMs, headersTimeout: headersTimeoutMs, bodyTimeout: bodyTimeoutMs };
            try {
                dispatcher = selected.address ? new ProxyAgent({ uri: selected.address, ...limits }) : new Agent(limits);
            } catch {
                throw new ProviderNetworkError('E_PROXY_CONFIGURATION', '供应商网络连接配置无效');
            }
            dispatchers.set(key, dispatcher);
        }
        const dispatched: NativeFetchInit = { signal, dispatcher, redirect: 'error' };
        try { options.onRoute?.(selected.route); } catch {}
        return nativeFetch(request, dispatched);
    };
    return {
        fetch: fetchImpl,
        diagnostics: Object.freeze(diagnostics),
        routeFor: url => selectRoute(requestUrl(url)).route,
        close(): Promise<void> {
            if (closing) return closing;
            closed = true;
            shutdown.abort(new DOMException('供应商网络已经关闭', 'AbortError'));
            closing = Promise.allSettled([...dispatchers.values()].map(dispatcher => dispatcher.destroy())).then(results => {
                dispatchers.clear();
                if (results.some(result => result.status === 'rejected')) {
                    throw new ProviderNetworkError('E_NETWORK_CLOSED', '供应商网络连接释放失败');
                }
            });
            return closing;
        },
    };
}
