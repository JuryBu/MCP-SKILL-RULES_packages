import fs from "node:fs";

export type AntigravityTransport = "app-ls" | "legacy-ls" | "cli-ls" | "cli-agent";
export type AntigravityOutcomeKind = "success" | "not-started" | "rejected" | "auth-required" | "quota-exhausted" | "cancelled" | "timeout-unknown" | "transport-unknown";

export interface AntigravityOutcome {
    transport?: AntigravityTransport;
    model?: string;
    submitted: boolean;
    outcomeUnknown: boolean;
    safeToFallback: boolean;
    kind: AntigravityOutcomeKind;
}

export class AntigravityCallError extends Error implements AntigravityOutcome {
    readonly retryable: boolean;
    readonly timedOut: boolean;
    readonly transport?: AntigravityTransport;
    readonly model?: string;
    readonly submitted: boolean;
    readonly outcomeUnknown: boolean;
    readonly safeToFallback: boolean;
    readonly kind: AntigravityOutcomeKind;

    constructor(message: string, outcome: AntigravityOutcome, options?: ErrorOptions) {
        super(message, options);
        this.name = "AntigravityCallError";
        Object.assign(this, outcome);
        this.transport = outcome.transport;
        this.model = outcome.model;
        this.submitted = outcome.submitted;
        this.outcomeUnknown = outcome.outcomeUnknown;
        this.safeToFallback = outcome.safeToFallback;
        this.kind = outcome.kind;
        this.retryable = outcome.safeToFallback && !outcome.outcomeUnknown;
        this.timedOut = outcome.kind === "timeout-unknown";
    }
}

export interface AntigravityCatalogModel {
    label: string;
    id: string;
    model: string;
    disabled: boolean;
    reason?: string;
    remaining?: number;
}

export interface AntigravityCatalog {
    models: AntigravityCatalogModel[];
    observedAt: string;
    source: "GetUserStatus" | "fixture";
}

function record(value: unknown): Record<string, any> {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

export function parseAntigravityCatalog(value: unknown, now = Date.now()): AntigravityCatalog | null {
    const root = record(value);
    const status = record(root.userStatus);
    const config = record(status.cascadeModelConfigData);
    const source = Array.isArray(root.models) ? "fixture" : "GetUserStatus";
    const entries: unknown = source === "fixture" ? root.models : config.clientModelConfigs;
    if (!Array.isArray(entries)) return null;
    const models: AntigravityCatalogModel[] = [];
    for (const item of entries) {
        const entry = record(item);
        const model = entry.modelOrAlias?.model ?? entry.model;
        const id = entry.modelId ?? entry.id;
        if (typeof model !== "string" || !/^MODEL_[A-Z0-9_]+$/u.test(model) || typeof id !== "string" || typeof entry.label !== "string") continue;
        const remaining = entry.quotaInfo?.remainingFraction ?? entry.remaining;
        const reason = entry.disabledReason ?? entry.reason ?? entry.description;
        models.push({ label: entry.label, id, model, disabled: entry.disabled === true,
            ...(typeof reason === "string" ? { reason } : {}),
            ...(typeof remaining === "number" && Number.isFinite(remaining) ? { remaining } : {}) });
    }
    return { models, observedAt: typeof root.observedAt === "string" ? root.observedAt : new Date(now).toISOString(), source };
}

function normalized(value: string): string {
    return value.trim().toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "");
}

export function isDefaultAntigravityModel(requested: string): boolean {
    return /^(?:|default|auto|fast|ag-fast|flash|gemini-flash)$/u.test(normalized(requested));
}

export function defaultAntigravityFlashCandidates(catalog: AntigravityCatalog, requested: string): AntigravityCatalogModel[] {
    const selected = selectAntigravityModel(catalog, requested || "default");
    if (!isDefaultAntigravityModel(requested)) return [selected];
    const family = selected.id.replace(/-high$/u, "");
    return [selected, ...["medium", "low"].flatMap(level => {
        const candidate = catalog.models.find(entry => entry.id === `${family}-${level}` && !entry.disabled && (entry.remaining === undefined || entry.remaining > 0));
        return candidate ? [candidate] : [];
    })];
}

function unavailable(model: AntigravityCatalogModel): AntigravityCallError {
    const quota = typeof model.remaining === "number" && model.remaining <= 0;
    return new AntigravityCallError(`Antigravity 模型不可用: ${model.label}${model.reason ? ` (${model.reason})` : ""}${quota ? "，额度耗尽" : ""}`,
        { model: model.model, submitted: false, outcomeUnknown: false, safeToFallback: false, kind: quota ? "quota-exhausted" : "rejected" });
}

