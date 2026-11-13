import assert from 'node:assert/strict';
import test from 'node:test';
import { presentAgentResult } from '../../../src/tools/agent.ts';

test('a successful query presents the original failed execution clearly and retains the complete JSON result', () => {
    const original = { ok: true, data: { runId: 'original-run', state: 'failed', resultStatus: 'failed',
        failure: { error: { code: 'ORIGINAL_PROVIDER_ERROR', message: '供应商拒绝了原请求' } },
        failureArtifact: { artifactId: 'attempt:original-attempt' } },
        presentation: { format: 'markdown', text: '### 原执行失败\n\n供应商拒绝了原请求\n\n原件：`attempt:original-attempt`' } };
    const result = presentAgentResult(original);
    assert.equal(result.isError, false);
    assert.match(result.content[0].text, /^### 原执行失败/);
    assert.match(result.content[0].text, /"queryOk":true,"executionState":"failed"/);
    assert.match(result.content[0].text, /attempt:original-attempt/);
    assert.deepEqual(result.structuredContent, original);
});

test('an RPC failure retains the original code, acceptance uncertainty, retry flags and failure signal', () => {
    const original = { ok: false, error: { code: 'ORIGINAL_TIMEOUT', message: '原请求结果待核实',
        retryable: false, mayHaveStarted: true, details: { attemptId: 'original-attempt' } } };
    const result = presentAgentResult(original);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /^### 调用未完成/);
    assert.match(result.content[0].text, /"mayHaveStarted":true/);
    assert.deepEqual(result.structuredContent, original);
});

test('ordinary results keep the previous JSON text and structured view unchanged', () => {
    const original = { ok: true, data: { state: 'running', visibleText: '正文' } };
    const result = presentAgentResult(original);
    assert.equal(result.content[0].text, JSON.stringify(original));
    assert.deepEqual(result.structuredContent, original);
    assert.equal(result.isError, false);
});
