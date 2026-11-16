import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createNapCatNotifier } from "../src/core.mjs";

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

async function withMemoryNotifier(config, run) {
  const virtualPath = path.join(os.tmpdir(), "configured-route-guards-virtual-binding.json");
  const originalRead = fs.readFileSync;
  const originalExists = fs.existsSync;
  const binding = {
    schemaVersion: 2,
    expectedSelfId: "1000000001",
    controlPlane: { enabled: true, targets: {
      room: { type: "group", id: "2000000001", name: "Expected", expectedMemberCount: 3 },
      owner: { type: "private", id: "1000000002" },
    } },
  };
  if (Object.hasOwn(config, "expectedSelfId")) binding.expectedSelfId = config.expectedSelfId;
  const raw = {
    message_id: "501", message_seq: "601", message_type: config.targetKey === "owner" ? "private" : "group",
    ...(config.targetKey === "owner" ? {} : { group_id: "2000000001" }),
    sender: { user_id: "1000000002" },
    message: [{ type: "file", data: { file_id: "original-file", file: "original.txt", file_size: 1 } }],
    raw_message: "original",
    ...config.raw,
  };
  const calls = [];
  const bodyStarted = deferred();
  const release = deferred();
  const state = { armed: false, signal: null };
  fs.readFileSync = function(filePath, ...rest) {
    return String(filePath) === virtualPath ? JSON.stringify(binding) : originalRead.call(this, filePath, ...rest);
  };
  fs.existsSync = function(filePath) { return String(filePath) === virtualPath || originalExists.call(this, filePath); };
  const notifier = createNapCatNotifier({
    env: { NAPCAT_MCP_BINDING_PATH: virtualPath, NAPCAT_HTTP_URL: "http://127.0.0.1:39123",
      NAPCAT_ALLOW_EMPTY_TOKEN: "1", NAPCAT_HTTP_TIMEOUT_MS: "1000" },
    fetchImpl: async (url, request) => {
      const action = new URL(url).pathname.slice(1);
      calls.push({ action, params: JSON.parse(request.body), signal: request.signal });
      const data = action === "get_status" ? { online: true, good: true }
        : action === "get_login_info" ? { user_id: config.actualSelfId ?? "1000000001" }
          : action === "get_group_info" ? {
            ...(config.omitGroupId ? {} : { group_id: config.groupId ?? "2000000001" }),
            group_name: "Expected", member_count: 3,
          }
            : action === "get_friend_list" ? [{ user_id: "1000000002" }]
              : action === "get_msg" ? raw
                : action.endsWith("msg_history") ? { messages: [raw] }
                  : action.endsWith("file_url") ? { url: "invalid" } : null;
      assert.notEqual(data, null);
      if (state.armed && action === config.stage) {
        state.signal = request.signal;
        if (config.phase === "headers") {
          bodyStarted.resolve();
          await release.promise;
        } else {
          return { ok: true, text: async () => {
            bodyStarted.resolve();
            await release.promise;
            return JSON.stringify({ status: "ok", retcode: 0, data });
          } };
        }
      }
      return new Response(JSON.stringify({ status: "ok", retcode: 0, data }));
    },
  });
  try { await run({ notifier, binding, raw, calls, bodyStarted, release, state }); }
  finally { release.resolve(); fs.readFileSync = originalRead; fs.existsSync = originalExists; }
}

function downloadInput(targetKey, reference = "ncf1:" + "0".repeat(64)) {
  return { target_key: targetKey, message_id: "501", attachment_ref: reference,
    destination_dir: path.join(os.tmpdir(), "configured-route-guards-never-open") };
}

test("missing or blank expectedSelfId blocks both new tools and both target types before any OneBot request", async () => {
  for (const expectedSelfId of [undefined, null, "", " "]) {
    for (const targetKey of ["room", "owner"]) {
      await withMemoryNotifier({ expectedSelfId, targetKey }, async ({ notifier, calls }) => {
        await assert.rejects(notifier.readConfiguredRecent({ target_key: targetKey }), { code: "BINDING_INCOMPLETE", outcomeUnknown: false });
        await assert.rejects(notifier.downloadConfiguredFile(downloadInput(targetKey)), { code: "BINDING_INCOMPLETE", outcomeUnknown: false });
        assert.deepEqual(calls, []);
      });
    }
  }
  console.log("missing/null/blank expectedSelfId: new read/download group/private rejected; OneBot calls=0");
});

test("strict new group identity rejects wrong or missing response group_id before history or get_msg; legacy defaults stay unchanged", async () => {
  for (const config of [{ groupId: "2000000999" }, { omitGroupId: true }]) {
    await withMemoryNotifier(config, async ({ notifier, calls }) => {
      await assert.rejects(notifier.readConfiguredRecent({ target_key: "room" }), { code: "CONTROL_GROUP_ID_MISMATCH" });
      await assert.rejects(notifier.downloadConfiguredFile(downloadInput("room")), { code: "CONTROL_GROUP_ID_MISMATCH" });
      assert.equal(calls.some((item) => item.action.endsWith("msg_history") || item.action === "get_msg"), false);
      const legacy = await notifier.readConfiguredTargetMessages({ target_key: "room" });
      assert.equal(legacy.returnedCount, 1);
    });
  }
});

test("a configured but wrong account still rejects the new reader before history", async () => {
  await withMemoryNotifier({ actualSelfId: "1000000999" }, async ({ notifier, calls }) => {
    await assert.rejects(notifier.readConfiguredRecent({ target_key: "room" }), { code: "SELF_ID_MISMATCH" });
    assert.deepEqual(calls.map((item) => item.action), ["get_status", "get_login_info"]);
  });
});

