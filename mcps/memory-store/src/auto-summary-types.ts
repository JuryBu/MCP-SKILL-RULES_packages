import type { ModelBridgeAttemptFailure } from "./model-bridge.js";
import type { GrokAvailabilityDiagnostics } from "./grok-client.js";

export interface AutoSummaryProvenance {
    version: 1;
    status: "generated" | "failed" | "pending";
    provider: string | null;
    model: string | null;
    generatedAt: string;
    failures: readonly ModelBridgeAttemptFailure[];
    summarySource?: { provider: string | null; model: string | null; generatedAt: string; sourceFingerprint?: string };
    cancelled?: boolean;
    safetyStopped?: boolean;
    timedOut?: boolean;
    failureClass?: string;
    grokAvailabilityDiagnostics?: GrokAvailabilityDiagnostics;
}

export interface AutoSummaryGenerationResult {
    summary: string | null;
    provenance: AutoSummaryProvenance;
}
