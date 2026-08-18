import assert from "node:assert/strict";
import * as engine from "../src/record-unit-engine.ts";

const hash = (value: unknown) => engine.canonicalRecordUnitHash(value);

function unitInput(overrides: Partial<engine.RecordUnitSpecInput> = {}): engine.RecordUnitSpecInput {
    const sourceSnapshotId = "snapshot-1";
    return {
        unitId: "unit-1",
        unitKind: "parallel-chunk",
        inputHash: hash({ input: "unit-1" }),
        provenance: {
            sourceSnapshotId,
            sourceContentHash: hash({ source: sourceSnapshotId }),
            promptHash: hash({ prompt: "unit-1" }),
            formatterVersion: "formatter-1",
        },
        range: { axis: "round", start: 1, end: 1 },
        composeOrder: 0,
        continuationKey: null,
        dependencies: [],
        stepCount: 1,
        estimatedCost: 10,
        ...overrides,
    };
}

function planInput(
    units: engine.RecordUnitSpecInput[],
    overrides: Partial<engine.RecordUnitPlanningInput> = {},
): engine.RecordUnitPlanningInput {
    return {
        schemaVersion: 1,
        kind: "record-unit-plan-input",
        taskId: "task-1",
        recordId: "record-1",
        sourceSnapshotId: "snapshot-1",
        route: "auto",
        budgets: { unitAttempts: 8, routeAttempts: 5, providerAttempts: 2 },
        maxUnits: 10_000,
        units,
        ...overrides,
    };
}

function start(
    plan: engine.RecordUnitPlan,
    unitId: string,
    now = 1_000,
    availability?: Partial<Record<engine.RecordUnitProvider, engine.RecordUnitAvailability>>,
): engine.StartRecordUnitResult {
    return engine.startRecordUnit(plan, unitId, { now, availability });
}

function succeed(
    plan: engine.RecordUnitPlan,
    unitId: string,
    attempt: Pick<engine.RecordUnitAttempt, "attemptId" | "fence">,
): engine.RecordUnitPlan {
    return engine.succeedRecordUnit(plan, unitId, {
        attemptId: attempt.attemptId,
        fence: attempt.fence,
        model: "test-model",
        outputHash: hash({ output: unitId, fence: attempt.fence }),
        qualityHash: hash({ quality: unitId, fence: attempt.fence }),
    });
}

function fenceEvidence(
    attempt: engine.RecordUnitAttempt,
    advancedFence: number,
    outcome: engine.RecordUnitFenceAdvanceEvidence["outcome"] = "status-unsupported",
): engine.RecordUnitFenceAdvanceEvidence {
    return {
        previousAttemptId: attempt.attemptId,
        previousFence: attempt.fence,
        advancedFence,
        outcome,
        evidenceHash: hash({ attemptId: attempt.attemptId, advancedFence, outcome }),
    };
}

function replaceRuntime(
    node: engine.RecordUnitRuntimeNode | null,
    key: string,
    mutate: (runtime: engine.RecordUnitRuntime) => engine.RecordUnitRuntime,
): engine.RecordUnitRuntimeNode | null {
    if (!node) return null;
    if (node.key === key) return { ...node, value: mutate(node.value) };
    if (key.localeCompare(node.key) < 0) return { ...node, left: replaceRuntime(node.left, key, mutate) };
    return { ...node, right: replaceRuntime(node.right, key, mutate) };
}

