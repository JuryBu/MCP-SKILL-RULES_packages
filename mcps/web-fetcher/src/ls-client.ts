import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
    callCliAgent,
    isAntigravityCliInstalled,
    withCliEndpoint,
} from './antigravity-cli.js';
import {
    legacyAntigravityCatalog,
    parseAntigravityCatalog,
    selectAntigravityModel,
} from './antigravity-models.js';
import {
    AntigravityRpcError,
    antigravityRpcException,
    antigravityRpcFailure,
    callAntigravityModel,
    callAntigravityRpc,
    isAntigravityRpcUnsupported,
} from './antigravity-rpc.js';
import {
    antigravityFailure,
    remainingAntigravityMs,
    type AntigravityCatalog,
    type AntigravityEndpoint,
    type AntigravityRequest,
    type AntigravityResult,
} from './antigravity-types.js';

export interface AntigravityLsProcess {
    pid: number;
    executable: string;
    startedAt: number;
    commandLine: string;
    listeners: Array<{ address: string; port: number }>;
}

interface HubFile {
    name: string;
    modifiedAt: number;
    data: unknown;
}

export interface AntigravityDiscoveryOptions {
    daemonDirectory?: string;
    inspectProcesses?: (request: AntigravityRequest) => Promise<AntigravityLsProcess[]>;
}

export interface AntigravityClientDependencies {
    discover: (request: AntigravityRequest) => Promise<AntigravityEndpoint[]>;
    rpc: typeof callAntigravityRpc;
    generate: typeof callAntigravityModel;
    cliEndpoint: (request: AntigravityRequest,
        work: (endpoint: AntigravityEndpoint, scopedRequest: AntigravityRequest) => Promise<AntigravityResult>) => Promise<AntigravityResult>;
    cliAgent: (request: AntigravityRequest) => Promise<AntigravityResult>;
    cliInstalled: () => boolean | Promise<boolean>;
}

const STATUS_TTL_MS = 15000;
const MAX_HUB_BYTES = 32768;
const MAX_HUB_FILES = 128;
const LEGACY_MODELS = [
    'MODEL_PLACEHOLDER_M132',
    'MODEL_PLACEHOLDER_M20',
    'MODEL_PLACEHOLDER_M18',
    'MODEL_PLACEHOLDER_M16',
    'MODEL_PLACEHOLDER_M36',
];

function stopped(request: AntigravityRequest): AntigravityResult | null {
    if (request.signal?.aborted) return antigravityFailure('cancelled', 'Antigravity request cancelled');
    if (remainingAntigravityMs(request) <= 0) {
        return antigravityFailure('not-started', 'Antigravity deadline expired before generation');
    }
    return null;
}

function assertActive(request: AntigravityRequest): void {
    const failure = stopped(request);
    if (failure) throw new AntigravityRpcError(failure.error!, failure.outcome, false, false);
}

function normalizeExecutable(executable: string): string {
    return executable.replace(/\\/g, '/').toLowerCase();
}

function flag(commandLine: string, name: string): string | undefined {
    const match = commandLine.match(new RegExp(`(?:^|\\s)--${name}(?:=|\\s+)(?:"([^"]*)"|'([^']*)'|(\\S+))`, 'i'));
    return match ? match[1] ?? match[2] ?? match[3] : undefined;
}

