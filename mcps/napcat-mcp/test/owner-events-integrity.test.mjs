import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createNapCatNotifier } from "../src/core.mjs";
import { createControlState } from "../src/control-state.mjs";
import { createControlPlane } from "../src/control-plane.mjs";
import { OWNER_REPLY_EVENT_LIMITS } from "../src/owner-reply-events.mjs";

async function fixture(context, options = {}) {
  const temporaryParent = path.resolve(os.tmpdir());
  const root = fs.mkdtempSync(path.join(temporaryParent, "napcat-owner-integrity-"));
  const statePath = path.join(root, "control-state.json");
  const history = [];
  const calls = [];
  const readInputs = [];
  const wakes = [];
  const unexpectedActions = [];
  let wakeOutcome = "accepted";
  const server = http.createServer(async (request, response) => {
    const action = new URL(request.url, "http://127.0.0.1").pathname.slice(1);
    for await (const chunk of request) void chunk;
    calls.push(action);
    const data = {
      get_status: { online: true, good: true },
      get_login_info: { user_id: "1000000001", nickname: "IntegrityTestBot" },
      get_friend_list: [{ user_id: "1999000001", nickname: "SyntheticOwner" }],
      get_friend_msg_history: { messages: history },
    };
    if (!Object.hasOwn(data, action)) unexpectedActions.push(action);
    response.writeHead(Object.hasOwn(data, action) ? 200 : 500, { "Content-Type": "application/json" });
    response.end(JSON.stringify(Object.hasOwn(data, action)
      ? { status: "ok", retcode: 0, data: data[action] }
      : { status: "failed", retcode: 1, wording: "only synthetic read-only endpoints are available" }));
  });
  context.after(async () => {
    if (server.listening) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    assert.equal(path.dirname(root), temporaryParent);
    assert.ok(path.basename(root).startsWith("napcat-owner-integrity-"));
    fs.rmSync(root, { recursive: true, force: true });
    assert.deepEqual(unexpectedActions, []);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const bindingPath = path.join(root, "binding.json");
  fs.writeFileSync(bindingPath, JSON.stringify({
    schemaVersion: 2, bindingName: "owner-integrity-test", expectedSelfId: "1000000001", expectedNickname: "IntegrityTestBot",
    groupId: "123456789", groupName: "SyntheticGroup", expectedMemberCount: 4,
    allowedEvents: ["test"], minimumHeartbeatMinutes: 5, dedupeRetentionDays: 30,
    requireGroupIdentityCheckBeforeSend: true, requireMessageVerification: true,
    controlPlane: {
      enabled: true, localMachine: "development", defaultTargetKey: "owner-private",
      targets: { "owner-private": { type: "private", id: "1999000001", name: "SyntheticOwner" } },
    },
  }), "utf8");
  const now = () => new Date("2026-11-15T15:00:00.000Z");
  const nativeNotifier = createNapCatNotifier({ cwd: root, now, env: {
    USERPROFILE: root, NAPCAT_HTTP_URL: `http://127.0.0.1:${server.address().port}`,
    NAPCAT_ACCESS_TOKEN: "synthetic-loopback-only-token", NAPCAT_MCP_BINDING_PATH: bindingPath,
    NAPCAT_MCP_STATE_PATH: path.join(root, "unused-dedupe.json"), NAPCAT_HTTP_TIMEOUT_MS: "2000",
  } });
  const notifier = { ...nativeNotifier, readConfiguredTargetMessages: async (input) => {
    readInputs.push(structuredClone(input));
    const result = await nativeNotifier.readConfiguredTargetMessages(input);
    if (options.omitContentMarker) for (const message of result.messages) delete message.ownerEventContent;
    return result;
  } };
  const bridge = { wake: async (input) => {
    wakes.push(structuredClone(input));
    return { outcome: wakeOutcome, started: wakeOutcome === "accepted", turn: { id: `test-turn-${wakes.length}` } };
  } };
  const newState = () => createControlState({ statePath, now });
  const newControl = (state) => createControlPlane({ notifier, state, bridge, now });
  const state = newState();
  const control = newControl(state);
  await control.registerOwnerRoute({
    route_key: "integrity-route", conversation_id: "integrity-chat", target_key: "owner-private",
    ...(options.capture === false ? {} : { capture_owner_events: true }),
  });
  state.recordOwnerAlertMessage({ messageId: "500", routeKey: "integrity-route", targetKey: "owner-private" });
  const readArguments = {
    route_key: "integrity-route", conversation_id: "integrity-chat", original_qq_message_id: "500", expected_route_generation: 1,
  };
  return {
    root, statePath, state, control, calls, readInputs, wakes, nativeNotifier,
    read: (reader = control) => reader.readOwnerEvents(readArguments),
    reload: () => {
      const reloadedState = newState();
      return { state: reloadedState, control: newControl(reloadedState) };
    },
    setWakeOutcome: (outcome) => { wakeOutcome = outcome; },
    textReply: (sequence, body, representation = "raw") => history.push({
      message_id: String(1000 + sequence), message_seq: String(sequence), time: 1794754860 + sequence,
      user_id: "1999000001", sender: { user_id: "1999000001", nickname: "SyntheticOwner" },
      message: [{ type: "reply", data: { id: "500" } }, { type: "text", data: { text: body.slice(0, Math.floor(body.length / 2)) } },
        { type: "text", data: { text: body.slice(Math.floor(body.length / 2)) } }],
      ...(representation === "raw" ? { raw_message: body } : {}),
    }),
    mediaReply: (sequence) => history.push({
      message_id: String(1000 + sequence), message_seq: String(sequence), time: 1794754860 + sequence,
      user_id: "1999000001", sender: { user_id: "1999000001", nickname: "SyntheticOwner" },
      message: [{ type: "reply", data: { id: "500" } }, { type: "image", data: { file: "synthetic.png" } }],
      raw_message: "[CQ:reply,id=500][CQ:image,file=synthetic.png]",
    }),
  };
}

function failNextAtomicWrite(context, subject, methodName) {
  const originalMethod = subject.state[methodName].bind(subject.state);
  const failures = [];
  let injected = false;
  const directory = path.dirname(subject.statePath);
  const prefix = `.${path.basename(subject.statePath)}.`;
  subject.state[methodName] = (...args) => {
    if (injected) return originalMethod(...args);
    const originalOpen = fs.openSync;
    const originalFsync = fs.fsyncSync;
    const temporaryDescriptors = new Set();
    fs.openSync = (filePath, ...openArguments) => {
      const descriptor = originalOpen(filePath, ...openArguments);
      if (typeof filePath === "string" && path.dirname(filePath) === directory
        && path.basename(filePath).startsWith(prefix) && filePath.endsWith(".tmp")) temporaryDescriptors.add(descriptor);
      return descriptor;
    };
    fs.fsyncSync = (descriptor) => {
      if (!injected && temporaryDescriptors.has(descriptor)) {
        injected = true;
        throw Object.assign(new Error("single isolated state tempfile fsync failure"), { code: "EIO" });
      }
      return originalFsync(descriptor);
    };
    try { return originalMethod(...args); } catch (error) {
      failures.push(error.code);
      throw error;
    } finally {
      fs.openSync = originalOpen;
      fs.fsyncSync = originalFsync;
    }
  };
  context.after(() => { subject.state[methodName] = originalMethod; });
  return () => {
    assert.equal(injected, true, `${methodName} must execute a real atomic state-file write`);
    assert.deepEqual(failures, ["STATE_WRITE_FAILED"]);
    assert.equal(fs.existsSync(`${subject.statePath}.lock`), false);
  };
}

for (const representation of ["raw", "segments"]) {
  test(`native ${representation} content is complete while the legacy preview remains 2000 characters`, async (context) => {
    const subject = await fixture(context);
    const body = `${"原生文本".repeat(650)}VISIBLE_NATIVE_END`;
    subject.textReply(7, body, representation);
    const preview = await subject.nativeNotifier.readConfiguredTargetMessages({ target_key: "owner-private" });
    assert.equal(preview.messages[0].text.length, 2000);
    assert.equal(Object.hasOwn(preview.messages[0], "ownerEventContent"), false);
    const complete = await subject.nativeNotifier.readConfiguredTargetMessages({ target_key: "owner-private", include_owner_event_content: true });
    assert.equal(complete.messages[0].text, preview.messages[0].text);
    assert.ok(complete.messages[0].ownerEventContent.text.endsWith(body));
    await subject.control.scanOwnerReplies();
    assert.equal(subject.readInputs.at(-1).include_owner_event_content, true);
    const before = fs.readFileSync(subject.statePath);
    const callCount = subject.calls.length;
    const page = subject.read();
    assert.deepEqual(page.events.map((event) => event.message_seq), [7]);
    assert.equal(page.events[0].text, complete.messages[0].ownerEventContent.text);
    assert.equal(page.partial, false);
    assert.equal(page.next_cursor, null);
    assert.deepEqual(fs.readFileSync(subject.statePath), before);
    assert.equal(subject.calls.length, callCount);
    assert.equal(subject.wakes.length, 1);
    assert.equal(subject.wakes[0].generation, 1);
    assert.ok(subject.wakes[0].prompt.endsWith(preview.messages[0].text));
  });

  test(`native ${representation} content over 1 MiB is unavailable rather than a complete preview`, async (context) => {
    const subject = await fixture(context);
    const body = "原".repeat(Math.floor(OWNER_REPLY_EVENT_LIMITS.cacheBytes / 3) + 1);
    subject.textReply(7, body, representation);
    const complete = await subject.nativeNotifier.readConfiguredTargetMessages({ target_key: "owner-private", include_owner_event_content: true });
    assert.equal(complete.messages[0].text.length, 2000);
    assert.equal(typeof complete.messages[0].ownerEventContent.unavailable, "string");
    assert.equal(Object.hasOwn(complete.messages[0].ownerEventContent, "text"), false);
    await subject.control.scanOwnerReplies();
    assert.throws(() => subject.read(), { code: "OWNER_EVENTS_CONTENT_UNAVAILABLE" });
    assert.equal(subject.wakes.length, 1);
    assert.equal(subject.wakes[0].generation, 1);
    assert.ok(subject.wakes[0].prompt.endsWith(complete.messages[0].text));
  });
}

test("scanner requests complete native content only for explicitly captured owner routes", async (context) => {
  const subject = await fixture(context, { capture: false });
  subject.textReply(7, "x".repeat(2500));
  await subject.control.scanOwnerReplies();
  assert.ok(subject.readInputs.every((input) => input.include_owner_event_content !== true));
  assert.equal(subject.wakes.length, 1);
  assert.equal(subject.wakes[0].generation, 1);
  assert.equal(subject.wakes[0].prompt.split("\n").at(-1).length, 2000);
  assert.throws(() => subject.read(), { code: "OWNER_EVENTS_UNSUPPORTED" });
});

test("missing complete-source metadata is unavailable while the old delivery continues", async (context) => {
  const subject = await fixture(context, { omitContentMarker: true });
  subject.textReply(7, "not a complete-source marker");
  await subject.control.scanOwnerReplies();
  assert.throws(() => subject.read(), { code: "OWNER_EVENTS_CONTENT_UNAVAILABLE" });
  assert.equal(subject.wakes.length, 1);
  assert.equal(subject.wakes[0].generation, 1);
});

test("the delivery seen transaction recovers event 7 after one genuine capture write failure", async (context) => {
  const subject = await fixture(context);
  subject.textReply(7, "native reply 7");
  subject.textReply(8, "native reply 8");
  const assertInjected = failNextAtomicWrite(context, subject, "recordOwnerReplyEvent");
  await subject.control.scanOwnerReplies();
  assertInjected();
  assert.equal(subject.wakes.length, 2);
  const initial = subject.read();
  const reloaded = subject.reload();
  await reloaded.control.scanOwnerReplies();
  const page = subject.read(reloaded.control);
  assert.deepEqual(page.events.map((event) => event.message_seq), [7, 8]);
  assert.deepEqual(page.events.map((event) => event.text), ["native reply 7", "native reply 8"]);
  assert.deepEqual(page, initial);
  assert.equal(new Set(page.events.map((event) => event.event_id)).size, 2);
  assert.equal(page.partial, false);
  assert.equal(page.next_cursor, null);
  assert.equal(subject.wakes.length, 2);
  assert.ok(reloaded.state.hasSeenControlMessage("owner:owner-private:7"));
  assert.ok(reloaded.state.hasSeenControlMessage("owner:owner-private:8"));
});

test("the media-buffer seen transaction recovers event 7 across rescan, reload and a text follow-up", async (context) => {
  const subject = await fixture(context);
  subject.mediaReply(7);
  const assertInjected = failNextAtomicWrite(context, subject, "recordOwnerReplyEvent");
  await subject.control.scanOwnerReplies();
  assertInjected();
  assert.equal(subject.wakes.length, 0);
  const reloaded = subject.reload();
  assert.ok(reloaded.state.hasSeenControlMessage("owner:owner-private:7"));
  assert.deepEqual(reloaded.state.listOwnerRouteBufferedMessages("integrity-route").map((message) => message.messageSeq), [7]);
  const bufferedPage = subject.read(reloaded.control);
  await reloaded.control.scanOwnerReplies();
  subject.textReply(8, "follow up after buffered media");
  await reloaded.control.scanOwnerReplies();
  const finalReload = subject.reload();
  await finalReload.control.scanOwnerReplies();
  const page = subject.read(finalReload.control);
  assert.deepEqual(bufferedPage.events.map((event) => event.message_seq), [7]);
  assert.deepEqual(page.events.map((event) => event.message_seq), [7, 8]);
  assert.equal(page.events[0].event_id, bufferedPage.events[0].event_id);
  assert.equal(page.events[0].text, "[CQ:reply,id=500][CQ:image,file=synthetic.png]");
  assert.equal(page.events[1].text, "follow up after buffered media");
  assert.equal(page.partial, false);
  assert.equal(subject.wakes.length, 1);
  assert.equal(subject.wakes[0].generation, 1);
  assert.deepEqual(subject.wakes[0].pendingMessageSeqs, [7, 8]);
  assert.equal(finalReload.state.listOwnerRouteBufferedMessages("integrity-route").length, 0);
});

for (const mode of ["delivery", "media-buffer"]) {
  test(`a failed ${mode} seen write remains retryable after reload without duplicate events`, async (context) => {
    const subject = await fixture(context);
    if (mode === "delivery") subject.textReply(7, "retry the same native reply");
    else subject.mediaReply(7);
    const assertInjected = failNextAtomicWrite(context, subject, mode === "delivery" ? "completeOwnerReplyDelivery" : "bufferOwnerRouteMessage");
    try { await subject.control.scanOwnerReplies(); } catch (error) { assert.equal(error.code, "STATE_WRITE_FAILED"); }
    assertInjected();
    const reloaded = subject.reload();
    assert.equal(reloaded.state.hasSeenControlMessage("owner:owner-private:7"), false);
    const firstPage = subject.read(reloaded.control);
    assert.deepEqual(firstPage.events.map((event) => event.message_seq), [7]);
    await reloaded.control.scanOwnerReplies();
    const finalReload = subject.reload();
    await finalReload.control.scanOwnerReplies();
    assert.ok(finalReload.state.hasSeenControlMessage("owner:owner-private:7"));
    assert.deepEqual(subject.read(finalReload.control), firstPage);
    if (mode === "delivery") {
      assert.equal(subject.wakes.length, 2);
      assert.equal(subject.wakes[0].wakeId, subject.wakes[1].wakeId);
      assert.ok(subject.wakes.every((wake) => wake.generation === 1));
    } else {
      assert.equal(subject.wakes.length, 0);
      assert.equal(finalReload.state.listOwnerRouteBufferedMessages("integrity-route").length, 1);
    }
  });
}

test("busy delivery keeps complete captured events readable and the eventual wake identity stable", async (context) => {
  const subject = await fixture(context);
  subject.textReply(7, `${"native ".repeat(400)}BUSY_END`);
  subject.setWakeOutcome("busy");
  await subject.control.scanOwnerReplies();
  const reloaded = subject.reload();
  assert.equal(reloaded.state.hasSeenControlMessage("owner:owner-private:7"), false);
  const firstPage = subject.read(reloaded.control);
  assert.deepEqual(firstPage.events.map((event) => event.message_seq), [7]);
  assert.ok(firstPage.events[0].text.endsWith("BUSY_END"));
  subject.setWakeOutcome("accepted");
  await reloaded.control.scanOwnerReplies();
  assert.deepEqual(subject.read(subject.reload().control), firstPage);
  assert.equal(subject.wakes.length, 2);
  assert.equal(subject.wakes[0].wakeId, subject.wakes[1].wakeId);
  assert.ok(subject.wakes.every((wake) => wake.generation === 1));
});