{
    const first = unitInput({
        unitId: "part-1",
        unitKind: "round-part",
        range: { axis: "step", start: 1, end: 2 },
        stepCount: 2,
        continuationKey: "round-1-prev-summary",
    });
    const second = unitInput({
        unitId: "part-2",
        unitKind: "round-part",
        range: { axis: "step", start: 3, end: 4 },
        stepCount: 2,
        composeOrder: 1,
        continuationKey: "round-1-prev-summary",
        dependencies: ["part-1"],
    });
    const parallel = unitInput({ unitId: "parallel-1", composeOrder: 2 });
    let plan = engine.createRecordUnitPlan(planInput([first, second, parallel]));
    assert.deepEqual(plan.layers.map((layer) => layer.unitIds), [["part-1", "parallel-1"], ["part-2"]]);
    assert.equal(start(plan, "part-2").reason, "dependency");
    const firstStart = start(plan, "part-1");
    plan = succeed(firstStart.plan, "part-1", firstStart.attempt!);
    const secondBaseHash = plan.unitSpecs[plan.unitSpecIndex["part-2"]].inputHash;
    const secondStart = start(plan, "part-2", 1_001);
    assert.equal(secondStart.action, "dispatch");
    assert.notEqual(secondStart.attempt!.inputHash, secondBaseHash);
    assert.equal(engine.getRecordUnit(secondStart.plan, "part-2").prompt.dependencyOutputs[0].unitId, "part-1");
    assert.throws(() => engine.createRecordUnitPlan(planInput([first, { ...second, dependencies: [] }])), (error: unknown) => error instanceof engine.RecordUnitEngineError && error.code === "CONTINUATION_PARALLEL");
    assert.throws(() => engine.createRecordUnitPlan({ ...planInput([first]), unexpected: true }), (error: unknown) => error instanceof engine.RecordUnitEngineError && error.code === "UNKNOWN_FIELD");
}

{
    const explicit = engine.createRecordUnitPlan(planInput([unitInput({ unitId: "explicit" })], { route: "codex" }));
    assert.deepEqual(explicit.unitSpecs[0].routePlan, ["codex"]);
    const forgedWithoutHash: Omit<engine.RecordUnitSpec, "specHash"> = {
        ...explicit.unitSpecs[0],
        routePlan: ["codex", "agy"],
    };
    const forgedSpec: engine.RecordUnitSpec = {
        ...forgedWithoutHash,
        specHash: engine.hashRecordUnitSpec(forgedWithoutHash),
    };
    const forged = { ...explicit, unitSpecs: [forgedSpec] } as engine.RecordUnitPlan;
    assert.equal(forgedSpec.specHash, engine.hashRecordUnitSpec(forgedSpec));
    assert.throws(() => engine.validateRecordUnitPlan(forged), (error: unknown) => error instanceof engine.RecordUnitEngineError && error.code === "ROUTE_POLICY_MISMATCH");

    const directForgedWithoutHash: Omit<engine.RecordUnitSpec, "specHash"> = {
        ...explicit.unitSpecs[0],
        routePlan: ["agy"],
    };
    const directForgedSpec: engine.RecordUnitSpec = {
        ...directForgedWithoutHash,
        specHash: engine.hashRecordUnitSpec(directForgedWithoutHash),
    };
    const directForgedDispatch = { ...explicit, unitSpecs: [directForgedSpec] } as engine.RecordUnitPlan;
    assert.equal(directForgedSpec.specHash, engine.hashRecordUnitSpec(directForgedSpec));
    assert.throws(() => engine.startRecordUnit(directForgedDispatch, "explicit", { now: 1_500 }), (error: unknown) => error instanceof engine.RecordUnitEngineError && error.code === "ROUTE_POLICY_MISMATCH");
    assert.throws(() => engine.splitRecordUnit(directForgedDispatch, "explicit"), (error: unknown) => error instanceof engine.RecordUnitEngineError && error.code === "ROUTE_POLICY_MISMATCH");

    const extraFieldSpec = { ...explicit.unitSpecs[0], unexpected: true } as engine.RecordUnitSpec;
    const extraFieldPlan = { ...explicit, unitSpecs: [extraFieldSpec] } as engine.RecordUnitPlan;
    assert.throws(() => engine.validateRecordUnitPlan(extraFieldPlan), (error: unknown) => error instanceof engine.RecordUnitEngineError && error.code === "UNKNOWN_FIELD");
    assert.equal(engine.RECORD_UNIT_SPEC_HASH_ROLE, "integrity-only-not-authorization");

    const badPolicy = {
        order: ["agy", "grok", "antigravity", "codex", "claude-code"],
        overflow: { enabled: true, from: "grok", to: "agy" },
    } as engine.RecordUnitAutoPolicy;
    assert.throws(() => engine.createRecordUnitPlan(planInput([unitInput()], { autoPolicy: badPolicy })), (error: unknown) => error instanceof engine.RecordUnitEngineError && error.code === "ROUTE_POLICY_MISMATCH");
}

