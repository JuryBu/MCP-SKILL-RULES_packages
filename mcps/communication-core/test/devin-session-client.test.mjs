import test from 'node:test';
import assert from 'node:assert/strict';
import { createDevinSessionClient } from '../src/transports/devin-session-client.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const binding = { connectorId: 'fixture-connector', sessionId: 'fixture-daemon-session', cwd: 'C:/fixture/workspace' };
const agentCapabilities = { sessionCapabilities: { resume: {} }, _meta: { 'cognition.ai/midTurnPrompts': true, 'cognition.ai/queuedMessages': true } };
const input = (suffix, extra = {}) => ({ message_id: `fixture-message-${suffix}`, delivery_id: `fixture-delivery-${suffix}`, text: `合成消息 ${suffix}`, ...extra });

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function harness(options = {}) {
  const wire = [];
  const client = createDevinSessionClient({ ...binding, requestTimeoutMs: 500, ...options, sendLine: options.sendLine ?? (line => { wire.push(JSON.parse(line)); }) });
  const reply = (frame, result) => client.feedLine(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result }));
  const error = (frame, code = -32000) => client.feedLine(JSON.stringify({ jsonrpc: '2.0', id: frame.id, error: { code, message: 'synthetic error' } }));
  const echo = (messageId, sessionId = binding.sessionId, meta = {}) => client.feedLine(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'synthetic echo' }, _meta: { 'cognition.ai/clientMessageId': messageId, ...meta } } } }));
  return { client, wire, reply, error, echo };
}

async function handshake(target, capabilities = agentCapabilities) {
  const initialized = target.client.initialize();
  await tick();
  target.reply(target.wire.at(-1), { protocolVersion: 2, agentCapabilities: capabilities });
  assert.equal((await initialized).outcome, 'accepted');
  const attached = target.client.attach();
  await tick();
  target.reply(target.wire.at(-1), {});
  assert.equal((await attached).outcome, 'accepted');
  await tick();
  return target;
}

function assertIdentity(result, original, description) {
  assert.equal(result.message_id, original.message_id);
  assert.equal(result.delivery_id, original.delivery_id);
  assert.equal(result.session_id, description.session_id);
  assert.equal(result.connector_id, description.connector_id);
  assert.equal(result.connection_id, description.connection_id);
  assert.equal(result.protocol_version, description.protocol_version);
  assert.equal(result.model_processing, 'unknown');
  assert.equal(result.ui_visibility, 'unknown');
}

test('v2 initialize advertises no fs/terminal; plain resume stays on the bound session', async () => {
  const target = harness();
  try {
    assert.equal(target.client.describe().ready, false);
    assert.equal(target.client.describe().mode_evidence, null);
    await handshake(target);
    assert.deepEqual(target.wire[0].params.clientCapabilities, { fs: { readTextFile: false, writeTextFile: false }, terminal: false, auth: { terminal: false } });
    assert.equal(target.wire[0].params.protocolVersion, 2);
    assert.equal(target.wire[1].method, 'session/resume');
    assert.deepEqual(target.wire[1].params, { sessionId: binding.sessionId, cwd: binding.cwd, mcpServers: [] });
    const description = target.client.describe();
    assert.equal(description.ready, true);
    assert.deepEqual(description.capabilities, { direct: true, queue: true, resume: true });
    for (const name of ['session_id', 'connector_id', 'connection_id', 'protocol_version']) assert.equal(description.mode_evidence[name], description[name]);
    assert.equal(description.model_id, null);
    assert.equal(description.mode_id, null);
    await target.client.initialize();
    await target.client.attach();
    assert.equal(target.wire.length, 2);
  } finally { target.client.close(); }
});

