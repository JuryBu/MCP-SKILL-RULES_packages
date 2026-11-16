import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { HostStatusProvider } from "../src/host-status.mjs";
import { projectModelObservation } from "../src/host-model-observation.mjs";
import { createWindsurfDesktopStatusReader } from "../src/windsurf-desktop-status.mjs";

const SLUG = "fixture-pewter";
const DESKTOP_ID = createHash("sha1").update(`devin-acp/devin-cli/${SLUG}`).digest("hex");
const OBSERVED_AT = "2026-11-16T17:00:00.000Z";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

function fixture(context, options = {}) {
  const tempRoot = path.resolve(os.tmpdir());
  const directory = mkdtempSync(path.join(tempRoot, "wsf-desktop-status-"));
  const userDataDir = path.join(directory, "Devin", "User");
  const cliDataDir = path.join(directory, "Devin", "cli");
  const installRoot = path.join(directory, "Programs", "Devin");
  const connections = [];
  const readers = [];
  mkdirSync(path.join(userDataDir, "acp-messages"), { recursive: true });
  mkdirSync(path.join(userDataDir, "globalStorage"), { recursive: true });
  mkdirSync(path.join(cliDataDir, "session_locks"), { recursive: true });
  const target = { host: "windsurf", conversation_id: SLUG };
  const process = (pid, relativePath = "Devin.exe", argumentsList = [], parentPid = 1, createdAt = "2026-11-16T16:00:00.000Z") => {
    const executablePath = path.join(installRoot, relativePath);
    return { pid, parent_pid: parentPid, executable_path: executablePath,
      command_line: [`"${executablePath}"`, ...argumentsList].join(" "), created_at: createdAt };
  };
  const main = () => process(101);
  const helper = () => process(102, "Devin.exe", ["--type=utility", "--utility-sub-type=node.mojom.NodeService"], 101, "2026-11-16T16:01:00.000Z");
  const acp = (argumentsList = ["acp"], parentPid = 102) => process(103,
    path.join("resources", "app", "extensions", "windsurf", "devin", "bin", "devin.exe"), argumentsList, parentPid,
    "2026-11-16T16:02:00.000Z");
  const reader = overrides => {
    const value = createWindsurfDesktopStatusReader({ userDataDir, cliDataDir, installRoots: [installRoot],
      now: () => Date.parse(OBSERVED_AT), listProcesses: async () => [], ...options, ...overrides });
    readers.push(value);
    return value;
  };
  const database = (filePath, schema) => {
    const connection = new DatabaseSync(filePath);
    connections.push(connection);
    connection.exec(schema);
    return connection;
  };
  context.after(async () => {
    await Promise.all(readers.map(value => value.close()));
    for (const connection of connections) if (connection.isOpen) connection.close();
    const relative = path.relative(tempRoot, directory);
    assert.ok(relative.startsWith("wsf-desktop-status-") && !relative.includes(path.sep));
    rmSync(directory, { recursive: true, force: true });
    assert.equal(existsSync(directory), false);
  });
  return { directory, userDataDir, cliDataDir, installRoot, target, reader, process, main, helper, acp, database };
}

function digestTree(directory) {
  return readdirSync(directory, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).map(entry => {
    const filePath = path.join(entry.parentPath, entry.name);
    return { path: path.relative(directory, filePath), size: statSync(filePath).size, modifiedAt: statSync(filePath).mtimeMs,
      hash: createHash("sha256").update(readFileSync(filePath)).digest("hex") };
  }).sort((left, right) => left.path.localeCompare(right.path));
}

function sqliteFixture(context, { slug = SLUG, model = "ui-selected-model", cliModel = "cli-configured-model", includeCli = true, includeDesktop = true,
  mappingId, mappingValue, info, journal = "delete" } = {}) {
  const sample = fixture(context);
  const desktopId = createHash("sha1").update(`devin-acp/devin-cli/${slug}`).digest("hex");
  const cliPath = path.join(sample.cliDataDir, "sessions.db");
  const desktopPath = path.join(sample.userDataDir, "acp-messages", `${desktopId}.db`);
  const mappingPath = path.join(sample.userDataDir, "globalStorage", "state.vscdb");
  let cli;
  let desktop;
  if (includeCli) {
    cli = sample.database(cliPath, `CREATE TABLE sessions(id TEXT PRIMARY KEY, model TEXT NOT NULL, agent_mode TEXT NOT NULL, last_activity_at INTEGER NOT NULL, main_chain_id INTEGER DEFAULT 1);
      CREATE TABLE message_nodes(row_id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, node_id INTEGER NOT NULL, parent_node_id INTEGER, chat_message TEXT NOT NULL, created_at INTEGER NOT NULL, metadata TEXT, UNIQUE(session_id,node_id));`);
    cli.exec(`PRAGMA journal_mode=${journal}`);
    cli.prepare("INSERT INTO sessions(id,model,agent_mode,last_activity_at) VALUES (?, ?, 'bypass', 1)").run(slug, cliModel);
    cli.prepare("INSERT INTO message_nodes(session_id,node_id,chat_message,created_at) VALUES (?,1,?,1)").run(slug, "private-cli-message-and-thought");
  }
  if (includeDesktop) {
    desktop = sample.database(desktopPath, "CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE messages(position INTEGER PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL)");
    desktop.exec(`PRAGMA journal_mode=${journal}`);
    desktop.prepare("INSERT INTO meta VALUES ('info', ?)").run(JSON.stringify(info ?? {
      configOptions: [{ id: "model", currentValue: model }], title: "private-title", availableCommands: [{ name: "private-command-secret" }],
    }));
    desktop.prepare("INSERT INTO messages VALUES (1,'agent_thought',?)").run("private-ui-message-and-thought");
  }
  const mapping = sample.database(mappingPath, "CREATE TABLE ItemTable(key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)");
  mapping.prepare("INSERT INTO ItemTable VALUES (?, ?)").run(`windsurf.acp.messageStore.session.acp/devin-cli/${slug}`,
    Buffer.from(mappingValue ?? JSON.stringify({ uuid: mappingId ?? desktopId })));
  return { ...sample, cli, desktop, mapping, cliPath, desktopPath, mappingPath, desktopId, slug,
    target: { host: "windsurf", conversation_id: slug } };
}

