import http from "node:http";
import fs from "node:fs";
import { discoverAntigravityLsCandidates, verifyAntigravityLsProcess, type AntigravityLsProcess } from "./antigravity-discovery.js";
import { openOwnedAntigravityLs, resolveAntigravityLsCliCommand, type OwnedAntigravityLs } from "./antigravity-cli-ls.js";
import { AntigravityCallError, antigravityOutcomeFromError, parseAntigravityCatalog, readAntigravityCatalogFixture,
    selectAntigravityModel, defaultAntigravityFlashCandidates, isDefaultAntigravityModel, type AntigravityCatalog, type AntigravityOutcome } from "./antigravity-model-catalog.js";

export interface LsProcessInfo extends AntigravityLsProcess {}
export interface ParentLsConnection { info: LsProcessInfo; port: number; }
export interface LsModelResult extends Partial<AntigravityOutcome> { text: string | null; error?: string; timedOut?: boolean; partialText?: string; cleanupConfirmed?: boolean; }

interface RpcResult { status: number; data: any; rawBody: string; }
interface LsRuntime {
    discover(signal?: AbortSignal): Promise<LsProcessInfo[]>;
    verify(info: LsProcessInfo, port: number, signal?: AbortSignal): Promise<boolean>;
    openCli(signal: AbortSignal, deadline: number): Promise<OwnedAntigravityLs>;
}

const defaultRuntime: LsRuntime = { discover: discoverAntigravityLsCandidates, verify: verifyAntigravityLsProcess, openCli: openOwnedAntigravityLs };
let runtime = defaultRuntime;
let parentLs: ParentLsConnection | null = null;
let parentLsInitPromise: Promise<void> | null = null;
let parentLsInjectedForTest = false;
const catalogCache = new Map<string, { expiresAt: number; value: Promise<AntigravityCatalog | null> }>();

export function getParentLs(): ParentLsConnection | null { return parentLs; }
export function isLsReady(): boolean { return parentLs !== null; }
export function isAntigravityAvailable(): boolean {
    return isLsReady() || Boolean(process.env.SANDBOX_AGY_CLI_COMMAND?.trim()) || fs.existsSync(resolveAntigravityLsCliCommand());
}

export function __setParentLsForTest(connection: ParentLsConnection | null): void {
    parentLs = connection;
    parentLsInitPromise = null;
    parentLsInjectedForTest = connection !== null;
    catalogCache.clear();
}

export function __setAntigravityRuntimeForTest(value?: Partial<LsRuntime>): void {
    runtime = value ? { ...defaultRuntime, ...value } : defaultRuntime;
    parentLs = null;
    parentLsInitPromise = null;
    parentLsInjectedForTest = false;
    catalogCache.clear();
}

function transportOf(info: LsProcessInfo) { return info.transport || "legacy-ls" as const; }
function endpointKey(connection: ParentLsConnection): string {
    return `${transportOf(connection.info)}:${connection.info.pid}:${connection.info.startedAt || ""}:${connection.port}:${connection.info.csrfToken}`;
}

async function rpcCall(connection: ParentLsConnection, method: string, payload: Record<string, unknown>, timeoutMs: number,
    signal?: AbortSignal, onSubmitted?: () => void): Promise<RpcResult> {
    signal?.throwIfAborted();
    const body = JSON.stringify(payload);
    return await new Promise<RpcResult>((resolve, reject) => {
        const headers: Record<string, string | number> = { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), "Connect-Protocol-Version": "1" };
        if (connection.info.csrfToken) headers["x-codeium-csrf-token"] = connection.info.csrfToken;
        const request = http.request({ hostname: "127.0.0.1", port: connection.port,
            path: `/exa.language_server_pb.LanguageServerService/${method}`, method: "POST", headers, signal }, response => {
            const chunks: Buffer[] = [];
            let size = 0;
            response.on("data", chunk => {
                const buffer = Buffer.from(chunk);
                size += buffer.length;
                if (size > 4 * 1024 * 1024) { request.destroy(new Error("Antigravity LS 响应超过大小限制")); return; }
                chunks.push(buffer);
            });
            response.on("error", reject);
            response.on("aborted", () => reject(new Error("Antigravity LS response aborted")));
            response.on("end", () => {
                const rawBody = Buffer.concat(chunks).toString("utf8");
                let data: any;
                try { data = JSON.parse(rawBody); } catch { data = undefined; }
                resolve({ status: response.statusCode || 0, data, rawBody });
            });
        });
        request.on("socket", socket => {
            if (!socket.connecting) onSubmitted?.();
            else socket.once("connect", () => onSubmitted?.());
        });
        const timer = setTimeout(() => request.destroy(new Error("Antigravity LS request timeout")), Math.max(1, timeoutMs));
        request.once("close", () => clearTimeout(timer));
        request.once("error", reject);
        request.end(body);
    });
}

