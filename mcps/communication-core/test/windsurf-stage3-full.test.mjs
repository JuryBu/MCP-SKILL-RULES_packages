import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createDevinSessionClient } from "../src/transports/devin-session-client.mjs";
import { WindsurfAcpDeliveryAdapter } from "../src/adapters/windsurf-acp.mjs";
import { WindsurfAcpTransport } from "../src/transports/windsurf-acp-transport.mjs";
import { createWindsurfConversationContent } from "../src/windsurf-conversation-content.mjs";
import { HostConversationContent, normalizeHostContentGrants } from "../src/host-conversation-content.mjs";
import { identityKey } from "../src/contracts.mjs";

test("real Devin 3000.14.30833 protocolVersion=1 + daemon v2 handshake, session/load, persisted node confirmation, and FIFO settled eviction", async () => {
  const wire = [];
  let persisted = false;
  let client;
  client = createDevinSessionClient({
    connectorId: "devin-cli",
    sessionId: "cobalt-meadow",
    cwd: "C:/fixture/wsf",
    requestTimeoutMs: 500,
    verifyPersisted: async () => (persisted ? { verified: true, node_id: 501, created_at: "2026-11-22T04:00:00.000Z" } : { verified: false }),
    checkSessionIdle: async () => ({ idle: true }),
    sendLine: line => {
      const frame = JSON.parse(line);
      wire.push(frame);
      if (frame.method === "initialize") {
        queueMicrotask(() => client.feedLine(JSON.stringify({
          jsonrpc: "2.0",
          id: frame.id,
          result: {
            protocolVersion: 1,
            agentCapabilities: {
              loadSession: true,
              _meta: { "cognition.ai/midTurnPrompts": true, "cognition.ai/daemon": true },
            },
            _meta: {
              "cognition.ai/daemon": { protocolVersion: 2, version: "3000.14.30833", pid: 4242 },
            },
          },
        })));
      } else if (frame.method === "session/load") {
        queueMicrotask(() => client.feedLine(JSON.stringify({
          jsonrpc: "2.0",
          id: frame.id,
          result: {
            modes: { currentModeId: "bypass" },
            configOptions: [{ id: "model", currentValue: "swe-2-max-lightning" }],
          },
        })));
      } else if (frame.method === "session/set_config_option") {
        queueMicrotask(() => client.feedLine(JSON.stringify({
          jsonrpc: "2.0",
          id: frame.id,
          result: {
            configOptions: [{ id: "model", currentValue: frame.params.value }],
          },
        })));
      } else if (frame.method === "session/prompt") {
        // Simulate real devin.exe: no immediate RPC response while 45s turn runs, but node persists to SQLite WAL in 150ms!
        setTimeout(() => { persisted = true; }, 120);
      }
    },
  });

  try {
    const init = await client.initialize();
    assert.equal(init.outcome, "accepted");
    assert.equal(client.describe().protocol_version, 2);
    assert.equal(client.describe().daemon_pid, 4242);

    const attached = await client.attach();
    assert.equal(attached.outcome, "accepted");
    assert.equal(wire[1].method, "session/load");
    assert.deepEqual(wire[1].params._meta["cognition.ai/replayFrom"], { type: "tail", count: 0 });
    assert.equal(client.describe().model_id, "swe-2-max-lightning");
    assert.equal(client.describe().daemon_capabilities.local_idle_gate, true);

    const switched = await client.setConfigOption({ configId: "model", value: "swe-2-flash-medium" });
    assert.equal(switched.outcome, "accepted");
    assert.equal(client.describe().model_id, "swe-2-flash-medium");

    const delivered = await client.deliver({
      message_id: "msg-persisted-1",
      delivery_id: "deliv-persisted-1",
      text: "hello mid-turn",
    });
    assert.equal(delivered.outcome, "accepted");
    assert.equal(delivered.evidence.kind, "persisted_session_node");
    assert.equal(delivered.evidence.node_id, 501);
  } finally {
    client.close();
  }
});

