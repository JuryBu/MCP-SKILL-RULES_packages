import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const nativeRequire = createRequire(import.meta.url);
const outputLimit = 1024 * 1024;
const compiledModules = new Map(['model-bridge', 'request-context'].map(name => [name,
  ts.transpileModule(readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8'), {
    fileName: `${name}.ts`,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText,
]));

class FakeClock {
  now = 1000;
  timers = new Map();

  setTimeout = (callback, delay = 0) => {
    const timer = { at: this.now + Math.max(0, delay), callback, unref() { return this; } };
    this.timers.set(timer, timer);
    return timer;
  };

  clearTimeout = timer => { this.timers.delete(timer); };

  advance(duration) {
    const target = this.now + duration;
    while (true) {
      const next = [...this.timers.values()].filter(timer => timer.at <= target).sort((left, right) => left.at - right.at)[0];
      if (!next) break;
      this.now = next.at;
      this.timers.delete(next);
      next.callback();
    }
    this.now = target;
  }
}

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = new EventEmitter();
  input = [];
  kills = [];
  closed = false;

  constructor() {
    super();
    this.stdin.end = (...args) => { this.input.push(args); };
  }

  start() { this.emit('spawn'); }
  output(value) { this.stdout.emit('data', Buffer.isBuffer(value) ? value : Buffer.from(value)); }
  errorOutput(value) { this.stderr.emit('data', Buffer.isBuffer(value) ? value : Buffer.from(value)); }
  close(code = 0) { this.closed = true; this.emit('close', code); }
  kill(signal) { this.kills.push(signal); return true; }
  unref() { return this; }
}

function agyResult(overrides = {}) {
  return {
    text: null, transport: 'app-ls', model: 'MODEL_PLACEHOLDER_M318', outcome: 'not-started',
    submitted: false, safeToFallback: false, error: 'fixture unavailable', ...overrides,
  };
}

function codexText(text, terminal = true) {
  return [
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } }),
    ...(terminal ? [JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } })] : []),
  ].join('\n') + '\n';
}

function claudeText(text, overrides = {}) {
  return JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: text, ...overrides });
}

const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture(context, options = {}) {
  const clock = new FakeClock();
  const calls = [];
  const children = [];
  const execCalls = [];
  const fsEvents = [];
  const files = new Map((options.files ?? []).map(file => [file, { kind: 'file', content: '' }]));
  const plans = [...(options.plans ?? [])];
  const env = { PATH: '', ...options.env };
  const constants = {
    AI_SUMMARY_ANTIGRAVITY_LABEL: 'Antigravity fixture',
    AI_SUMMARY_CODEX_LABEL: 'Codex fixture',
    AI_SUMMARY_CLAUDE_CODE_LABEL: 'Claude Code fixture',
    AI_SUMMARY_MAX_INPUT: 12000,
    AI_SUMMARY_PROMPT_TEMPLATE: '{pageTitle}\n{url}\n{content}',
    CODEX_AI_SUMMARY_MODEL: 'fixture-codex-model',
    CODEX_AI_SUMMARY_REASONING_EFFORT: 'max',
    CODEX_AI_SUMMARY_SPEED_TIER: 'standard',
    CODEX_AI_SUMMARY_TIMEOUT: 45000,
    CLAUDE_CODE_AI_SUMMARY_MODEL: 'fixture-claude-model',
    CLAUDE_CODE_AI_SUMMARY_EFFORT: 'max',
    CLAUDE_CODE_AI_SUMMARY_TIMEOUT: 40000,
    CLAUDE_CODE_AI_SUMMARY_BACKGROUND_TIMEOUT: 240000,
  };
  const mockedFs = {
    existsSync(filename) { fsEvents.push(['exists', filename]); return files.has(filename); },
    statSync(filename) {
      fsEvents.push(['stat', filename]);
      const entry = files.get(filename);
      if (!entry || entry.kind === 'unreadable') throw Object.assign(new Error('fixture missing'), { code: 'ENOENT' });
      return { isFile: () => entry.kind === 'file' };
    },
    writeFileSync(filename, content, encoding) {
      fsEvents.push(['write', filename, content, encoding]);
      files.set(filename, { kind: 'file', content });
    },
    unlinkSync(filename) { fsEvents.push(['unlink', filename]); files.delete(filename); },
  };
  const childProcess = {
    spawn(command, args, spawnOptions) {
      const provider = command === 'claude' ? 'claude-code' : command === 'codex' ? 'codex' : 'unexpected';
      assert.notEqual(provider, 'unexpected', `Unexpected mocked command: ${command}`);
      const call = { provider, command, args, options: spawnOptions, at: clock.now };
      calls.push(call);
      const child = new FakeChild();
      children.push(child);
      call.child = child;
      const plan = plans.shift();
      if (plan) queueMicrotask(() => plan(child, call));
      return child;
    },
    execFile(...args) {
      execCalls.push(args);
      throw new Error('Version probes and real executables are forbidden in this fixture');
    },
  };
  const moduleCache = new Map();
  const sandbox = vm.createContext({
    Buffer, AbortController, URL,
    process: { env, platform: 'linux', cwd: () => '/fixture/workspace' },
    performance: { now: () => clock.now },
    Date: class extends Date { static now() { return 1800000000000 + clock.now; } },
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    console: { error() {}, log() {}, warn() {} },
  });
  const mockedRequire = specifier => {
    if (specifier === 'child_process' || specifier === 'node:child_process') return childProcess;
    if (specifier === 'fs' || specifier === 'node:fs') return mockedFs;
    if (specifier === 'os') return { tmpdir: () => '/fixture/tmp' };
    if (specifier === 'crypto') return { randomUUID: () => 'fixture-uuid' };
    if (specifier === 'path') return path;
    if (['util', 'node:util', 'node:async_hooks', 'string_decoder', 'node:string_decoder'].includes(specifier)) return nativeRequire(specifier);
    if (specifier === 'node:perf_hooks') return { performance: { now: () => clock.now } };
    if (specifier === './constants.js') return constants;
    if (specifier === './request-context.js') return loadModule('request-context');
    if (specifier === './ls-client.js') return {
      async callAntigravity(request) {
        calls.push({ provider: 'antigravity', request, at: clock.now });
        return options.agy ? options.agy(request, clock) : agyResult();
      },
      isAntigravityAvailable() { throw new Error('Unexpected availability probe'); },
    };
    throw new Error(`Unmocked dependency is forbidden: ${specifier}`);
  };
  function loadModule(name) {
    if (moduleCache.has(name)) return moduleCache.get(name).exports;
    const loaded = { exports: {} };
    moduleCache.set(name, loaded);
    const wrapper = new vm.Script(`(function(require, module, exports) {\n${compiledModules.get(name)}\n})`, { filename: `${name}.fixture.cjs` }).runInContext(sandbox);
    wrapper(mockedRequire, loaded, loaded.exports);
    return loaded.exports;
  }
  context.after(() => {
    assert.equal(execCalls.length, 0, 'Generation must never run a version probe');
    assert.equal(clock.timers.size, 0, 'Model and cleanup timers must be released');
    assert.equal(plans.length, 0, 'Every configured process event plan must be exercised');
  });
  return {
    bridge: loadModule('model-bridge'), requestContext: loadModule('request-context'),
    clock, calls, children, files, fsEvents, env, constants,
  };
}

