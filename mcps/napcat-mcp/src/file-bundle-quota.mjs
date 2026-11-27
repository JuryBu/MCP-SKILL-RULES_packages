import { fileBundleRouteScope, sameFileBundleRouteScope } from "./file-bundle-route-scope.mjs";

const shaPattern = /^[a-f0-9]{64}$/u;

function nonnegative(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

export function relayFileQuotaPolicy(limits) {
  const result = {
    maxUploads: limits.maxUploads,
    maxUploadBytes: limits.maxUploadBytes,
    reserveFiles: limits.reserveFiles ?? 2,
    reserveBytes: limits.reserveBytes ?? 0,
    retentionMs: limits.retentionMs ?? 60 * 60 * 1000,
    cleanupBatch: limits.cleanupBatch ?? 4,
  };
  if (Object.values(result).some((value) => !nonnegative(value))
    || result.maxUploads < 1 || result.maxUploadBytes < 1
    || result.cleanupBatch < 1 || result.cleanupBatch > 32) {
    throw Object.assign(new Error("群文件容量配置无效"), { code: "RELAY_FILE_QUOTA_POLICY_INVALID" });
  }
  return result;
}

function measureSpace(quota, policy, incomingBytes) {
  if (!quota || !nonnegative(quota.fileCount) || !nonnegative(quota.fileCapacity)
    || !nonnegative(quota.usedBytes) || !nonnegative(quota.totalBytes)
    || quota.fileCapacity < 1 || quota.totalBytes < 1) return { status: "quota_unknown" };
  if (incomingBytes > quota.totalBytes || incomingBytes > policy.maxUploadBytes) {
    return { status: "too_large" };
  }
  const fileCapacity = Math.min(quota.fileCapacity, policy.maxUploads);
  const freeFiles = fileCapacity - quota.fileCount;
  const freeBytes = quota.totalBytes - quota.usedBytes;
  return {
    status: freeFiles >= 1 && freeBytes >= incomingBytes ? "ready" : "pending_capacity",
    headroom: freeFiles >= Math.min(fileCapacity, 1 + policy.reserveFiles)
      && freeBytes >= incomingBytes + Math.min(policy.reserveBytes, quota.totalBytes - incomingBytes),
  };
}

function sameRoute(record, route) {
  return record.relayId === route.relayId && record.generation === route.generation
    && record.groupId === route.groupId && sameFileBundleRouteScope(record, route);
}

function eligible(record, route, policy, now) {
  return record?.origin === "relay-data-bundle" && sameRoute(record, route)
    && record.state === "received" && record.cleanupState == null
    && record.uploaderId === route.selfQqId
    && typeof record.nativeFileId === "string" && record.nativeFileId.length > 0
    && typeof record.name === "string" && record.name.length > 0
    && typeof record.bundleSha256 === "string" && shaPattern.test(record.bundleSha256)
    && nonnegative(record.bytes) && nonnegative(record.uploadedAt)
    && nonnegative(record.receivedAt) && record.receivedAt >= record.uploadedAt
    && record.receivedAt <= now - policy.retentionMs;
}

function exactFile(file, candidate) {
  return file?.id === candidate.nativeFileId && file?.uploaderId === candidate.uploaderId
    && file?.name === candidate.name && file?.bytes === candidate.bytes;
}

export async function ensureRelayFileSpace({ route, incomingBytes, limits, io, now = Date.now(), signal }) {
  if (!nonnegative(incomingBytes) || incomingBytes < 1 || !nonnegative(now)) {
    throw Object.assign(new Error("待传文件大小或时间无效"), { code: "RELAY_FILE_QUOTA_INPUT_INVALID" });
  }
  const policy = relayFileQuotaPolicy(limits);
  if (incomingBytes > policy.maxUploadBytes) return { status: "too_large", headroom: false, reclaimed: [] };
  const binding = Object.freeze({
    relayId: route.relayId,
    generation: route.generation,
    groupId: route.groupId,
    selfQqId: route.selfQqId,
    ...fileBundleRouteScope(route),
  });
  const reclaimed = [];
  const result = (status, headroom = false) => ({ status, headroom, reclaimed });
  signal?.throwIfAborted();
  if (!(await io.routeStillAuthorized(binding, { signal }))) return result("route_changed");
  let space = measureSpace(await io.readQuota(binding, { signal }), policy, incomingBytes);
  if (space.status === "too_large" || space.status === "quota_unknown" || space.headroom) {
    return result(space.status, space.headroom);
  }
  const records = await io.readFileRecords(binding, { signal });
  const nativeReferences = new Map();
  for (const record of records) {
    if (record?.groupId !== binding.groupId || typeof record.nativeFileId !== "string") continue;
    nativeReferences.set(record.nativeFileId, (nativeReferences.get(record.nativeFileId) ?? 0) + 1);
  }
  const candidates = records
    .filter((record) => eligible(record, binding, policy, now) && nativeReferences.get(record.nativeFileId) === 1)
    .sort((left, right) => left.uploadedAt - right.uploadedAt
      || left.nativeFileId.localeCompare(right.nativeFileId));
  const considered = new Set();
  for (const candidate of candidates) {
    if (considered.size >= policy.cleanupBatch || space.headroom) break;
    if (considered.has(candidate.nativeFileId)) continue;
    considered.add(candidate.nativeFileId);
    signal?.throwIfAborted();
    if (!(await io.routeStillAuthorized(binding, { signal }))) return result("route_changed");
    const file = await io.inspectFile(binding, candidate.nativeFileId, { signal });
    if (!exactFile(file, candidate)) continue;
    if (!(await io.routeStillAuthorized(binding, { signal }))) return result("route_changed");
    signal?.throwIfAborted();
    const outcome = await io.removeOwnedOnce(binding, candidate, file, { signal });
    if (outcome?.status === "unknown") return result("cleanup_unknown");
    if (outcome?.status !== "removed") continue;
    reclaimed.push(candidate.nativeFileId);
    space = measureSpace(await io.readQuota(binding, { signal }), policy, incomingBytes);
    if (space.status === "quota_unknown" || space.status === "too_large") return result(space.status);
  }
  signal?.throwIfAborted();
  if (!(await io.routeStillAuthorized(binding, { signal }))) return result("route_changed");
  return result(space.status, space.headroom);
}