function validProcess(processInfo: AntigravityLsProcess, modern: boolean): boolean {
    if (!Number.isInteger(processInfo.pid) || processInfo.pid <= 0
        || !Number.isFinite(processInfo.startedAt) || processInfo.startedAt <= 0
        || processInfo.startedAt > Date.now() + 1000
        || typeof processInfo.executable !== 'string' || typeof processInfo.commandLine !== 'string'
        || !Array.isArray(processInfo.listeners)) return false;
    const executable = normalizeExecutable(processInfo.executable);
    const commandExecutable = processInfo.commandLine.match(/^\s*(?:"([^"]+)"|(\S+))/);
    if (!commandExecutable || normalizeExecutable(commandExecutable[1] ?? commandExecutable[2]) !== executable) return false;
    if (modern) {
        return executable.endsWith('/antigravity/resources/bin/language_server.exe')
            && flag(processInfo.commandLine, 'override_ide_name')?.toLowerCase() === 'antigravity'
            && flag(processInfo.commandLine, 'subclient_type')?.toLowerCase() === 'hub';
    }
    return executable.endsWith('/language_server_windows_x64.exe')
        && (executable.includes('/antigravity/') || flag(processInfo.commandLine, 'override_ide_name')?.toLowerCase() === 'antigravity');
}

function ownedPort(processInfo: AntigravityLsProcess, port: unknown): port is number {
    return typeof port === 'number' && Number.isInteger(port) && port > 0 && port <= 65535
        && processInfo.listeners.some(listener => listener && listener.address === '127.0.0.1' && listener.port === port);
}

function endpointIdentity(processInfo: AntigravityLsProcess, port: number, token: string, useHttps: boolean): string {
    return createHash('sha256').update(JSON.stringify([
        processInfo.pid, normalizeExecutable(processInfo.executable), processInfo.startedAt,
        processInfo.commandLine, port, token, useHttps,
    ])).digest('hex');
}

export function validateAntigravityHub(
    hub: unknown,
    fileName: string,
    modifiedAt: number,
    processInfo: AntigravityLsProcess,
): AntigravityEndpoint | null {
    if (!hub || typeof hub !== 'object' || Array.isArray(hub) || !validProcess(processInfo, true)) return null;
    const data = hub as Record<string, unknown>;
    if (data.pid !== processInfo.pid || typeof data.csrfToken !== 'string'
        || !data.csrfToken || data.csrfToken.length > 4096 || /[\r\n]/.test(data.csrfToken)
        || !Number.isFinite(modifiedAt) || modifiedAt < processInfo.startedAt - 1000
        || modifiedAt > Date.now() + 5000 || !/^hub_\d+\.json$/.test(fileName)
        || Number(fileName.slice(4, -5)) !== data.httpPort) return null;
    const useHttps = !ownedPort(processInfo, data.httpPort);
    const port = useHttps ? data.httpsPort : data.httpPort;
    if (!ownedPort(processInfo, port)) return null;
    return {
        host: '127.0.0.1', port, pid: processInfo.pid, csrfToken: data.csrfToken,
        identity: endpointIdentity(processInfo, port, data.csrfToken, useHttps),
        transport: 'app-ls', ...(useHttps ? { useHttps: true } : {}),
    };
}

async function readHubFiles(directory: string, request: AntigravityRequest, ports: Set<number>): Promise<HubFile[]> {
    if (!ports.size) return [];
    let entries;
    try {
        entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
    }
    const files: HubFile[] = [];
    const names = entries.filter(entry => entry.isFile() && /^hub_\d+\.json$/.test(entry.name)
        && ports.has(Number(entry.name.slice(4, -5))));
    const metadata = await Promise.all(names.map(async entry => {
        try {
            const filename = path.join(directory, entry.name);
            const info = await fs.lstat(filename);
            return info.isFile() && info.size <= MAX_HUB_BYTES ? { filename, name: entry.name, info } : null;
        } catch {
            return null;
        }
    }));
    const candidates = metadata.filter(item => item !== null)
        .sort((left, right) => right.info.mtimeMs - left.info.mtimeMs).slice(0, MAX_HUB_FILES);
    for (const candidate of candidates) {
        assertActive(request);
        let handle;
        try {
            handle = await fs.open(candidate.filename, 'r');
            const info = await handle.stat();
            if (!info.isFile() || info.size > MAX_HUB_BYTES) continue;
            const buffer = Buffer.alloc(MAX_HUB_BYTES + 1);
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
            if (bytesRead > MAX_HUB_BYTES) continue;
            files.push({ name: candidate.name, modifiedAt: info.mtimeMs,
                data: JSON.parse(buffer.subarray(0, bytesRead).toString('utf8').replace(/^\uFEFF/, '')) });
        } catch {
            continue;
        } finally {
            await handle?.close();
        }
    }
    return files;
}

