import type { SqlDatabase, SqlValue } from './internal.js';
import { AgentFault } from '../protocol.js';
import { summarizeUsageField, summarizeCacheRate } from '../accounting/usage-summary.js';
import type { UsageMetric } from '../accounting/usage-summary.js';
import type { NormalizedUsage } from '../accounting/usage.js';

export interface UsageSummaryMetrics {
    input: UsageMetric;
    output: UsageMetric;
    total: UsageMetric;
    cacheRead: UsageMetric;
    cacheRate: ReturnType<typeof summarizeCacheRate>;
}

function emptyMetrics(): UsageSummaryMetrics {
    return { input: summarizeUsageField([], 'inputTokens'), output: summarizeUsageField([], 'outputTokens'),
        total: summarizeUsageField([], 'totalTokens'), cacheRead: summarizeUsageField([], 'cacheReadTokens'),
        cacheRate: summarizeCacheRate([]) };
}

function readMetrics(database: SqlDatabase, where: string, values: SqlValue[]): UsageSummaryMetrics {
    const tokenField = (field: string) => `CASE WHEN json_type(usage,'$.${field}') IN ('integer','real') THEN json_extract(usage,'$.${field}') END`;
    const statement = database.prepare(`WITH normalized AS (
        SELECT quota_scope_id,execution_key,usage_revision,
        COALESCE(json_extract(usage_json,'$.normalized'),json_extract(usage_json,'$.settlement.normalized'),usage_json,'{}') AS usage
        FROM charges WHERE ${where} AND component = 'model_usage'
    ), unique_usage AS (
        SELECT usage,ROW_NUMBER() OVER (PARTITION BY quota_scope_id,execution_key ORDER BY usage_revision DESC) AS position
        FROM normalized
    ), projected AS (
        SELECT json_object('inputTokens',${tokenField('inputTokens')},
            'outputTokens',${tokenField('outputTokens')},'totalTokens',${tokenField('totalTokens')},
            'cacheReadTokens',${tokenField('cacheReadTokens')},'cacheWriteTokens',${tokenField('cacheWriteTokens')},
            'inputIncludesCache',CASE WHEN json_extract(usage,'$.inputIncludesCache') = 1 THEN 1 ELSE 0 END,
            'issues',json((SELECT json_group_array(DISTINCT value) FROM json_each(usage,'$.issues')
                WHERE value IN ('partial_stream_usage','progrok_total_token_bucket_mismatch','cache_read_exceeds_input','input_bucket_mismatch')))) AS metric_usage
        FROM unique_usage WHERE position = 1
    ) SELECT metric_usage,COUNT(*) AS requests FROM projected GROUP BY metric_usage`);
    if (!statement.iterate) throw new AgentFault('STORAGE_UNAVAILABLE', 'SQLite未提供有界用量统计读取接口');
    const metrics = emptyMetrics();
    const overflow = new Set<string>();
    let rateComplete = true;
    const fields = { input: 'inputTokens', output: 'outputTokens', total: 'totalTokens', cacheRead: 'cacheReadTokens' } as const;
    for (const row of statement.iterate(...values)) {
        const usage = JSON.parse(String(row.metric_usage)) as NormalizedUsage;
        const requests = Number(row.requests);
        for (const key of ['input', 'output', 'total', 'cacheRead'] as const) {
            const metric = summarizeUsageField([usage], fields[key]);
            const target = metrics[key];
            const previousRequests = target.reportedRequests + target.missingRequests;
            const complete = (previousRequests === 0 || target.status === 'known') && metric.status === 'known';
            target.reportedRequests += metric.reportedRequests * requests;
            target.missingRequests += metric.missingRequests * requests;
            if (metric.value !== null) {
                const total = (target.value ?? 0) + metric.value * requests;
                if (!Number.isSafeInteger(total)) overflow.add(key);
                target.value = overflow.has(key) ? null : total;
            }
            target.status = overflow.has(key) || !target.reportedRequests ? 'unknown' : complete ? 'known' : 'partial';
        }
        const rate = summarizeCacheRate([usage]);
        metrics.cacheRate.cachedTokens += rate.cachedTokens * requests;
        metrics.cacheRate.inputTokens += rate.inputTokens * requests;
        metrics.cacheRate.reportedRequests += rate.reportedRequests * requests;
        metrics.cacheRate.missingRequests += rate.missingRequests * requests;
        if (rate.missingRequests || usage.issues.some(issue => ['partial_stream_usage','cache_read_exceeds_input','input_bucket_mismatch'].includes(issue))) rateComplete = false;
    }
    const rate = metrics.cacheRate;
    const rateKnown = Number.isSafeInteger(rate.cachedTokens) && Number.isSafeInteger(rate.inputTokens)
        && rate.reportedRequests > 0 && rate.inputTokens > 0;
    rate.value = rateKnown ? rate.cachedTokens / rate.inputTokens : null;
    rate.status = !rateKnown ? 'unknown' : rateComplete ? 'known' : 'partial';
    return metrics;
}

