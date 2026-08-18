import assert from "node:assert/strict";
import {
    MAX_BREAKER_OPEN_MS,
    PROVIDER_CONTROL_SCHEMA_VERSION,
    assertProviderControlState,
    createInitialProviderControlState,
    effectiveAgyLimit,
    type ProviderLease,
    type ProviderUncertainLease,
} from "../src/provider-control-contracts.ts";

const baseNow = 1_760_000_000_000;

function lease(leaseId: string, provider: "grok" | "agy", trafficClass: ProviderLease["trafficClass"] = "record"): ProviderLease {
    return {
        leaseId,
        attemptId: `${leaseId}-attempt`,
        provider,
        trafficClass,
        ownerEpoch: 1,
        capacityGeneration: 1,
        acquiredAtMs: baseNow + 10,
        expiresAtMs: baseNow + 100,
    };
}

function uncertain(active: ProviderLease): ProviderUncertainLease {
    return {
        ...active,
        unknownOutcomeAtMs: baseNow + 20,
        graceExpiresAtMs: baseNow + 80,
    };
}

function ownedState() {
    const state = createInitialProviderControlState(baseNow, "provider-control-contract-test");
    state.ownerEpoch = 1;
    state.ownerLease = { ownerId: "owner-a", leaseId: "owner-lease-a", acquiredAtMs: baseNow, expiresAtMs: baseNow + 200 };
    return state;
}

const state = createInitialProviderControlState(baseNow, "provider-control-contract-test");
assert.equal(state.schemaVersion, PROVIDER_CONTROL_SCHEMA_VERSION);
assert.equal(state.initialized, true);
assert.equal(state.controlRevision, 1);
assert.equal(state.ownerEpoch, 0);
assert.equal(state.pools.grok.physicalMax, 8);
assert.equal(state.pools.grok.currentLimit, 2);
assert.equal(state.agy.memory.memoryAimdLimit, 2);
assert.equal(state.agy.admission.firstRunOverflowGuarantee, 4);
assert.equal(state.agy.admission.fallbackGuarantee, 4);
assert.equal(state.agy.admission.firstRunOverflowBorrowedSlots, 0);
assert.equal(effectiveAgyLimit(state), 2);
assert.doesNotThrow(() => assertProviderControlState(state));

const invalidOpenUntil = structuredClone(state);
invalidOpenUntil.pools.grok.breaker.openUntilMs = baseNow + MAX_BREAKER_OPEN_MS + 1;
assert.throws(() => assertProviderControlState(invalidOpenUntil), /openUntilMs/u);

const invalidRetryAfter = structuredClone(state);
invalidRetryAfter.pools.grok.breaker.retryAfterMs = Number.POSITIVE_INFINITY;
assert.throws(() => assertProviderControlState(invalidRetryAfter), /retryAfterMs/u);

const unknownField = structuredClone(state) as typeof state & { unexpected?: boolean };
unknownField.unexpected = true;
assert.throws(() => assertProviderControlState(unknownField), /未知或缺失字段/u);

const duplicateAcrossProviders = ownedState();
duplicateAcrossProviders.pools.grok.activeLeases.push(lease("global-duplicate", "grok"));
duplicateAcrossProviders.pools.agy.activeLeases.push(lease("global-duplicate", "agy"));
assert.throws(() => assertProviderControlState(duplicateAcrossProviders), /全局唯一/u);

const activeAndUncertainDuplicate = ownedState();
const duplicateLease = lease("active-uncertain-duplicate", "grok");
activeAndUncertainDuplicate.pools.grok.activeLeases.push(duplicateLease);
activeAndUncertainDuplicate.pools.grok.uncertainLeases.push(uncertain(duplicateLease));
assert.throws(() => assertProviderControlState(activeAndUncertainDuplicate), /同时 active\/uncertain/u);

const overPhysical = ownedState();
overPhysical.pools.grok.activeLeases = Array.from({ length: 8 }, (_, index) => lease(`physical-${index}`, "grok"));
overPhysical.pools.grok.uncertainLeases = [uncertain(lease("physical-8", "grok"))];
assert.throws(() => assertProviderControlState(overPhysical), /physicalMax/u);

const probeBeyondOwner = ownedState();
probeBeyondOwner.pools.grok.breaker.probeLease = {
    leaseId: "probe-too-long",
    attemptId: "probe-too-long-attempt",
    ownerEpoch: 1,
    capacityGeneration: 1,
    acquiredAtMs: baseNow + 10,
    expiresAtMs: baseNow + 201,
};
assert.throws(() => assertProviderControlState(probeBeyondOwner), /probe.*owner expiresAtMs/u);

const borrowedAgy = ownedState();
borrowedAgy.pools.agy.currentLimit = 8;
borrowedAgy.pools.agy.activeLeases = Array.from({ length: 6 }, (_, index) => lease(`agy-first-${index}`, "agy", "agy-first-run-overflow"));
borrowedAgy.agy.admission.firstRunOverflowLeaseIds = borrowedAgy.pools.agy.activeLeases.map(item => item.leaseId);
borrowedAgy.agy.admission.firstRunOverflowBorrowedSlots = 2;
assert.doesNotThrow(() => assertProviderControlState(borrowedAgy));

const agyLaneOverlap = structuredClone(borrowedAgy);
agyLaneOverlap.agy.admission.fallbackLeaseIds = [agyLaneOverlap.agy.admission.firstRunOverflowLeaseIds[0]];
assert.throws(() => assertProviderControlState(agyLaneOverlap), /对应 active 集合|重复归类/u);

const invalidFrozen = ownedState();
invalidFrozen.pools.agy.timeFrozen = {
    frozen: true,
    reason: "clock_non_monotonic",
    enteredAtMs: baseNow,
    requiresManualClear: false,
    frozenFailureAttemptIds: [],
    freezeEvidence: null,
};
assert.throws(() => assertProviderControlState(invalidFrozen), /人工解除/u);

const invalidAgyGuarantee = structuredClone(state);
invalidAgyGuarantee.agy.admission.fallbackGuarantee = 3;
assert.throws(() => assertProviderControlState(invalidAgyGuarantee), /4\+4/u);

console.log("provider-control-contracts tests passed");
