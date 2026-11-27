import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createFileBundleCapacity } from "../src/file-bundle-capacity.mjs";
import { openRelayFileJournal, relayFileJournalKey } from "../src/file-bundle-journal.mjs";
import { createFileBundleOneBot } from "../src/file-bundle-onebot.mjs";

const epoch = 1_790_000_000_000;
const route = { relayId: "qq-private-relay", generation: 4, groupId: "10101", selfQqId: "70101", peerQqId: "70102" };
const digest = (value) => createHash("sha256").update(value).digest("hex");

async function fixture(context) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "napcat-qq-file-proof-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const workRoot = path.join(root, "files");
  const journalRoot = path.join(root, "journal");
  await fs.mkdir(workRoot);
  await fs.mkdir(journalRoot);
  const journal = await openRelayFileJournal(journalRoot);
  const calls = [];
  const files = [];
  const settings = { allow: true, dropDeleteReply: false, folders: [], capacity: 3, reportZeroBytes: false };
  const routeAuthorized = async (target) => settings.allow && target.groupId === route.groupId && target.generation === route.generation;
  const onebot = async (action, params) => {
    assert.equal(params.group_id, route.groupId);
    calls.push(action);
    if (action === "get_group_file_system_info") return {
      file_count: String(files.length), limit_count: settings.capacity,
      used_space: settings.reportZeroBytes ? 0 : files.reduce((total, file) => total + file.file_size, 0), total_space: 10000,
    };
    if (action === "get_group_root_files") return { files: structuredClone(files), folders: settings.folders };
    if (action === "upload_group_file") {
      assert.equal(path.relative(workRoot, params.file), "source.data");
      const file_id = "expected-file-id";
      files.push({ file_id, file_name: params.name, file_size: (await fs.stat(params.file)).size, uploader: route.selfQqId, busid: 123 });
      return { file_id };
    }
    if (action === "get_group_file_url") {
      assert.equal(params.busid, 123);
      return { url: settings.url ?? "https://files.fixture.invalid/transfer" };
    }
    if (action === "delete_group_file") {
      const index = files.findIndex((file) => file.file_id === params.file_id);
      assert.notEqual(index, -1);
      files.splice(index, 1);
      if (settings.dropDeleteReply) throw new Error("reply dropped after applying delete");
      return {};
    }
    throw new Error("unexpected action");
  };
  const adapter = (fetchImpl) => createFileBundleOneBot({
    workRoot, callOneBot: onebot, routeAuthorized, downloadOrigins: ["https://files.fixture.invalid"], fetchImpl,
  });
  async function remember(file, { direction = "out", state = "received", originalRoute = route, age = 10800 } = {}) {
    const transferId = randomUUID();
    const key = relayFileJournalKey(direction, "development", transferId);
    await journal.advance(key, null, {
      direction, route: originalRoute, state,
      offer: { transferId, sha256: digest(file.file_name), from: "development" },
      file: { id: file.file_id, name: file.file_name, bytes: file.file_size, uploaderId: file.uploader },
      uploadedAt: epoch - age - 1, receivedAt: epoch - age,
    });
    return key;
  }
  return { calls, files, settings, workRoot, journalRoot, journal, adapter, remember, routeAuthorized };
}

test("群非空却回报使用零字节时，仅凭完整根目录恢复用量，无法核清即保留旧档", async (context) => {
  const fixtureState = await fixture(context);
  fixtureState.settings.reportZeroBytes = true;
  fixtureState.files.push({ file_id: "known-1", file_name: "one.data", file_size: 660, uploader: route.peerQqId },
    { file_id: "known-2", file_name: "two.data", file_size: 440, uploader: route.selfQqId });
  const adapter = await fixtureState.adapter();
  assert.deepEqual(await adapter.readQuota(route), { fileCount: 2, fileCapacity: 3, usedBytes: 1100, totalBytes: 10000 });
  fixtureState.settings.folders = [{ folder_id: "unexamined" }];
  assert.equal((await adapter.readQuota(route)).usedBytes, null);
  assert.ok(fixtureState.calls.every((action) => ["get_group_file_system_info", "get_group_root_files"].includes(action)));
});

test("本机释放同时改账时仍合并同次删除的明确未送，重开不假报未知", async (context) => {
  const isolated = await fixture(context);
  isolated.settings.capacity = 2;
  const first = { file_id: "oldest-owned", file_name: "oldest.ncp", file_size: 200, uploader: route.selfQqId };
  const second = { file_id: "still-in-use", file_name: "keep.data", file_size: 180, uploader: route.peerQqId };
  isolated.files.push(first, second);
  const originalKey = await isolated.remember(first, { age: 40000 });
  const provider = await isolated.adapter();
  const basis = { localMachine: "development", routeAuthorized: isolated.routeAuthorized, now: () => epoch,
    limits: { maxUploads: 2, maxUploadBytes: 1000, cleanupBatch: 1, retentionMs: 0 } };
  const deniedBeforeEffect = { ...provider, removeConfirmedFile: async () => {
    const prior = await isolated.journal.read(originalKey);
    assert.equal(prior.value.cleanupState, "deleting");
    const releasing = await isolated.journal.advance(prior.key, prior.revision, { ...prior.value, releaseState: "releasing" });
    await isolated.journal.advance(releasing.key, releasing.revision, { ...releasing.value, releaseState: "released" });
    return { status: "not_sent" };
  } };
  const cause = createFileBundleCapacity({ ...basis, journal: isolated.journal, provider: deniedBeforeEffect });
  assert.equal((await cause.ensureSpace({ bytes: 90 }, route)).status, "pending_capacity");
  assert.deepEqual(isolated.files.map((file) => file.file_id), [first.file_id, second.file_id]);
  assert.ok(!isolated.calls.includes("delete_group_file"));
  const reopened = await openRelayFileJournal(isolated.journalRoot);
  const original = await reopened.read(originalKey);
  assert.equal(original.value.cleanupState, null);
  assert.equal(original.value.releaseState, "released");
  const restart = createFileBundleCapacity({ ...basis, journal: reopened, provider });
  assert.deepEqual(await restart.reconcile(route), []);
  assert.equal((await restart.ensureSpace({ bytes: 90 }, route)).status, "ready");
  assert.deepEqual(isolated.files.map((file) => file.file_id), [second.file_id]);
  assert.equal(isolated.calls.filter((action) => action === "delete_group_file").length, 1);
  assert.equal((await reopened.read(originalKey)).value.cleanupState, "removed");
});