export function selectAntigravityModel(catalog: AntigravityCatalog, requested = "default"): AntigravityCatalogModel {
    const key = normalized(requested || "default");
    const exact = catalog.models.find(entry => [entry.id, entry.label, entry.model, entry.model.replace(/^MODEL_PLACEHOLDER_/u, "")]
        .some(value => normalized(value) === key));
    if (exact) {
        if (exact.disabled || (typeof exact.remaining === "number" && exact.remaining <= 0)) throw unavailable(exact);
        return exact;
    }
    const family = /^(?:default|auto|fast|ag-fast|flash|gemini-flash)$/u.test(key) ? "flash"
        : /^(?:pro|pro-high|gemini-pro|strong|reasoning|argon|argon-high)$/u.test(key) ? "argon"
            : /^(?:carbon|carbon-high)$/u.test(key) ? "carbon"
                : /^(?:sonnet|claude-sonnet)$/u.test(key) ? "sonnet"
                    : /^(?:opus|claude-opus)$/u.test(key) ? "opus" : undefined;
    if (!family) throw new AntigravityCallError(`Antigravity 当前目录没有模型: ${requested}`,
        { submitted: false, outcomeUnknown: false, safeToFallback: false, kind: "rejected" });
    const families = family === "argon" && !key.startsWith("argon") ? ["argon", "carbon"] : [family];
    const candidates = families.flatMap(name => catalog.models.filter(entry => {
        const modelKey = normalized(entry.id);
        return modelKey.includes(name) && /-high$/u.test(modelKey) && !modelKey.includes("orchestrator");
    }).sort((left, right) => {
        const preferred = (entry: AntigravityCatalogModel) => entry.id === "gemini-3.8-flash-high" ? 1 : 0;
        return preferred(right) - preferred(left) || right.id.localeCompare(left.id, undefined, { numeric: true });
    }));
    const selected = candidates.find(entry => !entry.disabled && (entry.remaining === undefined || entry.remaining > 0));
    if (selected) return selected;
    if (candidates[0]) throw unavailable(candidates[0]);
    throw new AntigravityCallError(`Antigravity 当前目录没有可用的 ${family} High 模型`,
        { submitted: false, outcomeUnknown: false, safeToFallback: false, kind: "rejected" });
}

let fixtureCache: { path: string; stamp: string; catalog: AntigravityCatalog } | undefined;

export function readAntigravityCatalogFixture(now = Date.now()): AntigravityCatalog | null {
    const filePath = process.env.SANDBOX_AGY_CATALOG_PATH?.trim();
    if (!filePath) return null;
    const metadata = fs.statSync(filePath);
    if (!metadata.isFile() || metadata.size > 2 * 1024 * 1024) throw new Error("Antigravity 目录 fixture 大小或类型无效");
    const stamp = `${metadata.mtimeMs}:${metadata.size}`;
    if (fixtureCache?.path !== filePath || fixtureCache.stamp !== stamp) {
        const catalog = parseAntigravityCatalog(JSON.parse(fs.readFileSync(filePath, "utf8")), now);
        if (!catalog) throw new Error("Antigravity 目录 fixture 缺少模型目录");
        fixtureCache = { path: filePath, stamp, catalog };
    }
    const age = now - Date.parse(fixtureCache.catalog.observedAt);
    const maxAge = Number(process.env.SANDBOX_AGY_CATALOG_MAX_AGE_MS || 60 * 60_000);
    if (!Number.isFinite(age) || age < -60_000 || !Number.isFinite(maxAge) || maxAge <= 0 || age > maxAge) {
        throw new AntigravityCallError("Antigravity 目录 fixture 已过期或时间无效，请刷新原目录后重试",
            { submitted: false, outcomeUnknown: false, safeToFallback: false, kind: "not-started" });
    }
    return fixtureCache.catalog;
}

export function antigravityOutcomeFromError(error: unknown, fallback?: Partial<AntigravityOutcome>): AntigravityCallError {
    if (error instanceof AntigravityCallError) return error;
    const aborted = error instanceof Error && error.name === "AbortError";
    return new AntigravityCallError(error instanceof Error ? error.message : String(error), {
        submitted: false, outcomeUnknown: false, safeToFallback: !aborted, kind: aborted ? "cancelled" : "not-started", ...fallback,
    }, { cause: error });
}
