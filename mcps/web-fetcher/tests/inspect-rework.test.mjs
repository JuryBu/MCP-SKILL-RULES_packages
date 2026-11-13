import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const nativeRequire = createRequire(import.meta.url);
const sources = new Map(['tools/inspect', 'request-context'].map(name => [name,
    ts.transpileModule(readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8')
        + (name === 'tools/inspect' ? '\nexport { InspectInputSchema, normalizeParams, backgroundTasks, checkBackgroundTask };' : ''), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText,
]));

function clockFixture() {
    let now = 0;
    let sequence = 0;
    const timers = new Map();
    const flush = async () => { for (let iteration = 0; iteration < 160; iteration++) await Promise.resolve(); };
    const clock = {
        now: () => now,
        flush,
        setTimeout(callback, delay = 0) {
            const timer = { id: ++sequence, at: now + Math.max(0, delay), callback, unref() {} };
            timers.set(timer.id, timer);
            return timer;
        },
        clearTimeout(timer) { if (timer) timers.delete(timer.id); },
        async advance(milliseconds) {
            const target = now + milliseconds;
            await flush();
            while (true) {
                const next = [...timers.values()].sort((first, second) => first.at - second.at || first.id - second.id)[0];
                if (!next || next.at > target) break;
                now = next.at;
                timers.delete(next.id);
                next.callback();
                await flush();
            }
            now = target;
            await flush();
        },
    };
    clock.sleep = milliseconds => new Promise(resolve => clock.setTimeout(resolve, milliseconds));
    return clock;
}

function successfulModel(overrides = {}) {
    return {
        text: JSON.stringify({ summary: 'Fixture review', aiFindings: [], confirmedIssues: [], dismissedIssues: [], dismissReason: {} }),
        chainUsed: 'antigravity', providerLabel: 'Fixture', transport: 'cli-agent', modelUsed: 'fixture-model',
        outcome: 'success', submitted: true, outcomeUnknown: false, fallbackAllowed: false,
        cleanup: { status: 'graceful', confirmed: true, warnings: [] },
        ...overrides,
    };
}

function queuedProvider(clock) {
    const queue = [];
    const executions = [];
    let active;
    const drain = () => {
        if (active || !queue.length) return;
        const entry = queue.shift();
        active = entry;
        entry.started = true;
        clock.clearTimeout(entry.timer);
        const executionDeadline = Math.min(entry.request.deadline, clock.now() + entry.request.generationTimeoutMs);
        executions.push({ ownerId: entry.ownerId, startedAt: clock.now(), executionDeadline, parentDeadline: entry.request.deadline });
        entry.timer = clock.setTimeout(() => entry.finish(successfulModel({ text: null, outcome: 'timeout-unknown', outcomeUnknown: true,
            error: 'Fixture generation deadline', cleanup: { confirmed: true, status: 'terminated', warnings: [] } })), executionDeadline - clock.now());
        entry.work = clock.setTimeout(() => entry.finish(successfulModel()), entry.durationMs);
    };
    const submit = (request, ownerId, durationMs) => new Promise(resolve => {
        const entry = { request, ownerId, durationMs, started: false, settled: false };
        entry.finish = result => {
            if (entry.settled) return;
            entry.settled = true;
            clock.clearTimeout(entry.timer);
            clock.clearTimeout(entry.work);
            request.signal?.removeEventListener('abort', entry.abort);
            const index = queue.indexOf(entry);
            if (index >= 0) queue.splice(index, 1);
            if (active === entry) active = undefined;
            resolve(result);
            drain();
        };
        entry.abort = () => entry.finish(successfulModel({ text: null, outcome: 'cancelled', submitted: entry.started,
            outcomeUnknown: entry.started, error: 'Fixture request_cancelled', cleanup: { confirmed: true, status: 'graceful', warnings: [] } }));
        entry.timer = clock.setTimeout(() => entry.finish(successfulModel({ text: null, outcome: 'not-started', submitted: false,
            outcomeUnknown: false, error: 'Fixture admission_timeout', cleanup: undefined })), request.deadline - clock.now());
        queue.push(entry);
        request.signal?.addEventListener('abort', entry.abort, { once: true });
        if (request.signal?.aborted) entry.abort();
        drain();
    });
    return { submit, executions };
}

function fixture(options = {}) {
    const clock = clockFixture();
    const provider = queuedProvider(clock);
    const files = new Map();
    const calls = [];
    const counts = { structure: 0, detection: 0, screenshots: 0 };
    const structure = Array.from({ length: options.pages ?? 1 }, (_, index) => ({
        page: index + 1, dimensions: { width: 800, height: 520 }, elements: [],
    }));
    class FixtureDate extends Date {
        constructor(...args) { super(...(args.length ? args : [1_800_000_000_000 + clock.now()])); }
        static now() { return 1_800_000_000_000 + clock.now(); }
    }
    const load = (name, dependencies) => {
        const module = { exports: {} };
        const context = vm.createContext({
            Buffer, URL, AbortController, AbortSignal, Date: FixtureDate,
            performance: { now: clock.now }, process: { env: { WEB_FETCHER_INSPECT_BACKGROUND_MAX_RUN_MS: String(options.maxRunMs ?? 900_000) } },
            setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
            setImmediate: callback => clock.setTimeout(callback, 0), console,
        });
        const allowed = new Set(['node:async_hooks', 'zod', 'crypto', 'url']);
        const requireDependency = specifier => {
            if (Object.hasOwn(dependencies, specifier)) return dependencies[specifier];
            if (specifier === 'node:perf_hooks') return { performance: { now: clock.now } };
            if (allowed.has(specifier)) return nativeRequire(specifier);
            throw new Error(`Unmocked dependency: ${name} -> ${specifier}`);
        };
        new vm.Script(`(function(require,module,exports){${sources.get(name)}\n})`, { filename: `${name}.fixture.cjs` })
            .runInContext(context)(requireDependency, module, module.exports);
        return module.exports;
    };
    const requestContext = load('request-context', {});
    const page = {
        async screenshot({ path }) { counts.screenshots++; files.set(path, 'fixture-image'); },
        async close() {},
    };
    const extract = async () => { counts.structure++; return options.extract ? options.extract(structure) : structure; };
    const detect = async () => {
        counts.detection++;
        return { summary: { pages: structure.length, elements: 0, issues: 0, warnings: 0, errors: 0 }, issues: [] };
    };
    const inspector = load('tools/inspect', {
        fs: { existsSync: filename => files.has(filename) },
        '../request-context.js': requestContext,
        '../browser.js': { browserManager: { async navigateTo() { return page; }, async waitForVisualReady() { return { complete: true }; } } },
        '../viewport.js': { viewportSchema: nativeRequire('zod').z.object({ width: nativeRequire('zod').z.number(), height: nativeRequire('zod').z.number() }), assertViewportTarget() {}, async applyExplicitViewport() {} },
        '../lifecycle.js': { touchActivity() {} },
        '../model-bridge.js': { async generateModelText(request) {
            calls.push({ request, at: clock.now(), deadline: requestContext.getRequestContext()?.deadline });
            if (options.queuedGenerationMs !== undefined) return provider.submit(request, requestContext.getRequestContext()?.ownerId, options.queuedGenerationMs);
            return options.generate ? options.generate(request, calls.length, clock) : successfulModel();
        } },
        '../temp-store.js': { ensureTempDirs() {}, generateCacheKey: (...args) => args.join('-'), TEMP_DIRS: { screenshots: '/fixture' },
            saveTempFile(_kind, key, extension, content) { const filename = `/fixture/${key}${extension}`; files.set(filename, content); return filename; } },
        '../constants.js': { SUMMARY_CHAIN_VALUES: ['auto', 'antigravity', 'codex', 'claude-code'], QUALITY_PRESETS: { default: { jpegQuality: 75 } }, resolveSummaryModelChain: (chain, modelChain) => modelChain ?? chain ?? 'auto' },
        '../inspector/dom-inspector.js': { extractDomStructure: extract, detectDomIssues: detect },
        '../inspector/pdf-inspector.js': { resolvePdfPathFromUrl: async () => '/fixture/document.pdf', extractPdfStructure: extract, detectPdfIssues: detect },
        '../inspector/pptx-inspector.js': { localPptxPathFromUrl: () => '/fixture/document.pptx', extractPptxStructure: extract, detectPptxIssues: detect },
        '../ebook/epub.js': {},
        '../inspection-output.js': { inspectionContent: async response => response },
        '../background-tasks.js': { runBackgroundWork(_kind, run, maxRunMs, _onStarted, signal) {
            return requestContext.runWithRequestContext({ signal, timeoutMs: maxRunMs }, async () => {
                if (options.backgroundQueueMs) await clock.sleep(options.backgroundQueueMs);
                return run();
            });
        } },
    });
    let handler;
    let config;
    inspector.registerInspect({ registerTool(_name, specification, execute) { config = specification; handler = execute; } });
    const inspect = (params = {}, request = {}) => requestContext.runWithRequestContext({ timeoutMs: 300_000, ...request },
        () => handler({ url: 'https://fixture.invalid/document.pdf', mode: 'ai_review', ...params }));
    return { clock, files, calls, counts, inspector, config, inspect, structure, requestContext, provider };
}

test('request model is validated, normalized and forwarded without selecting another provider', async () => {
    const current = fixture();
    assert.equal(current.config.inputSchema.model.parse('  Explicit Model  '), 'Explicit Model');
    assert.throws(() => current.config.inputSchema.model.parse('   '));
    const result = await current.inspect({ model: 'Explicit Model', modelChain: 'auto' });
    assert.equal(result.model, 'Explicit Model');
    assert.equal(current.calls[0].request.model, 'Explicit Model');
    assert.equal(current.calls[0].request.chain, 'auto');
    assert.equal(current.calls[0].request.timeoutMs, 300_000);
    assert.equal(current.calls[0].request.deadline, 300_000);
    assert.equal(current.calls[0].request.generationTimeoutMs, 60_000);
    assert.equal(current.inspector.normalizeParams({ model: ' Trimmed ' }).model, 'Trimmed');
});

test('all background returns before heavy structure and preserves all outputs and mode', async () => {
    let release;
    const current = fixture({ extract: structure => new Promise(resolve => { release = () => resolve(structure); }) });
    const started = await current.inspect({ mode: 'all', background: true, model: 'Explicit Model' });
    assert.equal(started.status, 'running');
    assert.equal(started.mode, 'all');
    assert.equal(current.counts.structure, 0);
    await current.clock.advance(0);
    assert.equal(current.counts.structure, 1);
    release();
    await current.clock.flush();
    const checked = await current.inspect({ action: 'check', taskId: started.taskId });
    assert.equal(checked.status, 'done');
    assert.equal(checked.mode, 'all');
    assert.equal(checked.structure.length, 1);
    assert.equal(checked.detection.summary.pages, 1);
    assert.equal(checked.aiReview.summary, 'Fixture review');
    assert.equal(checked.result, checked.aiReview);
    assert.equal(checked.model, 'Explicit Model');
    assert.equal(current.counts.structure, 1);
    assert.equal(current.counts.detection, 1);
});

for (const modelChain of ['antigravity', 'auto']) {
    test(`${modelChain}: five 25s pages keep one active call and a separate 60s generation budget`, async () => {
        let active = 0;
        let maximum = 0;
        const current = fixture({ pages: 5, async generate(_request, _index, clock) {
            maximum = Math.max(maximum, ++active);
            await clock.sleep(25_000);
            active--;
            return successfulModel();
        } });
        const pending = current.inspect({ modelChain, batchSize: 5 });
        await current.clock.flush();
        assert.equal(current.calls.length, 1);
        await current.clock.advance(125_000);
        const result = await pending;
        assert.equal(result.aiReview.error, undefined);
        assert.equal(result.aiReview.modelCalls.length, 5);
        assert.equal(maximum, 1);
        assert.deepEqual(current.calls.map(call => call.at), [0, 25_000, 50_000, 75_000, 100_000]);
        assert.ok(current.calls.every(call => call.deadline === 300_000 && call.request.generationTimeoutMs === 60_000));
        assert.deepEqual(current.calls.map(call => call.request.timeoutMs), [300_000, 275_000, 250_000, 225_000, 200_000]);
    });
}

test('another owner summary occupies the global CLI before two inspect pages get full execution budgets', async () => {
    const current = fixture({ pages: 2, queuedGenerationMs: 25_000 });
    const summary = current.provider.submit({ deadline: 180_000, generationTimeoutMs: 60_000 }, 'summary-owner', 40_000);
    const pending = current.inspect({ modelChain: 'antigravity' }, { ownerId: 'inspect-owner', timeoutMs: 180_000 });
    await current.clock.flush();
    assert.equal(current.calls.length, 1);
    assert.equal(current.provider.executions.length, 1);
    await current.clock.advance(90_000);
    assert.equal((await summary).outcome, 'success');
    const result = await pending;
    assert.equal(result.aiReview.error, undefined);
    assert.equal(result.aiReview.modelCalls.length, 2);
    assert.deepEqual(current.provider.executions.map(entry => [entry.ownerId, entry.startedAt, entry.executionDeadline]),
        [['summary-owner', 0, 60_000], ['inspect-owner', 40_000, 100_000], ['inspect-owner', 65_000, 125_000]]);
    assert.deepEqual(current.calls.map(call => call.request.deadline), [180_000, 180_000]);
    assert.deepEqual(current.calls.map(call => call.request.timeoutMs), [180_000, 115_000]);
});

test('parent deadline expires in the global CLI queue without submitting or replaying inspect pages', async () => {
    const current = fixture({ pages: 2, queuedGenerationMs: 25_000 });
    const summary = current.provider.submit({ deadline: 180_000, generationTimeoutMs: 60_000 }, 'summary-owner', 50_000);
    const pending = current.inspect({ modelChain: 'antigravity' }, { ownerId: 'inspect-owner', timeoutMs: 20_000 });
    await current.clock.advance(20_000);
    const result = await pending;
    assert.match(result.aiReview.error, /admission_timeout/);
    assert.equal(result.aiReview.modelCalls[0].submitted, false);
    assert.equal(current.calls.length, 1);
    assert.equal(current.provider.executions.length, 1);
    await current.clock.advance(30_000);
    assert.equal((await summary).outcome, 'success');
});

test('global CLI execution stops at the page budget and never replays or submits the next page', async () => {
    const current = fixture({ pages: 2, queuedGenerationMs: 70_000 });
    const summary = current.provider.submit({ deadline: 180_000, generationTimeoutMs: 60_000 }, 'summary-owner', 40_000);
    const pending = current.inspect({ modelChain: 'antigravity' }, { ownerId: 'inspect-owner', timeoutMs: 180_000 });
    await current.clock.advance(100_000);
    await summary;
    const result = await pending;
    assert.equal(current.calls.length, 1);
    assert.equal(current.provider.executions[1].executionDeadline, 100_000);
    assert.equal(result.aiReview.modelCalls[0].outcome, 'timeout-unknown');
    assert.equal(result.aiReview.modelCalls[0].submitted, true);
    assert.equal(result.aiReview.modelCalls[0].fallbackAllowed, false);
});

test('background parent expiry keeps the original task and does not restart after another owner releases CLI', async () => {
    const current = fixture({ pages: 2, queuedGenerationMs: 25_000, maxRunMs: 20_000 });
    const summary = current.provider.submit({ deadline: 180_000, generationTimeoutMs: 60_000 }, 'summary-owner', 50_000);
    const started = await current.inspect({ background: true, modelChain: 'antigravity' }, { ownerId: 'inspect-owner' });
    await current.clock.advance(20_000);
    const checked = await current.inspector.checkBackgroundTask(started.taskId, 0);
    assert.equal(checked.taskId, started.taskId);
    assert.equal(checked.status, 'error');
    assert.equal(checked.timedOut, true);
    assert.equal(checked.result.modelCalls[0].submitted, false);
    const snapshot = JSON.stringify(checked);
    await current.clock.advance(30_000);
    await summary;
    assert.equal(current.inspector.backgroundTasks.size, 1);
    assert.equal(current.calls.length, 1);
    assert.equal(current.provider.executions.length, 1);
    assert.equal(JSON.stringify(await current.inspector.checkBackgroundTask(started.taskId, 0)), snapshot);
});

test('cancelling a queued inspection leaves the active and next independent inspection healthy', async () => {
    const controller = new AbortController();
    const current = fixture({ queuedGenerationMs: 50 });
    const first = current.inspect({ modelChain: 'antigravity' }, { ownerId: 'active' });
    await current.clock.flush();
    const cancelled = current.inspect({ modelChain: 'antigravity' }, { ownerId: 'cancelled', signal: controller.signal });
    const third = current.inspect({ modelChain: 'antigravity' }, { ownerId: 'next' });
    await current.clock.flush();
    controller.abort(new Error('Fixture queued cancellation'));
    await current.clock.flush();
    assert.match((await cancelled).aiReview.error, /request_cancelled/);
    assert.equal(current.calls.length, 3);
    assert.equal(current.provider.executions.length, 1);
    await current.clock.advance(100);
    assert.equal((await first).aiReview.error, undefined);
    assert.equal((await third).aiReview.error, undefined);
    assert.deepEqual(current.provider.executions.map(call => call.startedAt), [0, 50]);
});

test('explicit non-AGY chain retains the requested batch concurrency', async () => {
    const current = fixture({ pages: 5, async generate(_request, _index, clock) { await clock.sleep(25); return successfulModel(); } });
    const pending = current.inspect({ modelChain: 'codex', batchSize: 5, mode: 'all' });
    await current.clock.flush();
    assert.equal(current.calls.length, 5);
    await current.clock.advance(25);
    const result = await pending;
    assert.equal(result.mode, 'all');
    assert.equal(result.structure.length, 5);
    assert.equal(result.aiReview.modelCalls.length, 5);
    assert.equal(current.counts.structure, 1);
    assert.equal(current.counts.detection, 1);
});

test('submitted unknown result keeps cleanup facts and stops remaining pages without replay', async () => {
    const current = fixture({ pages: 5, generate: () => successfulModel({ text: null, outcome: 'timeout-unknown', outcomeUnknown: true,
        error: 'Fixture submitted request outcome unknown', cleanup: { status: 'unconfirmed', confirmed: false, warnings: ['Fixture cleanup pending'] } }) });
    const result = await current.inspect({ modelChain: 'antigravity', batchSize: 5 });
    assert.equal(current.calls.length, 1);
    assert.equal(current.counts.screenshots, 1);
    assert.equal(result.aiReview.modelCalls[0].submitted, true);
    assert.equal(result.aiReview.modelCalls[0].outcomeUnknown, true);
    assert.equal(result.aiReview.modelCalls[0].fallbackAllowed, false);
    assert.equal(result.aiReview.modelCalls[0].cleanup.confirmed, false);
    assert.match(result.aiReview.error, /剩余4页未审查/);
});

test('foreground cancellation retains the original submitted model and cleanup receipt', async () => {
    const controller = new AbortController();
    const current = fixture({ pages: 5, generate: async (request, _index, clock) => {
        await new Promise(resolve => request.signal.addEventListener('abort', resolve, { once: true }));
        await clock.sleep(20);
        return successfulModel({ text: null, outcome: 'cancelled', outcomeUnknown: true, error: 'Fixture cancellation',
            cleanup: { status: 'unconfirmed', confirmed: false, warnings: ['Fixture owned exit unconfirmed'] } });
    } });
    const pending = current.inspect({ modelChain: 'antigravity' }, { signal: controller.signal });
    await current.clock.flush();
    controller.abort(new Error('Fixture cancel'));
    await current.clock.advance(20);
    const result = await pending;
    assert.equal(current.calls.length, 1);
    assert.equal(result.aiReview.modelCalls[0].outcome, 'cancelled');
    assert.equal(result.aiReview.modelCalls[0].submitted, true);
    assert.equal(result.aiReview.modelCalls[0].cleanup.confirmed, false);
});

test('background timeout settles once after bounded cleanup and ignores late result and progress', async () => {
    let release;
    const current = fixture({ maxRunMs: 100, generate: () => new Promise(resolve => { release = resolve; }) });
    const started = await current.inspect({ mode: 'all', background: true });
    await current.clock.advance(100);
    let checked = await current.inspector.checkBackgroundTask(started.taskId, 0);
    assert.equal(checked.status, 'running');
    assert.equal(checked.timedOut, true);
    assert.equal(checked.cleanupStatus, 'pending');
    await current.clock.advance(5_000);
    checked = await current.inspector.checkBackgroundTask(started.taskId, 0);
    assert.equal(checked.status, 'error');
    assert.equal(checked.cleanupStatus, 'unconfirmed');
    const before = JSON.stringify(checked);
    const finishedAt = current.inspector.backgroundTasks.get(started.taskId).finishedAt;
    release(successfulModel());
    await current.clock.flush();
    assert.equal(JSON.stringify(await current.inspector.checkBackgroundTask(started.taskId, 0)), before);
    assert.equal(current.inspector.backgroundTasks.get(started.taskId).finishedAt, finishedAt);
});

test('timeout waits for cooperative cleanup and retains its submitted unknown receipt', async () => {
    const current = fixture({ maxRunMs: 100, generate: async (request, _index, clock) => {
        await new Promise(resolve => request.signal.addEventListener('abort', resolve, { once: true }));
        await clock.sleep(20);
        return successfulModel({ text: null, outcome: 'cancelled', outcomeUnknown: true, error: 'Fixture timeout cancellation',
            cleanup: { status: 'unconfirmed', confirmed: false, warnings: ['Fixture exit still unconfirmed'] } });
    } });
    const started = await current.inspect({ background: true });
    await current.clock.advance(120);
    const checked = await current.inspector.checkBackgroundTask(started.taskId, 0);
    assert.equal(checked.mode, 'ai_review');
    assert.equal(checked.status, 'error');
    assert.equal(checked.timedOut, true);
    assert.equal(checked.cleanupStatus, 'unconfirmed');
    assert.equal(checked.result.modelCalls[0].submitted, true);
    assert.equal(checked.result.modelCalls[0].fallbackAllowed, false);
    assert.equal(checked.result.modelCalls[0].cleanup.confirmed, false);
    assert.match(checked.error, /退出尚未确认/);
});

test('background queue time consumes the task total deadline before any model submission', async () => {
    const current = fixture({ maxRunMs: 100, backgroundQueueMs: 150 });
    const started = await current.inspect({ mode: 'all', background: true });
    await current.clock.advance(150);
    const checked = await current.inspector.checkBackgroundTask(started.taskId, 0);
    assert.equal(checked.status, 'error');
    assert.equal(checked.timedOut, true);
    assert.equal(current.counts.structure, 0);
    assert.equal(current.calls.length, 0);
});
