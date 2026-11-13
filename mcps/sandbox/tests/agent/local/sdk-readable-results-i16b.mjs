import assert from 'node:assert/strict';
import test from 'node:test';
import { usageOverviewLines } from '../../../src/agent-cli/usage-view.ts';
import { interactiveResultLines } from '../../../src/agent-cli/ui-results.ts';
import { runFailureLines } from '../../../src/agent-cli/run-view.ts';
import { summarizeCacheRate, summarizeUsageField } from '../../../src/agent-server/accounting/usage-summary.ts';

function overview() {
    return { asOf: '2026-11-11T03:05:20Z', account: { status: 'reported', source: 'provider-balance', balances: [{ currency: 'CNY', available: '17.92' }] },
        conversation: { inputTokens: 8087, outputTokens: 706, cachedInputTokens: 0, totalTokens: 8793,
            tokensStatus: 'known', cacheStatus: 'known', costs: [], amountStatus: 'unknown' },
        providerUsage: { scope: 'local_tool', costs: [{ currency: 'USD', amountMicros: 29490 }], amountStatus: 'partial' } };
}

test('the existing complete two-round zero-cache evidence stays 8793 and 0.0 percent', () => {
    const lines = usageOverviewLines(overview()).join('\n');
    assert.match(lines, /8793 token/);
    assert.match(lines, /缓存率 0\.0%/);
    assert.match(lines, /17\.92/);
    assert.doesNotMatch(lines, /0\.02949|API已用|未提供/);
});

test('unknown and partial token totals are never presented as complete', () => {
    const source = overview();
    source.conversation.tokensStatus = 'unknown';
    assert.doesNotMatch(usageOverviewLines(source).join('\n'), /8793|0\.0%/);
    source.conversation.tokensStatus = 'partial';
    const lines = usageOverviewLines(source).join('\n');
    assert.match(lines, /已记录 8793 token.*部分/);
    assert.doesNotMatch(lines, /0\.0%/);
});

test('a cache ratio requires both a complete denominator and a consistent cache count', () => {
    const source = overview();
    source.conversation.cachedInputTokens = 9000;
    assert.doesNotMatch(usageOverviewLines(source).join('\n'), /111\.3%/);
    source.conversation.cachedInputTokens = 0;
    source.conversation.cacheStatus = 'partial';
    assert.doesNotMatch(usageOverviewLines(source).join('\n'), /缓存率 0\.0%/);
});

test('an independently complete input denominator remains usable when only output is partial', () => {
    const source = overview();
    source.conversation.tokensStatus = 'partial';
    source.conversation.inputTokensStatus = 'known';
    assert.match(usageOverviewLines(source).join('\n'), /缓存率 0\.0%/);
    source.conversation.inputTokensStatus = 'partial';
    assert.doesNotMatch(usageOverviewLines(source).join('\n'), /缓存率 0\.0%/);
});

test('partial conversation amounts retain currency and known subtotal without mixing in historical ledger', () => {
    const source = overview();
    source.conversation.costs = [{ currency: 'USD', amountMicros: 1234 }, { currency: 'CNY', amountMicros: 20000 }];
    source.conversation.amountStatus = 'partial';
    const lines = usageOverviewLines(source).join('\n');
    assert.match(lines, /对话费用 已知小计 USD 0\.001234 \/ CNY 0\.02/);
    assert.match(lines, /部分金额/);
    assert.doesNotMatch(lines, /0\.02949/);
});

test('account sampling time is not invented from the current overview query time', () => {
    const source = overview();
    const lines = usageOverviewLines(source, undefined, { details: true });
    assert.match(lines.find(line => line.startsWith('余额来源')), /采样时间 未提供/);
    assert.ok(lines.find(line => line.startsWith('统计查询时间')).includes(new Date(source.asOf).toLocaleTimeString('zh-CN', { hour12: false })));
    source.account.asOf = '2026-11-11T03:05:00Z';
    assert.ok(usageOverviewLines(source, undefined, { details: true }).find(line => line.startsWith('余额来源'))
        .includes(new Date(source.account.asOf).toLocaleTimeString('zh-CN', { hour12: false })));
});

test('provider summary metrics preserve the original two-round zero-cache result', () => {
    const usages = [{ inputTokens: 3950, outputTokens: 172, totalTokens: 4122, cacheReadTokens: 0, cacheWriteTokens: 0, inputIncludesCache: true, issues: [] },
        { inputTokens: 4137, outputTokens: 534, totalTokens: 4671, cacheReadTokens: 0, cacheWriteTokens: 0, inputIncludesCache: true, issues: [] }];
    const source = overview();
    source.conversation.metrics = { totalTokens: summarizeUsageField(usages, 'totalTokens'), cacheRate: summarizeCacheRate(usages) };
    const lines = usageOverviewLines(source).join('\n');
    assert.match(lines, /8793 token/);
    assert.match(lines, /缓存率 0\.0%/);
    assert.match(usageOverviewLines(source, undefined, { details: true }).join('\n'), /缓存覆盖：2 次已报告，0 次缺失/);
});

