import { createHash } from "node:crypto";

export const RECORD_UNIT_SCHEMA_VERSION = 1 as const;
export const RECORD_UNIT_MAX_COUNT = 10_000;
export const RECORD_UNIT_UNKNOWN_OUTCOME_GRACE_MS = 30_000;
export const RECORD_UNIT_REMOTE_EXECUTION_SEMANTICS = "remote-at-least-once-possible" as const;
export const RECORD_UNIT_SPEC_HASH_ROLE = "integrity-only-not-authorization" as const;

export const RECORD_UNIT_PROVIDERS = ["grok", "agy", "antigravity", "codex", "claude-code"] as const;
export const RECORD_UNIT_KINDS = ["round-part", "parallel-chunk", "serial-chunk", "compose-window", "reduce-window"] as const;

export type RecordUnitProvider = typeof RECORD_UNIT_PROVIDERS[number];
export type RecordUnitKind = typeof RECORD_UNIT_KINDS[number];
export type RecordUnitRoute = "auto" | RecordUnitProvider;
export type RecordUnitRangeAxis = "step" | "round";
export type RecordUnitState = "blocked_dependency" | "queued" | "running" | "waiting_backoff" | "unknown_outcome" | "succeeded" | "failed_final" | "split";
export type RecordUnitFailureClass = "Congestion" | "Availability" | "Quality" | "Complexity" | "LocalResource" | "UnknownOutcome" | "DeterministicInput";
export type RecordUnitFailureSignal = "rate-limit" | "resource-exhausted" | "network-timeout" | "network-error" | "provider-unavailable" | "quality-rejected" | "complexity-exceeded" | "local-resource" | "unknown-outcome" | "deterministic-input";
export type RecordUnitAvailability = "available" | "capacity-full" | "unavailable";
export type UnknownOutcomeDecision = "retry_same_provider" | "fallback" | "fail_final";
export type RecordUnitLayerCompletion = "pending" | "succeeded" | "failed";

export interface RecordUnitRange {
    axis: RecordUnitRangeAxis;
    start: number;
    end: number;
}

export interface RecordUnitProvenance {
    sourceSnapshotId: string;
    sourceContentHash: string;
    promptHash: string;
    formatterVersion: string;
}

export interface RecordUnitBudgets {
    unitAttempts: number;
    routeAttempts: number;
    providerAttempts: number;
}

export interface RecordUnitAutoPolicy {
    order: RecordUnitProvider[];
    overflow: {
        enabled: boolean;
        from: "grok";
        to: "agy";
    };
}

export interface RecordUnitPromptDependencyBinding {
    unitId: string;
    placeholder: string;
}

export interface RecordUnitPromptContinuationBinding {
    continuationKey: string;
    previousUnitId: string;
    placeholder: string;
}

export interface RecordUnitPromptRecipe {
    recipeVersion: 1;
    templateId: string;
    range: RecordUnitRange;
    dependencyBindings: RecordUnitPromptDependencyBinding[];
    continuationBinding: RecordUnitPromptContinuationBinding | null;
}

export interface RecordUnitSpecInput {
    unitId: string;
    unitKind: RecordUnitKind;
    inputHash: string;
    provenance: RecordUnitProvenance;
    range: RecordUnitRange;
    composeOrder: number;
    continuationKey: string | null;
    dependencies: string[];
    stepCount: number;
    estimatedCost: number;
    promptRecipe?: RecordUnitPromptRecipe;
}

export interface RecordUnitPlanningInput {
    schemaVersion: typeof RECORD_UNIT_SCHEMA_VERSION;
    kind: "record-unit-plan-input";
    taskId: string;
    recordId: string;
    sourceSnapshotId: string;
    route: RecordUnitRoute;
    autoPolicy?: RecordUnitAutoPolicy | null;
    budgets: RecordUnitBudgets;
    maxUnits: number;
    units: RecordUnitSpecInput[];
}

export interface RecordUnitSpec {
    schemaVersion: typeof RECORD_UNIT_SCHEMA_VERSION;
    kind: "record-unit-spec";
    taskId: string;
    recordId: string;
    unitId: string;
    unitKind: RecordUnitKind;
    active: boolean;
    sourceSnapshotId: string;
    inputHash: string;
    provenance: RecordUnitProvenance;
    promptRecipe: RecordUnitPromptRecipe;
    range: RecordUnitRange;
    composeOrder: number;
    childOrder: number;
    continuationKey: string | null;
    dependencies: string[];
    parentUnitId: string | null;
    childUnitIds: string[];
    splitDepth: number;
    stepCount: number;
    estimatedCost: number;
    inheritedCost: number;
    routePlan: RecordUnitProvider[];
    /** 完整性校验值，不授予 provider 路由权限；授权只能由 Plan 的 route/autoPolicy 重推。 */
    specHash: string;
}

export interface RecordUnitAttempt {
    attemptId: string;
    provider: RecordUnitProvider;
    fence: number;
    dispatchedAt: number;
    inputHash: string;
    provenanceHash: string;
}

export interface RecordUnitFailure {
    attemptId: string;
    provider: RecordUnitProvider;
    fence: number;
    failureClass: RecordUnitFailureClass;
    at: number;
}

export interface RecordUnitUnknownOutcome {
    attemptId: string;
    provider: RecordUnitProvider;
    fence: number;
    dispatchedAt: number;
    graceUntil: number;
    providerEvidence: string;
}

export interface RecordUnitFenceAdvanceEvidence {
    previousAttemptId: string;
    previousFence: number;
    advancedFence: number;
    outcome: "reconciled-not-found" | "known-failure" | "status-unsupported";
    evidenceHash: string;
}

export interface RecordUnitResult {
    attemptId: string;
    provider: RecordUnitProvider;
    model: string;
    fence: number;
    inputHash: string;
    provenanceHash: string;
    outputHash: string;
    qualityHash: string;
}

export type ProviderAttemptCounts = Record<RecordUnitProvider, number>;

export interface RecordUnitPromptResolution {
    status: "waiting_dependencies" | "resolved";
    inputHash: string;
    promptHash: string;
    dependencyOutputs: Array<{ unitId: string; outputHash: string }>;
}

export interface RecordUnitRuntime {
    state: RecordUnitState;
    routeCursor: number;
    currentProvider: RecordUnitProvider | null;
    attemptedProviders: RecordUnitProvider[];
    providerAttemptCounts: ProviderAttemptCounts;
    routeAttempts: number;
    unitAttempts: number;
    nextEligibleAt: number | null;
    currentAttempt: RecordUnitAttempt | null;
    unknownOutcome: RecordUnitUnknownOutcome | null;
    fenceAdvanceEvidence: RecordUnitFenceAdvanceEvidence | null;
    fence: number;
    result: RecordUnitResult | null;
    failureHistory: RecordUnitFailure[];
    lastFailureClass: RecordUnitFailureClass | null;
    prompt: RecordUnitPromptResolution;
}

export interface RecordUnit extends RecordUnitSpec, RecordUnitRuntime {}

export interface RecordUnitLayer {
    layer: number;
    unitIds: string[];
    completion: "all-succeeded";
}

export interface RecordUnitRuntimeNode {
    key: string;
    value: RecordUnitRuntime;
    left: RecordUnitRuntimeNode | null;
    right: RecordUnitRuntimeNode | null;
}

export interface RecordUnitEngineMetrics {
    specHashComputations: number;
    planHashComputations: number;
    layerComputations: number;
    graphValidations: number;
    runtimeNodeCopies: number;
}

export interface RecordUnitPlan {
    schemaVersion: typeof RECORD_UNIT_SCHEMA_VERSION;
    kind: "record-unit-plan";
    taskId: string;
    recordId: string;
    sourceSnapshotId: string;
    route: RecordUnitRoute;
    autoPolicy: RecordUnitAutoPolicy | null;
    budgets: RecordUnitBudgets;
    maxUnits: number;
    unitSpecs: readonly RecordUnitSpec[];
    unitSpecIndex: Readonly<Record<string, number>>;
    runtimeRoot: RecordUnitRuntimeNode | null;
    layers: readonly RecordUnitLayer[];
    planHash: string;
    metrics: RecordUnitEngineMetrics;
    readonly units: readonly RecordUnit[];
}

export interface RecordUnitEligibility {
    eligible: boolean;
    reason: "ready" | "terminal" | "dependency" | "dependency-failed" | "backoff" | "unknown-grace" | "needs-fence-advance" | "unit-budget";
}

export interface RecordUnitUnknownAction {
    action: "needs-fence-advance";
    attemptId: string;
    provider: RecordUnitProvider;
    previousFence: number;
    graceUntil: number;
    remoteExecutionSemantics: typeof RECORD_UNIT_REMOTE_EXECUTION_SEMANTICS;
}

export interface StartRecordUnitOptions {
    now: number;
    availability?: Partial<Record<RecordUnitProvider, RecordUnitAvailability>>;
}

export interface StartRecordUnitResult {
    plan: RecordUnitPlan;
    action: "dispatch" | "blocked" | "waiting-capacity" | "needs-fence-advance" | "failed-final";
    reason: string;
    attempt?: RecordUnitAttempt;
    unknownAction?: RecordUnitUnknownAction;
}

export interface RecordUnitFailureInput {
    attemptId: string;
    fence: number;
    failureClass: RecordUnitFailureClass;
    now: number;
    backoffMs?: number;
    providerEvidence?: string;
}

export interface ResolveUnknownOutcomeInput {
    now: number;
    attemptId: string;
    fence: number;
    providerEvidence: string;
    decision: UnknownOutcomeDecision;
    advancedFence: number;
    attemptEvidence: RecordUnitFenceAdvanceEvidence;
}

export interface RecordUnitUnknownResolutionMigrationInput {
    now: number;
    attempt: Pick<RecordUnitAttempt, "attemptId" | "fence">;
    providerEvidence: string;
    decision: UnknownOutcomeDecision;
    advancedFence: number;
    outcome: RecordUnitFenceAdvanceEvidence["outcome"];
    evidenceHash: string;
}

export interface RecordUnitCompositionItem {
    unitId: string;
    range: RecordUnitRange;
    composeOrder: number;
    childOrder: number;
    result: RecordUnitResult;
}

export interface RecordUnitComposition {
    sourceSnapshotId: string;
    items: RecordUnitCompositionItem[];
    outputHash: string;
}

export class RecordUnitEngineError extends Error {
    readonly code: string;

    constructor(code: string, message: string) {
        super(message);
        this.name = "RecordUnitEngineError";
        this.code = code;
    }
}

