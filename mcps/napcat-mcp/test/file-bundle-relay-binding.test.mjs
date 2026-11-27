import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { createFileBundleRelayBinding } from "../src/file-bundle-relay-binding.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const offer = { from: "development", to: "training", transferId: "12345678-1234-8234-8234-123456789abc" };
const nativeFile = { id: "known-native-file", uploaderId: "10001" };
const request = { target_machine: "training", recipients: ["codex/desktop/one"], meta: {} };
const fixed = {
  relay_key: "test-old", generation: 7, group_id: "10000", channel: "qq", local_machine_id: "development",
  expected_self_id: "10001", peer_machine_id: "training", peer_qq_id: "10002", role: "active_write",
  allow_file_bundle_write: true, legacy_training_coexistence: false, allow_recipient_list_disclosure: true,
};
const original = { reply_relay_key: fixed.relay_key, reply_group_id: fixed.group_id, reply_route_generation: fixed.generation };

function fixture() {
  const routes = new Map([[fixed.relay_key, { ...fixed }]]);
  const state = { active: fixed.relay_key, isLive: true, override: {}, transfers: [] };
  const resolveRelayRoute = (_config, { target_machine, relay_key, expected_group_id, expected_generation, mode }) => {
    const entry = routes.get(mode === "write" ? state.active : relay_key);
    if (!entry || entry.peer_machine_id !== target_machine
      || (expected_group_id !== undefined && entry.group_id !== expected_group_id)
      || (expected_generation !== undefined && entry.generation !== expected_generation)) throw new Error("drift");
    return { ...entry };
  };
  const transact = (kind) => async (route, spec) => {
    state.transfers.push({ kind, route, spec });
    assert.equal(spec.reply_relay_key, route.relay_key);
    assert.equal(spec.reply_group_id, route.group_id);
    assert.equal(spec.reply_route_generation, route.generation);
    return { status: "sent_verified", transport_stage: "group_received", outcome_unknown: false,
      relay_key: route.relay_key, group_id: route.group_id, route_generation: route.generation,
      body_sha256: sha256(spec.body), onebot_message_id: "-7345", real_seq: "12345", ...state.override };
  };
  const binding = createFileBundleRelayBinding({
    configOptions: { bindingPath: "verified-shared-path" },
    loadAndValidateRelayConfig: ({ bindingPath }) => {
      assert.equal(bindingPath, "verified-shared-path");
      return routes;
    },
    resolveRelayRoute,
    reverifyFrozenRelayRoute: (_config, frozen, { allowDraining, requireFileBundleWrite }) => {
      const entry = routes.get(frozen.relay_key);
      if (!entry || Object.entries(frozen).some(([key, value]) => value !== entry[key])
        || (!allowDraining && entry.role !== "active_write")
        || (requireFileBundleWrite && entry.allow_file_bundle_write !== true)) throw new Error("drift");
      return { ...entry };
    },
    verifyLiveRoute: () => state.isLive,
    sendPinnedControl: transact("send"), inspectPinnedControl: transact("inspect"),
    controlAddress: (machine) => `codex/desktop/${machine}-core`,
  });
  return { binding, routes, state };
}

test("pins both ends and the original QQ group; during drain only original work can be checked and acknowledged", async () => {
  const { binding, routes, state } = fixture();
  const route = await binding.resolveRoute(request);
  assert.deepEqual(route, { relayId: "test-old", generation: 7, groupId: "10000", channel: "qq",
    localMachineId: "development", peerMachineId: "training", selfQqId: "10001", peerQqId: "10002", disclosesRecipients: false });
  assert.deepEqual(await binding.control.publish("file_notice", offer, route), { status: "sent", messageId: "-7345" });
  routes.set(fixed.relay_key, { ...fixed, role: "draining_read", allow_file_bundle_write: false });
  routes.set("test-new", { ...fixed, relay_key: "test-new", generation: 8, group_id: "20000" });
  state.active = "test-new";
  assert.equal((await binding.resolveRoute(request)).groupId, "20000");
  await assert.rejects(binding.resolveRoute({ ...request, ...original }), { code: "RELAY_FILE_ROUTE_DENIED" });
  await assert.rejects(binding.resolveRoute({ ...request, reply_relay_key: fixed.relay_key }), { code: "RELAY_FILE_REPLY_ROUTE_UNBOUND" });
  await assert.rejects(binding.resolveRoute({ ...request, reply_group_id: fixed.group_id, reply_route_generation: fixed.generation }), {
    code: "RELAY_FILE_REPLY_ROUTE_UNBOUND",
  });
  for (const purpose of ["prepare", "announce", "upload", "file_space", "delete"]) {
    assert.equal(await binding.routeAuthorized(route, purpose), false, purpose);
  }
  for (const purpose of ["list", "download", "commit_received", "reconcile", "receipt", "reconcile_delete"]) {
    assert.equal(await binding.routeAuthorized(route, purpose), true, purpose);
  }
  assert.equal((await binding.control.publish("file_notice", offer, route)).status, "not_sent");
  assert.equal((await binding.control.find("file_notice", offer, route)).status, "sent");
  assert.equal((await binding.control.publish("file_ack", { ...offer, from: "training", to: "development" }, route, nativeFile)).status, "sent");
  assert.deepEqual(state.transfers.map(({ kind, route: actual }) => [kind, actual.group_id]), [
    ["send", "10000"], ["inspect", "10000"], ["send", "10000"],
  ]);
  routes.set(fixed.relay_key, { ...fixed, peer_qq_id: "10999" });
  assert.equal((await binding.control.find("file_notice", offer, route)).status, "unknown");
  assert.equal(state.transfers.length, 3);
});

