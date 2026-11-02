import { callModelResponse, type ModelBridgeOptions, type ModelBridgeResult } from "./model-bridge.js";
import { validateAutoSummaryCandidate } from "./auto-summary-validation.js";
import type { AutoSummaryGenerationResult } from "./auto-summary-types.js";
export type { AutoSummaryGenerationResult, AutoSummaryProvenance } from "./auto-summary-types.js";
import type { Chain } from "./chain.js";
import { DEFAULT_ANTIGRAVITY_LS_MODEL } from "./ls-model-defaults.js";
export { captureAutoSummarySnapshot, captureAutoSummaryFileSnapshot, autoSummarySourceFingerprint, type AutoSummarySnapshot } from "./auto-summary-snapshot.js";
export { writeAutoSummaryIfUnchanged, recoverAutoSummaryWriteback, restoreAutoSummaryWriteback, autoSummaryRecoveryInfo, type AutoSummaryWritebackResult } from "./auto-summary-storage.js";
import { withToolConcurrency } from "./tool-concurrency.js";

const AUTO_SUMMARY_MODEL = process.env.MEMORY_STORE_AUTOSUMMARY_MODEL || process.env.MEMORY_STORE_LS_MODEL || DEFAULT_ANTIGRAVITY_LS_MODEL;
const AUTO_SUMMARY_TIMEOUT_MS = Number(process.env.MEMORY_STORE_AUTOSUMMARY_TIMEOUT_MS || "30000");

export function shouldGenerateAutoSummaryForUpdate(input: {
    contentChanged: boolean;
    titleChanged: boolean;
    tagsChanged: boolean;
    existingAutoSummary?: string;
    existingSummaryPending?: boolean;
}): boolean {
    return input.contentChanged
        || input.titleChanged
        || input.tagsChanged
        || input.existingSummaryPending === true
        || !input.existingAutoSummary?.trim();
}

export async function generateAutoSummary(
    title: string,
    tags: string[],
    content: string,
    chain: Chain = "auto",
): Promise<string | null> {
    return (await generateAutoSummaryResult(title, tags, content, chain)).summary;
}

export async function generateAutoSummaryResult(
    title: string,
    tags: string[],
    content: string,
    chain: Chain = "auto",
    options: Pick<ModelBridgeOptions, "signal" | "shouldCancel"> & {
        timeoutMs?: number;
        callModel?: typeof callModelResponse;
    } = {},
): Promise<AutoSummaryGenerationResult> {
    const truncatedContent = content.length > 6000
        ? content.slice(0, 6000) + "\n\n[内容已截断]"
        : content;

    const prompt = `请为以下记忆生成一段简洁的中文摘要，用于未来快速理解和检索。

要求：
- 80-150 字
- 概括核心内容、关键决策、技术点或问题解决方案
- 不要重复标题
- 直接输出摘要文本，不要加前缀

标题: ${title}
标签: ${tags.join(", ")}

内容:
${truncatedContent}`;

    const result: ModelBridgeResult = await withToolConcurrency(
        "mixed",
        "autoSummary",
        () => (options.callModel || callModelResponse)(AUTO_SUMMARY_MODEL, prompt, chain, options.timeoutMs ?? AUTO_SUMMARY_TIMEOUT_MS, {
            grokContext: "default",
            signal: options.signal,
            shouldCancel: options.shouldCancel,
            responseValidator: candidate => validateAutoSummaryCandidate(candidate.text),
        }),
    ).catch(error => {
        const reason = error instanceof Error ? error.message : String(error);
        return {
            text: null, chainUsed: null, modelUsed: null, error: reason, failureClass: "UnknownOutcome" as const,
            attemptFailures: [{ provider: null, model: null, reason, occurredAt: new Date().toISOString(), kind: "provider" as const, failureClass: "UnknownOutcome" as const }],
        };
    });
    if (result.chainUsed) {
        console.error(`[auto-summary] modelChain=${chain} actualChain=${result.chainUsed} actualModel=${result.modelUsed || "unknown"} grokContext=default`);
    }
    const text = result.text?.trim() || null;
    const invalid = text ? validateAutoSummaryCandidate(text) : null;
    const stopped = result.cancelled || result.safetyStopped || result.failureClass === "UnknownOutcome" || result.timedOut;
    const summary = !stopped && !invalid ? text : null;
    const generatedAt = new Date().toISOString();
    const lastFailure = [...(result.attemptFailures || [])].reverse().find(failure => failure.provider !== null);
    return {
        summary,
        provenance: {
            version: 1,
            status: summary ? "generated" : "failed",
            provider: result.chainUsed || lastFailure?.provider || null,
            model: result.modelUsed || lastFailure?.model || null,
            generatedAt,
            failures: [
                ...(result.attemptFailures || []),
                ...(invalid ? [{ provider: result.chainUsed, model: result.modelUsed || null, reason: invalid, occurredAt: generatedAt, kind: "response-validation" as const, failureClass: "Quality" as const }] : []),
            ],
            ...(result.cancelled ? { cancelled: true } : {}),
            ...(result.safetyStopped ? { safetyStopped: true } : {}),
            ...(result.timedOut ? { timedOut: true } : {}),
            ...(result.failureClass ? { failureClass: result.failureClass } : {}),
        },
    };
}