{
    let overflowPlan = engine.createRecordUnitPlan(planInput([unitInput({ unitId: "overflow" })], {
        budgets: { unitAttempts: 8, routeAttempts: 5, providerAttempts: 1 },
    }));
    const overflow = start(overflowPlan, "overflow", 2_000, { grok: "capacity-full", agy: "available" });
    assert.equal(overflow.attempt!.provider, "agy");
    overflowPlan = engine.failRecordUnitAttempt(overflow.plan, "overflow", {
        attemptId: overflow.attempt!.attemptId,
        fence: overflow.attempt!.fence,
        failureClass: "Availability",
        now: 2_001,
    });
    const afterOverflow = start(overflowPlan, "overflow", 2_001);
    assert.equal(afterOverflow.attempt!.provider, "antigravity");
    assert.deepEqual(engine.getRecordUnit(afterOverflow.plan, "overflow").attemptedProviders, ["agy", "antigravity"]);

    let congestionPlan = engine.createRecordUnitPlan(planInput([unitInput({ unitId: "congestion-route" })]));
    const congestionFirst = start(congestionPlan, "congestion-route", 2_100);
    congestionPlan = engine.failRecordUnitAttempt(congestionFirst.plan, "congestion-route", {
        attemptId: congestionFirst.attempt!.attemptId,
        fence: congestionFirst.attempt!.fence,
        failureClass: "Congestion",
        now: 2_100,
        backoffMs: 100,
    });
    assert.equal(start(congestionPlan, "congestion-route", 2_199).reason, "backoff");
    const congestionRetry = start(congestionPlan, "congestion-route", 2_200);
    assert.equal(congestionRetry.attempt!.provider, "grok");

    let unavailablePlan = engine.createRecordUnitPlan(planInput([unitInput({ unitId: "unavailable" })]));
    const unavailableFirst = start(unavailablePlan, "unavailable", 2_300);
    unavailablePlan = engine.failRecordUnitAttempt(unavailableFirst.plan, "unavailable", {
        attemptId: unavailableFirst.attempt!.attemptId,
        fence: unavailableFirst.attempt!.fence,
        failureClass: "Congestion",
        now: 2_300,
    });
    const unavailableFallback = start(unavailablePlan, "unavailable", 2_300, { grok: "unavailable" });
    assert.equal(unavailableFallback.attempt!.provider, "agy");
    assert.equal(engine.getRecordUnit(unavailableFallback.plan, "unavailable").routeAttempts, 2);

    let availabilityPlan = engine.createRecordUnitPlan(planInput([unitInput({ unitId: "availability" })]));
    const availabilityFirst = start(availabilityPlan, "availability", 2_400);
    availabilityPlan = engine.failRecordUnitAttempt(availabilityFirst.plan, "availability", {
        attemptId: availabilityFirst.attempt!.attemptId,
        fence: availabilityFirst.attempt!.fence,
        failureClass: "Availability",
        now: 2_400,
        backoffMs: 999_999,
    });
    assert.equal(engine.getRecordUnit(availabilityPlan, "availability").nextEligibleAt, 2_400);
    assert.equal(start(availabilityPlan, "availability", 2_400).attempt!.provider, "agy");

    let explicit = engine.createRecordUnitPlan(planInput([unitInput({ unitId: "explicit-end" })], {
        route: "codex",
        budgets: { unitAttempts: 3, routeAttempts: 1, providerAttempts: 1 },
    }));
    const codex = start(explicit, "explicit-end", 2_500);
    explicit = engine.failRecordUnitAttempt(codex.plan, "explicit-end", {
        attemptId: codex.attempt!.attemptId,
        fence: codex.attempt!.fence,
        failureClass: "Availability",
        now: 2_500,
    });
    const explicitEnd = start(explicit, "explicit-end", 2_500);
    assert.equal(explicitEnd.action, "failed-final");
    assert.deepEqual(engine.getRecordUnit(explicitEnd.plan, "explicit-end").attemptedProviders, ["codex"]);

    let allRoutes = engine.createRecordUnitPlan(planInput([unitInput({ unitId: "all-routes" })], {
        budgets: { unitAttempts: 8, routeAttempts: 5, providerAttempts: 1 },
    }));
    for (let index = 0; index < engine.RECORD_UNIT_PROVIDERS.length; index++) {
        const running = start(allRoutes, "all-routes", 2_600 + index);
        assert.equal(running.action, "dispatch");
        allRoutes = engine.failRecordUnitAttempt(running.plan, "all-routes", {
            attemptId: running.attempt!.attemptId,
            fence: running.attempt!.fence,
            failureClass: "Availability",
            now: 2_600 + index,
        });
    }
    assert.equal(start(allRoutes, "all-routes", 2_700).action, "failed-final");
}