test("rejects roster disclosure on a solo target, legacy overlap and non-boolean live authorization", async () => {
  const { binding, routes, state } = fixture();
  const multiple = { ...request, meta: { all_recipients: ["other-machine:agent", "test-machine:agent"] } };
  const staged = await binding.resolveRoute(multiple);
  assert.equal(staged.disclosesRecipients, true);
  await assert.rejects(binding.resolveRoute({ ...multiple, allow_disclose_recipients: false }), {
    code: "RELAY_RECIPIENT_DISCLOSURE_BLOCKED",
  });
  routes.set(fixed.relay_key, { ...fixed, allow_recipient_list_disclosure: false });
  await assert.rejects(binding.resolveRoute(multiple), {
    code: "RELAY_RECIPIENT_DISCLOSURE_BLOCKED",
  });
  assert.equal(await binding.routeAuthorized(staged, "upload"), false);
  assert.equal(await binding.routeAuthorized(staged, "reconcile"), true);
  const previous = await binding.resolveRoute(request);
  routes.set(fixed.relay_key, { ...fixed, legacy_training_coexistence: true });
  assert.equal(await binding.routeAuthorized(previous, "receipt"), false);
  routes.set(fixed.relay_key, { ...fixed });
  state.isLive = { ok: false };
  await assert.rejects(binding.resolveRoute(request), { code: "RELAY_FILE_ROUTE_DENIED" });
  assert.equal(state.transfers.length, 0);
});

test("同群共存时绑定实际文件目录，换目录或关闭共存后旧记录不会改走根目录", async () => {
  const { binding, routes, state } = fixture();
  const rootRoute = await binding.resolveRoute(request);
  const shared = { ...fixed, legacy_training_coexistence: true,
    file_bundle_folder_id: "/actual-id", file_bundle_folder_name: "comm-relay-bundles" };
  routes.set(fixed.relay_key, { ...shared, file_bundle_folder_id: null });
  await assert.rejects(binding.resolveRoute(request), { code: "RELAY_FILE_ROUTE_DENIED" });
  routes.set(fixed.relay_key, shared);
  const pinned = await binding.resolveRoute(request);
  assert.equal(pinned.fileBundleFolderId, shared.file_bundle_folder_id);
  assert.equal(pinned.fileBundleFolderName, shared.file_bundle_folder_name);
  assert.equal(await binding.routeAuthorized(rootRoute, "reconcile"), false);
  assert.equal(await binding.routeAuthorized(pinned, "upload"), true);
  for (const changed of [
    { file_bundle_folder_id: "/different-id" },
    { file_bundle_folder_name: "renamed" },
    { legacy_training_coexistence: false },
  ]) {
    routes.set(fixed.relay_key, { ...shared, ...changed });
    assert.equal(await binding.routeAuthorized(pinned, "delete"), false);
    assert.equal(await binding.routeAuthorized(pinned, "reconcile_delete"), false);
  }
  routes.set(fixed.relay_key, { ...shared, role: "draining_read", allow_file_bundle_write: false });
  assert.equal(await binding.routeAuthorized(pinned, "download"), true);
  assert.equal(await binding.routeAuthorized(pinned, "upload"), false);
  assert.equal((await binding.control.publish("file_ack", offer, pinned, nativeFile)).status, "sent");
  assert.equal(state.transfers[0].route.file_bundle_folder_id, shared.file_bundle_folder_id);
});

test("a control action is only verified by matching route and native message, sequence and body hash", async () => {
  const { binding, state } = fixture();
  const route = await binding.resolveRoute(request);
  for (const override of [
    { outcome_unknown: true }, { group_id: "20000" }, { route_generation: 6 }, { relay_key: "other" },
    { body_sha256: "f".repeat(64) }, { real_seq: "0" }, { onebot_message_id: "" }, { transport_stage: "group_unverified" },
  ]) {
    state.override = override;
    assert.equal((await binding.control.find("file_notice", offer, route)).status, "unknown");
  }
  state.override = { status: "duplicate" };
  assert.equal((await binding.control.find("file_notice", offer, route)).status, "sent");
});

test("an inbound file preannouncement must match the target, authenticated sender, original route and exact body", async () => {
  const { binding } = fixture();
  const body = JSON.stringify({ v: 1, offer: { ...offer, from: "training", to: "development" } });
  const frame = { body, body_sha256: sha256(body), op: "file_notice", from_machine: "training", to_machine: "development" };
  const event = { event_id: "exact-control-origin", relay_key: "test-old", group_id: "10000", route_generation: 7,
    sender_id: "10002", source_machine: "training", frame };
  const decoded = await binding.decodeVerifiedEvent(event);
  assert.equal(decoded.offer.from, "training");
  assert.equal(decoded.route.selfQqId, "10001");
  assert.equal(decoded.observed.messageId, "exact-control-origin");
  for (const changed of [
    { ...event, sender_id: "10099" }, { ...event, source_machine: "untrusted" },
    { ...event, frame: { ...frame, to_machine: "other" } }, { ...event, frame: { ...frame, body: body + " " } },
    { ...event, frame: { ...frame, body: "{", body_sha256: sha256("{") } },
  ]) await assert.rejects(binding.decodeVerifiedEvent(changed), { code: "RELAY_FILE_CONTROL_INVALID" });
  await assert.rejects(binding.decodeVerifiedEvent({ ...event, route_generation: 8 }));
  assert.equal(await binding.decodeVerifiedEvent({ ...event, frame: { ...frame, op: "message" } }), null);
});