async function findConnection(info: LsProcessInfo, signal?: AbortSignal, deadline = Date.now() + 10_000): Promise<ParentLsConnection | null> {
    for (const port of info.ports) {
        signal?.throwIfAborted();
        if (Date.now() >= deadline) return null;
        try {
            const connection = { info, port };
            const result = await rpcCall(connection, "Heartbeat", {}, Math.min(3000, deadline - Date.now()), signal);
            if (result.status === 200) return connection;
        } catch { signal?.throwIfAborted(); }
    }
    return null;
}

export async function initParentLs(signal?: AbortSignal, deadline = Date.now() + 10_000): Promise<void> {
    if (parentLs || parentLsInitPromise) return parentLsInitPromise || undefined;
    parentLsInitPromise = (async () => {
        try {
            for (const info of await runtime.discover(signal)) {
                const connection = await findConnection(info, signal, deadline);
                if (connection) { parentLs = connection; return; }
            }
        } catch {}
    })();
    try { await parentLsInitPromise; } finally { parentLsInitPromise = null; }
}

const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_LS_MODEL = "MODEL_PLACEHOLDER_M132";
const DEFAULT_LS_MODEL_FALLBACKS = ["MODEL_PLACEHOLDER_M132", "MODEL_PLACEHOLDER_M20", "MODEL_PLACEHOLDER_M18", "MODEL_PLACEHOLDER_M16", "MODEL_PLACEHOLDER_M36"];
const DEPRECATED_LS_RAW_MODELS: Record<string, string> = {
    MODEL_PLACEHOLDER_M37: "MODEL_PLACEHOLDER_M16", MODEL_PLACEHOLDER_M47: "MODEL_PLACEHOLDER_M18",
    MODEL_GOOGLE_GEMINI_2_5_FLASH: "MODEL_PLACEHOLDER_M132", MODEL_GOOGLE_GEMINI_2_5_FLASH_LITE: "MODEL_PLACEHOLDER_M20",
};
const LS_MODEL_ALIASES: Record<string, string> = {
    m132: DEFAULT_LS_MODEL, fast: DEFAULT_LS_MODEL, default: DEFAULT_LS_MODEL, "ag-fast": DEFAULT_LS_MODEL,
    flash: DEFAULT_LS_MODEL, "gemini-flash": DEFAULT_LS_MODEL, "gemini-3.5-flash-high": DEFAULT_LS_MODEL,
    "gemini-35-flash-high": DEFAULT_LS_MODEL, "gemini-3-flash-agent": DEFAULT_LS_MODEL,
    m20: "MODEL_PLACEHOLDER_M20", "flash-medium": "MODEL_PLACEHOLDER_M20", "gemini-3.5-flash-medium": "MODEL_PLACEHOLDER_M20",
    "gemini-35-flash-medium": "MODEL_PLACEHOLDER_M20", "gemini-3.5-flash-low": "MODEL_PLACEHOLDER_M20", "gemini-35-flash-low": "MODEL_PLACEHOLDER_M20",
    m18: "MODEL_PLACEHOLDER_M18", "gemini-3-flash": "MODEL_PLACEHOLDER_M18",
    m16: "MODEL_PLACEHOLDER_M16", m37: "MODEL_PLACEHOLDER_M16", pro: "MODEL_PLACEHOLDER_M16", "pro-high": "MODEL_PLACEHOLDER_M16",
    "gemini-pro": "MODEL_PLACEHOLDER_M16", "gemini-3.1-pro": "MODEL_PLACEHOLDER_M16", "gemini-31-pro": "MODEL_PLACEHOLDER_M16",
    "gemini-3.1-pro-high": "MODEL_PLACEHOLDER_M16", "gemini-31-pro-high": "MODEL_PLACEHOLDER_M16",
    m36: "MODEL_PLACEHOLDER_M36", "pro-low": "MODEL_PLACEHOLDER_M36", "gemini-3.1-pro-low": "MODEL_PLACEHOLDER_M36", "gemini-31-pro-low": "MODEL_PLACEHOLDER_M36",
    m35: "MODEL_PLACEHOLDER_M35", "claude-sonnet": "MODEL_PLACEHOLDER_M35", "claude-4.6-sonnet": "MODEL_PLACEHOLDER_M35", "claude-46-sonnet": "MODEL_PLACEHOLDER_M35", sonnet: "MODEL_PLACEHOLDER_M35",
    m26: "MODEL_PLACEHOLDER_M26", "claude-opus": "MODEL_PLACEHOLDER_M26", "claude-4.6-opus": "MODEL_PLACEHOLDER_M26", "claude-46-opus": "MODEL_PLACEHOLDER_M26", opus: "MODEL_PLACEHOLDER_M26",
    "gemini-2.5-flash": DEFAULT_LS_MODEL, "gemini-25-flash": DEFAULT_LS_MODEL, "2.5-flash": DEFAULT_LS_MODEL,
    "gemini-2.5-flash-lite": "MODEL_PLACEHOLDER_M20", "gemini-25-flash-lite": "MODEL_PLACEHOLDER_M20", "2.5-flash-lite": "MODEL_PLACEHOLDER_M20",
    "flash-lite": "MODEL_PLACEHOLDER_M20", lite: "MODEL_PLACEHOLDER_M20", m47: "MODEL_PLACEHOLDER_M18",
};