function assertFailure(result, { outcome, submitted = false, unknown = outcome === 'cancelled' && submitted, fallback = false }) {
  assert.equal(result.text, null);
  assert.equal(result.chainUsed, null);
  assert.equal(result.providerLabel, null);
  assert.equal(result.outcome, outcome);
  assert.equal(result.submitted, submitted);
  assert.equal(result.outcomeUnknown ?? false, unknown);
  assert.equal(result.fallbackAllowed, fallback);
  assert.equal(typeof result.error, 'string');
}

function noExecutable() {
  return child => child.emit('error', Object.assign(new Error('fixture ENOENT'), { code: 'ENOENT' }));
}

for (const outcome of ['quota-exhausted', 'auth-required', 'rejected', 'unsupported', 'cancelled', 'invalid-response', 'timeout-unknown', 'transport-unknown']) {
  test(`auto does not repeat an LS ${outcome} on another model or platform`, async context => {
    const submitted = !['rejected', 'unsupported'].includes(outcome);
    const harness = fixture(context, {
      env: { WEB_FETCHER_CLAUDE_CODE_AUTO_FALLBACK: '1' },
      agy: () => agyResult({ outcome, submitted, error: outcome === 'transport-unknown' ? 'LS ECONNRESET after SendUserCascadeMessage' : outcome }),
    });
    const result = await harness.bridge.generateModelText({ prompt: 'one submission only', model: 'M318' });
    assertFailure(result, { outcome, submitted, unknown: submitted && ['invalid-response', 'timeout-unknown', 'transport-unknown', 'cancelled'].includes(outcome) });
    assert.deepEqual(harness.calls.map(call => call.provider), ['antigravity']);
    assert.equal(harness.calls[0].request.model, 'M318');
    assert.equal(result.transport, 'app-ls');
    assert.equal(result.modelUsed, 'MODEL_PLACEHOLDER_M318');
  });
}

for (const safeToFallback of [undefined, false, 'true', 1]) {
  test(`auto requires literal safeToFallback=true, received ${String(safeToFallback)}`, async context => {
    const harness = fixture(context, { agy: () => agyResult({ safeToFallback }) });
    const result = await harness.bridge.generateModelText({ prompt: 'strict fallback gate' });
    assert.equal(result.text, null);
    assert.equal(harness.calls.length, 1);
    assert.equal(harness.children.length, 0);
  });
}