test("Core cancellation reaches fetch and response.text at every new preparation stage and prevents all later requests", async () => {
  const cases = [
    ["read", "room", "get_status"], ["read", "room", "get_login_info"],
    ["read", "room", "get_group_info"], ["read", "room", "get_group_msg_history"],
    ["read", "owner", "get_friend_list"], ["read", "owner", "get_friend_msg_history"],
    ["download", "room", "get_msg"], ["download", "room", "get_group_file_url"],
    ["download", "owner", "get_private_file_url"],
  ];
  for (const [method, targetKey, stage] of cases) {
    for (const phase of ["headers", "body"]) {
      await withMemoryNotifier({ targetKey, stage, phase }, async (setup) => {
        const recent = await setup.notifier.readConfiguredRecent({ target_key: targetKey });
        const reference = recent.messages[0].attachments[0].attachment_ref;
        setup.calls.length = 0;
        setup.state.armed = true;
        const caller = new AbortController();
        const pending = method === "read"
          ? setup.notifier.readConfiguredRecent({ target_key: targetKey }, { signal: caller.signal })
          : setup.notifier.downloadConfiguredFile(downloadInput(targetKey, reference), { signal: caller.signal });
        await setup.bodyStarted.promise;
        const atCancellation = setup.calls.map((item) => item.action);
        caller.abort();
        await assert.rejects(pending, { code: "CONFIGURED_OPERATION_CANCELLED", outcomeUnknown: false });
        assert.equal(setup.state.signal.aborted, true);
        setup.release.resolve();
        await delay(15);
        assert.deepEqual(setup.calls.map((item) => item.action), atCancellation, `${stage}/${phase} advanced after cancellation`);
      });
    }
  }
  console.log("18 cancellation counterexamples passed: status/login/group/friend/history/get_msg/file_url headers+body; underlying signal=true; later requests=0; writes=0");
});

test("the optional new OneBot context keeps its per-request deadline alive through delayed response.text", async () => {
  await withMemoryNotifier({ stage: "get_status", phase: "body" }, async (setup) => {
    setup.state.armed = true;
    const began = performance.now();
    const pending = setup.notifier.readConfiguredRecent({ target_key: "room" });
    await assert.rejects(pending, { code: "ONEBOT_TIMEOUT", outcomeUnknown: false });
    assert.ok(performance.now() - began < 1350);
    assert.equal(setup.state.signal.aborted, true);
    setup.release.resolve();
    await delay(20);
    assert.deepEqual(setup.calls.map((item) => item.action), ["get_status"]);
  });
});

test("legacy OneBot header-only deadline remains unchanged without the optional context", async () => {
  await withMemoryNotifier({ stage: "get_status", phase: "body" }, async (setup) => {
    setup.state.armed = true;
    const pending = setup.notifier.readConfiguredTargetMessages({ target_key: "room" });
    await setup.bodyStarted.promise;
    await delay(1100);
    assert.equal(setup.state.signal.aborted, false);
    setup.release.resolve();
    assert.equal((await pending).returnedCount, 1);
  });
});

test("structured text cannot mint or revalidate a raw_message-only file identity; old parser and string CQ remain available", async () => {
  const spoof = "[CQ:file,file_id=unrelated-file,file=x.txt]";
  await withMemoryNotifier({ targetKey: "owner", raw: {
    message: [{ type: "text", data: { text: spoof } }], raw_message: spoof,
  } }, async ({ notifier, calls }) => {
    const recent = await notifier.readConfiguredRecent({ target_key: "owner" });
    assert.deepEqual(recent.messages[0].attachments, []);
    const legacy = await notifier.readConfiguredTargetMessages({ target_key: "owner" });
    assert.equal(legacy.messages[0].attachments[0].downloadable, true);
    const forgedReference = "ncf1:" + createHash("sha256").update(JSON.stringify([
      "ncf1", "owner", "private", "1000000002", "501", "file", "unrelated-file",
    ])).digest("hex");
    await assert.rejects(notifier.downloadConfiguredFile(downloadInput("owner", forgedReference)), { code: "ATTACHMENT_REF_MISMATCH" });
    assert.equal(calls.some((item) => item.action.endsWith("file_url")), false);
  });
  await withMemoryNotifier({ targetKey: "owner", raw: { message: spoof, raw_message: spoof } }, async ({ notifier, calls }) => {
    const recent = await notifier.readConfiguredRecent({ target_key: "owner" });
    assert.equal(recent.messages[0].attachments[0].downloadable, true);
    await assert.rejects(notifier.downloadConfiguredFile(downloadInput("owner", recent.messages[0].attachments[0].attachment_ref)), { code: "FILE_URL_INVALID" });
    assert.equal(calls.find((item) => item.action === "get_private_file_url").params.file_id, "unrelated-file");
  });
  console.log("structured text CQ spoof: attachments=0, file URL calls=0; legacy parser and native string CQ unchanged");
});

test("structured real file segments remain downloadable while raw-only extra files are excluded", async () => {
  await withMemoryNotifier({ raw: { raw_message: "[CQ:file,file_id=unrelated-file,file=x.txt]" } }, async ({ notifier }) => {
    const recent = await notifier.readConfiguredRecent({ target_key: "room" });
    assert.equal(recent.messages[0].attachments.length, 1);
    assert.equal(recent.messages[0].attachments[0].fileId, "original-file");
    assert.equal(recent.messages[0].attachments[0].downloadable, true);
  });
});