export function resolveLsModelName(model: string): string {
    const raw = (model || "").trim();
    if (!raw) return DEFAULT_LS_MODEL;
    if (/^MODEL_/u.test(raw)) return DEPRECATED_LS_RAW_MODELS[raw] || raw;
    const key = raw.toLowerCase().replace(/_/gu, "-");
    return LS_MODEL_ALIASES[key] || (/^m\d+$/u.test(key) ? `MODEL_PLACEHOLDER_${key.toUpperCase()}` : raw);
}

function legacyModelCandidates(requested: string): string[] {
    const model = resolveLsModelName(requested);
    if (!isDefaultAntigravityModel(requested)) return [model];
    const fallbacks = (process.env.SANDBOX_LS_MODEL_FALLBACKS?.split(",").map(item => item.trim()).filter(Boolean) || DEFAULT_LS_MODEL_FALLBACKS).map(resolveLsModelName);
    const offset = fallbacks.indexOf(model);
    return [...new Set([model, ...(offset >= 0 ? fallbacks.slice(offset + 1) : [])])];
}

function rejection(result: RpcResult, connection: ParentLsConnection, model?: string): AntigravityCallError {
    const message = String(result.data?.message || result.data?.error?.message || result.rawBody || "empty response").slice(0, 1000);
    const auth = result.status === 401 || result.status === 403 || /unauthenticated|authentication required/iu.test(message);
    const quota = result.status === 429 || /quota|resource_exhausted|capacity exhausted|insufficient.*(?:credit|balance)/iu.test(message);
    const capacity = result.status === 503 && typeof result.data?.message === "string" && /no capacity available for /iu.test(result.data.message);
    const unsupported = !auth && !quota && /unknown model|model.*(?:not found|unsupported|does not exist)|unknown.*model.*key|unimplemented|unknown method|method.*not found/iu.test(message);
    return new AntigravityCallError(`Antigravity LS HTTP ${result.status}: ${message}`, {
        transport: transportOf(connection.info), model, submitted: true, outcomeUnknown: !auth && !quota && !unsupported && !capacity,
        safeToFallback: unsupported || capacity, kind: auth ? "auth-required" : quota ? "quota-exhausted" : unsupported || capacity ? "rejected" : "transport-unknown",
    });
}

