import { fixedHandoffCompatibility } from "./inner-handoff-compatibility.mjs";

const fail = code => { throw Object.assign(new Error(code), { code }); };
const hash = value => typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
const identifier = value => typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,128}$/u.test(value);
const exactKeys = (value, expected) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
const sameVersion = (left, right) => left.core === right.core && left.helper === right.helper;

function normalizeInstance(input) {
  if (!exactKeys(input, ["pid", "instanceToken", "core", "helper"])
    || !Number.isSafeInteger(input.pid) || input.pid < 1 || !identifier(input.instanceToken)
    || !hash(input.core) || !hash(input.helper)) fail("MIGRATION_PLAN_INVALID_INSTANCE");
  return Object.freeze({ pid: input.pid, instanceToken: input.instanceToken, core: input.core, helper: input.helper });
}

export function validateInnerMigrationPlan(input, { identity, role, threadId, minimumGeneration = 0, now = Date.now() } = {}) {
  if (!exactKeys(input, ["schemaVersion", "id", "generation", "threadId", "expiresAt", "source", "target", "compatibility"])
    || input.schemaVersion !== 1 || !identifier(input.id) || !Number.isSafeInteger(input.generation)
    || input.generation <= minimumGeneration || typeof input.threadId !== "string"
    || input.threadId.length < 1 || input.threadId.length > 512 || input.threadId.includes("\0")
    || !Number.isSafeInteger(input.expiresAt) || input.expiresAt <= now || input.expiresAt > now + 300_000
    || !["source", "target"].includes(role)) fail("MIGRATION_PLAN_INVALID");
  const source = normalizeInstance(input.source);
  const target = normalizeInstance(input.target);
  if (source.pid === target.pid || source.instanceToken === target.instanceToken) fail("MIGRATION_PLAN_SAME_INSTANCE");
  const selected = role === "source" ? source : target;
  if (identity?.pid !== selected.pid || identity?.instanceToken !== selected.instanceToken
    || identity?.sourceHashes?.core !== selected.core || identity?.sourceHashes?.helper !== selected.helper
    || (threadId !== undefined && input.threadId !== threadId)) fail("MIGRATION_PLAN_IDENTITY_MISMATCH");
  const compatibility = fixedHandoffCompatibility(input.compatibility ?? undefined);
  if (!sameVersion(source, target) && !compatibility?.manifest.edges.some(edge => sameVersion(edge.source, source)
    && sameVersion(edge.target, target))) fail("MIGRATION_PLAN_VERSION_NOT_ALLOWED");
  return Object.freeze({ schemaVersion: 1, id: input.id, generation: input.generation, threadId: input.threadId,
    expiresAt: input.expiresAt, source, target, compatibility });
}