const DEFAULT_AUTO_POLICY: RecordUnitAutoPolicy = {
    order: [...RECORD_UNIT_PROVIDERS],
    overflow: { enabled: true, from: "grok", to: "agy" },
};

export function canonicalRecordUnitJson(value: unknown): string {
    return canonicalValue(value);
}

export function canonicalRecordUnitHash(value: unknown): string {
    return `sha256:${createHash("sha256").update(canonicalRecordUnitJson(value), "utf8").digest("hex")}`;
}

export function classifyRecordUnitFailure(signal: RecordUnitFailureSignal): RecordUnitFailureClass {
    if (signal === "rate-limit" || signal === "resource-exhausted" || signal === "network-timeout") return "Congestion";
    if (signal === "network-error" || signal === "provider-unavailable") return "Availability";
    if (signal === "quality-rejected") return "Quality";
    if (signal === "complexity-exceeded") return "Complexity";
    if (signal === "local-resource") return "LocalResource";
    if (signal === "unknown-outcome") return "UnknownOutcome";
    return "DeterministicInput";
}

export function parseRecordUnitPlanningInput(value: unknown): RecordUnitPlanningInput {
    const input = asPlainObject(value, "Record Unit 规划输入");
    const legacyKeys = ["schemaVersion", "kind", "taskId", "recordId", "sourceSnapshotId", "route", "budgets", "maxUnits", "units"];
    const policyKeys = [...legacyKeys, "autoPolicy"];
    assertOneExactKeySet(input, [legacyKeys, policyKeys], "Record Unit 规划输入");
    const schemaVersion = parseSafeInteger(input.schemaVersion, "schemaVersion", 1);
    if (schemaVersion !== RECORD_UNIT_SCHEMA_VERSION) throw new RecordUnitEngineError("UNSUPPORTED_SCHEMA", "Record Unit schemaVersion 不受支持");
    if (input.kind !== "record-unit-plan-input") throw new RecordUnitEngineError("INVALID_KIND", "Record Unit 规划输入 kind 不受支持");
    const sourceSnapshotId = parseText(input.sourceSnapshotId, "sourceSnapshotId");
    const route = parseRoute(input.route);
    const autoPolicy = parseDeclaredAutoPolicy(input.autoPolicy, route);
    const parsed: RecordUnitPlanningInput = {
        schemaVersion: RECORD_UNIT_SCHEMA_VERSION,
        kind: "record-unit-plan-input",
        taskId: parseText(input.taskId, "taskId"),
        recordId: parseText(input.recordId, "recordId"),
        sourceSnapshotId,
        route,
        autoPolicy,
        budgets: parseBudgets(input.budgets),
        maxUnits: parseSafeInteger(input.maxUnits, "maxUnits", 1),
        units: parseUnits(input.units, sourceSnapshotId),
    };
    if (parsed.maxUnits > RECORD_UNIT_MAX_COUNT) throw new RecordUnitEngineError("UNIT_LIMIT", `maxUnits 不得超过 ${RECORD_UNIT_MAX_COUNT}`);
    if (parsed.units.length > parsed.maxUnits) throw new RecordUnitEngineError("UNIT_LIMIT", "规划 Unit 数超过 maxUnits");
    return parsed;
}

export function createRecordUnitPlan(input: RecordUnitPlanningInput | unknown): RecordUnitPlan {
    const parsed = parseRecordUnitPlanningInput(input);
    assertInputGraph(parsed.units);
    const routePlan = deriveAuthorizedRoutePlan(parsed.route, parsed.autoPolicy ?? null);
    const rawSpecs = parsed.units.map((unit) => rawSpecFromInput(parsed, unit, routePlan));
    const unitSpecs = normalizeSpecs(rawSpecs);
    const unitSpecIndex = buildSpecIndex(unitSpecs);
    const layers = deriveLayers(unitSpecs);
    const planHash = computePlanHash(parsed, unitSpecs, layers);
    const runtimes = unitSpecs.map((spec) => [spec.unitId, initialRuntime(spec)] as const);
    const runtimeRoot = buildRuntimeTree(runtimes);
    const plan = attachUnitsView({
        schemaVersion: RECORD_UNIT_SCHEMA_VERSION,
        kind: "record-unit-plan",
        taskId: parsed.taskId,
        recordId: parsed.recordId,
        sourceSnapshotId: parsed.sourceSnapshotId,
        route: parsed.route,
        autoPolicy: parsed.autoPolicy ?? null,
        budgets: { ...parsed.budgets },
        maxUnits: parsed.maxUnits,
        unitSpecs,
        unitSpecIndex,
        runtimeRoot,
        layers,
        planHash,
        metrics: {
            specHashComputations: unitSpecs.length,
            planHashComputations: 1,
            layerComputations: 1,
            graphValidations: 1,
            runtimeNodeCopies: 0,
        },
    });
    validateRecordUnitPlan(plan);
    return plan;
}

export function hashRecordUnitSpec(spec: Omit<RecordUnitSpec, "specHash"> | RecordUnitSpec): string {
    return canonicalRecordUnitHash(specHashPayload(spec));
}

export function adaptRecordUnitUnknownOutcomeResolution(input: RecordUnitUnknownResolutionMigrationInput): ResolveUnknownOutcomeInput {
    const attemptId = parseText(input.attempt.attemptId, "attempt.attemptId");
    const previousFence = parseSafeInteger(input.attempt.fence, "attempt.fence", 1);
    const advancedFence = parseSafeInteger(input.advancedFence, "advancedFence", 1);
    return {
        now: input.now,
        attemptId,
        fence: previousFence,
        providerEvidence: parseText(input.providerEvidence, "providerEvidence"),
        decision: input.decision,
        advancedFence,
        attemptEvidence: {
            previousAttemptId: attemptId,
            previousFence,
            advancedFence,
            outcome: input.outcome,
            evidenceHash: parseCanonicalHash(input.evidenceHash, "evidenceHash"),
        },
    };
}

export function validateRecordUnitPlan(plan: RecordUnitPlan): void {
    if (plan.schemaVersion !== RECORD_UNIT_SCHEMA_VERSION || plan.kind !== "record-unit-plan") {
        throw new RecordUnitEngineError("INVALID_PLAN", "Record Unit Plan schema 不受支持");
    }
    if (plan.maxUnits < 1 || plan.maxUnits > RECORD_UNIT_MAX_COUNT || plan.unitSpecs.length > plan.maxUnits) {
        throw new RecordUnitEngineError("UNIT_LIMIT", "Record Unit Plan Unit 数超出上限");
    }
    assertDeclaredRoutePolicy(plan.route, plan.autoPolicy);
    const authorizedRoutePlan = deriveAuthorizedRoutePlan(plan.route, plan.autoPolicy);
    const seen = new Set<string>();
    for (let index = 0; index < plan.unitSpecs.length; index++) {
        const spec = plan.unitSpecs[index];
        assertExactKeys(asPlainObject(spec, `Unit spec ${spec.unitId}`), [
            "schemaVersion", "kind", "taskId", "recordId", "unitId", "unitKind", "active",
            "sourceSnapshotId", "inputHash", "provenance", "promptRecipe", "range", "composeOrder",
            "childOrder", "continuationKey", "dependencies", "parentUnitId", "childUnitIds", "splitDepth",
            "stepCount", "estimatedCost", "inheritedCost", "routePlan", "specHash",
        ], `Unit spec ${spec.unitId}`);
        if (seen.has(spec.unitId)) throw new RecordUnitEngineError("DUPLICATE_UNIT", `UnitId 重复：${spec.unitId}`);
        seen.add(spec.unitId);
        if (plan.unitSpecIndex[spec.unitId] !== index) throw new RecordUnitEngineError("SPEC_INDEX_MISMATCH", `Unit ${spec.unitId} 的 spec index 不一致`);
        assertSpecIdentity(plan, spec);
        assertAuthorizedRoutePlan(spec, authorizedRoutePlan);
        if (spec.specHash !== hashRecordUnitSpec(spec)) throw new RecordUnitEngineError("SPEC_HASH_MISMATCH", `Unit ${spec.unitId} specHash 不一致`);
        if (!getRuntime(plan.runtimeRoot, spec.unitId)) throw new RecordUnitEngineError("RUNTIME_MISSING", `Unit ${spec.unitId} 缺少 runtime`);
    }
    const runtimeKeys = collectRuntimeKeys(plan.runtimeRoot);
    if (runtimeKeys.length !== plan.unitSpecs.length || runtimeKeys.some((key) => !seen.has(key))) {
        throw new RecordUnitEngineError("RUNTIME_INDEX_MISMATCH", "runtime tree 与 Unit spec 集合不一致");
    }
    assertSpecGraph(plan.unitSpecs);
    assertPromptRecipes(plan.unitSpecs);
    const expectedLayers = deriveLayers(plan.unitSpecs);
    if (canonicalRecordUnitJson(expectedLayers) !== canonicalRecordUnitJson(plan.layers)) throw new RecordUnitEngineError("LAYER_MISMATCH", "Plan layers 与 spec DAG 不一致");
    const expectedPlanHash = computePlanHash(plan, plan.unitSpecs, plan.layers);
    if (expectedPlanHash !== plan.planHash) throw new RecordUnitEngineError("PLAN_HASH_MISMATCH", "Plan hash 与不可变 spec 不一致");
}

export function getRecordUnit(plan: RecordUnitPlan, unitId: string): RecordUnit {
    const spec = getSpec(plan, unitId);
    const runtime = requireRuntime(plan, unitId);
    return materializeUnit(spec, runtime);
}

export function materializeRecordUnits(plan: RecordUnitPlan): readonly RecordUnit[] {
    return Object.freeze(plan.unitSpecs.map((spec) => materializeUnit(spec, requireRuntime(plan, spec.unitId))));
}

export function getRecordUnitEligibility(plan: RecordUnitPlan, unitId: string, now: number): RecordUnitEligibility {
    assertNow(now);
    const spec = getSpec(plan, unitId);
    const runtime = requireRuntime(plan, unitId);
    if (!spec.active || runtime.state === "succeeded" || runtime.state === "failed_final" || runtime.state === "split") return { eligible: false, reason: "terminal" };
    for (const dependencyId of spec.dependencies) {
        const dependency = requireRuntime(plan, dependencyId);
        if (dependency.state === "failed_final") return { eligible: false, reason: "dependency-failed" };
        if (dependency.state !== "succeeded") return { eligible: false, reason: "dependency" };
    }
    if (runtime.state === "unknown_outcome") {
        return { eligible: false, reason: runtime.unknownOutcome && now < runtime.unknownOutcome.graceUntil ? "unknown-grace" : "needs-fence-advance" };
    }
    if (runtime.nextEligibleAt !== null && now < runtime.nextEligibleAt) return { eligible: false, reason: "backoff" };
    if (runtime.unitAttempts >= plan.budgets.unitAttempts) return { eligible: false, reason: "unit-budget" };
    return { eligible: true, reason: "ready" };
}