export async function inspectAntigravityLsProcesses(
    request: AntigravityRequest,
    execute: typeof execFile = execFile,
): Promise<AntigravityLsProcess[]> {
    assertActive(request);
    if (process.platform !== 'win32') return [];
    const script = [
        "$ErrorActionPreference = 'Stop'",
        "$ProgressPreference = 'SilentlyContinue'",
        '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false',
        "$processes = @(Get-CimInstance Win32_Process -Filter \"Name='language_server.exe' OR Name='language_server_windows_x64.exe'\" | Where-Object { $_.Name -eq 'language_server_windows_x64.exe' -or ($_.ExecutablePath -like '*\\antigravity\\resources\\bin\\language_server.exe' -and $_.CommandLine -match 'antigravity' -and $_.CommandLine -match 'hub') })",
        "if ($processes.Count -eq 0) { Write-Output '[]'; exit }",
        '$ids = @($processes | ForEach-Object { $_.ProcessId })',
        '$listeners = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { $ids -contains $_.OwningProcess })',
        '$results = @(foreach ($item in $processes) {',
        '  $ports = @($listeners | Where-Object { $_.OwningProcess -eq $item.ProcessId } | ForEach-Object {',
        '    @{ address = $_.LocalAddress; port = $_.LocalPort }',
        '  })',
        '  @{ pid = $item.ProcessId; executable = $item.ExecutablePath; startedAt = $item.CreationDate.ToUniversalTime().ToString("o"); commandLine = $item.CommandLine; listeners = $ports }',
        '})',
        'ConvertTo-Json -InputObject $results -Depth 5 -Compress',
    ].join('\n');
    const stdout = await new Promise<string>((resolve, reject) => {
        execute('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
            encoding: 'utf8', windowsHide: true, timeout: Math.max(1, Math.floor(Math.min(10000, remainingAntigravityMs(request)))),
            maxBuffer: 1024 * 1024, signal: request.signal,
        }, (error, output) => {
            if (!error) resolve(output);
            else if (request.signal?.aborted) reject(new AntigravityRpcError('Antigravity discovery cancelled', 'cancelled', false, false));
            else reject(new AntigravityRpcError(`Antigravity process discovery failed before generation (${error.killed ? 'timeout' : error.code ?? 'process-error'})`, 'not-started', false,
                remainingAntigravityMs(request) > 0));
        });
    });
    assertActive(request);
    let raw: unknown;
    try { raw = JSON.parse(stdout.replace(/^\uFEFF/, '').trim() || '[]'); }
    catch { throw new AntigravityRpcError('Invalid process discovery response', 'not-started', false, false); }
    const records = Array.isArray(raw) ? raw : [raw];
    return records.filter(item => item && typeof item === 'object').map(item => ({
        pid: item.pid, executable: item.executable, startedAt: Date.parse(item.startedAt),
        commandLine: item.commandLine, listeners: Array.isArray(item.listeners) ? item.listeners : [],
    }));
}

