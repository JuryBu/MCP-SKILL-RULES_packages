import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startLiveFromConfig } from "../src/live-runtime.mjs";
import { createMcpStdioFacade } from "../src/mcp-stdio-facade.mjs";
import { runLiveCli } from "../scripts/live.mjs";
import { startLiveService } from "../scripts/live-service.mjs";
import { MockAdapter } from "../src/adapters/mock.mjs";
import { restrictBoardRelayDispatcher } from "../src/board-entry-contract.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const mockFactories = { antigravity: () => new MockAdapter() };

test("isolated live launch shares each caller's personal book across direct and local shared host facade, while keeping disabled entries read-only", async context => {
  const value = configuration();
  const files = await fixture(context, value);
  const endpointFile = join(files.directory, "fixture-endpoint.json");
  value.address_book_file = join(files.directory, "shared-contacts.json");
  value.multi_recipient_enabled = true;
  value.principals[0].address_book_identity_bound = true;
  const identity = { ...value.principals[0].identity, surface: "desktop" };
  const hostScope = { machine_id: identity.machine_id, host: identity.host, surface: identity.surface };
  const sharedHostPrincipal = {
    ...value.principals[0], id: "fixture-live-shared-host", token: "fixture-live-shared-host-token",
    identity: { ...hostScope, conversation_id: "*" }, caller_scope: hostScope,
  };
  delete sharedHostPrincipal.address_book_identity_bound;
  const disabledHostPrincipal = {
    ...sharedHostPrincipal, id: "fixture-live-disabled-host", token: "fixture-live-disabled-host-token",
    address_book_identity_bound: false,
  };
  value.principals.push(sharedHostPrincipal, disabledHostPrincipal);
  const caller = { host: identity.host, conversation_id: identity.conversation_id };
  const configured = value.targets[0];
  const target = { machine_id: configured.machine_id, host: configured.host, surface: configured.surface, conversation_id: configured.conversation_id };
  await writeFile(value.address_book_file, JSON.stringify({
    schema_version: 1, machine_id: identity.machine_id, entries: [{ id: "fixture-shared-note", alias: "共有", target, note: "默认" }],
  }), "utf8");
  await writeFile(files.configPath, JSON.stringify(value), "utf8");

  const service = await startLiveService({ ...files, endpointFile }, {
    startRuntime: options => startLiveFromConfig({ ...options, factories: mockFactories }),
  });
  files.cleanup(() => service.close());
  const direct = new Client({ name: "fixture-address-book-launch", version: "1.0.0" });
  files.cleanup(() => direct.close());
  await direct.connect(new StreamableHTTPClientTransport(new URL(service.url), {
    requestInit: { headers: { Authorization: `Bearer ${value.principals[0].token}` } },
  }));
  const saved = await direct.callTool({ name: "communication_contacts", arguments: { caller, action: "save", alias: "个人", target } });
  assert.equal(saved.structuredContent?.scope, "personal");

  const profile = join(files.directory, "fixture-connection.json");
  const registry = join(files.directory, "fixture-registry.json");
  await writeFile(profile, JSON.stringify({ endpoint_file: endpointFile, identity: sharedHostPrincipal.identity, caller_scope: hostScope, token: sharedHostPrincipal.token }), "utf8");
  await writeFile(registry, JSON.stringify({ version: 1, connections: [{ connection_file: profile }] }), "utf8");
  const facade = await createMcpStdioFacade({ registryFile: registry, includeContacts: true, includeMultiRecipient: true });
  files.cleanup(() => facade.close());
  const visible = await facade.callTool("communication_contacts", { caller, action: "list" });
  assert.deepEqual(visible.structuredContent?.contacts.map(entry => entry.alias), ["共有", "个人"]);
  assert.deepEqual(visible.structuredContent?.caller, caller);
  const updated = await facade.callTool("communication_contacts", { caller, action: "set_note", contact: "共有", note: "共享入口可写个人备注" });
  assert.notEqual(updated.isError, true);
  assert.deepEqual(updated.structuredContent?.caller, caller);
  assert.equal((await direct.callTool({ name: "communication_contacts", arguments: { caller, action: "get", contact: "共有" } })).structuredContent?.note, "共享入口可写个人备注");

  // Explicitly disabled principal still remains read-only
  const disabledClient = new Client({ name: "fixture-disabled-host", version: "1.0.0" });
  files.cleanup(() => disabledClient.close());
  await disabledClient.connect(new StreamableHTTPClientTransport(new URL(service.url), {
    requestInit: { headers: { Authorization: `Bearer ${disabledHostPrincipal.token}` } },
  }));
  const denied = await disabledClient.callTool({ name: "communication_contacts", arguments: { caller, action: "set_note", contact: "共有", note: "不得覆盖" } });
  assert.equal(denied.structuredContent?.error?.code, "caller_unverified");

  const grouped = await facade.callTool("communication_send_message", { caller, targets: [{ contact: "共有" }], text: "真实隔离门面群发",
    dedupe_key: "fixture-live-one-recipient-batch" });
  assert.notEqual(grouped.isError, true, JSON.stringify(grouped.structuredContent));
  assert.deepEqual(grouped.structuredContent.results.map(entry => entry.target), [target]);
});

async function prepareBoardFixture(context) {
  const value = configuration();
  const files = await fixture(context, value);
  const principal = value.principals[0];
  const identity = { ...principal.identity, surface: principal.identity.surface ?? "desktop" };
  value.address_book_file = join(files.directory, "fixture-board-book.json");
  principal.address_book_identity_bound = true;
  const facadePrincipal = { ...principal, id: "fixture-facade-board", token: "fixture-board-facade-token", address_book_identity_bound: false };
  value.principals.push(facadePrincipal);
  await writeFile(value.address_book_file, JSON.stringify({ schema_version: 1, machine_id: identity.machine_id, entries: [] }), "utf8");
  await writeFile(files.configPath, JSON.stringify(value), "utf8");
  return { files, principal, facadePrincipal, identity, caller: { host: identity.host, conversation_id: identity.conversation_id } };
}

test("private board startup uses its own root, retains local identity, and closes before the state store", async context => {
  const { files, principal, facadePrincipal, identity, caller } = await prepareBoardFixture(context);
  const endpointFile = join(files.directory, "fixture-board-endpoint.json");
  const events = [];
  let entered;
  let confirmAbort;
  let finishAction;
  let signal;
  const inFlight = new Promise(resolveEntry => { entered = resolveEntry; });
  const aborted = new Promise(resolveAbort => { confirmAbort = resolveAbort; });
  const boards = {
    enabled: true,
    principalIds: [principal.id],
    superAdminIdentities: [identity],
    open(options) {
      assert.equal(options.privateRoot, resolve(files.stateDir));
      assert.equal(options.boardRoot, join(resolve(files.stateDir), "boards"));
      assert.equal(options.localMachineId, identity.machine_id);
      assert.deepEqual(options.allowedUploadRoots, []);
      assert.deepEqual(options.superAdminIdentities, [identity]);
      assert.ok(Object.isFrozen(options.superAdminIdentities[0]));
      const probe = options.openStore(({ database, transaction, now, privateRoot, allowedUploadRoots }) => {
        assert.equal(privateRoot, options.privateRoot);
        assert.deepEqual(allowedUploadRoots, []);
        assert.ok(Number.isSafeInteger(now()));
        database.exec("CREATE TABLE fixture_board_probe (value TEXT NOT NULL) STRICT");
        transaction(() => database.prepare("INSERT INTO fixture_board_probe VALUES (?)").run("ready"));
        return () => database.prepare("SELECT value FROM fixture_board_probe").get().value;
      });
      events.push("opened");
      return {
        start() { events.push("started"); },
        invoke(input) {
          assert.deepEqual(input.actorIdentity, identity);
          if (input.action === "list") return { status: probe() };
          signal = input.signal;
          return new Promise((resolveDone, rejectDone) => {
            finishAction = () => {
              try { resolveDone({ cancelled: true, stateStore: probe() }); } catch (error) { rejectDone(error); }
            };
            input.signal.addEventListener("abort", confirmAbort, { once: true });
            entered();
          });
        },
        close() {
          if (signal) assert.equal(signal.aborted, true);
          assert.equal(probe(), "ready");
          events.push("closed");
        },
      };
    },
  };
  let runtime;
  const service = await startLiveService({ ...files, endpointFile }, {
    startRuntime: async options => {
      runtime = await startLiveFromConfig({ ...options, factories: mockFactories, boards });
      return runtime;
    },
  });
  files.cleanup(() => service.close());
  const direct = new Client({ name: "fixture-private-board", version: "1.0.0" });
  files.cleanup(() => direct.close());
  await direct.connect(new StreamableHTTPClientTransport(new URL(service.url), {
    requestInit: { headers: { Authorization: "Bearer " + principal.token } },
  }));
  const listed = await direct.callTool({ name: "communication_board", arguments: { caller, action: "list" } });
  assert.deepEqual(listed.structuredContent, { status: "ready", caller });
  const profile = join(files.directory, "fixture-board-connection.json");
  const registry = join(files.directory, "fixture-board-registry.json");
  await writeFile(profile, JSON.stringify({ endpoint_file: endpointFile, identity, token: facadePrincipal.token }), "utf8");
  await writeFile(registry, JSON.stringify({ version: 1, connections: [{ connection_file: profile }] }), "utf8");
  const facade = await createMcpStdioFacade({ registryFile: registry, includeContacts: true, includeMultiRecipient: true });
  files.cleanup(() => facade.close());
  const refused = await facade.callTool("communication_board", { caller, action: "list" });
  assert.equal(refused.isError, true);
  assert.equal(runtime.core.canUseBoardTool(facadePrincipal.id), false);
  const ongoing = runtime.core.board({ principal_id: principal.id }, { caller, action: "create", title: "测试板" });
  await inFlight;
  await direct.close();
  let stopped = false;
  const closing = service.close().then(() => { stopped = true; });
  await aborted;
  try {
    await delay(30);
    assert.equal(stopped, false);
  } finally {
    finishAction();
  }
  assert.deepEqual(await ongoing, { cancelled: true, stateStore: "ready" });
  await closing;
  assert.throws(() => runtime.core.board({ principal_id: principal.id }, { caller, action: "list" }), { code: "board_unavailable" });
  assert.deepEqual(events, ["opened", "started", "closed"]);
});