test('second direct is written while the original prompt is still pending', async () => {
  const target = await handshake(harness());
  try {
    const first = input('original');
    const second = input('steering');
    const firstResult = target.client.deliver(first);
    await tick();
    const secondResult = target.client.deliver(second);
    await tick();
    assert.deepEqual(target.wire.slice(2).map(frame => frame.method), ['session/prompt', 'session/prompt']);
    assert.deepEqual(target.wire[3].params, { sessionId: binding.sessionId, prompt: [{ type: 'text', text: second.text }], _meta: { 'cognition.ai/clientMessageId': second.message_id } });
    assert.notEqual(target.wire[2].id, target.wire[3].id);
    assert.equal(target.client.query(first).outcome, 'unknown');
    target.reply(target.wire[3], { messageId: 'fixture-native-insertion' });
    const inserted = await secondResult;
    assertIdentity(inserted, second, target.client.describe());
    assert.equal(inserted.outcome, 'accepted');
    assert.equal(inserted.evidence.kind, 'direct_receipt');
    assert.equal(inserted.evidence.turn_complete, false);
    assert.equal(target.client.query(first).outcome, 'unknown');
    target.reply(target.wire[2], { stopReason: 'end_turn' });
    assert.equal((await firstResult).evidence.turn_complete, true);
    assert.equal(target.wire.some(frame => /cancel|close|unload|new|load/u.test(frame.method)), false);
  } finally { target.client.close(); }
});

test('explicit when_idle uses only queue add and distinguishes its acknowledgement', async () => {
  const target = await handshake(harness());
  try {
    const original = input('queued', { policy: 'when_idle' });
    const result = target.client.deliver(original);
    await tick();
    assert.equal(target.wire[2].method, '_cognition.ai/queuedMessages/update');
    assert.deepEqual(target.wire[2].params, { sessionId: binding.sessionId, op: 'add', id: original.message_id, message: { message: original.text } });
    target.reply(target.wire[2], {});
    const receipt = await result;
    assertIdentity(receipt, original, target.client.describe());
    assert.equal(receipt.evidence.kind, 'queue_ack');
    assert.equal(receipt.evidence.turn_complete, false);
    assert.equal(target.wire.length, 3);
  } finally { target.client.close(); }
});

test('awaited onRequestStarted completes before prompt write; cancellation during hook stays unsent', async () => {
  const target = await handshake(harness());
  const gate = deferred();
  const controller = new AbortController();
  let started = 0;
  try {
    const result = target.client.deliver(input('hook', { signal: controller.signal, onRequestStarted: async context => { started++; assert.equal(context.message_id, 'fixture-message-hook'); await gate.promise; } }));
    await tick();
    assert.equal(started, 1);
    assert.equal(target.wire.length, 2);
    controller.abort();
    assert.deepEqual([(await result).outcome, (await result).request_sent], ['failed_before_send', false]);
    gate.resolve();
    await tick();
    assert.equal(target.wire.length, 2);
  } finally { gate.resolve(); target.client.close(); }
});

test('successful hook gate is awaited and sees exact original IDs', async () => {
  const target = await handshake(harness());
  const gate = deferred();
  try {
    const original = input('hook-success', { onRequestStarted: async context => { assertIdentity({ ...context, model_processing: 'unknown', ui_visibility: 'unknown' }, input('hook-success'), target.client.describe()); await gate.promise; } });
    const result = target.client.deliver(original);
    await tick();
    assert.equal(target.wire.length, 2);
    gate.resolve();
    await tick();
    target.reply(target.wire[2], { messageId: 'native-hook-success' });
    assert.equal((await result).outcome, 'accepted');
  } finally { gate.resolve(); target.client.close(); }
});

test('hook exception, pre-cancel, text and frame budgets do not write or resend', async () => {
  const target = await handshake(harness({ limits: { maxFrameBytes: 512, maxTextBytes: 1000 } }));
  try {
    const failure = await target.client.deliver(input('hook-error', { onRequestStarted: () => { throw new Error('synthetic'); } }));
    assert.equal(failure.request_sent, false);
    const controller = new AbortController();
    controller.abort();
    assert.equal((await target.client.deliver(input('cancelled', { signal: controller.signal }))).request_sent, false);
    assert.equal((await target.client.deliver(input('text-limit', { text: '中'.repeat(400) }))).reason, 'text_budget');
    let hookCalls = 0;
    assert.equal((await target.client.deliver(input('frame-limit', { text: 'x'.repeat(600), onRequestStarted: () => hookCalls++ }))).reason, 'frame_budget');
    assert.equal(hookCalls, 0);
    assert.equal(target.wire.length, 2);
  } finally { target.client.close(); }
});