test("slug point lookups use the explicit state mapping and deterministic Desktop identity", async context => {
  const sample = sqliteFixture(context);
  const before = digestTree(sample.directory);
  const status = await sample.reader().describeConversation(sample.target);
  assert.equal(status.host_online, false);
  assert.equal(status.conversation_exists, true);
  assert.equal(status.conversation_running, false);
  assert.equal(status.can_deliver, false);
  assert.deepEqual(status.identity, { desktop_id: sample.desktopId, cli_session_id: SLUG, source: "devin_state_vscdb_uuid_and_cli_slug_sha1" });
  assert.deepEqual(digestTree(sample.directory), before);
});

test("a 40hex target reads only its exact UI file and preserves an unknown reverse mapping", async context => {
  const sample = sqliteFixture(context);
  const status = await sample.reader().describeConversation({ host: "windsurf", conversation_id: sample.desktopId.toUpperCase(), path: sample.cliPath });
  assert.equal(status.conversation_exists, true);
  assert.equal(status.identity.desktop_id, sample.desktopId);
  assert.equal(status.identity.cli_session_id, "unknown");
  assert.equal(status.session_lock_evidence, "unknown_identity");
});

test("a conflicting or malformed mapping is ambiguous and never follows its UUID as an arbitrary path", async context => {
  for (const mappingValue of [JSON.stringify({ uuid: "f".repeat(40) }), JSON.stringify({ uuid: "../outside" }), "{broken", JSON.stringify([{ uuid: DESKTOP_ID }])]) {
    const sample = sqliteFixture(context, { mappingValue });
    const before = digestTree(sample.directory);
    const status = await sample.reader().describeConversation(sample.target);
    assert.equal(status.conversation_exists, "unknown");
    assert.equal(status.conversation_running, "unknown");
    assert.equal(status.code, "ls_target_ambiguous");
    assert.equal(status.identity.desktop_id, "unknown");
    assert.deepEqual(digestTree(sample.directory), before);
  }
});

test("nonexistent CLI rows and missing databases are distinguished", async context => {
  const sample = sqliteFixture(context, { includeDesktop: false });
  const status = await sample.reader().describeConversation({ host: "windsurf", conversation_id: "absent-session" });
  assert.equal(status.conversation_exists, false);
  assert.equal(status.conversation_running, false);
  const missing = fixture(context);
  const absent = await missing.reader().describeConversation(missing.target);
  assert.equal(absent.conversation_exists, "unknown");
  assert.equal(absent.host_online, false);
  assert.equal(absent.code, "ls_target_unavailable");
});

test("a CLI primary-key row proves disk existence when the UI cache is absent", async context => {
  const sample = sqliteFixture(context, { includeDesktop: false });
  const status = await sample.reader().describeConversation(sample.target);
  assert.equal(status.conversation_exists, true);
  assert.equal(status.model_observation.current_selection.model, "unknown");
  assert.equal(status.model_observation.last_invocation.model, "unknown");
});

test("corrupt databases and unsupported schemas fail closed without edits", async context => {
  const corrupt = fixture(context);
  writeFileSync(path.join(corrupt.cliDataDir, "sessions.db"), "invalid database fixture");
  const before = digestTree(corrupt.directory);
  assert.equal((await corrupt.reader().describeConversation(corrupt.target)).conversation_exists, "unknown");
  assert.deepEqual(digestTree(corrupt.directory), before);
  const unindexed = fixture(context);
  const database = unindexed.database(path.join(unindexed.cliDataDir, "sessions.db"), "CREATE TABLE sessions(id TEXT, model TEXT)");
  database.prepare("INSERT INTO sessions VALUES (?, 'configured')").run(SLUG);
  assert.equal((await unindexed.reader().describeConversation(unindexed.target)).conversation_exists, "unknown");
});

test("UI persisted selection, CLI configured model and actual invocation remain separate", async context => {
  const sample = sqliteFixture(context);
  const reader = sample.reader({ listProcesses: async () => [sample.main(), sample.helper(), sample.acp()] });
  const status = await reader.describeConversation(sample.target);
  const observation = status.model_observation;
  assert.equal(status.host_online, true);
  assert.equal(status.conversation_exists, true);
  assert.equal(status.conversation_running, "unknown");
  assert.equal(observation.current_selection.model, "unknown");
  assert.equal(observation.current_selection.raw_model, "ui-selected-model");
  assert.equal(observation.current_selection.code, "model_renderer_selection_missing");
  assert.equal(observation.current_selection.observed_at, OBSERVED_AT);
  assert.equal(observation.last_invocation.model, "unknown");
  assert.equal(observation.last_invocation.code, "model_invocation_not_exposed");
  assert.deepEqual(projectModelObservation(observation, reader.source), observation);
  for (const secret of ["private-title", "private-command-secret", "private-cli-message-and-thought", "private-ui-message-and-thought", "cli-configured-model"]) {
    assert.equal(JSON.stringify(status).includes(secret), false);
  }
  const offline = await sample.reader().describeConversation(sample.target);
  assert.equal(offline.model_observation.current_selection.model, "unknown");
  assert.equal(offline.conversation_running, false);
});

function invocationMessage(overrides = {}) {
  return { role: "assistant", content: "private-invocation-content", thinking: "private-invocation-thought",
    metadata: { generation_model: "swe-2-max", request_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      started_generation_at: "2026-11-16T19:29:32.208391400Z", created_at: "2026-11-16T19:29:39.438195400Z",
      finish_reason: "stop", ...overrides } };
}

function invocationNode(sample, nodeId, parentId, message = invocationMessage(), slug = sample.slug) {
  sample.cli.prepare("INSERT INTO message_nodes(session_id,node_id,parent_node_id,chat_message,created_at) VALUES (?,?,?,?,?)")
    .run(slug, nodeId, parentId, typeof message === "string" ? message : JSON.stringify(message), 1794857379);
}

