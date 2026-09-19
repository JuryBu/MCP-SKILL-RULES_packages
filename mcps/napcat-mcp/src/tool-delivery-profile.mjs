import crypto from "node:crypto";

const HASH_PATTERN = /^[0-9a-f]{64}$/u;

export function toolIdentityHash(item) {
  if (!item || typeof item !== "object" || typeof item.name !== "string" || item.name.length === 0) return null;
  if (item.namespace !== undefined && item.namespace !== null && typeof item.namespace !== "string") return null;
  return crypto.createHash("sha256")
    .update(JSON.stringify([item.namespace ?? null, item.name]), "utf8")
    .digest("hex");
}

export function parseToolDeliveryProfile(value) {
  let parsed;
  try {
    parsed = typeof value === "string" ? JSON.parse(value) : value;
  } catch (error) {
    throw new Error(`invalid tool delivery profile JSON: ${error.message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
    || parsed.schemaVersion !== 1 || !Array.isArray(parsed.bufferedToolIdentityHashes)) {
    throw new Error("invalid tool delivery profile schema");
  }
  for (const hash of parsed.bufferedToolIdentityHashes) {
    if (typeof hash !== "string" || !HASH_PATTERN.test(hash)) {
      throw new Error("invalid buffered tool identity hash");
    }
  }
  if (parsed.evidence !== undefined && (parsed.evidence === null || typeof parsed.evidence !== "object")) {
    throw new Error("invalid tool delivery profile evidence");
  }
  return {
    schemaVersion: 1,
    bufferedToolIdentityHashes: [...new Set(parsed.bufferedToolIdentityHashes)],
    ...(parsed.evidence === undefined ? {} : { evidence: parsed.evidence }),
  };
}