test("a disabled private board or malformed admin and upload settings never open the runtime", async context => {
  const { files, identity, principal } = await prepareBoardFixture(context);
  let constructed = 0;
  const open = () => { constructed += 1; throw new Error("must not open"); };
  const options = { ...files, factories: mockFactories };
  const privateBoard = { enabled: true, open, principalIds: [principal.id] };
  await assert.rejects(startLiveFromConfig({ ...options,
    boards: { ...privateBoard, superAdminIdentities: [{ ...identity, conversation_id: "*" }] } }), { code: "invalid_config" });
  await assert.rejects(startLiveFromConfig({ ...options,
    boards: { ...privateBoard, superAdminIdentities: [{ ...identity, surface: undefined }] } }), { code: "invalid_config" });
  await assert.rejects(startLiveFromConfig({ ...options,
    boards: { ...privateBoard, allowedUploadRoots: ["relative"] } }), { code: "invalid_config" });
  await assert.rejects(startLiveFromConfig({ ...options,
    boards: { ...privateBoard, principalIds: ["fixture-missing-board"] } }), { code: "invalid_config" });
  await assert.rejects(startLiveFromConfig({ ...options,
    boards: { ...privateBoard, peerMachineIds: ["fixture-unknown-machine"] } }), { code: "invalid_config" });
  await assert.rejects(startLiveFromConfig({ ...options,
    boards: { ...privateBoard, fileBundlePeers: ["fixture-unknown-machine"] } }), { code: "invalid_config" });
  const service = await startLiveFromConfig({ ...options, boards: { enabled: false, open } });
  files.cleanup(() => service.close());
  assert.equal(constructed, 0);
  assert.equal(service.core.canUseBoardTool(principal.id), false);
});

test("board retries and incoming events consult the narrower board and attachment permissions", async () => {
  const connected = new Map();
  const outbound = [];
  const inbound = [];
  const dispatcher = {
    registerOpHandler(op, handler) {
      connected.set(op, handler);
      return () => connected.delete(op);
    },
    async dispatchCustomOp(request) {
      outbound.push(request);
      return { status: "accepted" };
    },
  };
  const capabilities = new Map([["board-peer", { allow_file_bundle: true }]]);
  const readCaps = peer => capabilities.get(peer);
  assert.equal(restrictBoardRelayDispatcher(dispatcher, [], readCaps), undefined);
  const scoped = restrictBoardRelayDispatcher(dispatcher, ["board-peer"], readCaps);
  const unregister = scoped.registerOpHandler("board_delta", context => {
    inbound.push(context);
    return { handled: true };
  });
  const acceptDelta = connected.get("board_delta");
  const request = { targetMachine: "board-peer", attachments: [{ name: "fixture-file" }] };
  const verified = { remotePrincipal: { from_machine: "board-peer" }, staged_files: [{ name: "fixture-file" }] };
  assert.deepEqual(acceptDelta(verified), { handled: true });
  assert.equal((await scoped.dispatchCustomOp(request)).status, "accepted");

  const unrelated = { ...verified, remotePrincipal: { from_machine: "message-only-peer" } };
  assert.equal(acceptDelta(unrelated).code, "forbidden");
  await assert.rejects(scoped.dispatchCustomOp({ ...request, targetMachine: "message-only-peer" }), { code: "forbidden" });

  capabilities.set("board-peer", { allow_file_bundle: false });
  assert.equal(acceptDelta(verified).code, "relay_file_route_denied");
  await assert.rejects(scoped.dispatchCustomOp(request), { code: "relay_file_route_denied" });
  assert.equal(outbound.length, 1);
  assert.equal(inbound.length, 1);
  assert.deepEqual(acceptDelta({ ...verified, staged_files: [] }), { handled: true });
  assert.equal((await scoped.dispatchCustomOp({ ...request, attachments: [] })).status, "accepted");
  unregister();
  assert.equal(connected.has("board_delta"), false);
});

test("live board runtime allows authorized local shared host scope to open an existing board while rejecting external channel principals", async context => {
  const { files, principal, identity, caller } = await prepareBoardFixture(context);
  const hostScope = { machine_id: identity.machine_id, host: identity.host, surface: identity.surface };
  const sharedHostPrincipal = {
    ...principal, id: "fixture-board-shared-host", token: "fixture-board-shared-host-token",
    identity: { ...hostScope, conversation_id: "*" }, caller_scope: hostScope,
  };
  delete sharedHostPrincipal.address_book_identity_bound;
  const qqChannelPrincipal = {
    id: "fixture-board-qq-channel", token: "fixture-board-qq-channel-token",
    identity: { machine_id: identity.machine_id, host: "qq", surface: "group", conversation_id: "fixture-qq-group" },
    allowed_targets: [], origin_kinds: ["human_message"], channel_component: "napcat_owner",
  };
  const githubScopePrincipal = {
    id: "fixture-board-github-scope", token: "fixture-board-github-scope-token",
    identity: { machine_id: identity.machine_id, host: "github", surface: "webhook", conversation_id: "*" },
    caller_scope: { machine_id: identity.machine_id, host: "github", surface: "webhook" },
    allowed_targets: [], origin_kinds: ["agent_message"],
  };
  files.value.principals.push(sharedHostPrincipal, qqChannelPrincipal, githubScopePrincipal);
  await writeFile(files.configPath, JSON.stringify(files.value), "utf8");
  const endpointFile = join(files.directory, "fixture-shared-board-endpoint.json");

  // External QQ channel and non-model host (e.g. github) principals must be rejected at startup
  for (const badId of [qqChannelPrincipal.id, githubScopePrincipal.id]) {
    await assert.rejects(startLiveFromConfig({
      ...files, factories: mockFactories,
      boards: { enabled: true, principalIds: [badId], notifyIntervalMs: 0 },
    }), { code: "invalid_config" });
  }

  // Start real live board runtime granting both dedicated and local shared host principals
  const service = await startLiveService({ ...files, endpointFile }, {
    startRuntime: options => startLiveFromConfig({
      ...options, factories: mockFactories,
      boards: { enabled: true, principalIds: [principal.id, sharedHostPrincipal.id], notifyIntervalMs: 0 },
    }),
  });
  files.cleanup(() => service.close());

  // 1) Pre-create an existing board and post via dedicated principal
  const direct = new Client({ name: "fixture-direct-board-seed", version: "1.0.0" });
  files.cleanup(() => direct.close());
  await direct.connect(new StreamableHTTPClientTransport(new URL(service.url), {
    requestInit: { headers: { Authorization: "Bearer " + principal.token } },
  }));
  const created = await direct.callTool({ name: "communication_board", arguments: { caller, action: "create", title: "现役既有交流板" } });
  assert.notEqual(created.isError, true, JSON.stringify(created.structuredContent));
  const boardId = created.structuredContent.board_id;
  await direct.callTool({ name: "communication_board", arguments: { caller, action: "post", board: { board_id: boardId }, body: "已有首帖内容" } });

  // 2) Connect through real shared stdio facade using ONLY the host-scoped connection (no per-conversation card)
  const profile = join(files.directory, "fixture-shared-board-conn.json");
  const registry = join(files.directory, "fixture-shared-board-reg.json");
  await writeFile(profile, JSON.stringify({ endpoint_file: endpointFile, identity: sharedHostPrincipal.identity, caller_scope: hostScope, token: sharedHostPrincipal.token }), "utf8");
  await writeFile(registry, JSON.stringify({ version: 1, connections: [{ connection_file: profile }] }), "utf8");
  const facade = await createMcpStdioFacade({ registryFile: registry, includeContacts: true, includeBoard: true });
  files.cleanup(() => facade.close());

  const readExisting = await facade.callTool("communication_board", { caller, action: "read", board: { contact: "现役既有交流板" } });
  assert.notEqual(readExisting.isError, true, JSON.stringify(readExisting.structuredContent));
  assert.equal(readExisting.structuredContent.posts[0].body, "已有首帖内容");
  assert.deepEqual(readExisting.structuredContent.caller, caller);
  const posted = await facade.callTool("communication_board", { caller, action: "post", board: { contact: "现役既有交流板" }, body: "普通入口补发第二帖" });
  assert.notEqual(posted.isError, true, JSON.stringify(posted.structuredContent));
  assert.equal(posted.structuredContent.seq, 2);
  assert.deepEqual(posted.structuredContent.caller, caller);

  // 3) Impersonating another host or calling as non-member fails closed with exact submitted caller echoed
  const nonMemberCaller = { host: identity.host, conversation_id: "fixture-uninvited-conv" };
  const deniedRead = await facade.callTool("communication_board", { caller: nonMemberCaller, action: "read", board: { board_id: boardId } });
  assert.equal(deniedRead.isError, true);
  assert.equal(deniedRead.structuredContent?.error?.code, "forbidden");
  assert.deepEqual(deniedRead.structuredContent?.caller, nonMemberCaller);
  const otherHostCaller = { host: "windsurf", conversation_id: identity.conversation_id };
  const deniedHost = await facade.callTool("communication_board", { caller: otherHostCaller, action: "list" });
  assert.equal(deniedHost.isError, true);
  assert.equal(deniedHost.structuredContent?.error?.code, "caller_unregistered");
  assert.deepEqual(deniedHost.structuredContent?.caller, otherHostCaller);
});

