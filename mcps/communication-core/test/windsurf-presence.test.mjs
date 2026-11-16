import test from "node:test";
import assert from "node:assert/strict";
import { createWindsurfPresenceReader } from "../src/windsurf-presence.mjs";

test("WSF准确未找到进程时报告离线，发现进程仍保留LS未知和无发送能力", async () => {
  for (const count of [0, 1, 20]) {
    const reader = createWindsurfPresenceReader({ execute: async (command, args, options) => {
      assert.equal(command, "powershell.exe");
      assert.ok(args.includes("-NonInteractive"));
      assert.equal(options.windowsHide, true);
      assert.equal(options.maxBuffer, 32768);
      assert.ok(!args.join(" ").includes("--csrf_token"));
      return { stdout: JSON.stringify({ count }) };
    } });
    const status = await reader.getHostStatus({ host: "windsurf" });
    assert.equal(status.host_online, count === 0 ? false : "unknown");
    assert.deepEqual(reader.configured_delivery_modes, { next_model_boundary: false, when_idle: false });
    assert.equal((await reader.describeConversation()).conversation_running, "unknown");
  }
});

test("WSF错误、坏响应和过大计数均保持查询失败", async () => {
  for (const stdout of ["bad", "{}", '{"count":-1}', '{"count":257}', '{"count":1.5}']) {
    const reader = createWindsurfPresenceReader({ execute: async () => ({ stdout }) });
    await assert.rejects(reader.getHostStatus({ host: "windsurf" }), { code: "ls_discovery_failed" });
  }
  const reader = createWindsurfPresenceReader({ execute: async () => { throw new Error("synthetic-secret"); } });
  await assert.rejects(reader.getHostStatus({ host: "windsurf" }), error => error.code === "ls_discovery_failed" && !error.message.includes("synthetic-secret"));
});

test("WSF把取消signal继续交给自身只读子进程", async () => {
  const controller = new AbortController();
  const reader = createWindsurfPresenceReader({ execute: async (command, args, options) => {
    assert.equal(options.signal, controller.signal);
    controller.abort();
    return { stdout: '{"count":0}' };
  } });
  await assert.rejects(reader.getHostStatus({ host: "windsurf" }, { signal: controller.signal }));
  assert.throws(() => createWindsurfPresenceReader({ execute: null }), { code: "invalid_config" });
});
