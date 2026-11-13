import { callGetModelResponseDetailed, type LsModelResult } from "./ls-client.js";
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

export async function callValidatedLsCandidates(
    model: string,
    prompt: string,
    timeoutMs: number,
    signal: AbortSignal,
    validator: Validator,
    failures: ModelBridgeAttemptFailure[],
): Promise<LsModelResult & { modelUsed?: string; cancelled?: boolean }> {
    return callGetModelResponseDetailed(model, prompt, timeoutMs, {
        signal,
        validator: (text, candidate) => rejectResponse(text, "antigravity", candidate, validator, failures),
        onFailure: (candidate, error, failureClass) => {
            if (failureClass !== "Quality") failures.push({ provider: "antigravity", model: candidate, reason: error, occurredAt: new Date().toISOString(), kind: "provider", failureClass });
        },
    });
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
