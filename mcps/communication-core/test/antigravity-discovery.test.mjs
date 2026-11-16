import test from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter, getEventListeners } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { promisify } from "node:util";
import { setImmediate as nextTick, setTimeout as delay } from "node:timers/promises";

const executablePath = "C:\\synthetic\\antigravity\\resources\\bin\\language_server.exe";
const candidate = { pid: 123, csrf: "synthetic-private-sentinel", ports: [12345], host_pid: 122, host_ports: [12346] };
const target = { conversation_id: "synthetic-root" };
const summary = { trajectorySummaries: { [target.conversation_id]: { trajectoryId: "synthetic-trajectory", status: "IDLE", stepCount: 0, trajectoryMetadata: { rootConversationId: target.conversation_id } } } };
let sequence = 0;

async function fixture(context, { manualClose = false } = {}) {
  const calls = [];
  let active = 0;
  let peak = 0;
  const stub = () => { throw new Error("use promisified execute"); };
  stub[promisify.custom] = (file, args, options) => {
    const child = new EventEmitter();
    let accept;
    let reject;
    let closed = false;
    const promise = new Promise((resolve, fail) => { accept = resolve; reject = fail; });
    promise.child = child;
    active += 1;
    peak = Math.max(peak, active);
    const call = {
      file, args, options, aborted: false,
      close() {
        if (closed) return;
        closed = true;
        active -= 1;
        options.signal?.removeEventListener("abort", abort);
        child.emit("close", 0, null);
      },
      completeRaw(stdout) { accept({ stdout }); call.close(); },
      complete(values = [candidate]) { call.completeRaw(JSON.stringify(values)); },
      fail() { reject(new Error(candidate.csrf)); call.close(); },
    };
    const abort = () => {
      call.aborted = true;
      reject(new Error("synthetic abort"));
      if (!manualClose) queueMicrotask(() => call.close());
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    calls.push(call);
    return promise;
  };
  const original = childProcess.execFile;
  let module;
  try {
    childProcess.execFile = stub;
    syncBuiltinESMExports();
    module = await import(`../src/transports/antigravity-ls.mjs?discovery_fixture=${++sequence}`);
  } finally {
    childProcess.execFile = original;
    syncBuiltinESMExports();
  }
  context.after(async () => {
    for (const call of calls) call.complete([]);
    await nextTick();
    assert.equal(active, 0);
  });
  return { ...module, calls, get active() { return active; }, get peak() { return peak; } };
}

test("concurrent discoveries across callers execute once and return independent snapshots", async context => {
  const fake = await fixture(context);
  const pending = Array.from({ length: 6 }, () => fake.discoverAntigravityProcesses({ executablePath }));
  await nextTick();
  const executions = fake.calls.length;
  const peak = fake.peak;
  for (const call of fake.calls) call.complete();
  const results = await Promise.all(pending);
  context.diagnostic(JSON.stringify({ callers: 6, executions, peak_active_children: peak }));
  assert.equal(executions, 1);
  results[0][0].ports.push(12347);
  results[0][0].host_ports.push(12348);
  assert.deepEqual(results[1], [candidate]);
});

test("one caller cancellation leaves shared discovery and another caller alive", async context => {
  const fake = await fixture(context);
  const controller = new AbortController();
  const cancelled = fake.discoverAntigravityProcesses({ executablePath, signal: controller.signal });
  const rejected = assert.rejects(cancelled, error => !error.message.includes(candidate.csrf));
  const survivor = fake.discoverAntigravityProcesses({ executablePath });
  await nextTick();
  controller.abort();
  await rejected;
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].aborted, false);
  fake.calls[0].complete();
  assert.deepEqual(await survivor, [candidate]);
});

test("caller timeouts stay independent and do not replace the shared process timeout", async context => {
  const fake = await fixture(context);
  const short = fake.discoverAntigravityProcesses({ executablePath, signal: AbortSignal.timeout(50) });
  const rejected = assert.rejects(short);
  const long = fake.discoverAntigravityProcesses({ executablePath, signal: AbortSignal.timeout(500) });
  await delay(75);
  await rejected;
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].aborted, false);
  assert.equal(fake.calls[0].options.timeout, 8000);
  fake.calls[0].complete();
  assert.deepEqual(await long, [candidate]);
});

