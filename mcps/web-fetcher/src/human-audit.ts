import type { HumanVerificationConfidence, HumanVerificationEvidence, HumanVerificationStatus } from "./human-verification.js";

export type HumanVerificationAuditPhase =
    | HumanVerificationStatus
    | "human_verification_opened"
    | "human_verification_completed"
    | "live_session_reused"
    | "cookie_copy_fallback"
    | "failed"
    | "detached"
    | "closed";

export interface HumanVerificationAuditEvent {
    phase: HumanVerificationAuditPhase;
    at: string;
    url?: string;
    ownerId?: string;
    humanSessionId?: string;
    sessionId?: string;
    pageId?: string;
    confidence?: HumanVerificationConfidence;
    reasonCodes?: string[];
    evidence?: HumanVerificationEvidence[];
    metadata?: Record<string, string | number | boolean | undefined>;
}

export function makeHumanVerificationAuditEvent(
    event: Omit<HumanVerificationAuditEvent, "at">
): HumanVerificationAuditEvent {
    return {
        ...event,
        at: new Date().toISOString(),
        evidence: event.evidence?.map(item => ({
            type: item.type,
            value: redactAuditValue(item.value),
        })),
    };
}

export function logHumanVerificationAudit(event: Omit<HumanVerificationAuditEvent, "at">): void {
    const safeEvent = makeHumanVerificationAuditEvent(event);
    console.error(`[web-fetcher] HUMAN_VERIFICATION_AUDIT ${JSON.stringify(safeEvent)}`);
}

function redactAuditValue(value: string): string {
    return value
        .replace(/(cookie|token|authorization|password|passwd|secret)=([^;&\s]+)/ig, "$1=<redacted>")
        .slice(0, 180);
}
