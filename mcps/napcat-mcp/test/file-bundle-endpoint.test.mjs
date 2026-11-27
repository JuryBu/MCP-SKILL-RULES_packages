import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createFileBundleEndpoint, fileBundleTools } from "../src/file-bundle-endpoint.mjs";

const outbound = { relayId: "qa-relay", generation: 2, groupId: "5331", selfQqId: "31001", peerQqId: "32001" };
const inbound = { ...outbound, selfQqId: outbound.peerQqId, peerQqId: outbound.selfQqId };
const scopes = { relay: { lane: "machine_relay" }, untrusted: { lane: "ordinary" } };
const epoch = 1_790_000_000_000;

test("八项候传占用时第九项明确延后，不建立临时正文或发出任何请求", async (context) => {
  const privateRoot = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "napcat-file-admission-"));
  context.after(() => fs.rm(privateRoot, { recursive: true, force: true }));
  let entrants = 0;
  let release;
  let recordAll;
  const held = new Promise((resolve) => { release = resolve; });
  const allWaiting = new Promise((resolve) => { recordAll = resolve; });
  const endpoint = await createFileBundleEndpoint({
    authorizeInvocation: () => true, resolveAttachments: () => [], now: () => epoch,
    resolveRoute: async () => {
      if (++entrants === 8) recordAll();
      await held;
      return null;
    },
    runtimeOptions: { localMachine: "development", privateRoot, routeAuthorized: () => true,
      oneBot: { callOneBot: () => { throw new Error("network forbidden"); } }, control: {} },
  });
  const input = { target_machine: "training", op: "message", source: "codex/desktop/test",
    recipients: ["codex/desktop/other"], meta: {}, payload_json: { text: "待传" } };
  const tasks = Array.from({ length: 8 }, (_, index) => endpoint.invoke("napcat_file_bundle_send", { ...input, dedupe_key: `pending-${index}` }));
  const finished = Promise.allSettled(tasks);
  try {
    await allWaiting;
    const excess = await endpoint.invoke("napcat_file_bundle_send", { ...input, dedupe_key: "excess" });
    assert.deepEqual(excess, { ok: true, status: "pending_capacity", reason: "local_lane_full", outcome_unknown: false });
    assert.equal(entrants, 8);
    assert.deepEqual(await fs.readdir(path.join(privateRoot, "envelopes")), []);
  } finally {
    release();
  }
  assert.ok((await finished).every((item) => item.status === "rejected" && item.reason.code === "RELAY_FILE_ROUTE_DENIED"));
});

