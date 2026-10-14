import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createModelObserver } from '../src/model-observer.mjs';

async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'model-observer-'));
  t.after(async () => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'observations.jsonl');
  const statusPath = path.join(directory, 'runtime.json');
  const producerInstance = randomUUID();
  return { directory, filePath, statusPath, producerInstance, observer: createModelObserver({ filePath, statusPath, producerInstance, heartbeatMs: 20, ...options }) };
}

function observation(overrides = {}) {
  return {
    request_id: randomUUID(), upstream_attempt: 1, native_attempt: null,
    endpoint: 'responses', protocol: 'sse', phase: 'response.completed',
    observation_source: 'upstream', request_sent: true, outcome: 'completed',
    proxy_input_model: 'gpt-6-sol', forwarded_model: 'gpt-6-sol',
    upstream_response_model: 'gpt-6-sol', upstream_header_model: null,
    ...overrides,
  };
}

async function lines(filePath) {
  return (await fs.readFile(filePath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
}

async function until(predicate, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('condition not reached');
}

test('whitelist copies only v2 scalars and never private payloads', async (t) => {
  const { filePath, statusPath, producerInstance, observer } = await fixture(t);
  const record = observation({
    body: 'PRIVATE_BODY', raw_header: 'PRIVATE_HEADER', authorization: 'PRIVATE_TOKEN',
    account_id: 'PRIVATE_ACCOUNT', thread_id: 'PRIVATE_THREAD', turn_id: 'PRIVATE_TURN',
    upstream_response_model: 'invalid model SECRET', upstream_header_model: 'model-B',
  });
  assert.equal(observer.observe(record), true);
  await observer.flush();
  const content = await fs.readFile(filePath, 'utf8');
  for (const secret of ['PRIVATE_BODY', 'PRIVATE_HEADER', 'PRIVATE_TOKEN', 'PRIVATE_ACCOUNT', 'PRIVATE_THREAD', 'PRIVATE_TURN', 'invalid model SECRET']) {
    assert.equal(content.includes(secret), false);
  }
  const event = (await lines(filePath)).find((entry) => entry.type === 'model_observation');
  assert.equal(event.schema_version, 2);
  assert.equal(event.producer_instance, producerInstance);
  assert.equal(event.invalid_fields, 1);
  assert.equal(event.upstream_response_model, undefined);
  assert.equal(event.upstream_header_model, 'model-B');
  assert.equal(event.at.endsWith('Z'), true);
  const runtime = JSON.parse(await fs.readFile(statusPath, 'utf8'));
  assert.equal(runtime.write_errors, 0);
  assert.equal(runtime.dropped, 0);
  assert.equal(runtime.queue_depth, 0);
  assert.equal(await observer.close(), true);
});

test('synthetic and local records cannot assert upstream identity', async (t) => {
  const { filePath, observer } = await fixture(t);
  observer.observe(observation({ observation_source: 'proxy_synthetic', phase: 'proxy.synthetic' }));
  observer.observe(observation({ observation_source: 'proxy_lifecycle', upstream_response_model: 'model-B' }));
  await observer.flush();
  const events = (await lines(filePath)).filter((entry) => entry.type === 'model_observation');
  assert.equal(events[0].upstream_response_model, undefined);
  assert.equal(events[0].forwarded_model, undefined);
  assert.equal(events[1].upstream_response_model, undefined);
  await observer.close();
});

test('invalid structural fields and hostile getters never escape observe', async (t) => {
  const { filePath, observer } = await fixture(t);
  assert.equal(observer.observe(observation({ request_id: 'secret-id' })), false);
  let coerced = false;
  assert.equal(observer.observe(observation({ request_id: { toString() { coerced = true; return randomUUID(); } } })), false);
  assert.equal(coerced, false);
  assert.equal(observer.observe(Object.defineProperty({}, 'request_id', { get() { throw new Error('secret'); } })), false);
  assert.equal(observer.status().dropped, 3);
  assert.equal(observer.status().last_error_code, 'INVALID_RECORD');
  assert.equal(observer.observe(observation()), true);
  await observer.flush();
  assert.equal((await lines(filePath)).filter((entry) => entry.type === 'model_watch_coverage').length, 0);
  assert.equal(observer.status().capture_enabled, false);
  await observer.close();
});

test('slow event write does not block independent atomic status or claim coverage', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let entered = false;
  const adapter = {
    ...fs,
    appendFile: async (filePath, ...args) => {
      entered = true;
      await gate;
      return fs.appendFile(filePath, ...args);
    },
  };
  const { filePath, statusPath, observer } = await fixture(t, { fsAdapter: adapter });
  assert.equal(observer.observe(observation()), true);
  await until(() => entered);
  const runtime = await until(async () => {
    try {
      const value = JSON.parse(await fs.readFile(statusPath, 'utf8'));
      return value.queue_depth === 1 ? value : null;
    } catch { return null; }
  });
  assert.equal(runtime.coverage_end, null);
  assert.equal(runtime.running, true);
  await assert.rejects(fs.readFile(filePath));
  release();
  await observer.flush();
  assert.ok(observer.status().coverage_end);
  await observer.close();
});

test('coverage end never advances past an earlier flushed event while another event is pending', async (t) => {
  let release;
  let secondEntered = false;
  let eventWrites = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  const adapter = {
    ...fs,
    appendFile: async (filePath, data, encoding) => {
      if (JSON.parse(data).type === 'model_observation' && ++eventWrites === 2) {
        secondEntered = true;
        await gate;
      }
      return fs.appendFile(filePath, data, encoding);
    },
  };
  const { statusPath, observer } = await fixture(t, { fsAdapter: adapter });
  observer.observe(observation());
  await observer.flush();
  const before = observer.status().coverage_end;
  observer.observe(observation());
  await until(() => secondEntered);
  const pending = await until(async () => {
    const value = JSON.parse(await fs.readFile(statusPath, 'utf8'));
    return value.queue_depth === 1 ? value : null;
  });
  assert.equal(pending.coverage_end, before);
  release();
  await observer.flush();
  assert.ok(observer.status().coverage_end >= (before ?? ''));
  await observer.close();
});

test('bounded queue drops storm records and retains sticky loss after recovery', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const adapter = { ...fs, appendFile: async (filePath, ...args) => { await gate; return fs.appendFile(filePath, ...args); } };
  const { filePath, observer } = await fixture(t, { fsAdapter: adapter, maxQueue: 2 });
  let accepted = 0;
  for (let index = 0; index < 100; index += 1) accepted += Number(observer.observe(observation()));
  assert.equal(accepted, 2);
  assert.equal(observer.status().dropped, 98);
  assert.equal(observer.status().last_error_code, 'QUEUE_FULL');
  release();
  await observer.flush();
  assert.equal((await lines(filePath)).filter((entry) => entry.type === 'model_observation').length, 2);
  assert.equal(observer.status().dropped, 98);
  assert.equal(observer.status().coverage_end, null);
  await observer.close();
});

