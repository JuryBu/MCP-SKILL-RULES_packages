import assert from "node:assert/strict";
import childProcess, { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { promisify } from "node:util";
import { WindsurfAcpDeliveryAdapter } from "../src/adapters/windsurf-acp.mjs";
import { MockAdapter } from "../src/adapters/mock.mjs";
import { identityKey } from "../src/contracts.mjs";
import { startLiveFromConfig } from "../src/live-runtime.mjs";
import { WindsurfAcpTransport } from "../src/transports/windsurf-acp-transport.mjs";
import { createWindsurfDesktopStatusReader } from "../src/windsurf-desktop-status.mjs";

const realExecFile = promisify(execFile);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

function createWorkspaceFixture(context, { sessions = [] } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "wsf-stage3b-polish-"));
  const userDataDir = path.join(root, "Devin", "User");
  const cliDataDir = path.join(root, "Devin", "cli");
  const installRoot = path.join(root, "Programs", "Devin");
  const binPath = path.join(root, "fake-devin.exe");
  mkdirSync(path.join(userDataDir, "acp-messages"), { recursive: true });
  mkdirSync(path.join(userDataDir, "globalStorage"), { recursive: true });
  mkdirSync(path.join(cliDataDir, "session_locks"), { recursive: true });
  writeFileSync(binPath, "stub");

  const cliPath = path.join(cliDataDir, "sessions.db");
  const statePath = path.join(userDataDir, "globalStorage", "state.vscdb");
  const cli = new DatabaseSync(cliPath);
  cli.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      working_directory TEXT NOT NULL,
      backend_type TEXT NOT NULL DEFAULT 'windsurf',
      model TEXT NOT NULL,
      agent_mode TEXT NOT NULL DEFAULT 'bypass',
      created_at INTEGER NOT NULL DEFAULT 1795000000,
      last_activity_at INTEGER NOT NULL DEFAULT 1795000100,
      title TEXT,
      main_chain_id INTEGER,
      hidden INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX idx_sessions_hidden ON sessions(hidden);
    CREATE INDEX idx_sessions_activity ON sessions(last_activity_at DESC);
    CREATE TABLE message_nodes (
      row_id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      node_id INTEGER NOT NULL,
      parent_node_id INTEGER,
      chat_message TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(session_id, node_id)
    );
  `);

  const stateDb = new DatabaseSync(statePath);
  stateDb.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)");
  stateDb.prepare("INSERT INTO ItemTable VALUES ('windsurfAuthStatus', ?)").run(
    JSON.stringify({ apiKey: "sk-wsf-stage3b-test-key", apiServerUrl: "https://server.codeium.com" }),
  );

  const desktopDbs = new Map();
  const desktopIds = new Map();
  for (const s of sessions) {
    const slug = s.slug;
    const desktopId = createHash("sha1").update(`devin-acp/devin-cli/${slug}`).digest("hex");
    desktopIds.set(slug, desktopId);
    cli.prepare(
      "INSERT INTO sessions(id, working_directory, model, agent_mode, last_activity_at, title, main_chain_id, hidden) VALUES (?, ?, ?, 'bypass', 1795000100, ?, ?, 0)",
    ).run(slug, s.cwd ?? "C:/ws/stage3b", s.cliModel ?? "", s.title ?? slug, s.mainChainId ?? null);
    for (const node of s.nodes ?? []) {
      cli.prepare(
        "INSERT INTO message_nodes(session_id, node_id, parent_node_id, chat_message, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run(slug, node.nodeId, node.parentId ?? null, JSON.stringify(node.message), node.createdAt ?? 1795285330);
    }
    stateDb.prepare("INSERT INTO ItemTable VALUES (?, ?)").run(
      `windsurf.acp.messageStore.session.acp/devin-cli/${slug}`,
      Buffer.from(JSON.stringify({ uuid: desktopId })),
    );
    if (s.uiModel !== undefined) {
      const desktopPath = path.join(userDataDir, "acp-messages", `${desktopId}.db`);
      const ddb = new DatabaseSync(desktopPath);
      ddb.exec("CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)");
      ddb.prepare("INSERT INTO meta VALUES ('info', ?)").run(
        JSON.stringify({ configOptions: [{ id: "model", currentValue: s.uiModel }] }),
      );
      desktopDbs.set(slug, ddb);
    }
  }

  const mainProcess = {
    pid: 101,
    parent_pid: 1,
    executable_path: path.join(installRoot, "Devin.exe"),
    command_line: `"${path.join(installRoot, "Devin.exe")}"`,
    created_at: "2026-11-22T07:00:00.000Z",
  };

  context.after(() => {
    for (const ddb of desktopDbs.values()) if (ddb.isOpen) ddb.close();
    if (stateDb.isOpen) stateDb.close();
    if (cli.isOpen) cli.close();
    rmSync(root, { recursive: true, force: true });
  });

  return { root, userDataDir, cliDataDir, installRoot, binPath, cliPath, statePath, cli, stateDb, desktopDbs, desktopIds, mainProcess };
}

test("serializeDatabase: true serializes concurrent describeConversation FIFO without busy collisions, respects queue abort and child-close handoff, and caps queue at 16", async context => {
  const fx = createWorkspaceFixture(context, {
    sessions: [
      { slug: "alpha-one", cliModel: "swe-2-max", uiModel: "swe-2-max" },
      { slug: "beta-two", cliModel: "swe-2-max", uiModel: "swe-2-max" },
      { slug: "gamma-three", cliModel: "swe-2-max", uiModel: "swe-2-max" },
    ],
  });

  // 1a. Concurrent multi-call describeConversation with real SQLite queries succeeds with zero ls_target_unavailable
  let inFlight = 0;
  let maxInFlight = 0;
  let totalQueries = 0;
  const reader = createWindsurfDesktopStatusReader({
    userDataDir: fx.userDataDir,
    cliDataDir: fx.cliDataDir,
    installRoots: [fx.installRoot],
    listProcesses: async () => [fx.mainProcess],
    serializeDatabase: true,
    timeoutMs: 8000,
    databaseTimeoutMs: 1800,
    executeDatabase: (cmd, args, opts) => {
      inFlight += 1;
      totalQueries += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const execPromise = realExecFile(cmd, args, opts);
      const tracked = execPromise.finally(() => { inFlight -= 1; });
      tracked.child = execPromise.child;
      return tracked;
    },
  });
  context.after(() => reader.close());

  const results = await Promise.all([
    reader.describeConversation({ host: "windsurf", conversation_id: "alpha-one" }),
    reader.describeConversation({ host: "windsurf", conversation_id: "beta-two" }),
    reader.describeConversation({ host: "windsurf", conversation_id: "gamma-three" }),
  ]);
  assert.equal(maxInFlight, 1);
  assert.equal(totalQueries, 9); // 3 calls * (desktop_mapping + cli_session + desktop_info)
  for (const res of results) {
    assert.equal(res.conversation_exists, true);
    assert.equal(res.code, undefined);
  }

  // 1b. Queued caller aborts immediately with ls_cancelled; holder abort still waits for child close before handing slot to next queued caller
  const executions = [];
  const waitForDatabaseStart = async index => {
    const deadline = performance.now() + 4000;
    while (executions.length <= index) {
      assert.ok(performance.now() < deadline, "test database did not start for position " + index);
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  };
  const controlledReader = createWindsurfDesktopStatusReader({
    userDataDir: fx.userDataDir,
    cliDataDir: fx.cliDataDir,
    installRoots: [fx.installRoot],
    listProcesses: async () => [fx.mainProcess],
    serializeDatabase: true,
    timeoutMs: 8000,
    databaseTimeoutMs: 1800,
    executeDatabase: (_cmd, _args, { signal }) => {
      const d = deferred();
      const child = new EventEmitter();
      const onAbort = () => d.reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      signal.addEventListener("abort", onAbort, { once: true });
      child.once("close", () => signal.removeEventListener("abort", onAbort));
      d.promise.child = child;
      const rec = { ...d, child, signal };
      executions.push(rec);
      return d.promise;
    },
  });
  context.after(async () => {
    const closing = controlledReader.close();
    for (const execution of executions) {
      if (execution.signal.aborted) execution.child.emit("close", null, "SIGTERM");
    }
    await closing;
  });

  const desktopTarget = { host: "windsurf", conversation_id: fx.desktopIds.get("alpha-one") };
  const ctrlA = new AbortController();
  const ctrlB = new AbortController();
  const reqA = controlledReader.describeConversation(desktopTarget, { signal: ctrlA.signal });
  reqA.catch(() => {});
  await waitForDatabaseStart(0);
  const reqB = controlledReader.describeConversation(desktopTarget, { signal: ctrlB.signal });
  const reqC = controlledReader.describeConversation(desktopTarget);
  reqB.catch(() => {});
  reqC.catch(() => {});
  await new Promise(r => setImmediate(r));
  assert.equal(executions.length, 1);

  // Cancel queued B -> immediately exits without waiting for A
  ctrlB.abort();
  await assert.rejects(reqB, { code: "ls_cancelled" });
  assert.equal(executions.length, 1);

  // Cancel active A -> A rejects immediately, but slot stays held until childA emits close!
  ctrlA.abort();
  await assert.rejects(reqA, { code: "ls_cancelled" });
  await new Promise(r => setImmediate(r));
  assert.equal(executions.length, 1);

  // Release childA -> C starts immediately and completes
  executions[0].child.emit("close", null, "SIGTERM");
  await waitForDatabaseStart(1);
  assert.equal(executions.length, 2);
  executions[1].resolve({ stdout: JSON.stringify({ state: "ready", found: true, value: JSON.stringify({ configOptions: [{ id: "model", currentValue: "swe-2-max" }] }) }) });
  executions[1].child.emit("close", 0, null);
  const resC = await reqC;
  assert.equal(resC.conversation_exists, true);

  // 1c. Bounded queue cap at 16: 1 active + 16 queued succeed, 18th returns ls_target_unavailable immediately
  executions.length = 0;
  const holder = controlledReader.describeConversation(desktopTarget);
  holder.catch(() => {});
  await waitForDatabaseStart(0);
  const queued = Array.from({ length: 17 }, () => controlledReader.describeConversation(desktopTarget));
  const overflow = await Promise.race(queued);
  assert.equal(overflow.conversation_exists, "unknown");
  assert.equal(overflow.code, "ls_target_unavailable");

  // Drain the 1 active + 16 queued sequentially
  const finishNext = async expectedIndex => {
    await waitForDatabaseStart(expectedIndex);
    executions[expectedIndex].resolve({ stdout: JSON.stringify({ state: "ready", found: true, value: JSON.stringify({ configOptions: [{ id: "model", currentValue: "swe-2-max" }] }) }) });
    executions[expectedIndex].child.emit("close", 0, null);
  };
  for (let i = 0; i < 17; i += 1) await finishNext(i);
  const drained = await Promise.all([holder, ...queued]);
  assert.equal(drained.length, 18);
  assert.equal(drained.filter(entry => entry.conversation_exists === true).length, 17);
  assert.equal(drained.filter(entry => entry.code === "ls_target_unavailable").length, 1);
});

test("default executeFile process snapshot caches successful results for 2500ms and never caches unknown", async context => {
  const fx = createWorkspaceFixture(context);
  let calls = 0;
  let nextStdout = JSON.stringify({ complete: true, processes: [fx.mainProcess] });
  const original = childProcess.execFile;
  const stub = () => { throw new Error("promisify.custom expected"); };
  stub[promisify.custom] = async () => {
    calls += 1;
    if (nextStdout === "THROW") throw new Error("transient_powershell_error");
    return { stdout: nextStdout };
  };

  let createReaderIsolated;
  try {
    childProcess.execFile = stub;
    syncBuiltinESMExports();
    ({ createWindsurfDesktopStatusReader: createReaderIsolated } = await import("../src/windsurf-desktop-status.mjs?stage3b_proc_cache"));
  } finally {
    childProcess.execFile = original;
    syncBuiltinESMExports();
  }

  let fakeNow = 1_795_000_000_000;
  const reader = createReaderIsolated({
    userDataDir: fx.userDataDir,
    cliDataDir: fx.cliDataDir,
    installRoots: [fx.installRoot],
    now: () => fakeNow,
  });
  context.after(() => reader.close());

  const first = await reader.getHostStatus({ host: "windsurf" });
  assert.equal(first.host_online, true);
  assert.equal(calls, 1);

  // Within 2500ms TTL -> cache hit, no extra powershell invocation
  fakeNow += 2499;
  const second = await reader.getHostStatus({ host: "windsurf" });
  assert.equal(second.host_online, true);
  assert.equal(calls, 1);

  // Past 2500ms TTL -> refreshes; failure returns unknown and is NOT cached
  fakeNow += 2;
  nextStdout = "THROW";
  const third = await reader.getHostStatus({ host: "windsurf" });
  assert.equal(third.host_online, "unknown");
  assert.equal(calls, 2);

  // Immediate retry after unknown -> must invoke again (not cached)
  nextStdout = JSON.stringify({ complete: true, processes: [fx.mainProcess] });
  const fourth = await reader.getHostStatus({ host: "windsurf" });
  assert.equal(fourth.host_online, true);
  assert.equal(calls, 3);
});

test("new session with empty sessions.model returns UI current_selection via liveTransport while preserving unknown without liveTransport or on conflict", async context => {
  const fx = createWorkspaceFixture(context, {
    sessions: [
      { slug: "fresh-default", cliModel: "", uiModel: "gpt-6-astra-max-priority", mainChainId: null },
      { slug: "conflict-model", cliModel: "swe-2-max", uiModel: "gpt-6-astra-max-priority", mainChainId: null },
    ],
  });

  const transport = new WindsurfAcpTransport({
    appDataDir: fx.root,
    devinBinaryPath: fx.binPath,
    execute: (cmd, args, opts) => {
      if (cmd === fx.binPath) return Promise.resolve({ stdout: "devin daemon running (pid 7777), 1 session(s) loaded\n" });
      return realExecFile(cmd, args, opts);
    },
  });
  context.after(() => transport.close());

  const withTransport = createWindsurfDesktopStatusReader({
    userDataDir: fx.userDataDir,
    cliDataDir: fx.cliDataDir,
    installRoots: [fx.installRoot],
    listProcesses: async () => [fx.mainProcess],
    configured_delivery_modes: { next_model_boundary: true, when_idle: true },
    transportProbe: (target, ctx) => transport.probeStatus(target, ctx),
    serializeDatabase: true,
    timeoutMs: 8000,
    databaseTimeoutMs: 1800,
  });
  context.after(() => withTransport.close());

  // 1. sessions.model === "" -> persisted_model === null -> UI selection accepted!
  const fresh = await withTransport.describeConversation({ host: "windsurf", conversation_id: "fresh-default" });
  assert.equal(fresh.conversation_exists, true);
  assert.equal(fresh.model_observation.current_selection.model, "gpt-6-astra-max-priority");
  assert.equal(fresh.model_observation.current_selection.source, "windsurf_devin_meta_info_configOptions_model_currentValue_persisted");

  // 2. Non-empty sessions.model conflicts with UI model -> remains unknown
  const conflict = await withTransport.describeConversation({ host: "windsurf", conversation_id: "conflict-model" });
  assert.equal(conflict.model_observation.current_selection.model, "unknown");
  assert.equal(conflict.model_observation.current_selection.raw_model, "gpt-6-astra-max-priority");

  // 3. Without liveTransport (s8 compatibility) -> remains unknown + raw_model
  const withoutTransport = createWindsurfDesktopStatusReader({
    userDataDir: fx.userDataDir,
    cliDataDir: fx.cliDataDir,
    installRoots: [fx.installRoot],
    listProcesses: async () => [fx.mainProcess],
  });
  context.after(() => withoutTransport.close());
  const legacy = await withoutTransport.describeConversation({ host: "windsurf", conversation_id: "fresh-default" });
  assert.equal(legacy.model_observation.current_selection.model, "unknown");
  assert.equal(legacy.model_observation.current_selection.raw_model, "gpt-6-astra-max-priority");
});

test("OpenAI Responses API Astra node (finish_reason: null + telemetry.operation: inference) extracts last_invocation, reports idle via single probe_session, and rejects malformed null finish_reason", async context => {
  const astraNode = {
    role: "assistant",
    content: "Astra inference done " + "x".repeat(90000),
    metadata: {
      generation_model: "gpt-6-astra-max-priority",
      request_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      started_generation_at: "2026-11-22T08:00:01.100Z",
      created_at: "2026-11-22T08:00:05.500Z",
      finish_reason: null,
      telemetry: { operation: "inference" },
    },
  };
  const malformedNullFinish = {
    role: "assistant",
    content: "Malformed null finish without telemetry",
    metadata: {
      generation_model: "gpt-6-astra-max-priority",
      request_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      started_generation_at: "2026-11-22T08:00:01.100Z",
      created_at: "2026-11-22T08:00:05.500Z",
      finish_reason: null,
    },
  };
  const astraWithTools = {
    role: "assistant",
    content: "",
    tool_calls: [{ id: "tc-1", name: "run" }],
    metadata: {
      generation_model: "gpt-6-astra-max-priority",
      request_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      started_generation_at: "2026-11-22T08:00:01.100Z",
      created_at: "2026-11-22T08:00:05.500Z",
      finish_reason: null,
      telemetry: { operation: "inference" },
    },
  };
  const astraMissingCreatedAt = {
    role: "assistant",
    content: "Incomplete metadata",
    metadata: {
      generation_model: "gpt-6-astra-max-priority",
      request_id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      started_generation_at: "2026-11-22T08:00:01.100Z",
      finish_reason: null,
      telemetry: { operation: "inference" },
    },
  };
  const compactorSummary = {
    role: "assistant",
    content: "Compacted context summary",
    metadata: {
      generation_model: "compactor",
      request_id: "12121212-1212-4212-8212-121212121212",
      started_generation_at: "2026-11-22T08:01:00.000Z",
      created_at: "2026-11-22T08:01:02.000Z",
      finish_reason: null,
      telemetry: { operation: "inference" },
    },
  };
  const missingFinishKeyWithTelemetry = {
    role: "assistant",
    content: "Missing finish_reason key",
    metadata: {
      generation_model: "gpt-6-astra-max-priority",
      request_id: "34343434-3434-4434-8434-343434343434",
      started_generation_at: "2026-11-22T08:00:01.100Z",
      created_at: "2026-11-22T08:00:05.500Z",
      telemetry: { operation: "inference" },
    },
  };

  const fx = createWorkspaceFixture(context, {
    sessions: [
      { slug: "astra-idle", cliModel: "", uiModel: "gpt-6-astra-max-priority", mainChainId: 2, nodes: [{ nodeId: 2, parentId: null, message: astraNode }] },
      { slug: "malformed-null", cliModel: "gpt-6-astra-max-priority", uiModel: "gpt-6-astra-max-priority", mainChainId: 2, nodes: [{ nodeId: 2, parentId: null, message: malformedNullFinish }] },
      { slug: "astra-tools", cliModel: "gpt-6-astra-max-priority", uiModel: "gpt-6-astra-max-priority", mainChainId: 2, nodes: [{ nodeId: 2, parentId: null, message: astraWithTools }] },
      { slug: "astra-no-ts", cliModel: "gpt-6-astra-max-priority", uiModel: "gpt-6-astra-max-priority", mainChainId: 2, nodes: [{ nodeId: 2, parentId: null, message: astraMissingCreatedAt }] },
      { slug: "astra-compacting", cliModel: "gpt-6-astra-max-priority", uiModel: "gpt-6-astra-max-priority", mainChainId: 3, nodes: [{ nodeId: 2, parentId: null, message: astraNode }, { nodeId: 3, parentId: 2, message: compactorSummary }] },
      { slug: "astra-missing-fr-key", cliModel: "gpt-6-astra-max-priority", uiModel: "gpt-6-astra-max-priority", mainChainId: 2, nodes: [{ nodeId: 2, parentId: null, message: missingFinishKeyWithTelemetry }] },
    ],
  });

  const sqliteKinds = [];
  let daemonChecks = 0;
  const transport = new WindsurfAcpTransport({
    appDataDir: fx.root,
    devinBinaryPath: fx.binPath,
    execute: (cmd, args, opts) => {
      if (cmd === fx.binPath) {
        daemonChecks += 1;
        return Promise.resolve({ stdout: "devin daemon running (pid 8888), 4 session(s) loaded\n" });
      }
      if (args.includes("--windsurf-acp-transport-sqlite-query")) {
        sqliteKinds.push(JSON.parse(args.at(-1)).kind);
      }
      return realExecFile(cmd, args, opts);
    },
  });
  context.after(() => transport.close());

  const reader = createWindsurfDesktopStatusReader({
    userDataDir: fx.userDataDir,
    cliDataDir: fx.cliDataDir,
    installRoots: [fx.installRoot],
    listProcesses: async () => [fx.mainProcess],
    configured_delivery_modes: { next_model_boundary: true, when_idle: true },
    transportProbe: (target, ctx) => transport.probeStatus(target, ctx),
    serializeDatabase: true,
    timeoutMs: 8000,
    databaseTimeoutMs: 2000,
    maxRecordBytes: 524288,
    processCacheTtlMs: 5000,
  });
  context.after(() => reader.close());

  // 1. Astra finished node -> last_invocation extracted, telemetry_op not exposed, idle=true (conversation_running=false), single probe_session child
  const astraStatus = await reader.describeConversation({ host: "windsurf", conversation_id: "astra-idle" });
  assert.equal(astraStatus.conversation_exists, true);
  assert.equal(astraStatus.conversation_running, false);
  assert.equal(astraStatus.can_deliver, true);
  assert.equal(astraStatus.model_observation.current_selection.model, "gpt-6-astra-max-priority");
  assert.equal(astraStatus.model_observation.last_invocation.model, "gpt-6-astra-max-priority");
  assert.equal(Object.hasOwn(astraStatus.model_observation.last_invocation, "telemetry_op"), false);
  assert.equal(JSON.stringify(astraStatus).includes("telemetry_op"), false);
  assert.deepEqual(sqliteKinds, ["probe_session"]);
  assert.equal(daemonChecks, 1);

  // Direct check_idle also reports idle: true for Astra
  const directIdle = await transport.sqliteQuery({ path: fx.cliPath, kind: "check_idle", slug: "astra-idle" });
  assert.equal(directIdle.state, "ready");
  assert.equal(directIdle.found, true);
  assert.equal(directIdle.idle, true);

  // 2. Malformed finish_reason: null without telemetry.operation="inference" -> rejected for both last_invocation and idle
  const malformedStatus = await reader.describeConversation({ host: "windsurf", conversation_id: "malformed-null" });
  assert.equal(malformedStatus.model_observation.last_invocation.model, "unknown");
  assert.equal(malformedStatus.conversation_running, true);
  // Daemon status reused from 3000ms cache!
  assert.equal(daemonChecks, 1);

  // 3. Astra node with tool_calls or missing metadata.created_at -> not idle (conversation_running=true)
  const toolsProbe = await transport.probeStatus({ host: "windsurf", conversation_id: "astra-tools" });
  assert.equal(toolsProbe.conversation_running, true);
  const noTsProbe = await transport.probeStatus({ host: "windsurf", conversation_id: "astra-no-ts" });
  assert.equal(noTsProbe.conversation_running, true);

  // 4. Compactor summary node at head: conversation_running stays true (busy) and last_invocation skips compactor to return real parent model!
  const compactStatus = await reader.describeConversation({ host: "windsurf", conversation_id: "astra-compacting" });
  assert.equal(compactStatus.conversation_running, true);
  assert.equal(compactStatus.model_observation.last_invocation.model, "gpt-6-astra-max-priority");
  assert.equal(compactStatus.model_observation.last_invocation.step_index, 2);

  // 5. Missing finish_reason key (json_type === null instead of 'null') is strictly rejected for both last_invocation and idle!
  const missingKeyStatus = await reader.describeConversation({ host: "windsurf", conversation_id: "astra-missing-fr-key" });
  assert.equal(missingKeyStatus.model_observation.last_invocation.model, "unknown");
  assert.equal(missingKeyStatus.conversation_running, true);
});

test("3 concurrent long-turn sessions detach safely once persisted_session_node settles so the 3rd session borrows a pool slot immediately", async context => {
  const fx = createWorkspaceFixture(context, {
    sessions: [
      { slug: "turn-one", cliModel: "swe-2-max", uiModel: "swe-2-max", mainChainId: 1, nodes: [{ nodeId: 1, parentId: null, message: { role: "assistant", content: "ready", metadata: { finish_reason: "stop" } } }] },
      { slug: "turn-two", cliModel: "swe-2-max", uiModel: "swe-2-max", mainChainId: 1, nodes: [{ nodeId: 1, parentId: null, message: { role: "assistant", content: "ready", metadata: { finish_reason: "stop" } } }] },
      { slug: "turn-three", cliModel: "swe-2-max", uiModel: "swe-2-max", mainChainId: 1, nodes: [{ nodeId: 1, parentId: null, message: { role: "assistant", content: "ready", metadata: { finish_reason: "stop" } } }] },
    ],
  });

  let autoPersist = true;
  let nextNodeId = 10;
  const makeFakeSpawn = () => (_cmd, _args) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => { child.emit("exit", 0); };
    child.stdin.on("data", chunk => {
      for (const line of chunk.toString("utf8").split("\n").filter(Boolean)) {
        const req = JSON.parse(line);
        if (req.method === "initialize") {
          child.stdout.write(JSON.stringify({
            jsonrpc: "2.0",
            id: req.id,
            result: {
              protocolVersion: 1,
              agentCapabilities: { loadSession: true, _meta: { "cognition.ai/midTurnPrompts": true, "cognition.ai/daemon": true } },
              _meta: { "cognition.ai/daemon": { protocolVersion: 2, pid: 9090 } },
            },
          }) + "\n");
        } else if (req.method === "authenticate") {
          child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: {} }) + "\n");
        } else if (req.method === "session/load") {
          child.stdout.write(JSON.stringify({
            jsonrpc: "2.0",
            id: req.id,
            result: { configOptions: [{ id: "model", currentValue: "swe-2-max" }] },
          }) + "\n");
        } else if (req.method === "session/prompt") {
          // Simulate long-running daemon turn: NO RPC reply yet, only persist user message node into SQLite WAL!
          if (autoPersist) {
            const slug = req.params.sessionId;
            const promptText = req.params.prompt[0].text;
            setTimeout(() => {
              if (!fx.cli.isOpen) return;
              const nodeId = nextNodeId++;
              fx.cli.prepare("INSERT INTO message_nodes(session_id, node_id, parent_node_id, chat_message, created_at) VALUES (?, ?, 1, ?, ?)")
                .run(slug, nodeId, JSON.stringify({ role: "user", content: promptText, metadata: { is_user_input: 1 } }), 1795286000);
              fx.cli.prepare("UPDATE sessions SET main_chain_id = ? WHERE id = ?").run(nodeId, slug);
            }, 60);
          }
        }
      }
    });
    return child;
  };

  const transport = new WindsurfAcpTransport({
    appDataDir: fx.root,
    devinBinaryPath: fx.binPath,
    maxActiveClients: 2,
    settleDelayMs: 10,
    spawnProcess: makeFakeSpawn(),
    execute: (cmd, args, opts) => {
      if (cmd === fx.binPath) return Promise.resolve({ stdout: "devin daemon running (pid 9090), 3 session(s) loaded\n" });
      return realExecFile(cmd, args, opts);
    },
  });
  context.after(() => transport.close());

  const adapter = new WindsurfAcpDeliveryAdapter({
    clientForTarget: (target, ctx) => transport.clientForTarget(target, ctx),
    verifyPersistedDelivery: (target, ctx) => transport.verifyPersistedDelivery(target, ctx),
  });

  const makeDeliveryInput = (slug, suffix) => {
    const target = {
      machine_id: "development", host: "windsurf", surface: "desktop", conversation_id: slug,
      binding_id: `bind-${slug}`, binding_generation: 1, adapter_id: "wsf-acp",
      capabilities: { next_model_boundary: true, when_idle: true },
    };
    return {
      target,
      message: {
        message_id: `11111111-1111-4111-8111-11111111111${suffix}`,
        envelope: {
          caller: { machine_id: "development", host: "antigravity", surface: "desktop", conversation_id: "caller-main" },
          origin: { kind: "agent_message", channel: "antigravity", source_ref: "caller-main" },
          target,
          text: `long turn message ${suffix}`,
          delivery_policy: "next_model_boundary",
          attachment_refs: [],
        },
      },
      delivery: {
        delivery_id: `22222222-2222-4222-8222-22222222222${suffix}`,
        message_id: `11111111-1111-4111-8111-11111111111${suffix}`,
        target_key: identityKey(target),
        status: "prepared",
        attempt_count: 1,
      },
    };
  };

  // Deliver to turn-one first, then turn-two (so turn-one has older last_activity_at)
  const input1 = makeDeliveryInput("turn-one", "1");
  const res1 = await adapter.deliver(input1);
  assert.equal(res1.outcome, "accepted");
  assert.equal(res1.evidence.native.kind, "persisted_session_node");

  await new Promise(r => setTimeout(r, 30));

  const input2 = makeDeliveryInput("turn-two", "2");
  const res2 = await adapter.deliver(input2);
  assert.equal(res2.outcome, "accepted");
  assert.equal(res2.evidence.native.kind, "persisted_session_node");

  assert.equal(transport.active.size, 2);
  const desc1 = transport.active.get("turn-one").client.describe();
  const desc2 = transport.active.get("turn-two").client.describe();
  assert.equal(desc1.turn_active, true);
  assert.equal(desc2.turn_active, true);
  assert.equal(desc1.can_detach_safely, true);
  assert.equal(desc2.can_detach_safely, true);

  // Deliver to 3rd session while both turns are still running -> evicts oldest safely-detachable (turn-one) and succeeds!
  const input3 = makeDeliveryInput("turn-three", "3");
  const res3 = await adapter.deliver(input3);
  assert.equal(res3.outcome, "accepted");
  assert.equal(res3.evidence.native.kind, "persisted_session_node");
  assert.equal(transport.active.size, 2);
  assert.equal(transport.active.has("turn-one"), false);
  assert.equal(transport.active.has("turn-two"), true);
  assert.equal(transport.active.has("turn-three"), true);

  // Detached turn-one retains its accepted receipt in retainedClosed for queryOnly lookups
  const queried1 = await adapter.query(input1);
  assert.equal(queried1.outcome, "accepted");
  assert.equal(queried1.evidence.native.kind, "persisted_session_node");

  // Unsettled prompt must NOT be detachable: trigger unsettled prompts on both active slots and verify 3rd session cannot evict them
  autoPersist = false;
  const c2 = transport.active.get("turn-two").client;
  const c3 = transport.active.get("turn-three").client;
  const p2 = c2.deliver({ message_id: "unsettled-m2", delivery_id: "unsettled-d2", text: "still inflight 2" });
  const p3 = c3.deliver({ message_id: "unsettled-m3", delivery_id: "unsettled-d3", text: "still inflight 3" });
  await new Promise(r => setImmediate(r));
  assert.equal(c2.describe().can_detach_safely, false);
  assert.equal(c3.describe().can_detach_safely, false);
  const blocked = await transport.clientForTarget({ host: "windsurf", surface: "desktop", conversation_id: "turn-one" });
  assert.equal(blocked, null);
  await transport.close();
  await Promise.allSettled([p2, p3]);
});

test("WindsurfAcpTransport and live-runtime default max_active_clients to 8 and allow 1..16", async context => {
  const defaultTransport = new WindsurfAcpTransport();
  const cappedTransport = new WindsurfAcpTransport({ maxActiveClients: 99 });
  context.after(async () => {
    await defaultTransport.close();
    await cappedTransport.close();
  });
  assert.equal(defaultTransport.maxActiveClients, 8);
  assert.equal(cappedTransport.maxActiveClients, 16);

  const dir = mkdtempSync(path.join(os.tmpdir(), "wsf-runtime-cfg-"));
  context.after(() => rmSync(dir, { recursive: true, force: true }));

  const buildConfig = maxActiveClients => ({
    adapter_mode: "live_test",
    allowed_conversation_ids: ["alpha-one"],
    adapters: [
      { id: "wsf-acp", kind: "windsurf_acp", ...(maxActiveClients === undefined ? {} : { max_active_clients: maxActiveClients }) },
    ],
    targets: [{
      machine_id: "development", host: "windsurf", surface: "desktop", conversation_id: "alpha-one",
      binding_id: "wsf-b1", binding_generation: 1, adapter_id: "wsf-acp",
      capabilities: { next_model_boundary: true, when_idle: true }, evidence: "simulated",
    }],
    principals: [{
      id: "caller-p1", token: "tok-stage3b",
      identity: { machine_id: "development", host: "antigravity", surface: "desktop", conversation_id: "caller-1" },
      allowed_targets: ["wsf-b1"],
    }],
  });

  // Default -> 8, max valid -> 16
  for (const [configured, expected] of [[undefined, 8], [16, 16]]) {
    const configPath = path.join(dir, `cfg-${expected}.json`);
    const stateDir = path.join(dir, `state-${expected}`);
    writeFileSync(configPath, JSON.stringify(buildConfig(configured)), "utf8");
    let captured;
    const service = await startLiveFromConfig({
      configPath,
      stateDir,
      factories: {
        windsurf_acp: entry => {
          captured = entry;
          return new MockAdapter();
        },
      },
    });
    try {
      assert.equal(captured.max_active_clients, expected);
    } finally {
      await service.close();
    }
  }

  // Out of bounds -> invalid_config
  for (const invalid of [0, 17]) {
    const configPath = path.join(dir, `cfg-bad-${invalid}.json`);
    const stateDir = path.join(dir, `state-bad-${invalid}`);
    writeFileSync(configPath, JSON.stringify(buildConfig(invalid)), "utf8");
    await assert.rejects(
      startLiveFromConfig({ configPath, stateDir, factories: { windsurf_acp: () => new MockAdapter() } }),
      { code: "invalid_config" },
    );
  }
});
