import type { AutoSummaryProvenance } from "./auto-summary-types.js";

export function parseAutoSummaryProvenance(value: unknown): AutoSummaryProvenance | null {
    if (typeof value !== "string") return null;
    try {
        const parsed = JSON.parse(value) as AutoSummaryProvenance;
        return parsed?.version === 1 && ["generated", "failed", "pending"].includes(parsed.status) ? parsed : null;
    } catch {
        return null;
    }
}

export function pendingAutoSummaryProvenance(value: unknown, queuedAt: string): string {
    const previous = parseAutoSummaryProvenance(value);
    const summarySource = previous?.summarySource || (previous?.status === "generated" ? { provider: previous.provider, model: previous.model, generatedAt: previous.generatedAt } : undefined);
    return JSON.stringify({ version: 1, status: "pending", provider: null, model: null, generatedAt: queuedAt, failures: [], ...(summarySource ? { summarySource } : {}) });
}