test("CLI invocation follows the selected main chain, deduplicates requests and survives the existing model projector", async context => {
  const sample = sqliteFixture(context);
  invocationNode(sample, 2, null);
  invocationNode(sample, 3, 2);
  invocationNode(sample, 4, null, invocationMessage({ generation_model: "swe-2-flash-max", request_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }));
  invocationNode(sample, 999, null, invocationMessage({ generation_model: "off-session-model" }), "other-session");
  sample.cli.prepare("UPDATE sessions SET main_chain_id=3 WHERE id=?").run(sample.slug);
  const before = digestTree(sample.directory);
  const reader = sample.reader({ listProcesses: async () => [sample.main(), sample.helper(), sample.acp()] });
  const provider = new HostStatusProvider({ providers: { windsurf: reader } });
  context.after(() => provider.close());
  const status = await provider.getStatus(sample.target);
  const last = status.model_observation.last_invocation;
  assert.equal(last.model, "swe-2-max");
  assert.equal(last.source, "windsurf_devin_cli_message_nodes_metadata");
  assert.equal(last.field, "message_nodes/3/request/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/chat_message.metadata.generation_model");
  assert.equal(last.step_index, 3);
  assert.equal(last.conversation_id, sample.slug);
  assert.equal(last.observed_at, OBSERVED_AT);
  assert.equal(last.step_started_at, "2026-11-16T19:29:32.208391400Z");
  assert.equal(last.step_completed_at, "2026-11-16T19:29:39.438195400Z");
  assert.equal(status.model_observation.current_selection.model, "unknown");
  assert.equal(status.conversation_running, "unknown");
  assert.deepEqual(digestTree(sample.directory), before);
  for (const secret of ["private-invocation-content", "private-invocation-thought", "off-session-model", "swe-2-flash-max", "metrics"]) assert.equal(JSON.stringify(status).includes(secret), false);
});

test("CLI invocation rejects malformed, oversized, missing and conflicting duplicate metadata without losing disk identity", async context => {
  for (const invalid of ["{", JSON.stringify({ role: "assistant", metadata: {} }), invocationMessage({ generation_model: "sk-private" }),
    invocationMessage({ request_id: "private/not-a-request" }), invocationMessage({ finish_reason: null }),
    invocationMessage({ started_generation_at: "2027-11-16T19:29:32Z" }),
    { ...invocationMessage(), content: "private-large-".repeat(6000) }, null, "duplicate-conflict", "cycle", "missing-node"]) {
    const sample = sqliteFixture(context);
    if (invalid === "missing-node") sample.cli.prepare("UPDATE sessions SET main_chain_id=999 WHERE id=?").run(sample.slug);
    else {
      invocationNode(sample, 2, invalid === "cycle" ? 2 : null, invalid === "duplicate-conflict" || invalid === "cycle" ? invocationMessage() : invalid === null ? { role: "tool" } : invalid);
      if (invalid === "duplicate-conflict") invocationNode(sample, 3, 2, invocationMessage({ generation_model: "swe-2-flash-max" }));
      sample.cli.prepare("UPDATE sessions SET main_chain_id=? WHERE id=?").run(invalid === "duplicate-conflict" ? 3 : 2, sample.slug);
    }
    const before = digestTree(sample.directory);
    const status = await sample.reader().describeConversation(sample.target);
    assert.equal(status.conversation_exists, true);
    assert.equal(status.model_observation.last_invocation.model, "unknown");
    assert.deepEqual(digestTree(sample.directory), before);
  }
});

test("CLI invocation has a 32-node ancestor budget and no timestamp or off-branch fallback", async context => {
  const sample = sqliteFixture(context);
  invocationNode(sample, 2, null);
  for (let nodeId = 3; nodeId <= 34; nodeId += 1) invocationNode(sample, nodeId, nodeId - 1, { role: "tool" });
  sample.cli.prepare("UPDATE sessions SET main_chain_id=34 WHERE id=?").run(sample.slug);
  assert.equal((await sample.reader().describeConversation(sample.target)).model_observation.last_invocation.model, "unknown");
  sample.cli.prepare("UPDATE sessions SET main_chain_id=NULL WHERE id=?").run(sample.slug);
  assert.equal((await sample.reader().describeConversation(sample.target)).model_observation.last_invocation.model, "unknown");
});

test("CLI invocation is read from WAL using the same single CLI query child and preserves its files", async context => {
  const sample = sqliteFixture(context, { journal: "wal" });
  invocationNode(sample, 2, null);
  sample.cli.prepare("UPDATE sessions SET main_chain_id=2 WHERE id=?").run(sample.slug);
  let cliExecutions = 0;
  const execute = promisify(execFile);
  const reader = sample.reader({ executeDatabase: (executable, argumentsList, options) => {
    if (JSON.parse(argumentsList.at(-1)).kind === "cli_session") cliExecutions += 1;
    return execute(executable, argumentsList, options);
  } });
  const before = digestTree(sample.directory);
  const sharedMemory = [sample.cliPath, sample.desktopPath].map(databasePath => ({
    file: `${databasePath}-shm`, bytes: readFileSync(`${databasePath}-shm`),
  }));
  const status = await reader.describeConversation(sample.target);
  assert.equal(status.model_observation.last_invocation.model, "swe-2-max");
  assert.equal(cliExecutions, 1);
  const stableFiles = rows => rows.map(entry => entry.path.endsWith("-shm") ? { ...entry, hash: "sqlite-read-marks" } : entry);
  assert.deepEqual(stableFiles(digestTree(sample.directory)), stableFiles(before));
  for (const memory of sharedMemory) {
    const after = readFileSync(memory.file);
    const changed = Array.from(memory.bytes.keys()).filter(offset => memory.bytes[offset] !== after[offset]);
    assert.ok(changed.every(offset => offset >= 104 && offset < 120), JSON.stringify(changed));
  }
});

test("CLI invocation cancellation retains the database slot until the actual child exits", async context => {
  const sample = sqliteFixture(context);
  const began = deferred();
  const completion = deferred();
  const child = new EventEmitter();
  let cliExecutions = 0;
  let closed = false;
  const execute = promisify(execFile);
  const reader = sample.reader({ executeDatabase: (executable, argumentsList, options) => {
    if (JSON.parse(argumentsList.at(-1)).kind !== "cli_session") return execute(executable, argumentsList, options);
    cliExecutions += 1;
    options.signal.addEventListener("abort", () => completion.reject(new Error("cancelled")), { once: true });
    completion.promise.child = child;
    began.resolve();
    return completion.promise;
  } });
  const controller = new AbortController();
  const pending = reader.describeConversation(sample.target, { signal: controller.signal });
  await began.promise;
  controller.abort();
  await assert.rejects(pending, { code: "ls_cancelled" });
  const closing = reader.close().then(() => { closed = true; });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(closed, false);
    assert.equal(cliExecutions, 1);
  } finally {
    child.emit("close", null, "SIGTERM");
    await closing;
  }
  assert.equal(closed, true);
});