test('safe auto fallback tries AGY then Codex and stops on success', async context => {
  const harness = fixture(context, {
    env: { WEB_FETCHER_CLAUDE_CODE_AUTO_FALLBACK: '1' },
    agy: () => agyResult({ safeToFallback: true }),
    plans: [child => { child.start(); child.output(codexText('Codex answer')); child.close(); }],
  });
  const result = await harness.bridge.generateModelText({ prompt: 'fallback order' });
  assert.equal(result.text, 'Codex answer');
  assert.equal(result.chainUsed, 'codex');
  assert.equal(result.outcome, 'success');
  assert.equal(result.submitted, true);
  assert.equal(result.fallbackAllowed, false);
  assert.deepEqual(harness.calls.map(call => call.provider), ['antigravity', 'codex']);
});

for (const flag of [undefined, '0', 'true', '1']) {
  test(`Claude Code follows AGY and Codex only with opt-in=1 (${String(flag)})`, async context => {
    const harness = fixture(context, {
      env: flag === undefined ? {} : { WEB_FETCHER_CLAUDE_CODE_AUTO_FALLBACK: flag },
      agy: () => agyResult({ safeToFallback: true }),
      plans: [noExecutable(), ...(flag === '1' ? [child => { child.start(); child.output(claudeText('CC answer')); child.close(); }] : [])],
    });
    const result = await harness.bridge.generateModelText({ prompt: 'opt in' });
    assert.deepEqual(harness.calls.map(call => call.provider), flag === '1' ? ['antigravity', 'codex', 'claude-code'] : ['antigravity', 'codex']);
    if (flag === '1') {
      assert.equal(result.text, 'CC answer');
      assert.equal(result.chainUsed, 'claude-code');
    } else {
      assertFailure(result, { outcome: 'not-started', fallback: true });
      assert.match(result.error, /antigravity.*codex/s);
    }
  });
}

for (const chain of ['antigravity', 'codex', 'claude-code']) {
  test(`explicit ${chain} never crosses platforms even after a safe failure`, async context => {
    const harness = fixture(context, {
      env: { WEB_FETCHER_CLAUDE_CODE_AUTO_FALLBACK: '1' },
      agy: () => agyResult({ safeToFallback: true }), plans: chain === 'antigravity' ? [] : [noExecutable()],
    });
    assertFailure(await harness.bridge.generateModelText({ prompt: 'explicit', chain }), { outcome: 'not-started', fallback: true });
    assert.deepEqual(harness.calls.map(call => call.provider), [chain]);
  });
}

test('an unexpected LS rejection is outcome-unknown and never retried', async context => {
  const harness = fixture(context, { agy() { throw new Error('fixture disconnected after submission'); } });
  assertFailure(await harness.bridge.generateModelText({ prompt: 'unknown' }), { outcome: 'transport-unknown', submitted: true, unknown: true });
  assert.equal(harness.calls.length, 1);
});

test('AGY receives both image paths, schema, model and the original signal with the tightest deadline', async context => {
  const imagePaths = ['C:\\fixture files\\截图 01.png', 'C:\\fixture files\\second.png'];
  const schema = { type: 'object', properties: { answer: { type: 'string' } } };
  const controller = new AbortController();
  const harness = fixture(context, { files: imagePaths, agy: () => agyResult({ text: 'image answer', outcome: 'success', submitted: true }) });
  const result = await harness.requestContext.runWithRequestContext({ timeoutMs: 80 }, () => harness.bridge.generateModelText({
    prompt: 'inspect both images', chain: 'antigravity', model: 'M318', imagePaths, schema, signal: controller.signal, timeoutMs: 100, deadline: 1090,
  }));
  assert.equal(result.text, 'image answer');
  const request = harness.calls[0].request;
  assert.equal(request.imagePaths, imagePaths);
  assert.equal(request.schema, schema);
  assert.equal(request.signal, controller.signal);
  assert.equal(request.model, 'M318');
  assert.equal(request.deadline, 1080);
});

for (const chain of ['auto', 'antigravity', 'codex', 'claude-code']) {
  for (const kind of ['missing', 'directory', 'unreadable']) {
    test(`${chain} rejects a ${kind} attachment before any provider call`, async context => {
      const harness = fixture(context, { files: ['/fixture/valid.png'] });
      if (kind !== 'missing') harness.files.set('/fixture/bad.png', { kind });
      const result = await harness.bridge.generateModelText({ prompt: 'no attachment loss', chain, imagePaths: ['/fixture/valid.png', '/fixture/bad.png'] });
      assertFailure(result, { outcome: 'rejected' });
      assert.equal(harness.calls.length, 0);
      assert.equal(harness.fsEvents.some(event => event[0] === 'write'), false);
    });
  }
}