test("the real private board MCP entry keeps each member's alias and post across a live restart", async context => {
  const { files, principal, identity } = await prepareBoardFixture(context);
  const member = { ...principal, id: "fixture-board-invitee", token: "fixture-board-invitee-token",
    identity: { ...identity, conversation_id: "fixture-board-invitee-conversation" } };
  const outsider = { ...principal, id: "fixture-board-outsider", token: "fixture-board-outsider-token",
    identity: { ...identity, conversation_id: "fixture-board-outsider-conversation" } };
  files.value.principals.push(member, outsider);
  await writeFile(files.configPath, JSON.stringify(files.value), "utf8");
  const endpointFile = join(files.directory, "fixture-real-board-endpoint.json");
  const notices = [];
  const boards = {
    enabled: true, principalIds: [principal.id, member.id, outsider.id], notifyIntervalMs: 0,
    async notifyLocalMember(notification) {
      notices.push({ member: notification.member, board_id: notification.board_id, kind: notification.kind });
      return { delivered: true };
    },
  };
  const start = async () => {
    const instance = await startLiveService({ ...files, endpointFile }, {
      startRuntime: options => startLiveFromConfig({ ...options, factories: mockFactories, boards }),
    });
    files.cleanup(() => instance.close());
    return instance;
  };
  async function connect(instance, memberPrincipal) {
    const client = new Client({ name: memberPrincipal.id, version: "1.0.0" });
    files.cleanup(() => client.close());
    await client.connect(new StreamableHTTPClientTransport(new URL(instance.url), {
      requestInit: { headers: { Authorization: "Bearer " + memberPrincipal.token } },
    }));
    const { host, conversation_id } = memberPrincipal.identity;
    return {
      client,
      request: async (action, extra = {}) => client.callTool({
        name: "communication_board", arguments: { caller: { host, conversation_id }, action, ...extra },
      }),
    };
  }
  async function boardCall(connection, action, extra) {
    const response = await connection.request(action, extra);
    assert.notEqual(response.isError, true, JSON.stringify(response.structuredContent));
    return response.structuredContent;
  }

  const first = await start();
  const creatorConnection = await connect(first, principal);
  const memberConnection = await connect(first, member);
  const outsiderConnection = await connect(first, outsider);
  const boardTitle = "测试公告";
  const created = await boardCall(creatorConnection, "create", { title: boardTitle });
  await boardCall(memberConnection, "create", { title: boardTitle });
  const board = { machine_id: identity.machine_id, board_id: created.board_id };
  const contactAlias = "试验收件对话";
  const saved = await creatorConnection.client.callTool({ name: "communication_contacts", arguments: {
    caller: identity, action: "save", alias: contactAlias, target: member.identity,
  } });
  assert.notEqual(saved.isError, true, JSON.stringify(saved.structuredContent));
  const wrongAlias = await creatorConnection.request("invite", { board, members: [{ contact: boardTitle }] });
  assert.equal(wrongAlias.structuredContent?.error?.code, "board_not_direct_target");
  const invited = await boardCall(creatorConnection, "invite", { board, members: [{ contact: contactAlias }] });
  const memberAlias = boardTitle + "#2";
  assert.equal(JSON.stringify(invited).includes(memberAlias), false);
  const listedCreator = await boardCall(creatorConnection, "list");
  const listedMember = await boardCall(memberConnection, "list");
  assert.equal(listedCreator.boards.find(entry => entry.board_id === board.board_id)?.alias, boardTitle);
  assert.equal(listedMember.boards.find(entry => entry.board_id === board.board_id)?.alias, memberAlias);
  assert.equal(listedMember.total, 2);
  assert.equal(listedMember.has_more, false);
  assert.deepEqual((await boardCall(outsiderConnection, "list")).boards, []);

  const outsideFile = join(files.directory, "fixture-file-not-authorized.txt");
  await writeFile(outsideFile, "not authorized for upload", "utf8");
  const deniedUpload = await creatorConnection.request("post", { board, body: "不得保存", files: [{ path: outsideFile }] });
  assert.equal(deniedUpload.structuredContent?.error?.code, "upload_path_denied");
  const memberAddress = { contact: memberAlias };
  await boardCall(memberConnection, "set_subscription", { board: memberAddress, delivery_mode: "event", filter_mode: "mute" });
  const mutedBody = "板仍可读，普通帖不提醒";
  await boardCall(creatorConnection, "post", { board: { contact: boardTitle }, body: mutedBody });
  assert.deepEqual(notices, []);
  const body = "真实交流板隔离入口发帖";
  const post = await boardCall(creatorConnection, "post", {
    board: { contact: boardTitle }, body, mentions: [{ contact: contactAlias }], client_post_id: "fixture-board-mention",
  });
  assert.deepEqual(notices, [{ member: member.identity, board_id: board.board_id, kind: "event_post" }]);
  const readByMember = await boardCall(memberConnection, "read", { board: memberAddress });
  assert.deepEqual(readByMember.posts.map(entry => entry.body), [mutedBody, body]);
  assert.ok(JSON.stringify(readByMember.posts[1].mentions).includes(member.identity.conversation_id));
  const deniedRead = await outsiderConnection.request("read", { board });
  assert.equal(deniedRead.structuredContent?.error?.code, "forbidden");

  await Promise.all([creatorConnection, memberConnection, outsiderConnection].map(connection => connection.client.close()));
  await first.close();
  const second = await start();
  const reopened = await connect(second, member);
  const recoveredList = await boardCall(reopened, "list");
  assert.equal(recoveredList.boards.find(entry => entry.board_id === board.board_id)?.alias, memberAlias);
  const recoveredPost = await boardCall(reopened, "read", { board: memberAddress, seq: post.seq });
  assert.deepEqual(recoveredPost.posts.map(post => post.body), [body]);
  assert.equal(notices.length, 1);
});

test("the live local-only board archives after 31 days without a relay or notice callback", async context => {
  const { files, principal, caller } = await prepareBoardFixture(context);
  const startMs = Date.UTC(2031, 0, 1);
  const threshold = startMs + 31 * 86_400_000;
  context.mock.timers.enable({ apis: ["Date", "setTimeout"], now: startMs });
  const adapter = new MockAdapter();
  const service = await startLiveService({ ...files, endpointFile: join(files.directory, "board-archive-endpoint.json") }, {
    startRuntime: options => startLiveFromConfig({
      ...options, factories: { antigravity: () => adapter }, boards: { enabled: true, principalIds: [principal.id] },
    }),
  });
  files.cleanup(() => service.close());
  const client = new Client({ name: "fixture-silent-board-archive", version: "1.0.0" });
  files.cleanup(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(service.url), {
    requestInit: { headers: { Authorization: "Bearer " + principal.token } },
  }));
  const request = async (action, fields = {}) => {
    const result = await client.callTool({ name: "communication_board", arguments: { caller, action, ...fields } });
    assert.notEqual(result.isError, true, JSON.stringify(result.structuredContent));
    return result.structuredContent;
  };
  const created = await request("create", { title: "归档验收" });
  const status = async () => (await request("list")).boards.find(entry => entry.board_id === created.board_id)?.status;

  context.mock.timers.setTime(threshold - 90_001);
  context.mock.timers.tick(90_000);
  assert.equal(Date.now(), threshold - 1);
  assert.equal(await status(), "active");
  context.mock.timers.tick(90_001);
  assert.equal(await status(), "archived");
  assert.equal(adapter.calls.length, 0);

  await client.close();
  await service.close();
  const database = new DatabaseSync(join(files.stateDir, "core.sqlite"), { readOnly: true });
  try {
    const row = database.prepare("SELECT status, archive_reason FROM boards WHERE board_id = ?").get(created.board_id);
    assert.equal(row?.status, "archived");
    assert.equal(row?.archive_reason, "auto_inactive_31d");
    assert.equal(database.prepare("SELECT count(*) AS count FROM board_notifications WHERE board_id = ?").get(created.board_id).count, 0);
  } finally { database.close(); }
});

test("an ambiguous live machine config will not label a local reader with the incoming caller's machine", async context => {
  const value = configuration();
  const callerConfig = value.principals[0];
  callerConfig.identity.machine_id = "fixture-other-machine";
  const scope = { machine_id: callerConfig.identity.machine_id, host: "antigravity", surface: "desktop" };
  callerConfig.allowed_host_lists = [scope];
  callerConfig.allowed_target_scopes = [scope];
  const files = await fixture(context, value);
  const service = await startLiveFromConfig({ ...files, factories: mockFactories });
  files.cleanup(() => service.close());
  assert.equal(service.core.statusProvider.localMachineId, null);
  assert.equal(service.core.hostContentProvider.localMachineId, null);
  let reads = 0;
  service.core.statusProvider.providers.set("antigravity", { async getHostStatus() { reads++; return { host_online: true }; } });
  service.core.hostContentProvider.providers.antigravity = { async list() { reads++; return { conversations: [] }; } };
  const caller = { host: callerConfig.identity.host, conversation_id: callerConfig.identity.conversation_id };
  const auth = { principal_id: callerConfig.id };
  const status = await service.core.getStatus(auth, { caller, ...scope });
  assert.equal(status.host_online, "unknown");
  assert.equal(status.code, "status_reader_not_configured");
  await assert.rejects(service.core.listConversations(auth, { caller, ...scope, scope: "host" }), { code: "host_content_unavailable" });
  assert.equal(reads, 0);
});