export interface UsageQuery {
    rootBudgetIds?: string[];
    quotaScopeId?: string;
}

export interface UsageSummary {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    totalTokens: number;
    costs: { currency: string; amountMicros: number }[];
    amountStatus: 'known' | 'partial' | 'unknown';
    tokensStatus: 'known' | 'partial' | 'unknown';
    cacheStatus: 'known' | 'partial' | 'unknown';
    metrics: UsageSummaryMetrics;
}

export function emptyUsageSummary(): UsageSummary {
    return { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, totalTokens: 0,
        costs: [], amountStatus: 'known', tokensStatus: 'known', cacheStatus: 'known', metrics: emptyMetrics() };
}

export function readUsageSummary(database: SqlDatabase, query: UsageQuery): UsageSummary {
    if (query.rootBudgetIds?.length === 0) return emptyUsageSummary();
    const clauses: string[] = [];
    const values: SqlValue[] = [];
    if (query.rootBudgetIds) {
        clauses.push('root_budget_id IN (SELECT value FROM json_each(?))');
        values.push(JSON.stringify([...new Set(query.rootBudgetIds)]));
    }
    if (query.quotaScopeId) {
        clauses.push('quota_scope_id = ?');
        values.push(query.quotaScopeId);
    }
    const where = clauses.length ? clauses.join(' AND ') : '1 = 1';
    const amounts = database.prepare(`SELECT json_extract(record_json,'$.currency') AS currency,
        SUM(amount_micros) AS amount FROM charges WHERE ${where} AND amount_micros IS NOT NULL
        GROUP BY json_extract(record_json,'$.currency')`).all(...values);
    const unknownCharges = database.prepare(`SELECT COUNT(*) AS count FROM charges
        WHERE ${where} AND amount_micros IS NULL`).get(...values);
    const pending = database.prepare(`SELECT COUNT(*) AS count FROM reservations
        WHERE ${where} AND state IN ('reserved','dispatched','unknown','unsettled')`).get(...values);
    const tokens = database.prepare(`WITH normalized AS (
        SELECT quota_scope_id,execution_key,usage_revision,
        COALESCE(json_extract(usage_json,'$.normalized'),json_extract(usage_json,'$.settlement.normalized'),usage_json,'{}') AS usage
        FROM charges WHERE ${where} AND component = 'model_usage'
    ), unique_usage AS (
        SELECT usage,ROW_NUMBER() OVER (PARTITION BY quota_scope_id,execution_key ORDER BY usage_revision DESC) AS position
        FROM normalized
    ) SELECT COUNT(*) AS count,
        SUM(COALESCE(json_extract(usage,'$.inputTokens'),0)
            + CASE WHEN json_extract(usage,'$.inputIncludesCache') = 0
                THEN COALESCE(json_extract(usage,'$.cacheReadTokens'),0) + COALESCE(json_extract(usage,'$.cacheWriteTokens'),0) ELSE 0 END) AS input_tokens,
        SUM(COALESCE(json_extract(usage,'$.outputTokens'),0)) AS output_tokens,
        SUM(CASE WHEN json_extract(usage,'$.outputIncludesReasoning') = 0
            THEN COALESCE(json_extract(usage,'$.reasoningTokens'),0) ELSE 0 END) AS additional_reasoning_tokens,
        SUM(COALESCE(json_extract(usage,'$.cacheReadTokens'),0)) AS cached_tokens,
        SUM(CASE WHEN json_extract(usage,'$.cacheReadTokens') IS NULL THEN 1 ELSE 0 END) AS unknown_cache_tokens,
        SUM(CASE WHEN json_extract(usage,'$.inputTokens') IS NULL OR json_extract(usage,'$.outputTokens') IS NULL THEN 1 ELSE 0 END) AS unknown_tokens
        FROM unique_usage WHERE position = 1`).get(...values);
    const costs = amounts.map(row => ({ currency: String(row.currency ?? 'XXX'), amountMicros: Number(row.amount ?? 0) }));
    const inputTokens = Number(tokens?.input_tokens ?? 0);
    const outputTokens = Number(tokens?.output_tokens ?? 0);
    const unknown = Number(unknownCharges?.count ?? 0) + Number(pending?.count ?? 0) > 0;
    const metrics = readMetrics(database, where, values);
    const tokenStatuses = [metrics.input.status, metrics.output.status, metrics.total.status];
    return { inputTokens, outputTokens, cachedInputTokens: Number(tokens?.cached_tokens ?? 0), totalTokens: inputTokens + outputTokens + Number(tokens?.additional_reasoning_tokens ?? 0),
        costs, amountStatus: unknown ? costs.length ? 'partial' : 'unknown' : 'known',
        tokensStatus: tokenStatuses.every(status => status === 'known') ? 'known' : tokenStatuses.every(status => status === 'unknown') ? 'unknown' : 'partial',
        cacheStatus: metrics.cacheRead.status, metrics };
}