test("按 OneBot 原生字段定位上传和附件，源校验失败不发下载", async (context) => {
  const sample = await fixture(context);
  const data = Buffer.from("pure data");
  const offer = { name: "pack.ncp", bytes: data.length, sha256: digest(data) };
  let requested = 0;
  const provider = await sample.adapter(async (url, options) => {
    requested += 1;
    assert.equal(url.origin, "https://files.fixture.invalid");
    assert.equal(options.redirect, "error");
    return new Response(data);
  });
  assert.equal((await provider.readQuota(route)).usedBytes, 0);
  const source = path.join(sample.workRoot, "source.data");
  await fs.writeFile(source, data);
  const result = await provider.upload(offer, route, source);
  assert.deepEqual(result.file, { id: "expected-file-id", name: offer.name, bytes: offer.bytes, uploaderId: route.selfQqId, busId: 123 });
  assert.equal(sample.calls.filter((call) => call === "upload_group_file").length, 1);
  const inbound = { ...route, selfQqId: route.peerQqId, peerQqId: route.selfQqId };
  const destination = path.join(sample.workRoot, "received.data");
  sample.settings.url = "https://untrusted.fixture.invalid/transfer";
  await assert.rejects(provider.download(offer, inbound, result.file, destination), { code: "RELAY_FILE_URL_DENIED" });
  assert.equal(requested, 0);
  delete sample.settings.url;
  await provider.download(offer, inbound, result.file, destination);
  assert.deepEqual(await fs.readFile(destination), data);
  await assert.rejects(provider.download(offer, inbound, result.file, destination), { code: "EEXIST" });
  assert.deepEqual(await fs.readFile(destination), data);
  sample.files.push({ ...sample.files[0] });
  assert.equal((await provider.findUpload(offer, route, route.selfQqId)).status, "unknown");
});

test("容量不足自动回收旧包，未明后重启只核原删除", async (context) => {
  const sample = await fixture(context);
  const selected = { file_id: "eligible-old", file_name: "owned-old.ncp", file_size: 111, uploader: route.selfQqId };
  const bystander = { file_id: "older-bystander", file_name: "user-list.txt", file_size: 120, uploader: route.peerQqId };
  const waiting = { file_id: "waiting", file_name: "waiting.ncp", file_size: 100, uploader: route.selfQqId };
  sample.files.push(bystander, waiting, selected);
  const original = await sample.remember(selected);
  await sample.remember(waiting, { state: "uploaded", age: 30000 });
  const provider = await sample.adapter();
  const limits = { maxUploads: 3, maxUploadBytes: 2048, reserveFiles: 0, retentionMs: 10000 };
  const capacity = (journal) => createFileBundleCapacity({
    localMachine: "development", journal, provider, routeAuthorized: sample.routeAuthorized, limits, now: () => epoch,
  });
  sample.settings.dropDeleteReply = true;
  const result = await capacity(sample.journal).ensureSpace({ bytes: 120 }, route);
  assert.equal(result.status, "cleanup_unknown");
  assert.equal((await sample.journal.read(original)).value.cleanupState, "deleting");
  assert.deepEqual(sample.files.map((file) => file.file_id), [bystander.file_id, waiting.file_id]);
  const reopened = await openRelayFileJournal(sample.journalRoot);
  assert.deepEqual(await capacity(reopened).reconcile(route), [{ nativeFileId: selected.file_id, status: "removed" }]);
  assert.equal((await reopened.read(original)).value.cleanupState, "removed");
  assert.equal(sample.calls.filter((call) => call === "delete_group_file").length, 1);
  assert.equal((await capacity(reopened).ensureSpace({ bytes: 120 }, route)).status, "ready");
});

test("根目录不完整时不假定原文件已删除", async (context) => {
  const sample = await fixture(context);
  const provider = await sample.adapter();
  sample.settings.folders.push({ folder_id: "not-scanned" });
  assert.equal(await provider.inspectAbsence(route, "old-native-id"), null);
  sample.settings.folders.length = 0;
  const repeated = { file_id: "duplicate-observation", file_name: "reply.data", file_size: 12, uploader: route.selfQqId };
  sample.files.push(repeated, { ...repeated });
  assert.equal(await provider.inspectAbsence(route, "old-native-id"), null);
  assert.equal(sample.calls.filter((call) => call === "delete_group_file").length, 0);
});