export function getRecordUnitLayerCompletion(plan: RecordUnitPlan, layer: number): RecordUnitLayerCompletion {
    const target = plan.layers.find((entry) => entry.layer === layer);
    if (!target) throw new RecordUnitEngineError("UNKNOWN_LAYER", `找不到 Unit layer：${layer}`);
    const states = target.unitIds.map((unitId) => requireRuntime(plan, unitId).state);
    if (states.every((state) => state === "succeeded")) return "succeeded";
    if (states.some((state) => state === "failed_final")) return "failed";
    return "pending";
}

export function startRecordUnit(plan: RecordUnitPlan, unitId: string, options: StartRecordUnitOptions): StartRecordUnitResult {
    assertNow(options.now);
    const spec = getSpec(plan, unitId);
    assertLocalRouteAuthorization(plan, spec);
    let runtime = requireRuntime(plan, unitId);
    const eligibility = getRecordUnitEligibility(plan, unitId, options.now);
    if (!eligibility.eligible) {
        if (eligibility.reason === "needs-fence-advance") {
            const unknown = runtime.unknownOutcome!;
            return {
                plan,
                action: "needs-fence-advance",
                reason: "reconcile-or-persist-new-fence",
                unknownAction: {
                    action: "needs-fence-advance",
                    attemptId: unknown.attemptId,
                    provider: unknown.provider,
                    previousFence: unknown.fence,
                    graceUntil: unknown.graceUntil,
                    remoteExecutionSemantics: RECORD_UNIT_REMOTE_EXECUTION_SEMANTICS,
                },
            };
        }
        if (eligibility.reason === "dependency-failed" || eligibility.reason === "unit-budget") {
            runtime = { ...runtime, state: "failed_final", currentProvider: null, currentAttempt: null, unknownOutcome: null, nextEligibleAt: null };
            return { plan: updateRuntimePlan(plan, unitId, runtime), action: "failed-final", reason: eligibility.reason };
        }
        const state = eligibility.reason === "dependency" ? "blocked_dependency" : eligibility.reason === "backoff" ? "waiting_backoff" : runtime.state;
        return { plan: state === runtime.state ? plan : updateRuntimePlan(plan, unitId, { ...runtime, state }), action: "blocked", reason: eligibility.reason };
    }
    runtime = resolvePromptForDispatch(plan, spec, runtime);
    if (runtime.prompt.status !== "resolved") {
        return { plan: updateRuntimePlan(plan, unitId, { ...runtime, state: "blocked_dependency" }), action: "blocked", reason: "dependency" };
    }
    const selection = selectProvider(plan, spec, runtime, options.availability || {});
    if (selection.kind === "none") {
        const terminal = { ...runtime, state: "failed_final" as const, currentProvider: null, currentAttempt: null, nextEligibleAt: null };
        return { plan: updateRuntimePlan(plan, unitId, terminal), action: "failed-final", reason: selection.reason };
    }
    if (selection.kind === "waiting-capacity") {
        const queued = runtime.state === "queued" ? runtime : { ...runtime, state: "queued" as const };
        return { plan: queued === runtime ? plan : updateRuntimePlan(plan, unitId, queued), action: "waiting-capacity", reason: selection.reason };
    }
    const providerAttemptCounts = {
        ...runtime.providerAttemptCounts,
        [selection.provider]: runtime.providerAttemptCounts[selection.provider] + 1,
    };
    const attemptNumber = runtime.unitAttempts + 1;
    const attempt: RecordUnitAttempt = {
        attemptId: `${spec.unitId}:attempt:${attemptNumber}`,
        provider: selection.provider,
        fence: runtime.fence + 1,
        dispatchedAt: options.now,
        inputHash: runtime.prompt.inputHash,
        provenanceHash: effectiveProvenanceHash(spec, runtime.prompt.promptHash),
    };
    const started: RecordUnitRuntime = {
        ...runtime,
        state: "running",
        routeCursor: selection.routeCursor,
        currentProvider: selection.provider,
        attemptedProviders: runtime.attemptedProviders.includes(selection.provider)
            ? runtime.attemptedProviders
            : [...runtime.attemptedProviders, selection.provider],
        providerAttemptCounts,
        routeAttempts: runtime.routeAttempts + (selection.isRouteTransition ? 1 : 0),
        unitAttempts: attemptNumber,
        nextEligibleAt: null,
        currentAttempt: attempt,
        unknownOutcome: null,
        fence: attempt.fence,
    };
    return { plan: updateRuntimePlan(plan, unitId, started), action: "dispatch", reason: selection.reason, attempt };
}

export function succeedRecordUnit(
    plan: RecordUnitPlan,
    unitId: string,
    input: { attemptId: string; fence: number; model: string; outputHash: string; qualityHash: string },
): RecordUnitPlan {
    const spec = getSpec(plan, unitId);
    const runtime = requireRuntime(plan, unitId);
    const attempt = assertCurrentAttempt(spec, runtime, input.attemptId, input.fence);
    const result: RecordUnitResult = {
        attemptId: attempt.attemptId,
        provider: attempt.provider,
        model: parseText(input.model, "model"),
        fence: attempt.fence,
        inputHash: runtime.prompt.inputHash,
        provenanceHash: effectiveProvenanceHash(spec, runtime.prompt.promptHash),
        outputHash: parseCanonicalHash(input.outputHash, "outputHash"),
        qualityHash: parseCanonicalHash(input.qualityHash, "qualityHash"),
    };
    return updateRuntimePlan(plan, unitId, {
        ...runtime,
        state: "succeeded",
        currentProvider: null,
        currentAttempt: null,
        nextEligibleAt: null,
        result,
    });
}

export function failRecordUnitAttempt(plan: RecordUnitPlan, unitId: string, input: RecordUnitFailureInput): RecordUnitPlan {
    assertNow(input.now);
    const spec = getSpec(plan, unitId);
    const runtime = requireRuntime(plan, unitId);
    const attempt = assertCurrentAttempt(spec, runtime, input.attemptId, input.fence);
    const failureClass = parseFailureClass(input.failureClass);
    const failure: RecordUnitFailure = {
        attemptId: attempt.attemptId,
        provider: attempt.provider,
        fence: attempt.fence,
        failureClass,
        at: input.now,
    };
    const failureHistory = [...runtime.failureHistory, failure];
    if (failureClass === "UnknownOutcome") {
        const providerEvidence = parseText(input.providerEvidence, "providerEvidence");
        const graceUntil = input.now + RECORD_UNIT_UNKNOWN_OUTCOME_GRACE_MS;
        return updateRuntimePlan(plan, unitId, {
            ...runtime,
            state: "unknown_outcome",
            currentProvider: null,
            currentAttempt: null,
            nextEligibleAt: graceUntil,
            unknownOutcome: {
                attemptId: attempt.attemptId,
                provider: attempt.provider,
                fence: attempt.fence,
                dispatchedAt: attempt.dispatchedAt,
                graceUntil,
                providerEvidence,
            },
            failureHistory,
            lastFailureClass: failureClass,
        });
    }
    if (failureClass === "DeterministicInput") {
        return updateRuntimePlan(plan, unitId, {
            ...runtime,
            state: "failed_final",
            currentProvider: null,
            currentAttempt: null,
            nextEligibleAt: null,
            failureHistory,
            lastFailureClass: failureClass,
        });
    }
    const backoffMs = parseBackoff(input.backoffMs);
    const congestionRetry = (failureClass === "Congestion" || failureClass === "LocalResource")
        && runtime.providerAttemptCounts[attempt.provider] < plan.budgets.providerAttempts
        && runtime.unitAttempts < plan.budgets.unitAttempts;
    const nextEligibleAt = failureClass === "Congestion" || failureClass === "LocalResource" ? input.now + backoffMs : input.now;
    const exhausted = runtime.unitAttempts >= plan.budgets.unitAttempts;
    return updateRuntimePlan(plan, unitId, {
        ...runtime,
        state: exhausted ? "failed_final" : nextEligibleAt > input.now ? "waiting_backoff" : "queued",
        currentProvider: congestionRetry && !exhausted ? attempt.provider : null,
        currentAttempt: null,
        nextEligibleAt: exhausted ? null : nextEligibleAt,
        failureHistory,
        lastFailureClass: failureClass,
    });
}

export function resolveRecordUnitUnknownOutcome(plan: RecordUnitPlan, unitId: string, input: ResolveUnknownOutcomeInput): RecordUnitPlan {
    assertNow(input.now);
    const runtime = requireRuntime(plan, unitId);
    const unknown = runtime.unknownOutcome;
    if (runtime.state !== "unknown_outcome" || !unknown) throw new RecordUnitEngineError("NOT_UNKNOWN_OUTCOME", `Unit ${unitId} 不在 unknown_outcome 状态`);
    if (input.now < unknown.graceUntil) throw new RecordUnitEngineError("UNKNOWN_GRACE_ACTIVE", `Unit ${unitId} 仍在 unknown_outcome 宽限期`);
    if (input.attemptId !== unknown.attemptId || input.fence !== unknown.fence) {
        throw new RecordUnitEngineError("UNKNOWN_EVIDENCE_MISMATCH", `Unit ${unitId} 的 attempt 或 fence 证据不匹配`);
    }
    const providerEvidence = parseText(input.providerEvidence, "providerEvidence");
    if (providerEvidence !== unknown.providerEvidence) throw new RecordUnitEngineError("UNKNOWN_EVIDENCE_MISMATCH", `Unit ${unitId} 的 provider 证据不匹配`);
    const evidence = parseFenceAdvanceEvidence(input.attemptEvidence);
    if (evidence.previousAttemptId !== unknown.attemptId || evidence.previousFence !== unknown.fence || evidence.advancedFence !== input.advancedFence) {
        throw new RecordUnitEngineError("UNKNOWN_EVIDENCE_MISMATCH", `Unit ${unitId} 的 fence advance evidence 不匹配`);
    }
    if (input.advancedFence <= unknown.fence || input.advancedFence <= runtime.fence) {
        throw new RecordUnitEngineError("FENCE_NOT_ADVANCED", `Unit ${unitId} 必须持久化严格递增的新 fence`);
    }
    if (input.decision === "fail_final") {
        return updateRuntimePlan(plan, unitId, {
            ...runtime,
            state: "failed_final",
            currentProvider: null,
            unknownOutcome: null,
            nextEligibleAt: null,
            fenceAdvanceEvidence: evidence,
            fence: input.advancedFence - 1,
        });
    }
    const canRetryProvider = runtime.providerAttemptCounts[unknown.provider] < plan.budgets.providerAttempts
        && runtime.unitAttempts < plan.budgets.unitAttempts;
    const currentProvider = input.decision === "retry_same_provider" && canRetryProvider ? unknown.provider : null;
    return updateRuntimePlan(plan, unitId, {
        ...runtime,
        state: "queued",
        currentProvider,
        unknownOutcome: null,
        nextEligibleAt: input.now,
        fenceAdvanceEvidence: evidence,
        fence: input.advancedFence - 1,
    });
}