test('timeout retains original request and accepts a late exact RPC receipt without retransmission', async () => {
  const target = await handshake(harness({ requestTimeoutMs: 60 }));
  try {
    const original = input('late');
    const result = await target.client.deliver(original);
    assertIdentity(result, original, target.client.describe());
    assert.equal(result.outcome, 'unknown');
    assert.equal(result.request_sent, true);
    await target.client.deliver(original);
    assert.equal(target.wire.length, 3);
    target.reply(target.wire[2], { messageId: 'native-late' });
    assert.equal(target.client.query(original).outcome, 'accepted');
    assert.equal(target.client.query(original).evidence.native_message_id, 'native-late');
    assert.equal(target.wire.length, 3);
  } finally { target.client.close(); }
});

test('post-write cancellation preserves IDs and late errors stay on their original request', async () => {
  const target = await handshake(harness());
  try {
    const controller = new AbortController();
    const first = input('cancel-after', { signal: controller.signal });
    const second = input('independent');
    const firstResult = target.client.deliver(first);
    await tick();
    const secondResult = target.client.deliver(second);
    await tick();
    controller.abort();
    assert.equal((await firstResult).request_sent, true);
    target.error(target.wire[2], -32001);
    assert.equal(target.client.query(first).evidence.code, -32001);
    assert.equal(target.client.query(second).evidence, undefined);
    target.reply(target.wire[3], { _meta: { 'cognition.ai/streamingMessageId': 'native-stream' } });
    assert.equal((await secondResult).evidence.native_message_id, 'native-stream');
    target.echo(first.message_id);
    assert.equal(target.client.query(first).outcome, 'accepted');
    assert.equal(target.client.query(first).evidence.kind, 'direct_echo');
    assert.equal(target.wire.length, 4);
  } finally { target.client.close(); }
});

test('EOF, malformed JSON and oversized frames close only the client and retain unknown sent operations', async () => {
  for (const frame of [null, '{broken json', 'x'.repeat(2097153), '{"jsonrpc":"2.0","id":0,"result":{},"error":{}}']) {
    const target = await handshake(harness());
    const original = input('input-fault');
    const result = target.client.deliver(original);
    await tick();
    target.client.feedLine(frame);
    assert.equal((await result).outcome, 'unknown');
    assert.equal(target.client.describe().ready, false);
    assert.equal(target.client.query(original).request_sent, true);
    await target.client.deliver(original);
    assert.equal(target.wire.length, 3);
  }
});

test('permission, fs and terminal requests are unsupported; foreign session notifications never mix', async () => {
  const target = await handshake(harness());
  try {
    const original = input('permissions');
    const result = target.client.deliver(original);
    await tick();
    for (const [index, method] of ['session/request_permission', 'fs/read_text_file', 'fs/write_text_file', 'terminal/create', 'terminal/wait_for_exit'].entries()) {
      target.client.feedLine(JSON.stringify({ jsonrpc: '2.0', id: index, method, params: { sessionId: binding.sessionId } }));
    }
    await tick();
    assert.equal(target.wire.length, 8);
    for (const reply of target.wire.slice(3)) {
      assert.equal(reply.error.code, -32601);
      assert.equal(reply.error.data.reason, 'client_method_unsupported');
      assert.equal(Object.hasOwn(reply, 'result'), false);
    }
    assert.equal(target.echo(original.message_id, 'fixture-foreign-session').status, 'foreign_notification');
    assert.equal(target.echo(original.message_id, binding.sessionId, { 'cognition.ai/isOptimistic': true }).status, 'unmatched_echo');
    assert.equal(target.client.query(original).outcome, 'unknown');
    assert.equal(target.echo('fixture-unrecognized-id').status, 'unmatched_echo');
    assert.equal(target.echo(original.message_id).status, 'matched_echo');
    assert.equal((await result).evidence.kind, 'direct_echo');
    assert.equal(target.client.describe().retained_operations, 1);
  } finally { target.client.close(); }
});

test('v1 is rejected; missing resume declaration never falls back to load or new', async () => {
  for (const result of [{ protocolVersion: 1, agentCapabilities }, { protocolVersion: 2, agentCapabilities: { _meta: agentCapabilities._meta } }]) {
    const target = harness();
    try {
      const init = target.client.initialize();
      await tick();
      target.reply(target.wire[0], result);
      await init;
      const attached = await target.client.attach();
      assert.equal(attached.request_sent, false);
      assert.equal(target.client.describe().ready, false);
      assert.equal(target.wire.length, 1);
    } finally { target.client.close(); }
  }
});