test("in-process protocolVersion=1 without daemon v2 is rejected to prevent isolated second engine", async () => {
  let client;
  client = createDevinSessionClient({
    connectorId: "devin-cli",
    sessionId: "cobalt-meadow",
    cwd: "C:/fixture/wsf",
    sendLine: line => {
      const frame = JSON.parse(line);
      if (frame.method === "initialize") {
        queueMicrotask(() => client.feedLine(JSON.stringify({
          jsonrpc: "2.0",
          id: frame.id,
          result: { protocolVersion: 1, agentCapabilities: { loadSession: true, _meta: { "cognition.ai/midTurnPrompts": true } } },
        })));
      }
    },
  });
  try {
    const init = await client.initialize();
    assert.equal(init.outcome, "unknown");
    assert.equal(init.reason, "unsupported_initialize_protocol");
    assert.equal(client.describe().ready, false);
  } finally {
    client.close();
  }
});

test("local daemon when_idle fail-closed gate returns busy while turn is active, then delivers via session/prompt once idle", async () => {
  let sessionIdle = false;
  let promptsSent = 0;
  let client;
  client = createDevinSessionClient({
    connectorId: "devin-cli",
    sessionId: "cobalt-meadow",
    cwd: "C:/fixture/wsf",
    checkSessionIdle: async () => (sessionIdle ? { idle: true } : { idle: false, reason: "latest_node_assistant_active" }),
    sendLine: line => {
      const frame = JSON.parse(line);
      if (frame.method === "initialize") {
        queueMicrotask(() => client.feedLine(JSON.stringify({
          jsonrpc: "2.0",
          id: frame.id,
          result: {
            protocolVersion: 1,
            agentCapabilities: { loadSession: true, _meta: { "cognition.ai/midTurnPrompts": true, "cognition.ai/daemon": true } },
            _meta: { "cognition.ai/daemon": { protocolVersion: 2, pid: 777 } },
          },
        })));
      } else if (frame.method === "session/load") {
        queueMicrotask(() => client.feedLine(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: {} })));
      } else if (frame.method === "session/prompt") {
        promptsSent += 1;
        queueMicrotask(() => client.feedLine(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { stopReason: "end_turn" } })));
      }
    },
  });
  await client.initialize();
  await client.attach();

  const target = {
    machine_id: "development", host: "windsurf", surface: "desktop", conversation_id: "cobalt-meadow",
    binding_id: "wsf-test", binding_generation: 1, adapter_id: "wsf-acp", capabilities: { next_model_boundary: true, when_idle: true },
  };
  const adapter = new WindsurfAcpDeliveryAdapter({ clientForTarget: async () => client });
  const input = {
    target,
    message: {
      message_id: "msg-idle-1",
      envelope: {
        caller: { machine_id: "development", host: "antigravity", surface: "desktop", conversation_id: "caller-1" },
        origin: { kind: "agent_message", channel: "antigravity", source_ref: "caller-1" },
        target,
        text: "deliver after big turn",
        delivery_policy: "when_idle",
        attachment_refs: [],
      },
    },
    delivery: { delivery_id: "deliv-idle-1", message_id: "msg-idle-1", target_key: identityKey(target), status: "prepared", attempt_count: 1 },
  };

  try {
    const first = await adapter.deliver(input);
    assert.equal(first.outcome, "busy");
    assert.equal(first.evidence.request_sent, false);
    assert.equal(first.evidence.retry_after_ms, 1500);
    assert.equal(promptsSent, 0);

    sessionIdle = true;
    const second = await adapter.deliver(input);
    assert.equal(second.outcome, "accepted");
    assert.equal(promptsSent, 1);
  } finally {
    client.close();
  }
});