test('Codex transports every image and schema without writing a real temporary file', async context => {
  const images = ['C:\\fixture files\\截图 01.png', 'C:\\fixture files\\two.png'];
  const schema = { type: 'object', required: ['answer'] };
  const harness = fixture(context, { files: images });
  const pending = harness.bridge.generateModelText({ prompt: 'stdin only', chain: 'codex', imagePaths: images, schema, schemaName: '../unsafe name' });
  const call = harness.calls[0];
  assert.deepEqual(Array.from(call.args).filter((value, index) => call.args[index - 1] === '-i'), images);
  const schemaPath = call.args[call.args.indexOf('--output-schema') + 1];
  assert.equal(path.basename(schemaPath), 'mcp-web-fetcher----unsafe-name-schema-fixture-uuid.json');
  assert.deepEqual(JSON.parse(harness.files.get(schemaPath).content), schema);
  assert.equal(call.args.at(-1), '-');
  assert.equal(call.args.includes('stdin only'), false);
  assert.equal(call.args[call.args.indexOf('--sandbox') + 1], 'read-only');
  assert.ok(call.args.includes('--ignore-user-config'));
  assert.ok(call.args.includes('--ignore-rules'));
  harness.children[0].start();
  harness.children[0].output(codexText('image answer'));
  harness.children[0].close();
  assert.equal((await pending).text, 'image answer');
  assert.equal(harness.files.has(schemaPath), false);
  assert.equal(harness.fsEvents.filter(event => event[0] === 'unlink').length, 1);
});

test('Claude Code reports images unsupported without spawning or silently dropping them', async context => {
  const harness = fixture(context, { files: ['/fixture/image.png'] });
  assertFailure(await harness.bridge.generateModelText({ prompt: 'image', chain: 'claude-code', imagePaths: ['/fixture/image.png'] }), { outcome: 'unsupported' });
  assert.equal(harness.calls.length, 0);
});

for (const reason of ['request-aborted', 'context-aborted', 'timeout-zero', 'request-deadline', 'context-deadline']) {
  test(`${reason} stops before every provider and before the response mock`, async context => {
    const controller = new AbortController();
    const harness = fixture(context, { env: { WEB_FETCHER_MOCK_MODEL_RESPONSE: 'must not escape cancellation' } });
    const request = { prompt: 'cancel early' };
    const requestOptions = { timeoutMs: 1000 };
    if (reason === 'request-aborted' || reason === 'context-aborted') controller.abort();
    if (reason === 'request-aborted') request.signal = controller.signal;
    if (reason === 'context-aborted') requestOptions.signal = controller.signal;
    if (reason === 'timeout-zero') request.timeoutMs = 0;
    if (reason === 'request-deadline') request.deadline = harness.clock.now;
    if (reason === 'context-deadline') requestOptions.deadline = harness.clock.now;
    const result = await harness.requestContext.runWithRequestContext(requestOptions, () => harness.bridge.generateModelText(request));
    assertFailure(result, { outcome: reason.endsWith('aborted') ? 'cancelled' : 'not-started' });
    assert.equal(harness.calls.length, 0);
    assert.equal(harness.fsEvents.length, 0);
  });
}

test('all candidates share one deadline and receive only the remaining time', async context => {
  const harness = fixture(context, {
    env: { WEB_FETCHER_CLAUDE_CODE_AUTO_FALLBACK: '1' },
    agy: (_request, clock) => { clock.advance(35); return agyResult({ safeToFallback: true }); },
    plans: [child => {
      assert.deepEqual([...harness.clock.timers.values()].map(timer => timer.at), [1080]);
      harness.clock.advance(20);
      noExecutable()(child);
    }],
  });
  let settled = false;
  const pending = harness.bridge.generateModelText({ prompt: 'one budget', timeoutMs: 80 }).then(result => { settled = true; return result; });
  await flush();
  assert.deepEqual(harness.calls.map(call => [call.provider, call.at]), [['antigravity', 1000], ['codex', 1035], ['claude-code', 1055]]);
  assert.equal(harness.calls[0].request.deadline, 1080);
  assert.deepEqual([...harness.clock.timers.values()].map(timer => timer.at), [1080]);
  const child = harness.children[1];
  child.start();
  harness.clock.advance(24);
  await flush();
  assert.equal(child.kills.length, 0);
  assert.equal(settled, false);
  harness.clock.advance(1);
  await flush();
  assert.deepEqual(child.kills, ['SIGKILL']);
  assert.equal(settled, false, 'Timeout must wait for close or the bounded cleanup confirmation');
  child.close();
  assertFailure(await pending, { outcome: 'timeout-unknown', submitted: true, unknown: true });
});

test('deadline exhausted by AGY prevents the next candidate from starting', async context => {
  const harness = fixture(context, { agy: (_request, clock) => { clock.advance(50); return agyResult({ safeToFallback: true }); } });
  assertFailure(await harness.bridge.generateModelText({ prompt: 'already spent', timeoutMs: 50 }), { outcome: 'not-started' });
  assert.deepEqual(harness.calls.map(call => call.provider), ['antigravity']);
});

test('a fresh background context uses its own deadline and does not inherit the cancelled callers signal', async context => {
  const controller = new AbortController();
  const harness = fixture(context, { agy: () => agyResult({ text: 'background answer', outcome: 'success', submitted: true }) });
  const result = await harness.requestContext.runWithRequestContext({ ownerId: 'fixture-owner', signal: controller.signal, timeoutMs: 5 }, async () => {
    controller.abort();
    return harness.requestContext.runWithRequestContext({ ownerId: 'fixture-owner', timeoutMs: 2000 }, () => harness.bridge.generateModelText({ prompt: 'detached background', timeoutMs: 1000 }));
  });
  assert.equal(result.text, 'background answer');
  assert.equal(harness.calls[0].request.signal, undefined);
  assert.equal(harness.calls[0].request.deadline, 2000);
});

