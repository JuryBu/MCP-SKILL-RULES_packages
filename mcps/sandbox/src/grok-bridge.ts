import { spawn, type ChildProcess } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

export type ProgrokAvailabilityStatus =
    | "ok"
    | "port_not_listening"
    | "upstream_unreachable"
    | "timeout"
    | "rate_limited"
    | "http_error"
    | "invalid_response";

export interface ProgrokAvailability {
    ok: boolean;
    status: ProgrokAvailabilityStatus;
    detail: string;
    httpStatus?: number;
}

export interface ProgrokImage {
    url: string;
}

export type ProgrokReasoningEffort = "low" | "medium" | "high";

export interface ProgrokCallOptions {
    baseUrl?: string;
    model?: string;
    maxTokens?: number;
    signal?: AbortSignal;
    images?: ProgrokImage[];
    reasoningEffort?: ProgrokReasoningEffort;
    fallbackModel?: string | false;
}

export interface ProgrokPatchResult {
    root: string;
    filePath: string;
    patched: boolean;
    hasPatch: boolean;
    backupPath?: string;
    message: string;
}

export interface ProgrokProxyProcess {
    started: boolean;
    pid?: number;
    process?: ChildProcess;
    message: string;
}

export class ProgrokError extends Error {
    code: ProgrokAvailabilityStatus;
    httpStatus?: number;

    constructor(code: ProgrokAvailabilityStatus, message: string, httpStatus?: number) {
        super(message);
        this.name = "ProgrokError";
        this.code = code;
        this.httpStatus = httpStatus;
    }
}

const DEFAULT_PROGROK_BASE_URL = process.env.SANDBOX_PROGROK_BASE_URL || "http://127.0.0.1:18645";
const DEFAULT_PROGROK_MODEL = process.env.SANDBOX_PROGROK_MODEL || "grok-4.5";
const DEFAULT_PROGROK_TIMEOUT_MS = Number(process.env.SANDBOX_PROGROK_TIMEOUT_MS || 30_000);
export const DEFAULT_PROGROK_REASONING_EFFORT = normalizeProgrokReasoningEffort(process.env.SANDBOX_PROGROK_REASONING_EFFORT, "low");
export const DEFAULT_PROGROK_FALLBACK_MODEL = (process.env.SANDBOX_PROGROK_FALLBACK_MODEL || "grok-4.20-non-reasoning").trim() || "grok-4.20-non-reasoning";
const DEFAULT_PROGROK_PROBE_TIMEOUT_MS = Number(process.env.SANDBOX_PROGROK_PROBE_TIMEOUT_MS || 8000);
const DEFAULT_PROGROK_PROBE_RETRIES = Math.max(0, Math.min(3, Number(process.env.SANDBOX_PROGROK_PROBE_RETRIES ?? 1)));
const DEFAULT_PROGROK_PROBE_BACKOFF_MS = Number(process.env.SANDBOX_PROGROK_PROBE_BACKOFF_MS || 250);
const DEFAULT_PROGROK_ROOT = process.env.SANDBOX_PROGROK_ROOT
    || path.join(os.homedir(), ".progrok");

export function normalizeProgrokReasoningEffort(value: unknown, fallback: ProgrokReasoningEffort = "low"): ProgrokReasoningEffort {
    if (value === "low" || value === "medium" || value === "high") return value;
    return fallback;
}

function joinSignal(timeoutMs: number, signal?: AbortSignal): { signal: AbortSignal; cleanup: () => void } {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`progrok request timeout after ${timeoutMs}ms`)), timeoutMs);
    timer.unref?.();
    const abort = () => controller.abort(signal?.reason || new Error("progrok request aborted"));
    signal?.addEventListener("abort", abort, { once: true });
    return {
        signal: controller.signal,
        cleanup: () => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", abort);
        },
    };
}

function classifyFetchError(error: unknown): ProgrokError {
    if (error instanceof ProgrokError) return error;
    const anyError = error as any;
    const message = error instanceof Error ? error.message : String(error);
    const code = anyError?.cause?.code || anyError?.code;
    if (/timeout|aborted|abort/iu.test(message)) {
        return new ProgrokError("timeout", message);
    }
    if (code === "ECONNREFUSED" || /ECONNREFUSED|fetch failed/iu.test(message)) {
        return new ProgrokError("port_not_listening", message);
    }
    return new ProgrokError("http_error", message);
}

