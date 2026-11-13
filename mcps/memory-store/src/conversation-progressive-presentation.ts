export function progressiveWorkerProgress(event: { stage?: string; detail?: string; current?: number; total?: number; unit?: string }) {
    return { stage: event.stage, detail: event.detail, current: event.current, total: event.total,
        unit: event.unit ?? (event.stage?.startsWith("source:") ? "字节" : event.current !== undefined ? "轮" : undefined) };
}

export function reconcileProgressiveWarnings(warnings: readonly string[], complete: boolean) {
    const superseded = /^(?:host_cold_tail_relative_rounds|host_source_partial|RELATIVE_TAIL_WINDOW)(?:$|[:\s])/u;
    return { warnings: [...new Set(warnings.filter(warning => !complete || !superseded.test(warning)))],
        historicalWarnings: complete ? [...new Set(warnings.filter(warning => superseded.test(warning)))] : [] };
}

export function progressiveWarningView<State extends { warnings: string[]; historicalWarnings?: string[] }>(state: State, complete: boolean) {
    const current = reconcileProgressiveWarnings(state.warnings, complete);
    return { ...state, warnings: current.warnings,
        historicalWarnings: [...new Set([...(state.historicalWarnings ?? []), ...current.historicalWarnings])] };
}

export function progressiveCompletedProgress(progress: { stage?: string; detail?: string; current?: number; unit?: string } | undefined,
    completed: boolean, publishedRounds?: number) {
    return completed ? { ...progress, stage: "complete", detail: "完整fetch缓存已发布，已就绪范围可以继续读取",
        current: publishedRounds, unit: "轮" } : progress;
}
import type { ProgressiveStatus } from "./conversation-progressive-types.js";

export function selectedProgressiveStatus(status: ProgressiveStatus, blockIds?: readonly string[]): ProgressiveStatus {
    if (!blockIds?.length) return status;
    const selected = new Set(blockIds);
    const blocks = status.blocks.filter(block => selected.has(block.blockId));
    const completeRanges = status.completeRanges.filter(range => selected.has(range.blockId));
    const absoluteRanges: ProgressiveStatus["absoluteRanges"] = [];
    for (const range of completeRanges.filter(range => range.kind === "absolute").sort((first, second) => first.startRound - second.startRound)) {
        const previous = absoluteRanges.at(-1);
        if (previous && range.startRound <= previous.endRound + 1) previous.endRound = Math.max(previous.endRound, range.endRound);
        else absoluteRanges.push({ startRound: range.startRound, endRound: range.endRound });
    }
    return { ...status, blocks, completeRanges, absoluteRanges,
        coveredAbsoluteRounds: absoluteRanges.reduce((total, range) => total + range.endRound - range.startRound + 1, 0),
        relativeReadyRounds: blocks.filter(block => block.coverage.kind === "relative").reduce((total, block) => total + block.roundCount, 0) };
}