{
    let plan = engine.createRecordUnitPlan(planInput([unitInput({ unitId: "unknown" })], {
        budgets: { unitAttempts: 4, routeAttempts: 5, providerAttempts: 2 },
    }));
    const running = start(plan, "unknown", 3_000);
    plan = engine.failRecordUnitAttempt(running.plan, "unknown", {
        attemptId: running.attempt!.attemptId,
        fence: running.attempt!.fence,
        failureClass: "UnknownOutcome",
        now: 3_000,
        providerEvidence: "request-dispatched:unknown-1",
    });
    assert.equal(start(plan, "unknown", 32_999).reason, "unknown-grace");
    const expired = start(plan, "unknown", 33_000);
    assert.equal(expired.action, "needs-fence-advance");
    assert.equal(expired.unknownAction!.remoteExecutionSemantics, "remote-at-least-once-possible");
    assert.throws(() => engine.resolveRecordUnitUnknownOutcome(plan, "unknown", {
        now: 33_000,
        attemptId: running.attempt!.attemptId,
        fence: running.attempt!.fence,
        providerEvidence: "request-dispatched:unknown-1",
        decision: "fallback",
        advancedFence: running.attempt!.fence,
        attemptEvidence: fenceEvidence(running.attempt!, running.attempt!.fence),
    }), (error: unknown) => error instanceof engine.RecordUnitEngineError && error.code === "FENCE_NOT_ADVANCED");
    const advancedFence = running.attempt!.fence + 5;
    const evidence = fenceEvidence(running.attempt!, advancedFence, "status-unsupported");
    const migratedResolution = engine.adaptRecordUnitUnknownOutcomeResolution({
        now: 33_000,
        attempt: running.attempt!,
        providerEvidence: "request-dispatched:unknown-1",
        decision: "fallback",
        advancedFence,
        outcome: "status-unsupported",
        evidenceHash: evidence.evidenceHash,
    });
    assert.deepEqual(migratedResolution.attemptEvidence, evidence);
    plan = engine.resolveRecordUnitUnknownOutcome(plan, "unknown", migratedResolution);
    assert.deepEqual(engine.getRecordUnit(plan, "unknown").fenceAdvanceEvidence, evidence);
    const retried = start(plan, "unknown", 33_000);
    assert.equal(retried.attempt!.provider, "agy");
    assert.equal(retried.attempt!.fence, advancedFence);
    assert.throws(() => engine.succeedRecordUnit(retried.plan, "unknown", {
        attemptId: running.attempt!.attemptId,
        fence: running.attempt!.fence,
        model: "late-model",
        outputHash: hash("late"),
        qualityHash: hash("late-quality"),
    }), (error: unknown) => error instanceof engine.RecordUnitEngineError && error.code === "FENCE_MISMATCH");
    plan = succeed(retried.plan, "unknown", retried.attempt!);
    assert.equal(engine.getRecordUnit(plan, "unknown").state, "succeeded");

    let finite = engine.createRecordUnitPlan(planInput([unitInput({ unitId: "unknown-finite" })], {
        budgets: { unitAttempts: 1, routeAttempts: 5, providerAttempts: 1 },
    }));
    const finiteRun = start(finite, "unknown-finite", 3_100);
    finite = engine.failRecordUnitAttempt(finiteRun.plan, "unknown-finite", {
        attemptId: finiteRun.attempt!.attemptId,
        fence: finiteRun.attempt!.fence,
        failureClass: "UnknownOutcome",
        now: 3_100,
        providerEvidence: "request-dispatched:finite",
    });
    const finiteFence = finiteRun.attempt!.fence + 1;
    finite = engine.resolveRecordUnitUnknownOutcome(finite, "unknown-finite", {
        now: 33_100,
        attemptId: finiteRun.attempt!.attemptId,
        fence: finiteRun.attempt!.fence,
        providerEvidence: "request-dispatched:finite",
        decision: "fallback",
        advancedFence: finiteFence,
        attemptEvidence: fenceEvidence(finiteRun.attempt!, finiteFence),
    });
    assert.equal(start(finite, "unknown-finite", 33_100).action, "failed-final");
}