export async function discoverAntigravityEndpoints(
    request: AntigravityRequest,
    options: AntigravityDiscoveryOptions = {},
): Promise<AntigravityEndpoint[]> {
    assertActive(request);
    const processes = await (options.inspectProcesses ?? inspectAntigravityLsProcesses)(request);
    assertActive(request);
    const modernPorts = new Set(processes.filter(item => validProcess(item, true))
        .flatMap(item => item.listeners.filter(listener => listener.address === '127.0.0.1').map(listener => listener.port)));
    const hubs = await readHubFiles(options.daemonDirectory ?? path.join(os.homedir(), '.gemini', 'antigravity', 'daemon'), request, modernPorts);
    const endpoints: AntigravityEndpoint[] = [];
    for (const hub of hubs) {
        for (const processInfo of processes) {
            const endpoint = validateAntigravityHub(hub.data, hub.name, hub.modifiedAt, processInfo);
            if (endpoint && !endpoints.some(item => item.identity === endpoint.identity)) endpoints.push(endpoint);
        }
    }
    for (const processInfo of processes.sort((left, right) => right.startedAt - left.startedAt)) {
        assertActive(request);
        if (!validProcess(processInfo, false)) continue;
        const token = flag(processInfo.commandLine, 'csrf_token');
        if (!token || token.length > 4096 || /[\r\n]/.test(token)) continue;
        const extensionPort = Number(flag(processInfo.commandLine, 'extension_server_port'));
        const httpsPort = Number(flag(processInfo.commandLine, 'https_port'));
        const httpPort = Number(flag(processInfo.commandLine, 'http_port'));
        const ports = processInfo.listeners.map(listener => listener.port)
            .filter(port => port !== extensionPort && ownedPort(processInfo, port))
            .sort((left, right) => Number(right === httpPort) - Number(left === httpPort) || left - right);
        for (const port of ports) {
            const useHttps = port === httpsPort;
            const identity = endpointIdentity(processInfo, port, token, useHttps);
            if (endpoints.some(endpoint => endpoint.identity === identity)) continue;
            endpoints.push({ host: '127.0.0.1', port, pid: processInfo.pid, csrfToken: token, identity,
                transport: 'legacy-ls', ...(useHttps ? { useHttps: true } : {}) });
        }
    }
    assertActive(request);
    return endpoints;
}

export function getLsModelCandidates(model: string): string[] {
    return [...new Set([model, ...(process.env.WEB_FETCHER_LS_MODEL_FALLBACKS ?? LEGACY_MODELS.join(','))
        .split(',').map(item => item.trim()).filter(Boolean)])];
}

function flashLevel(label: string): number {
    const level = /^Gemini\s+3\.8\s+Flash\s*(?:\((High|Medium|Low)\)|(High|Medium|Low))$/i.exec(label);
    return level ? ['high', 'medium', 'low'].indexOf((level[1] ?? level[2]).toLowerCase()) : -1;
}

function modernCapacityCandidates(catalog: AntigravityCatalog, selected: { id: string; label: string }): string[] {
    const candidates = [selected.id];
    const selectedLevel = flashLevel(selected.label);
    if (selectedLevel < 0) return candidates;
    for (const level of [1, 2]) {
        if (level <= selectedLevel) continue;
        const model = catalog.models.find(item => !item.disabled
            && (item.quotaRemaining === undefined || item.quotaRemaining > 0) && flashLevel(item.label) === level);
        if (model && !candidates.includes(model.id)) candidates.push(model.id);
    }
    return candidates;
}