test('foreground context cancellation is forwarded to AGY without substitution', async context => {
  const controller = new AbortController();
  const harness = fixture(context, { agy: request => { assert.equal(request.signal, controller.signal); controller.abort(); return agyResult({ outcome: 'cancelled', submitted: true }); } });
  const result = await harness.requestContext.runWithRequestContext({ signal: controller.signal, timeoutMs: 500 }, () => harness.bridge.generateModelText({ prompt: 'context signal' }));
  assertFailure(result, { outcome: 'cancelled', submitted: true });
  assert.equal(harness.calls.length, 1);
});

for (const chain of ['auto', 'antigravity', 'codex', 'claude-code']) {
  test(`the existing response mock stays local and preserves ${chain} attribution`, async context => {
    const harness = fixture(context, { env: { WEB_FETCHER_MOCK_MODEL_RESPONSE: '  mock text  ' } });
    const result = await harness.bridge.generateModelText({ prompt: 'mock', chain, imagePaths: ['/does/not/exist.png'] });
    assert.equal(result.text, '  mock text  ');
    assert.equal(result.chainUsed, chain === 'auto' ? 'antigravity' : chain);
    assert.equal(result.providerLabel, chain === 'codex' ? harness.constants.AI_SUMMARY_CODEX_LABEL : chain === 'claude-code' ? harness.constants.AI_SUMMARY_CLAUDE_CODE_LABEL : harness.constants.AI_SUMMARY_ANTIGRAVITY_LABEL);
    assert.equal(result.outcome, undefined);
    assert.equal(harness.calls.length, 0);
    assert.equal(harness.fsEvents.length, 0);
  });
}

test('an empty response mock is still an intentional mock, not a real-model trigger', async context => {
  const harness = fixture(context, { env: { WEB_FETCHER_MOCK_MODEL_RESPONSE: '' } });
  assert.equal((await harness.bridge.generateModelText({ prompt: 'empty mock' })).text, '');
  assert.equal(harness.calls.length, 0);
});

test('generateSummaryText also unwraps an existing JSON response mock locally', async context => {
  const harness = fixture(context, { env: { WEB_FETCHER_MOCK_MODEL_RESPONSE: '{"summary":"  mock summary  "}' } });
  const result = await harness.bridge.generateSummaryText('mock summary prompt', 'codex');
  assert.equal(result.text, 'mock summary');
  assert.equal(result.chainUsed, 'codex');
  assert.equal(harness.calls.length, 0);
});

for (const response of ['{"summary":"  中文摘要  "}', 'plain summary', '{"other":"preserved"}']) {
  test(`generateSummaryText unwraps only summary strings and preserves diagnostics (${response})`, async context => {
    const controller = new AbortController();
    const harness = fixture(context, { agy: () => agyResult({ text: response, outcome: 'success', submitted: true }) });
    const result = await harness.bridge.generateSummaryText('summary prompt', 'antigravity', 75, controller.signal);
    assert.equal(result.text, response.startsWith('{"summary"') ? '中文摘要' : response);
    assert.equal(result.transport, 'app-ls');
    assert.equal(result.modelUsed, 'MODEL_PLACEHOLDER_M318');
    assert.equal(result.outcome, 'success');
    assert.equal(result.submitted, true);
    assert.equal(result.fallbackAllowed, false);
    const request = harness.calls[0].request;
    assert.equal(request.signal, controller.signal);
    assert.equal(request.deadline, 1075);
    assert.deepEqual(Array.from(request.schema.required), ['summary']);
    assert.equal(request.schema.additionalProperties, false);
  });
}

test('generateSummaryText returns quota diagnostics without any fallback', async context => {
  const harness = fixture(context, { agy: () => agyResult({ outcome: 'quota-exhausted', error: 'fixture account quota' }) });
  assertFailure(await harness.bridge.generateSummaryText('summary'), { outcome: 'quota-exhausted' });
  assert.equal(harness.calls.length, 1);
});

