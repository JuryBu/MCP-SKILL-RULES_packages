import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { discoverAppLsProcesses } from "./ls-app-discovery.js";
import { parseLsModelCatalog, selectLsModelCandidates, type LsCatalogModel } from "./ls-model-catalog.js";
import { rpcCall, type LsProcessInfo } from "./ls-rpc.js";
import type { FailureClass } from "./record-scheduler-contracts.js";
import { spawnWindowsJobProcess, type WindowsJobProcess } from "./windows-job-process.js";

export interface LsModelConnection {
    info: LsProcessInfo;
    port: number;
    release?: () => Promise<void>;
}

export interface LsRuntimeResult {
    text: string | null;
    error?: string;
    timedOut?: boolean;
    cancelled?: boolean;
    failureClass?: FailureClass;
    safetyStopped?: boolean;
    modelUsed?: string;
    generationAttempted?: boolean;
}

export interface LsRuntimeOptions {
    signal?: AbortSignal;
    connection?: LsModelConnection;
    discoverLegacy?: () => Promise<LsModelConnection | null>;
    validator?: (text: string, model: string) => string | null;
    onFailure?: (model: string, error: string, failureClass: FailureClass) => void;
    onCatalog?: (catalog: LsCatalogModel[] | null, transport: string, endpoint: { pid: number; port: number }) => void;
    maxGenerationAttempts?: number;
    onGeneration?: (model: string) => void;
}

export function resolveLsCliCommand(): string | null {
    if (process.platform !== "win32") return null;
    const configured = process.env.MEMORY_STORE_AGY_COMMAND;
    if (configured && path.isAbsolute(configured)) return fs.existsSync(configured) ? configured : null;
    const standard = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "agy", "bin", "agy.exe");
    if (!configured && fs.existsSync(standard)) return standard;
    try {
        const output = execFileSync("where.exe", [configured || "agy.exe"], { encoding: "utf8", timeout: 2000, windowsHide: true });
        return output.split(/\r?\n/u).map(value => value.trim()).find(value => /\.exe$/iu.test(value) && fs.existsSync(value)) || null;
    } catch { return null; }
}

function check(signal: AbortSignal): void {
    if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("LS operation cancelled");
}

async function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
    check(signal);
    await new Promise<void>((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(signal.reason); };
        const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, milliseconds);
        signal.addEventListener("abort", abort, { once: true });
    });
}

export function isOwnedCliLsLog(content: string, pid: number): number | null {
    const loggedPid = content.match(/Starting language server process with pid (\d+)/u)?.[1];
    const port = Number(content.match(/Language server listening on random port at (\d+) for HTTP\b/u)?.[1]);
    return Number(loggedPid) === pid && Number.isSafeInteger(port) && port > 0 && port <= 65535 ? port : null;
}

function ownsLoopbackPort(pid: number, port: number): boolean {
    const script = `$items=@(Get-NetTCPConnection -OwningProcess ${pid} -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalAddress -in @('127.0.0.1','::1') }); if($items.Count -gt 0){'owned'}`;
    try {
        return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", timeout: 7000, windowsHide: true }).trim() === "owned";
    } catch { return false; }
}