test("同stateDir第二runtime在adapter构造与SQLite调度前被拒绝", async context => {
  const files = await fixture(context);
  const first = await startLiveFromConfig({ ...files, factories: mockFactories });
  files.cleanup(() => first.close());
  let constructions = 0;
  let second;
  try {
    await assert.rejects((async () => {
      second = await startLiveFromConfig({ ...files, factories: { antigravity: () => { constructions += 1; return new MockAdapter(); } } });
    })(), error => error.code === "runtime_locked");
    assert.equal(constructions, 0);
  } finally {
    await second?.close();
  }
});

test("runtime关闭等待adapter完成才释放锁，关闭失败保留独占", async context => {
  const files = await fixture(context);
  let finish;
  let entered;
  const entering = new Promise(resolveEntered => { entered = resolveEntered; });
  const closing = new Promise(resolveFinish => { finish = resolveFinish; });
  const adapter = new MockAdapter();
  adapter.close = () => { entered(); return closing; };
  const service = await startLiveFromConfig({ ...files, factories: { antigravity: () => adapter } });
  files.cleanup(() => service.close());
  const stopped = service.close();
  await entering;
  try {
    await assert.rejects(startLiveFromConfig({ ...files, factories: mockFactories }), { code: "runtime_locked" });
    assert.ok((await stat(`${files.stateDir}.runtime-lock`)).isFile());
  } finally { finish(); }
  await stopped;
  assert.equal(JSON.parse(await readFile(`${files.stateDir}.runtime-lock`, "utf8")).state, "closed");
  const broken = new MockAdapter();
  broken.close = () => { throw new Error("synthetic-close-failure"); };
  const next = await startLiveFromConfig({ ...files, factories: { antigravity: () => broken } });
  files.cleanup(() => next.close().catch(() => {}));
  await assert.rejects(next.close(), { code: "shutdown_failed" });
  await assert.rejects(startLiveFromConfig({ ...files, factories: mockFactories }), { code: "runtime_locked" });
  await assert.rejects(startLiveFromConfig({ ...files, factories: mockFactories, recoverTerminated: true }), { code: "runtime_locked" });
});

test("旧无锁状态换endpoint仍在adapter与SQLite前拒绝", async context => {
  const files = await fixture(context);
  const service = await startLiveFromConfig({ ...files, factories: mockFactories });
  await service.close();
  await unlink(`${files.stateDir}.runtime-lock`);
  const database = await readFile(join(files.stateDir, "core.sqlite"));
  let constructed = 0;
  const endpointFile = join(files.directory, "synthetic-new-endpoint.json");
  await assert.rejects(startLiveService({ ...files, endpointFile }, { startRuntime: options => startLiveFromConfig({ ...options, factories: { antigravity: () => { constructed += 1; return new MockAdapter(); } } }) }), { code: "runtime_locked" });
  assert.equal(constructed, 0);
  assert.deepEqual(await readFile(join(files.stateDir, "core.sqlite")), database);
  await assert.rejects(stat(endpointFile), { code: "ENOENT" });
});

test("Codex私有连接默认工厂通过真实HTTP提交准确来源与原ID", async context => {
  const value = configuration();
  value.targets[0].host = "codex";
  value.adapters[0].kind = "codex_proxy";
  const files = await fixture(context, value);
  const calls = [];
  const upstream = createHttpServer(async (incoming, response) => {
    const buffers = [];
    for await (const chunk of incoming) buffers.push(chunk);
    const body = JSON.parse(Buffer.concat(buffers).toString("utf8"));
    calls.push({ url: incoming.url, token: incoming.headers.authorization, body });
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ok: true, delivery: { ...body, thread_id: body.target.conversation_id, turn_id: "synthetic-native-turn", outcome: "accepted", request_sent: true, injection_method: "turn/start" } }));
  });
  await new Promise(resolveListen => upstream.listen(0, "127.0.0.1", resolveListen));
  files.cleanup(() => new Promise(resolveClose => { upstream.closeAllConnections(); upstream.close(resolveClose); }));
  const connectionPath = join(files.directory, "synthetic-private-connection.json");
  await writeFile(connectionPath, JSON.stringify({ base_url: `http://127.0.0.1:${upstream.address().port}`, token: "synthetic-control-token" }), "utf8");
  value.adapters[0].connection_file = connectionPath;
  await writeFile(files.configPath, JSON.stringify(value), "utf8");
  const service = await startLiveFromConfig(files);
  files.cleanup(() => service.close());
  const result = await service.core.sendMessage({ principal_id: value.principals[0].id }, sendInput(value));
  await service.core.drain();
  const snapshot = service.core.getMessage({ principal_id: value.principals[0].id }, { caller: value.principals[0].identity, message_id: result.message.message_id });
  assert.equal(snapshot.delivery.status, "accepted");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/v1/communication/deliveries");
  assert.equal(calls[0].body.delivery_id, result.delivery.delivery_id);
  assert.equal(calls[0].body.origin.conversation_id, value.principals[0].identity.conversation_id);
  assert.equal(calls[0].body.target.conversation_id, value.targets[0].conversation_id);
  assert.equal(calls[0].token, "Bearer synthetic-control-token");
});

test("Codex默认工厂只在显式固定hash模块的submit前触发来源恢复", async context => {
  const value = configuration();
  value.targets[0].host = "codex";
  value.adapters[0].kind = "codex_proxy";
  const files = await fixture(context, value);
  const calls = [];
  const tracePath = join(files.directory, "synthetic-recovery-trace.json");
  const upstream = createHttpServer(async (incoming, response) => {
    const buffers = [];
    for await (const chunk of incoming) buffers.push(chunk);
    const body = JSON.parse(Buffer.concat(buffers).toString("utf8"));
    calls.push(body);
    assert.deepEqual(JSON.parse(await readFile(tracePath, "utf8")), { mode: "ensure" });
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ok: true, delivery: { ...body, thread_id: body.target.conversation_id, turn_id: "synthetic-native-turn", outcome: "accepted", request_sent: true, injection_method: "turn/start" } }));
  });
  await new Promise(resolveListen => upstream.listen(0, "127.0.0.1", resolveListen));
  files.cleanup(() => new Promise(resolveClose => { upstream.closeAllConnections(); upstream.close(resolveClose); }));
  const baseUrl = `http://127.0.0.1:${upstream.address().port}`;
  const modulePath = join(files.directory, "synthetic-recovery.mjs");
  const bytes = `import {writeFileSync} from 'node:fs'; export async function ensureCodexCommunication(options) { writeFileSync(${JSON.stringify(tracePath)}, JSON.stringify(options)); return {ok:true,status:'ready',endpoint:${JSON.stringify(baseUrl)},binding:{instance_id:'synthetic-instance',manifest_sha256:'${"a".repeat(64)}',configuration_sha256:'${"b".repeat(64)}'}}; }`;
  await writeFile(modulePath, bytes, "utf8");
  const connectionPath = join(files.directory, "synthetic-opt-in-connection.json");
  await writeFile(connectionPath, JSON.stringify({ base_url: baseUrl, token: "synthetic-control-token", source_recovery: { module_path: modulePath, sha256: createHash("sha256").update(bytes).digest("hex") } }), "utf8");
  value.adapters[0].connection_file = connectionPath;
  await writeFile(files.configPath, JSON.stringify(value), "utf8");
  const service = await startLiveFromConfig(files);
  files.cleanup(() => service.close());
  await assert.rejects(stat(tracePath), { code: "ENOENT" });
  const result = await service.core.sendMessage({ principal_id: value.principals[0].id }, sendInput(value));
  await service.core.drain();
  assert.equal(service.core.store.getDelivery(result.delivery.delivery_id).status, "accepted");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].delivery_id, result.delivery.delivery_id);
});

test("Codex私有连接拒绝显式空hook和未校验模块，不调用模块或业务", async context => {
  for (const sourceRecovery of [null, {}, { module_path: "relative.mjs", sha256: "0".repeat(64) }, { module_path: "file:///fixture.mjs", sha256: "0".repeat(64) }]) {
    const value = configuration();
    value.targets[0].host = "codex";
    value.adapters[0].kind = "codex_proxy";
    const files = await fixture(context, value);
    const connectionPath = join(files.directory, "synthetic-invalid-hook.json");
    await writeFile(connectionPath, JSON.stringify({ base_url: "http://127.0.0.1:12345", token: "synthetic-control-token", source_recovery: sourceRecovery }), "utf8");
    value.adapters[0].connection_file = connectionPath;
    await writeFile(files.configPath, JSON.stringify(value), "utf8");
    await assert.rejects(startLiveFromConfig(files), { code: "startup_failed" });
    await assert.rejects(stat(join(files.stateDir, "core.sqlite")), { code: "ENOENT" });
  }
});

