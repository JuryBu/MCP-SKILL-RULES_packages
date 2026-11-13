import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readUsageSummary } from '../../../src/agent-server/storage/usage.ts';
import { summarizeUsageField, summarizeCacheRate } from '../../../src/agent-server/accounting/usage-summary.ts';
import { SqliteStore } from '../../../src/agent-server/storage/sqlite.ts';

const normalized = overrides => ({ inputTokens: 10, outputTokens: 2, totalTokens: 12,
    cacheReadTokens: 0, cacheWriteTokens: 0, inputIncludesCache: true, outputIncludesReasoning: true,
    issues: [], ...overrides });

function databaseFor(usages) {
    const database = new DatabaseSync(':memory:');
    database.exec(`CREATE TABLE charges (root_budget_id TEXT, quota_scope_id TEXT, execution_key TEXT,
        usage_revision INTEGER, component TEXT, amount_micros INTEGER, record_json TEXT, usage_json TEXT);
        CREATE TABLE reservations (root_budget_id TEXT, quota_scope_id TEXT, state TEXT);`);
    const insert = database.prepare('INSERT INTO charges VALUES (?,?,?,?,?,?,?,?)');
    for (const [index, usage] of usages.entries()) insert.run('root', 'scope', `request-${index}`, 1,
        'model_usage', 1, '{"currency":"USD"}', JSON.stringify(index % 2 ? { settlement: { normalized: usage } } : { normalized: usage }));
    return database;
}

function expected(usages) {
    return { input: summarizeUsageField(usages, 'inputTokens'), output: summarizeUsageField(usages, 'outputTokens'),
        total: summarizeUsageField(usages, 'totalTokens'), cacheRead: summarizeUsageField(usages, 'cacheReadTokens'),
        cacheRate: summarizeCacheRate(usages) };
}

test('SQL metric projection and grouped request counts match shared helpers for complete, partial and missing usage', () => {
    const cases = [[], [normalized({})], [normalized({ cacheReadTokens: 0 }), normalized({ cacheReadTokens: null })],
        [normalized({ inputTokens: 20, cacheReadTokens: 5 }), normalized({ inputTokens: 10, cacheReadTokens: 4,
            cacheWriteTokens: 2, inputIncludesCache: false })],
        [normalized({ inputTokens: null, totalTokens: null, outputTokens: 0, cacheReadTokens: null }), normalized({})],
        [normalized({ issues: ['partial_stream_usage'] }), normalized({})],
        [normalized({ issues: ['progrok_total_token_bucket_mismatch'] }), normalized({})],
        [normalized({ issues: ['cache_read_exceeds_input'] }), normalized({})],
        [normalized({ issues: ['input_bucket_mismatch'] }), normalized({})],
        [normalized({ inputTokens: 0, cacheReadTokens: 0, issues: ['partial_stream_usage'] }), normalized({})],
        [normalized({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }), normalized({})],
        [normalized({ inputTokens: 0, outputTokens: 0, totalTokens: 0 })],
        [normalized({ inputTokens: '10', cacheReadTokens: 0.5, totalTokens: -1 }), normalized({})],
        Array.from({ length: 1000 }, () => normalized({ cacheReadTokens: 3 }))];
    for (const usages of cases) {
        const database = databaseFor(usages);
        try { assert.deepEqual(readUsageSummary(database, { rootBudgetIds: ['root'] }).metrics, expected(usages)); }
        finally { database.close(); }
    }
});

test('latest revision is counted once and scope filters exclude other requests', () => {
    const database = databaseFor([normalized({ inputTokens: 3 }), normalized({ inputTokens: 5 })]);
    try {
        const selected = normalized({ inputTokens: 27, cacheReadTokens: 7 });
        database.prepare('INSERT INTO charges VALUES (?,?,?,?,?,?,?,?)').run('root', 'scope', 'request-0', 2,
            'model_usage', 2, '{"currency":"USD"}', JSON.stringify({ normalized: selected }));
        database.prepare('UPDATE charges SET root_budget_id = ?,quota_scope_id = ? WHERE execution_key = ?')
            .run('other-root', 'other-scope', 'request-1');
        const result = readUsageSummary(database, { rootBudgetIds: ['root'], quotaScopeId: 'scope' });
        assert.deepEqual(result.metrics, expected([selected]));
        assert.deepEqual(readUsageSummary(database, { rootBudgetIds: [] }).metrics, expected([]));
    } finally { database.close(); }
});

