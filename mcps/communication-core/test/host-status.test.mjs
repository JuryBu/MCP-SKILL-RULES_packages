import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate as nextTick } from "node:timers/promises";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { pathToFileURL } from "node:url";
import { HostStatusProvider, createAntigravityStatusReader, createWindsurfStatusReader, createCodexStatusReader } from "../src/host-status.mjs";
import { AntigravityLsTransport } from "../src/transports/antigravity-ls.mjs";

const target = { machine_id: "isolated-machine", host: "antigravity", surface: "desktop", conversation_id: "isolated-root" };
const configured = { next_model_boundary: true, when_idle: true };
const unknownModes = { next_model_boundary: "unknown", when_idle: "unknown" };
const candidate = { pid: 123, ports: [12345], csrf: "synthetic-private-csrf-sentinel" };
let discoveryFixtureSequence = 0;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

function reader(overrides = {}) {
  return {
    source: "isolated_status_reader", configured_delivery_modes: configured,
    async getHostStatus() { return { host_online: true }; },
    async describeConversation() { return { conversation_exists: true, status: "CASCADE_RUN_STATUS_IDLE" }; },
    ...overrides,
  };
}

function provider(context, providers = { antigravity: reader() }, options = {}) {
  const instance = new HostStatusProvider({ providers, ...options });
  context.after(() => instance.close());
  return instance;
}

function transport(context, options = {}) {
  const instance = new AntigravityLsTransport({ discover: async () => [candidate], fetchImpl: async () => Response.json({}), ...options });
  context.after(() => instance.close());
  return instance;
}

function readyCodex(overrides = {}) {
  return {
    ok: true, closed: false, readyClientCount: 1, control_enabled: true,
    clients: [{ initialized: true, upstreamReady: true, downstreamState: 1, upstreamState: 1 }],
    ...overrides,
  };
}

function codexReader(status = { type: "idle" }, host = readyCodex(), inspection) {
  return createCodexStatusReader({
    configured_delivery_modes: configured,
    async readHostStatus() { return host; },
    async inspectThread(threadId) { return inspection ?? { ok: true, threadId, found: true, thread: { id: threadId, status, canAcceptDirectInput: true } }; },
  });
}

async function fakeDiscovery() {
  const calls = [];
  const original = childProcess.execFile;
  try {
    childProcess.execFile = (file, args, options, callback) => {
      calls.push({ file, args, options });
      callback(null, { stdout: JSON.stringify([candidate]) });
    };
    syncBuiltinESMExports();
    discoveryFixtureSequence += 1;
    const module = await import(`../src/transports/antigravity-ls.mjs?status_discovery_fixture=${discoveryFixtureSequence}`);
    return { discover: module.discoverAntigravityProcesses, calls };
  } finally {
    childProcess.execFile = original;
    syncBuiltinESMExports();
  }
}

for (const [status, running] of [
  ["CASCADE_RUN_STATUS_RUNNING", true], ["CASCADE_RUN_STATUS_IDLE", false], ["CASCADE_RUN_STATUS_NOT_LOADED", false],
  ["RUNNING", true], ["IDLE", false], ["NOT_LOADED", false],
]) {
  test(`known status ${status} preserves online, existence and configured delivery`, async context => {
    const instance = provider(context, { antigravity: reader({ async describeConversation() { return { conversation_exists: true, status }; } }) }, { now: () => 1000 });
    const result = await instance.getStatus(target);
    assert.deepEqual(result.target, target);
    assert.equal(result.observed_at, "1970-01-01T00:00:01.000Z");
    assert.equal(result.source, "isolated_status_reader");
    assert.equal(result.host_online, true);
    assert.equal(result.conversation_exists, true);
    assert.equal(result.conversation_running, running);
    assert.equal(result.raw_status, status);
    assert.equal(result.can_deliver, true);
    assert.deepEqual(result.delivery_modes, configured);
    assert.deepEqual(result.configured_delivery_modes, configured);
  });
}

for (const status of ["CASCADE_RUN_STATUS_FUTURE", "idle", 44]) {
  test(`unknown enum ${status} stays unknown with its exact raw value`, async context => {
    const instance = provider(context, { antigravity: reader({ async describeConversation() { return { conversation_exists: true, status }; } }) });
    const result = await instance.getStatus(target);
    assert.equal(result.conversation_running, "unknown");
    assert.equal(result.raw_status, status);
    assert.equal(result.code, "status_unknown_enum");
  });
}

test("host-only query does not fabricate or inspect a single conversation", async context => {
  const actualTarget = { machine_id: target.machine_id, host: target.host, surface: target.surface };
  const instance = provider(context, { antigravity: reader({ describeConversation() { assert.fail("host-only query inspected a conversation"); } }) });
  const result = await instance.getStatus(actualTarget);
  assert.deepEqual(result.target, actualTarget);
  assert.equal(Object.hasOwn(result.target, "conversation_id"), false);
  assert.equal(result.host_online, true);
  for (const field of ["conversation_exists", "conversation_running", "can_deliver"]) assert.equal(result[field], "unknown");
  assert.equal(result.code, "status_host_scope");
  assert.deepEqual(result.delivery_modes, unknownModes);
  assert.deepEqual(result.configured_delivery_modes, configured);
});

test("missing reader and inherited object names cannot impersonate a supported host", async context => {
  const instance = provider(context, {});
  for (const host of ["windsurf", "codex", "toString", "__proto__"]) {
    const result = await instance.getStatus({ ...target, host });
    assert.equal(result.host_online, "unknown");
    assert.equal(result.conversation_exists, "unknown");
    assert.equal(result.can_deliver, "unknown");
    assert.equal(result.code, "status_reader_not_configured");
  }
});

test("a status target on another machine cannot reuse this machine's same-host reader", async context => {
  const remote = { ...target, machine_id: "test-status-remote" };
  const routes = new Map();
  let localCalls = 0;
  let remoteCalls = 0;
  const instance = new HostStatusProvider({
    localMachineId: target.machine_id,
    providers: { [target.host]: reader({
      source: "fixture-local-status",
      async getHostStatus() { localCalls++; return { host_online: true, transport_ready: true }; },
    }) },
    machineProviders: routes,
  });
  context.after(() => instance.close());
  assert.equal((await instance.getStatus(remote)).code, "status_reader_not_configured");
  assert.equal(localCalls, 0);
  routes.set(remote.machine_id, new Map([[target.host, reader({
    source: "fixture-remote-status",
    async getHostStatus(address) { remoteCalls++; assert.equal(address.machine_id, remote.machine_id); return { host_online: false }; },
  })]]));
  assert.equal((await instance.getStatus(target)).source, "fixture-local-status");
  const result = await instance.getStatus(remote);
  assert.equal(result.source, "fixture-remote-status");
  assert.equal(result.host_online, false);
  assert.deepEqual([localCalls, remoteCalls], [1, 1]);
});