test('write refusal stays unhealthy even when later writes succeed', async (t) => {
  let fail = true;
  const adapter = {
    ...fs,
    appendFile: async (filePath, ...args) => {
      if (fail) {
        fail = false;
        throw Object.assign(new Error('PRIVATE_PATH'), { code: 'EACCES' });
      }
      return fs.appendFile(filePath, ...args);
    },
  };
  const { filePath, statusPath, observer } = await fixture(t, { fsAdapter: adapter });
  observer.observe(observation());
  await observer.flush();
  observer.observe(observation());
  await observer.flush();
  assert.equal((await lines(filePath)).filter((entry) => entry.type === 'model_observation').length, 1);
  assert.equal(observer.status().dropped, 1);
  assert.equal(observer.status().write_errors, 1);
  assert.equal(observer.status().coverage_end, null);
  assert.equal(observer.status().capture_enabled, false);
  assert.equal((await fs.readFile(statusPath, 'utf8')).includes('PRIVATE_PATH'), false);
  await observer.close();
});

test('status refusal recovers atomically but remains sticky', async (t) => {
  let fail = true;
  const adapter = {
    ...fs,
    writeFile: async (filePath, ...args) => {
      if (fail) {
        fail = false;
        throw Object.assign(new Error('PRIVATE_STATUS'), { code: 'ENOSPC' });
      }
      return fs.writeFile(filePath, ...args);
    },
  };
  const { statusPath, observer } = await fixture(t, { fsAdapter: adapter });
  const runtime = await until(async () => {
    try { return JSON.parse(await fs.readFile(statusPath, 'utf8')); }
    catch { return null; }
  });
  assert.equal(runtime.write_errors, 1);
  assert.equal(runtime.capture_enabled, false);
  assert.equal(runtime.last_error_code, 'ENOSPC');
  assert.equal((await fs.readFile(statusPath, 'utf8')).includes('PRIVATE_STATUS'), false);
  await observer.close();
});

test('rotation keeps bounded active file and numbered history', async (t) => {
  const { filePath, observer } = await fixture(t, { maxFileBytes: 600, rotations: 2 });
  for (let index = 0; index < 12; index += 1) observer.observe(observation());
  await observer.flush();
  const names = (await fs.readdir(path.dirname(filePath))).filter((name) => name.startsWith(path.basename(filePath)));
  assert.ok(names.includes('observations.jsonl.1'));
  assert.ok(names.includes('observations.jsonl.2'));
  assert.equal(names.includes('observations.jsonl.3'), false);
  for (const name of names) await lines(path.join(path.dirname(filePath), name));
  await observer.close();
});

test('close returns on hung event write and publishes unhealthy status', async (t) => {
  let release;
  let entered = false;
  const gate = new Promise((resolve) => { release = resolve; });
  const adapter = { ...fs, appendFile: async (filePath, ...args) => { entered = true; await gate; return fs.appendFile(filePath, ...args); } };
  const { statusPath, observer } = await fixture(t, { fsAdapter: adapter });
  observer.observe(observation());
  await until(() => entered);
  const start = Date.now();
  assert.equal(await observer.close(), false);
  assert.ok(Date.now() - start < 2200);
  const runtime = await until(async () => {
    try {
      const value = JSON.parse(await fs.readFile(statusPath, 'utf8'));
      return value.last_error_code === 'WRITE_TIMEOUT' ? value : null;
    } catch { return null; }
  });
  assert.equal(runtime.running, false);
  assert.equal(runtime.capture_enabled, false);
  assert.ok(runtime.write_errors >= 1);
  assert.equal(runtime.dropped, 0);
  release();
  await observer.flush();
});
