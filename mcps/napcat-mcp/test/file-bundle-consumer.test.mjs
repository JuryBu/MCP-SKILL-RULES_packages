import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { openFileBundleControlConsumer } from "../src/file-bundle-consumer.mjs";
import { openFileBundleIntegration } from "../src/file-bundle-integration.mjs";
import { openRelayFileJournal, relayFileJournalKey } from "../src/file-bundle-journal.mjs";

const route = { relay_key: "old-qa", group_id: "10001", route_generation: 5 };
const other = { relay_key: "next-qa", group_id: "20001", route_generation: 8 };
const clock = () => 1_790_000_000_000;

function frame(scope, event_id, op = "file_notice", expiresAt = clock() + 1000) {
  return { ...scope, event_id, frame: { op, offer: { expiresAt } } };
}

async function isolated(context) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "napcat-file-consumer-")));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test("文件控制帧只读独立分页，原回执待核时保留进度，重开按同一页接着走", async (context) => {
  const privateRoot = await isolated(context);
  const requests = [];
  const ingested = new Set();
  let upstreamReadable = false;
  const options = {
    privateRoot, now: clock, listScopes: async () => [route, other],
    readVerifiedPage: async ({ relay_key, cursor }) => {
      requests.push([relay_key, cursor]);
      if (relay_key === other.relay_key) {
        return { events: cursor ? [] : [frame(other, "new-operation")], next_cursor: "new-next" };
      }
      return { events: cursor ? [] : [frame(route, "accepted"), frame(route, "needs-original", "file_ack"),
        frame(route, "ordinary-text", "message"), frame(route, "expired", "file_notice", clock() - 1)], next_cursor: "old-next" };
    },
    decodeVerifiedEvent: (event) => ({ ...event.frame, id: event.event_id }),
    ingestControl: async ({ id, op }) => {
      if (id === "needs-original" && !upstreamReadable) return { status: "upload_unverified" };
      ingested.add(id);
      return op === "file_ack" ? { status: "received" } : { direction: "in", state: "waiting_file" };
    },
  };
  let consumer = await openFileBundleControlConsumer(options);
  const first = await consumer.sweep();
  assert.deepEqual(first.map((result) => [result.status, result.processed, result.rejected]),
    [["checking_original", 1, 1], ["read", 1, 0]]);
  upstreamReadable = true;
  consumer = await openFileBundleControlConsumer(options);
  assert.deepEqual((await consumer.sweep()).map((result) => result.status), ["read", "read"]);
  await consumer.sweep({ relayKeys: [route.relay_key] });
  assert.deepEqual(requests.filter(([name]) => name === "old-qa").map(([, cursor]) => cursor), [null, null, "old-next"]);
  assert.deepEqual(requests.filter(([name]) => name === "next-qa").map(([, cursor]) => cursor), [null, "new-next"]);
  assert.deepEqual([...ingested].sort(), ["accepted", "needs-original", "new-operation"]);
});

test("某群游标断档或错群不清零、不消费，另一群继续处理", async (context) => {
  const privateRoot = await isolated(context);
  const processed = [];
  const originals = [];
  let mode = "gap";
  const consumer = await openFileBundleControlConsumer({
    privateRoot, now: clock, listScopes: async () => [route, other],
    readVerifiedPage: async ({ relay_key, cursor }) => {
      originals.push([relay_key, cursor]);
      if (relay_key === route.relay_key) {
        if (mode === "gap") throw Object.assign(new Error("gap"), { code: "RELAY_HISTORY_GAP" });
        if (mode === "returned-gap") return { events: [frame(route, "unproven")], next_cursor: "gap", route_gaps: [route] };
        return { events: [frame(other, "cross-group-frame")], next_cursor: "wrong" };
      }
      return { events: cursor ? [] : [frame(other, "valid-other")], next_cursor: "valid" };
    },
    decodeVerifiedEvent: (item) => ({ ...item.frame, id: item.event_id }),
    ingestControl: ({ id }) => {
      processed.push(id);
      return { direction: "in" };
    },
  });
  assert.deepEqual((await consumer.sweep()).map((result) => result.status), ["history_gap", "read"]);
  mode = "returned-gap";
  assert.deepEqual((await consumer.sweep()).map((result) => result.status), ["history_gap", "read"]);
  mode = "wrong";
  assert.deepEqual((await consumer.sweep()).map((result) => result.status), ["blocked", "read"]);
  assert.deepEqual(originals.filter(([name]) => name === "old-qa").map(([, cursor]) => cursor), [null, null, null]);
  assert.deepEqual(originals.filter(([name]) => name === "next-qa").map(([, cursor]) => cursor), [null, "valid", "valid"]);
  assert.deepEqual(processed, ["valid-other"]);
});