function buildContent(prompt: string, images?: ProgrokImage[]): string | Array<Record<string, unknown>> {
    if (!images || images.length === 0) return prompt;
    return [
        { type: "text", text: prompt },
        ...images.map((image) => ({
            type: "image_url",
            image_url: { url: image.url },
        })),
    ];
}

async function callProgrokAPIOnce(
    prompt: string,
    timeoutMs: number,
    opts: ProgrokCallOptions,
    model: string,
    reasoningEffort?: ProgrokReasoningEffort,
): Promise<string> {
    const baseUrl = (opts.baseUrl || DEFAULT_PROGROK_BASE_URL).replace(/\/+$/u, "");
    const { signal, cleanup } = joinSignal(timeoutMs, opts.signal);
    const requestBody: Record<string, unknown> = {
        model,
        messages: [{
            role: "user",
            content: buildContent(prompt, opts.images),
        }],
        max_tokens: opts.maxTokens ?? 4096,
    };
    if (reasoningEffort) requestBody.reasoning_effort = reasoningEffort;

    try {
        const response = await fetch(`${baseUrl}/v1/chat/completions`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                authorization: "Bearer anything",
            },
            body: JSON.stringify(requestBody),
            signal,
        });

        let responseBody: any = null;
        try {
            responseBody = await response.json();
        } catch {
            responseBody = null;
        }

        if (!response.ok) {
            const detail = responseBody?.error?.message || responseBody?.message || response.statusText || `HTTP ${response.status}`;
            if (response.status === 429) throw new ProgrokError("rate_limited", detail, response.status);
            if (response.status === 502 || response.status === 503 || response.status === 504) {
                throw new ProgrokError("upstream_unreachable", detail, response.status);
            }
            throw new ProgrokError("http_error", detail, response.status);
        }

        const choice = responseBody?.choices?.[0];
        const finishReason = choice?.finish_reason;
        if (finishReason === "length" || finishReason === "max_tokens") {
            throw new ProgrokError("invalid_response", `progrok response truncated: finish_reason=${finishReason}`);
        }
        const content = choice?.message?.content;
        if (typeof content !== "string") {
            throw new ProgrokError("invalid_response", "progrok response missing choices[0].message.content");
        }
        return content;
    } catch (error) {
        throw classifyFetchError(error);
    } finally {
        cleanup();
    }
}

function isRetriableProgrokCallError(error: ProgrokError): boolean {
    if (error.code === "timeout" || error.code === "upstream_unreachable" || error.code === "rate_limited") return true;
    if (error.code === "http_error" && typeof error.httpStatus === "number" && error.httpStatus >= 500) return true;
    if (error.code === "invalid_response" && /truncated|finish_reason|length|max_tokens/iu.test(error.message)) return true;
    return false;
}

function resolveFallbackModel(primaryModel: string, fallbackModel: ProgrokCallOptions["fallbackModel"]): string | undefined {
    if (fallbackModel === false) return undefined;
    const resolved = typeof fallbackModel === "string" && fallbackModel.trim()
        ? fallbackModel.trim()
        : DEFAULT_PROGROK_FALLBACK_MODEL;
    return resolved && resolved !== primaryModel ? resolved : undefined;
}

export async function callProgrokAPI(
    prompt: string,
    timeoutMs = DEFAULT_PROGROK_TIMEOUT_MS,
    opts: ProgrokCallOptions = {},
): Promise<string> {
    const model = opts.model || DEFAULT_PROGROK_MODEL;
    try {
        return await callProgrokAPIOnce(prompt, timeoutMs, opts, model, opts.reasoningEffort);
    } catch (error) {
        const classified = classifyFetchError(error);
        if (opts.signal?.aborted || !isRetriableProgrokCallError(classified)) throw classified;
        const fallbackModel = resolveFallbackModel(model, opts.fallbackModel);
        if (!fallbackModel) throw classified;
        try {
            return await callProgrokAPIOnce(prompt, timeoutMs, opts, fallbackModel, undefined);
        } catch (fallbackError) {
            throw classifyFetchError(fallbackError);
        }
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        timer.unref?.();
    });
}

function isRetriableProbeError(status: ProgrokAvailabilityStatus): boolean {
    return status === "timeout" || status === "upstream_unreachable" || status === "port_not_listening";
}