test("remote deadline stays separate from a local probe and returns only unknown current status", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const remote = { ...target, machine_id: "test-remote-deadline" };
  const silent = () => new Promise(() => {});
  const remoteReader = reader({
    getHostStatus() { return { host_online: true, transport_ready: true }; },
    describeConversation: silent,
  });
  const instance = new HostStatusProvider({
    localMachineId: target.machine_id, timeoutMs: 25,
    providers: { [target.host]: reader({ getHostStatus: silent, describeConversation: silent }) },
    machineProviders: new Map([[remote.machine_id, new Map([[remote.host, remoteReader]])]]),
  });
  context.after(() => instance.close());
  const localPending = instance.getStatus(target);
  let remoteFinished = false;
  const remotePending = instance.getStatus(remote).finally(() => { remoteFinished = true; });
  await nextTick();
  context.mock.timers.tick(25);
  assert.equal((await localPending).code, "status_timeout");
  context.mock.timers.tick(14974);
  await nextTick();
  assert.equal(remoteFinished, false);
  context.mock.timers.tick(1);
  const status = await remotePending;
  assert.deepEqual(status.target, remote);
  assert.equal(status.source, "remote_core_relay");
  assert.equal(status.code, "remote_timeout");
  for (const field of ["host_online", "conversation_exists", "conversation_running", "can_deliver"]) {
    assert.equal(status[field], "unknown");
  }
  remoteReader.describeConversation = () => { throw Object.assign(new Error("provider receipt"), { code: "remote_timeout" }); };
  assert.equal((await instance.getStatus(remote)).code, "remote_timeout");
  const controller = new AbortController();
  remoteReader.describeConversation = silent;
  const cancelled = instance.getStatus(remote, { signal: controller.signal });
  controller.abort();
  assert.equal((await cancelled).code, "status_cancelled");
});

test("new remote status calls do not join an in-flight query from the previous route generation", async context => {
  const remote = { ...target, machine_id: "test-remote-generation" };
  let resolveOld;
  const old = new Promise(resolve => { resolveOld = resolve; });
  let calls = 0;
  const remoteReader = reader({
    cursorGeneration: 1,
    getHostStatus() { calls++; return this.cursorGeneration === 1 ? old : { host_online: false }; },
  });
  const instance = new HostStatusProvider({
    localMachineId: target.machine_id,
    machineProviders: new Map([[remote.machine_id, new Map([[remote.host, remoteReader]])]]),
  });
  context.after(() => instance.close());
  const early = instance.getStatus(remote);
  await nextTick();
  remoteReader.cursorGeneration = 2;
  assert.equal((await instance.getStatus(remote)).host_online, false);
  resolveOld({ host_online: true });
  assert.equal((await early).host_online, true);
  assert.equal(calls, 2);
  remoteReader.cursorGeneration = undefined;
  const unversioned = await Promise.all([instance.getStatus(remote), instance.getStatus(remote)]);
  assert.equal(unversioned.every(observation => observation.host_online === false), true);
  assert.equal(calls, 4);
});

for (const code of ["ls_target_unavailable", "ls_target_ambiguous"]) {
  test(`${code} keeps online separate from unconfirmed existence`, async context => {
    const instance = provider(context, { antigravity: reader({ describeConversation() { throw Object.assign(new Error("private diagnostic"), { code }); } }) });
    const result = await instance.getStatus(target);
    assert.equal(result.host_online, true);
    assert.equal(result.conversation_exists, "unknown");
    assert.equal(result.conversation_running, "unknown");
    assert.equal(result.can_deliver, "unknown");
    assert.equal(result.code, code);
    assert.equal(JSON.stringify(result).includes("private diagnostic"), false);
  });
}

test("explicit host-down never becomes conversation-not-found", async context => {
  const instance = provider(context, { antigravity: reader({
    async getHostStatus() { return { host_online: false }; },
    async describeConversation() { throw new Error("offline"); },
  }) });
  const result = await instance.getStatus(target);
  assert.equal(result.host_online, false);
  assert.equal(result.conversation_exists, "unknown");
  assert.equal(result.conversation_running, "unknown");
  assert.equal(result.can_deliver, false);
  assert.deepEqual(result.delivery_modes, { next_model_boundary: false, when_idle: false });
  assert.deepEqual(result.configured_delivery_modes, configured);
});

test("one host failing cannot break other injected hosts", async context => {
  const instance = provider(context, {
    antigravity: reader({ getHostStatus() { throw new Error("synthetic-secret"); }, describeConversation() { throw new Error("synthetic-secret"); } }),
    codex: reader({ async describeConversation() { return { conversation_exists: true, conversation_running: true }; } }),
    windsurf: reader({ configured_delivery_modes: { next_model_boundary: false, when_idle: false } }),
  });
  const [ag, codex, wsf] = await Promise.all(["antigravity", "codex", "windsurf"].map(host => instance.getStatus({ ...target, host })));
  assert.equal(ag.host_online, "unknown");
  assert.equal(JSON.stringify(ag).includes("synthetic-secret"), false);
  assert.equal(codex.conversation_running, true);
  assert.equal(codex.can_deliver, true);
  assert.equal(wsf.host_online, true);
  assert.equal(wsf.can_deliver, false);
});

test("delivery requires explicit configuration as well as a unique conversation", async context => {
  for (const [configuration, expected] of [
    [undefined, "unknown"], [{}, "unknown"], [{ next_model_boundary: "true", when_idle: 1 }, "unknown"],
    [{ next_model_boundary: false, when_idle: false }, false], [{ next_model_boundary: false, when_idle: true }, true],
  ]) {
    const instance = provider(context, { antigravity: reader({ configured_delivery_modes: configuration }) });
    const result = await instance.getStatus(target);
    assert.equal(result.host_online, true);
    assert.equal(result.conversation_exists, true);
    assert.equal(result.can_deliver, expected);
    if (expected === "unknown") assert.equal(result.code, "status_delivery_not_configured");
  }
  const instance = provider(context, { antigravity: { getHostStatus: reader().getHostStatus, configured_delivery_modes: configured } });
  const result = await instance.getStatus(target);
  assert.equal(result.host_online, true);
  assert.equal(result.conversation_exists, "unknown");
  assert.equal(result.can_deliver, "unknown");
  assert.equal(result.code, "status_conversation_unsupported");
});

test("only explicit not-found marks a conversation absent", async context => {
  const instance = provider(context, { antigravity: reader({ async describeConversation() { return { conversation_exists: false }; } }) });
  const result = await instance.getStatus(target);
  assert.equal(result.host_online, true);
  assert.equal(result.conversation_exists, false);
  assert.equal(result.conversation_running, false);
  assert.equal(result.can_deliver, false);
});

test("a located conversation with no current run status has an explicit unknown reason", async context => {
  const instance = provider(context, { antigravity: reader({ async describeConversation() { return { conversation_exists: true }; } }) });
  const result = await instance.getStatus(target);
  assert.equal(result.conversation_exists, true);
  assert.equal(result.conversation_running, "unknown");
  assert.equal(result.code, "status_conversation_unknown");
});

test("malformed reader responses and invalid targets remain bounded unknown results", async context => {
  const instance = provider(context, { antigravity: reader({ async getHostStatus() { return null; }, async describeConversation() { return {}; } }) });
  const result = await instance.getStatus(target);
  assert.equal(result.code, "status_invalid_response");
  assert.equal(result.host_online, "unknown");
  assert.equal(result.conversation_exists, "unknown");
  for (const value of [null, {}, [], { host: "" }, { host: "codex", conversation_id: "" }]) {
    assert.equal((await instance.getStatus(value)).code, "status_invalid_target");
  }
  for (const timeoutMs of [0, -1, 8001, 1.5, Infinity, "1000"]) assert.throws(() => new HostStatusProvider({ timeoutMs }), RangeError);
});

