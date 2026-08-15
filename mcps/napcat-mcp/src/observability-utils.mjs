import crypto from "node:crypto";

export function hashIdentity(value) {
  return typeof value === "string" && value.length > 0
    ? crypto.createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16)
    : null;
}

export function correlationQuality(threadHash, turnHash) {
  if (threadHash && turnHash) return "exact";
  if (threadHash || turnHash) return "ambiguous";
  return "none";
}