export function splitRecordUnit(plan: RecordUnitPlan, unitId: string, splitAt?: number): RecordUnitPlan {
    const parentSpec = getSpec(plan, unitId);
    assertLocalRouteAuthorization(plan, parentSpec);
    const parentRuntime = requireRuntime(plan, unitId);
    if (parentRuntime.lastFailureClass !== "Quality" && parentRuntime.lastFailureClass !== "Complexity") {
        throw new RecordUnitEngineError("SPLIT_NOT_ALLOWED", `Unit ${unitId} 仅可在 Quality 或 Complexity 失败后拆分`);
    }
    if (parentSpec.splitDepth >= 1) throw new RecordUnitEngineError("SPLIT_DEPTH", `Unit ${unitId} 已达到最大 splitDepth`);
    if (!parentSpec.active || parentRuntime.state === "running" || parentRuntime.state === "unknown_outcome" || parentRuntime.state === "succeeded" || parentRuntime.state === "failed_final") {
        throw new RecordUnitEngineError("SPLIT_STATE", `Unit ${unitId} 当前状态不可拆分`);
    }
    if (parentSpec.range.axis !== "step" || parentSpec.range.end - parentSpec.range.start < 1) {
        throw new RecordUnitEngineError("SPLIT_MIN_STEP", `Unit ${unitId} 无法拆成两个至少一个 step 的子 Unit`);
    }
    if (plan.unitSpecs.length + 2 > plan.maxUnits) throw new RecordUnitEngineError("UNIT_LIMIT", "拆分会超过 maxUnits");
    const point = splitAt ?? Math.floor((parentSpec.range.start + parentSpec.range.end) / 2);
    if (!Number.isSafeInteger(point) || point < parentSpec.range.start || point >= parentSpec.range.end) {
        throw new RecordUnitEngineError("SPLIT_MIN_STEP", `Unit ${unitId} 的 splitAt 必须让两边各至少保留一个 step`);
    }
    const firstId = `${parentSpec.unitId}.split-1`;
    const secondId = `${parentSpec.unitId}.split-2`;
    if (plan.unitSpecIndex[firstId] !== undefined || plan.unitSpecIndex[secondId] !== undefined) {
        throw new RecordUnitEngineError("DUPLICATE_UNIT", `Unit ${unitId} 的拆分子 ID 已存在`);
    }
    const firstRange: RecordUnitRange = { axis: "step", start: parentSpec.range.start, end: point };
    const secondRange: RecordUnitRange = { axis: "step", start: point + 1, end: parentSpec.range.end };
    const firstDependencies = [...parentSpec.dependencies];
    const secondDependencies = parentSpec.continuationKey ? uniqueStrings([...parentSpec.dependencies, firstId]) : [...parentSpec.dependencies];
    const parentWithoutHash: Omit<RecordUnitSpec, "specHash"> = {
        ...parentSpec,
        active: false,
        childUnitIds: [firstId, secondId],
    };
    const first = rawSplitChild(parentSpec, firstId, 0, firstRange, firstDependencies);
    const second = rawSplitChild(parentSpec, secondId, 1, secondRange, secondDependencies);
    const rawSpecs = plan.unitSpecs.map((spec) => {
        if (spec.unitId === parentSpec.unitId) return { ...parentWithoutHash, specHash: "" };
        if (!spec.dependencies.includes(parentSpec.unitId)) return spec;
        const dependencies = uniqueStrings(spec.dependencies.flatMap((dependency) => dependency === parentSpec.unitId ? [firstId, secondId] : [dependency]));
        return { ...spec, dependencies, specHash: "" };
    });
    rawSpecs.push(first, second);
    const unitSpecs = normalizeSpecs(rawSpecs);
    const runtimeOverrides = new Map<string, RecordUnitRuntime>();
    runtimeOverrides.set(parentSpec.unitId, {
        ...parentRuntime,
        state: "split",
        currentProvider: null,
        currentAttempt: null,
        unknownOutcome: null,
        nextEligibleAt: null,
    });
    runtimeOverrides.set(firstId, inheritedChildRuntime(first, parentRuntime));
    runtimeOverrides.set(secondId, inheritedChildRuntime(second, parentRuntime));
    for (const spec of unitSpecs) {
        if (runtimeOverrides.has(spec.unitId)) continue;
        const previousSpec = plan.unitSpecIndex[spec.unitId] === undefined ? null : plan.unitSpecs[plan.unitSpecIndex[spec.unitId]];
        const previousRuntime = previousSpec ? requireRuntime(plan, spec.unitId) : null;
        if (!previousRuntime) {
            runtimeOverrides.set(spec.unitId, initialRuntime(spec));
        } else if (previousSpec!.specHash !== spec.specHash) {
            runtimeOverrides.set(spec.unitId, { ...previousRuntime, state: "blocked_dependency", prompt: initialPromptResolution(spec) });
        } else {
            runtimeOverrides.set(spec.unitId, previousRuntime);
        }
    }
    return rebuildSpecPlan(plan, unitSpecs, runtimeOverrides);
}

export function composeRecordUnitResults(plan: RecordUnitPlan, unitIds: readonly string[]): RecordUnitComposition {
    if (unitIds.length === 0) throw new RecordUnitEngineError("EMPTY_COMPOSE", "组合至少需要一个 Unit 结果");
    const requested = uniqueStrings([...unitIds]);
    if (requested.length !== unitIds.length) throw new RecordUnitEngineError("DUPLICATE_COMPOSE_INPUT", "组合输入不能重复 Unit");
    const expected = new Set(requested);
    for (const unitId of requested) {
        const spec = getSpec(plan, unitId);
        if (!spec.active) throw new RecordUnitEngineError("COMPOSE_CLOSURE", `Unit ${unitId} 已被拆分，必须组合完整叶子后代`);
        const root = splitRoot(plan, spec);
        if (root) for (const leafId of collectActiveLeafIds(plan, root)) expected.add(leafId);
        if (spec.unitKind === "compose-window" && spec.continuationKey) {
            for (const candidate of plan.unitSpecs) {
                if (candidate.active && candidate.unitKind === "compose-window" && candidate.continuationKey === spec.continuationKey) expected.add(candidate.unitId);
            }
        }
    }
    if (expected.size !== requested.length || requested.some((unitId) => !expected.has(unitId))) {
        throw new RecordUnitEngineError("COMPOSE_CLOSURE", "组合输入没有覆盖完整 compose window 或 split family 闭包");
    }
    const items = requested.map((unitId) => {
        const spec = getSpec(plan, unitId);
        const runtime = requireRuntime(plan, unitId);
        if (runtime.state !== "succeeded" || !runtime.result) throw new RecordUnitEngineError("COMPOSE_INCOMPLETE", `Unit ${unitId} 尚未成功完成`);
        for (const dependencyId of spec.dependencies) {
            if (requireRuntime(plan, dependencyId).state !== "succeeded") throw new RecordUnitEngineError("COMPOSE_DEPENDENCY", `Unit ${unitId} 的依赖 ${dependencyId} 尚未完成`);
        }
        if (runtime.result.inputHash !== runtime.prompt.inputHash || runtime.result.provenanceHash !== effectiveProvenanceHash(spec, runtime.prompt.promptHash)) {
            throw new RecordUnitEngineError("COMPOSE_PROVENANCE", `Unit ${unitId} 的 inputHash 或 provenance 不一致`);
        }
        if (spec.sourceSnapshotId !== plan.sourceSnapshotId || spec.provenance.sourceSnapshotId !== plan.sourceSnapshotId) {
            throw new RecordUnitEngineError("COMPOSE_PROVENANCE", `Unit ${unitId} 的 sourceSnapshotId 不一致`);
        }
        return {
            unitId,
            range: { ...spec.range },
            composeOrder: spec.composeOrder,
            childOrder: spec.childOrder,
            result: { ...runtime.result },
        };
    }).sort(compareCompositionItems);
    return {
        sourceSnapshotId: plan.sourceSnapshotId,
        items,
        outputHash: canonicalRecordUnitHash({ sourceSnapshotId: plan.sourceSnapshotId, items }),
    };
}

function rawSpecFromInput(plan: RecordUnitPlanningInput, input: RecordUnitSpecInput, routePlan: readonly RecordUnitProvider[]): RecordUnitSpec {
    return {
        schemaVersion: RECORD_UNIT_SCHEMA_VERSION,
        kind: "record-unit-spec",
        taskId: plan.taskId,
        recordId: plan.recordId,
        unitId: input.unitId,
        unitKind: input.unitKind,
        active: true,
        sourceSnapshotId: plan.sourceSnapshotId,
        inputHash: input.inputHash,
        provenance: { ...input.provenance },
        promptRecipe: input.promptRecipe || emptyPromptRecipe(input.unitKind, input.range),
        range: { ...input.range },
        composeOrder: input.composeOrder,
        childOrder: 0,
        continuationKey: input.continuationKey,
        dependencies: [...input.dependencies],
        parentUnitId: null,
        childUnitIds: [],
        splitDepth: 0,
        stepCount: input.stepCount,
        estimatedCost: input.estimatedCost,
        inheritedCost: input.estimatedCost,
        routePlan: [...routePlan],
        specHash: "",
    };
}

function rawSplitChild(parent: RecordUnitSpec, unitId: string, childOrder: number, range: RecordUnitRange, dependencies: string[]): RecordUnitSpec {
    const stepCount = range.end - range.start + 1;
    const ratio = stepCount / parent.stepCount;
    return {
        ...parent,
        unitId,
        active: true,
        range,
        composeOrder: parent.composeOrder,
        childOrder,
        dependencies,
        parentUnitId: parent.unitId,
        childUnitIds: [],
        splitDepth: parent.splitDepth + 1,
        stepCount,
        estimatedCost: Math.max(0.000001, roundCost(parent.estimatedCost * ratio)),
        promptRecipe: emptyPromptRecipe(parent.promptRecipe.templateId, range),
        inputHash: "",
        provenance: { ...parent.provenance, promptHash: "" },
        routePlan: [...parent.routePlan],
        specHash: "",
    };
}