test("timeout aborts both probes and late rejections are handled", async context => {
  const pending = [deferred(), deferred()];
  const signals = [];
  const instance = provider(context, { antigravity: reader({
    getHostStatus(actual, { signal }) { signals.push(signal); return pending[0].promise; },
    describeConversation(actual, { signal }) { signals.push(signal); return pending[1].promise; },
  }) }, { timeoutMs: 20 });
  const result = await instance.getStatus(target);
  assert.equal(result.code, "status_timeout");
  assert.equal(result.host_online, "unknown");
  assert.equal(result.conversation_exists, "unknown");
  assert.equal(signals.length, 2);
  assert.ok(signals.every(signal => signal.aborted));
  assert.equal(instance.active.size, 0);
  pending.forEach(item => item.reject(new Error("late rejection")));
  await nextTick();
});

test("a single timed-out item preserves the completed host observation", async context => {
  const instance = provider(context, { antigravity: reader({ describeConversation() { return new Promise(() => {}); } }) }, { timeoutMs: 20 });
  const result = await instance.getStatus(target);
  assert.equal(result.host_online, true);
  assert.equal(result.conversation_exists, "unknown");
  assert.equal(result.can_deliver, "unknown");
  assert.equal(result.code, "status_timeout");
});

test("pre-cancelled queries never start a reader", async context => {
  const controller = new AbortController();
  controller.abort();
  const instance = provider(context, { antigravity: reader({ getHostStatus() { assert.fail("unexpected probe"); } }) });
  assert.equal((await instance.getStatus(target, { signal: controller.signal })).code, "status_cancelled");
  assert.equal(instance.active.size, 0);
});

test("external cancellation aborts unshared probes and removes provider tracking", async context => {
  const signals = [];
  const hang = (actual, { signal }) => { signals.push(signal); return new Promise(() => {}); };
  const instance = provider(context, { antigravity: reader({ getHostStatus: hang, describeConversation: hang }) });
  const controller = new AbortController();
  const resultPromise = instance.getStatus(target, { signal: controller.signal });
  await nextTick();
  controller.abort();
  assert.equal((await resultPromise).code, "status_cancelled");
  assert.ok(signals.every(signal => signal.aborted));
  await nextTick();
  assert.equal(instance.active.size, 0);
  assert.equal(instance.inflight.size, 0);
});

test("in-flight deduplication does not let one caller cancel another caller", async context => {
  const gate = deferred();
  let hostCalls = 0;
  let conversationCalls = 0;
  let probeSignal;
  const instance = provider(context, { antigravity: reader({
    async getHostStatus(actual, { signal }) { hostCalls += 1; probeSignal = signal; await gate.promise; return { host_online: true }; },
    async describeConversation() { conversationCalls += 1; await gate.promise; return { conversation_exists: true, status: "IDLE" }; },
  }) });
  const controller = new AbortController();
  const first = instance.getStatus(target, { signal: controller.signal });
  const second = instance.getStatus({ ...target });
  await nextTick();
  assert.equal(hostCalls, 1);
  assert.equal(conversationCalls, 1);
  controller.abort();
  assert.equal((await first).code, "status_cancelled");
  assert.equal(probeSignal.aborted, false);
  gate.resolve();
  assert.equal((await second).can_deliver, true);
});

test("completed snapshots are never relabelled as fresh and output cannot mutate another result", async context => {
  let clock = 1000;
  let calls = 0;
  const instance = provider(context, { antigravity: reader({ async getHostStatus() { calls += 1; return { host_online: true }; } }) }, { now: () => clock });
  const first = await instance.getStatus(target);
  first.delivery_modes.next_model_boundary = false;
  clock = 1500;
  const second = await instance.getStatus(target);
  assert.equal(calls, 2);
  assert.equal(first.observed_at, "1970-01-01T00:00:01.000Z");
  assert.equal(second.observed_at, "1970-01-01T00:00:01.500Z");
  assert.equal(second.delivery_modes.next_model_boundary, true);
});

test("a shared observation keeps its probe-start timestamp while another item is waiting", async context => {
  let clock = 1000;
  const gate = deferred();
  const instance = provider(context, { antigravity: reader({ async describeConversation() { await gate.promise; return { conversation_exists: true, status: "IDLE" }; } }) }, { now: () => clock });
  const first = instance.getStatus(target);
  clock = 1500;
  const second = instance.getStatus(target);
  clock = 3000;
  gate.resolve();
  const results = await Promise.all([first, second]);
  assert.equal(results[0].observed_at, "1970-01-01T00:00:01.000Z");
  assert.equal(results[1].observed_at, results[0].observed_at);
});

test("deduplication lasts at most one second and separates machines and surfaces", async context => {
  let clock = 1000;
  let calls = 0;
  const gate = deferred();
  const instance = provider(context, { antigravity: reader({ async getHostStatus() { calls += 1; await gate.promise; return { host_online: true }; } }) }, { now: () => clock });
  const jobs = [instance.getStatus(target)];
  clock = 2000;
  jobs.push(instance.getStatus(target));
  jobs.push(instance.getStatus({ ...target, machine_id: "other-machine" }));
  jobs.push(instance.getStatus({ ...target, surface: "other-surface" }));
  await nextTick();
  assert.equal(calls, 4);
  gate.resolve();
  await Promise.all(jobs);
  assert.equal(instance.active.size, 0);
});

test("close cancels every owned probe without closing borrowed readers", async context => {
  let borrowedClosed = false;
  const signals = [];
  const hang = (actual, { signal }) => { signals.push(signal); return new Promise(() => {}); };
  const instance = provider(context, { antigravity: reader({ getHostStatus: hang, describeConversation: hang, close() { borrowedClosed = true; } }) });
  const jobs = [instance.getStatus(target), instance.getStatus({ ...target, conversation_id: "second-root" })];
  await nextTick();
  await instance.close();
  assert.ok(signals.every(signal => signal.aborted));
  assert.ok((await Promise.all(jobs)).every(result => result.code === "status_closed"));
  assert.equal(instance.active.size, 0);
  assert.equal(instance.inflight.size, 0);
  assert.equal(borrowedClosed, false);
  assert.equal((await instance.getStatus(target)).code, "status_closed");
});

test("AG reader projects only checked identity and raw status, never calls readSteps", async context => {
  const calls = [];
  const ag = createAntigravityStatusReader({
    async describeHost(options) { calls.push(["host", options]); return { host_online: true }; },
    async describe(actual, options) { calls.push(["conversation", actual, options]); return { cascade_id: actual.conversation_id, trajectory_id: "isolated-trajectory", status: "CASCADE_RUN_STATUS_NOT_LOADED", title: candidate.csrf, steps: candidate.csrf }; },
    readSteps() { assert.fail("state probe cannot call readSteps"); },
  }, { configured_delivery_modes: configured });
  const instance = provider(context, { antigravity: ag });
  const result = await instance.getStatus(target);
  assert.equal(result.conversation_exists, true);
  assert.equal(result.conversation_running, false);
  assert.equal(result.raw_status, "CASCADE_RUN_STATUS_NOT_LOADED");
  assert.equal(result.can_deliver, true);
  assert.equal(JSON.stringify(result).includes(candidate.csrf), false);
  assert.equal(calls.length, 2);
  assert.equal(calls[1][1].conversation_id, target.conversation_id);
  assert.ok(calls.every(call => call.at(-1).signal instanceof AbortSignal));
});