for (const provider of ['codex', 'claude-code']) {
  const encode = provider === 'codex' ? codexText : claudeText;

  test(`${provider} writes stdin once after spawn and accepts a complete response only after close`, async context => {
    const harness = fixture(context);
    let settled = false;
    const pending = harness.bridge.generateModelText({ prompt: 'input\n中文 "quoted"', chain: provider }).then(result => { settled = true; return result; });
    const child = harness.children[0];
    assert.deepEqual(child.input, []);
    assert.equal(harness.calls[0].args.includes('input\n中文 "quoted"'), false);
    child.start();
    assert.deepEqual(child.input, [['input\n中文 "quoted"', 'utf-8']]);
    const response = encode('最终回答');
    child.output(response.slice(0, 9));
    child.output(response.slice(9));
    await flush();
    assert.equal(settled, false);
    child.close();
    const result = await pending;
    assert.equal(result.text, '最终回答');
    assert.equal(result.chainUsed, provider);
    assert.equal(result.outcome, 'success');
    assert.equal(result.submitted, true);
    assert.equal(result.fallbackAllowed, false);
    assert.equal(harness.calls[0].options.windowsHide, true);
    assert.deepEqual(Array.from(harness.calls[0].options.stdio), ['pipe', 'pipe', 'pipe']);
  });

  test(`${provider} rejects malformed output at exit zero without replay`, async context => {
    const harness = fixture(context);
    const pending = harness.bridge.generateModelText({ prompt: 'malformed', chain: provider });
    const child = harness.children[0];
    child.start(); child.output('{"broken":'); child.close();
    assertFailure(await pending, { outcome: 'invalid-response', submitted: true, unknown: true });
    assert.equal(harness.calls.length, 1);
  });

  test(`${provider} rejects a nonzero exit even if stdout contains usable text`, async context => {
    const harness = fixture(context);
    const pending = harness.bridge.generateModelText({ prompt: 'bad exit', chain: provider });
    const child = harness.children[0];
    child.start(); child.output(encode('must not succeed')); child.close(7);
    assertFailure(await pending, { outcome: 'transport-unknown', submitted: true, unknown: true });
    assert.match((await pending).error, /7/);
    assert.equal(harness.calls.length, 1);
  });

  for (const [stderr, outcome] of [['\u001b[31mquota exhausted\u001b[0m', 'quota-exhausted'], ['not logged in', 'auth-required']]) {
    test(`${provider} preserves ${outcome} and does not automatically resend`, async context => {
      const harness = fixture(context, {
        env: { WEB_FETCHER_CLAUDE_CODE_AUTO_FALLBACK: '1' }, agy: () => agyResult({ safeToFallback: true }),
      });
      const chain = provider === 'codex' ? 'auto' : 'claude-code';
      const pending = harness.bridge.generateModelText({ prompt: 'provider failure', chain });
      await flush();
      const child = harness.children[0];
      child.start();
      if (provider === 'claude-code') child.output(claudeText(stderr, { subtype: 'error_during_execution', is_error: true }));
      else child.errorOutput(stderr);
      child.close(1);
      assertFailure(await pending, { outcome, submitted: true });
      assert.equal(harness.children.length, 1);
    });
  }

  test(`${provider} accepts exactly the output byte limit`, async context => {
    const harness = fixture(context);
    const pending = harness.bridge.generateModelText({ prompt: 'bounded output', chain: provider });
    const child = harness.children[0];
    child.start();
    const response = Buffer.from(encode('limit answer'));
    child.output(Buffer.concat([response, Buffer.alloc(outputLimit - response.length, 32)]));
    child.close();
    assert.equal((await pending).text, 'limit answer');
    assert.equal(child.kills.length, 0);
  });

  test(`${provider} counts stdout plus stderr bytes and waits for close after exceeding the limit`, async context => {
    const harness = fixture(context);
    let settled = false;
    const pending = harness.bridge.generateModelText({ prompt: 'overflow', chain: provider }).then(result => { settled = true; return result; });
    const child = harness.children[0];
    child.start();
    child.errorOutput(Buffer.alloc(outputLimit / 2, 120));
    child.output(Buffer.alloc(outputLimit / 2 + 1, 120));
    await flush();
    assert.deepEqual(child.kills, ['SIGKILL']);
    assert.equal(settled, false);
    child.output(encode('late success must be ignored'));
    child.close();
    assertFailure(await pending, { outcome: 'invalid-response', submitted: true, unknown: true });
    assert.equal(harness.calls.length, 1);
  });

  for (const started of [false, true]) {
    test(`${provider} cancellation ${started ? 'after' : 'before'} spawn prevents late stdin and success`, async context => {
      const controller = new AbortController();
      const harness = fixture(context);
      let settled = false;
      const pending = harness.bridge.generateModelText({
        prompt: 'cancel me', chain: provider, signal: controller.signal,
        schema: provider === 'codex' ? { type: 'object' } : undefined,
      }).then(result => { settled = true; return result; });
      const child = harness.children[0];
      if (started) child.start();
      controller.abort();
      await flush();
      assert.equal(settled, false);
      assert.deepEqual(child.kills, ['SIGKILL']);
      if (!started) child.start();
      child.output(encode('late output'));
      child.close();
      assertFailure(await pending, { outcome: 'cancelled', submitted: started });
      assert.equal(child.input.length, started ? 1 : 0);
      assert.equal(harness.files.size, 0, 'Cancellation must release any Codex schema file');
      controller.abort();
      assert.equal(child.kills.length, 1);
    });
  }

  for (const started of [false, true]) {
    test(`${provider} deadline ${started ? 'after' : 'before'} spawn keeps submission diagnostics and never falls back`, async context => {
      const harness = fixture(context);
      const pending = harness.bridge.generateModelText({ prompt: 'deadline', chain: provider, timeoutMs: 20 });
      const child = harness.children[0];
      if (started) child.start();
      harness.clock.advance(20);
      assert.deepEqual(child.kills, ['SIGKILL']);
      if (!started) child.start();
      child.output(encode('too late')); child.close();
      assertFailure(await pending, { outcome: started ? 'timeout-unknown' : 'not-started', submitted: started, unknown: started });
      assert.equal(child.input.length, started ? 1 : 0);
      assert.equal(harness.calls.length, 1);
    });
  }

  test(`${provider} stdin errors are unknown outcomes and await process close`, async context => {
    const harness = fixture(context);
    const pending = harness.bridge.generateModelText({ prompt: 'broken stdin', chain: provider });
    const child = harness.children[0];
    child.start(); child.stdin.emit('error', Object.assign(new Error('fixture EPIPE'), { code: 'EPIPE' }));
    assert.deepEqual(child.kills, ['SIGKILL']);
    child.close();
    assertFailure(await pending, { outcome: 'transport-unknown', submitted: true, unknown: true });
  });

  test(`${provider} ENOENT after spawn is submitted and cannot become a safe fallback`, async context => {
    const harness = fixture(context);
    const pending = harness.bridge.generateModelText({ prompt: 'post-spawn error', chain: provider });
    const child = harness.children[0];
    child.start(); child.emit('error', Object.assign(new Error('fixture error'), { code: 'ENOENT' }));
    assertFailure(await pending, { outcome: 'transport-unknown', submitted: true, unknown: true });
    child.close();
  });

  test(`${provider} a child that never closes reports bounded cleanup uncertainty after cancellation`, async context => {
    const controller = new AbortController();
    const harness = fixture(context);
    const pending = harness.bridge.generateModelText({ prompt: 'no close', chain: provider, signal: controller.signal });
    const child = harness.children[0];
    child.start(); controller.abort(); harness.clock.advance(2000);
    const result = await pending;
    assertFailure(result, { outcome: 'cancelled', submitted: true });
    assert.match(result.error, /退出确认仍待完成/);
    child.close();
  });

  test(`${provider} preserves UTF-8 characters split across stdout buffers`, async context => {
    const harness = fixture(context);
    const pending = harness.bridge.generateModelText({ prompt: 'multibyte output', chain: provider });
    const child = harness.children[0];
    child.start();
    const response = Buffer.from(encode('中文回答'));
    const split = response.indexOf(Buffer.from('中')) + 1;
    child.output(response.subarray(0, split)); child.output(response.subarray(split)); child.close();
    assert.equal((await pending).text, '中文回答');
  });
}

