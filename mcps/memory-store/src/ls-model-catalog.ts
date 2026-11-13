import { DEFAULT_ANTIGRAVITY_LS_MODEL, LEGACY_ANTIGRAVITY_LS_MODEL_FALLBACKS } from "./ls-model-defaults.js";

export interface LsCatalogModel {
    model: string;
    modelId: string;
    label: string;
    disabled: boolean;
    remaining?: number;
}

export function parseLsModelCatalog(data: any): LsCatalogModel[] | null {
    const entries = data?.userStatus?.cascadeModelConfigData?.clientModelConfigs;
    if (!Array.isArray(entries)) return null;
    return entries.flatMap((entry: any) => {
        const model = entry?.modelOrAlias?.model;
        if (typeof model !== "string" || !model) return [];
        const remaining = entry.quotaInfo?.remainingFraction;
        return [{ model, modelId: String(entry.modelId || ""), label: String(entry.label || ""), disabled: entry.disabled === true,
            ...(typeof remaining === "number" && Number.isFinite(remaining) ? { remaining } : {}) }];
    });
}

function normalized(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9]/gu, "");
}

function matches(entry: LsCatalogModel, requested: string): boolean {
    const key = normalized(requested);
    return [entry.model, entry.modelId, entry.label].some(value => normalized(value) === key)
        || /^m\d+$/u.test(key) && normalized(entry.model) === `modelplaceholder${key}`;
}

export function selectLsModelCandidates(requested: string, catalog: LsCatalogModel[] | null, configuredFallbacks?: string): string[] {
    const configured = (configuredFallbacks || "").split(",").map(value => value.trim()).filter(Boolean);
    if (catalog === null) {
        const legacyRequested = requested === DEFAULT_ANTIGRAVITY_LS_MODEL ? LEGACY_ANTIGRAVITY_LS_MODEL_FALLBACKS[0] : requested;
        return [...new Set([legacyRequested, ...(configured.length ? configured : LEGACY_ANTIGRAVITY_LS_MODEL_FALLBACKS)])];
    }
    const available = catalog.filter(entry => !entry.disabled && (entry.remaining === undefined || entry.remaining > 0));
    const exact = catalog.find(entry => matches(entry, requested));
    const explicitClaude = /claude|opus|sonnet/iu.test(requested) || /^MODEL_PLACEHOLDER_M40[0-5]$/u.test(requested);
    if (explicitClaude) return available.filter(entry => matches(entry, requested)).map(entry => entry.model);
    const ordinary = requested === DEFAULT_ANTIGRAVITY_LS_MODEL || /^(?:flash|default|auto)$/iu.test(requested)
        || /M132$|GEMINI_2_5_FLASH|gemini.*flash/iu.test(requested);
    const strong = /argon|carbon|\bpro\b|M(?:20|18|16|36|37|47)$/iu.test(requested);
    const family = (pattern: RegExp) => available.filter(entry => pattern.test(`${entry.label} ${entry.modelId}`));
    const rank = (entry: LsCatalogModel) => /high/iu.test(entry.label) ? 0 : /medium/iu.test(entry.label) ? 1 : 2;
    const defaults = ordinary ? family(/flash/iu) : strong ? family(/carbon|argon/iu).filter(entry => !/orchestrator/iu.test(entry.label)) : [];
    defaults.sort((left, right) => rank(left) - rank(right));
    const primary = exact && available.includes(exact) ? [exact.model] : [];
    const explicitFallbacks = configured.flatMap(value => available.filter(entry => matches(entry, value)).map(entry => entry.model));
    return [...new Set([...primary, ...defaults.map(entry => entry.model), ...explicitFallbacks])];
}