function normalizeSpecs(rawSpecs: readonly RecordUnitSpec[]): RecordUnitSpec[] {
    const active = rawSpecs.filter((spec) => spec.active);
    const predecessors = continuationPredecessors(active);
    const normalized = rawSpecs.map((raw) => {
        const predecessor = raw.active ? predecessors.get(raw.unitId) || null : null;
        const templateId = raw.promptRecipe.templateId || `record-${raw.unitKind}-v1`;
        const promptRecipe = buildPromptRecipe(raw, predecessor, templateId);
        const promptHash = unresolvedPromptHash(promptRecipe);
        const provenance = { ...raw.provenance, promptHash };
        const inputHash = unresolvedInputHash(raw.sourceSnapshotId, provenance.sourceContentHash, raw.range, promptHash, promptRecipe);
        const withoutHash: Omit<RecordUnitSpec, "specHash"> = {
            ...raw,
            inputHash,
            provenance,
            promptRecipe,
        };
        return { ...withoutHash, specHash: hashRecordUnitSpec(withoutHash) };
    });
    assertSpecGraph(normalized);
    assertPromptRecipes(normalized);
    return normalized;
}

function buildPromptRecipe(spec: Pick<RecordUnitSpec, "unitId" | "range" | "dependencies" | "continuationKey">, predecessor: string | null, templateId: string): RecordUnitPromptRecipe {
    return {
        recipeVersion: 1,
        templateId,
        range: { ...spec.range },
        dependencyBindings: spec.dependencies.map((unitId) => ({ unitId, placeholder: dependencyPlaceholder(unitId) })),
        continuationBinding: spec.continuationKey && predecessor
            ? {
                continuationKey: spec.continuationKey,
                previousUnitId: predecessor,
                placeholder: continuationPlaceholder(spec.continuationKey, predecessor),
            }
            : null,
    };
}

function initialRuntime(spec: RecordUnitSpec): RecordUnitRuntime {
    return {
        state: spec.active ? (spec.dependencies.length > 0 ? "blocked_dependency" : "queued") : "split",
        routeCursor: -1,
        currentProvider: null,
        attemptedProviders: [],
        providerAttemptCounts: emptyProviderCounts(),
        routeAttempts: 0,
        unitAttempts: 0,
        nextEligibleAt: null,
        currentAttempt: null,
        unknownOutcome: null,
        fenceAdvanceEvidence: null,
        fence: 0,
        result: null,
        failureHistory: [],
        lastFailureClass: null,
        prompt: initialPromptResolution(spec),
    };
}

function inheritedChildRuntime(spec: RecordUnitSpec, parent: RecordUnitRuntime): RecordUnitRuntime {
    return {
        ...initialRuntime(spec),
        routeCursor: parent.routeCursor,
        attemptedProviders: [...parent.attemptedProviders],
        providerAttemptCounts: { ...parent.providerAttemptCounts },
        routeAttempts: parent.routeAttempts,
        unitAttempts: parent.unitAttempts,
        nextEligibleAt: parent.nextEligibleAt,
        fence: parent.fence,
        failureHistory: [...parent.failureHistory],
        lastFailureClass: parent.lastFailureClass,
    };
}

function initialPromptResolution(spec: RecordUnitSpec): RecordUnitPromptResolution {
    return {
        status: spec.dependencies.length === 0 ? "resolved" : "waiting_dependencies",
        inputHash: spec.inputHash,
        promptHash: spec.provenance.promptHash,
        dependencyOutputs: [],
    };
}

function resolvePromptForDispatch(plan: RecordUnitPlan, spec: RecordUnitSpec, runtime: RecordUnitRuntime): RecordUnitRuntime {
    if (spec.dependencies.length === 0 || runtime.prompt.status === "resolved") return runtime;
    const dependencyOutputs: Array<{ unitId: string; outputHash: string }> = [];
    for (const binding of spec.promptRecipe.dependencyBindings) {
        const dependency = requireRuntime(plan, binding.unitId);
        if (dependency.state !== "succeeded" || !dependency.result) return runtime;
        dependencyOutputs.push({ unitId: binding.unitId, outputHash: dependency.result.outputHash });
    }
    const promptHash = canonicalRecordUnitHash({ recipe: spec.promptRecipe, dependencyOutputs });
    const inputHash = canonicalRecordUnitHash({
        sourceSnapshotId: spec.sourceSnapshotId,
        sourceContentHash: spec.provenance.sourceContentHash,
        range: spec.range,
        promptHash,
        dependencyOutputs,
    });
    return { ...runtime, state: "queued", prompt: { status: "resolved", inputHash, promptHash, dependencyOutputs } };
}

function updateRuntimePlan(plan: RecordUnitPlan, unitId: string, runtime: RecordUnitRuntime): RecordUnitPlan {
    const updated = updateRuntimeNode(plan.runtimeRoot, unitId, runtime);
    return attachUnitsView({
        schemaVersion: plan.schemaVersion,
        kind: plan.kind,
        taskId: plan.taskId,
        recordId: plan.recordId,
        sourceSnapshotId: plan.sourceSnapshotId,
        route: plan.route,
        autoPolicy: plan.autoPolicy,
        budgets: plan.budgets,
        maxUnits: plan.maxUnits,
        unitSpecs: plan.unitSpecs,
        unitSpecIndex: plan.unitSpecIndex,
        runtimeRoot: updated.root,
        layers: plan.layers,
        planHash: plan.planHash,
        metrics: { ...plan.metrics, runtimeNodeCopies: plan.metrics.runtimeNodeCopies + updated.copies },
    });
}

function rebuildSpecPlan(plan: RecordUnitPlan, unitSpecs: readonly RecordUnitSpec[], runtimes: ReadonlyMap<string, RecordUnitRuntime>): RecordUnitPlan {
    const unitSpecIndex = buildSpecIndex(unitSpecs);
    const layers = deriveLayers(unitSpecs);
    const planHash = computePlanHash(plan, unitSpecs, layers);
    const runtimeRoot = buildRuntimeTree(unitSpecs.map((spec) => [spec.unitId, runtimes.get(spec.unitId) || initialRuntime(spec)] as const));
    const rebuilt = attachUnitsView({
        schemaVersion: plan.schemaVersion,
        kind: plan.kind,
        taskId: plan.taskId,
        recordId: plan.recordId,
        sourceSnapshotId: plan.sourceSnapshotId,
        route: plan.route,
        autoPolicy: plan.autoPolicy,
        budgets: plan.budgets,
        maxUnits: plan.maxUnits,
        unitSpecs,
        unitSpecIndex,
        runtimeRoot,
        layers,
        planHash,
        metrics: {
            ...plan.metrics,
            specHashComputations: plan.metrics.specHashComputations + unitSpecs.length,
            planHashComputations: plan.metrics.planHashComputations + 1,
            layerComputations: plan.metrics.layerComputations + 1,
            graphValidations: plan.metrics.graphValidations + 1,
        },
    });
    validateRecordUnitPlan(rebuilt);
    return rebuilt;
}

type PlanCore = Omit<RecordUnitPlan, "units">;

function attachUnitsView(core: PlanCore): RecordUnitPlan {
    let cache: readonly RecordUnit[] | null = null;
    const plan = core as RecordUnitPlan;
    Object.defineProperty(plan, "units", {
        enumerable: true,
        configurable: false,
        get: () => {
            if (!cache) cache = materializeRecordUnits(plan);
            return cache;
        },
    });
    return plan;
}

function materializeUnit(spec: RecordUnitSpec, runtime: RecordUnitRuntime): RecordUnit {
    return {
        ...spec,
        ...runtime,
        inputHash: runtime.prompt.inputHash,
        provenance: { ...spec.provenance, promptHash: runtime.prompt.promptHash },
    };
}

function buildRuntimeTree(entries: readonly (readonly [string, RecordUnitRuntime])[]): RecordUnitRuntimeNode | null {
    const sorted = [...entries].sort((left, right) => left[0].localeCompare(right[0]));
    const build = (start: number, end: number): RecordUnitRuntimeNode | null => {
        if (start >= end) return null;
        const middle = Math.floor((start + end) / 2);
        const entry = sorted[middle];
        return { key: entry[0], value: entry[1], left: build(start, middle), right: build(middle + 1, end) };
    };
    return build(0, sorted.length);
}

function updateRuntimeNode(root: RecordUnitRuntimeNode | null, key: string, value: RecordUnitRuntime): { root: RecordUnitRuntimeNode; copies: number } {
    if (!root) throw new RecordUnitEngineError("UNKNOWN_UNIT", `找不到 Unit runtime：${key}`);
    if (key === root.key) return { root: { ...root, value }, copies: 1 };
    if (key.localeCompare(root.key) < 0) {
        const updated = updateRuntimeNode(root.left, key, value);
        return { root: { ...root, left: updated.root }, copies: updated.copies + 1 };
    }
    const updated = updateRuntimeNode(root.right, key, value);
    return { root: { ...root, right: updated.root }, copies: updated.copies + 1 };
}

function getRuntime(root: RecordUnitRuntimeNode | null, key: string): RecordUnitRuntime | null {
    let current = root;
    while (current) {
        if (key === current.key) return current.value;
        current = key.localeCompare(current.key) < 0 ? current.left : current.right;
    }
    return null;
}

function collectRuntimeKeys(root: RecordUnitRuntimeNode | null): string[] {
    const keys: string[] = [];
    const stack: RecordUnitRuntimeNode[] = [];
    let current = root;
    while (current || stack.length > 0) {
        while (current) {
            stack.push(current);
            current = current.left;
        }
        current = stack.pop()!;
        keys.push(current.key);
        current = current.right;
    }
    return keys;
}

function buildSpecIndex(specs: readonly RecordUnitSpec[]): Readonly<Record<string, number>> {
    const index: Record<string, number> = Object.create(null) as Record<string, number>;
    specs.forEach((spec, position) => {
        if (index[spec.unitId] !== undefined) throw new RecordUnitEngineError("DUPLICATE_UNIT", `UnitId 重复：${spec.unitId}`);
        index[spec.unitId] = position;
    });
    return Object.freeze(index);
}

function getSpec(plan: RecordUnitPlan, unitId: string): RecordUnitSpec {
    const index = plan.unitSpecIndex[unitId];
    if (index === undefined) throw new RecordUnitEngineError("UNKNOWN_UNIT", `找不到 Unit：${unitId}`);
    return plan.unitSpecs[index];
}