export async function isProgrokAvailable(
    baseUrl = DEFAULT_PROGROK_BASE_URL,
    timeoutMs = DEFAULT_PROGROK_PROBE_TIMEOUT_MS,
    retries = DEFAULT_PROGROK_PROBE_RETRIES,
): Promise<ProgrokAvailability> {
    const attempts = Math.max(1, retries + 1);
    let last: ProgrokAvailability | undefined;
    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            const response = await callProgrokAPI("Say ok.", timeoutMs, { baseUrl, maxTokens: 8, fallbackModel: false });
            if (!/\bok\b/iu.test(response)) {
                last = {
                    ok: false,
                    status: "invalid_response",
                    detail: `progrok probe response did not include ok: ${response.slice(0, 120)}`,
                };
                break;
            }
            return { ok: true, status: "ok", detail: attempt > 1 ? `progrok API ok after ${attempt} attempts` : "progrok API ok" };
        } catch (error) {
            const classified = classifyFetchError(error);
            last = {
                ok: false,
                status: classified.code,
                detail: attempts > 1 ? `${classified.message} (attempt ${attempt}/${attempts})` : classified.message,
                httpStatus: classified.httpStatus,
            };
            if (attempt < attempts && isRetriableProbeError(classified.code)) await sleep(DEFAULT_PROGROK_PROBE_BACKOFF_MS);
            else break;
        }
    }
    return last || { ok: false, status: "invalid_response", detail: "progrok probe failed without error" };
}

function resolveProgrokIndex(root = DEFAULT_PROGROK_ROOT): string {
    return path.join(root, "dist", "index.js");
}

export function ensureProgrokPatch(opts: { root?: string; patchProgrok?: boolean } = {}): ProgrokPatchResult {
    const root = opts.root || DEFAULT_PROGROK_ROOT;
    const filePath = resolveProgrokIndex(root);
    if (!fs.existsSync(filePath)) {
        return {
            root,
            filePath,
            patched: false,
            hasPatch: false,
            message: "progrok dist/index.js not found",
        };
    }
    const source = fs.readFileSync(filePath, "utf-8");
    const hasPatch = source.includes("ProxyAgent") && source.includes("HTTP_PROXY");
    const allowed = opts.patchProgrok || /^(1|true|yes)$/iu.test(process.env.SANDBOX_PROGROK_PATCH || "");
    if (hasPatch || !allowed) {
        return {
            root,
            filePath,
            patched: false,
            hasPatch,
            message: hasPatch ? "progrok proxy patch detected" : "progrok proxy patch missing; set SANDBOX_PROGROK_PATCH=1 to patch",
        };
    }

    const backupPath = `${filePath}.before-sandbox-${new Date().toISOString().replace(/[:.]/gu, "")}`;
    fs.copyFileSync(filePath, backupPath);
    const patch = [
        "import { ProxyAgent, setGlobalDispatcher } from 'undici';",
        "const sandboxProxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;",
        "if (sandboxProxy) setGlobalDispatcher(new ProxyAgent(sandboxProxy));",
        "",
    ].join("\n");
    fs.writeFileSync(filePath, `${patch}${source}`, "utf-8");
    return {
        root,
        filePath,
        patched: true,
        hasPatch: true,
        backupPath,
        message: "progrok proxy patch applied",
    };
}

export function maybeStartProgrokProxy(opts: { root?: string; proxyEnvBat?: string } = {}): ProgrokProxyProcess {
    if (!/^(1|true|yes)$/iu.test(process.env.SANDBOX_PROGROK_AUTOSTART || "")) {
        return { started: false, message: "SANDBOX_PROGROK_AUTOSTART is not enabled" };
    }
    const root = opts.root || DEFAULT_PROGROK_ROOT;
    const proxyEnvBat = opts.proxyEnvBat || path.join(root, "proxy-env.bat");
    if (!fs.existsSync(root)) {
        return { started: false, message: `progrok root not found: ${root}` };
    }
    const command = process.platform === "win32" && fs.existsSync(proxyEnvBat)
        ? `call "${proxyEnvBat}" && node dist\\index.js proxy`
        : "node dist/index.js proxy";
    const child = spawn(command, {
        cwd: root,
        shell: true,
        detached: true,
        stdio: "ignore",
        windowsHide: true,
    });
    child.unref();
    return {
        started: true,
        pid: child.pid,
        process: child,
        message: `progrok proxy started from ${root}`,
    };
}
