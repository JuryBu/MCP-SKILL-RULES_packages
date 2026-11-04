import { canonicalJson } from '../protocol.js';
import type { ProviderProtocol } from '../providers/types.js';
import type { CatalogSnapshot, ModelEntry, ParameterSpec } from './catalog.js';
import type { Evidence } from './evidence.js';

export interface CatalogSourceScope { endpoint: string; protocol: ProviderProtocol }

const fields = ['contextWindow', 'maxOutputTokens', 'inputModalities', 'outputModalities', 'tools', 'streaming', 'pricing'] as const;
const identity = (entry: ModelEntry): string => canonicalJson([entry.modelId, entry.routeId]);
const sameSource = (entry: ModelEntry, scope: CatalogSourceScope): boolean => entry.protocol === scope.protocol
    && entry.contextWindow.scope.endpoint === scope.endpoint;
const declaredSource = (evidence: Evidence<unknown>): boolean => evidence.source === 'manual' || evidence.source === 'verified_fixture';

export function catalogLayers(snapshot: CatalogSnapshot | null): { discoveryEntries: ModelEntry[]; declarations: ModelEntry[] } {
    if (!snapshot) return { discoveryEntries: [], declarations: [] };
    if (snapshot.discoveryEntries && snapshot.declarations) {
        return { discoveryEntries: snapshot.discoveryEntries, declarations: snapshot.declarations };
    }
    const isDeclaration = (entry: ModelEntry): boolean => [...fields.map(field => entry[field]), ...Object.values(entry.parameters)].some(declaredSource);
    return { discoveryEntries: snapshot.entries.filter(entry => !isDeclaration(entry)), declarations: snapshot.entries.filter(isDeclaration) };
}

function overlayEvidence<Value>(discovery: Evidence<Value>, declaration: Evidence<Value> | undefined, now: number): Evidence<Value> {
    if (!declaration || !declaredSource(declaration) || declaration.status === 'unknown'
        || Date.parse(declaration.observedAt) > now || Date.parse(declaration.expiresAt) <= now
        || canonicalJson(discovery.scope) !== canonicalJson(declaration.scope)) return discovery;
    if (discovery.status !== 'unknown' && Date.parse(discovery.observedAt) <= now && Date.parse(discovery.expiresAt) > now
        && (discovery.status !== declaration.status || canonicalJson(discovery.value) !== canonicalJson(declaration.value))) {
        return { ...declaration, conflicts: [...(declaration.conflicts ?? []), structuredClone(discovery)] };
    }
    return declaration;
}

export function composeCatalogEntries(discoveryEntries: ModelEntry[], declarations: ModelEntry[], scope: CatalogSourceScope, now: number): ModelEntry[] {
    const discovered = discoveryEntries.filter(entry => sameSource(entry, scope));
    const entries = new Map(discovered.map(entry => [identity(entry), entry]));
    for (const declaration of declarations.filter(entry => sameSource(entry, scope))) {
        const key = identity(declaration);
        const discovery = entries.get(key);
        const availability = discovery ?? discovered.find(entry => entry.modelId === declaration.modelId && entry.routeId === null);
        const base = discovery ?? { ...declaration, parameters: {},
            ...Object.fromEntries(fields.map(field => [field, { ...declaration[field], value: null, status: 'unknown', conflicts: undefined }])) } as ModelEntry;
        const parameters: Record<string, Evidence<ParameterSpec>> = { ...base.parameters };
        for (const [name, evidence] of Object.entries(declaration.parameters)) {
            const original = parameters[name];
            if (original) parameters[name] = overlayEvidence(original, evidence, now);
            else if (declaredSource(evidence) && evidence.status !== 'unknown' && Date.parse(evidence.observedAt) <= now && Date.parse(evidence.expiresAt) > now) {
                parameters[name] = evidence;
            }
        }
        entries.set(key, { ...base, retired: availability?.retired ?? declaration.retired, parameters,
            contextWindow: overlayEvidence(base.contextWindow, declaration.contextWindow, now),
            maxOutputTokens: overlayEvidence(base.maxOutputTokens, declaration.maxOutputTokens, now),
            inputModalities: overlayEvidence(base.inputModalities, declaration.inputModalities, now),
            outputModalities: overlayEvidence(base.outputModalities, declaration.outputModalities, now),
            tools: overlayEvidence(base.tools, declaration.tools, now), streaming: overlayEvidence(base.streaming, declaration.streaming, now),
            pricing: overlayEvidence(base.pricing, declaration.pricing, now) });
    }
    return [...entries.values()];
}

export function effectiveCatalog(snapshot: CatalogSnapshot, now: number): CatalogSnapshot {
    if (!snapshot.sourceScope || !snapshot.discoveryEntries || !snapshot.declarations) return snapshot;
    return { ...snapshot, entries: composeCatalogEntries(snapshot.discoveryEntries, snapshot.declarations, snapshot.sourceScope, now) };
}