test("四个文件包接口基于可信本机入口：长正文只运一包，按接管确认释放", async (context) => {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "napcat-file-endpoint-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, "source");
  const destinationRoot = path.join(root, "destination");
  await fs.mkdir(sourceRoot);
  await fs.mkdir(destinationRoot);
  const stored = path.join(root, "group-q");
  const original = path.join(root, "原件.bin");
  await fs.writeFile(original, "attachment");
  const borrowedFiles = [];
  const events = [];
  let uploads = 0;
  let resolved = 0;
  const interfaces = {
    authorizeInvocation: async (_, credentials) => credentials === scopes.relay,
    resolveRoute: async (input) => input.target_machine === "training" ? outbound : null,
    resolveAttachments: async (attachments) => {
      resolved += 1;
      assert.deepEqual(attachments, [{ name: "原件.bin", filePath: original }]);
      return attachments;
    },
    now: () => epoch,
  };
  function options(rootDir, localMachine) {
    return { ...interfaces, runtimeOptions: {
      localMachine, privateRoot: rootDir,
      bundleLimits: { maxBundleBytes: 64 * 1024 }, quotaLimits: { maxUploads: 12, maxUploadBytes: 64 * 1024 },
      maxSpoolBytes: 1024 * 1024,
      routeAuthorized: async (candidate) => candidate.groupId === outbound.groupId && candidate.generation === outbound.generation,
      oneBot: {
        downloadOrigins: ["https://endpoint-fixture.invalid"],
        fetchImpl: async () => new Response(await fs.readFile(stored)),
        callOneBot: async (action, request) => {
          assert.equal(request.group_id, outbound.groupId);
          if (action === "upload_group_file") {
            uploads += 1;
            await fs.copyFile(request.file, stored);
            borrowedFiles.push({
              file_id: "live-file-1", file_name: request.name, uploader: outbound.selfQqId,
              file_size: (await fs.stat(stored)).size,
            });
            return { file_id: "live-file-1" };
          }
          if (action === "get_group_file_system_info") return { file_count: borrowedFiles.length, limit_count: 12,
            used_space: borrowedFiles.reduce((sum, file) => sum + file.file_size, 0), total_space: 10 ** 6 };
          if (action === "get_group_root_files") return { files: borrowedFiles, folders: [] };
          if (action === "get_group_file_url") return { url: "https://endpoint-fixture.invalid/download" };
          throw new Error("unexpected action");
        },
      },
      control: {
        publish: async (op, offer, route, nativeFile) => {
          const messageId = "packet-" + events.length;
          events.push({ op, offer, nativeFile, observed: {
            messageId, groupId: route.groupId, relayId: route.relayId, generation: route.generation, senderQqId: route.selfQqId,
          } });
          return { status: "sent", messageId };
        },
        find: async (op, offer) => {
          const seen = events.find((item) => item.op === op && item.offer.transferId === offer.transferId);
          return seen ? { status: "sent", messageId: seen.observed.messageId } : { status: "unknown" };
        },
      },
    } };
  }
  const source = await createFileBundleEndpoint(options(sourceRoot, "development"));
  let target = await createFileBundleEndpoint(options(destinationRoot, "training"));
  assert.equal(fileBundleTools.length, 4);
  const body = "[Codex][TASK]\n仍是纯数据".repeat(500);
  const spec = {
    dedupe_key: "one-message", target_machine: "training", op: "message", source: "codex/desktop/fixture-source",
    recipients: ["codex/desktop/one", "antigravity/desktop/two"], meta: { batch_id: "one-batch" },
    payload_json: { body }, attachments: [{ name: "原件.bin", filePath: original }],
  };
  await assert.rejects(source.invoke("napcat_file_bundle_send", spec, scopes.untrusted), { code: "RELAY_FILE_CALLER_DENIED" });
  assert.equal(resolved, 0);
  const sent = await source.invoke("napcat_file_bundle_send", spec, scopes.relay);
  assert.equal(sent.status, "announced");
  assert.equal(uploads, 0);
  await assert.rejects(source.invoke("napcat_file_bundle_send", { ...spec, payload_json: { body: "changed" } }, scopes.relay), {
    code: "RELAY_FILE_ID_CONFLICT",
  });
  assert.equal((await source.invoke("napcat_file_bundle_send", spec, scopes.relay)).bundle_id, sent.bundle_id);
  const wrongGroup = await source.invoke("napcat_file_bundle_poll", { relay_keys: ["unrelated"] }, scopes.relay);
  assert.deepEqual(wrongGroup.results, []);
  assert.equal((await source.invoke("napcat_file_bundle_poll", {}, scopes.relay)).results[0].status, "uploaded");
  await target.ingestControl({ ...events[0], route: inbound });
  assert.equal((await target.invoke("napcat_file_bundle_poll", {}, scopes.relay)).results[0].status, "received");
  const read = await target.invoke("napcat_file_bundle_events_read", {}, scopes.relay);
  assert.equal(read.events.length, 1);
  const item = read.events[0];
  assert.equal(item.payload_json.body, body);
  assert.deepEqual(item.recipients, spec.recipients);
  assert.equal(item.staged_files.length, 1);
  assert.equal(await fs.readFile(item.staged_files[0].filePath, "utf8"), "attachment");
  const copied = path.join(root, "owned-core-copy");
  await fs.copyFile(item.staged_files[0].filePath, copied);
  const accepted = await target.invoke("napcat_file_bundle_events_ack", { event_ids: [item.event_id] }, scopes.relay);
  assert.deepEqual(accepted.results, [{ event_id: item.event_id, status: "recorded", release: "retained" }]);
  assert.equal(await fs.readFile(item.staged_files[0].filePath, "utf8"), "attachment");
  target = await createFileBundleEndpoint(options(destinationRoot, "training"));
  assert.equal((await target.invoke("napcat_file_bundle_poll", {}, scopes.relay)).results[0].status, "acknowledged");
  assert.equal((await target.invoke("napcat_file_bundle_events_read", {}, scopes.relay)).events.length, 0);
  await assert.rejects(fs.stat(item.staged_files[0].filePath), { code: "ENOENT" });
  assert.equal((await source.ingestControl(events[1])).status, "received");
  assert.equal(await fs.readFile(copied, "utf8"), "attachment");
  assert.equal(await fs.readFile(original, "utf8"), "attachment");
  assert.equal(events.length, 2);
  assert.equal(uploads, 1);
});