test("WSF conversation catalog pagination, 500KB giant node truncation, external provenance, and Core restart unknown recovery", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "wsf-content-test-"));
  const cliDir = path.join(tmpDir, "Devin", "cli");
  const userDir = path.join(tmpDir, "Devin", "User", "globalStorage");
  await fs.mkdir(cliDir, { recursive: true });
  await fs.mkdir(userDir, { recursive: true });

  const dbPath = path.join(cliDir, "sessions.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      working_directory TEXT NOT NULL,
      backend_type TEXT NOT NULL,
      model TEXT NOT NULL,
      agent_mode TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_activity_at INTEGER NOT NULL,
      title TEXT,
      main_chain_id INTEGER,
      hidden INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX idx_sessions_hidden ON sessions(hidden);
    CREATE INDEX idx_sessions_activity ON sessions(last_activity_at DESC);
    CREATE TABLE message_nodes (
      row_id INTEGER PRIMARY KEY,
      session_id TEXT NOT NULL,
      node_id INTEGER NOT NULL,
      parent_node_id INTEGER,
      chat_message TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX idx_nodes_pk ON message_nodes(session_id, node_id);
  `);

  db.prepare("INSERT INTO sessions VALUES (?, ?, 'windsurf', 'swe-2-max-lightning', 'bypass', 1795000000, 1795285343, 'WSF跨端集成测试会话', 4, 0)").run("cobalt-meadow", "C:/ws/test");
  db.prepare("INSERT INTO sessions VALUES (?, ?, 'windsurf', 'swe-2-max', 'bypass', 1794000000, 1794100000, '第二条可见会话', null, 0)").run("alpha-bravo", "C:/ws/two");
  db.prepare("INSERT INTO sessions VALUES (?, ?, 'windsurf', 'swe-2-high', 'bypass', 1794000000, 1795999999, '隐藏子代理会话', null, 1)").run("hidden-sub", "C:/ws/sub");

  const msgId = "11111111-2222-3333-4444-555555555555";
  const delivId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const relayBody = `这条消息来自「antigravity」代理对话「a0000001」，由交流核心转送。\n[COMMUNICATION_CORE message_id=${msgId} delivery_id=${delivId}]\n\n你好WSF测试对话`;

  const insertNode = db.prepare("INSERT INTO message_nodes (session_id, node_id, parent_node_id, chat_message, created_at) VALUES (?, ?, ?, ?, ?)");
  insertNode.run("cobalt-meadow", 1, null, JSON.stringify({ message_id: "m1", role: "user", content: relayBody, metadata: { is_user_input: 1 } }), 1795285300);
  insertNode.run("cobalt-meadow", 2, 1, JSON.stringify({ message_id: "m2", role: "assistant", content: "", tool_calls: [{ id: "t1" }], metadata: { generation_model: "swe-2-max-lightning", finish_reason: "tool_calls" } }), 1795285310);
  // 500 KB giant tool output node!
  insertNode.run("cobalt-meadow", 3, 2, JSON.stringify({ message_id: "m3", role: "tool", content: "X".repeat(520000) }), 1795285320);
  insertNode.run("cobalt-meadow", 4, 3, JSON.stringify({ message_id: "m4", role: "assistant", content: "已收到并完成核对。", metadata: { generation_model: "swe-2-max-lightning", finish_reason: "stop", created_at: "2026-11-22T04:02:00.000Z" } }), 1795285330);
  db.close();

  const stateDb = new DatabaseSync(path.join(userDir, "state.vscdb"));
  stateDb.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)");
  stateDb.close();

  const target = { machine_id: "development", host: "windsurf", surface: "desktop", conversation_id: "cobalt-meadow" };
  const transport = new WindsurfAcpTransport({ appDataDir: path.join(tmpDir, "Devin", "..") });
  try {
    // 1. Test Core-restart persisted recovery via WindsurfAcpTransport + WindsurfAcpDeliveryAdapter!
    const adapter = new WindsurfAcpDeliveryAdapter({
      clientForTarget: async (_t, ctx) => {
        assert.equal(ctx.queryOnly, true);
        return null; // Simulates empty memory cache after Core restart!
      },
      verifyPersistedDelivery: (t, ctx) => transport.verifyPersistedDelivery(t, ctx),
    });
    const recovered = await adapter.query({
      target: { ...target, binding_id: "b1", binding_generation: 1, adapter_id: "wsf" },
      message: { message_id: msgId, envelope: {} },
      delivery: { delivery_id: delivId, message_id: msgId, target_key: identityKey(target), status: "unknown" },
    });
    assert.equal(recovered.outcome, "accepted");
    assert.equal(recovered.evidence.native.kind, "persisted_session_node_recovered");
    assert.equal(recovered.evidence.native.node_id, 1);

    // 2. Test HostConversationContent list & snapshot (with unauthorized forbidden check!)
    const provider = createWindsurfConversationContent({
      cliDataDir: cliDir,
      transport,
      getMessageForDelivery: id => (id === delivId ? {
        message_id: msgId,
        target_key: identityKey(target),
        envelope: { caller: { host: "antigravity" }, text: "你好WSF测试对话" },
      } : null),
    });
    const hostContent = new HostConversationContent({ providers: { windsurf: provider } });
    const principal = {
      id: "authorized-antigravity-host",
      identity: { machine_id: "development", host: "antigravity", surface: "desktop", conversation_id: "a0000001" },
      allowed_host_lists: normalizeHostContentGrants([{ machine_id: "development", host: "windsurf", surface: "desktop" }], false),
      allowed_host_snapshots: normalizeHostContentGrants([{ machine_id: "development", host: "windsurf", surface: "desktop", conversation_id: "cobalt-meadow" }], true),
    };

    const page1 = await hostContent.list(principal, { caller: principal.identity, scope: "host", host: "windsurf", limit: 1 });
    assert.equal(page1.conversations.length, 1);
    assert.equal(page1.conversations[0].conversation_id, "cobalt-meadow");
    assert.equal(page1.has_more, true);

    const page2 = await hostContent.list(principal, { caller: principal.identity, scope: "host", host: "windsurf", limit: 5, cursor: page1.next_cursor });
    assert.equal(page2.conversations.length, 1);
    assert.equal(page2.conversations[0].conversation_id, "alpha-bravo"); // hidden-sub excluded!
    assert.equal(page2.has_more, false);

    // Unauthorized conversation must throw forbidden!
    await assert.rejects(
      () => hostContent.snapshot(principal, { caller: principal.identity, target: { ...target, conversation_id: "alpha-bravo" }, last_rounds: 3 }),
      err => err.code === "forbidden",
    );

    const snap = await hostContent.snapshot(principal, { caller: principal.identity, target, last_rounds: 3 });
    assert.match(snap.markdown, /外部消息/);
    assert.match(snap.markdown, /你好WSF测试对话/);
    assert.match(snap.markdown, /该轮还有 2 条工具或活动记录/);
    assert.match(snap.markdown, /已收到并完成核对/);
    assert.ok(Buffer.byteLength(snap.markdown, "utf8") <= 6000);
  } finally {
    await transport.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});


test("checkpointed WAL sessions.db without sidecars is read offline without recreating -wal or -shm", async () => {
  const fsSync = await import("node:fs");
  const { DatabaseSync: SqliteDb } = await import("node:sqlite");
  const root = fsSync.mkdtempSync(path.join(os.tmpdir(), "wsf-closed-wal-"));
  try {
    const cliDir = path.join(root, "Devin", "cli");
    fsSync.mkdirSync(cliDir, { recursive: true });
    const dbPath = path.join(cliDir, "sessions.db");
    const db = new SqliteDb(dbPath);
    db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE sessions (id TEXT PRIMARY KEY, working_directory TEXT, model TEXT, agent_mode TEXT, created_at INTEGER, last_activity_at INTEGER, title TEXT, main_chain_id INTEGER, hidden INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX idx_sessions_activity ON sessions(last_activity_at DESC);
      CREATE INDEX idx_sessions_hidden ON sessions(hidden) WHERE hidden = 0;
      CREATE TABLE message_nodes (session_id TEXT NOT NULL, node_id INTEGER NOT NULL, parent_node_id INTEGER, created_at INTEGER NOT NULL, chat_message TEXT NOT NULL, PRIMARY KEY (session_id, node_id));
      INSERT INTO sessions VALUES ('cobalt-meadow', 'C:/work', 'swe-2-max-lightning', 'bypass', 1700000000, 1700000100, 'WSF跨端集成测试会话', 0, 0);
      INSERT INTO message_nodes VALUES ('cobalt-meadow', 0, NULL, 1700000050, '{"role":"user","content":"离线只读检查","metadata":{"is_user_input":1}}');
    `);
    db.close();
    assert.equal(fsSync.existsSync(`${dbPath}-wal`), false);
    assert.equal(fsSync.existsSync(`${dbPath}-shm`), false);
    const provider = createWindsurfConversationContent({ appDataDir: root });
    const listed = await provider.list({ machine_id: "development", host: "windsurf", surface: "desktop" }, { limit: 5, cursor: null });
    assert.equal(listed.conversations.length, 1);
    assert.equal(listed.conversations[0].conversation_id, "cobalt-meadow");
    const snap = await provider.readRecent({ machine_id: "development", host: "windsurf", surface: "desktop", conversation_id: "cobalt-meadow" }, { lastRounds: 3 });
    assert.equal(snap.rounds.length, 1);
    assert.equal(fsSync.existsSync(`${dbPath}-wal`), false);
    assert.equal(fsSync.existsSync(`${dbPath}-shm`), false);
  } finally {
    fsSync.rmSync(root, { recursive: true, force: true });
  }
});