test("CLI invocation real child abort is reaped before reader close completes", async context => {
  const sample = sqliteFixture(context);
  const began = deferred();
  const execute = promisify(execFile);
  let child;
  let childClosed = false;
  const reader = sample.reader({ executeDatabase: (executable, argumentsList, options) => {
    if (JSON.parse(argumentsList.at(-1)).kind !== "cli_session") return execute(executable, argumentsList, options);
    const completion = execute(executable, ["-e", "setInterval(()=>{},1000)"], options);
    child = completion.child;
    child.once("close", () => { childClosed = true; });
    child.once("spawn", () => began.resolve());
    return completion;
  } });
  const controller = new AbortController();
  const pending = reader.describeConversation(sample.target, { signal: controller.signal });
  try {
    await began.promise;
    assert.equal(childClosed, false);
    controller.abort();
    await assert.rejects(pending, { code: "ls_cancelled" });
  } finally {
    controller.abort();
    await reader.close();
  }
  assert.equal(childClosed, true);
  assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
  sample.cli.exec("BEGIN EXCLUSIVE; ROLLBACK");
});

test("CLI invocation missing tables, oversized projected fields and tiny output budgets keep old existence results", async context => {
  for (const mode of ["missing-table", "oversized-model", "tiny-budget"]) {
    const sample = sqliteFixture(context);
    invocationNode(sample, 2, null, invocationMessage(mode === "oversized-model" ? { generation_model: "a".repeat(129) } : {}));
    sample.cli.prepare("UPDATE sessions SET main_chain_id=2 WHERE id=?").run(sample.slug);
    if (mode === "missing-table") sample.cli.exec("DROP TABLE message_nodes");
    const status = await sample.reader(mode === "tiny-budget" ? { maxRecordBytes: 256 } : {}).describeConversation(sample.target);
    assert.equal(status.conversation_exists, true);
    assert.equal(status.model_observation.last_invocation.model, "unknown");
  }
});

test("duplicate, invalid, oversized and missing model metadata never become observations", async context => {
  const cases = [
    { configOptions: [{ id: "model", currentValue: "first" }, { id: "model", currentValue: "second" }] },
    { configOptions: [{ id: "model", currentValue: "secret with spaces" }] },
    { configOptions: [{ id: "model", currentValue: "x".repeat(129) }] },
    { configOptions: [{ id: "model", currentValue: "x".repeat(70000) }] },
    { configOptions: [{ id: "model", currentValue: "sk-proj-fixture-key-must-stay-private" }] },
    { configOptions: [{ id: "model", currentValue: "valid" }], title: "x".repeat(1024 * 1024) },
    { configOptions: Array.from({ length: 65 }, (unused, index) => ({ id: index === 0 ? "model" : `option-${index}`, currentValue: "valid" })) },
    { configOptions: [{ id: "model", currentValue: "valid" }, { id: "mode" }, { id: "mode" }] },
    { configOptions: [{ currentValue: "valid" }] },
    { configOptions: [{ id: "model", currentValue: "valid" }, { id: "x".repeat(129) }] },
    { configOptions: [{ id: "model", currentValue: "valid" }, { id: 42 }] },
    { configOptions: [{ id: "model" }] },
    { configOptions: [{ id: "model", currentValue: { private: "hidden" } }] },
    { configOptions: [{ id: "model", currentValue: 123 }] },
    { configOptions: [{ id: "other", currentValue: "valid" }] },
    { configOptions: { id: "model", currentValue: "valid" } },
    { configOptions: [] },
    { title: "no-config-options" },
    [],
  ];
  let nested = {};
  for (let depth = 0; depth < 14; depth += 1) nested = { nested };
  cases.push({ configOptions: [{ id: "model", currentValue: nested }] });
  for (const info of cases) {
    const sample = sqliteFixture(context, { info });
    const result = await sample.reader().describeConversation(sample.target);
    assert.equal(result.conversation_exists, true);
    assert.equal(result.model_observation.current_selection.model, "unknown");
    assert.equal(result.model_observation.current_selection.raw_model, undefined);
  }
});

test("large realistic UI metadata is projected inside SQLite without returning choices or private fields", async context => {
  const sentinel = "PRIVATE_UI_CHOICE_SENTINEL_MUST_NOT_LEAVE_SQLITE";
  const choices = Array.from({ length: 2400 }, (unused, index) => ({ value: `catalogue-model-${index}`, label: `${sentinel}-${index}`, description: sentinel }));
  const info = {
    availableCommands: [{ name: sentinel, description: sentinel.repeat(200) }],
    title: sentinel,
    configOptions: [
      { id: "agent_mode", currentValue: sentinel },
      { id: "reasoning_effort", currentValue: sentinel },
      { id: "model", currentValue: "swe-2-max", choices },
      { id: "tools", currentValue: sentinel },
      { id: "style", currentValue: sentinel },
      { id: "context", currentValue: sentinel },
    ],
  };
  assert.ok(Buffer.byteLength(JSON.stringify(info.configOptions)) > 240 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(info)) < 1024 * 1024);
  const sample = sqliteFixture(context, { info, journal: "wal" });
  const before = digestTree(sample.directory).filter(entry => !entry.path.endsWith("-shm"));
  const request = { path: sample.desktopPath, kind: "desktop_info", key: "info", maxRecordBytes: 256 };
  const executeFile = promisify(execFile);
  const { stdout } = await executeFile(process.execPath, [fileURLToPath(new URL("../src/windsurf-desktop-status.mjs", import.meta.url)),
    "--windsurf-desktop-status-readonly-query", JSON.stringify(request)], { timeout: 3000, maxBuffer: 65536, windowsHide: true, encoding: "utf8" });
  assert.ok(Buffer.byteLength(stdout) <= 256);
  assert.equal(stdout.includes(sentinel), false);
  assert.deepEqual(JSON.parse(JSON.parse(stdout).value), { configOptions: [{ id: "model", currentValue: "swe-2-max" }] });
  const result = await sample.reader({ maxRecordBytes: 256 }).describeConversation(sample.target);
  assert.equal(result.host_online, false);
  assert.equal(result.conversation_exists, true);
  assert.equal(result.model_observation.current_selection.model, "unknown");
  assert.equal(result.model_observation.current_selection.raw_model, "swe-2-max");
  assert.equal(result.model_observation.last_invocation.model, "unknown");
  assert.equal(JSON.stringify(result).includes(sentinel), false);
  assert.deepEqual(digestTree(sample.directory).filter(entry => !entry.path.endsWith("-shm")), before);
});