test('true zero stays known and partial requests never become known at summary level', () => {
    const database = databaseFor([normalized({ inputTokens: 0, outputTokens: 0, totalTokens: 0,
        issues: ['partial_stream_usage'] })]);
    try {
        const result = readUsageSummary(database, {});
        assert.equal(result.metrics.input.value, 0);
        assert.equal(result.metrics.input.status, 'partial');
        assert.equal(result.tokensStatus, 'partial');
        assert.equal(result.cacheStatus, 'partial');
        assert.equal(result.metrics.cacheRate.value, null);
        assert.equal(result.metrics.cacheRate.status, 'unknown');
    } finally { database.close(); }
});

test('only a bounded scalar usage projection crosses the SQL reader', () => {
    const usages = Array.from({ length: 1200 }, () => normalized({ cacheReadTokens: 2,
        raw: { body: 'private-original-usage-must-not-be-returned'.repeat(100) } }));
    const database = databaseFor(usages);
    let projectedRows = 0;
    const adapter = { prepare(sql) {
        const statement = database.prepare(sql);
        return { get: (...values) => statement.get(...values), all: (...values) => statement.all(...values),
            *iterate(...values) {
                assert.ok(sql.includes('GROUP BY metric_usage'));
                assert.ok(!sql.includes('provider_attempt_journal'));
                for (const row of statement.iterate(...values)) {
                    projectedRows++;
                    assert.ok(Buffer.byteLength(row.metric_usage) < 512);
                    assert.ok(!row.metric_usage.includes('private-original'));
                    yield row;
                }
            } };
    } };
    try {
        assert.deepEqual(readUsageSummary(adapter, {}).metrics, expected(usages));
        assert.equal(projectedRows, 1);
    } finally { database.close(); }
});

test('SQLite worker readUsage returns metrics from the real accounting port', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'usage-metrics-20261113-'));
    const store = await SqliteStore.open({ dataDir });
    try {
        const rootBudgetId = randomUUID();
        const attemptId = randomUUID();
        const usage = normalized({ inputTokens: 19, outputTokens: 4, totalTokens: 23, cacheReadTokens: 3,
            issues: ['partial_stream_usage'] });
        await store.executeAccounting({ type: 'create_budget', definition: { rootBudgetId, mode: 'hard', currency: 'USD',
            maxCostMicros: 1000, maxModelCalls: 4, maxOutputTokens: 64,
            deadlineAt: new Date(Date.now() + 60_000).toISOString(), sourceRef: 'local-fixture-no-request' } });
        await store.executeAccounting({ type: 'reserve', rootBudgetId, attemptId, actionId: randomUUID(),
            quotaScopeId: 'metrics-fixture', snapshotHash: 'f'.repeat(64),
            upperBound: { currency: 'USD', amountMicros: 100, reliable: true, source: 'fixture', sourceRef: 'local-fixture' } });
        await store.executeAccounting({ type: 'dispatch', attemptId });
        await store.executeAccounting({ type: 'settle', attemptId, usageRevision: 1, providerExecutionId: 'metrics-execution', complete: true,
            charges: [{ component: 'model_usage', amountMicros: 5, currency: 'USD', usage: { normalized: usage }, kind: 'provider_reported' }] });
        const result = await store.readUsage({ rootBudgetIds: [rootBudgetId] });
        assert.deepEqual(result.metrics, expected([usage]));
        assert.equal(result.tokensStatus, 'partial');
        assert.equal(result.cacheStatus, 'partial');
    } finally { await store.close(); await rm(dataDir, { recursive: true, force: true }); }
});