{
    const parent = unitInput({
        unitId: "split-parent",
        unitKind: "serial-chunk",
        range: { axis: "step", start: 1, end: 5 },
        stepCount: 5,
        continuationKey: "serial-split",
        estimatedCost: 10,
    });
    let plan = engine.createRecordUnitPlan(planInput([parent]));
    const parentSpec = plan.unitSpecs[0];
    const running = start(plan, "split-parent", 4_000);
    plan = engine.failRecordUnitAttempt(running.plan, "split-parent", {
        attemptId: running.attempt!.attemptId,
        fence: running.attempt!.fence,
        failureClass: "Quality",
        now: 4_000,
    });
    plan = engine.splitRecordUnit(plan, "split-parent", 3);
    const firstSpec = plan.unitSpecs[plan.unitSpecIndex["split-parent.split-1"]];
    const secondSpec = plan.unitSpecs[plan.unitSpecIndex["split-parent.split-2"]];
    assert.equal(plan.unitSpecs[plan.unitSpecIndex["split-parent"]].active, false);
    assert.notEqual(firstSpec.inputHash, parentSpec.inputHash);
    assert.notEqual(secondSpec.inputHash, parentSpec.inputHash);
    assert.notEqual(firstSpec.inputHash, secondSpec.inputHash);
    assert.notEqual(firstSpec.provenance.promptHash, secondSpec.provenance.promptHash);
    assert.equal(firstSpec.estimatedCost, 6);
    assert.equal(secondSpec.estimatedCost, 4);
    assert.deepEqual(secondSpec.dependencies, ["split-parent.split-1"]);
    assert.equal(secondSpec.promptRecipe.dependencyBindings[0].placeholder, "{{unit:split-parent.split-1:outputHash}}");
    assert.equal(start(plan, "split-parent.split-2", 4_001).reason, "dependency");

    const first = start(plan, "split-parent.split-1", 4_001);
    plan = succeed(first.plan, "split-parent.split-1", first.attempt!);
    assert.equal(start(plan, "split-parent.split-1", 4_002).reason, "terminal");
    assert.throws(() => engine.composeRecordUnitResults(plan, ["split-parent.split-1"]), (error: unknown) => error instanceof engine.RecordUnitEngineError && error.code === "COMPOSE_CLOSURE");
    assert.throws(() => engine.composeRecordUnitResults(plan, ["split-parent.split-1", "split-parent.split-2"]), (error: unknown) => error instanceof engine.RecordUnitEngineError && error.code === "COMPOSE_INCOMPLETE");

    const secondBaseHash = engine.getRecordUnit(plan, "split-parent.split-2").inputHash;
    const second = start(plan, "split-parent.split-2", 4_002);
    assert.equal(second.action, "dispatch");
    assert.notEqual(second.attempt!.inputHash, secondBaseHash);
    assert.notEqual(second.attempt!.inputHash, parentSpec.inputHash);
    assert.equal(engine.getRecordUnit(second.plan, "split-parent.split-2").prompt.status, "resolved");
    plan = succeed(second.plan, "split-parent.split-2", second.attempt!);
    const composition = engine.composeRecordUnitResults(plan, ["split-parent.split-2", "split-parent.split-1"]);
    assert.deepEqual(composition.items.map((item) => item.unitId), ["split-parent.split-1", "split-parent.split-2"]);

    const tamperedRoot = replaceRuntime(plan.runtimeRoot, "split-parent.split-2", (runtime) => ({
        ...runtime,
        result: { ...runtime.result!, provenanceHash: hash({ forged: true }) },
    }));
    const tampered = { ...plan, runtimeRoot: tamperedRoot } as engine.RecordUnitPlan;
    assert.throws(() => engine.composeRecordUnitResults(tampered, ["split-parent.split-1", "split-parent.split-2"]), (error: unknown) => error instanceof engine.RecordUnitEngineError && error.code === "COMPOSE_PROVENANCE");
}