test("默认Codex运行时close等待原来源恢复promise且取消后没有业务POST", async context => {
  const value = configuration();
  value.targets[0].host = "codex";
  value.adapters[0].kind = "codex_proxy";
  const files = await fixture(context, value);
  let entered;
  let release;
  const started = new Promise(resolveStarted => { entered = resolveStarted; });
  const pending = new Promise(resolvePending => { release = resolvePending; });
  const key = `synthetic-recovery-${files.directory}`;
  const state = { calls: 0, entered, pending };
  globalThis[key] = state;
  let posts = 0;
  const upstream = createHttpServer((incoming, response) => { posts += 1; response.writeHead(500); response.end(); });
  await new Promise(resolveListen => upstream.listen(0, "127.0.0.1", resolveListen));
  files.cleanup(() => new Promise(resolveClose => { upstream.closeAllConnections(); upstream.close(resolveClose); }));
  const baseUrl = `http://127.0.0.1:${upstream.address().port}`;
  const result = { ok: true, status: "ready", endpoint: baseUrl, binding: { instance_id: "synthetic-instance", manifest_sha256: "a".repeat(64), configuration_sha256: "b".repeat(64) } };
  files.cleanup(() => { release(result); delete globalThis[key]; });
  const bytes = `export async function ensureCodexCommunication() { const state = globalThis[${JSON.stringify(key)}]; state.calls += 1; state.entered(); return state.pending; }`;
  const modulePath = join(files.directory, "synthetic-pending-recovery.mjs");
  await writeFile(modulePath, bytes, "utf8");
  const connectionPath = join(files.directory, "synthetic-pending-connection.json");
  await writeFile(connectionPath, JSON.stringify({ base_url: baseUrl, token: "synthetic-token", source_recovery: { module_path: modulePath, sha256: createHash("sha256").update(bytes).digest("hex") } }), "utf8");
  value.adapters[0].connection_file = connectionPath;
  await writeFile(files.configPath, JSON.stringify(value), "utf8");
  const service = await startLiveFromConfig(files);
  files.cleanup(async () => { release(result); await service.close(); });
  await service.core.sendMessage({ principal_id: value.principals[0].id }, sendInput(value));
  await started;
  let closed = false;
  const closing = service.close().then(() => { closed = true; });
  await delay(20);
  assert.equal(closed, false);
  assert.equal(state.calls, 1);
  release(result);
  await closing;
  assert.equal(posts, 0);
});

function configuration() {
  return {
    adapter_mode: "live_test",
    allowed_conversation_ids: ["synthetic-ag-target"],
    adapters: [{ id: "synthetic-ag-adapter", kind: "antigravity" }],
    targets: [{
      machine_id: "synthetic-machine", host: "antigravity", surface: "test", conversation_id: "synthetic-ag-target",
      binding_id: "synthetic-ag-binding", binding_generation: 1, adapter_id: "synthetic-ag-adapter",
      capabilities: { next_model_boundary: true, when_idle: true }, evidence: "simulated",
    }],
    principals: [{
      id: "synthetic-source", token: "synthetic-source-token",
      identity: { machine_id: "synthetic-machine", host: "codex", conversation_id: "synthetic-source-conversation" },
      allowed_targets: ["synthetic-ag-binding"],
    }],
  };
}

async function fixture(context, value = configuration()) {
  const directory = await mkdtemp(join(tmpdir(), "communication-core-live-中文 "));
  const cleanups = [];
  context.after(async () => {
    const results = [];
    for (const cleanup of cleanups.reverse()) {
      try { await cleanup(); } catch (error) { results.push(error); }
    }
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    await rm(directory, { recursive: true, force: true });
    if (results.length) throw new AggregateError(results, "模拟运行资源清理失败");
  });
  const configPath = join(directory, "synthetic-配置.json");
  const stateDir = join(directory, "synthetic-状态");
  await writeFile(configPath, JSON.stringify(value), "utf8");
  return { directory, configPath, stateDir, value, cleanup: callback => cleanups.push(callback) };
}

async function waitUntil(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("模拟运行等待超时");
    await delay(10);
  }
}

function sendInput(value, dedupeKey = "synthetic-live-request") {
  const target = value.targets[0];
  return {
    caller: value.principals[0].identity,
    origin: { kind: "agent_message", channel: "host_mcp", source_ref: "synthetic-live-event" },
    target: {
      machine_id: target.machine_id, host: target.host, surface: target.surface,
      conversation_id: target.conversation_id, binding_id: target.binding_id, binding_generation: target.binding_generation,
    },
    dedupe_key: dedupeKey, text: "模拟入口验证，不发送真实消息", reply_required: true,
    expires_at: new Date(Date.now() + 60000).toISOString(),
  };
}

function ownerConfiguration(replyEvents) {
  const value = configuration();
  value.allowed_conversation_ids = ["synthetic-owner-target"];
  value.targets[0].host = "qq";
  value.targets[0].surface = "group";
  value.targets[0].conversation_id = "synthetic-owner-target";
  value.adapters[0] = { id: value.adapters[0].id, kind: "napcat_owner", base_url: "http://127.0.0.1:12345/napcat/mcp", route_key: "synthetic-owner-route", conversation_id: "synthetic-maintenance-route", ...(replyEvents === undefined ? {} : { reply_events: replyEvents }) };
  return value;
}

test("QQ回信配置默认关闭，只保留显式真实代次与本人allowlist的接入准备", async context => {
  for (const option of [undefined, { enabled: false }, { enabled: true, target_key: "synthetic-owner-target", route_generation: 7, owner_sender_allowlist: ["90001"] }]) {
    const files = await fixture(context, ownerConfiguration(option));
    let captured;
    const service = await startLiveFromConfig({ ...files, factories: { napcat_owner: entry => { captured = entry; return new MockAdapter(); } } });
    files.cleanup(() => service.close());
    assert.equal(captured.conversation_id, "synthetic-maintenance-route");
    if (option?.enabled) assert.deepEqual(captured.reply_events, { enabled: true, targetKey: "synthetic-owner-target", routeGeneration: 7, ownerSenderAllowlist: ["90001"] });
    else assert.deepEqual(captured.reply_events, option);
    await service.close();
  }
});

test("QQ回信配置缺少代次或本人授权时在构造和创建状态前拒绝", async context => {
  const valid = { enabled: true, target_key: "synthetic-owner-target", route_generation: 7, owner_sender_allowlist: ["90001"] };
  const files = await fixture(context, ownerConfiguration());
  let constructions = 0;
  const factories = { napcat_owner: () => { constructions += 1; return new MockAdapter(); } };
  const invalid = [null, {}, { enabled: "true" }, { ...valid, route_generation: 0 }, { ...valid, route_generation: 1.5 }, { ...valid, route_generation: undefined }, { ...valid, target_key: "another-target" }, { ...valid, owner_sender_allowlist: [] }, { ...valid, owner_sender_allowlist: [90001] }, { ...valid, owner_sender_allowlist: ["0"] }, { ...valid, owner_sender_allowlist: ["90001", "90001"] }, { ...valid, owner_sender_allowlist: ["90001", null] }, { ...valid, arbitrary_account: "private-data" }, { enabled: false, route_generation: 1 }];
  for (const option of invalid) {
    await writeFile(files.configPath, JSON.stringify(ownerConfiguration(option)), "utf8");
    await assert.rejects(startLiveFromConfig({ ...files, factories }), { code: "invalid_config" });
    assert.equal(constructions, 0);
    await assert.rejects(stat(files.stateDir), { code: "ENOENT" });
  }
});

function forwardingConfiguration() {
  const value = ownerConfiguration({ enabled: true, target_key: "synthetic-owner-target", route_generation: 7, owner_sender_allowlist: ["90001"] });
  const returnTarget = { ...configuration().targets[0], binding_id: "synthetic-return-binding", adapter_id: "synthetic-return-adapter" };
  value.allowed_conversation_ids.push(returnTarget.conversation_id);
  value.targets.push(returnTarget);
  value.adapters.push({ id: returnTarget.adapter_id, kind: "antigravity" });
  value.principals[0].identity = { machine_id: returnTarget.machine_id, host: returnTarget.host, surface: returnTarget.surface, conversation_id: returnTarget.conversation_id };
  value.reply_forwarding = [{ id: "synthetic-runtime-forward", source_principal_id: value.principals[0].id, from_binding_id: value.targets[0].binding_id, to_binding_id: returnTarget.binding_id, ttl_ms: 60000 }];
  return value;
}

test("QQ自动回推从已验证reader配置取得本人allowlist，内部授权不暴露HTTP token", async context => {
  const files = await fixture(context, forwardingConfiguration());
  const service = await startLiveFromConfig({ ...files, factories: { napcat_owner: () => new MockAdapter(), antigravity: () => new MockAdapter() } });
  files.cleanup(() => service.close());
  assert.deepEqual(service.core.replyForwarding[0].owner_sender_allowlist, ["90001"]);
  assert.equal(service.core.replyForwardPrincipals.length, 1);
  assert.equal(service.core.principals.length, 1);
  assert.equal(Object.hasOwn(service.core.replyForwardPrincipals[0], "token"), false);
  const denied = await fetch(service.url, { headers: { Authorization: `Bearer ${service.core.replyForwardPrincipals[0].id}` } });
  assert.equal(denied.status, 401);
  await denied.body?.cancel();
});

test("QQ自动回推的禁用reader、错来源及私自扩大allowlist在构造和建库前拒绝", async context => {
  const files = await fixture(context, forwardingConfiguration());
  let constructions = 0;
  const factories = { napcat_owner: () => { constructions += 1; return new MockAdapter(); }, antigravity: () => { constructions += 1; return new MockAdapter(); } };
  const mutations = [
    value => { value.adapters[0].reply_events = { enabled: false }; },
    value => { value.reply_forwarding[0].source_principal_id = "foreign-principal"; },
    value => { value.reply_forwarding[0].from_binding_id = value.targets[1].binding_id; },
    value => { value.reply_forwarding[0].to_binding_id = value.targets[0].binding_id; },
    value => { value.reply_forwarding[0].owner_sender_allowlist = ["90002"]; },
    value => { value.reply_forwarding[0].ttl_ms = 0; },
    value => { value.reply_forwarding[0].adopt_reply_events = [{ message_id: "synthetic-message", native_event_id: "" }]; },
  ];
  for (const mutation of mutations) {
    const value = forwardingConfiguration();
    mutation(value);
    await writeFile(files.configPath, JSON.stringify(value), "utf8");
    await assert.rejects(startLiveFromConfig({ ...files, factories }), { code: "invalid_config" });
    assert.equal(constructions, 0);
    await assert.rejects(stat(files.stateDir), { code: "ENOENT" });
  }
});

