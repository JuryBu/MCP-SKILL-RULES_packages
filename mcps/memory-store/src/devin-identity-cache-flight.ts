import { resolveDevinConversation } from "./devin-sqlite.js";
import { devinSourceValidationRevision } from "./devin-source-validation.js";
import type { DevinConversationSummary, DevinReadOptions } from "./devin-types.js";
import type { ConversationSourceFingerprint } from "./conversation-source-cache.js";

const resolutions = new Map<string, Promise<DevinConversationSummary | null>>();
export interface DevinPublishedIdentityVerification {
    status: "pending" | "verified" | "changed" | "deferred";
    code?: string;
}
const publishedVerifications = new Map<string, DevinPublishedIdentityVerification>();

export function schedulePublishedDevinIdentityVerification(id: string, generation: string, fingerprint: ConversationSourceFingerprint | null,
    aliases: string[]): DevinPublishedIdentityVerification {
    const key = JSON.stringify([id, generation]);
    const existing = publishedVerifications.get(key);
    if (existing) return { ...existing };
    const state: DevinPublishedIdentityVerification = { status: "pending" };
    publishedVerifications.set(key, state);
    while (publishedVerifications.size > 64) publishedVerifications.delete(publishedVerifications.keys().next().value!);
    setImmediate(() => {
        void (async () => {
            try {
                const revision = devinSourceValidationRevision();
                if (revision === fingerprint?.revision) { state.status = "verified"; return; }
                const summary = await resolveDevinIdentityOnce(id, { deadlineMs: Date.now() + 1500 });
                state.status = summary?.canonicalId === id && aliases.every(alias => summary.aliases.includes(alias)) ? "verified" : "changed";
            } catch (error) {
                state.status = "deferred";
                state.code = (error as { code?: string }).code || "DEVIN_IDENTITY_UNAVAILABLE";
            }
        })();
    });
    return { ...state };
}

export function resolveDevinIdentityOnce(id: string, options: DevinReadOptions = {}): Promise<DevinConversationSummary | null> {
    if (options.signal || options.isCancelled || options.identityCache) return resolveDevinConversation(id, options);
    const key = JSON.stringify([id, devinSourceValidationRevision(options.maxDesktopFiles), options]);
    const existing = resolutions.get(key);
    if (existing) return existing;
    const pending = resolveDevinConversation(id, options).finally(() => { resolutions.delete(key); });
    resolutions.set(key, pending);
    return pending;
}