test("all 64 fixed option indices are supported while malformed JSON and BLOB metadata remain unknown", async context => {
  const configOptions = Array.from({ length: 64 }, (unused, index) => ({ id: index === 63 ? "model" : `option-${index}`,
    currentValue: index === 63 ? "swe-edge-model" : "private-non-model-value" }));
  const sample = sqliteFixture(context, { info: { configOptions } });
  const reader = sample.reader({ maxRecordBytes: 256 });
  const valid = await reader.describeConversation(sample.target);
  assert.equal(valid.model_observation.current_selection.raw_model, "swe-edge-model");
  assert.equal(JSON.stringify(valid).includes("private-non-model-value"), false);
  for (const value of ["{broken-json", "null", '"private-json-root"',
    Buffer.from(JSON.stringify({ configOptions: [{ id: "model", currentValue: "must-not-use-blob" }] }))]) {
    sample.desktop.prepare("UPDATE meta SET value = ? WHERE key = 'info'").run(value);
    const before = digestTree(sample.directory);
    const invalid = await reader.describeConversation(sample.target);
    assert.equal(invalid.conversation_exists, true);
    assert.equal(invalid.model_observation.current_selection.model, "unknown");
    assert.equal(invalid.model_observation.current_selection.raw_model, undefined);
    assert.equal(invalid.model_observation.last_invocation.model, "unknown");
    assert.deepEqual(digestTree(sample.directory), before);
  }
});

test("stale PID text, reused PIDs and live PID candidates never prove a running conversation", async context => {
  const sample = sqliteFixture(context);
  const lockPath = path.join(sample.cliDataDir, "session_locks", `${SLUG}.lock`);
  const reader = sample.reader({ listProcesses: async () => [sample.main(), sample.helper(), sample.acp()] });
  writeFileSync(lockPath, "20288\n");
  assert.equal((await reader.describeConversation(sample.target)).session_lock_evidence, "owner_not_verified");
  writeFileSync(lockPath, "103\n");
  utimesSync(lockPath, new Date("2026-11-16T15:00:00Z"), new Date("2026-11-16T15:00:00Z"));
  const reused = await reader.describeConversation(sample.target);
  assert.equal(reused.session_lock_evidence, "pid_reused");
  assert.equal(reused.conversation_running, "unknown");
  utimesSync(lockPath, new Date("2026-11-16T16:30:00Z"), new Date("2026-11-16T16:30:00Z"));
  const candidate = await reader.describeConversation(sample.target);
  assert.equal(candidate.session_lock_evidence, "pid_candidate_lock_ownership_unknown");
  assert.equal(candidate.conversation_running, "unknown");
  assert.equal((await sample.reader().describeConversation(sample.target)).host_online, false);
  writeFileSync(lockPath, JSON.stringify({ pid: 103, active: true }));
  assert.equal((await reader.describeConversation(sample.target)).session_lock_evidence, "unverified_format");
});

test("ACP lock candidates require the exact executable, acp argument and verified parent birth chain", async context => {
  const sample = sqliteFixture(context);
  const lockPath = path.join(sample.cliDataDir, "session_locks", `${SLUG}.lock`);
  writeFileSync(lockPath, "103\n");
  utimesSync(lockPath, new Date(OBSERVED_AT), new Date(OBSERVED_AT));
  for (const engine of [sample.acp(["not-acp", "acp"]), sample.acp(["acp"], 999), { ...sample.acp(), created_at: "2026-11-16T15:00:00Z" },
    { ...sample.acp(), executable_path: path.join(sample.directory, "fake", "devin.exe") }]) {
    const reader = sample.reader({ listProcesses: async () => [sample.main(), sample.helper(), engine] });
    const status = await reader.describeConversation(sample.target);
    assert.equal(status.session_lock_evidence, "owner_not_verified");
    assert.equal(status.conversation_running, "unknown");
  }
});

test("WAL-only committed metadata is fresh and main/WAL contents remain unchanged", async context => {
  const sample = sqliteFixture(context, { journal: "wal", model: "before-wal-update" });
  sample.desktop.prepare("UPDATE meta SET value = ? WHERE key = 'info'").run(JSON.stringify({ configOptions: [{ id: "model", currentValue: "committed-in-wal" }] }));
  const before = digestTree(sample.directory).filter(entry => !entry.path.endsWith("-shm"));
  const result = await sample.reader().describeConversation(sample.target);
  assert.equal(result.conversation_exists, true);
  assert.equal(result.model_observation.current_selection.raw_model, "committed-in-wal");
  assert.deepEqual(digestTree(sample.directory).filter(entry => !entry.path.endsWith("-shm")), before);
});

test("exclusive busy locks fail within the reader budget and release every child read transaction", async context => {
  const sample = sqliteFixture(context, { includeDesktop: false });
  sample.cli.exec("BEGIN EXCLUSIVE");
  const before = digestTree(sample.directory);
  const started = Date.now();
  const status = await sample.reader({ databaseTimeoutMs: 500 }).describeConversation(sample.target);
  assert.equal(status.conversation_exists, "unknown");
  assert.ok(Date.now() - started < 3000);
  sample.cli.exec("ROLLBACK");
  assert.deepEqual(digestTree(sample.directory), before);
  sample.cli.exec("BEGIN EXCLUSIVE; ROLLBACK");
  assert.equal((await sample.reader().describeConversation(sample.target)).conversation_exists, true);
});

test("a WAL database without existing sidecars is left untouched instead of creating WAL or SHM files", async context => {
  const sample = sqliteFixture(context, { journal: "wal", includeCli: false });
  sample.desktop.close();
  assert.equal(existsSync(`${sample.desktopPath}-wal`), false);
  assert.equal(existsSync(`${sample.desktopPath}-shm`), false);
  const before = digestTree(sample.directory);
  const status = await sample.reader().describeConversation(sample.target);
  assert.equal(status.conversation_exists, "unknown");
  assert.deepEqual(digestTree(sample.directory), before);
});