test("live配置拒绝越界、未知字段与重复授权，校验失败不构造adapter或创建状态目录", async context => {
  const files = await fixture(context);
  let constructions = 0;
  const factories = { antigravity: () => { constructions += 1; return new MockAdapter(); } };
  const mutations = [
    value => { delete value.adapter_mode; },
    value => { value.adapter_mode = "mock"; },
    value => { value.adapter_mode = "real"; },
    value => { value.host = "0.0.0.0"; },
    value => { value.host = "::1"; },
    value => { value.host = null; },
    value => { value.port = -1; },
    value => { value.port = 65536; },
    value => { value.port = 1.5; },
    value => { value.port = null; },
    value => { value.delivery_timeout_ms = 999; },
    value => { value.delivery_timeout_ms = 30001; },
    value => { value.delivery_timeout_ms = "15000"; },
    value => { value.delivery_timeout_ms = null; },
    value => { value.unknown = "synthetic-secret"; },
    value => { delete value.allowed_conversation_ids; },
    value => { value.allowed_conversation_ids = []; },
    value => { value.allowed_conversation_ids = ["synthetic-other-target"]; },
    value => { value.allowed_conversation_ids.push(value.allowed_conversation_ids[0]); },
    value => { value.allowed_conversation_ids = [" "]; },
    value => { value.allowed_conversation_ids = Array.from({ length: 257 }, (_, index) => `synthetic-${index}`); },
    value => { delete value.adapters; },
    value => { value.adapters = []; },
    value => { value.adapters = Array.from({ length: 257 }, (_, index) => ({ id: `synthetic-${index}`, kind: "antigravity" })); },
    value => { value.adapters[0].kind = "codex"; },
    value => { value.adapters[0].kind = "__proto__"; },
    value => { value.adapters[0].fields = {}; },
    value => { value.adapters[0].transport = {}; },
    value => { value.adapters.push({ ...value.adapters[0] }); },
    value => { delete value.targets; },
    value => { value.targets = []; },
    value => { value.targets = Array.from({ length: 257 }, () => ({ ...value.targets[0] })); },
    value => { value.targets.push({ ...value.targets[0] }); },
    value => { value.targets.push({ ...value.targets[0], binding_id: "synthetic-second-binding" }); },
    value => { value.targets[0].adapter_id = "synthetic-missing-adapter"; },
    value => { value.targets[0].binding_generation = 0; },
    value => { value.targets[0].unknown = true; },
    value => { value.targets[0].capabilities.unknown = true; },
    value => { value.targets[0].capabilities.next_model_boundary = "true"; },
    value => { delete value.principals; },
    value => { value.principals = []; },
    value => { value.principals = Array.from({ length: 257 }, () => ({ ...value.principals[0] })); },
    value => { value.principals.push({ ...value.principals[0], token: "synthetic-second-token" }); },
    value => { value.principals.push({ ...value.principals[0], id: "synthetic-second-principal" }); },
    value => { value.principals[0].token = "synthetic invalid token"; },
    value => { value.principals[0].token = "x".repeat(4097); },
    value => { value.principals[0].id = " "; },
    value => { value.principals[0].unknown = true; },
    value => { value.principals[0].identity.unknown = true; },
    value => { delete value.principals[0].identity.conversation_id; },
    value => { delete value.principals[0].allowed_targets; },
    value => { value.principals[0].allowed_targets = ["synthetic-missing-binding"]; },
    value => { value.principals[0].allowed_targets.push(value.principals[0].allowed_targets[0]); },
    value => { value.principals[0].origin_kinds = []; },
    value => { value.principals[0].origin_kinds = ["agent_message", "agent_message"]; },
    value => { value.principals[0].origin_kinds = Array.from({ length: 33 }, (_, index) => `synthetic-${index}`); },
    value => { value.principals[0].channel_component = " "; },
  ];
  for (const [index, mutate] of mutations.entries()) {
    const value = configuration();
    mutate(value);
    await writeFile(files.configPath, JSON.stringify(value), "utf8");
    await assert.rejects(startLiveFromConfig({ ...files, factories }), error => error.code === "invalid_config" && !error.message.includes("synthetic-secret"), `配置拒绝案例${index}`);
    await assert.rejects(stat(files.stateDir), { code: "ENOENT" });
  }
  assert.equal(constructions, 0);
});

test("live配置拒绝畸形、超大、目录及缺失文件，路径必须显式给出", async context => {
  const files = await fixture(context);
  for (const content of ["{synthetic-secret", " ".repeat(1048577), "null", "[]"]) {
    await writeFile(files.configPath, content, "utf8");
    await assert.rejects(startLiveFromConfig({ ...files, factories: mockFactories }), { code: "invalid_config" });
  }
  for (const options of [
    { configPath: files.directory, stateDir: files.stateDir },
    { configPath: join(files.directory, "missing.json"), stateDir: files.stateDir },
    { configPath: files.configPath },
    { stateDir: files.stateDir },
    { configPath: files.configPath, stateDir: " " },
  ]) await assert.rejects(startLiveFromConfig({ ...options, factories: mockFactories }), { code: "invalid_config" });
  await assert.rejects(stat(files.stateDir), { code: "ENOENT" });
});

test("live工厂固定kind，所有adapter构造成功才创建状态，失败清理已拥有实例并隐藏原错误", async context => {
  const files = await fixture(context);
  for (const factories of [{ codex: () => new MockAdapter() }, { antigravity: true }]) {
    await assert.rejects(startLiveFromConfig({ ...files, factories }), { code: "invalid_config" });
  }
  files.value.adapters.push({ id: "synthetic-second-adapter", kind: "antigravity" });
  await writeFile(files.configPath, JSON.stringify(files.value), "utf8");
  let closed = 0;
  const received = [];
  await assert.rejects(startLiveFromConfig({ ...files, factories: {
    antigravity: entry => {
      received.push(entry);
      if (entry.id === "synthetic-second-adapter") throw new Error("synthetic-private-token-and-ls-path");
      const adapter = new MockAdapter();
      adapter.close = () => { closed += 1; };
      return adapter;
    },
  } }), error => error.code === "startup_failed" && !/private|token|ls-path/.test(error.message));
  assert.deepEqual(received, files.value.adapters);
  assert.equal(closed, 1);
  await assert.rejects(stat(files.stateDir), { code: "ENOENT" });
  await assert.rejects(startLiveFromConfig({ ...files, factories: { antigravity: () => ({ close() { closed += 1; } }) } }), { code: "startup_failed" });
  assert.equal(closed, 2);
  await assert.rejects(stat(files.stateDir), { code: "ENOENT" });
});

test("UTF8 BOM、单个AG目标和仅来源principal可走真实MCP，关闭重开保留SQLite与去重身份", { timeout: 15000 }, async context => {
  const files = await fixture(context);
  await writeFile(files.configPath, `\uFEFF${JSON.stringify(files.value)}`, "utf8");
  let adapter;
  const factories = { antigravity: () => {
    adapter = new MockAdapter();
    adapter.observeReply = ({ target }) => ({
      native_message_id: "synthetic-native-reply", text: "模拟关联回信", source_step_index: 7,
      cascade_id: target.conversation_id, trajectory_id: "synthetic-trajectory",
    });
    return adapter;
  } };
  let service = await startLiveFromConfig({ ...files, factories });
  const client = new Client({ name: "synthetic-live-runtime", version: "0.1.0" });
  files.cleanup(async () => { await client.close(); await service.close(); });
  assert.equal(service.address.address, "127.0.0.1");
  assert.equal(service.core.deliveryTimeoutMs, 15000);
  assert.equal(service.core.targets.length, 1);
  assert.equal(service.core.principals[0].identity.surface, "desktop");
  assert.equal(service.core.principals[0].identity.conversation_id, "synthetic-source-conversation");
  assert.ok(!files.value.allowed_conversation_ids.includes("synthetic-source-conversation"));
  assert.deepEqual(service.core.principals[0].origin_kinds, ["agent_message"]);
  await client.connect(new StreamableHTTPClientTransport(new URL(service.url), {
    requestInit: { headers: { Authorization: `Bearer ${files.value.principals[0].token}` } },
  }));
  const tools = (await client.listTools()).tools;
  assert.equal(tools.length, 11);
  assert.ok(!tools.some(tool => /inject|fake|forge/i.test(tool.name)));
  const request = sendInput(files.value);
  const sent = await client.callTool({ name: "communication_send_message", arguments: request });
  assert.notEqual(sent.isError, true);
  const original = sent.structuredContent;
  await service.core.drain();
  assert.equal(adapter.calls.length, 1);
  assert.equal(service.core.result(original.message.message_id).delivery.status, "accepted");
  const reply = await client.callTool({ name: "communication_wait", arguments: {
    caller: files.value.principals[0].identity, message_id: original.message.message_id, until: "reply", wait_ms: 3000,
  } });
  assert.notEqual(reply.isError, true);
  assert.equal(reply.structuredContent.matched, true);
  assert.equal(reply.structuredContent.matched_by, "reply");
  assert.equal(service.core.result(original.message.message_id).message.processing, "pending");
  const url = service.url;
  await client.close();
  assert.strictEqual(service.close(), service.close());
  await service.close();
  await assert.rejects(fetch(url));
  const database = await stat(join(files.stateDir, "core.sqlite"));
  assert.ok(database.size > 0);
  service = await startLiveFromConfig({ ...files, factories });
  const restored = await service.core.sendMessage({ principal_id: files.value.principals[0].id }, request);
  assert.equal(restored.duplicate, true);
  assert.equal(restored.message.message_id, original.message.message_id);
  assert.equal(restored.delivery.delivery_id, original.delivery.delivery_id);
  assert.equal(adapter.calls.length, 0);
  assert.equal(service.core.result(original.message.message_id).delivery.status, "accepted");
  assert.equal(service.core.hasReply(original.message.message_id), true);
});