{
    const parent = unitInput({ unitId: "depth-parent", range: { axis: "step", start: 1, end: 4 }, stepCount: 4 });
    let plan = engine.createRecordUnitPlan(planInput([parent]));
    const parentRun = start(plan, "depth-parent", 4_100);
    plan = engine.failRecordUnitAttempt(parentRun.plan, "depth-parent", {
        attemptId: parentRun.attempt!.attemptId,
        fence: parentRun.attempt!.fence,
        failureClass: "Complexity",
        now: 4_100,
    });
    plan = engine.splitRecordUnit(plan, "depth-parent");
    const childRun = start(plan, "depth-parent.split-1", 4_101);
    plan = engine.failRecordUnitAttempt(childRun.plan, "depth-parent.split-1", {
        attemptId: childRun.attempt!.attemptId,
        fence: childRun.attempt!.fence,
        failureClass: "Quality",
        now: 4_101,
    });
    assert.throws(() => engine.splitRecordUnit(plan, "depth-parent.split-1"), (error: unknown) => error instanceof engine.RecordUnitEngineError && error.code === "SPLIT_DEPTH");

    let congestion = engine.createRecordUnitPlan(planInput([unitInput({ unitId: "no-split", range: { axis: "step", start: 1, end: 2 }, stepCount: 2 })]));
    const congestionRun = start(congestion, "no-split", 4_200);
    congestion = engine.failRecordUnitAttempt(congestionRun.plan, "no-split", {
        attemptId: congestionRun.attempt!.attemptId,
        fence: congestionRun.attempt!.fence,
        failureClass: "Congestion",
        now: 4_200,
    });
    assert.throws(() => engine.splitRecordUnit(congestion, "no-split"), (error: unknown) => error instanceof engine.RecordUnitEngineError && error.code === "SPLIT_NOT_ALLOWED");
}

