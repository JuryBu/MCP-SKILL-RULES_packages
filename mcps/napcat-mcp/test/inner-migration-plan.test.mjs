import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { validateInnerMigrationPlan } from "../src/inner-migration-plan.mjs";

const digest = value => crypto.createHash("sha256").update(value).digest("hex");
const source = { pid: 100, instanceToken: "old-instance", core: "a".repeat(64), helper: "b".repeat(64) };
const target = { pid: 101, instanceToken: "new-instance", core: "c".repeat(64), helper: "b".repeat(64) };
const manifest = { schemaVersion: 1, edges: [{ source: { core: source.core, helper: source.helper },
  target: { core: target.core, helper: target.helper }, checkpointSchemaVersion: 1, stateSchemaVersion: 1, stateSemantics: "state-v1" }] };
const now = 10_000;
const makePlan = () => ({ schemaVersion: 1, id: "migration-1", generation: 1, threadId: "thread-1", expiresAt: now + 120_000,
  source: { ...source }, target: { ...target }, compatibility: { manifest: structuredClone(manifest), sha256: digest(JSON.stringify(manifest)) } });
const identity = instance => ({ pid: instance.pid, instanceToken: instance.instanceToken,
  sourceHashes: { core: instance.core, helper: instance.helper } });

test("runtime migration is authorized separately by source and target and frozen", () => {
  const input = makePlan();
  const normalized = validateInnerMigrationPlan(input, { identity: identity(source), role: "source", now });
  assert.ok(Object.isFrozen(normalized));
  assert.ok(Object.isFrozen(normalized.source));
  input.source.pid = 999;
  input.compatibility.manifest.edges[0].target.core = "d".repeat(64);
  assert.equal(normalized.source.pid, source.pid);
  assert.equal(normalized.compatibility.manifest.edges[0].target.core, target.core);
  assert.deepEqual(validateInnerMigrationPlan(normalized, { identity: identity(target), role: "target", now }), normalized);
});

for (const [name, modify] of [
  ["expired", plan => { plan.expiresAt = now; }],
  ["overlong", plan => { plan.expiresAt = now + 300_001; }],
  ["unknown version", plan => { plan.schemaVersion = 2; }],
  ["same process", plan => { plan.target.pid = plan.source.pid; }],
  ["same token", plan => { plan.target.instanceToken = plan.source.instanceToken; }],
  ["unknown field", plan => { plan.account = "SECRET_NOT_ACCEPTED"; }],
  ["unknown target", plan => { plan.target.core = "f".repeat(64); }],
  ["changed manifest", plan => { plan.compatibility.sha256 = "0".repeat(64); }],
]) {
  test(`refuses ${name}`, () => {
    const plan = makePlan(); modify(plan);
    assert.throws(() => validateInnerMigrationPlan(plan, { identity: identity(source), role: "source", now }));
  });
}

test("generation replay and changed source identity or thread are refused", () => {
  assert.throws(() => validateInnerMigrationPlan(makePlan(), { identity: identity(source), role: "source", minimumGeneration: 1, now }), /MIGRATION_PLAN_INVALID/);
  assert.throws(() => validateInnerMigrationPlan(makePlan(), { identity: identity(target), role: "source", now }), /IDENTITY_MISMATCH/);
  assert.throws(() => validateInnerMigrationPlan(makePlan(), { identity: identity(source), role: "source", threadId: "other-thread", now }), /IDENTITY_MISMATCH/);
});

test("same code transfer needs no compatibility extension", () => {
  const plan = makePlan();
  plan.target.core = source.core; plan.compatibility = null;
  assert.equal(validateInnerMigrationPlan(plan, { identity: identity(source), role: "source", now }).compatibility, null);
});