test("可选字段沿用S1授权，localhost仅监听回环，投递期限接受两个边界", async context => {
  for (const timeoutMs of [1000, 30000]) {
    const value = configuration();
    value.host = "localhost";
    value.port = 0;
    value.delivery_timeout_ms = timeoutMs;
    value.principals[0].allowed_targets = [];
    value.principals[0].channel_component = "synthetic-channel";
    delete value.targets[0].capabilities;
    delete value.targets[0].evidence;
    const files = await fixture(context, value);
    const service = await startLiveFromConfig({ ...files, factories: mockFactories });
    files.cleanup(() => service.close());
    assert.equal(service.address.address, "127.0.0.1");
    assert.match(service.url, /^http:\/\/localhost:\d+\/mcp$/);
    assert.equal(service.core.deliveryTimeoutMs, timeoutMs);
    assert.deepEqual(service.core.principals[0].allowed_targets, []);
    assert.equal(service.core.principals[0].channel_component, "synthetic-channel");
    assert.deepEqual(service.core.targets[0].capabilities, { next_model_boundary: false, when_idle: false });
    await service.close();
  }
});

test("投递和回信检查不互等，单路不重入，关闭等待已开始的工作", { timeout: 10000 }, async context => {
  const files = await fixture(context);
  const service = await startLiveFromConfig({ ...files, factories: mockFactories });
  files.cleanup(() => service.close());
  await service.core.drain();
  let dispatches = 0;
  let polls = 0;
  let dispatching = false;
  let polling = false;
  const dispatchGate = Promise.withResolvers();
  const replyGate = Promise.withResolvers();
  service.core.dispatchPending = async () => {
    assert.equal(dispatching, false);
    dispatches += 1;
    dispatching = true;
    await dispatchGate.promise;
    dispatching = false;
  };
  service.core.pollReplies = async () => {
    assert.equal(polling, false);
    polls += 1;
    polling = true;
    await replyGate.promise;
    polling = false;
  };
  let closed = false;
  try {
    await waitUntil(() => dispatching && polling);
    assert.equal(dispatches, 1);
    dispatchGate.resolve();
    await waitUntil(() => dispatches >= 2);
    assert.equal(polls, 1);
    const closing = service.close().then(() => { closed = true; });
    await delay(50);
    assert.equal(closed, false);
    assert.equal(polling, true);
    replyGate.resolve();
    await closing;
  } finally {
    dispatchGate.resolve();
    replyGate.resolve();
  }
  assert.equal(dispatching, false);
  assert.equal(polling, false);
  const count = dispatches;
  await delay(350);
  assert.equal(dispatches, count);
  assert.equal(polls, 1);
});

test("调度异常只回报安全文本并关闭HTTP、adapter与store，onError抛错也完成清理", { timeout: 10000 }, async context => {
  const files = await fixture(context);
  const errors = [];
  let closed = 0;
  const adapter = new MockAdapter();
  adapter.close = () => { closed += 1; };
  const service = await startLiveFromConfig({ ...files, factories: { antigravity: () => adapter }, onError: message => {
    errors.push(message);
    throw new Error("synthetic-onError-private-token");
  } });
  files.cleanup(() => service.close());
  await service.core.drain();
  service.core.pollReplies = async () => { throw new Error("synthetic-private-LS-token"); };
  await waitUntil(() => closed === 1);
  await service.close();
  assert.equal(errors.length, 1);
  assert.match(errors[0], /调度异常/);
  assert.ok(!errors[0].includes("synthetic"));
  assert.equal(service.core.closed, true);
  await assert.rejects(fetch(service.url));
  assert.throws(() => service.core.store.getMessage("synthetic-missing"));
  assert.ok((await stat(join(files.stateDir, "core.sqlite"))).size > 0);
});

test("close中止真实core在途模拟投递，等待后清理自有adapter且保留外部adapter所有权", { timeout: 10000 }, async context => {
  const files = await fixture(context);
  let signal;
  let aborted = false;
  let closed = 0;
  const adapter = new MockAdapter();
  adapter.deliver = options => {
    signal = options.signal;
    return new Promise(resolveDelivery => options.signal.addEventListener("abort", () => {
      aborted = true;
      resolveDelivery({ outcome: "unknown", delivery_id: options.delivery.delivery_id, target_key: options.delivery.target_key });
    }, { once: true }));
  };
  adapter.close = () => { assert.equal(aborted, true); closed += 1; };
  const service = await startLiveFromConfig({ ...files, factories: { antigravity: () => adapter } });
  files.cleanup(() => service.close());
  await service.core.sendMessage({ principal_id: files.value.principals[0].id }, sendInput(files.value));
  await waitUntil(() => signal !== undefined);
  await service.close();
  assert.equal(signal.aborted, true);
  assert.equal(closed, 1);
  const borrowed = new MockAdapter();
  borrowed.close = () => { throw new Error("不得关闭外部adapter"); };
  const reopened = await startLiveFromConfig({ ...files, factories: { antigravity: () => ({ adapter: borrowed, owned: false }) } });
  files.cleanup(() => reopened.close());
  await reopened.close();
  assert.equal(reopened.core.closed, true);
});

test("监听失败和退出清理失败保留SQLite，仍清理其余自有资源且隐藏内部错误", async context => {
  const files = await fixture(context);
  const occupied = createServer();
  await new Promise(resolveListening => occupied.listen(0, "127.0.0.1", resolveListening));
  files.cleanup(() => new Promise(resolveClosed => occupied.close(resolveClosed)));
  files.value.port = occupied.address().port;
  await writeFile(files.configPath, JSON.stringify(files.value), "utf8");
  let closed = 0;
  const adapter = new MockAdapter();
  adapter.close = () => { closed += 1; };
  await assert.rejects(startLiveFromConfig({ ...files, factories: { antigravity: () => adapter } }), error => error.code === "startup_failed" && !error.message.includes("EADDRINUSE"));
  assert.equal(closed, 1);
  assert.ok((await stat(join(files.stateDir, "core.sqlite"))).size > 0);
  files.value.port = 0;
  await writeFile(files.configPath, JSON.stringify(files.value), "utf8");
  const service = await startLiveFromConfig({ ...files, factories: { antigravity: () => {
    const broken = new MockAdapter();
    broken.close = () => { throw new Error("synthetic-private-shutdown-token"); };
    return broken;
  } } });
  files.cleanup(() => service.close().catch(() => {}));
  await assert.rejects(service.close(), error => error.code === "shutdown_failed" && !error.message.includes("synthetic"));
  await assert.rejects(fetch(service.url));
  assert.throws(() => service.core.store.getMessage("synthetic-missing"));
});

test("live CLI只接受config和state-dir，缺参、help、重复参数不启动", async () => {
  const output = [];
  const errors = [];
  for (const argumentsList of [[], ["--help"], ["-h"], ["--config", "a"], ["--unknown", "a", "--state-dir", "b"], ["--config", "a", "--config", "b", "--state-dir", "c"]]) {
    assert.equal(await runLiveCli(argumentsList, { stdout: { write: message => output.push(message) }, stderr: { write: message => errors.push(message) } }), 1);
  }
  assert.equal(output.length, 0);
  assert.equal(errors.length, 6);
  assert.ok(errors.every(message => /--config/.test(message) && /--state-dir/.test(message)));
});

function launch(context, files, { signal, direct = false } = {}) {
  const liveModule = pathToFileURL(join(root, "scripts", "live.mjs")).href;
  const mockModule = pathToFileURL(join(root, "src", "adapters", "mock.mjs")).href;
  const source = `import { runLiveCli } from ${JSON.stringify(liveModule)}; import { MockAdapter } from ${JSON.stringify(mockModule)}; process.exitCode = await runLiveCli(process.argv.slice(1), { factories: { antigravity: () => new MockAdapter() } }); ${signal ? `if (process.exitCode === 0) setTimeout(() => process.emit(${JSON.stringify(signal)}), 25);` : ""}`;
  const argumentsList = ["--config", files.configPath, "--state-dir", files.stateDir];
  const child = spawn(process.execPath, direct ? [join(root, "scripts", "live.mjs"), ...argumentsList] : ["--input-type=module", "-e", source, "--", ...argumentsList], {
    cwd: files.directory, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
  });
  child.stdin.on("error", () => {});
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk.toString(); });
  child.stderr.on("data", chunk => { stderr += chunk.toString(); });
  const exited = new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, exitSignal) => resolveExit({ code, signal: exitSignal, stdout, stderr }));
  });
  files.cleanup(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  });
  return {
    child, exited,
    async listening() {
      await waitUntil(() => stdout.includes("\n") || child.exitCode !== null);
      assert.equal(child.exitCode, null, stderr);
      const event = JSON.parse(stdout.trim());
      assert.deepEqual(Object.keys(event).sort(), ["event", "url"]);
      assert.equal(event.event, "listening");
      assert.match(event.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
      return event;
    },
  };
}

async function boundedExit(exited) {
  let timer;
  try {
    return await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("CLI退出超时，stdin可能仍被持有")), 5000); })]);
  } finally {
    clearTimeout(timer);
  }
}

