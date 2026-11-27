import assert from "node:assert/strict";
import test from "node:test";
import { ensureRelayFileSpace } from "../src/file-bundle-quota.mjs";

const now = 1_790_000_000_000;
const route = { relayId: "relay-main", generation: 2, groupId: "10000001", selfQqId: "10001" };
const limits = { maxUploads: 5, maxUploadBytes: 4096, reserveFiles: 1, retentionMs: 100, cleanupBatch: 4 };

function record(nativeFileId, uploadedAt, fields = {}) {
  return {
    ...route,
    origin: "relay-data-bundle",
    state: "received",
    nativeFileId,
    name: nativeFileId + ".data",
    bundleSha256: "a".repeat(64),
    uploaderId: route.selfQqId,
    bytes: 100,
    uploadedAt,
    receivedAt: uploadedAt + 1,
    ...fields,
  };
}

function group({ fileCount = 5, records = [], miss = [], mutations = {}, readQuota } = {}) {
  const deleted = [];
  const calls = [];
  const files = new Map(records.map((value) => [value.nativeFileId, {
    id: value.nativeFileId, name: value.name, bytes: value.bytes, uploaderId: value.uploaderId,
  }]));
  const io = {
    async routeStillAuthorized() {
      return mutations.authorized !== false;
    },
    async readQuota() {
      calls.push("quota");
      return readQuota ? readQuota() : { fileCount, fileCapacity: 5, usedBytes: fileCount * 100, totalBytes: 10_000 };
    },
    async readFileRecords() {
      return records;
    },
    async inspectFile(_, nativeFileId) {
      return miss.includes(nativeFileId) ? null : files.get(nativeFileId);
    },
    async removeOwnedOnce(_, candidate, observed) {
      assert.equal(candidate.nativeFileId, observed.id);
      deleted.push(observed.id);
      if (mutations.uncertain) return { status: "unknown" };
      fileCount -= 1;
      return { status: "removed" };
    },
    ...mutations,
  };
  return { io, deleted, calls };
}

test("群档未满也预留位置：仅对已收妥的本协议，按最旧优先", async () => {
  const oldest = record("earliest", now - 350);
  const latest = record("newer", now - 280);
  const pending = record("in-flight", now - 900, { state: "upload_unknown" });
  const someoneElse = record("legacy", now - 800, { origin: "legacy" });
  const recentReceipt = record("still-retained", now - 750, { receivedAt: now - 20 });
  const fixture = group({ fileCount: 4, records: [latest, oldest, pending, someoneElse, recentReceipt] });
  const result = await ensureRelayFileSpace({ route, incomingBytes: 200, limits, io: fixture.io, now });
  assert.deepEqual(result, { status: "ready", headroom: true, reclaimed: ["earliest"] });
  assert.deepEqual(fixture.deleted, ["earliest"]);
  assert.equal(fixture.calls.length, 2);
});

test("同一群档还有未完成引用、文件归属变化或处于另一代时保留", async () => {
  const duplicated = record("duplicate", now - 500);
  const referred = { ...duplicated, state: "uploading", generation: 1 };
  const wrongRoute = record("old-route", now - 600, { generation: 1 });
  const wrongIdentity = record("different-file", now - 700);
  const missing = record("missing", now - 400);
  const fixture = group({
    records: [duplicated, referred, wrongRoute, wrongIdentity, missing],
    mutations: {
      async inspectFile(_, id) {
        assert.equal(["different-file", "missing"].includes(id), true);
        if (id === "missing") return null;
        return { id, name: wrongIdentity.name, bytes: wrongIdentity.bytes, uploaderId: "10002" };
      },
    },
  });
  const result = await ensureRelayFileSpace({ route, incomingBytes: 200, limits, io: fixture.io, now });
  assert.deepEqual(result, { status: "pending_capacity", headroom: false, reclaimed: [] });
  assert.deepEqual(fixture.deleted, []);
});

test("删除结果未明立即保留现场，不能再清另一个候选", async () => {
  const fixture = group({
    records: [record("first", now - 450), record("second", now - 351)],
    mutations: { uncertain: true },
  });
  assert.deepEqual(await ensureRelayFileSpace({ route, incomingBytes: 200, limits, io: fixture.io, now }), {
    status: "cleanup_unknown", headroom: false, reclaimed: [],
  });
  assert.deepEqual(fixture.deleted, ["first"]);
  assert.equal(fixture.calls.length, 1);
});

test("组路由在核原文件后变化就零删；超单档和未知容量如实返回", async () => {
  let checks = 0;
  const fixture = group({
    records: [record("first", now - 501)],
    mutations: {
      async routeStillAuthorized() {
        checks += 1;
        return checks < 3;
      },
    },
  });
  assert.equal((await ensureRelayFileSpace({ route, incomingBytes: 200, limits, io: fixture.io, now })).status, "route_changed");
  assert.equal((await ensureRelayFileSpace({ route, incomingBytes: 5000, limits, io: {}, now })).status, "too_large");
  assert.equal((await ensureRelayFileSpace({
    route, incomingBytes: 200, limits, io: group({ readQuota: () => ({ fileCount: 5 }) }).io, now,
  })).status, "quota_unknown");
  assert.deepEqual(fixture.deleted, []);
});

test("只有本次上传能放下时不谎报预留余量，也不扩大清理对象", async () => {
  const fixture = group({ fileCount: 4, records: [record("waiting", now - 900, { state: "upload_unknown" })] });
  assert.deepEqual(await ensureRelayFileSpace({ route, incomingBytes: 200, limits, io: fixture.io, now }), {
    status: "ready", headroom: false, reclaimed: [],
  });
});