test("AG reader rejects mismatched roots and requires the explicit read-only contract", async context => {
  assert.throws(() => createAntigravityStatusReader({ describe() {} }), TypeError);
  const ag = createAntigravityStatusReader({ async describeHost() { return { host_online: true }; }, async describe() { return { cascade_id: "foreign", trajectory_id: "valid", status: "RUNNING" }; } }, { configured_delivery_modes: configured });
  const result = await provider(context, { antigravity: ag }).getStatus(target);
  assert.equal(result.host_online, true);
  assert.equal(result.conversation_exists, "unknown");
  assert.equal(result.can_deliver, "unknown");
  assert.equal(result.code, "ls_target_mismatch");
});

test("WSF reuses only injected LS reads and explicitly reports no sending adapter", async context => {
  const calls = [];
  const wsf = createWindsurfStatusReader({
    async describeHost() { calls.push("GetAllCascadeTrajectories"); return { host_online: true }; },
    async describe(actual) { calls.push(actual.conversation_id); return { cascade_id: actual.conversation_id, trajectory_id: "wsf-trajectory", status: "CASCADE_RUN_STATUS_RUNNING" }; },
    readSteps() { assert.fail("WSF state reader cannot call readSteps"); },
  });
  const result = await provider(context, { windsurf: wsf }).getStatus({ ...target, host: "windsurf" });
  assert.equal(result.source, "windsurf_ls");
  assert.equal(result.host_online, true);
  assert.equal(result.conversation_exists, true);
  assert.equal(result.conversation_running, true);
  assert.equal(result.can_deliver, false);
  assert.deepEqual(result.delivery_modes, { next_model_boundary: false, when_idle: false });
  assert.deepEqual(calls, ["GetAllCascadeTrajectories", target.conversation_id]);
});

test("AG host status requires a real read-only RPC response and emits no credentials or trajectories", async context => {
  const calls = [];
  const ag = transport(context, { fetchImpl: async (url, options) => { calls.push({ url, options }); return Response.json({ trajectorySummaries: { private: { summary: "private full trajectory" } } }); } });
  const result = await ag.describeHost();
  assert.deepEqual(result, { source: "antigravity_ls", host_online: true, instance_count: 1, responding_pid: candidate.pid });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.endsWith("/GetAllCascadeTrajectories"));
  assert.deepEqual(JSON.parse(calls[0].options.body), {});
  assert.equal(calls[0].options.headers["x-codeium-csrf-token"], candidate.csrf);
  assert.equal(ag.endpoints.size, 0);
  for (const sentinel of [candidate.csrf, "private full trajectory", "trajectorySummaries"]) assert.equal(JSON.stringify(result).includes(sentinel), false);
});

test("AG process absence, endpoint absence, discovery failures and RPC failures remain distinct", async context => {
  const cases = [
    [{ discover: async () => [] }, false, "ls_process_not_found"],
    [{ discover: async () => [{ ...candidate, ports: [] }] }, "unknown", "ls_endpoint_not_found"],
    [{ discover: async () => { throw new Error(candidate.csrf); } }, "unknown", "ls_discovery_failed"],
    [{ fetchImpl: async () => { throw new Error(candidate.csrf); } }, "unknown", "ls_host_unavailable"],
  ];
  for (const [options, online, code] of cases) {
    const result = await transport(context, options).describeHost();
    assert.equal(result.host_online, online);
    assert.equal(result.code, code);
    assert.equal(JSON.stringify(result).includes(candidate.csrf), false);
  }
});

test("any responsive AG instance establishes host online and cancels the losing probes", async context => {
  let cancelled = false;
  const calls = [];
  const ag = transport(context, {
    discover: async () => [{ ...candidate, ports: [12345] }, { ...candidate, pid: 124, ports: [12346] }],
    fetchImpl: async (url, { signal }) => {
      calls.push(url);
      if (url.includes(":12346/")) return Response.json({});
      return new Promise((resolve, reject) => signal.addEventListener("abort", () => { cancelled = true; reject(new Error("cancelled losing probe")); }, { once: true }));
    },
  });
  const result = await ag.describeHost();
  assert.equal(result.host_online, true);
  assert.equal(result.instance_count, 2);
  assert.equal(result.responding_pid, 124);
  assert.equal(calls.length, 2);
  assert.equal(cancelled, true);
});

test("host availability never weakens the original unique-root AG conversation check", async context => {
  const summary = { trajectorySummaries: { [target.conversation_id]: { trajectoryId: "isolated-trajectory", status: "CASCADE_RUN_STATUS_RUNNING", trajectoryMetadata: { rootConversationId: target.conversation_id } } } };
  const ag = transport(context, { discover: async () => [{ ...candidate, ports: [12345, 12346] }], fetchImpl: async () => Response.json(summary) });
  const instance = provider(context, { antigravity: createAntigravityStatusReader(ag, { configured_delivery_modes: configured }) });
  const result = await instance.getStatus(target);
  assert.equal(result.host_online, true);
  assert.equal(result.conversation_exists, "unknown");
  assert.equal(result.code, "ls_target_ambiguous");
  assert.equal(result.can_deliver, "unknown");
});

test("AG describeHost bounds discovery and endpoint waits and handles external cancellation", async context => {
  for (const options of [{ discover: () => new Promise(() => {}) }, { fetchImpl: () => new Promise(() => {}) }]) {
    const ag = transport(context, { timeoutMs: 50, ...options });
    const result = await ag.describeHost();
    assert.equal(result.host_online, "unknown");
    assert.equal(result.code, "ls_timeout");
  }
  const controller = new AbortController();
  const ag = transport(context, { discover: () => new Promise(() => {}) });
  const pending = ag.describeHost({ signal: controller.signal });
  controller.abort();
  assert.equal((await pending).code, "ls_cancelled");
  await ag.close();
  assert.equal((await ag.describeHost()).code, "ls_closed");
});

for (const [raw, expected, code] of [["active", true], ["idle", false], ["notLoaded", false], ["systemError", "unknown", "codex_thread_system_error"], ["futureState", "unknown", "status_unknown_enum"]]) {
  test(`Codex top-level ${raw} is parsed without historical turn inference`, async context => {
    const actual = { ...target, host: "codex" };
    const thread = { id: target.conversation_id, status: { type: raw } };
    Object.defineProperty(thread, "turns", { get() { assert.fail("historical turns were read"); } });
    const instance = provider(context, { codex: codexReader(null, readyCodex(), { threadId: actual.conversation_id, found: true, thread }) });
    const result = await instance.getStatus(actual);
    assert.equal(result.host_online, true);
    assert.equal(result.conversation_exists, true);
    assert.equal(result.conversation_running, expected);
    assert.equal(result.raw_status, raw);
    if (code) assert.equal(result.code, code);
  });
}

test("Codex missing status and outer transaction busy never infer a thread running state", async context => {
  const actual = { ...target, host: "codex" };
  for (const inspection of [
    { threadId: actual.conversation_id, found: true, thread: { id: actual.conversation_id, turns: [{ status: "completed" }] } },
    { full: { busy: true } },
  ]) {
    const result = await provider(context, { codex: codexReader(null, { full: { busy: true } }, inspection) }).getStatus(actual);
    assert.equal(result.conversation_running, "unknown");
    assert.equal(result.can_deliver, "unknown");
  }
});