test('a provider partial denominator overrides optimistic legacy aggregate flags', () => {
    const usages = [{ inputTokens: 10, outputTokens: 2, totalTokens: 12, cacheReadTokens: 0, cacheWriteTokens: 0, inputIncludesCache: true, issues: [] },
        { inputTokens: 10, outputTokens: 2, totalTokens: null, cacheReadTokens: 0, cacheWriteTokens: null, inputIncludesCache: false, issues: [] }];
    const source = overview();
    source.conversation.metrics = { totalTokens: summarizeUsageField(usages, 'totalTokens'), cacheRate: summarizeCacheRate(usages) };
    const lines = usageOverviewLines(source).join('\n');
    assert.match(lines, /已记录 12 token（部分用量）/);
    assert.doesNotMatch(lines, /0\.0%|8793/);
    const detail = usageOverviewLines(source, undefined, { details: true }).join('\n');
    assert.match(detail, /缓存覆盖：1 次已报告，1 次缺失/);
    assert.match(detail, /缓存请求覆盖或用量不完整/);
});

test('provider-account balance details preserve recharge, grant, availability and sampling scope', () => {
    const source = overview();
    source.account = { status: 'reported', source: 'provider-balance', observedAt: '2026-11-11T03:05:00Z', scope: 'provider_account', isAvailable: false,
        message: '供应商报告当前余额不足以发起模型调用', balances: [{ currency: 'CNY', available: '17.92', toppedUp: '16.92', granted: '1.00' }] };
    const compact = usageOverviewLines(source).join('\n');
    assert.match(compact, /余额不足以发起模型调用/);
    assert.doesNotMatch(compact, /额度已消耗/);
    const detail = usageOverviewLines(source, undefined, { details: true }).join('\n');
    assert.match(detail, /充值 16\.92 · 赠送 1\.00/);
    assert.match(detail, /余额范围：服务商账号/);
    assert.match(detail, /余额可用状态：暂不可用/);
    assert.ok(detail.includes(new Date(source.account.observedAt).toLocaleTimeString('zh-CN', { hour12: false })));
    assert.match(detail, /（本机时间）/);
});

test('details distinguish historical local-tool costs, unknown amount and observation time', () => {
    const lines = usageOverviewLines(overview(), undefined, { details: true }).join('\n');
    assert.match(lines, /本工具历史账本/);
    assert.match(lines, /部分金额/);
    assert.match(lines, /对话费用.*未知|对话费用.*未提供/);
    assert.match(lines, /统计查询时间.*2026/);
    assert.doesNotMatch(lines, /T03:05:20Z/);
    assert.match(lines, /provider-balance/);
});

test('a failed RPC shows the original error and recovery identity instead of an empty object', () => {
    const result = { ok: false, error: { code: 'RECEIPT_UNKNOWN', message: '原写命令回执待确认', mayHaveStarted: true, retryable: true,
        details: { clientCommandId: 'original-command', requestId: 'original-request', operationPhase: 'request' } } };
    const lines = interactiveResultLines({ method: 'conversations.create', result }).join('\n');
    assert.match(lines, /RECEIPT_UNKNOWN/);
    assert.match(lines, /original-command/);
    assert.match(lines, /original-request/);
    assert.doesNotMatch(lines, /^\{\}$/);
});

test('successful run lookup stays separate from the failed run and preserves raw references', () => {
    const run = { runId: 'owned-run', state: 'failed', resultStatus: 'partial', failure: { acceptance: 'rejected', attemptId: 'original-attempt',
        error: { code: 'E_PARAMETER_INVALID', message: 'unsupported country or region', details: { responseArtifactId: 'original-response' } } } };
    const lines = interactiveResultLines({ method: 'runs.get', result: { ok: true, data: run } }).join('\n');
    assert.match(lines, /查询.*成功|查询.*完成/);
    assert.match(lines, /E_PARAMETER_INVALID/);
    assert.match(lines, /original-attempt/);
    assert.match(lines, /original-response/);
    assert.match(lines, /地区|账号/);
    assert.match(lines, /部分/);
    assert.ok(runFailureLines(run).length > 0);
});

test('CLI consumes server presentation while preserving business state, original failure reference and full JSON view', () => {
    const result = { ok: true, data: { state: 'failed', resultStatus: 'partial', failure: { error: { code: 'ORIGINAL_CODE', message: 'raw-message' } },
        failureArtifact: { method: 'conversations.readArtifact', conversationId: 'owned-conversation', artifactId: 'attempt:owned-attempt' } },
        presentation: { format: 'markdown', text: '### 原执行失败\n\n服务端可读说明' } };
    const original = structuredClone(result);
    const lines = interactiveResultLines({ method: 'runs.get', result }).join('\n');
    assert.match(lines, /服务端可读说明/);
    assert.match(lines, /查询已完成/);
    assert.match(lines, /目标执行状态：failed/);
    assert.match(lines, /ORIGINAL_CODE/);
    assert.match(lines, /attempt:owned-attempt/);
    assert.match(lines, /部分内容/);
    const raw = JSON.parse(interactiveResultLines({ method: 'runs.get', result }, { raw: true }).join('\n'));
    assert.equal(raw.ok, true);
    assert.equal(raw.data.state, 'failed');
    assert.equal(raw.data.failure.error.code, 'ORIGINAL_CODE');
    assert.equal(raw.presentation.text, result.presentation.text);
    assert.deepEqual(result, original);
});

test('presentation never changes a failed RPC into query success', () => {
    const result = { ok: false, error: { code: 'ORIGINAL_FAILURE', message: 'raw failure', mayHaveStarted: false, retryable: false },
        presentation: { format: 'markdown', text: '业务未完成的可读说明' } };
    const lines = interactiveResultLines({ method: 'runs.get', result }).join('\n');
    assert.match(lines, /业务未完成的可读说明/);
    assert.match(lines, /ORIGINAL_FAILURE/);
    assert.doesNotMatch(lines, /查询已完成/);
    assert.equal(result.ok, false);
});