async function catalogFor(connection: ParentLsConnection, signal?: AbortSignal, deadline = Date.now() + 5000): Promise<AntigravityCatalog | null> {
    const fixture = transportOf(connection.info) !== "legacy-ls" ? readAntigravityCatalogFixture() : null;
    if (fixture) return fixture;
    if (parentLsInjectedForTest && transportOf(connection.info) === "legacy-ls") return null;
    const key = endpointKey(connection);
    const cached = catalogCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return await cached.value;
    const value = (async () => {
        const result = await rpcCall(connection, "GetUserStatus", {}, Math.max(1, deadline - Date.now()), signal);
        if ([404, 501].includes(result.status)) {
            if (transportOf(connection.info) === "legacy-ls") return null;
            throw new AntigravityCallError("Antigravity 现代 LS 没有可用的 GetUserStatus 目录",
                { transport: transportOf(connection.info), submitted: false, outcomeUnknown: false, safeToFallback: false, kind: "rejected" });
        }
        if (result.status !== 200) {
            const error = rejection(result, connection);
            throw new AntigravityCallError(error.message, { ...error, submitted: false, outcomeUnknown: false,
                safeToFallback: error.safeToFallback, kind: error.kind === "transport-unknown" ? "not-started" : error.kind });
        }
        const catalog = parseAntigravityCatalog(result.data);
        if (!catalog && transportOf(connection.info) !== "legacy-ls") throw new AntigravityCallError("Antigravity GetUserStatus 没有有效模型目录",
            { transport: transportOf(connection.info), submitted: false, outcomeUnknown: false, safeToFallback: false, kind: "rejected" });
        return catalog;
    })();
    catalogCache.set(key, { expiresAt: Date.now() + 5 * 60_000, value });
    try { return await value; } catch (error) { catalogCache.delete(key); throw error; }
}

export async function getAntigravityModelCatalog(signal?: AbortSignal, deadline = Date.now() + 10_000): Promise<AntigravityCatalog | null> {
    const fixture = readAntigravityCatalogFixture();
    if (fixture) return fixture;
    await initParentLs(signal, deadline);
    if (!parentLs) return null;
    return await catalogFor(parentLs, signal, deadline);
}

export async function resolveAntigravityCliModel(model: string, signal?: AbortSignal, deadline?: number): Promise<string> {
    const catalog = await getAntigravityModelCatalog(signal, deadline);
    if (catalog) return selectAntigravityModel(catalog, model || "default").label;
    return /^(?:default|auto)$/iu.test(model) ? "" : model;
}

async function callOn(connection: ParentLsConnection, requested: string, prompt: string, signal: AbortSignal, deadline: number): Promise<LsModelResult> {
    const catalog = await catalogFor(connection, signal, deadline);
    const candidates = catalog ? defaultAntigravityFlashCandidates(catalog, requested).map(entry => entry.model) : legacyModelCandidates(requested);
    let lastError: AntigravityCallError | undefined;
    for (const model of candidates) {
        signal.throwIfAborted();
        let submitted = false;
        try {
            const result = await rpcCall(connection, "GetModelResponse", { model, prompt }, Math.max(1, deadline - Date.now()), signal, () => { submitted = true; });
            if (result.status < 200 || result.status >= 300) throw rejection(result, connection, model);
            if (typeof result.data?.response !== "string" || !result.data.response.trim()) throw new AntigravityCallError("Antigravity LS 返回空白或无法确认完整的响应",
                { transport: transportOf(connection.info), model, submitted: true, outcomeUnknown: true, safeToFallback: false, kind: "transport-unknown" });
            return { text: result.data.response, transport: transportOf(connection.info), model, submitted: true, outcomeUnknown: false, safeToFallback: false, kind: "success" };
        } catch (error) {
            const timeout = signal.aborted && signal.reason?.name === "TimeoutError" || /timeout/iu.test(error instanceof Error ? error.message : "");
            lastError = antigravityOutcomeFromError(error, { transport: transportOf(connection.info), model, submitted,
                outcomeUnknown: submitted, safeToFallback: !submitted && !signal.aborted,
                kind: signal.aborted && !timeout ? "cancelled" : submitted ? timeout ? "timeout-unknown" : "transport-unknown" : signal.aborted ? "cancelled" : "not-started" });
            if (signal.aborted || !lastError.safeToFallback) throw lastError;
        }
    }
    if (lastError?.submitted && lastError.kind === "rejected") throw new AntigravityCallError(lastError.message, { ...lastError, safeToFallback: false }, { cause: lastError });
    throw lastError || new Error("Antigravity LS model unavailable");
}