test("Codex exact not-found, mismatched target and RPC errors have separate existence results", async context => {
  const actual = { ...target, host: "codex" };
  const cases = [
    [{ threadId: actual.conversation_id, found: false, thread: null }, false],
    [{ threadId: "foreign-root", found: true, thread: { id: "foreign-root", status: "active" } }, "unknown"],
    [{ threadId: actual.conversation_id, found: true, thread: { id: "foreign-root", status: "active" } }, "unknown"],
    [{ ok: false, error: { code: "APP_SERVER_RPC_ERROR", message: "private-rpc-secret" } }, "unknown"],
  ];
  for (const [inspection, exists] of cases) {
    const result = await provider(context, { codex: codexReader(null, readyCodex(), inspection) }).getStatus(actual);
    assert.equal(result.conversation_exists, exists);
    assert.equal(JSON.stringify(result).includes("private-rpc-secret"), false);
  }
});

test("Codex host online needs ready count and a currently OPEN pair, not process or transaction flags", async context => {
  const actual = { host: "codex" };
  for (const host of [
    readyCodex({ readyClientCount: 0 }), readyCodex({ closed: true }),
    readyCodex({ clients: [{ initialized: true, upstreamReady: true, downstreamState: 3, upstreamState: 1 }] }),
    readyCodex({ clients: [{ initialized: true, upstreamReady: false, downstreamState: 1, upstreamState: 1 }] }),
    { ok: true, pid: 123, full: { busy: false } },
  ]) {
    const result = await provider(context, { codex: codexReader(null, host) }).getStatus(actual);
    assert.equal(result.host_online, "unknown");
    assert.equal(result.conversation_exists, "unknown");
    assert.equal(result.can_deliver, "unknown");
  }
});

test("Codex delivery requires current control enabled and explicitly configured capability", async context => {
  for (const [control_enabled, expected] of [[true, true], [false, false], [undefined, "unknown"]]) {
    const result = await provider(context, { codex: codexReader("active", readyCodex({ control_enabled })) }).getStatus({ ...target, host: "codex" });
    assert.equal(result.host_online, true);
    assert.equal(result.conversation_running, true);
    assert.equal(result.can_deliver, expected);
  }
  const codex = codexReader("idle");
  codex.configured_delivery_modes = {};
  assert.equal((await provider(context, { codex }).getStatus({ ...target, host: "codex" })).can_deliver, "unknown");
});

test("Codex injected functions receive the target, exact thread ID and owned cancellation signal", async context => {
  const actual = { ...target, host: "codex" };
  const calls = [];
  const codex = createCodexStatusReader({
    configured_delivery_modes: configured,
    async readHostStatus(address, options) { calls.push(["host", address, options.signal]); return { proxy: readyCodex(), control_enabled: true }; },
    async inspectThread(threadId, options) { calls.push(["thread", threadId, options.signal]); return { threadId, found: true, thread: { id: threadId, status: "idle", canAcceptDirectInput: true } }; },
  });
  const result = await provider(context, { codex }).getStatus(actual);
  assert.equal(result.can_deliver, true);
  assert.deepEqual(calls[0][1], actual);
  assert.equal(calls[1][1], actual.conversation_id);
  assert.ok(calls.every(call => call[2] instanceof AbortSignal));
  assert.throws(() => createCodexStatusReader({ readHostStatus() {} }), TypeError);
});

test("Codex unavailable injected APIs remain unknown without invoking another host or transport", async context => {
  const codex = createCodexStatusReader({
    configured_delivery_modes: configured,
    async readHostStatus() { throw new Error("outer status path unavailable"); },
    async inspectThread() { throw new Error("outer thread path unavailable"); },
  });
  const result = await provider(context, { codex }).getStatus({ ...target, host: "codex" });
  assert.equal(result.host_online, "unknown");
  assert.equal(result.conversation_exists, "unknown");
  assert.equal(result.conversation_running, "unknown");
  assert.equal(result.can_deliver, "unknown");
  assert.equal(result.code, "status_probe_failed");
});

for (const [input, expected] of [[true, true], [false, false], [undefined, "unknown"]]) {
  test(`Codex raw thread.canAcceptDirectInput=${input} gates each actual mode independently of history`, async context => {
    const thread = { id: target.conversation_id, status: { type: "active", activeFlags: [] } };
    if (input !== undefined) thread.canAcceptDirectInput = input;
    Object.defineProperty(thread, "turns", { get() { assert.fail("historical turns were read"); } });
    const inspection = { ok: true, threadId: target.conversation_id, found: true, thread };
    const result = await provider(context, { codex: codexReader(null, readyCodex(), inspection) }).getStatus({ ...target, host: "codex" });
    assert.equal(result.conversation_exists, true);
    assert.equal(result.conversation_running, true);
    assert.equal(result.can_deliver, expected);
    assert.deepEqual(result.configured_delivery_modes, configured);
    assert.deepEqual(result.delivery_modes, { next_model_boundary: expected, when_idle: expected });
    if (input === undefined) assert.equal(result.code, "codex_direct_input_unknown");
    if (input === false) assert.equal(result.code, "codex_direct_input_disabled");
  });
}

test("Codex root-level direct-input flag cannot replace or overrule the verified thread field", async context => {
  for (const [threadFlag, expected] of [[false, false], [undefined, "unknown"]]) {
    const thread = { id: target.conversation_id, status: "active" };
    if (threadFlag !== undefined) thread.canAcceptDirectInput = threadFlag;
    const inspection = { ok: true, threadId: target.conversation_id, found: true, canAcceptDirectInput: true, thread };
    const result = await provider(context, { codex: codexReader(null, readyCodex(), inspection) }).getStatus({ ...target, host: "codex" });
    assert.equal(result.can_deliver, expected);
    assert.equal(result.delivery_modes.next_model_boundary, expected);
  }
});

test("Codex unverified host or control keeps configured modes separate from actual availability", async context => {
  for (const [host, expected] of [
    [readyCodex({ readyClientCount: 0, clients: [] }), "unknown"],
    [readyCodex({ closed: true }), "unknown"],
    [readyCodex({ control_enabled: undefined }), "unknown"],
    [readyCodex({ control_enabled: false }), false],
  ]) {
    const result = await provider(context, { codex: codexReader("active", host) }).getStatus({ ...target, host: "codex" });
    assert.equal(result.conversation_running, true);
    assert.equal(result.can_deliver, expected);
    assert.deepEqual(result.configured_delivery_modes, configured);
    assert.deepEqual(result.delivery_modes, { next_model_boundary: expected, when_idle: expected });
  }
});

test("whole-host Codex query leaves conversation and actual enabled modes unknown", async context => {
  const codex = createCodexStatusReader({
    configured_delivery_modes: configured,
    async readHostStatus() { return readyCodex(); },
    inspectThread() { assert.fail("whole-host status inspected a thread"); },
  });
  const result = await provider(context, { codex }).getStatus({ machine_id: target.machine_id, host: "codex", surface: "desktop" });
  assert.equal(result.host_online, true);
  for (const field of ["conversation_exists", "conversation_running", "can_deliver"]) assert.equal(result[field], "unknown");
  assert.deepEqual(result.configured_delivery_modes, configured);
  assert.deepEqual(result.delivery_modes, unknownModes);
});