test('Codex requires a successful turn terminal event, not just an intermediate agent item', async context => {
  const harness = fixture(context);
  const pending = harness.bridge.generateModelText({ prompt: 'missing terminal', chain: 'codex' });
  const child = harness.children[0];
  child.start(); child.output(codexText('partial answer', false)); child.close();
  assertFailure(await pending, { outcome: 'invalid-response', submitted: true, unknown: true });
});

test('Codex turn.failed overrides earlier agent text even when process exit is zero', async context => {
  const harness = fixture(context);
  const pending = harness.bridge.generateModelText({ prompt: 'failed terminal', chain: 'codex' });
  const child = harness.children[0];
  child.start();
  child.output(codexText('partial answer', false));
  child.output(JSON.stringify({ type: 'turn.failed', error: { message: 'quota exhausted' } }) + '\n');
  child.close();
  assertFailure(await pending, { outcome: 'quota-exhausted', submitted: true });
});

test('Claude Code structured_output is serialized and takes precedence over result text', async context => {
  const harness = fixture(context);
  const pending = harness.bridge.generateModelText({ prompt: 'structured', chain: 'claude-code' });
  const child = harness.children[0];
  child.start(); child.output(claudeText('ignored plain text', { structured_output: { answer: '结构化' } })); child.close();
  assert.deepEqual(JSON.parse((await pending).text), { answer: '结构化' });
});

test('Claude Code rejects nonterminal JSON even if it contains a result field', async context => {
  const harness = fixture(context);
  const pending = harness.bridge.generateModelText({ prompt: 'nonterminal', chain: 'claude-code' });
  const child = harness.children[0];
  child.start(); child.output(JSON.stringify({ type: 'assistant', result: 'partial answer' })); child.close();
  assertFailure(await pending, { outcome: 'invalid-response', submitted: true, unknown: true });
});

test('Codex temporary schema is removed after a safe startup failure', async context => {
  const harness = fixture(context, { plans: [noExecutable()] });
  assertFailure(await harness.bridge.generateModelText({ prompt: 'schema failure cleanup', chain: 'codex', schema: { type: 'object' } }), { outcome: 'not-started', fallback: true });
  const writes = harness.fsEvents.filter(event => event[0] === 'write');
  assert.equal(writes.length, 1);
  assert.equal(harness.files.has(writes[0][1]), false);
});

function bytewiseOutput(child, stdout, stderr = '') {
  const output = Buffer.from(stdout);
  const errors = Buffer.from(stderr);
  for (let index = 0; index < Math.max(output.length, errors.length); index++) {
    if (index < output.length) child.output(output.subarray(index, index + 1));
    if (index < errors.length) child.errorOutput(errors.subarray(index, index + 1));
  }
}

