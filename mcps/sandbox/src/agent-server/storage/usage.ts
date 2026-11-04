import type { SqlDatabase, SqlValue } from './internal.js';

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
}

export function emptyUsageSummary(): UsageSummary {
    return { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, totalTokens: 0,
        costs: [], amountStatus: 'known', tokensStatus: 'known', cacheStatus: 'known' };
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
    const unknownTokens = Number(tokens?.unknown_tokens ?? 0);
    const unknownCache = Number(tokens?.unknown_cache_tokens ?? 0);
    return { inputTokens, outputTokens, cachedInputTokens: Number(tokens?.cached_tokens ?? 0), totalTokens: inputTokens + outputTokens + Number(tokens?.additional_reasoning_tokens ?? 0),
        costs, amountStatus: unknown ? costs.length ? 'partial' : 'unknown' : 'known',
        tokensStatus: unknownTokens ? unknownTokens === Number(tokens?.count ?? 0) ? 'unknown' : 'partial' : 'known',
        cacheStatus: unknownCache ? unknownCache === Number(tokens?.count ?? 0) ? 'unknown' : 'partial' : 'known' };
}