export function createAntigravityClient(overrides: Partial<AntigravityClientDependencies> = {}) {
    const dependencies: AntigravityClientDependencies = {
        discover: discoverAntigravityEndpoints, rpc: callAntigravityRpc, generate: callAntigravityModel,
        cliEndpoint: withCliEndpoint, cliAgent: callCliAgent, cliInstalled: isAntigravityCliInstalled,
        ...overrides,
    };
    let cachedEndpoint: { endpoint: AntigravityEndpoint; verifiedAt: number; accountKey?: string } | null = null;
    const clearCache = () => { cachedEndpoint = null; };
    const remember = (endpoint: AntigravityEndpoint, accountKey?: string) => {
        if (endpoint.transport !== 'cli-ls') cachedEndpoint = { endpoint, verifiedAt: Date.now(), accountKey };
    };
    const callEndpoint = async (request: AntigravityRequest, endpoint: AntigravityEndpoint): Promise<AntigravityResult> => {
        const interruption = stopped(request);
        if (interruption) return { ...interruption, transport: endpoint.transport };
        let catalog: AntigravityCatalog;
        let protocolEndpoint = endpoint;
        try {
            const response = await dependencies.rpc(endpoint, 'GetUserStatus', {}, request);
            if (isAntigravityRpcUnsupported(response)) {
                catalog = legacyAntigravityCatalog();
                protocolEndpoint = { ...endpoint, transport: endpoint.transport === 'cli-ls' ? 'cli-ls' : 'legacy-ls' };
            } else {
                const failure = antigravityRpcFailure(response, endpoint);
                if (failure) { clearCache(); return failure; }
                catalog = parseAntigravityCatalog(response.data);
                if (!catalog?.modern || !Array.isArray(catalog.models) || !catalog.models.length) {
                    clearCache();
                    return antigravityFailure('invalid-response', 'GetUserStatus returned an invalid modern model catalog', endpoint.transport);
                }
            }
        } catch (error) {
            clearCache();
            if (error instanceof AntigravityRpcError) return antigravityRpcException(error, endpoint);
            return antigravityFailure('invalid-response', 'GetUserStatus model catalog could not be decoded', endpoint.transport);
        }
        remember(protocolEndpoint, catalog.accountKey);
        const interruptionAfterCatalog = stopped(request);
        if (interruptionAfterCatalog) return { ...interruptionAfterCatalog, transport: protocolEndpoint.transport };
        const explicitModel = request.model ?? process.env.WEB_FETCHER_LS_MODEL;
        let selection;
        try { selection = selectAntigravityModel(catalog, explicitModel); }
        catch { return antigravityFailure('invalid-response', 'Antigravity model selection failed', protocolEndpoint.transport); }
        if (selection.error) return { ...selection.error, transport: protocolEndpoint.transport };
        if (!selection.model) return antigravityFailure('invalid-response', 'Antigravity catalog selected no model', protocolEndpoint.transport);
        const models = explicitModel ? [selection.model.id] : catalog.modern
            ? modernCapacityCandidates(catalog, selection.model)
            : getLsModelCandidates(selection.model.id).filter(model => catalog.models.some(item => item.id === model && !item.disabled));
        let result: AntigravityResult | undefined;
        for (const model of models) {
            const interruptionBeforeGeneration = stopped(request);
            if (interruptionBeforeGeneration) return { ...interruptionBeforeGeneration, transport: protocolEndpoint.transport, model };
            const candidateSelection = selectAntigravityModel(catalog, model);
            if (candidateSelection.error) return { ...candidateSelection.error, transport: protocolEndpoint.transport };
            try { result = await dependencies.generate(request, protocolEndpoint, model); }
            catch { return antigravityFailure('transport-unknown', 'Antigravity generation failed; submission state unknown', protocolEndpoint.transport, model, true); }
            const capacityRejected = result.outcome === 'rejected' && result.safeToFallback
                && /\bno capacity available\b/i.test(result.error ?? '');
            if (explicitModel || !result.safeToFallback || (catalog.modern ? !capacityRejected : result.outcome !== 'unsupported')) return result;
            if (model !== models.at(-1)) {
                console.error(`[ls-client] ${protocolEndpoint.transport} ${model} ${result.outcome}; submitted=${result.submitted}; ${result.error ?? ''}`);
            }
        }
        return result ?? antigravityFailure('unsupported', 'No compatible legacy Antigravity model', protocolEndpoint.transport);
    };
    const call = async (request: AntigravityRequest): Promise<AntigravityResult> => {
        const interruption = stopped(request);
        if (interruption) return interruption;
        if (typeof request.prompt !== 'string' || !request.prompt.trim()
            || (request.model !== undefined && (typeof request.model !== 'string' || !request.model.trim()))
            || (request.imagePaths !== undefined && (!Array.isArray(request.imagePaths)
                || request.imagePaths.some(image => typeof image !== 'string' || !image)))) {
            return antigravityFailure('rejected', 'Antigravity request contains invalid prompt, model, or attachments');
        }
        if (request.imagePaths?.length) {
            try { return await dependencies.cliAgent(request); }
            catch { return antigravityFailure('transport-unknown', 'Antigravity image agent failed; submission state unknown', 'cli-agent', null, true); }
        }
        let endpoints: AntigravityEndpoint[];
        try { endpoints = await dependencies.discover(request); }
        catch (error) {
            clearCache();
            const interruptionAfterDiscovery = stopped(request);
            if (interruptionAfterDiscovery) return interruptionAfterDiscovery;
            if (!(error instanceof AntigravityRpcError) || !error.safeToFallback) {
                return antigravityFailure(error instanceof AntigravityRpcError ? error.outcome : 'not-started',
                    'Antigravity App discovery failed before generation');
            }
            endpoints = [];
        }
        for (const endpoint of endpoints) {
            const result = await callEndpoint(request, endpoint);
            if (result.outcome !== 'not-started' || result.submitted || !result.safeToFallback) return result;
        }
        clearCache();
        const interruptionBeforeCli = stopped(request);
        if (interruptionBeforeCli) return interruptionBeforeCli;
        if (request.schema) {
            let result: AntigravityResult;
            const configuredModel = request.model ?? process.env.WEB_FETCHER_LS_MODEL;
            const agentRequest = configuredModel === undefined ? request : { ...request, model: configuredModel };
            try { result = await dependencies.cliAgent(agentRequest); }
            catch { return antigravityFailure('transport-unknown', 'Antigravity structured agent failed; submission state unknown', 'cli-agent', null, true); }
            if (result.cleanup && !result.cleanup.confirmed) return { ...result, safeToFallback: false };
            if (result.submitted || !result.safeToFallback || !['not-started', 'unsupported'].includes(result.outcome)) return result;
        }
        try { return await dependencies.cliEndpoint(request, (endpoint, scopedRequest) => callEndpoint(scopedRequest, endpoint)); }
        catch { return antigravityFailure('transport-unknown', 'Antigravity CLI failed; submission state unknown', 'cli-ls', null, true); }
    };
    const available = async (): Promise<boolean> => {
        const request: AntigravityRequest = { prompt: '', deadline: performance.now() + 5000 };
        try {
            for (const endpoint of await dependencies.discover(request)) {
                try {
                    const response = await dependencies.rpc(endpoint, 'Heartbeat', {}, request);
                    if (response.status === 200 && !antigravityRpcFailure(response, endpoint)) {
                        remember(endpoint);
                        return true;
                    }
                } catch { continue; }
            }
        } catch { clearCache(); return false; }
        clearCache();
        return false;
    };
    const status = (): { available: boolean; pid?: number; port?: number } => {
        if (!cachedEndpoint || Date.now() - cachedEndpoint.verifiedAt >= STATUS_TTL_MS) return { available: false };
        return { available: true, pid: cachedEndpoint.endpoint.pid, port: cachedEndpoint.endpoint.port };
    };
    return {
        callAntigravity: call,
        callEndpoint,
        isLsAvailable: available,
        getLsStatus: status,
        clearLsCache: clearCache,
        isAntigravityAvailable: async () => await available() || await dependencies.cliInstalled(),
    };
}

const client = createAntigravityClient();

export const clearLsCache = client.clearLsCache;
export const isLsAvailable = client.isLsAvailable;
export const getLsStatus = client.getLsStatus;
export const isAntigravityAvailable = client.isAntigravityAvailable;

export function callAntigravity(request: AntigravityRequest): Promise<AntigravityResult> {
    return client.callAntigravity(request);
}

export async function callGetModelResponse(
    prompt: string,
    model?: string,
    timeoutMs = 30000,
    imagePaths: string[] = [],
): Promise<string | null> {
    const result = await callAntigravity({ prompt, model, imagePaths, deadline: performance.now() + timeoutMs });
    return result.outcome === 'success' ? result.text : null;
}
