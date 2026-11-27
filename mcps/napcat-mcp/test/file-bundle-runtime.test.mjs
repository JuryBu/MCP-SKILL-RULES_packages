import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createFileBundleRuntime } from "../src/file-bundle-runtime.mjs";
import { createRelayFileOffer } from "../src/file-bundle-transfer.mjs";

test("完整隔离入口：可靠原路收发、重开续查、到手后释放工作副本", async (context) => {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "napcat-file-runtime-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const epoch = 1_790_000_000_000;
  const senderRoot = path.join(root, "development");
  const receiverRoot = path.join(root, "training");
  await fs.mkdir(senderRoot);
  await fs.mkdir(receiverRoot);
  const actual = path.join(root, "source.ref");
  const transferred = path.join(root, "onebot.file");
  await fs.writeFile(actual, "原文件这边也要留");
  const senderRoute = { relayId: "staged", generation: 8, groupId: "311", selfQqId: "7081", peerQqId: "7082" };
  const receiverRoute = { ...senderRoute, selfQqId: senderRoute.peerQqId, peerQqId: senderRoute.selfQqId };
  const deployedFileList = [];
  const wire = [];
  let opens = 0;
  let uploadCount = 0;
  let releaseAllowed = false;
  let allow = false;
  const options = {
    bundleLimits: { maxBundleBytes: 4096 },
    quotaLimits: { maxUploads: 12, maxUploadBytes: 4096 },
    maxSpoolBytes: 8192,
    now: () => epoch,
    routeAuthorized: async (route) => allow && route.groupId === senderRoute.groupId && route.generation === senderRoute.generation,
    resolveLocalFiles: async (refs) => {
      opens += 1;
      assert.deepEqual(refs, ["attachment-ref"]);
      return [{ filePath: actual, name: "附件.txt" }];
    },
    canReleaseIncoming: async (record, evidence) => evidence === "core-copy-persisted" ? releaseAllowed : false,
    oneBot: {
      downloadOrigins: ["https://runtime-fixture.invalid"],
      fetchImpl: async () => new Response(await fs.readFile(transferred)),
      callOneBot: async (action, params) => {
        assert.equal(params.group_id, senderRoute.groupId);
        if (action === "upload_group_file") {
          uploadCount += 1;
          await fs.copyFile(params.file, transferred);
          deployedFileList.push({ file_id: "runtime-id-1", file_name: params.name, uploader: 7081,
            file_size: (await fs.stat(transferred)).size });
          return { file_id: "runtime-id-1" };
        }
        if (action === "get_group_file_system_info") return {
          file_count: deployedFileList.length, limit_count: 12, total_space: 100_000,
          used_space: deployedFileList.reduce((sum, item) => sum + item.file_size, 0),
        };
        if (action === "get_group_root_files") return { folders: [], files: deployedFileList };
        if (action === "get_group_file_url") return { url: "https://runtime-fixture.invalid/download" };
        throw new Error("unexpected action");
      },
    },
    control: {
      publish: async (op, offer, route, file) => {
        const messageId = "msg-" + wire.length;
        wire.push({ op, offer, file, observed: {
          messageId, groupId: route.groupId, relayId: route.relayId, generation: route.generation, senderQqId: route.selfQqId,
        } });
        return { status: "sent", messageId };
      },
      find: async (op, offer) => {
        const found = wire.find((item) => item.op === op && item.offer.transferId === offer.transferId);
        return found ? { status: "sent", messageId: found.observed.messageId } : { status: "unknown" };
      },
    },
  };
  const reload = (machine, privateRoot) => createFileBundleRuntime({ ...options, localMachine: machine, privateRoot });
  let sender = await reload("development", senderRoot);
  let receiver = await reload("training", receiverRoot);
  const transferId = randomUUID();
  const request = { transferId, route: senderRoute, to: "training", files: ["attachment-ref"], expiresAt: epoch + 60_000 };
  await assert.rejects(sender.prepare(request), { code: "RELAY_FILE_SEND_DENIED" });
  assert.equal(opens, 0);
  allow = true;
  assert.equal((await sender.prepare(request)).status, "prepared");
  assert.equal((await sender.prepare(request)).status, "existing");
  await assert.rejects(sender.prepare({ ...request, files: ["different-reference"] }), { code: "RELAY_FILE_ID_CONFLICT" });
  assert.equal(opens, 1);
  assert.equal((await sender.resume()).results[0].status, "announced");
  sender = await reload("development", senderRoot);
  assert.equal((await sender.resume()).results[0].status, "uploaded");
  assert.equal(uploadCount, 1);
  assert.deepEqual(await receiver.resume(), { results: [], next: null });
  assert.equal(wire.length, 1);
  await receiver.acceptAnnouncement({ ...wire[0], route: receiverRoute });
  assert.equal((await receiver.resume()).results[0].status, "received");
  const ready = await receiver.lookupIncoming("development", transferId);
  assert.equal(await fs.readFile(ready.staged.files[0].filePath, "utf8"), "原文件这边也要留");
  receiver = await reload("training", receiverRoot);
  assert.equal((await receiver.resume()).results[0].status, "acknowledged");
  assert.equal(wire.length, 2);
  assert.equal((await sender.acceptReceipt({ ...wire[1], nativeFile: wire[1].file })).status, "received");
  assert.equal((await sender.release({ direction: "out", transferId })).status, "released");
  assert.equal((await sender.lookupOutgoing(transferId)).releaseState, "released");
  assert.equal(await fs.readFile(actual, "utf8"), "原文件这边也要留");
  const inbound = { direction: "in", source: "development", transferId, confirmation: "core-copy-persisted" };
  assert.equal((await receiver.release(inbound)).status, "retained");
  releaseAllowed = { ok: false, status: "not_persisted" };
  assert.equal((await receiver.release(inbound)).status, "retained");
  assert.equal(await fs.readFile(ready.staged.files[0].filePath, "utf8"), "原文件这边也要留");
  releaseAllowed = true;
  const stagedPath = ready.staged.files[0].filePath;
  const expectedBytes = await fs.readFile(stagedPath);
  const wrongBytes = Buffer.alloc(expectedBytes.length, 88);
  await fs.writeFile(stagedPath, wrongBytes);
  await assert.rejects(receiver.release(inbound), { code: "RELAY_FILE_LOCAL_RELEASE_DENIED" });
  assert.deepEqual(await fs.readFile(stagedPath), wrongBytes);
  assert.equal((await receiver.lookupIncoming("development", transferId)).releaseState, "releasing");
  await fs.writeFile(stagedPath, expectedBytes);
  assert.equal((await receiver.release(inbound)).status, "released");
  assert.equal((await receiver.release(inbound)).status, "released");
  await assert.rejects(fs.stat(ready.staged.files[0].filePath), { code: "ENOENT" });
  assert.equal(uploadCount, 1);
});