test("explicit disabled configuration stays false through unknown probes and host-only scope", async context => {
  const disabled = { next_model_boundary: false, when_idle: false };
  const instance = provider(context, { antigravity: reader({
    configured_delivery_modes: disabled,
    getHostStatus() { throw new Error("synthetic host unavailable"); },
    describeConversation() { throw new Error("synthetic target unavailable"); },
  }) });
  const result = await instance.getStatus(target);
  assert.equal(result.can_deliver, false);
  assert.deepEqual(result.delivery_modes, disabled);
  assert.deepEqual(result.configured_delivery_modes, disabled);
  const whole = await instance.getStatus({ host: target.host });
  assert.equal(whole.can_deliver, "unknown");
  assert.deepEqual(whole.delivery_modes, disabled);
});

test("target capability false overrides enabled host configuration while direct addresses use host defaults", async context => {
  const instance = provider(context);
  const partial = await instance.getStatus({ ...target, capabilities: { next_model_boundary: false } });
  assert.deepEqual(partial.configured_delivery_modes, { next_model_boundary: false, when_idle: true });
  assert.deepEqual(partial.delivery_modes, { next_model_boundary: false, when_idle: true });
  assert.equal(partial.can_deliver, true);
  const disabled = await instance.getStatus({ ...target, capabilities: { next_model_boundary: false, when_idle: false } });
  assert.equal(disabled.can_deliver, false);
  assert.deepEqual(disabled.delivery_modes, { next_model_boundary: false, when_idle: false });
  const direct = await instance.getStatus(target);
  assert.equal(direct.can_deliver, true);
  assert.deepEqual(direct.configured_delivery_modes, configured);
  assert.deepEqual(direct.delivery_modes, configured);
});

test("target capability cannot enable a host mode that was explicitly disabled or unverified", async context => {
  const instance = provider(context, { antigravity: reader({ configured_delivery_modes: { next_model_boundary: false, when_idle: "unknown" } }) });
  const result = await instance.getStatus({ ...target, capabilities: configured });
  assert.deepEqual(result.configured_delivery_modes, { next_model_boundary: false, when_idle: "unknown" });
  assert.deepEqual(result.delivery_modes, { next_model_boundary: false, when_idle: "unknown" });
  assert.equal(result.can_deliver, "unknown");
});

test("cancelled status still exposes static configuration without asserting live availability", async context => {
  const controller = new AbortController();
  controller.abort();
  const result = await provider(context).getStatus({ ...target, capabilities: { when_idle: false } }, { signal: controller.signal });
  assert.deepEqual(result.configured_delivery_modes, { next_model_boundary: true, when_idle: false });
  assert.deepEqual(result.delivery_modes, { next_model_boundary: "unknown", when_idle: false });
  assert.equal(result.can_deliver, "unknown");
});

test("WSF executable discovery uses its Windows basename and escapes the full literal path", async () => {
  const fixture = await fakeDiscovery();
  const result = await fixture.discover({ executablePath: "C:\\Synthetic'Root\\Windsurf\\language_server_windows_x64.exe" });
  assert.equal(result[0].pid, candidate.pid);
  assert.equal(fixture.calls.length, 1);
  assert.equal(fixture.calls[0].file, "powershell.exe");
  const script = fixture.calls[0].args.at(-1);
  assert.ok(script.includes('-Filter "Name=\'language_server_windows_x64.exe\'"'));
  assert.ok(script.includes("$process.ExecutablePath -ne 'C:\\Synthetic''Root\\Windsurf\\language_server_windows_x64.exe'"));
  assert.equal(fixture.calls[0].options.windowsHide, true);
  assert.equal(fixture.calls[0].options.timeout, 8000);
});

test("default AG discovery retains its original image name and normalizes explicit Windows paths", async () => {
  const fixture = await fakeDiscovery();
  await fixture.discover();
  assert.ok(fixture.calls[0].args.at(-1).includes('-Filter "Name=\'language_server.exe\'"'));
  await fixture.discover({ executablePath: "C:/Synthetic/Windsurf/language_server_windows_x64.exe" });
  assert.ok(fixture.calls[1].args.at(-1).includes("$process.ExecutablePath -ne 'C:\\Synthetic\\Windsurf\\language_server_windows_x64.exe'"));
});

test("invalid executable paths and unsafe process basenames fail before a process command starts", async () => {
  const fixture = await fakeDiscovery();
  for (const executablePath of [
    "relative/language_server.exe", "C:language_server.exe", "C:\\Synthetic\\not-an-executable.txt",
    "C:\\Synthetic\\language_server.exe'; Write-Output injected; x.exe", "C:\\Synthetic\\bad\nname.exe", 42,
  ]) {
    await assert.rejects(fixture.discover({ executablePath }), { code: "ls_path_missing" });
  }
  assert.equal(fixture.calls.length, 0);
});

test("Codex v2 whole-host reports transport and control readiness without inspecting a CID", async context => {
  let hostReads = 0;
  let inspections = 0;
  const source = createCodexStatusReader({
    configured_delivery_modes: configured,
    async readHostStatus() {
      hostReads += 1;
      return { proxy: readyCodex(), control_state_version: 2, control_enabled: true, control_ready: true };
    },
    async inspectThread() { inspections += 1; throw new Error("whole-host must not inspect threads"); },
  });
  const result = await provider(context, { codex: source }).getStatus({ host: "codex" });
  for (const field of ["host_online", "transport_ready", "control_enabled", "control_ready", "host_can_receive"]) assert.equal(result[field], true, field);
  for (const field of ["conversation_exists", "conversation_running", "can_deliver"]) assert.equal(result[field], "unknown", field);
  assert.deepEqual(result.delivery_modes, unknownModes);
  assert.deepEqual(result.configured_delivery_modes, configured);
  assert.equal(hostReads, 1);
  assert.equal(inspections, 0);
});

for (const [name, flags, enabled, ready, receives] of [
  ["enabled", { control_enabled: true, control_ready: true }, true, true, true],
  ["native disabled", { control_enabled: false, control_ready: true }, false, true, false],
  ["instance mismatch", { control_enabled: true, control_ready: false }, true, false, false],
  ["both refused", { control_enabled: false, control_ready: false }, false, false, false],
  ["native missing", { control_ready: true }, "unknown", true, "unknown"],
  ["matching missing", { control_enabled: true }, true, "unknown", "unknown"],
  ["both missing", {}, "unknown", "unknown", "unknown"],
  ["malformed flags", { control_enabled: "true", control_ready: 1 }, "unknown", "unknown", "unknown"],
  ["refusal overrides missing", { control_ready: false }, "unknown", false, false],
]) {
  test(`Codex v2 control ${name} keeps host and single-CID semantics separate`, async context => {
    const source = codexReader(undefined, { proxy: readyCodex(), control_state_version: 2, ...flags });
    const instance = provider(context, { codex: source });
    const whole = await instance.getStatus({ host: "codex" });
    assert.equal(whole.host_online, true);
    assert.equal(whole.transport_ready, true);
    assert.equal(whole.control_enabled, enabled);
    assert.equal(whole.control_ready, ready);
    assert.equal(whole.host_can_receive, receives);
    assert.equal(whole.can_deliver, "unknown");
    assert.deepEqual(whole.delivery_modes, unknownModes);
    const single = await instance.getStatus({ ...target, host: "codex" });
    assert.equal(single.host_can_receive, receives);
    assert.equal(single.can_deliver, receives);
    assert.equal(single.conversation_exists, true);
    assert.equal(single.conversation_running, false);
  });
}