{
    const first = unitInput({
        unitId: "compose-window-1",
        unitKind: "compose-window",
        continuationKey: "compose-family",
        range: { axis: "round", start: 1, end: 5 },
        stepCount: 5,
    });
    const second = unitInput({
        unitId: "compose-window-2",
        unitKind: "compose-window",
        continuationKey: "compose-family",
        dependencies: ["compose-window-1"],
        composeOrder: 1,
        range: { axis: "round", start: 6, end: 10 },
        stepCount: 5,
    });
    let plan = engine.createRecordUnitPlan(planInput([first, second]));
    const firstRun = start(plan, "compose-window-1", 5_000);
    plan = succeed(firstRun.plan, "compose-window-1", firstRun.attempt!);
    assert.throws(() => engine.composeRecordUnitResults(plan, ["compose-window-1"]), (error: unknown) => error instanceof engine.RecordUnitEngineError && error.code === "COMPOSE_CLOSURE");
    const secondRun = start(plan, "compose-window-2", 5_001);
    plan = succeed(secondRun.plan, "compose-window-2", secondRun.attempt!);
    assert.deepEqual(engine.composeRecordUnitResults(plan, ["compose-window-2", "compose-window-1"]).items.map((item) => item.unitId), ["compose-window-1", "compose-window-2"]);
}

{
    const many = Array.from({ length: 10_000 }, (_, index) => unitInput({
        unitId: `bounded-${index}`,
        inputHash: hash({ input: index }),
        provenance: {
            sourceSnapshotId: "snapshot-1",
            sourceContentHash: hash({ source: "snapshot-1" }),
            promptHash: hash({ prompt: index }),
            formatterVersion: "formatter-1",
        },
        range: { axis: "round", start: index + 1, end: index + 1 },
        composeOrder: index,
    }));
    const createdAt = Date.now();
    let plan = engine.createRecordUnitPlan(planInput(many, {
        budgets: { unitAttempts: 2, routeAttempts: 5, providerAttempts: 1 },
    }));
    const createElapsed = Date.now() - createdAt;
    assert.equal(plan.unitSpecs.length, 10_000);
    assert.ok(createElapsed < 20_000, `10k create took ${createElapsed}ms`);
    const initialSpecs = plan.unitSpecs;
    const initialIndex = plan.unitSpecIndex;
    const initialLayers = plan.layers;
    const initialPlanHash = plan.planHash;
    const initialMetrics = { ...plan.metrics };
    const transitionsAt = Date.now();
    for (let index = 0; index < 334; index++) {
        const unitId = `bounded-${index}`;
        const running = start(plan, unitId, 6_000 + index);
        plan = succeed(running.plan, unitId, running.attempt!);
    }
    for (let index = 334; index < 500; index++) {
        const unitId = `bounded-${index}`;
        const running = start(plan, unitId, 7_000 + index);
        plan = engine.failRecordUnitAttempt(running.plan, unitId, {
            attemptId: running.attempt!.attemptId,
            fence: running.attempt!.fence,
            failureClass: "Availability",
            now: 7_000 + index,
        });
    }
    const transitionElapsed = Date.now() - transitionsAt;
    assert.strictEqual(plan.unitSpecs, initialSpecs);
    assert.strictEqual(plan.unitSpecIndex, initialIndex);
    assert.strictEqual(plan.layers, initialLayers);
    assert.equal(plan.planHash, initialPlanHash);
    assert.equal(plan.metrics.specHashComputations, initialMetrics.specHashComputations);
    assert.equal(plan.metrics.planHashComputations, initialMetrics.planHashComputations);
    assert.equal(plan.metrics.layerComputations, initialMetrics.layerComputations);
    assert.equal(plan.metrics.graphValidations, initialMetrics.graphValidations);
    assert.ok(plan.metrics.runtimeNodeCopies - initialMetrics.runtimeNodeCopies < 20_000);
    assert.ok(transitionElapsed < 10_000, `1000 local transitions took ${transitionElapsed}ms`);
    assert.throws(() => engine.createRecordUnitPlan(planInput([...many, unitInput({ unitId: "too-many" })])), (error: unknown) => error instanceof engine.RecordUnitEngineError && error.code === "UNIT_LIMIT");
}

console.log("record-unit-engine tests passed");