export async function startOwnedCliLs(signal: AbortSignal, deadlineAt: number): Promise<LsModelConnection> {
    const command = resolveLsCliCommand();
    if (!command) throw new Error("Antigravity CLI LS executable unavailable");
    check(signal);
    const directory = await mkdtemp(path.join(os.tmpdir(), "memory-store-ls-"));
    const workspace = path.join(directory, "workspace");
    const logPath = path.join(directory, "ls.log");
    let child: WindowsJobProcess | undefined;
    let reader: ReturnType<typeof createInterface> | undefined;
    let exited = false;
    let nextId = 0;
    let released = false;
    const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
    const rejectPending = (error: Error) => { for (const request of pending.values()) request.reject(error); pending.clear(); };
    const release = async () => {
        if (released) return;
        released = true;
        reader?.close();
        rejectPending(new Error("Owned CLI LS closed"));
        if (child) {
            child.stdin.end();
            let timer: NodeJS.Timeout | undefined;
            try {
                const ended = await Promise.race([child.completion.then(() => true), new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), 3000); })]);
                if (!ended) await child.terminate();
            } catch (error) {
                await child.terminate().catch(() => {});
                throw error;
            } finally { if (timer) clearTimeout(timer); }
        }
        await rm(directory, { recursive: true, force: true });
    };
    try {
        await mkdir(workspace);
        child = await spawnWindowsJobProcess(command, ["acp", "--stdio", "--cli_log_file", logPath, "--include-default-customizations=false"], { cwd: workspace, signal, deadlineAt });
        child.stderr.resume();
        child.stdin.on("error", error => rejectPending(error));
        void child.completion.then(() => { exited = true; rejectPending(new Error("Owned CLI LS exited during initialization")); }, error => { exited = true; rejectPending(error); });
        reader = createInterface({ input: child.stdout });
        reader.on("line", line => {
            try {
                const message = JSON.parse(line);
                const request = pending.get(message.id);
                if (request && !message.method) {
                    pending.delete(message.id);
                    if (message.error) request.reject(new Error(`ACP ${message.error.code}: ${message.error.message}`));
                    else request.resolve(message.result);
                } else if (message.method && message.id !== undefined) {
                    child!.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "No client tools in LS-only mode" } }) + "\n");
                }
            } catch { }
        });
        const request = (method: string, params: Record<string, unknown>) => {
            check(signal);
            const id = ++nextId;
            return new Promise<any>((resolve, reject) => {
                const abort = () => { pending.delete(id); reject(signal.reason); };
                signal.addEventListener("abort", abort, { once: true });
                pending.set(id, { resolve: value => { signal.removeEventListener("abort", abort); resolve(value); }, reject: error => { signal.removeEventListener("abort", abort); reject(error); } });
                child!.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
            });
        };
        await request("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "memory-store-ls", version: "1" } });
        check(signal);
        await request("session/new", { cwd: workspace, mcpServers: [] });
        while (!exited) {
            check(signal);
            let content = "";
            try { content = await readFile(logPath, "utf8"); } catch { }
            const port = isOwnedCliLsLog(content, child.childPid);
            if (port && ownsLoopbackPort(child.childPid, port)) {
                check(signal);
                return { info: { pid: child.childPid, csrfToken: "", workspaceId: "", ports: [port], transport: "cli" }, port, release };
            }
            await wait(100, signal);
        }
        throw new Error("Owned CLI LS did not expose its HTTP port");
    } catch (error) {
        await release();
        throw error;
    }
}

