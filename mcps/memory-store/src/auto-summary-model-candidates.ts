import { getLsModelCandidates, getParentLs, type LsModelResult } from "./ls-client.js";
import { enumerateActiveLs } from "./conversation-router.js";
import { rpcCall } from "./ls-rpc.js";
import { AGY_MODEL_SEQUENCE, callAgyModel, type AgyFallbackResult, type AgyInvocationOptions, type AgyAttempt } from "./agy-client.js";
import type { ModelBridgeAttemptFailure, ModelBridgeOptions, ModelResponseCandidate } from "./model-bridge.js";

type Validator = NonNullable<ModelBridgeOptions["responseValidator"]>;

function rejectResponse(text: string, provider: ModelResponseCandidate["provider"], model: string, validator: Validator, failures: ModelBridgeAttemptFailure[]): string | null {
    let reason: string | null;
    try {
        reason = validator({ text, provider, model });
    } catch {
        reason = "response-validator-failed";
    }
    if (!reason) return null;
    const error = `Invalid model response: ${reason}`;
    failures.push({ provider, model, reason: error, occurredAt: new Date().toISOString(), kind: "response-validation", failureClass: "Quality" });
    return error;
}

function untilAborted<Value>(promise: Promise<Value>, signal: AbortSignal): Promise<Value> {
    return new Promise((resolve, reject) => {
        const aborted = () => reject(new Error("summary-candidate-aborted"));
        signal.addEventListener("abort", aborted, { once: true });
        promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
        if (signal.aborted) aborted();
    });
}

export async function callValidatedLsCandidates(
    model: string,
    prompt: string,
    timeoutMs: number,
    signal: AbortSignal,
    validator: Validator,
    failures: ModelBridgeAttemptFailure[],
): Promise<LsModelResult & { modelUsed?: string; cancelled?: boolean }> {
    const deadlineAt = performance.now() + timeoutMs;
    let actualModel = model;
    let launched = false;
    try {
        const parent = getParentLs();
        const endpoint = parent ? null : (await untilAborted(enumerateActiveLs("antigravity"), signal))[0];
        const connection = parent || (endpoint ? {
            info: { pid: endpoint.pid, csrfToken: endpoint.csrfToken, workspaceId: endpoint.workspaceId || "", ports: [endpoint.port] },
            port: endpoint.port,
        } : null);
        if (!connection) return { text: null, error: "Antigravity LS connection unavailable", failureClass: "Availability", modelUsed: model };
        let last: LsModelResult & { modelUsed?: string } = { text: null, error: "Antigravity LS empty response", failureClass: "Quality", modelUsed: model };
        for (const candidate of getLsModelCandidates(model)) {
            if (signal.aborted || performance.now() >= deadlineAt) break;
            actualModel = candidate;
            launched = true;
            const response = await untilAborted(rpcCall(connection.info, connection.port, "GetModelResponse", { model: candidate, prompt }, Math.max(1, Math.floor(deadlineAt - performance.now()))), signal);
            const text = typeof response.data?.response === "string" ? response.data.response : "";
            const error = response.status === 200
                ? rejectResponse(text, "antigravity", candidate, validator, failures)
                : `Antigravity LS HTTP ${response.status}`;
            if (!error) return { text, modelUsed: candidate };
            last = { text: null, error, modelUsed: candidate, failureClass: response.status === 200 ? "Quality" : "Availability" };
            if (response.status !== 200) failures.push({ provider: "antigravity", model: candidate, reason: error, occurredAt: new Date().toISOString(), kind: "provider", failureClass: last.failureClass });
        }
        if (signal.aborted || performance.now() >= deadlineAt) return { text: null, error: "Antigravity LS candidate deadline reached", timedOut: true, modelUsed: actualModel, failureClass: launched ? "UnknownOutcome" : "Availability" };
        return last;
    } catch (error) {
        return { text: null, error: error instanceof Error ? error.message : String(error), modelUsed: actualModel, failureClass: launched ? "UnknownOutcome" : "Availability", ...(signal.aborted ? { cancelled: true } : {}) };
    }
}

export async function callValidatedAgyCandidates(
    prompt: string,
    options: AgyInvocationOptions,
    validator: Validator,
    failures: ModelBridgeAttemptFailure[],
): Promise<AgyFallbackResult> {
    const deadlineAt = performance.now() + (options.timeoutMs || 30_000);
    const attempts: AgyAttempt[] = [];
    let latest: AgyFallbackResult | undefined;
    for (const model of AGY_MODEL_SEQUENCE) {
        const remaining = Math.floor(deadlineAt - performance.now());
        if (options.signal?.aborted || remaining <= 0) break;
        const raw = await callAgyModel(prompt, model, { ...options, timeoutMs: remaining });
        const reason = raw.text !== null && !raw.cancelled && !raw.timedOut && !raw.truncated && raw.failureClass !== "UnknownOutcome"
            ? rejectResponse(raw.text, "agy", raw.model, validator, failures)
            : null;
        const result = reason ? { ...raw, text: null, error: reason, failureClass: "Quality" as const } : raw;
        attempts.push({ model: result.model, launched: result.launched, exitCode: result.exitCode, error: result.error, failureClass: result.failureClass, timedOut: result.timedOut, cancelled: result.cancelled, truncated: result.truncated, phase: result.phase, timing: result.timing });
        latest = { ...result, attempts };
        if (result.text !== null || !result.launched || result.cancelled || result.timedOut || result.truncated || result.failureClass === "LocalResource" || result.failureClass === "UnknownOutcome") return latest;
        if (!reason && result.error) failures.push({ provider: "agy", model: result.model, reason: result.error, occurredAt: new Date().toISOString(), kind: "provider", failureClass: result.failureClass });
    }
    if (latest && !options.signal?.aborted && performance.now() < deadlineAt) return latest;
    return {
        ...(latest || { model: AGY_MODEL_SEQUENCE[0], elapsedMs: 0, launched: false, stdout: "", stderr: "", attempts }),
        text: null,
        error: "AGY summary candidate deadline reached",
        ...(options.signal?.aborted ? { cancelled: true } : { timedOut: true }),
        failureClass: latest?.launched ? "UnknownOutcome" : "Availability",
    };
}