function requireRuntime(plan: RecordUnitPlan, unitId: string): RecordUnitRuntime {
    const runtime = getRuntime(plan.runtimeRoot, unitId);
    if (!runtime) throw new RecordUnitEngineError("UNKNOWN_UNIT", `找不到 Unit runtime：${unitId}`);
    return runtime;
}

function assertInputGraph(inputs: readonly RecordUnitSpecInput[]): void {
    const ids = new Set(inputs.map((input) => input.unitId));
    if (ids.size !== inputs.length) throw new RecordUnitEngineError("DUPLICATE_UNIT", "UnitId 不能重复");
    for (const input of inputs) {
        for (const dependency of input.dependencies) {
            if (!ids.has(dependency)) throw new RecordUnitEngineError("INVALID_DEPENDENCY", `Unit ${input.unitId} 依赖不存在：${dependency}`);
            if (dependency === input.unitId) throw new RecordUnitEngineError("SELF_DEPENDENCY", `Unit ${input.unitId} 不能依赖自身`);
        }
    }
    assertAcyclic(inputs.map((input) => ({ unitId: input.unitId, dependencies: input.dependencies })));
    continuationPredecessors(inputs.map((input) => ({
        unitId: input.unitId,
        composeOrder: input.composeOrder,
        childOrder: 0,
        range: input.range,
        continuationKey: input.continuationKey,
        dependencies: input.dependencies,
    })));
}

function assertSpecGraph(specs: readonly RecordUnitSpec[]): void {
    const active = specs.filter((spec) => spec.active);
    const ids = new Set(active.map((spec) => spec.unitId));
    for (const spec of active) {
        for (const dependency of spec.dependencies) {
            if (!ids.has(dependency)) throw new RecordUnitEngineError("INVALID_DEPENDENCY", `Unit ${spec.unitId} 依赖不存在或已停用：${dependency}`);
        }
    }
    assertAcyclic(active);
    continuationPredecessors(active);
}

function assertAcyclic(units: ReadonlyArray<{ unitId: string; dependencies: readonly string[] }>): void {
    const pending = new Map(units.map((unit) => [unit.unitId, unit.dependencies.length]));
    const followers = new Map<string, string[]>();
    for (const unit of units) {
        for (const dependency of unit.dependencies) {
            const entries = followers.get(dependency) || [];
            entries.push(unit.unitId);
            followers.set(dependency, entries);
        }
    }
    const ready = units.filter((unit) => pending.get(unit.unitId) === 0).map((unit) => unit.unitId);
    let processed = 0;
    while (ready.length > 0) {
        const unitId = ready.pop()!;
        processed++;
        for (const followerId of followers.get(unitId) || []) {
            const remaining = (pending.get(followerId) || 0) - 1;
            pending.set(followerId, remaining);
            if (remaining === 0) ready.push(followerId);
        }
    }
    if (processed !== units.length) throw new RecordUnitEngineError("DEPENDENCY_CYCLE", "Record Unit 依赖图存在环");
}

function continuationPredecessors<T extends { unitId: string; composeOrder: number; childOrder: number; range: RecordUnitRange; continuationKey: string | null; dependencies: readonly string[] }>(units: readonly T[]): Map<string, string> {
    const groups = new Map<string, T[]>();
    for (const unit of units) {
        if (!unit.continuationKey) continue;
        const group = groups.get(unit.continuationKey) || [];
        group.push(unit);
        groups.set(unit.continuationKey, group);
    }
    const predecessors = new Map<string, string>();
    for (const [continuationKey, group] of groups) {
        const ordered = [...group].sort(compareUnitIdentity);
        for (let index = 1; index < ordered.length; index++) {
            const previous = ordered[index - 1];
            const current = ordered[index];
            if (!current.dependencies.includes(previous.unitId)) {
                throw new RecordUnitEngineError("CONTINUATION_PARALLEL", `continuationKey ${continuationKey} 的 Unit ${current.unitId} 未依赖前序 Unit ${previous.unitId}`);
            }
            predecessors.set(current.unitId, previous.unitId);
        }
    }
    return predecessors;
}

function assertPromptRecipes(specs: readonly RecordUnitSpec[]): void {
    const active = specs.filter((spec) => spec.active);
    const predecessors = continuationPredecessors(active);
    for (const spec of active) {
        const expected = buildPromptRecipe(spec, predecessors.get(spec.unitId) || null, spec.promptRecipe.templateId);
        if (canonicalRecordUnitJson(expected) !== canonicalRecordUnitJson(spec.promptRecipe)) {
            throw new RecordUnitEngineError("PROMPT_RECIPE_MISMATCH", `Unit ${spec.unitId} 的 promptRecipe 未绑定真实 range/dependencies/continuation`);
        }
    }
}

function deriveLayers(specs: readonly RecordUnitSpec[]): RecordUnitLayer[] {
    const active = specs.filter((spec) => spec.active);
    const byId = new Map(active.map((spec) => [spec.unitId, spec]));
    const pending = new Map(active.map((spec) => [spec.unitId, spec.dependencies.length]));
    const followers = new Map<string, string[]>();
    for (const spec of active) {
        for (const dependency of spec.dependencies) {
            const entries = followers.get(dependency) || [];
            entries.push(spec.unitId);
            followers.set(dependency, entries);
        }
    }
    let ready = active.filter((spec) => pending.get(spec.unitId) === 0).sort(compareUnitIdentity);
    const layers: RecordUnitLayer[] = [];
    let layer = 0;
    let processed = 0;
    while (ready.length > 0) {
        const current = ready;
        ready = [];
        layers.push({ layer, unitIds: current.map((spec) => spec.unitId), completion: "all-succeeded" });
        for (const spec of current) {
            processed++;
            for (const followerId of followers.get(spec.unitId) || []) {
                const remaining = (pending.get(followerId) || 0) - 1;
                pending.set(followerId, remaining);
                if (remaining === 0) ready.push(byId.get(followerId)!);
            }
        }
        ready.sort(compareUnitIdentity);
        layer++;
    }
    if (processed !== active.length) throw new RecordUnitEngineError("DEPENDENCY_CYCLE", "Record Unit 依赖图存在环");
    return layers;
}

function selectProvider(
    plan: RecordUnitPlan,
    spec: RecordUnitSpec,
    runtime: RecordUnitRuntime,
    availability: Partial<Record<RecordUnitProvider, RecordUnitAvailability>>,
): { kind: "selected"; provider: RecordUnitProvider; routeCursor: number; isRouteTransition: boolean; reason: string } | { kind: "waiting-capacity"; reason: string } | { kind: "none"; reason: string } {
    if (runtime.currentProvider) {
        const state = availability[runtime.currentProvider] || "available";
        if (state === "available" && runtime.providerAttemptCounts[runtime.currentProvider] < plan.budgets.providerAttempts) {
            return { kind: "selected", provider: runtime.currentProvider, routeCursor: runtime.routeCursor, isRouteTransition: false, reason: "retry-current-provider" };
        }
        if (state === "capacity-full") return { kind: "waiting-capacity", reason: `provider-capacity-full:${runtime.currentProvider}` };
    }
    if (runtime.routeAttempts >= plan.budgets.routeAttempts) return { kind: "none", reason: "route-budget" };
    for (let index = runtime.routeCursor + 1; index < spec.routePlan.length; index++) {
        const provider = spec.routePlan[index];
        if (runtime.attemptedProviders.includes(provider)) continue;
        const state = availability[provider] || "available";
        if (state === "unavailable") continue;
        if (state === "capacity-full") {
            const overflow = plan.route === "auto" && plan.autoPolicy?.overflow.enabled && provider === plan.autoPolicy.overflow.from;
            if (overflow) {
                const overflowIndex = spec.routePlan.indexOf(plan.autoPolicy!.overflow.to);
                const overflowProvider = plan.autoPolicy!.overflow.to;
                const overflowState = availability[overflowProvider] || "available";
                if (overflowIndex > index && !runtime.attemptedProviders.includes(overflowProvider) && overflowState === "available") {
                    return { kind: "selected", provider: overflowProvider, routeCursor: overflowIndex, isRouteTransition: true, reason: "agy-first-run-overflow" };
                }
            }
            return { kind: "waiting-capacity", reason: `provider-capacity-full:${provider}` };
        }
        return { kind: "selected", provider, routeCursor: index, isRouteTransition: true, reason: "next-route-provider" };
    }
    return { kind: "none", reason: "route-exhausted" };
}

function assertCurrentAttempt(spec: RecordUnitSpec, runtime: RecordUnitRuntime, attemptId: string, fence: number): RecordUnitAttempt {
    if (runtime.state !== "running" || !runtime.currentAttempt) throw new RecordUnitEngineError("NO_RUNNING_ATTEMPT", `Unit ${spec.unitId} 没有运行中的 Attempt`);
    if (runtime.currentAttempt.attemptId !== attemptId || runtime.currentAttempt.fence !== fence) {
        throw new RecordUnitEngineError("FENCE_MISMATCH", `Unit ${spec.unitId} 的 Attempt 或 fence 不匹配`);
    }
    return runtime.currentAttempt;
}

function splitRoot(plan: RecordUnitPlan, spec: RecordUnitSpec): RecordUnitSpec | null {
    if (!spec.parentUnitId) return spec.childUnitIds.length > 0 ? spec : null;
    let current = getSpec(plan, spec.parentUnitId);
    while (current.parentUnitId) current = getSpec(plan, current.parentUnitId);
    return current;
}

function collectActiveLeafIds(plan: RecordUnitPlan, root: RecordUnitSpec): string[] {
    if (root.childUnitIds.length === 0) return root.active ? [root.unitId] : [];
    return root.childUnitIds.flatMap((unitId) => collectActiveLeafIds(plan, getSpec(plan, unitId)));
}

function computePlanHash(
    plan: Pick<RecordUnitPlanningInput, "schemaVersion" | "taskId" | "recordId" | "sourceSnapshotId" | "route" | "autoPolicy" | "budgets" | "maxUnits"> | RecordUnitPlan,
    specs: readonly RecordUnitSpec[],
    layers: readonly RecordUnitLayer[],
): string {
    return canonicalRecordUnitHash({
        schemaVersion: plan.schemaVersion,
        kind: "record-unit-plan",
        taskId: plan.taskId,
        recordId: plan.recordId,
        sourceSnapshotId: plan.sourceSnapshotId,
        route: plan.route,
        autoPolicy: plan.autoPolicy ?? null,
        budgets: plan.budgets,
        maxUnits: plan.maxUnits,
        specHashes: specs.map((spec) => ({ unitId: spec.unitId, specHash: spec.specHash })),
        layers,
    });
}