for (const [name, overrides, expected] of [
  ["closed", { closed: true }, false],
  ["no ready client", { readyClientCount: 0 }, false],
  ["empty client list", { clients: [] }, false],
  ["client refused", { clients: [{ initialized: true, upstreamReady: false, downstreamState: 1, upstreamState: 1 }] }, false],
  ["socket closed", { clients: [{ initialized: true, upstreamReady: true, downstreamState: 3, upstreamState: 1 }] }, false],
  ["missing count", { readyClientCount: undefined }, "unknown"],
  ["missing clients", { clients: undefined }, "unknown"],
  ["missing socket", { clients: [{ initialized: true, upstreamReady: true, upstreamState: 1 }] }, "unknown"],
  ["missing availability", { ok: undefined }, "unknown"],
  ["refusal despite missing", { ok: undefined, closed: true }, false],
]) {
  test(`Codex v2 transport ${name} never becomes ready from enabled configuration`, async context => {
    const input = { proxy: readyCodex(overrides), control_state_version: 2, control_enabled: true, control_ready: true };
    const instance = provider(context, { codex: codexReader(undefined, input) });
    const whole = await instance.getStatus({ host: "codex" });
    assert.equal(whole.transport_ready, expected);
    assert.equal(whole.host_can_receive, expected);
    const single = await instance.getStatus({ ...target, host: "codex" });
    assert.equal(single.can_deliver, expected);
  });
}

test("explicit runtime denials override ready clients and configured delivery", async context => {
  for (const override of [{ transport_ready: false }, { host_online: false }, { host_can_receive: false }]) {
    const input = { proxy: readyCodex(), control_state_version: 2, control_enabled: true, control_ready: true, ...override };
    const instance = provider(context, { codex: codexReader(undefined, input) });
    assert.equal((await instance.getStatus({ host: "codex" })).host_can_receive, false);
    assert.equal((await instance.getStatus({ ...target, host: "codex" })).can_deliver, false);
  }
  const legacy = provider(context, { codex: codexReader(undefined, readyCodex({ transport_ready: false })) });
  assert.equal((await legacy.getStatus({ ...target, host: "codex" })).can_deliver, false);
});

test("legacy Codex control input preserves composite meaning without inventing a native disabled switch", async context => {
  for (const [composite, enabled, receives] of [[true, true, true], [false, "unknown", false], [undefined, "unknown", "unknown"]]) {
    const instance = provider(context, { codex: codexReader(undefined, readyCodex({ control_enabled: composite })) });
    const result = await instance.getStatus({ ...target, host: "codex" });
    assert.equal(result.control_enabled, enabled);
    assert.equal(result.control_ready, composite ?? "unknown");
    assert.equal(result.host_can_receive, receives);
    assert.equal(result.can_deliver, receives);
    assert.equal(Object.hasOwn(result, "legacy_control_input"), false);
  }
  const instance = provider(context, { codex: codexReader(undefined, readyCodex({ closed: true })) });
  const result = await instance.getStatus({ ...target, host: "codex" });
  assert.equal(result.host_online, "unknown");
  assert.equal(result.transport_ready, false);
  assert.equal(result.host_can_receive, false);
  assert.equal(result.can_deliver, "unknown");
});

test("legacy generic readers need new live readiness evidence only for the new host summary", async context => {
  const result = await provider(context).getStatus(target);
  assert.equal(result.transport_ready, "unknown");
  assert.equal(result.control_enabled, "unknown");
  assert.equal(result.control_ready, "unknown");
  assert.equal(result.host_can_receive, "unknown");
  assert.equal(result.can_deliver, true);
  const refused = await provider(context, { antigravity: reader({ async getHostStatus() { return { host_online: true, transport_ready: false }; } }) }).getStatus(target);
  assert.equal(refused.host_can_receive, false);
  assert.equal(refused.can_deliver, false);
});

for (const [name, host, configuration, expectedReady, receives] of [
  ["verified LS with sender", { host_online: true }, configured, true, true],
  ["LS response missing", { host_online: "unknown", process_count: 1 }, configured, "unknown", "unknown"],
  ["explicit LS offline", { host_online: false }, configured, false, false],
  ["explicit transport refusal", { host_online: true, transport_ready: false }, configured, false, false],
  ["no sender configuration", { host_online: true }, undefined, true, false],
  ["empty sender configuration", { host_online: true }, {}, true, false],
  ["null sender configuration", { host_online: true }, null, true, false],
  ["malformed declared sender", { host_online: true }, { next_model_boundary: "true" }, true, "unknown"],
  ["disabled sender", { host_online: true }, { next_model_boundary: false, when_idle: false }, true, false],
]) {
  test(`AG host reception ${name}`, async context => {
    let hosts = 0;
    let conversations = 0;
    const source = createAntigravityStatusReader({
      async describeHost() { hosts += 1; return host; },
      async describe() { conversations += 1; throw new Error("whole-host must not inspect conversations"); },
    }, { configured_delivery_modes: configuration });
    const result = await provider(context, { antigravity: source }).getStatus({ host: "antigravity" });
    assert.equal(result.transport_ready, expectedReady);
    assert.equal(result.host_can_receive, receives);
    assert.equal(result.can_deliver, "unknown");
    assert.equal(hosts, 1);
    assert.equal(conversations, 0);
  });
}

test("WSF has no receiver without a sender and process presence never establishes LS readiness", async context => {
  for (const host of [{ process_count: 1, host_online: "unknown" }, { host_online: true }, { host_online: false }]) {
    const source = createWindsurfStatusReader({ async describeHost() { return host; }, async describe() { throw new Error("not queried"); } });
    const result = await provider(context, { windsurf: source }).getStatus({ host: "windsurf" });
    assert.equal(result.host_can_receive, false);
    assert.equal(result.transport_ready, host.host_online);
    assert.equal(result.can_deliver, "unknown");
    assert.deepEqual(result.delivery_modes, { next_model_boundary: false, when_idle: false });
  }
});

test("host reception excludes CID-specific capability and direct-input restrictions", async context => {
  const source = codexReader(undefined, { proxy: readyCodex(), control_state_version: 2, control_enabled: true, control_ready: true }, {
    ok: true, threadId: target.conversation_id, found: true,
    thread: { id: target.conversation_id, status: "idle", canAcceptDirectInput: false },
  });
  const instance = provider(context, { codex: source });
  const result = await instance.getStatus({ ...target, host: "codex", capabilities: { next_model_boundary: false, when_idle: false } });
  assert.equal(result.host_can_receive, true);
  assert.equal(result.can_deliver, false);
  assert.deepEqual(result.delivery_modes, { next_model_boundary: false, when_idle: false });
});

test("unknown host readiness cannot be enabled by an upstream positive summary", async context => {
  const source = reader({ async getHostStatus() { return { host_online: true, host_can_receive: true }; } });
  const result = await provider(context, { antigravity: source }).getStatus({ host: "antigravity" });
  assert.equal(result.transport_ready, "unknown");
  assert.equal(result.host_can_receive, "unknown");
});