test("a database directory junction cannot escape its configured User root", async context => {
  const sample = sqliteFixture(context, { includeCli: false, includeDesktop: false });
  const outside = path.join(sample.directory, "outside-user-root");
  mkdirSync(outside);
  const cached = sample.database(path.join(outside, `${sample.desktopId}.db`), "CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  cached.prepare("INSERT INTO meta VALUES ('info', ?)").run(JSON.stringify({ configOptions: [{ id: "model", currentValue: "must-not-read" }] }));
  const messagesDirectory = path.join(sample.userDataDir, "acp-messages");
  renameSync(messagesDirectory, `${messagesDirectory}-unused`);
  symlinkSync(outside, messagesDirectory, "junction");
  const status = await sample.reader().describeConversation(sample.target);
  assert.equal(status.conversation_exists, "unknown");
  assert.equal(JSON.stringify(status).includes("must-not-read"), false);
});

test("database dependency calls contain only constructed paths and exact point-lookup keys", async context => {
  const sample = sqliteFixture(context);
  const requests = [];
  const reader = sample.reader({ queryDatabase: async (request, options) => {
    requests.push(request);
    assert.ok(options.signal instanceof AbortSignal);
    assert.ok(options.timeoutMs <= 2000);
    assert.ok(request.maxRecordBytes <= 65536);
    if (request.kind === "desktop_mapping") return { state: "ready", found: true, value: JSON.stringify({ uuid: sample.desktopId }) };
    if (request.kind === "cli_session") return { state: "ready", found: true };
    return { state: "ready", found: true, value: JSON.stringify({ configOptions: [] }) };
  } });
  await reader.describeConversation({ ...sample.target, databasePath: "C:\\unrelated\\secrets.db", slug: "unrelated" });
  assert.deepEqual(requests.map(request => [request.kind, request.key, request.path]), [
    ["desktop_mapping", `windsurf.acp.messageStore.session.acp/devin-cli/${SLUG}`, sample.mappingPath],
    ["cli_session", SLUG, sample.cliPath],
    ["desktop_info", "info", sample.desktopPath],
  ]);
  requests.length = 0;
  await reader.describeConversation({ host: "windsurf", conversation_id: sample.desktopId });
  assert.deepEqual(requests.map(request => request.kind), ["desktop_info"]);
});

test("cancelling or closing a database read reaches its signal and leaves fixtures writable", async context => {
  const sample = sqliteFixture(context);
  let started;
  const began = new Promise(resolve => { started = resolve; });
  const reader = sample.reader({ queryDatabase: async (request, { signal }) => {
    started();
    return new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  } });
  const controller = new AbortController();
  const pending = reader.describeConversation(sample.target, { signal: controller.signal });
  await began;
  controller.abort();
  await assert.rejects(pending, { code: "ls_cancelled" });
  await reader.close();
  sample.mapping.exec("BEGIN EXCLUSIVE; ROLLBACK");
  sample.cli.exec("BEGIN EXCLUSIVE; ROLLBACK");
  assert.equal((await sample.reader().describeConversation(sample.target)).conversation_exists, true);
});

test("HostStatusProvider preserves independent disk model provenance while delivery stays disabled", async context => {
  const sample = sqliteFixture(context);
  let discoveries = 0;
  const reader = sample.reader({ listProcesses: async () => {
    discoveries += 1;
    return [sample.main(), sample.helper(), sample.acp()];
  } });
  const provider = new HostStatusProvider({ providers: { windsurf: reader } });
  context.after(() => provider.close());
  const status = await provider.getStatus(sample.target);
  assert.equal(status.host_online, true);
  assert.equal(status.conversation_exists, true);
  assert.equal(status.conversation_running, "unknown");
  assert.equal(status.model_observation.current_selection.model, "unknown");
  assert.equal(status.model_observation.current_selection.raw_model, "ui-selected-model");
  assert.equal(status.can_deliver, false);
  assert.equal(status.host_can_receive, false);
  assert.equal(discoveries, 1);
});

test("native database cancellation keeps its admission slot and close waits for the child close event", async context => {
  const sample = sqliteFixture(context);
  const began = deferred();
  const completion = deferred();
  const child = new EventEmitter();
  let executions = 0;
  let childFinished = false;
  let readerFinished = false;
  const reader = sample.reader({ executeDatabase: (executable, argumentsList, { signal }) => {
    executions += 1;
    const onAbort = () => completion.reject(Object.assign(new Error("cancelled"), { name: "AbortError" }));
    signal.addEventListener("abort", onAbort, { once: true });
    child.once("close", () => { childFinished = true; signal.removeEventListener("abort", onAbort); });
    completion.promise.child = child;
    began.resolve();
    return completion.promise;
  } });
  const controller = new AbortController();
  const pending = reader.describeConversation(sample.target, { signal: controller.signal });
  let closing;
  try {
    await began.promise;
    controller.abort();
    await assert.rejects(pending, { code: "ls_cancelled" });
    assert.equal(childFinished, false);
    assert.equal((await reader.describeConversation(sample.target)).code, "ls_target_unavailable");
    assert.equal(executions, 1);
    closing = reader.close().then(() => { readerFinished = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(readerFinished, false);
    child.emit("close", null, "SIGTERM");
    await closing;
    assert.equal(childFinished, true);
    assert.equal(readerFinished, true);
    sample.mapping.exec("BEGIN EXCLUSIVE; ROLLBACK");
  } finally {
    child.emit("close", null, "SIGTERM");
    await closing;
  }
});

for (const outcome of ["success", "timeout", "error"]) {
  test(`native database ${outcome} waits for child close before releasing its admission slot`, async context => {
    const sample = sqliteFixture(context);
    const began = deferred();
    const child = new EventEmitter();
    let executions = 0;
    let finished = false;
    const reader = sample.reader({ executeDatabase: () => {
      executions += 1;
      const completion = outcome === "success" ? Promise.resolve({ stdout: JSON.stringify({ state: "ready", found: false }) })
        : Promise.reject(Object.assign(new Error(outcome), { code: outcome === "timeout" ? "ETIMEDOUT" : "EIO" }));
      completion.child = child;
      began.resolve();
      return completion;
    } });
    const target = { host: "windsurf", conversation_id: sample.desktopId };
    const pending = reader.describeConversation(target).then(value => { finished = true; return value; });
    try {
      await began.promise;
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(finished, false);
      await reader.describeConversation(target);
      assert.equal(executions, 1);
      child.emit("close", outcome === "success" ? 0 : 1, null);
      await pending;
      assert.equal(finished, true);
    } finally {
      child.emit("close", null, "SIGTERM");
      await pending;
    }
  });
}

test("reader exposes a precise source and never advertises a delivery bridge", async context => {
  const sample = fixture(context);
  const reader = sample.reader();
  assert.equal(reader.source, "windsurf_devin_desktop_process_and_readonly_sqlite");
  assert.deepEqual(reader.configured_delivery_modes, { next_model_boundary: false, when_idle: false });
  assert.equal(reader.requires_host_status, true);
  assert.equal((await reader.getHostStatus({ host: "windsurf" })).host_online, false);
  const provider = new HostStatusProvider({ providers: { windsurf: reader } });
  context.after(() => provider.close());
  const status = await provider.getStatus(sample.target);
  assert.equal(status.host_online, false);
  assert.equal(status.can_deliver, false);
  assert.deepEqual(status.delivery_modes, { next_model_boundary: false, when_idle: false });
});

test("a Devin UI main process is online, renderer and helper processes alone are not hosts", async context => {
  const sample = fixture(context);
  assert.equal((await sample.reader({ listProcesses: async () => [sample.main()] }).getHostStatus(sample.target)).host_online, true);
  for (const argumentsList of [["--type=renderer"], ["--type", "utility"], ["--type=gpu-process"], ["--ms-enable-electron-run-as-node"]]) {
    const reader = sample.reader({ listProcesses: async () => [sample.process(101, "Devin.exe", argumentsList)] });
    assert.equal((await reader.getHostStatus(sample.target)).host_online, false);
  }
  assert.equal((await sample.reader({ listProcesses: async () => [sample.helper()] }).getHostStatus(sample.target)).host_online, false);
});

test("legacy Windsurf UI is supported but names and standalone ACP processes cannot prove Desktop presence", async context => {
  const sample = fixture(context);
  const legacy = sample.reader({ listProcesses: async () => [sample.process(101, "Windsurf.exe")] });
  assert.equal((await legacy.getHostStatus(sample.target)).host_online, true);
  const unrelated = sample.reader({ listProcesses: async () => [{ pid: 501, name: "node.exe", executable_path: path.join(sample.directory, "node.exe") }] });
  assert.equal((await unrelated.getHostStatus(sample.target)).host_online, false);
  for (const entries of [[sample.acp()], [{ pid: 201, name: "Devin.exe" }], [{ ...sample.main(), executable_path: path.join(sample.directory, "fake", "Devin.exe") }]]) {
    const status = await sample.reader({ listProcesses: async () => entries }).getHostStatus(sample.target);
    assert.equal(status.host_online, "unknown");
  }
});

test("incomplete, duplicate, over-budget, malformed and failed process probes preserve unknown", async context => {
  const sample = fixture(context);
  for (const value of [{ complete: false, processes: [] }, [sample.helper(), sample.helper()], [sample.main(), sample.main()], Array.from({ length: 257 }, () => sample.main()), [null]]) {
    assert.equal((await sample.reader({ listProcesses: async () => value }).getHostStatus(sample.target)).host_online, "unknown");
  }
  const failed = sample.reader({ listProcesses: async () => { throw new Error("private command data"); } });
  const result = await failed.getHostStatus(sample.target);
  assert.equal(result.host_online, "unknown");
  assert.equal(JSON.stringify(result).includes("private"), false);
});

test("the default process command is bounded, hidden, cancellable and includes Devin and Windsurf", async context => {
  const sample = fixture(context);
  let executions = 0;
  const reader = sample.reader({ listProcesses: undefined, execute: async (program, argumentsList, options) => {
    executions += 1;
    assert.equal(program, "powershell.exe");
    assert.match(argumentsList.at(-1), /Name='Devin.exe'/u);
    assert.match(argumentsList.at(-1), /Name='Windsurf.exe'/u);
    assert.doesNotMatch(argumentsList.at(-1), /Start-Process|language_server|WINDSURF_CSRF_TOKEN/u);
    assert.equal(options.windowsHide, true);
    assert.ok(options.signal instanceof AbortSignal);
    assert.ok(options.maxBuffer <= 262144 && options.timeout <= 8000);
    return { stdout: JSON.stringify({ complete: true, processes: [sample.main(), sample.helper(), sample.acp()] }) };
  } });
  assert.equal((await reader.getHostStatus(sample.target)).host_online, true);
  assert.equal(executions, 1);
});

test("unsafe conversation IDs are rejected before any process or database access", async context => {
  const sample = fixture(context);
  let reads = 0;
  const reader = sample.reader({ listProcesses: async () => { reads += 1; return []; }, queryDatabase: async () => { reads += 1; } });
  for (const conversationId of ["../elsewhere", "..\\elsewhere", "C:\\secret.db", "/secret.db", "file:///secret.db", "%2e%2e", "a'b", "a\u0000b", "a".repeat(129), ""]) {
    const status = await reader.describeConversation({ host: "windsurf", conversation_id: conversationId });
    assert.equal(status.conversation_exists, "unknown");
    assert.equal(status.code, "ls_target_mismatch");
  }
  assert.equal((await reader.describeConversation({ host: "antigravity", conversation_id: SLUG })).code, "ls_target_mismatch");
  assert.equal(reads, 0);
});

test("pre-cancelled reads never probe, and close rejects future reads", async context => {
  const sample = fixture(context);
  let reads = 0;
  const reader = sample.reader({ listProcesses: async () => { reads += 1; return []; } });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(reader.getHostStatus(sample.target, { signal: controller.signal }), { code: "ls_cancelled" });
  assert.equal(reads, 0);
  await reader.close();
  await assert.rejects(reader.describeConversation(sample.target), { code: "ls_closed" });
});

test("cancellation, timeout and close reach an in-flight process probe", async context => {
  const sample = fixture(context);
  const wait = ({ signal }) => new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  const cancelled = sample.reader({ listProcesses: wait });
  const controller = new AbortController();
  const pending = cancelled.getHostStatus(sample.target, { signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, { code: "ls_cancelled" });
  const timed = sample.reader({ listProcesses: wait, timeoutMs: 20 });
  await assert.rejects(timed.getHostStatus(sample.target), { code: "ls_timeout" });
  const closed = sample.reader({ listProcesses: wait });
  const active = closed.getHostStatus(sample.target);
  await new Promise(resolve => setImmediate(resolve));
  const rejection = assert.rejects(active, { code: "ls_closed" });
  await closed.close();
  await rejection;
});

test("a dependency that ignores its signal cannot defeat the reader deadline or close", async context => {
  const sample = fixture(context);
  const reader = sample.reader({ timeoutMs: 20, listProcesses: () => new Promise(() => {}) });
  await assert.rejects(reader.getHostStatus(sample.target), { code: "ls_timeout" });
  const closed = sample.reader({ listProcesses: () => new Promise(() => {}) });
  const pending = closed.getHostStatus(sample.target);
  const rejection = assert.rejects(pending, { code: "ls_closed" });
  await new Promise(resolve => setImmediate(resolve));
  await closed.close();
  await rejection;
});

test("concurrent host and conversation probes share one process discovery and completed results are never cached", async context => {
  const sample = fixture(context);
  const discovered = deferred();
  let starts = 0;
  const reader = sample.reader({ listProcesses: undefined, execute: () => {
    starts += 1;
    return starts === 1 ? discovered.promise : Promise.resolve({ stdout: JSON.stringify({ complete: true, processes: [] }) });
  } });
  const host = reader.getHostStatus(sample.target);
  const conversation = reader.describeConversation(sample.target);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(starts, 1);
  discovered.resolve({ stdout: JSON.stringify({ complete: true, processes: [sample.main()] }) });
  assert.equal((await host).host_online, true);
  assert.equal((await conversation).host_online, true);
  assert.equal((await reader.getHostStatus(sample.target)).host_online, false);
  assert.equal(starts, 2);
});

test("cancelling one process waiter leaves the other host or conversation waiter alive", async context => {
  for (const cancelledMethod of ["getHostStatus", "describeConversation"]) {
    const sample = fixture(context);
    const discovered = deferred();
    let discoverySignal;
    let starts = 0;
    const reader = sample.reader({ listProcesses: ({ signal }) => {
      starts += 1;
      discoverySignal = signal;
      return discovered.promise;
    } });
    const controller = new AbortController();
    const cancelled = reader[cancelledMethod](sample.target, { signal: controller.signal });
    const survivingMethod = cancelledMethod === "getHostStatus" ? "describeConversation" : "getHostStatus";
    const surviving = reader[survivingMethod](sample.target);
    await new Promise(resolve => setImmediate(resolve));
    controller.abort();
    await assert.rejects(cancelled, { code: "ls_cancelled" });
    assert.equal(starts, 1);
    assert.equal(discoverySignal.aborted, false);
    discovered.resolve([sample.main()]);
    assert.equal((await surviving).host_online, true);
    assert.equal(discoverySignal.aborted, false);
  }
});

test("an earlier waiter's timeout does not terminate a later waiter's shared discovery", async context => {
  const sample = fixture(context);
  const discovered = deferred();
  const started = deferred();
  let discoverySignal;
  let starts = 0;
  const reader = sample.reader({ timeoutMs: 200, listProcesses: ({ signal }) => {
    starts += 1;
    discoverySignal = signal;
    started.resolve();
    return discovered.promise;
  } });
  const earlier = reader.getHostStatus(sample.target);
  const expired = assert.rejects(earlier, { code: "ls_timeout" });
  await started.promise;
  await new Promise(resolve => setTimeout(resolve, 100));
  const later = reader.getHostStatus(sample.target);
  await expired;
  assert.equal(discoverySignal.aborted, false);
  assert.equal(starts, 1);
  discovered.resolve([sample.main()]);
  assert.equal((await later).host_online, true);
});

test("the last cancelled waiter aborts discovery and a replacement waits for actual child close", async context => {
  const sample = fixture(context);
  const executions = [];
  const reader = sample.reader({ listProcesses: undefined, execute: (program, argumentsList, { signal, timeout }) => {
    assert.equal(timeout, 0);
    const execution = deferred();
    const child = new EventEmitter();
    const timer = setTimeout(() => child.emit("close"), 1500);
    child.once("close", () => clearTimeout(timer));
    execution.promise.child = child;
    signal.addEventListener("abort", () => execution.reject(signal.reason), { once: true });
    executions.push({ ...execution, child, signal });
    return execution.promise;
  } });
  const firstController = new AbortController();
  const secondController = new AbortController();
  const first = reader.getHostStatus(sample.target, { signal: firstController.signal });
  const second = reader.describeConversation(sample.target, { signal: secondController.signal });
  const firstRejected = assert.rejects(first, { code: "ls_cancelled" });
  const secondRejected = assert.rejects(second, { code: "ls_cancelled" });
  await new Promise(resolve => setImmediate(resolve));
  firstController.abort();
  await firstRejected;
  assert.equal(executions[0].signal.aborted, false);
  secondController.abort();
  await secondRejected;
  assert.equal(executions[0].signal.aborted, true);
  const replacement = reader.getHostStatus(sample.target);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(executions.length, 1);
  executions[0].child.emit("close");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(executions.length, 2);
  executions[1].resolve({ stdout: JSON.stringify({ complete: true, processes: [sample.main()] }) });
  executions[1].child.emit("close");
  assert.equal((await replacement).host_online, true);
});

test("a failed discovery is shared only while in progress and the next request retries", async context => {
  const sample = fixture(context);
  const failed = deferred();
  let starts = 0;
  const reader = sample.reader({ listProcesses: undefined, execute: () => {
    starts += 1;
    return starts === 1 ? failed.promise : Promise.resolve({ stdout: JSON.stringify({ complete: true, processes: [sample.main()] }) });
  } });
  const host = reader.getHostStatus(sample.target);
  const conversation = reader.describeConversation(sample.target);
  await new Promise(resolve => setImmediate(resolve));
  failed.reject(new Error("private process metadata"));
  assert.equal((await host).host_online, "unknown");
  assert.equal((await conversation).host_online, "unknown");
  assert.equal(starts, 1);
  assert.equal((await reader.getHostStatus(sample.target)).host_online, true);
  assert.equal(starts, 2);
});

test("close waits for real owned discovery child termination and no process is left behind", async context => {
  const sample = fixture(context);
  const executeFile = promisify(execFile);
  const children = new Set();
  const started = deferred();
  let starts = 0;
  const reader = sample.reader({ listProcesses: undefined, execute: (program, argumentsList, options) => {
    starts += 1;
    const execution = executeFile(process.execPath, ["-e", "setInterval(() => {}, 1000)"], options);
    children.add(execution.child);
    execution.child.once("close", () => children.delete(execution.child));
    execution.child.once("spawn", () => started.resolve());
    return execution;
  } });
  const host = reader.getHostStatus(sample.target);
  const conversation = reader.describeConversation(sample.target);
  const rejected = Promise.all([assert.rejects(host, { code: "ls_closed" }), assert.rejects(conversation, { code: "ls_closed" })]);
  await started.promise;
  assert.equal(starts, 1);
  assert.equal(children.size, 1);
  await reader.close();
  assert.equal(children.size, 0);
  await rejected;
});