test("live CLI在持有stdin管道时shutdown正常退出，随后同状态重开", { timeout: 15000 }, async context => {
  const files = await fixture(context);
  for (let iteration = 0; iteration < 2; iteration += 1) {
    const running = launch(context, files);
    await running.listening();
    running.child.stdin.write("shutdown\n");
    const result = await boundedExit(running.exited);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout.trim().split("\n").length, 1);
    assert.ok(!/synthetic-source-token|stack|Error:/.test(result.stdout + result.stderr));
    assert.ok((await stat(join(files.stateDir, "core.sqlite"))).size > 0);
  }
});

test("live CLI信号处理和stdin EOF释放句柄，直接入口启动失败不泄露配置", { timeout: 20000 }, async context => {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const files = await fixture(context);
    const running = launch(context, files, { signal });
    await running.listening();
    const result = await boundedExit(running.exited);
    assert.equal(result.code, 0, result.stderr);
    assert.ok((await stat(join(files.stateDir, "core.sqlite"))).size > 0);
  }
  const files = await fixture(context);
  const running = launch(context, files);
  await running.listening();
  running.child.stdin.end();
  assert.equal((await boundedExit(running.exited)).code, 0);
  await writeFile(files.configPath, '{"synthetic-private-token":', "utf8");
  const failed = launch(context, files, { direct: true });
  const result = await boundedExit(failed.exited);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /启动失败/);
  assert.ok(!/synthetic-private-token|SyntaxError|ENOENT/.test(result.stderr));
  assert.ok((await readFile(files.configPath, "utf8")).includes("synthetic-private-token"));
});

test("live napcat_owner config validates and forwards attachment roots and limits", async context => {
  const allowedDir = await mkdtemp(join(tmpdir(), "cc-live-att-cfg-"));
  context.after(() => rm(allowedDir, { recursive: true, force: true }));
  const cfg = ownerConfiguration();
  cfg.adapters[0].allowed_attachment_roots = [allowedDir];
  cfg.adapters[0].max_attachment_bytes = 1048576;
  cfg.adapters[0].max_attachments_per_message = 4;
  const files = await fixture(context, cfg);
  let captured;
  const service = await startLiveFromConfig({
    ...files,
    factories: { napcat_owner: entry => { captured = entry; return new MockAdapter(); } },
  });
  files.cleanup(() => service.close());
  assert.deepEqual(captured.allowed_attachment_roots, [allowedDir]);
  assert.equal(captured.max_attachment_bytes, 1048576);
  assert.equal(captured.max_attachments_per_message, 4);
  await service.close();

  for (const badAdapter of [
    { allowed_attachment_roots: ["relative/dir"] },
    { allowed_attachment_roots: ["\\\\server\\share\\dir"] },
    { max_attachment_bytes: 0 },
    { max_attachments_per_message: 33 },
  ]) {
    const badCfg = ownerConfiguration();
    Object.assign(badCfg.adapters[0], badAdapter);
    await writeFile(files.configPath, JSON.stringify(badCfg), "utf8");
    await assert.rejects(startLiveFromConfig({
      ...files,
      factories: { napcat_owner: () => new MockAdapter() },
    }), { code: "invalid_config" });
  }
});

test("live QQ private send resolves local Antigravity summary title first, strips group @ hint, and sends ordered attachments over real HTTP NapCat transport", { timeout: 15000 }, async context => {
  const workDir = await mkdtemp(join(tmpdir(), "cc-live-qq-e2e-"));
  context.after(() => rm(workDir, { recursive: true, force: true }));

  // 1. Create isolated Antigravity conversation_summaries.db
  const summaryDbPath = join(workDir, "conversation_summaries.db");
  const sdb = new DatabaseSync(summaryDbPath);
  sdb.exec(`CREATE TABLE conversation_summaries (
    conversation_id TEXT PRIMARY KEY,
    title TEXT,
    workspace_uris TEXT,
    last_modified_time TEXT,
    parent_conversation_id TEXT,
    nesting_depth INTEGER,
    source TEXT,
    agent_name TEXT
  )`);
  sdb.prepare(`INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, '', 0, '', '')`)
    .run("catcloud-conv-1", "猫猫云梯核心开发对话", "[]", "2026-11-28T08:00:00Z");
  sdb.close();

  // 2. Prepare allowed local files (document, image, video)
  const docPath = join(workDir, "summary.txt");
  const imgPath = join(workDir, "preview.png");
  const vidPath = join(workDir, "clip.mp4");
  await writeFile(docPath, "hello owner\n", "utf8");
  await writeFile(imgPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  await writeFile(vidPath, Buffer.alloc(32, 0x7a));

  // 3. Real isolated HTTP JSON-RPC NapCat MCP server
  const receivedCalls = [];
  const napcatServer = createHttpServer(async (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    let body = "";
    for await (const chunk of req) body += chunk.toString("utf8");
    const rpc = JSON.parse(body);
    if (rpc.method === "initialize") {
      res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "napcat-e2e-session" });
      res.end(JSON.stringify({
        jsonrpc: "2.0",
        id: rpc.id,
        result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fake-napcat", version: "1.0.0" } },
      }));
      return;
    }
    if (rpc.method === "notifications/initialized") {
      res.writeHead(202).end();
      return;
    }
    if (rpc.method === "tools/call") {
      const { name, arguments: args } = rpc.params;
      receivedCalls.push({ name, args });
      let structuredContent = { ok: true, ready: true };
      if (name === "napcat_owner_alert") {
        structuredContent = {
          ok: true, sent: true, verified: true, statePersisted: true,
          target: { targetKey: "owner-private" }, messageId: "44001",
        };
      } else if (name === "napcat_send_configured_chat_file") {
        const idx = receivedCalls.filter(c => c.name === "napcat_send_configured_chat_file").length;
        structuredContent = {
          ok: true, sent: true, verified: true, chatFileStatePersisted: true,
          target: { targetKey: args.target_key },
          messageId: String(44100 + idx),
          fileMessageId: String(44100 + idx),
          fileId: `e2e-fid-${idx}`,
          fileName: args.name,
          fileBytes: idx === 1 ? 12 : idx === 2 ? 8 : 32,
          sha256: String(idx).repeat(64),
        };
      }
      res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "napcat-e2e-session" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { structuredContent } }));
      return;
    }
    res.writeHead(400).end();
  });
  await new Promise(resolveListen => napcatServer.listen(0, "127.0.0.1", resolveListen));
  context.after(() => new Promise(resolveClose => napcatServer.close(() => resolveClose())));
  const napcatPort = napcatServer.address().port;

  // 4. Start real live runtime with Antigravity summary index + real NapcatOwnerAdapter
  const cfg = ownerConfiguration();
  cfg.allowed_conversation_ids = ["owner-private", "catcloud-conv-1"];
  cfg.targets[0].surface = "private";
  cfg.targets[0].conversation_id = "owner-private";
  cfg.adapters[0] = {
    id: cfg.adapters[0].id,
    kind: "napcat_owner",
    base_url: `http://127.0.0.1:${napcatPort}/napcat/mcp`,
    route_key: "synthetic-private-route",
    conversation_id: "synthetic-maintenance-route",
    reply_hint: "有事引用这条并@我即可～",
    allowed_attachment_roots: [workDir],
  };
  cfg.adapters.push({
    id: "ag-local",
    kind: "antigravity",
    conversation_index_file: summaryDbPath,
  });
  const agScope = { machine_id: cfg.targets[0].machine_id, host: "antigravity", surface: "desktop" };
  cfg.principals[0].identity = { ...agScope, conversation_id: "*" };
  cfg.principals[0].caller_scope = agScope;
  cfg.principals[0].allowed_host_lists = [agScope];

  const files = await fixture(context, cfg);
  const service = await startLiveFromConfig({ ...files });
  files.cleanup(() => service.close());

  const caller = { ...agScope, conversation_id: "catcloud-conv-1" };
  const authCtx = { principal_id: cfg.principals[0].id };
  const created = await service.core.sendMessage(authCtx, {
    caller,
    origin: { kind: "agent_message", channel: "antigravity", source_ref: "catcloud-conv-1" },
    target: {
      machine_id: cfg.targets[0].machine_id,
      host: "qq",
      surface: "private",
      conversation_id: "owner-private",
      binding_id: cfg.targets[0].binding_id,
      binding_generation: cfg.targets[0].binding_generation,
    },
    dedupe_key: "live-qq-title-and-3-attachments",
    text: "附件已发来，请查收",
    attachment_refs: [docPath, imgPath, vidPath],
    expires_at: new Date(Date.now() + 60000).toISOString(),
  });

  await service.core.drain();
  const detail = await service.core.getMessage(authCtx, { caller, message_id: created.message.message_id });
  assert.equal(detail.delivery.status, "accepted");

  const alertCall = receivedCalls.find(c => c.name === "napcat_owner_alert");
  assert.ok(alertCall, "expected napcat_owner_alert call");
  assert.equal(alertCall.args.summary, "交流核心转送 / 来源「猫猫云梯核心开发对话」：\n附件已发来，请查收");
  assert.equal(alertCall.args.reply_hint, "有事引用这条即可～");

  const fileCalls = receivedCalls.filter(c => c.name === "napcat_send_configured_chat_file");
  assert.deepEqual(fileCalls.map(c => c.args.name), ["summary.txt", "preview.png", "clip.mp4"]);
  assert.deepEqual(fileCalls.map(c => c.args.target_key), ["owner-private", "owner-private", "owner-private"]);
  assert.equal(detail.delivery.evidence.evidence.native_receipt.attachments.length, 3);
  assert.deepEqual(
    detail.delivery.evidence.evidence.native_receipt.attachments.map(a => [a.index, a.file_name, a.message_id, a.verified, a.deduped]),
    [
      [0, "summary.txt", "44101", true, false],
      [1, "preview.png", "44102", true, false],
      [2, "clip.mp4", "44103", true, false],
    ],
  );
  await service.close();
});