test('only current initialize agentCapabilities metadata enables modes; direct never degrades to queue', async () => {
  const target = await handshake(harness(), { sessionCapabilities: { resume: {} }, _meta: { 'cognition.ai/queuedMessages': true } });
  try {
    const result = await target.client.deliver(input('no-direct'));
    assert.equal(result.reason, 'mode_unsupported');
    assert.equal(result.request_sent, false);
    assert.equal(target.wire.length, 2);
    assert.equal(target.client.describe().capabilities.direct, false);
    const queued = target.client.deliver(input('queue-only', { policy: 'when_idle' }));
    await tick();
    target.reply(target.wire[2], {});
    assert.equal((await queued).evidence.kind, 'queue_ack');
  } finally { target.client.close(); }
  const wrongLevel = await handshake(harness(), { sessionCapabilities: { resume: {} }, direct: true, queue: true });
  try { assert.equal((await wrongLevel.client.deliver(input('wrong-level'))).reason, 'mode_unsupported'); }
  finally { wrongLevel.client.close(); }
});

test('new connection cannot reuse enabled capabilities or query evidence from an older instance', async () => {
  const original = await handshake(harness());
  const replacement = harness({ connectionId: original.client.describe().connection_id, modeEvidence: original.client.describe().mode_evidence });
  try {
    assert.notEqual(original.client.describe().connection_id, replacement.client.describe().connection_id);
    assert.equal(replacement.client.describe().ready, false);
    assert.deepEqual(replacement.client.describe().capabilities, { direct: false, queue: false, resume: false });
    assert.equal(replacement.client.query(input('lost')).outcome, 'unknown');
    assert.equal(replacement.client.query(input('lost')).request_sent, 'unknown');
    assert.equal((await replacement.client.deliver(input('new'))).outcome, 'busy');
    assert.equal(replacement.wire.length, 0);
    assert.equal((await original.client.deliver(input('wrong-target', { connection_id: replacement.client.describe().connection_id }))).reason, 'target_mismatch');
  } finally { original.client.close(); replacement.client.close(); }
});

test('pending and operation budgets retain uncertain entries and refuse new work without eviction', async () => {
  const target = await handshake(harness({ limits: { maxPending: 1, maxOperations: 2 }, requestTimeoutMs: 60 }));
  try {
    const first = input('budget-one');
    const firstResult = await target.client.deliver(first);
    assert.equal(firstResult.outcome, 'unknown');
    const blocked = await target.client.deliver(input('budget-two'));
    assert.equal(blocked.outcome, 'busy');
    assert.equal(blocked.request_sent, false);
    assert.equal(target.wire.length, 3);
    assert.equal(target.client.describe().awaiting_responses, 1);
    target.reply(target.wire[2], { messageId: 'native-budget-one' });
    const second = target.client.deliver(input('budget-two'));
    await tick();
    target.reply(target.wire[3], { messageId: 'native-budget-two' });
    await second;
    assert.equal((await target.client.deliver(input('budget-three'))).reason, 'operation_budget');
    assert.equal(target.client.query(first).outcome, 'accepted');
    assert.equal(target.client.describe().retained_operations, 2);
  } finally { target.client.close(); }
});

test('duplicate exact IDs share one operation; message/delivery/text conflicts are rejected', async () => {
  const target = await handshake(harness());
  let hookCalls = 0;
  try {
    const original = input('duplicate', { onRequestStarted: () => hookCalls++ });
    const first = target.client.deliver(original);
    const second = target.client.deliver(original);
    await tick();
    for (const changed of [{ ...original, text: 'different' }, { ...original, delivery_id: 'different-delivery' }, { ...original, message_id: 'different-message' }, { ...original, policy: 'when_idle' }]) assert.equal((await target.client.deliver(changed)).reason, 'id_conflict');
    assert.equal(hookCalls, 1);
    assert.equal(target.wire.length, 3);
    target.reply(target.wire[2], { messageId: 'native-duplicate' });
    assert.equal((await first).outcome, 'accepted');
    assert.deepEqual(await second, await first);
    assert.equal(target.client.query({ message_id: original.message_id, delivery_id: 'other' }).outcome, 'unknown');
  } finally { target.client.close(); }
});