test("last cancellation aborts discovery and a replacement waits for the child close", async context => {
  const fake = await fixture(context, { manualClose: true });
  const controller = new AbortController();
  const pending = fake.discoverAntigravityProcesses({ executablePath, signal: controller.signal });
  const rejected = assert.rejects(pending);
  await nextTick();
  controller.abort();
  await rejected;
  assert.equal(fake.calls[0].aborted, true);
  const replacement = fake.discoverAntigravityProcesses({ executablePath });
  await nextTick();
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.active, 1);
  fake.calls[0].close();
  await nextTick();
  assert.equal(fake.calls.length, 2);
  assert.equal(fake.peak, 1);
  fake.calls[1].complete();
  assert.deepEqual(await replacement, [candidate]);
});

test("a cancelled drain waiter cannot start another process", async context => {
  const fake = await fixture(context, { manualClose: true });
  const first = new AbortController();
  const pending = assert.rejects(fake.discoverAntigravityProcesses({ executablePath, signal: first.signal }));
  await nextTick();
  first.abort();
  await pending;
  const second = new AbortController();
  const waiting = assert.rejects(fake.discoverAntigravityProcesses({ executablePath, signal: second.signal }));
  second.abort();
  await waiting;
  fake.calls[0].close();
  await nextTick();
  assert.equal(fake.calls.length, 1);
});

test("failure and process absence are not cached, and completed discovery refreshes PID and ports", async context => {
  const fake = await fixture(context);
  const failed = assert.rejects(fake.discoverAntigravityProcesses({ executablePath }), error => error.code === "ls_discovery_failed" && !error.message.includes(candidate.csrf));
  await nextTick();
  fake.calls[0].fail();
  await failed;
  const empty = fake.discoverAntigravityProcesses({ executablePath });
  await nextTick();
  fake.calls[1].complete([]);
  assert.deepEqual(await empty, []);
  const recovered = fake.discoverAntigravityProcesses({ executablePath });
  await nextTick();
  fake.calls[2].complete();
  assert.deepEqual(await recovered, [candidate]);
  const changed = fake.discoverAntigravityProcesses({ executablePath });
  await nextTick();
  const nextCandidate = { ...candidate, pid: 456, ports: [23456] };
  fake.calls[3].complete([nextCandidate]);
  assert.deepEqual(await changed, [nextCandidate]);
  assert.equal(fake.calls.length, 4);
});

test("only the same normalized executable path is shared and path/PID validation stays strict", async context => {
  const fake = await fixture(context);
  for (const path of ["relative.exe", "C:\\bad\npath.exe", "C:\\bad'file.exe"])
    await assert.rejects(fake.discoverAntigravityProcesses({ executablePath: path }), { code: "ls_path_missing" });
  const first = fake.discoverAntigravityProcesses({ executablePath });
  const same = fake.discoverAntigravityProcesses({ executablePath: executablePath.toUpperCase().replaceAll("\\", "/") });
  const other = fake.discoverAntigravityProcesses({ executablePath: "C:\\other\\language_server.exe" });
  await nextTick();
  assert.equal(fake.calls.length, 2);
  assert.match(fake.calls[0].args.at(-1), /process.ExecutablePath -ne/);
  assert.match(fake.calls[0].args.at(-1), /hostProcess.Path -eq/);
  assert.equal(fake.calls[0].options.windowsHide, true);
  for (const call of fake.calls) call.complete();
  await Promise.all([first, same, other]);
  const invalid = assert.rejects(fake.discoverAntigravityProcesses({ executablePath }), { code: "ls_discovery_failed" });
  await nextTick();
  fake.calls[2].complete([{ ...candidate, pid: -1 }]);
  await invalid;
});

test("pre-aborted callers start no discovery", async context => {
  const fake = await fixture(context);
  await assert.rejects(fake.discoverAntigravityProcesses({ executablePath, signal: AbortSignal.abort() }));
  assert.equal(fake.calls.length, 0);
});

test("transport close cancels only its own discovery waiter and prevents stale endpoint writes", async context => {
  const fake = await fixture(context);
  const first = new fake.AntigravityLsTransport({ fetchImpl: async () => Response.json(summary) });
  const second = new fake.AntigravityLsTransport({ fetchImpl: async () => Response.json(summary) });
  context.after(() => Promise.all([first.close(), second.close()]));
  const cancelled = assert.rejects(first.describe(target));
  const survivor = second.describe(target);
  await nextTick();
  await first.close();
  await cancelled;
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].aborted, false);
  fake.calls[0].complete();
  assert.equal((await survivor).cascade_id, target.conversation_id);
  assert.equal(first.endpoints.size, 0);
  assert.equal(second.endpoints.size, 1);
});

