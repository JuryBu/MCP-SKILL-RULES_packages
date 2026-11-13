import type { CatalogSnapshot, ModelEntry } from './catalog.js';
import type { Evidence } from './evidence.js';

export function readCatalogVersion(value: unknown): string | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const data = value as Record<string, unknown>;
    if (typeof data.catalogVersion === 'string' && data.catalogVersion.length) return data.catalogVersion;
    return data.catalog && typeof data.catalog === 'object' ? readCatalogVersion(data.catalog) : null;
}

export function evidenceFreshness(evidence: Evidence<unknown>, now = Date.now()): 'current' | 'expired' | 'future' | 'unknown' {
    if (!Number.isFinite(Date.parse(evidence.observedAt)) || !Number.isFinite(Date.parse(evidence.expiresAt))) return 'unknown';
    if (Date.parse(evidence.observedAt) > now) return 'future';
    if (Date.parse(evidence.expiresAt) <= now) return 'expired';
    return 'current';
}

export function modelEvidenceState(entry: ModelEntry, now = Date.now()) {
    const fields: Record<string, Evidence<unknown>> = { contextWindow: entry.contextWindow, maxOutputTokens: entry.maxOutputTokens,
        inputModalities: entry.inputModalities, outputModalities: entry.outputModalities, tools: entry.tools, streaming: entry.streaming,
        pricing: entry.pricing, ...(entry.maxInputTokens ? { maxInputTokens: entry.maxInputTokens } : {}),
        ...(entry.thinking ? { thinking: entry.thinking } : {}), ...Object.fromEntries(Object.entries(entry.parameters).map(([name, value]) => [`parameters.${name}`, value])) };
    return { retired: entry.retired, fields: Object.fromEntries(Object.entries(fields).map(([name, evidence]) => [name, {
        status: evidence.status, freshness: evidenceFreshness(evidence, now), source: evidence.source, confidence: evidence.confidence,
        sourceRef: evidence.sourceRef, observedAt: evidence.observedAt, expiresAt: evidence.expiresAt,
    }])) };
}

export function catalogState(snapshot: CatalogSnapshot | null, now = Date.now()) {
    return { catalogVersion: snapshot?.catalogVersion ?? null, observedAt: snapshot?.observedAt ?? null,
        expiresAt: snapshot?.expiresAt ?? null, profileRevision: snapshot?.profileRevision ?? null,
        freshness: !snapshot ? 'missing' : !Number.isFinite(Date.parse(snapshot.observedAt)) || !Number.isFinite(Date.parse(snapshot.expiresAt)) ? 'unknown'
            : Date.parse(snapshot.observedAt) > now ? 'future' : Date.parse(snapshot.expiresAt) <= now ? 'expired' : 'current' };
}