test('a transport exception is unknown and closes this client without retry, cancel or shared stop', async () => {
  const wire = [];
  const target = harness({ sendLine: line => { const frame = JSON.parse(line); wire.push(frame); if (frame.method === 'session/prompt') throw new Error('synthetic partial write'); } });
  target.wire = wire;
  await handshake(target);
  const original = input('write-fault');
  const result = await target.client.deliver(original);
  assert.equal(result.request_sent, 'unknown');
  assert.equal(result.outcome, 'unknown');
  assert.equal(target.client.describe().closed, true);
  await target.client.deliver(original);
  assert.deepEqual(wire.map(frame => frame.method), ['initialize', 'session/resume', 'session/prompt']);
});

test('write backlog timeout distinguishes written unknown from never-written queued prompt', async () => {
  const gate = deferred();
  const wire = [];
  const target = harness({ requestTimeoutMs: 60, sendLine: line => { const frame = JSON.parse(line); wire.push(frame); if (frame.method === 'session/prompt') return gate.promise; } });
  target.wire = wire;
  await handshake(target);
  try {
    const first = target.client.deliver(input('blocked-write'));
    const second = target.client.deliver(input('behind-write'));
    assert.equal((await first).request_sent, true);
    assert.equal((await second).request_sent, false);
    assert.equal((await second).outcome, 'failed_before_send');
    gate.resolve();
    await tick();
    assert.equal(wire.length, 3);
    target.client.close();
    assert.equal(target.client.query(input('blocked-write')).outcome, 'unknown');
    assert.equal(target.client.query(input('behind-write')).request_sent, false);
  } finally { gate.resolve(); target.client.close(); }
});

test('resume mismatched session, unknown response IDs and prompt missing receipt never redirect', async () => {
  const target = await handshake(harness());
  try {
    const original = input('empty-response');
    const result = target.client.deliver(original);
    await tick();
    target.reply({ id: 'unknown-rpc-id' }, { messageId: 'unrelated' });
    assert.equal(target.client.query(original).outcome, 'unknown');
    target.reply(target.wire[2], {});
    assert.equal((await result).reason, 'prompt_receipt_missing');
    assert.equal(target.client.query(original).request_sent, true);
  } finally { target.client.close(); }
  const mismatch = harness();
  const init = mismatch.client.initialize();
  await tick();
  mismatch.reply(mismatch.wire[0], { protocolVersion: 2, agentCapabilities });
  await init;
  const attach = mismatch.client.attach();
  await tick();
  mismatch.reply(mismatch.wire[1], { sessionId: 'fixture-wrong-session' });
  assert.equal((await attach).outcome, 'unknown');
  assert.equal(mismatch.client.describe().closed, true);
  assert.equal(mismatch.wire.length, 2);
});

test('close during awaited pre-write hook keeps the operation unsent and cannot resume shared work', async () => {
  const target = await handshake(harness());
  const gate = deferred();
  const original = input('close-before-write', { onRequestStarted: () => gate.promise });
  const result = target.client.deliver(original);
  await tick();
  target.client.close();
  assert.equal((await result).outcome, 'failed_before_send');
  assert.equal((await result).request_sent, false);
  assertIdentity(target.client.query(original), original, target.client.describe());
  gate.resolve();
  await tick();
  target.client.close();
  assert.equal(target.wire.length, 2);
  assert.equal(target.client.feedLine(null).status, 'closed');
});

test('queue echo and direct receipt remain distinct; positive echo survives a late RPC error', async () => {
  const target = await handshake(harness());
  try {
    const original = input('queue-echo', { policy: 'when_idle' });
    const result = target.client.deliver(original);
    await tick();
    target.echo(original.message_id);
    assert.equal((await result).evidence.kind, 'queue_echo');
    target.error(target.wire[2]);
    assert.equal(target.client.query(original).outcome, 'accepted');
    assert.equal(target.client.query(original).evidence.kind, 'queue_echo');
    assert.equal(target.client.query(original).evidence.turn_complete, false);
  } finally { target.client.close(); }
});