function specHashPayload(spec: Omit<RecordUnitSpec, "specHash"> | RecordUnitSpec): unknown {
    return {
        schemaVersion: spec.schemaVersion,
        kind: spec.kind,
        taskId: spec.taskId,
        recordId: spec.recordId,
        unitId: spec.unitId,
        unitKind: spec.unitKind,
        active: spec.active,
        sourceSnapshotId: spec.sourceSnapshotId,
        inputHash: spec.inputHash,
        provenance: spec.provenance,
        promptRecipe: spec.promptRecipe,
        range: spec.range,
        composeOrder: spec.composeOrder,
        childOrder: spec.childOrder,
        continuationKey: spec.continuationKey,
        dependencies: spec.dependencies,
        parentUnitId: spec.parentUnitId,
        childUnitIds: spec.childUnitIds,
        splitDepth: spec.splitDepth,
        stepCount: spec.stepCount,
        estimatedCost: spec.estimatedCost,
        inheritedCost: spec.inheritedCost,
        routePlan: spec.routePlan,
    };
}

function assertSpecIdentity(plan: RecordUnitPlan, spec: RecordUnitSpec): void {
    if (spec.schemaVersion !== RECORD_UNIT_SCHEMA_VERSION || spec.kind !== "record-unit-spec") throw new RecordUnitEngineError("INVALID_UNIT", "Unit spec schema 不受支持");
    if (spec.taskId !== plan.taskId || spec.recordId !== plan.recordId || spec.sourceSnapshotId !== plan.sourceSnapshotId) {
        throw new RecordUnitEngineError("IDENTITY_MISMATCH", `Unit ${spec.unitId} 身份与 Plan 不一致`);
    }
    if (spec.provenance.sourceSnapshotId !== plan.sourceSnapshotId) throw new RecordUnitEngineError("PROVENANCE_MISMATCH", `Unit ${spec.unitId} provenance 的 sourceSnapshotId 不一致`);
    if (spec.splitDepth < 0 || spec.splitDepth > 1) throw new RecordUnitEngineError("SPLIT_DEPTH", `Unit ${spec.unitId} splitDepth 超出范围`);
    if (spec.stepCount < 1 || !Number.isSafeInteger(spec.stepCount)) throw new RecordUnitEngineError("INVALID_UNIT", `Unit ${spec.unitId} stepCount 无效`);
    if (spec.range.axis === "step" && spec.stepCount !== spec.range.end - spec.range.start + 1) throw new RecordUnitEngineError("INVALID_UNIT", `Unit ${spec.unitId} stepCount 与 range 不一致`);
}

function assertDeclaredRoutePolicy(route: RecordUnitRoute, autoPolicy: RecordUnitAutoPolicy | null): void {
    if (route === "auto") {
        if (!autoPolicy || canonicalRecordUnitJson(autoPolicy) !== canonicalRecordUnitJson(DEFAULT_AUTO_POLICY)) {
            throw new RecordUnitEngineError("ROUTE_POLICY_MISMATCH", "auto route 必须声明严格的 Grok→agy→Antigravity→Codex→Claude Code 与 Grok→agy overflow policy");
        }
        return;
    }
    if (autoPolicy !== null) throw new RecordUnitEngineError("ROUTE_POLICY_MISMATCH", "显式 route 不得声明 auto overflow policy");
}

function deriveAuthorizedRoutePlan(route: RecordUnitRoute, autoPolicy: RecordUnitAutoPolicy | null): RecordUnitProvider[] {
    assertDeclaredRoutePolicy(route, autoPolicy);
    return route === "auto" ? [...autoPolicy!.order] : [route];
}

function assertAuthorizedRoutePlan(
    spec: Pick<RecordUnitSpec, "unitId" | "routePlan">,
    authorizedRoutePlan: readonly RecordUnitProvider[],
): void {
    if (!sameStringArray(spec.routePlan, authorizedRoutePlan)) {
        throw new RecordUnitEngineError("ROUTE_POLICY_MISMATCH", `Unit ${spec.unitId} 的 routePlan 不受 Plan route/autoPolicy 授权`);
    }
}

function assertLocalRouteAuthorization(
    plan: Pick<RecordUnitPlan, "route" | "autoPolicy">,
    spec: Pick<RecordUnitSpec, "unitId" | "routePlan">,
): void {
    assertAuthorizedRoutePlan(spec, deriveAuthorizedRoutePlan(plan.route, plan.autoPolicy));
}

function parseDeclaredAutoPolicy(value: unknown, route: RecordUnitRoute): RecordUnitAutoPolicy | null {
    if (route !== "auto") {
        if (value !== undefined && value !== null) throw new RecordUnitEngineError("ROUTE_POLICY_MISMATCH", "显式 route 的 autoPolicy 必须为空");
        return null;
    }
    if (value === undefined) return cloneAutoPolicy(DEFAULT_AUTO_POLICY);
    const policy = parseAutoPolicy(value);
    if (canonicalRecordUnitJson(policy) !== canonicalRecordUnitJson(DEFAULT_AUTO_POLICY)) throw new RecordUnitEngineError("ROUTE_POLICY_MISMATCH", "autoPolicy 不符合固定路由和 overflow 规则");
    return policy;
}

function parseAutoPolicy(value: unknown): RecordUnitAutoPolicy {
    const policy = asPlainObject(value, "autoPolicy");
    assertExactKeys(policy, ["order", "overflow"], "autoPolicy");
    if (!Array.isArray(policy.order)) throw new RecordUnitEngineError("INVALID_SCHEMA", "autoPolicy.order 必须是数组");
    const order = policy.order.map((provider, index) => parseKnown(provider, RECORD_UNIT_PROVIDERS, `autoPolicy.order[${index}]`));
    if (new Set(order).size !== order.length) throw new RecordUnitEngineError("INVALID_SCHEMA", "autoPolicy.order 不得重复 provider");
    const overflow = asPlainObject(policy.overflow, "autoPolicy.overflow");
    assertExactKeys(overflow, ["enabled", "from", "to"], "autoPolicy.overflow");
    if (typeof overflow.enabled !== "boolean" || overflow.from !== "grok" || overflow.to !== "agy") {
        throw new RecordUnitEngineError("ROUTE_POLICY_MISMATCH", "autoPolicy.overflow 仅允许 Grok→agy");
    }
    return { order, overflow: { enabled: overflow.enabled, from: "grok", to: "agy" } };
}

function cloneAutoPolicy(policy: RecordUnitAutoPolicy): RecordUnitAutoPolicy {
    return { order: [...policy.order], overflow: { ...policy.overflow } };
}

function parseFenceAdvanceEvidence(value: unknown): RecordUnitFenceAdvanceEvidence {
    const evidence = asPlainObject(value, "attemptEvidence");
    assertExactKeys(evidence, ["previousAttemptId", "previousFence", "advancedFence", "outcome", "evidenceHash"], "attemptEvidence");
    return {
        previousAttemptId: parseText(evidence.previousAttemptId, "attemptEvidence.previousAttemptId"),
        previousFence: parseSafeInteger(evidence.previousFence, "attemptEvidence.previousFence", 1),
        advancedFence: parseSafeInteger(evidence.advancedFence, "attemptEvidence.advancedFence", 1),
        outcome: parseKnown(evidence.outcome, ["reconciled-not-found", "known-failure", "status-unsupported"] as const, "attemptEvidence.outcome"),
        evidenceHash: parseCanonicalHash(evidence.evidenceHash, "attemptEvidence.evidenceHash"),
    };
}

function effectiveProvenanceHash(spec: RecordUnitSpec, promptHash: string): string {
    return canonicalRecordUnitHash({ ...spec.provenance, promptHash });
}

function unresolvedPromptHash(recipe: RecordUnitPromptRecipe): string {
    return canonicalRecordUnitHash({
        recipe,
        dependencyOutputs: recipe.dependencyBindings.map((binding) => ({ unitId: binding.unitId, outputHash: binding.placeholder })),
    });
}

function unresolvedInputHash(sourceSnapshotId: string, sourceContentHash: string, range: RecordUnitRange, promptHash: string, recipe: RecordUnitPromptRecipe): string {
    return canonicalRecordUnitHash({
        sourceSnapshotId,
        sourceContentHash,
        range,
        promptHash,
        dependencyOutputs: recipe.dependencyBindings.map((binding) => ({ unitId: binding.unitId, outputHash: binding.placeholder })),
    });
}

function dependencyPlaceholder(unitId: string): string {
    return `{{unit:${unitId}:outputHash}}`;
}

function continuationPlaceholder(continuationKey: string, unitId: string): string {
    return `{{continuation:${continuationKey}:${unitId}:outputHash}}`;
}

function emptyPromptRecipe(kindOrTemplate: RecordUnitKind | string, range: RecordUnitRange): RecordUnitPromptRecipe {
    const templateId = RECORD_UNIT_KINDS.includes(kindOrTemplate as RecordUnitKind) ? `record-${kindOrTemplate}-v1` : kindOrTemplate;
    return { recipeVersion: 1, templateId, range: { ...range }, dependencyBindings: [], continuationBinding: null };
}

function compareUnitIdentity(left: { composeOrder: number; childOrder: number; range: RecordUnitRange; unitId: string }, right: { composeOrder: number; childOrder: number; range: RecordUnitRange; unitId: string }): number {
    return left.composeOrder - right.composeOrder
        || left.childOrder - right.childOrder
        || left.range.start - right.range.start
        || left.range.end - right.range.end
        || left.unitId.localeCompare(right.unitId);
}

function compareCompositionItems(left: RecordUnitCompositionItem, right: RecordUnitCompositionItem): number {
    return left.composeOrder - right.composeOrder
        || left.childOrder - right.childOrder
        || left.range.start - right.range.start
        || left.range.end - right.range.end
        || left.unitId.localeCompare(right.unitId);
}

function emptyProviderCounts(): ProviderAttemptCounts {
    return { grok: 0, agy: 0, antigravity: 0, codex: 0, "claude-code": 0 };
}

function parseUnits(value: unknown, sourceSnapshotId: string): RecordUnitSpecInput[] {
    if (!Array.isArray(value)) throw new RecordUnitEngineError("INVALID_SCHEMA", "units 必须是数组");
    return value.map((entry, index) => parseUnitSpec(entry, `units[${index}]`, sourceSnapshotId));
}

