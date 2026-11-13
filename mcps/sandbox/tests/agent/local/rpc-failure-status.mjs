import assert from 'node:assert/strict';
import test from 'node:test';
import { readableRunResult } from '../../../src/agent-server/rpc-failure-artifact.ts';

test('a not-sent failure preserves prior execution facts', () => {
    const run = { conversationId: 'owned-conversation', runId: 'owned-run', state: 'failed', completedCalls: 13,
        artifacts: ['existing-note'], unknownAttemptId: 'prior-unknown',
        failure: { acceptance: 'not_sent', error: { code: 'CONTEXT_CONFIG_INVALID', message: '分块预算不足' } } };
    const result = readableRunResult({ ok: true, data: run });
    assert.deepEqual(result.data, run);
    assert.match(result.presentation.text, /下一条模型请求未发送/);
    assert.match(result.presentation.text, /此前请求、已写文件和费用记录仍保留/);
    assert.doesNotMatch(result.presentation.text, /原请求明确未发送/);
});