test("closing a transport bounds a pending host probe and releases its last discovery waiter", async context => {
  const fake = await fixture(context);
  const transport = new fake.AntigravityLsTransport();
  context.after(() => transport.close());
  const pending = transport.describeHost();
  await nextTick();
  await transport.close();
  const result = await pending;
  assert.equal(result.code, "ls_closed");
  assert.equal(fake.calls[0].aborted, true);
  await nextTick();
  assert.equal(fake.active, 0);
});

test("host and conversation probes share discovery without sharing authorization or RPC results", async context => {
  const fake = await fixture(context);
  const requests = [];
  const transport = new fake.AntigravityLsTransport({ fetchImpl: async url => { requests.push(url); return Response.json(summary); } });
  context.after(() => transport.close());
  const host = transport.describeHost();
  const conversation = transport.describe(target);
  await nextTick();
  assert.equal(fake.calls.length, 1);
  fake.calls[0].complete();
  assert.equal((await host).host_online, true);
  assert.equal((await conversation).cascade_id, target.conversation_id);
  assert.equal(requests.length, 2);
  await assert.rejects(transport.call("SendUserCascadeMessage", { cascadeId: "foreign" }, { target }), error => error.requestSent === false);
  assert.equal(requests.length, 2);
});

test("shared failures and malformed discovery results evict the flight for the next call", async context => {
  const fake = await fixture(context);
  for (const stdout of ["not-json", "{}", JSON.stringify(Array(9).fill(candidate)), JSON.stringify([{ ...candidate, ports: [0] }])]) {
    const before = fake.calls.length;
    const failed = Promise.all(Array.from({ length: 3 }, () => assert.rejects(fake.discoverAntigravityProcesses({ executablePath }), { code: "ls_discovery_failed" })));
    await nextTick();
    assert.equal(fake.calls.length, before + 1);
    fake.calls.at(-1).completeRaw(stdout);
    await failed;
    assert.equal(fake.active, 0);
  }
  const healthy = fake.discoverAntigravityProcesses({ executablePath });
  await nextTick();
  fake.calls.at(-1).complete();
  assert.deepEqual(await healthy, [candidate]);
});

test("completed and cancelled caller listeners are removed over repeated discoveries", async context => {
  const fake = await fixture(context);
  for (let index = 0; index < 40; index += 1) {
    const cancelled = new AbortController();
    const surviving = new AbortController();
    const rejected = assert.rejects(fake.discoverAntigravityProcesses({ executablePath, signal: cancelled.signal }));
    const pending = fake.discoverAntigravityProcesses({ executablePath, signal: surviving.signal });
    await nextTick();
    cancelled.abort();
    await rejected;
    fake.calls.at(-1).complete();
    await pending;
    await nextTick();
    assert.equal(getEventListeners(cancelled.signal, "abort").length, 0);
    assert.equal(getEventListeners(surviving.signal, "abort").length, 0);
    assert.equal(fake.active, 0);
  }
  assert.equal(fake.calls.length, 40);
  assert.equal(fake.peak, 1);
});

test("transport timeout and close bound even an injected discovery that ignores its signal", async context => {
  const fake = await fixture(context);
  const transport = new fake.AntigravityLsTransport({ discover: () => new Promise(() => {}), timeoutMs: 50 });
  context.after(() => transport.close());
  const bounded = assert.rejects(transport.describe(target), { code: "ls_cancelled" });
  await delay(75);
  await bounded;
  const pending = assert.rejects(transport.describe(target), { code: "ls_cancelled" });
  await transport.close();
  await pending;
  assert.equal(transport.endpoints.size, 0);
});

test("synchronous injected discoveries retain their original transport contract", async context => {
  const fake = await fixture(context);
  const transport = new fake.AntigravityLsTransport({ discover: () => [candidate], fetchImpl: async () => Response.json(summary) });
  context.after(() => transport.close());
  assert.equal((await transport.describe(target)).cascade_id, target.conversation_id);
  assert.equal(fake.calls.length, 0);
});

test("a discovery that aborts during invocation still has its late rejection observed", async context => {
  const fake = await fixture(context);
  const controller = new AbortController();
  const transport = new fake.AntigravityLsTransport({ discover() { controller.abort(); return Promise.reject(new Error(candidate.csrf)); } });
  context.after(() => transport.close());
  await assert.rejects(transport.describe(target, { signal: controller.signal }), { code: "ls_cancelled" });
  await nextTick();
  assert.equal(transport.endpoints.size, 0);
});
