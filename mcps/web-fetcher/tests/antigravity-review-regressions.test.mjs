import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';

const nativeRequire = createRequire(import.meta.url);
const sourceNames = ['constants', 'antigravity-types', 'antigravity-models', 'antigravity-cli', 'model-bridge', 'background-tasks', 'tools/inspect', 'tools/fetch-page', 'tools/fetch-rich'];
const snapshots = new Map(sourceNames.map(name => {
  const source = readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8');
  return [name, { source, sha256: createHash('sha256').update(source).digest('hex') }];
}));
const compiled = new Map();
const forbidden = operation => () => { throw new Error(`Unexpected real operation: ${operation}`); };
const quietConsole = { log() {}, warn() {}, error() {} };

function loadSource(name, dependencies = {}, expose = []) {
  const cacheKey = `${name}:${expose.join(',')}`;
  if (!compiled.has(cacheKey)) {
    const appended = expose.length ? `\nexport { ${expose.join(', ')} };\n` : '';
    const source = snapshots.get(name).source.replaceAll('import.meta.url', JSON.stringify(new URL(`../src/${name}.ts`, import.meta.url).href));
    compiled.set(cacheKey, ts.transpileModule(source + appended, {
      fileName: `${name}.ts`,
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText);
  }
  const module = { exports: {} };
  const context = vm.createContext({
    Buffer, URL, AbortController, AbortSignal, performance, process: { env: {}, platform: process.platform, pid: process.pid, cwd: () => '/review-fixture' },
    setTimeout, clearTimeout, setImmediate, console: quietConsole,
  });
  const safeModules = new Set(['path', 'node:path', 'os', 'node:os', 'crypto', 'node:crypto', 'util', 'node:util', 'url', 'node:url', 'node:perf_hooks', 'node:timers', 'string_decoder', 'node:string_decoder', 'zod', 'turndown']);
  const requireDependency = specifier => {
    if (Object.hasOwn(dependencies, specifier)) return dependencies[specifier];
    if (safeModules.has(specifier)) return nativeRequire(specifier);
    throw new Error(`Unmocked dependency: ${name} -> ${specifier}`);
  };
  const wrapper = new vm.Script(`(function(require, module, exports) {\n${compiled.get(cacheKey)}\n})`, { filename: `${name}.review.cjs` }).runInContext(context);
  wrapper(requireDependency, module, module.exports);
  return module.exports;
}

const constants = loadSource('constants');
const antigravityTypes = loadSource('antigravity-types');
const antigravityModels = loadSource('antigravity-models', { './antigravity-types.js': antigravityTypes });
const viewport = { viewportSchema: nativeRequire('zod').z.object({ width: nativeRequire('zod').z.number(), height: nativeRequire('zod').z.number() }), assertViewportTarget() {}, async applyExplicitViewport() {} };
const requestContext = { getRequestContext: () => undefined, throwIfRequestExpired() {}, remainingRequestMs: () => 30_000 };
const backgroundFormatter = loadSource('background-tasks', {
  './request-context.js': { ...requestContext, OperationGate: class {}, runWithRequestContext: forbidden('background execution') },
});
const childProcess = { spawn: forbidden('process spawn'), execFile: forbidden('process execFile') };
const url = 'https://review.example.invalid/page';
const article = '# Fixture article\n\n' + 'A complete local article used only by mocked summary tests. '.repeat(60);
const picture = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1kAAAAASUVORK5CYII=', 'base64');

function modelResult(success = false, overrides = {}) {
  return {
    text: success ? 'Fixture summary' : null,
    chainUsed: success ? 'antigravity' : null,
    providerLabel: success ? 'Antigravity fixture' : null,
    transport: 'cli-ls', modelUsed: 'MODEL_PLACEHOLDER_M318',
    outcome: success ? 'success' : 'transport-unknown', submitted: true,
    outcomeUnknown: !success, fallbackAllowed: false,
    ...(success ? {} : { error: 'Connection interrupted after dispatch' }), ...overrides,
  };
}

function assertModelCall(actual, expected) {
  assert.ok(actual && typeof actual === 'object', 'The caller must retain structured modelCall metadata');
  for (const property of ['transport', 'modelUsed', 'outcome', 'submitted', 'outcomeUnknown', 'fallbackAllowed']) {
    assert.equal(actual[property], expected[property], `modelCall.${property}`);
  }
}

function bridgeFixture(callAntigravity) {
  const alternateCalls = [];
  const bridge = loadSource('model-bridge', {
    './constants.js': constants,
    './request-context.js': requestContext,
    './ls-client.js': { callAntigravity, isAntigravityAvailable: forbidden('availability probe') },
    child_process: {
      spawn(...args) { alternateCalls.push(args); throw new Error('Mock alternate provider must not run'); },
      execFile: forbidden('version probe'),
    },
    fs: { statSync: () => ({ isFile: () => true }), existsSync: () => false, writeFileSync() {}, unlinkSync() {} },
  });
  return { bridge, alternateCalls };
}

function toolFixture(expectedResult = modelResult(), screenshotFailure = 'navigate') {
  const summaryCalls = [];
  const visualCalls = [];
  const tasks = [];
  const files = new Map();
  const page = {
    url: () => url, viewportSize: () => ({ width: 1920, height: 1080 }),
    async screenshot() { return picture; }, async evaluate() { return undefined; },
    async close() {}, async setViewportSize() {}, async waitForTimeout() {},
  };
  const browserManager = {
    lastRetryCount: 0,
    async navigateTo() {
      if (screenshotFailure === 'navigate') throw new Error('Fixture screenshot navigation failed');
      return page;
    },
    async waitForVisualReady() { return { complete: true }; },
    async checkAndHandleVerification() {}, async scrollPage() {},
  };
  const memoryFs = { writeFileSync: (filename, value) => files.set(filename, value), existsSync: filename => files.has(filename) };
  const extractor = {
    extractContent: () => ({ content: article }), compactContent: content => content.slice(0, 500), truncateContent: content => content,
    cleanFooterGarbage: content => content, detectSPAIssue: () => null, detectEncodingIssue: () => false, safePageContent: async () => '<article>fixture</article>',
  };
  const modelBridge = {
    buildSummaryPrompt: content => ({ prompt: content, pageTitle: 'fixture', truncatedContent: content }),
    async generateSummaryText(...args) { summaryCalls.push(args); return expectedResult; },
    async generateModelText(request) {
      visualCalls.push(request);
      return modelResult(true, { text: JSON.stringify({ summary: 'Fixture review', aiFindings: [], confirmedIssues: [], dismissedIssues: [], dismissReason: {} }) });
    },
  };
  const tempStore = {
    ensureTempDirs() {}, generateCacheKey: () => 'review-key', TEMP_DIRS: { screenshots: '/review-fixture/screenshots' },
    saveTempFile(_kind, key, extension, content) { const filename = `/review-fixture/${key}${extension}`; files.set(filename, content); return filename; },
    async splitOversizedImage() { return { wasSplit: false, paths: ['/review-fixture/screenshot.jpg'], sizes: [1] }; },
  };
  const background = {
    startBackgroundTask(_name, work) {
      const task = { id: `review-task-${tasks.length}`, kind: _name, status: 'running', startedAt: new Date().toISOString(), metadata: {}, deadlineAt: new Date(Date.now() + 5000).toISOString() };
      tasks.push(task);
      task.pending = Promise.resolve().then(() => work({ signal: new AbortController().signal, updateMetadata: metadata => Object.assign(task.metadata, metadata) }))
        .then(result => { task.result = result; task.status = 'done'; }, error => { task.error = error.message; task.status = 'error'; });
      return task;
    },
    async waitForBackgroundTask(taskId) { return tasks.find(task => task.id === taskId) ?? null; },
    formatBackgroundTask: backgroundFormatter.formatBackgroundTask,
  };
  const common = {
    '../constants.js': constants, '../browser.js': { browserManager }, '../session.js': { sessionManager: { get: () => page } },
    '../viewport.js': viewport, '../request-context.js': requestContext, '../extractor.js': extractor,
    '../model-bridge.js': modelBridge, '../lifecycle.js': { touchActivity() {} }, '../temp-store.js': tempStore,
    '../background-tasks.js': background,
  };
  const inspector = loadSource('tools/inspect', {
    ...common, fs: memoryFs,
    '../inspector/pdf-inspector.js': {}, '../inspector/pptx-inspector.js': {}, '../ebook/epub.js': {},
    '../inspector/dom-inspector.js': {
      async extractDomStructure() { return [{ page: 1, dimensions: { width: 1920, height: 1080 }, elements: [] }]; },
      async detectDomIssues() { return { summary: { pages: 1, elements: 0, issues: 0, warnings: 0, errors: 0 }, issues: [] }; },
    },
    '../inspection-output.js': { inspectionContent: async response => ({ structuredContent: response, content: [] }) },
  });
  const fetchPage = loadSource('tools/fetch-page', {
    ...common, fs: memoryFs, child_process: childProcess,
    '../page-access.js': {}, '../navigation-read.js': {}, '../human-verification.js': {}, '../cache.js': {},
  }, ['formatAiSummary']);
  const rich = loadSource('tools/fetch-rich', {
    ...common, '../page-access.js': { samePageTarget: () => true },
    '../image-output.js': { inlineImageContent: async () => [{ type: 'image', mimeType: 'image/png', data: picture.toString('base64') }] },
  });
  const handlers = new Map();
  const server = { registerTool(name, _config, handler) { handlers.set(name, handler); } };
  inspector.registerInspect(server);
  fetchPage.registerFetchPage(server);
  rich.registerFetchRich(server);
  return { handlers, fetchPage, summaryCalls, visualCalls, tasks, files };
}

for (const failure of ['navigate', 'missing-file']) {
  test(`review regression: ${failure} screenshot does not submit a text-only visual review`, async context => {
    context.diagnostic(`inspect source sha256=${snapshots.get('tools/inspect').sha256}`);
    const fixture = toolFixture(modelResult(), failure);
    const result = await fixture.handlers.get('web_inspect')({ url, mode: 'ai_review', modelChain: 'antigravity', batchSize: 1 });
    assert.equal(fixture.visualCalls.length, 0, 'Missing screenshot must stop before any model generation');
    assert.ok(result.structuredContent.aiReview.error, 'Missing screenshot must remain an unreviewed error');
  });
}

for (const submitted of [true, false]) {
  test(`review regression: local cancellation submitted=${submitted} preserves generation uncertainty`, async () => {
    const controller = new AbortController();
    const fixture = bridgeFixture(async () => {
      controller.abort();
      return { text: null, transport: 'cli-ls', model: 'MODEL_PLACEHOLDER_M318', outcome: 'cancelled', submitted, safeToFallback: false };
    });
    const result = await fixture.bridge.generateModelText({ prompt: 'Fixture cancellation', chain: 'auto', signal: controller.signal });
    assert.equal(result.outcome, 'cancelled');
    assert.equal(result.submitted, submitted);
    assert.equal(result.outcomeUnknown, submitted);
    assert.equal(result.fallbackAllowed, false);
    assert.equal(fixture.alternateCalls.length, 0);
  });
}

for (const success of [false, true]) {
  for (const mode of ['sync', 'background', 'rich-inline', 'rich-file']) {
    test(`review regression: ${mode} summary retains modelCall after ${success ? 'success' : 'submitted transport failure'}`, async context => {
      context.diagnostic(`summary sources sha256=${snapshots.get('tools/fetch-page').sha256},${snapshots.get('tools/fetch-rich').sha256}`);
      const expected = modelResult(success);
      const fixture = toolFixture(expected, 'none');
      if (mode === 'background') {
        await fixture.fetchPage.formatAiSummary(article, url, 'antigravity', true);
        assert.equal(fixture.tasks.length, 1);
        await fixture.tasks[0].pending;
        assertModelCall(fixture.tasks[0].metadata.modelCall, expected);
        assert.equal(Boolean(fixture.tasks[0].error), !success);
        const queried = await fixture.handlers.get('web_fetch_page')({ taskId: fixture.tasks[0].id, waitSeconds: 0 });
        assertModelCall(queried._meta?.modelCall, expected);
        const text = queried.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
        assert.ok(text.includes(expected.modelUsed), 'The queried result must identify the actual model');
        if (!success) assert.ok(text.includes(expected.outcome), 'The queried error must preserve the original uncertain outcome');
      } else {
        const result = mode === 'sync'
          ? await fixture.fetchPage.formatAiSummary(article, url, 'antigravity', false)
          : await fixture.handlers.get('web_fetch_rich')({ url, compact: 'ai_summary', modelChain: 'antigravity', saveMode: mode === 'rich-file' ? 'file' : 'inline' });
        assert.notEqual(result.isError, true, JSON.stringify(result));
        assertModelCall(result._meta?.modelCall, expected);
      }
      assert.equal(fixture.summaryCalls.length, 1, 'The original summary must not be resubmitted');
    });
  }
}

async function ownedCliFixture(context, statusLabel = 'Gemini 3.8 Flash (High)', availableModels = [{ modelId: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash (High)' }], protocolOptions = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-review-regressions-'));
  const imagePath = path.join(root, 'image.png');
  const auditPath = path.join(root, 'audit.jsonl');
  await fs.writeFile(imagePath, picture);
  const children = [];
  const metadataCalls = [];
  const terminationAttempts = [];
  const fixturePath = fileURLToPath(new URL('./fixtures/antigravity-cli/mock-acp.mjs', import.meta.url));
  const cliModule = loadSource('antigravity-cli', {
    'node:child_process': {
      spawn: forbidden('uninjected CLI process spawn'),
      execFile(command, args, _options, callback) {
        assert.equal(command, 'taskkill.exe');
        const child = children.find(candidate => candidate.pid === Number(args[args.indexOf('/PID') + 1]));
        assert.ok(child, 'Only this test fixture child may be terminated');
        terminationAttempts.push(child.pid);
        child.kill();
        queueMicrotask(() => callback(null, '', ''));
      },
    }, 'node:fs': nativeRequire('node:fs'), 'node:fs/promises': nativeRequire('node:fs/promises'),
    './memory-sampler.js': { getRuntimeMemorySampler: forbidden('global memory sampler') },
    './antigravity-types.js': antigravityTypes, './antigravity-models.js': antigravityModels,
    './antigravity-rpc.js': {
      async callAntigravityRpc(endpoint, method, payload, options) {
        metadataCalls.push({ endpoint, method, payload, options });
        assert.equal(method, 'GetUserStatus');
        assert.ok(children.some(child => child.pid === endpoint.pid), 'Mapping must use the owned CLI endpoint');
        return { status: 200, submitted: false, data: { userStatus: {
          userTier: { name: 'Google AI Ultra' },
          cascadeModelConfigData: { clientModelConfigs: [{ label: statusLabel, modelId: availableModels.find(item => item.name === statusLabel)?.modelId ?? 'fixture-unmatched-model', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M318' }, disabled: false, quotaInfo: { remainingFraction: 1 } }] },
        } } };
      },
    },
  });
  const client = new cliModule.AntigravityCliClient({
    resolveCommand: () => process.execPath,
    memoryProvider: { snapshot: () => ({ valid: true, sampledAt: performance.now(), physicalAvailableMB: 16000, commitAvailableMB: 24000, lowMemory: false }) },
    verifyEndpoint: async pid => children.some(child => child.pid === pid),
    spawnProcess(command, args, options) {
      assert.equal(command, process.execPath);
      const child = spawn(process.execPath, [fixturePath, ...args], { ...options, env: { ...process.env, MOCK_AGY_AUDIT: auditPath, MOCK_AGY_OPTIONS: JSON.stringify({ models: availableModels, ...protocolOptions }) } });
      children.push(child);
      return child;
    },
  });
  context.after(async () => {
    try { await client.dispose(); }
    finally {
      for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill();
      await Promise.all(children.map(child => child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise(resolve => child.once('close', resolve))));
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  return { client, imagePath, metadataCalls, terminationAttempts, events: async () => (await fs.readFile(auditPath, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) };
}

for (const model of ['M318', 'MODEL_PLACEHOLDER_M318']) {
  test(`review regression: explicit ${model} image maps through owned catalog without crossing platform`, async context => {
    context.diagnostic(`cli/bridge source sha256=${snapshots.get('antigravity-cli').sha256},${snapshots.get('model-bridge').sha256}`);
    const owned = await ownedCliFixture(context);
    const fixture = bridgeFixture(request => owned.client.callAgent(request));
    const result = await fixture.bridge.generateModelText({ prompt: 'Inspect fixture image', model, chain: 'auto', imagePaths: [owned.imagePath] });
    assert.equal(fixture.alternateCalls.length, 0);
    assert.equal(result.outcome, 'success', JSON.stringify(result));
    assert.equal(result.chainUsed, 'antigravity');
    assert.equal(result.modelUsed, 'gemini-3.8-flash-high');
    assert.equal(owned.metadataCalls.length, 1, 'The enum mapping must come from one owned GetUserStatus request');
    const prompts = (await owned.events()).filter(event => event.kind === 'message' && event.message.method === 'session/prompt');
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0].message.params.prompt.filter(block => block.type === 'image').length, 1);
  });
}

test('review regression: an unmapped explicit M318 image stops without a generation or alternate provider', async context => {
  const owned = await ownedCliFixture(context, 'Unmatched account catalog label');
  const fixture = bridgeFixture(request => owned.client.callAgent(request));
  const result = await fixture.bridge.generateModelText({ prompt: 'Inspect fixture image', model: 'M318', chain: 'auto', imagePaths: [owned.imagePath] });
  assert.equal(fixture.alternateCalls.length, 0);
  assert.equal(result.text, null);
  assert.equal(result.submitted, false);
  assert.equal(result.fallbackAllowed, false);
  const prompts = (await owned.events()).filter(event => event.kind === 'message' && event.message.method === 'session/prompt');
  assert.equal(prompts.length, 0);
});

test('review regression: explicit M318 follows a changed account catalog label instead of a fixed model table', async context => {
  const selected = { modelId: 'gemini-4-argon-high', name: 'Gemini 4 Argon (High)' };
  const owned = await ownedCliFixture(context, selected.name, [selected]);
  const fixture = bridgeFixture(request => owned.client.callAgent(request));
  const result = await fixture.bridge.generateModelText({ prompt: 'Inspect fixture image', model: 'M318', chain: 'auto', imagePaths: [owned.imagePath] });
  assert.equal(fixture.alternateCalls.length, 0);
  assert.equal(result.outcome, 'success', JSON.stringify(result));
  assert.equal(result.chainUsed, 'antigravity');
  assert.equal(result.modelUsed, selected.modelId);
  assert.equal(owned.metadataCalls.length, 1);
});

test('review regression: a complete end_turn survives an 800ms healthy EOF shutdown inside the total deadline', async context => {
  context.diagnostic(`cli source sha256=${snapshots.get('antigravity-cli').sha256}`);
  const owned = await ownedCliFixture(context, undefined, undefined, { eofDelay: 800 });
  const fixture = bridgeFixture(request => owned.client.callAgent(request));
  const result = await fixture.bridge.generateModelText({ prompt: 'Inspect fixture image', model: 'M318', chain: 'auto', imagePaths: [owned.imagePath], timeoutMs: 6000 });
  const events = await owned.events();
  assert.equal(events.filter(event => event.kind === 'terminal').length, 1);
  assert.equal(events.filter(event => event.kind === 'eof').length, 1);
  context.diagnostic(JSON.stringify({ outcome: result.outcome, submitted: result.submitted, retainedText: result.text, forcedTerminations: owned.terminationAttempts.length }));
  assert.equal(owned.terminationAttempts.length, 0, 'A healthy owned CLI must have its cleanup reserve before forced termination');
  assert.equal(result.outcome, 'success', JSON.stringify(result));
  assert.equal(JSON.parse(result.text).image, true);
  assert.equal(fixture.alternateCalls.length, 0);
});

test('review regression: without a successful end_turn an EOF-resistant CLI remains unknown and never becomes a passed image review', async context => {
  const owned = await ownedCliFixture(context, undefined, undefined, { stopReason: 'max_tokens', ignoreEof: true });
  const fixture = bridgeFixture(request => owned.client.callAgent(request));
  const started = performance.now();
  const result = await fixture.bridge.generateModelText({ prompt: 'Inspect fixture image', model: 'M318', chain: 'auto', imagePaths: [owned.imagePath], timeoutMs: 1800 });
  assert.equal((await owned.events()).filter(event => event.kind === 'terminal').length, 1);
  context.diagnostic(JSON.stringify({ outcome: result.outcome, submitted: result.submitted, outcomeUnknown: result.outcomeUnknown, forcedTerminations: owned.terminationAttempts.length }));
  assert.notEqual(result.outcome, 'success');
  assert.equal(result.text, null);
  assert.equal(result.submitted, true);
  assert.equal(result.outcomeUnknown, true);
  assert.equal(result.fallbackAllowed, false);
  assert.equal(fixture.alternateCalls.length, 0);
  assert.ok(performance.now() - started < 4000, 'Unconfirmed EOF cleanup must remain bounded');
});

test('review regression: a known end_turn retains its text and exposes forced cleanup through the model bridge', async context => {
  const owned = await ownedCliFixture(context, undefined, undefined, { ignoreEof: true });
  let original;
  const fixture = bridgeFixture(async request => {
    original = await owned.client.callAgent(request);
    return original;
  });
  const result = await fixture.bridge.generateModelText({ prompt: 'Inspect fixture image', model: 'M318', chain: 'auto', imagePaths: [owned.imagePath], timeoutMs: 1800 });
  assert.equal(original.cleanup.status, 'terminated');
  assert.equal(original.cleanup.confirmed, true);
  assert.equal(result.outcome, 'success');
  assert.equal(JSON.parse(result.text).image, true);
  context.diagnostic(JSON.stringify({ outcome: result.outcome, cliCleanup: original.cleanup.status, bridgeCleanup: result.cleanup ?? null }));
  assert.ok(result.cleanup, 'The outer bridge must retain the independently reported CLI cleanup state');
  assert.equal(result.cleanup.status, original.cleanup.status);
  assert.equal(result.cleanup.confirmed, original.cleanup.confirmed);
  assert.equal(result.cleanup.method, original.cleanup.method);
  assert.equal(fixture.alternateCalls.length, 0);
});