function parseUnitSpec(value: unknown, label: string, sourceSnapshotId: string): RecordUnitSpecInput {
    const unit = asPlainObject(value, label);
    const legacyKeys = ["unitId", "unitKind", "inputHash", "provenance", "range", "composeOrder", "continuationKey", "dependencies", "stepCount", "estimatedCost"];
    assertOneExactKeySet(unit, [legacyKeys, [...legacyKeys, "promptRecipe"]], label);
    const range = parseRange(unit.range, `${label}.range`);
    const stepCount = parseSafeInteger(unit.stepCount, `${label}.stepCount`, 1);
    if (range.axis === "step" && stepCount !== range.end - range.start + 1) throw new RecordUnitEngineError("INVALID_SCHEMA", `${label}.stepCount 必须等于 step range 宽度`);
    const unitKind = parseKnown(unit.unitKind, RECORD_UNIT_KINDS, `${label}.unitKind`);
    const continuationKey = unit.continuationKey === null ? null : parseText(unit.continuationKey, `${label}.continuationKey`);
    if ((unitKind === "round-part" || unitKind === "serial-chunk" || unitKind === "compose-window") && continuationKey === null) {
        throw new RecordUnitEngineError("INVALID_SCHEMA", `${label}.unitKind 必须提供 continuationKey`);
    }
    if ((unitKind === "parallel-chunk" || unitKind === "reduce-window") && continuationKey !== null) {
        throw new RecordUnitEngineError("INVALID_SCHEMA", `${label}.unitKind 不得提供 continuationKey`);
    }
    const provenance = parseProvenance(unit.provenance, `${label}.provenance`);
    if (provenance.sourceSnapshotId !== sourceSnapshotId) throw new RecordUnitEngineError("PROVENANCE_MISMATCH", `${label}.provenance.sourceSnapshotId 不匹配`);
    return {
        unitId: parseText(unit.unitId, `${label}.unitId`),
        unitKind,
        inputHash: parseCanonicalHash(unit.inputHash, `${label}.inputHash`),
        provenance,
        range,
        composeOrder: parseSafeInteger(unit.composeOrder, `${label}.composeOrder`, 0),
        continuationKey,
        dependencies: parseStringArray(unit.dependencies, `${label}.dependencies`),
        stepCount,
        estimatedCost: parseFiniteNumber(unit.estimatedCost, `${label}.estimatedCost`, 0),
        ...(unit.promptRecipe === undefined ? {} : { promptRecipe: parsePromptRecipe(unit.promptRecipe, `${label}.promptRecipe`) }),
    };
}

function parsePromptRecipe(value: unknown, label: string): RecordUnitPromptRecipe {
    const recipe = asPlainObject(value, label);
    assertExactKeys(recipe, ["recipeVersion", "templateId", "range", "dependencyBindings", "continuationBinding"], label);
    if (recipe.recipeVersion !== 1) throw new RecordUnitEngineError("INVALID_SCHEMA", `${label}.recipeVersion 必须为 1`);
    if (!Array.isArray(recipe.dependencyBindings)) throw new RecordUnitEngineError("INVALID_SCHEMA", `${label}.dependencyBindings 必须是数组`);
    const dependencyBindings = recipe.dependencyBindings.map((entry, index) => {
        const binding = asPlainObject(entry, `${label}.dependencyBindings[${index}]`);
        assertExactKeys(binding, ["unitId", "placeholder"], `${label}.dependencyBindings[${index}]`);
        return { unitId: parseText(binding.unitId, `${label}.dependencyBindings[${index}].unitId`), placeholder: parseText(binding.placeholder, `${label}.dependencyBindings[${index}].placeholder`) };
    });
    let continuationBinding: RecordUnitPromptContinuationBinding | null = null;
    if (recipe.continuationBinding !== null) {
        const binding = asPlainObject(recipe.continuationBinding, `${label}.continuationBinding`);
        assertExactKeys(binding, ["continuationKey", "previousUnitId", "placeholder"], `${label}.continuationBinding`);
        continuationBinding = {
            continuationKey: parseText(binding.continuationKey, `${label}.continuationBinding.continuationKey`),
            previousUnitId: parseText(binding.previousUnitId, `${label}.continuationBinding.previousUnitId`),
            placeholder: parseText(binding.placeholder, `${label}.continuationBinding.placeholder`),
        };
    }
    return {
        recipeVersion: 1,
        templateId: parseText(recipe.templateId, `${label}.templateId`),
        range: parseRange(recipe.range, `${label}.range`),
        dependencyBindings,
        continuationBinding,
    };
}

function parseProvenance(value: unknown, label: string): RecordUnitProvenance {
    const provenance = asPlainObject(value, label);
    assertExactKeys(provenance, ["sourceSnapshotId", "sourceContentHash", "promptHash", "formatterVersion"], label);
    return {
        sourceSnapshotId: parseText(provenance.sourceSnapshotId, `${label}.sourceSnapshotId`),
        sourceContentHash: parseCanonicalHash(provenance.sourceContentHash, `${label}.sourceContentHash`),
        promptHash: parseCanonicalHash(provenance.promptHash, `${label}.promptHash`),
        formatterVersion: parseText(provenance.formatterVersion, `${label}.formatterVersion`),
    };
}

function parseRange(value: unknown, label: string): RecordUnitRange {
    const range = asPlainObject(value, label);
    assertExactKeys(range, ["axis", "start", "end"], label);
    const start = parseSafeInteger(range.start, `${label}.start`, 1);
    const end = parseSafeInteger(range.end, `${label}.end`, start);
    return { axis: parseKnown(range.axis, ["step", "round"] as const, `${label}.axis`), start, end };
}

function parseBudgets(value: unknown): RecordUnitBudgets {
    const budgets = asPlainObject(value, "budgets");
    assertExactKeys(budgets, ["unitAttempts", "routeAttempts", "providerAttempts"], "budgets");
    return {
        unitAttempts: parseSafeInteger(budgets.unitAttempts, "budgets.unitAttempts", 1),
        routeAttempts: parseSafeInteger(budgets.routeAttempts, "budgets.routeAttempts", 1),
        providerAttempts: parseSafeInteger(budgets.providerAttempts, "budgets.providerAttempts", 1),
    };
}

function parseRoute(value: unknown): RecordUnitRoute {
    return parseKnown(value, ["auto", ...RECORD_UNIT_PROVIDERS] as const, "route");
}

function parseFailureClass(value: unknown): RecordUnitFailureClass {
    return parseKnown(value, ["Congestion", "Availability", "Quality", "Complexity", "LocalResource", "UnknownOutcome", "DeterministicInput"] as const, "failureClass");
}

function parseBackoff(value: unknown): number {
    if (value === undefined) return 0;
    return parseSafeInteger(value, "backoffMs", 0);
}

function parseStringArray(value: unknown, label: string): string[] {
    if (!Array.isArray(value)) throw new RecordUnitEngineError("INVALID_SCHEMA", `${label} 必须是数组`);
    const parsed = value.map((entry, index) => parseText(entry, `${label}[${index}]`));
    if (new Set(parsed).size !== parsed.length) throw new RecordUnitEngineError("INVALID_SCHEMA", `${label} 不能重复`);
    return parsed;
}

function parseCanonicalHash(value: unknown, label: string): string {
    const hash = parseText(value, label);
    if (!/^sha256:[0-9a-f]{64}$/u.test(hash)) throw new RecordUnitEngineError("INVALID_HASH", `${label} 必须是小写 sha256 canonical hash`);
    return hash;
}

function parseText(value: unknown, label: string): string {
    if (typeof value !== "string") throw new RecordUnitEngineError("INVALID_SCHEMA", `${label} 必须是字符串`);
    const normalized = value.normalize("NFC");
    if (!normalized || normalized.trim() !== normalized || /[\u0000-\u001F\u007F]/u.test(normalized)) {
        throw new RecordUnitEngineError("INVALID_SCHEMA", `${label} 必须是非空规范文本`);
    }
    return normalized;
}

function parseSafeInteger(value: unknown, label: string, minimum: number): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || !Number.isFinite(value) || Object.is(value, -0) || value < minimum) {
        throw new RecordUnitEngineError("INVALID_SCHEMA", `${label} 必须是大于等于 ${minimum} 的安全整数`);
    }
    return value;
}

function parseFiniteNumber(value: unknown, label: string, minimum: number): number {
    if (typeof value !== "number" || !Number.isFinite(value) || Object.is(value, -0) || value < minimum) {
        throw new RecordUnitEngineError("INVALID_SCHEMA", `${label} 必须是大于等于 ${minimum} 的有限数字`);
    }
    return value;
}

function parseKnown<T extends string>(value: unknown, values: readonly T[], label: string): T {
    const parsed = parseText(value, label);
    if (!values.includes(parsed as T)) throw new RecordUnitEngineError("INVALID_SCHEMA", `${label} 不受支持`);
    return parsed as T;
}

function asPlainObject(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new RecordUnitEngineError("INVALID_SCHEMA", `${label} 必须是普通对象`);
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new RecordUnitEngineError("INVALID_SCHEMA", `${label} 必须是普通对象`);
    return value as Record<string, unknown>;
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
    const actual = Object.keys(value).sort();
    const allowed = [...expected].sort();
    if (actual.length !== allowed.length || actual.some((key, index) => key !== allowed[index])) {
        throw new RecordUnitEngineError("UNKNOWN_FIELD", `${label} 含有未知字段或缺少必填字段`);
    }
}

function assertOneExactKeySet(value: Record<string, unknown>, expectedSets: readonly (readonly string[])[], label: string): void {
    const actual = Object.keys(value).sort();
    const matches = expectedSets.some((expected) => {
        const allowed = [...expected].sort();
        return actual.length === allowed.length && actual.every((key, index) => key === allowed[index]);
    });
    if (!matches) throw new RecordUnitEngineError("UNKNOWN_FIELD", `${label} 含有未知字段或缺少必填字段`);
}

function assertNow(now: number): void {
    if (!Number.isSafeInteger(now) || now < 0) throw new RecordUnitEngineError("INVALID_CLOCK", "now 必须是非负安全整数毫秒时间戳");
}

function uniqueStrings(values: string[]): string[] {
    return [...new Set(values)];
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}

function roundCost(value: number): number {
    return Math.round(value * 1_000_000) / 1_000_000;
}

function canonicalValue(value: unknown): string {
    if (value === null) return "null";
    if (typeof value === "string") return JSON.stringify(value.normalize("NFC"));
    if (typeof value === "boolean") return value ? "true" : "false";
    if (typeof value === "number") {
        if (!Number.isFinite(value) || Object.is(value, -0)) throw new RecordUnitEngineError("INVALID_CANONICAL_VALUE", "canonical hash 不接受非有限数字");
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) return `[${value.map(canonicalValue).join(",")}]`;
    const object = asPlainObject(value, "canonical hash 对象");
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key.normalize("NFC"))}:${canonicalValue(object[key])}`).join(",")}}`;
}