test("单包永久超限、候传不足和待收留存不足各有边界；无空间不启动上传或下载", async (context) => {
  const temporary = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "napcat-bundle-limits-"));
  context.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const clock = 1_790_000_000_000;
  const route = { relayId: "bounds", generation: 1, groupId: "10001", selfQqId: "11001", peerQqId: "12002" };
  const regular = path.join(temporary, "normal.bin");
  const tooLarge = path.join(temporary, "large.bin");
  await fs.writeFile(regular, Buffer.alloc(3000, 42));
  await fs.writeFile(tooLarge, Buffer.alloc(5000, 42));
  let network = 0;
  const runtime = await createFileBundleRuntime({
    localMachine: "first", privateRoot: temporary, now: () => clock, maxSpoolBytes: 8192,
    bundleLimits: { maxBundleBytes: 4096 }, routeAuthorized: () => true, resolveLocalFiles: (files) => files,
    oneBot: { callOneBot: () => { network += 1; throw new Error("unexpected network"); } }, control: {},
  });
  const prepare = (filePath) => ({ to: "second", route, transferId: randomUUID(),
    expiresAt: clock + 30_000, files: [{ name: "part", filePath }] });
  const invalid = prepare(tooLarge);
  await assert.rejects(runtime.prepare(invalid), { code: "RELAY_BUNDLE_TOO_LARGE" });
  assert.equal(await runtime.lookupOutgoing(invalid.transferId), null);
  const first = await runtime.prepare(prepare(regular));
  const second = await runtime.prepare(prepare(regular));
  assert.equal(first.status, "prepared");
  assert.equal(second.status, "prepared");
  assert.ok(first.offer.bytes + second.offer.bytes <= 8192);
  const deferred = prepare(regular);
  assert.deepEqual(await runtime.prepare(deferred), { status: "local_capacity_full" });
  assert.equal(await runtime.lookupOutgoing(deferred.transferId), null);
  assert.equal((await fs.readdir(path.join(temporary, "files"))).length, 2);
  const notice = createRelayFileOffer({ from: "second", to: "first", transferId: randomUUID(), route,
    bytes: 1800, sha256: "1".repeat(64), createdAt: clock, expiresAt: clock + 30_000 });
  await runtime.acceptAnnouncement({ offer: notice, route,
    observed: { groupId: route.groupId, senderQqId: route.peerQqId, relayId: route.relayId, generation: 1, messageId: "original" } });
  assert.deepEqual(await runtime.receive("second", notice.transferId), { status: "local_capacity_full" });
  assert.equal((await runtime.lookupIncoming("second", notice.transferId)).state, "waiting_file");
  assert.equal(network, 0);
});