test("cancelled and closed queries keep an unconfigured sender false and runtime fields unknown", async context => {
  const source = createAntigravityStatusReader({ async describeHost() { throw new Error("not queried"); }, async describe() {} });
  const instance = provider(context, { antigravity: source });
  const controller = new AbortController();
  controller.abort();
  const cancelled = await instance.getStatus({ host: "antigravity" }, { signal: controller.signal });
  await instance.close();
  const closed = await instance.getStatus({ host: "antigravity" });
  for (const result of [cancelled, closed]) {
    assert.equal(result.host_can_receive, false);
    for (const field of ["host_online", "transport_ready", "control_enabled", "control_ready", "can_deliver"]) assert.equal(result[field], "unknown", field);
  }
});

test("explicit control_ready selects the new contract even without a version marker", async context => {
  const instance = provider(context, { codex: codexReader(undefined, { proxy: readyCodex(), control_ready: true }) });
  const result = await instance.getStatus({ ...target, host: "codex" });
  assert.equal(result.control_enabled, "unknown");
  assert.equal(result.control_ready, true);
  assert.equal(result.host_can_receive, "unknown");
  assert.equal(result.can_deliver, "unknown");
});

test("Codex missing or disabled sender configuration is false only for host reception", async context => {
  for (const configuration of [undefined, null, {}, { next_model_boundary: false, when_idle: false }]) {
    const source = createCodexStatusReader({
      configured_delivery_modes: configuration,
      async readHostStatus() { return { proxy: readyCodex(), control_state_version: 2, control_enabled: true, control_ready: true }; },
      async inspectThread() { throw new Error("whole-host must not inspect threads"); },
    });
    const result = await provider(context, { codex: source }).getStatus({ host: "codex" });
    assert.equal(result.transport_ready, true);
    assert.equal(result.control_ready, true);
    assert.equal(result.host_can_receive, false);
    assert.equal(result.can_deliver, "unknown");
  }
});

test("completed host readiness survives a timed-out CID inspection without an extra snapshot", async context => {
  let hosts = 0;
  let conversations = 0;
  const source = createCodexStatusReader({
    configured_delivery_modes: configured,
    async readHostStatus() { hosts += 1; return { proxy: readyCodex(), control_state_version: 2, control_enabled: true, control_ready: true }; },
    inspectThread() { conversations += 1; return new Promise(() => {}); },
  });
  const instance = provider(context, { codex: source }, { timeoutMs: 20 });
  const result = await instance.getStatus({ ...target, host: "codex" });
  for (const field of ["transport_ready", "control_enabled", "control_ready", "host_can_receive"]) assert.equal(result[field], true, field);
  assert.equal(result.conversation_exists, "unknown");
  assert.equal(result.can_deliver, "unknown");
  assert.equal(result.code, "status_timeout");
  assert.equal(hosts, 1);
  assert.equal(conversations, 1);
});

test("host summary gives explicit refusal priority even when other required fields are missing", async context => {
  for (const denied of ["host_online", "transport_ready", "control_enabled", "control_ready", "host_can_receive"]) {
    const source = reader({ async getHostStatus() { return { [denied]: false }; } });
    const result = await provider(context, { antigravity: source }).getStatus({ host: "antigravity" });
    assert.equal(result.host_can_receive, false, denied);
  }
});

const privateStatusV2Path = process.env.COMMUNICATION_CORE_STATUS_V2_MODULE;

test("private Codex v2 wrapper shares one readonly snapshot and separates native enablement from binding matching", { skip: !privateStatusV2Path }, async () => {
  const { createCodexStatusSource } = await import(pathToFileURL(privateStatusV2Path).href);
  for (const [enabled, matching, expectedEnabled, expectedReady] of [
    [true, true, true, true], [false, false, false, false], [true, false, true, false],
    [undefined, undefined, "unknown", "unknown"], ["true", "true", "unknown", "unknown"],
  ]) {
    let snapshots = 0;
    let matches = 0;
    let fetches = 0;
    const requests = [];
    const communication = { enabled, binding: { instance_id: "synthetic-instance" } };
    const source = createCodexStatusSource({
      fetchImpl() { fetches += 1; throw new Error("no network in fixture"); },
      async readSnapshot() {
        snapshots += 1;
        return {
          ok: true, communication,
          matching(actual) { assert.equal(actual, communication); matches += 1; return matching; },
          async request(endpoint, method, body) {
            requests.push({ endpoint, method, body });
            return { httpStatus: 200, body: endpoint === "/v1/status" ? readyCodex() : { threadId: body.threadId, found: true } };
          },
        };
      },
    });
    const controller = new AbortController();
    const [host, thread] = await Promise.all([
      source.readHostStatus({ host: "codex" }, { signal: controller.signal }),
      source.inspectThread("synthetic-cid", { signal: controller.signal }),
    ]);
    assert.equal(host.control_state_version, 2);
    assert.equal(host.control_enabled, expectedEnabled);
    assert.equal(host.control_ready, expectedReady);
    assert.equal(thread.threadId, "synthetic-cid");
    assert.equal(snapshots, 1);
    assert.equal(matches, 1);
    assert.equal(fetches, 0);
    assert.deepEqual(requests, [
      { endpoint: "/v1/status", method: undefined, body: undefined },
      { endpoint: "/v1/threads/inspect", method: "POST", body: { threadId: "synthetic-cid" } },
    ]);
    await source.readHostStatus({ host: "codex" }, { signal: new AbortController().signal });
    assert.equal(snapshots, 2);
  }
});

test("private Codex v2 wrapper cancellation and invalid snapshots add no probe or network call", { skip: !privateStatusV2Path }, async () => {
  const { createCodexStatusSource } = await import(pathToFileURL(privateStatusV2Path).href);
  let reads = 0;
  const source = createCodexStatusSource({ async readSnapshot() { reads += 1; return { ok: false }; }, fetchImpl() { throw new Error("network forbidden"); } });
  const controller = new AbortController();
  controller.abort(new Error("synthetic cancellation"));
  await assert.rejects(source.readHostStatus({}, { signal: controller.signal }), /synthetic cancellation/u);
  assert.equal(reads, 0);
  await assert.rejects(source.readHostStatus({}, { signal: new AbortController().signal }), /Codex status source unavailable/u);
  assert.equal(reads, 1);
  const beforeMicrotask = new AbortController();
  const abortedBeforeRead = source.readHostStatus({}, { signal: beforeMicrotask.signal });
  beforeMicrotask.abort(new Error("cancel before snapshot starts"));
  await assert.rejects(abortedBeforeRead, /cancel before snapshot starts/u);
  assert.equal(reads, 1);

  const pendingSnapshot = deferred();
  let requests = 0;
  const delayed = createCodexStatusSource({ async readSnapshot() { return pendingSnapshot.promise; }, fetchImpl() { throw new Error("network forbidden"); } });
  const duringRead = new AbortController();
  const abortedDuringRead = delayed.readHostStatus({}, { signal: duringRead.signal });
  await nextTick();
  duringRead.abort(new Error("cancel during snapshot"));
  pendingSnapshot.resolve({ ok: true, matching() { return true; }, async request() { requests += 1; } });
  await assert.rejects(abortedDuringRead, /cancel during snapshot/u);
  assert.equal(requests, 0);
});