export async function runLsModelRequest(model: string, prompt: string, timeoutMs: number, options: LsRuntimeOptions = {}): Promise<LsRuntimeResult> {
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort(new Error("LS operation cancelled"));
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    const deadlineAt = Date.now() + Math.max(1, timeoutMs);
    const timer = setTimeout(() => { timedOut = true; controller.abort(new Error("LS operation deadline reached")); }, Math.max(1, timeoutMs));
    const remaining = () => {
        if (Date.now() >= deadlineAt) {
            timedOut = true;
            controller.abort(new Error("LS operation deadline reached"));
        }
        check(controller.signal);
        return Math.max(1, deadlineAt - Date.now());
    };
    let connection: LsModelConnection | undefined;
    let attempted = false;
    let actualModel = model;
    let result: LsRuntimeResult;
    const execute = async (): Promise<LsRuntimeResult> => {
        check(controller.signal);
        connection = options.connection;
        if (!connection) {
            const info = discoverAppLsProcesses()[0];
            if (info) connection = { info, port: info.ports[0] };
        }
        check(controller.signal);
        connection ||= await options.discoverLegacy?.() || undefined;
        check(controller.signal);
        connection ||= await startOwnedCliLs(controller.signal, deadlineAt);
        check(controller.signal);
        const status = await rpcCall(connection.info, connection.port, "GetUserStatus", {}, remaining(), controller.signal);
        if ([401, 403, 429].includes(status.status)) {
            return { text: null, error: `Antigravity LS model catalog unavailable (HTTP ${status.status})`, failureClass: status.status === 429 ? "Congestion" : "DeterministicInput", safetyStopped: true };
        }
        const catalog = status.status === 200 ? parseLsModelCatalog(status.data) : null;
        if (catalog === null && (connection.info.transport === "app" || connection.info.transport === "cli" || ![200, 404, 501].includes(status.status))) {
            return { text: null, error: `Antigravity LS model catalog unavailable (HTTP ${status.status})`, failureClass: "Availability", safetyStopped: status.status === 401 || status.status === 403 };
        }
        options.onCatalog?.(catalog, connection.info.transport || "legacy", { pid: connection.info.pid, port: connection.port });
        const candidates = selectLsModelCandidates(model, catalog, process.env.MEMORY_STORE_LS_MODEL_FALLBACKS)
            .slice(0, options.maxGenerationAttempts === undefined ? undefined : Math.max(0, Math.floor(options.maxGenerationAttempts)));
        if (!candidates.length) return { text: null, error: `Antigravity model unavailable, disabled or quota exhausted: ${model}`, failureClass: "DeterministicInput", safetyStopped: true, modelUsed: model };
        result = { text: null, error: "Antigravity LS returned no valid response", failureClass: "Quality", modelUsed: model };
        for (const candidate of candidates) {
            check(controller.signal);
            actualModel = candidate;
            options.onGeneration?.(candidate);
            attempted = true;
            const response = await rpcCall(connection.info, connection.port, "GetModelResponse", { prompt, model: candidate }, remaining(), controller.signal);
            check(controller.signal);
            if (response.status !== 200) {
                const detail = typeof response.data?.message === "string" ? response.data.message : "";
                const safeFallback = [400, 404, 422].includes(response.status) || /unknown model key|invalid.{0,30}model|unsupported.{0,30}model/iu.test(detail);
                const capacityRejected = response.status === 503 && /no capacity available|no available capacity/iu.test(detail);
                const failureClass: FailureClass = safeFallback || [401, 403].includes(response.status) ? "DeterministicInput" : response.status === 429 || capacityRejected ? "Congestion" : "UnknownOutcome";
                result = { text: null, error: `Antigravity LS HTTP ${response.status}${detail ? `: ${detail}` : ""}`, failureClass, modelUsed: candidate, generationAttempted: true };
                if ([401, 403, 429].includes(response.status)) {
                    result.failureClass = response.status === 429 ? "Congestion" : "DeterministicInput";
                    options.onFailure?.(candidate, result.error!, result.failureClass);
                    return { ...result, safetyStopped: true };
                }
                options.onFailure?.(candidate, result.error!, failureClass);
                if (!safeFallback && !capacityRejected) return { ...result, safetyStopped: [401, 403, 429].includes(response.status) };
                attempted = false;
                continue;
            }
            const text = typeof response.data?.response === "string" ? response.data.response : "";
            const rejection = options.validator?.(text, candidate) || (!text ? "Antigravity LS empty response" : null);
            attempted = false;
            if (!rejection) return { text, modelUsed: candidate, generationAttempted: true };
            result = { text: null, error: rejection, failureClass: "Quality", modelUsed: candidate, generationAttempted: true };
            options.onFailure?.(candidate, rejection, "Quality");
        }
        return result;
    };
    try {
        result = await execute();
    } catch (error: any) {
        const unknown = attempted && error?.mayHaveStarted !== false;
        result = { text: null, error: `Antigravity LS ${timedOut ? "模型调用超时" : "调用失败"}: ${error?.message || String(error)}`, timedOut: timedOut || error?.timedOut === true,
            ...(options.signal?.aborted ? { cancelled: true } : {}), failureClass: unknown ? "UnknownOutcome" : "Availability", modelUsed: actualModel, generationAttempted: attempted };
    } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        if (connection?.release) {
            try { await connection.release(); }
            catch (error: any) { result = { text: null, error: `Owned CLI LS cleanup unverified: ${error?.message || String(error)}`, failureClass: "UnknownOutcome", modelUsed: actualModel, generationAttempted: attempted }; }
        }
    }
    return result!;
}