test("一个群的慢查和坏路线不会挡住另一群；原查询未退场时不重新发起", async (context) => {
  const privateRoot = await isolated(context);
  let finishOld;
  let signalOfOld;
  let oldCalls = 0;
  let markOld;
  let markHealthy;
  const started = new Promise((resolve) => { markOld = resolve; });
  const healthy = new Promise((resolve) => { markHealthy = resolve; });
  const original = new Promise((resolve) => { finishOld = resolve; });
  const applied = [];
  const consumer = await openFileBundleControlConsumer({
    privateRoot, now: clock, routeBudgetMs: 1200,
    listScopes: async () => [route, { ...other, relay_key: "bad-scope", route_generation: 0 }, other],
    readVerifiedPage: async ({ relay_key, cursor, signal }) => {
      if (relay_key === route.relay_key) {
        oldCalls += 1;
        signalOfOld = signal;
        markOld();
        return original;
      }
      return { events: cursor ? [] : [frame(other, "separate")], next_cursor: "valid" };
    },
    decodeVerifiedEvent: (item) => ({ ...item.frame, id: item.event_id }),
    ingestControl: ({ id }) => { applied.push(id); markHealthy(); return { direction: "in" }; },
  });
  try {
    const sweep = consumer.sweep();
    const advancedIndependently = await Promise.race([Promise.all([started, healthy]).then(() => true), sweep.then(() => false)]);
    assert.equal(advancedIndependently, true);
    assert.equal(signalOfOld.aborted, false);
    const result = await sweep;
    assert.deepEqual(result.map((row) => row.status), ["checking_original", "blocked", "read"]);
    assert.equal(signalOfOld.aborted, true);
    assert.equal((await consumer.sweep({ relayKeys: [route.relay_key] }))[0].status, "in_progress");
    assert.deepEqual(applied, ["separate"]);
    assert.equal(oldCalls, 1);
  } finally {
    finishOld({ events: [frame(route, "too-late")], next_cursor: "after-timeout" });
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(applied, ["separate"]);
});

test("关闭文件运输会撤下全部入口并保留私有进度，旧工具照常可用", async (context) => {
  const privateRoot = await isolated(context);
  let touched = 0;
  const safe = await openFileBundleIntegration({ enabled: false, get runtimeOptions() { return { privateRoot }; },
    authorizeInvocation: () => { touched += 1; }, relay: { listScopes: () => { touched += 1; } } });
  assert.equal(safe, null);
  assert.equal(touched, 0);
  assert.deepEqual(await fs.readdir(privateRoot), []);
});

test("共享入口装配：长文字和两件文件各过一次原群、重开接续，禁用可热退", async (context) => {
  const root = await isolated(context);
  const spool = path.join(root, "synthetic-group-file");
  const localSources = await Promise.all(["one", "two"].map(async (name) => {
    const filePath = path.join(root, name);
    await fs.writeFile(filePath, name);
    return { name, filePath };
  }));
  const state = { frames: [], files: [], uploads: 0, receiverDisclosure: true };
  const ownerContext = { principal: "test-core" };
  const hash = (value) => createHash("sha256").update(value).digest("hex");

  async function setup(local, enabled = true) {
    const peer = local === "sender" ? "receiver" : "sender";
    const ids = { sender: "11001", receiver: "12002" };
    const privateRoot = path.join(root, local);
    await fs.mkdir(privateRoot, { recursive: true });
    const active = {
      relay_key: route.relay_key, group_id: route.group_id, generation: route.route_generation, channel: "qq",
      local_machine_id: local, peer_machine_id: peer, expected_self_id: ids[local], peer_qq_id: ids[peer],
      role: "active_write", allow_file_bundle_write: true, allow_recipient_list_disclosure: true,
    };
    function exact(target) {
      assert.equal(target, peer);
      return { ...active, allow_recipient_list_disclosure: local === "receiver" ? state.receiverDisclosure : true };
    }
    function verified(item) {
      return item ? { status: "sent_verified", transport_stage: "group_received", outcome_unknown: false,
        ...route, body_sha256: item.frame.body_sha256, onebot_message_id: item.onebot_message_id, real_seq: item.real_seq }
        : { status: "sent_unverified", outcome_unknown: true };
    }
    return openFileBundleIntegration({
      enabled, now: clock,
      authorizeInvocation: async (_, providedContext) => providedContext === ownerContext,
      resolveAttachments: async (attachments) => attachments,
      runtimeOptions: { privateRoot, localMachine: local, oneBot: {
        downloadOrigins: ["https://fixture-files.invalid"], fetchImpl: async () => new Response(await fs.readFile(spool)),
        callOneBot: async (action, input) => {
          assert.equal(input.group_id, route.group_id);
          if (action === "upload_group_file") {
            assert.equal(local, "sender");
            state.uploads += 1;
            await fs.copyFile(input.file, spool);
            state.files.push({ file_id: "group-file", file_name: input.name, uploader: ids[local], file_size: (await fs.stat(spool)).size });
            return { file_id: "group-file" };
          }
          if (action === "get_group_file_system_info") return { file_count: state.files.length,
            used_space: state.files.reduce((bytes, item) => bytes + item.file_size, 0), total_space: 10 ** 8, limit_count: 25 };
          if (action === "get_group_root_files") return { files: state.files, folders: [] };
          if (action === "get_group_file_url") return { url: "https://fixture-files.invalid/file" };
          throw new Error("unexpected native action: " + action);
        },
      } },
      relay: {
        loadAndValidateRelayConfig: () => active,
        resolveRelayRoute: (_, request) => exact(request.target_machine),
        reverifyFrozenRelayRoute: (_, scope) => {
          for (const property of Object.keys(scope)) assert.equal(scope[property], active[property]);
        },
        verifyLiveRoute: (scope) => scope.expected_self_id === ids[local] && scope.peer_qq_id === ids[peer],
        controlAddress: (machine) => `codex/desktop/${machine}-controller`,
        sendPinnedControl: (pinned, request) => {
          assert.deepEqual(pinned, active);
          assert.equal(request.reply_group_id, route.group_id);
          const next = String(state.frames.length + 1);
          const item = { ...route, key: request.dedupe_key, event_id: "event-" + next, onebot_message_id: "message-" + next,
            sender_id: Number(ids[local]), source_machine: local, real_seq: next,
            frame: { op: request.op, from_machine: local, to_machine: peer, body: request.body, body_sha256: hash(request.body) } };
          state.frames.push(item);
          return verified(item);
        },
        inspectPinnedControl: (_, request) => verified(state.frames.find((item) => item.key === request.dedupe_key)),
        listScopes: () => [route],
        readVerifiedPage: ({ cursor }) => {
          const pending = state.frames.slice(cursor ? Number(cursor) : 0);
          return { events: pending.filter((item) => item.frame.to_machine === local), next_cursor: String(state.frames.length) };
        },
      },
    });
  }

  const sender = await setup("sender");
  let receiver = await setup("receiver");
  assert.equal((await sender.listTools(ownerContext)).length, 4);
  assert.deepEqual(await sender.listTools({ principal: "ordinary" }), []);
  const specification = { dedupe_key: "fixture-long-message", target_machine: "receiver", op: "message",
    source: "codex/desktop/test-source", recipients: ["codex/desktop/first", "antigravity/desktop/second"], meta: {},
    payload_json: { text: "一条长消息".repeat(1000), sender_id: "99999" }, attachments: localSources };
  assert.equal((await sender.invoke("napcat_file_bundle_send", specification, ownerContext)).status, "announced");
  const firstPoll = await receiver.invoke("napcat_file_bundle_poll", {}, ownerContext);
  assert.equal(firstPoll.control[0].processed, 1);
  assert.equal((await receiver.invoke("napcat_file_bundle_events_read", {}, ownerContext)).events.length, 0);
  receiver.close();
  assert.deepEqual(await receiver.listTools(ownerContext), []);
  await assert.rejects(receiver.invoke("napcat_file_bundle_poll", {}, ownerContext), { code: "RELAY_FILE_INTEGRATION_DISABLED" });
  assert.equal(await setup("receiver", false), null);
  const uploaded = (await sender.invoke("napcat_file_bundle_poll", {}, ownerContext)).results[0];
  assert.equal(uploaded.status, "uploaded", JSON.stringify(uploaded));
  receiver = await setup("receiver");
  assert.equal((await receiver.invoke("napcat_file_bundle_poll", {}, ownerContext)).results[0].status, "received");
  state.receiverDisclosure = false;
  const hidden = await receiver.invoke("napcat_file_bundle_events_read", {}, ownerContext);
  assert.deepEqual(hidden.events, []);
  assert.equal(hidden.errors[0]?.code, "RELAY_RECIPIENT_DISCLOSURE_BLOCKED");
  state.receiverDisclosure = true;
  const [delivered] = (await receiver.invoke("napcat_file_bundle_events_read", {}, ownerContext)).events;
  assert.equal(delivered.sender_id, "11001");
  assert.equal(delivered.group_id, route.group_id);
  assert.equal(delivered.route_generation, route.route_generation);
  assert.deepEqual(delivered.payload_json, specification.payload_json);
  assert.deepEqual(delivered.recipients, specification.recipients);
  const inbox = await openRelayFileJournal(path.join(root, "receiver", "journal"));
  const inboxKey = relayFileJournalKey("in", "sender", delivered.bundle_id);
  const originalFile = await inbox.read(inboxKey);
  assert.equal(originalFile.value.announcementSenderQqId, "11001");
  const { announcementSenderQqId, ...noOriginalSender } = originalFile.value;
  let stored = originalFile;
  for (const alternative of [noOriginalSender, { ...noOriginalSender, announcementSenderQqId: "99999" }]) {
    stored = await inbox.advance(inboxKey, stored.revision, alternative);
    const refused = await receiver.invoke("napcat_file_bundle_events_read", {}, ownerContext);
    assert.deepEqual(refused.events, []);
    assert.deepEqual(refused.errors, [{ event_id: delivered.event_id, code: "RELAY_FILE_SENDER_UNVERIFIED" }]);
    const notAcknowledged = await receiver.invoke("napcat_file_bundle_events_ack", { event_ids: [delivered.event_id] }, ownerContext);
    assert.deepEqual(notAcknowledged.not_found, [delivered.event_id]);
    assert.deepEqual(notAcknowledged.results, []);
  }
  assert.ok(await inbox.advance(inboxKey, stored.revision, { ...noOriginalSender, announcementSenderQqId }));
  assert.deepEqual(await Promise.all(delivered.staged_files.map(({ filePath }) => fs.readFile(filePath, "utf8"))), ["one", "two"]);
  assert.equal((await receiver.invoke("napcat_file_bundle_poll", {}, ownerContext)).results[0].status, "acknowledged");
  assert.equal((await sender.invoke("napcat_file_bundle_poll", {}, ownerContext)).control[0].processed, 1);
  for (const entry of delivered.staged_files) await fs.copyFile(entry.filePath, path.join(root, "core-" + entry.name));
  assert.equal((await receiver.invoke("napcat_file_bundle_events_ack", { event_ids: [delivered.event_id] }, ownerContext)).results[0].status, "recorded");
  assert.deepEqual((await receiver.invoke("napcat_file_bundle_poll", {}, ownerContext)).maintenance, { archived: 1, needs_review: 0 });
  receiver = await setup("receiver");
  const secondAck = await receiver.invoke("napcat_file_bundle_events_ack", { event_ids: [delivered.event_id] }, ownerContext);
  assert.deepEqual(secondAck, { ok: true, results: [{ event_id: delivered.event_id, status: "recorded", release: "released" }], not_found: [] });
  assert.equal(state.uploads, 1);
  assert.deepEqual(state.frames.map((item) => item.frame.op), ["file_notice", "file_ack"]);
  assert.equal(await fs.readFile(path.join(root, "core-one"), "utf8"), "one");
});