test("daemon v2 enforces per-connection authenticate(windsurf-api-key) fail-closed, maxActiveClients pool cap across concurrent connects, >8KB external prefix match, and unknown retry_after_ms backoff", async () => {
  const fsSync = await import("node:fs");
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");
  const { CommunicationCore } = await import("../src/core.mjs");
  const { MessageStore } = await import("../src/store.mjs");

  const root = fsSync.mkdtempSync(path.join(os.tmpdir(), "wsf-auth-pool-"));
  try {
    const cliDir = path.join(root, "Devin", "cli");
    const gsDir = path.join(root, "Devin", "User", "globalStorage");
    const binPath = path.join(root, "fake-devin.exe");
    fsSync.mkdirSync(cliDir, { recursive: true });
    fsSync.mkdirSync(gsDir, { recursive: true });
    fsSync.writeFileSync(binPath, "stub");

    const sdb = new DatabaseSync(path.join(cliDir, "sessions.db"));
    sdb.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, working_directory TEXT, model TEXT, agent_mode TEXT, created_at INTEGER, last_activity_at INTEGER, title TEXT, main_chain_id INTEGER, hidden INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX idx_sessions_activity ON sessions(last_activity_at DESC);
      CREATE INDEX idx_sessions_hidden ON sessions(hidden);
      CREATE TABLE message_nodes (session_id TEXT NOT NULL, node_id INTEGER NOT NULL, parent_node_id INTEGER, created_at INTEGER NOT NULL, chat_message TEXT NOT NULL, PRIMARY KEY (session_id, node_id));
      INSERT INTO sessions VALUES ('slug-one', 'C:/ws/1', 'swe-2-max-lightning', 'bypass', 1700000000, 1700000100, 's1', 1, 0);
      INSERT INTO sessions VALUES ('slug-two', 'C:/ws/2', 'swe-2-max-lightning', 'bypass', 1700000000, 1700000200, 's2', 1, 0);
      INSERT INTO sessions VALUES ('slug-three', 'C:/ws/3', 'swe-2-max-lightning', 'bypass', 1700000000, 1700000300, 's3', 1, 0);
      INSERT INTO message_nodes VALUES ('slug-one', 1, NULL, 1700000050, '{"role":"assistant","content":"ok","metadata":{"finish_reason":"stop"}}');
      INSERT INTO message_nodes VALUES ('slug-two', 1, NULL, 1700000050, '{"role":"assistant","content":"ok","metadata":{"finish_reason":"stop"}}');
      INSERT INTO message_nodes VALUES ('slug-three', 1, NULL, 1700000050, '{"role":"assistant","content":"ok","metadata":{"finish_reason":"stop"}}');
    `);
    sdb.close();

    // 1. Missing apiKey in state.vscdb must fail-closed (null client, not added to active pool!)
    const vdbPath = path.join(gsDir, "state.vscdb");
    let vdb = new DatabaseSync(vdbPath);
    vdb.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)");
    vdb.close();

    const makeFakeSpawn = seenMethods => (_cmd, _args) => {
      const child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => { child.emit("exit", 0); };
      let authed = false;
      child.stdin.on("data", chunk => {
        for (const ln of chunk.toString("utf8").split("\n").filter(Boolean)) {
          const req = JSON.parse(ln);
          seenMethods.push(req.method);
          if (req.method === "initialize") {
            child.stdout.write(JSON.stringify({
              jsonrpc: "2.0", id: req.id,
              result: { protocolVersion: 1, agentCapabilities: { loadSession: true, _meta: { "cognition.ai/midTurnPrompts": true, "cognition.ai/daemon": true } }, _meta: { "cognition.ai/daemon": { protocolVersion: 2, pid: 999 } } },
            }) + "\n");
          } else if (req.method === "authenticate") {
            assert.equal(req.params.methodId, "windsurf-api-key");
            assert.equal(req.params._meta.api_key, "sk-wsf-secret-test-token-do-not-leak");
            authed = true;
            child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: {} }) + "\n");
          } else if (req.method === "session/load") {
            assert.equal(authed, true);
            child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { configOptions: [{ id: "model", currentValue: "swe-2-max-lightning" }] } }) + "\n");
          }
        }
      });
      return child;
    };

    const { execFile: rawExecFile } = await import("node:child_process");
    const { promisify: rawPromisify } = await import("node:util");
    const realExec = rawPromisify(rawExecFile);
    const seenNoAuth = [];
    const transportNoAuth = new WindsurfAcpTransport({
      appDataDir: root,
      devinBinaryPath: binPath,
      settleDelayMs: 10,
      spawnProcess: makeFakeSpawn(seenNoAuth),
      execute: (cmd, args, opts) => {
        if (cmd === binPath) return Promise.resolve({ stdout: "devin daemon running (pid 999), 1 session(s) loaded\n" });
        return realExec(cmd, args, opts);
      },
    });
    const unauthClient = await transportNoAuth.clientForTarget({ host: "windsurf", surface: "desktop", conversation_id: "slug-one" });
    assert.equal(unauthClient, null);
    assert.equal(transportNoAuth.active.size, 0);
    await transportNoAuth.close();

    // 2. Populate windsurfAuthStatus and verify authenticate + zero secret leak + maxActiveClients=2 cap under 3 concurrent connects!
    vdb = new DatabaseSync(vdbPath);
    vdb.prepare("INSERT INTO ItemTable VALUES ('windsurfAuthStatus', ?)").run(JSON.stringify({ apiKey: "sk-wsf-secret-test-token-do-not-leak", apiServerUrl: "https://server.codeium.com" }));
    vdb.close();

    const seenAuthed = [];
    const transportAuthed = new WindsurfAcpTransport({
      appDataDir: root,
      devinBinaryPath: binPath,
      maxActiveClients: 2,
      settleDelayMs: 40,
      spawnProcess: makeFakeSpawn(seenAuthed),
      execute: (cmd, args, opts) => {
        if (cmd === binPath) return Promise.resolve({ stdout: "devin daemon running (pid 999), 1 session(s) loaded\n" });
        return realExec(cmd, args, opts);
      },
    });
    const [c1, c2, c3] = await Promise.all([
      transportAuthed.clientForTarget({ host: "windsurf", surface: "desktop", conversation_id: "slug-one" }),
      transportAuthed.clientForTarget({ host: "windsurf", surface: "desktop", conversation_id: "slug-two" }),
      transportAuthed.clientForTarget({ host: "windsurf", surface: "desktop", conversation_id: "slug-three" }),
    ]);
    const connected = [c1, c2, c3].filter(Boolean);
    assert.equal(connected.length, 2);
    assert.equal(transportAuthed.active.size, 2);
    for (const client of connected) {
      assert.equal(JSON.stringify(client.describe()).includes("sk-wsf-secret-test-token-do-not-leak"), false);
    }
    assert.ok(seenAuthed.includes("authenticate"));
    await transportAuthed.close();
    assert.equal(transportAuthed.active.size, 0);

    // 3. >8KB external message prefix verification after SQL 8400-char excerpt truncation
    const longText = "长消息前缀核验_" + "A".repeat(9500);
    const msgId = "22222222-3333-4444-5555-666666666666";
    const delivId = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff";
    const fullRelay = `这条消息来自「antigravity」代理对话「a0000001」，由交流核心转送。\n[COMMUNICATION_CORE message_id=${msgId} delivery_id=${delivId}]\n\n${longText}`;
    const targetOne = { machine_id: "development", host: "windsurf", surface: "desktop", conversation_id: "slug-one" };
    const { projectWindsurfTail } = await import("../src/windsurf-conversation-content.mjs");
    const projected = projectWindsurfTail({
      session: { id: "slug-one" },
      nodes: [{
        node_id: 10,
        parent_node_id: 1,
        created_at: 1700000900,
        role: "user",
        message_id: "m-long",
        is_user_input: 1,
        content_bytes: Buffer.byteLength(fullRelay, "utf8"),
        content_excerpt: fullRelay.slice(0, 8400),
      }],
      omitted_earlier: false,
    }, targetOne, 3, id => (id === delivId ? {
      message_id: msgId,
      target_key: identityKey(targetOne),
      envelope: { caller: { host: "antigravity" }, text: longText },
    } : null));
    assert.equal(projected.rounds.length, 1);
    assert.equal(projected.rounds[0].messages[0].role, "external");
    assert.equal(projected.partial, true);

    // 4. WindsurfAcpTransport.verifyPersistedDelivery throttles unverified 250ms unknown queries via 5000ms negative cache (zero subprocess storm)
    let fakeNow = 1700000000000;
    let sqliteSpawns = 0;
    const transportBackoff = new WindsurfAcpTransport({
      appDataDir: root,
      devinBinaryPath: binPath,
      verifyNegativeCacheMs: 5000,
      now: () => fakeNow,
      execute: (cmd, args, opts) => {
        sqliteSpawns += 1;
        return realExec(cmd, args, opts);
      },
    });
    try {
      const r1 = await transportBackoff.verifyPersistedDelivery({ conversation_id: "slug-one" }, { messageId: "missing-msg-1", deliveryId: "missing-deliv-1" });
      assert.equal(r1.verified, false);
      const spawnsAfterFirst = sqliteSpawns;
      assert.ok(spawnsAfterFirst >= 1);
      const r2 = await transportBackoff.verifyPersistedDelivery({ conversation_id: "slug-one" }, { messageId: "missing-msg-1", deliveryId: "missing-deliv-1" });
      assert.equal(r2.verified, false);
      assert.equal(r2.throttled, true);
      assert.equal(sqliteSpawns, spawnsAfterFirst); // Zero extra SQLite subprocesses during 5000ms window!
      fakeNow += 6000;
      const r3 = await transportBackoff.verifyPersistedDelivery({ conversation_id: "slug-one" }, { messageId: "missing-msg-1", deliveryId: "missing-deliv-1" });
      assert.equal(r3.verified, false);
      assert.ok(sqliteSpawns > spawnsAfterFirst);
    } finally {
      await transportBackoff.close();
    }
  } finally {
    fsSync.rmSync(root, { recursive: true, force: true });
  }
});