export async function callGetModelResponseDetailed(model: string, prompt: string, timeoutMs = DEFAULT_TIMEOUT, signal?: AbortSignal): Promise<LsModelResult> {
    const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT;
    const deadline = Date.now() + timeout;
    const cleanupBudget = Math.min(2500, Math.floor(timeout / 5));
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    const timer = setTimeout(() => controller.abort(new DOMException("Antigravity 总期限已用完", "TimeoutError")), Math.max(1, timeout - cleanupBudget));
    let owned: OwnedAntigravityLs | undefined;
    let result: LsModelResult;
    try {
        controller.signal.throwIfAborted();
        const connections: ParentLsConnection[] = [];
        if (parentLs && (parentLsInjectedForTest || await runtime.verify(parentLs.info, parentLs.port, controller.signal))) connections.push(parentLs);
        else parentLs = null;
        if (!connections.length) {
            for (const info of await runtime.discover(controller.signal)) {
                const connection = await findConnection(info, controller.signal, deadline - cleanupBudget);
                if (connection) connections.push(connection);
            }
        }
        if (!connections.length) {
            owned = await runtime.openCli(controller.signal, deadline);
            connections.push(owned);
        }
        let lastError: unknown;
        for (const connection of connections) {
            try {
                result = await callOn(connection, model, prompt, controller.signal, deadline - cleanupBudget);
                if (!owned) parentLs = connection;
                lastError = undefined;
                break;
            } catch (error) {
                lastError = error instanceof AntigravityCallError ? new AntigravityCallError(error.message,
                    { ...error, transport: error.transport || transportOf(connection.info) }, { cause: error }) : error;
                if (controller.signal.aborted || !(lastError instanceof AntigravityCallError) || !lastError.safeToFallback) throw lastError;
            }
        }
        if (lastError) throw lastError;
        result ??= { text: null, error: "Antigravity 没有可用的模型入口", submitted: false, outcomeUnknown: false, safeToFallback: true, kind: "not-started" };
    } catch (error) {
        const failure = antigravityOutcomeFromError(error, { kind: controller.signal.aborted ? "cancelled" : "not-started", safeToFallback: !controller.signal.aborted });
        result = { text: null, error: failure.message, timedOut: failure.timedOut, transport: failure.transport, model: failure.model,
            submitted: failure.submitted, outcomeUnknown: failure.outcomeUnknown, safeToFallback: failure.safeToFallback, kind: failure.kind };
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
    }
    if (owned) {
        try { await owned.close(); result.cleanupConfirmed = true; } catch (error) {
            const failure = antigravityOutcomeFromError(error);
            result = { ...result, partialText: result.text || undefined, text: null, cleanupConfirmed: false,
                error: [result.error, failure.message].filter(Boolean).join(" | "), safeToFallback: false, kind: "transport-unknown" };
        }
        catalogCache.delete(endpointKey(owned));
    }
    return result;
}

export async function callGetModelResponse(model: string, prompt: string, timeoutMs?: number, signal?: AbortSignal): Promise<string | null> {
    return (await callGetModelResponseDetailed(model, prompt, timeoutMs, signal)).text;
}