for (const provider of ['codex', 'claude-code']) {
  for (const code of [0, 7]) {
    test(`${provider} bytewise success terminal preserves CJK and emoji while respecting exit ${code}`, async context => {
      const harness = fixture(context);
      const pending = harness.bridge.generateModelText({ prompt: 'split terminal', chain: provider });
      const child = harness.children[0];
      child.start();
      bytewiseOutput(child, provider === 'codex' ? codexText('中文🐾回答').replaceAll('\n', '\r\n') : claudeText('中文🐾回答'));
      child.close(code);
      const result = await pending;
      if (code === 0) {
        assert.equal(result.text, '中文🐾回答');
        assert.equal(result.outcome, 'success');
      } else {
        assertFailure(result, { outcome: 'transport-unknown', submitted: true, unknown: true });
      }
      assert.equal(harness.calls.length, 1);
    });
  }
}

const codexFailureTerminals = [
  { event: { type: 'turn.failed', error: { message: '额度用尽 quota exhausted 🐾' } }, outcome: 'quota-exhausted' },
  { event: { type: 'error', message: '认证失败 not logged in 🐾' }, outcome: 'auth-required' },
];

for (const { event, outcome } of codexFailureTerminals) {
  for (const code of [0, 7]) {
    for (const failureFirst of [false, true]) {
      test(`Codex ${event.type}/${outcome} dominates success ${failureFirst ? 'after' : 'before'} it at exit ${code}`, async context => {
        const harness = fixture(context);
        const pending = harness.bridge.generateModelText({ prompt: 'mixed terminal events', chain: 'codex' });
        const child = harness.children[0];
        child.start();
        const success = codexText('中文 partial 🐾');
        const failure = JSON.stringify(event) + '\n';
        bytewiseOutput(child, failureFirst ? failure + success : success + failure);
        child.close(code);
        assertFailure(await pending, { outcome, submitted: true });
        assert.equal(harness.calls.length, 1);
      });
    }
  }
}

for (const failureFirst of [false, true]) {
  test(`Codex an empty-message turn.failed remains a failure ${failureFirst ? 'before' : 'after'} turn.completed`, async context => {
    const harness = fixture(context);
    const pending = harness.bridge.generateModelText({ prompt: 'empty failure message', chain: 'codex' });
    const child = harness.children[0];
    child.start();
    const success = codexText('partial answer');
    const failure = JSON.stringify({ type: 'turn.failed', error: { message: '' } }) + '\n';
    bytewiseOutput(child, failureFirst ? failure + success : success + failure);
    child.close();
    assertFailure(await pending, { outcome: 'invalid-response', submitted: true, unknown: true });
  });
}

for (const provider of ['codex', 'claude-code']) {
  for (const code of [0, 7]) {
    for (const [stderr, outcome] of [['\u001b[31m额度用尽 quota exhausted 🐾\u001b[0m', 'quota-exhausted'], ['\u001b[31m认证失败 not logged in 🐾\u001b[0m', 'auth-required']]) {
      test(`${provider} missing terminal leaves bytewise stderr ${outcome} visible at exit ${code}`, async context => {
        const harness = fixture(context);
        const pending = harness.bridge.generateModelText({ prompt: 'missing terminal diagnostic', chain: provider });
        const child = harness.children[0];
        child.start();
        const nonterminal = provider === 'codex' ? codexText('partial answer', false) : JSON.stringify({ type: 'assistant', result: 'partial answer' });
        bytewiseOutput(child, nonterminal, stderr);
        child.close(code);
        const result = await pending;
        assertFailure(result, { outcome, submitted: true });
        assert.match(result.error, outcome === 'quota-exhausted' ? /额度用尽 quota exhausted 🐾/u : /认证失败 not logged in 🐾/u);
        assert.equal(harness.calls.length, 1);
      });
    }
  }
}

for (const code of [0, 7]) {
  test(`Claude Code a bytewise error result rejects its structured output at exit ${code}`, async context => {
    const harness = fixture(context);
    const pending = harness.bridge.generateModelText({ prompt: 'failure beats structured output', chain: 'claude-code' });
    const child = harness.children[0];
    child.start();
    bytewiseOutput(child, claudeText('额度用尽 quota exhausted 🐾', {
      subtype: 'error_during_execution', is_error: true, structured_output: { answer: 'must not succeed' },
    }));
    child.close(code);
    assertFailure(await pending, { outcome: 'quota-exhausted', submitted: true });
  });
}

test('Claude Code multiple terminal JSON documents cannot be mistaken for one successful result', async context => {
  const harness = fixture(context);
  const pending = harness.bridge.generateModelText({ prompt: 'concatenated terminal documents', chain: 'claude-code' });
  const child = harness.children[0];
  child.start();
  bytewiseOutput(child, claudeText('partial answer') + '\n' + claudeText('quota exhausted', { subtype: 'error_during_execution', is_error: true }));
  child.close();
  assertFailure(await pending, { outcome: 'invalid-response', submitted: true, unknown: true });
});
