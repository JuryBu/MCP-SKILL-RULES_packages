import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { readUsageSummary } from '../../../src/agent-server/storage/usage.ts';

function summary(usage) {
    const database = new DatabaseSync(':memory:');
    try {
        database.exec(`CREATE TABLE charges (root_budget_id TEXT, quota_scope_id TEXT, execution_key TEXT,
            usage_revision INTEGER, component TEXT, amount_micros INTEGER, record_json TEXT, usage_json TEXT);
            CREATE TABLE reservations (root_budget_id TEXT, quota_scope_id TEXT, state TEXT);`);
        database.prepare('INSERT INTO charges VALUES (?,?,?,?,?,?,?,?)').run('root', 'scope', 'request', 1,
            'model_usage', null, '{}', JSON.stringify({ normalized: usage }));
        return readUsageSummary(database, { rootBudgetIds: ['root'] });
    } finally { database.close(); }
}

test('conversation total includes separately reported reasoning while preserving visible output counts', () => {
    const result = summary({ inputTokens: 3448, outputTokens: 4, reasoningTokens: 74,
        inputIncludesCache: true, outputIncludesReasoning: false });
    assert.equal(result.inputTokens, 3448);
    assert.equal(result.outputTokens, 4);
    assert.equal(result.totalTokens, 3526);
    assert.equal(result.amountStatus, 'unknown');
});

test('reasoning already included in output is counted once', () => {
    assert.equal(summary({ inputTokens: 20, outputTokens: 10, reasoningTokens: 6,
        outputIncludesReasoning: true }).totalTokens, 30);
});

test('an unspecified inclusion relationship does not invent additional usage', () => {
    assert.equal(summary({ inputTokens: 20, outputTokens: 10, reasoningTokens: 6 }).totalTokens, 30);
});