test('Core maximum legal bodies plus provenance headers and sixfold JSON escaping fit bounded defaults', async () => {
  const coreRoot = new URL('../src/', import.meta.url).href;
  const { normalizeSendInput, normalizeTarget } = await import(`${coreRoot}contracts.mjs`);
  const { renderHostMessage } = await import(`${coreRoot}adapters/host-message.mjs`);
  const target = normalizeTarget({ machine_id: 'fixture', host: 'windsurf', surface: 'desktop', conversation_id: binding.sessionId, binding_id: 'fixture-binding', binding_generation: 1, adapter_id: 'fixture-wsf', capabilities: { next_model_boundary: true } });
  const caller = { machine_id: 'fixture', host: 'codex', surface: 'desktop', conversation_id: 'fixture-caller' };
  const principal = { id: 'fixture-principal', identity: caller, allowed_targets: [target.binding_id] };
  const harnessTarget = await handshake(harness());
  const measurements = [];
  try {
    for (const [name, text] of [['normal_70000', 'x'.repeat(70000)], ['maximum_262144', 'x'.repeat(262144)], ['nul_262144', '\u0000'.repeat(262144)]]) {
      const envelope = normalizeSendInput({ caller, origin: { kind: 'agent_message', channel: 'codex', source_ref: 'fixture-caller' }, target: { machine_id: target.machine_id, host: target.host, surface: target.surface, conversation_id: target.conversation_id, binding_id: target.binding_id, binding_generation: 1 }, dedupe_key: name, text, expires_at: '2026-11-18T00:00:00Z' }, principal, target);
      const original = input(name, { text: renderHostMessage({ message: { message_id: `fixture-message-${name}`, envelope }, delivery: { delivery_id: `fixture-delivery-${name}` } }) });
      const delivered = harnessTarget.client.deliver(original);
      await tick();
      const frame = harnessTarget.wire.at(-1);
      assert.equal(frame.method, 'session/prompt');
      assert.equal(frame.params.prompt[0].text, original.text);
      assert.ok(Buffer.byteLength(original.text) <= 270336);
      const frameBytes = Buffer.byteLength(JSON.stringify(frame) + '\n');
      assert.ok(frameBytes <= 2097152);
      if (name === 'nul_262144') assert.ok(frameBytes > 1572864);
      measurements.push({ name, body_bytes: Buffer.byteLength(text), rendered_bytes: Buffer.byteLength(original.text), frame_bytes: frameBytes });
      harnessTarget.reply(frame, { messageId: `native-${name}` });
      assert.equal((await delivered).outcome, 'accepted');
    }
    assert.equal((await harnessTarget.client.deliver(input('new-text-limit', { text: 'x'.repeat(270337) }))).reason, 'text_budget');
    assert.throws(() => createDevinSessionClient({ ...binding, sendLine: () => {}, limits: { maxTextBytes: 270337 } }), /Invalid maxTextBytes/u);
    assert.throws(() => createDevinSessionClient({ ...binding, sendLine: () => {}, limits: { maxFrameBytes: 2097153 } }), /Invalid maxFrameBytes/u);
    console.log(`CORE_BUDGET_BOUNDARIES ${JSON.stringify(measurements)}`);
  } finally { harnessTarget.client.close(); }
});

test('264137-byte synthetic native metadata fits frame headroom; larger than 2 MiB is still rejected', async () => {
  const target = await handshake(harness());
  try {
    const frame = { jsonrpc: '2.0', method: 'session/update', params: { sessionId: binding.sessionId, update: { sessionUpdate: 'session_info_update', _meta: { info: '' } } } };
    frame.params.update._meta.info = 'x'.repeat(264137 - Buffer.byteLength(JSON.stringify(frame)));
    const line = JSON.stringify(frame);
    assert.equal(Buffer.byteLength(line), 264137);
    assert.equal(target.client.feedLine(line).status, 'ignored_notification');
    assert.equal(target.client.describe().ready, true);
    assert.equal(target.client.feedLine('x'.repeat(2097153)).reason, 'frame_budget_or_type');
    assert.equal(target.client.describe().closed, true);
    console.log('CORE_METADATA_BOUNDARY {"accepted_frame_bytes":264137,"rejected_frame_bytes":2097153}');
  } finally { target.client.close(); }
});
