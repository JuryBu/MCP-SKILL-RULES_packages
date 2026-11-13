import type { summarizeCacheRate, UsageMetric } from '../agent-server/accounting/usage-summary.js';
import { formatLocalTimestamp } from '../agent-client/results.js';

export type UsageCompleteness = 'known' | 'partial' | 'unknown';

export interface UsageMetrics {
    inputTokens?: UsageMetric;
    outputTokens?: UsageMetric;
    totalTokens?: UsageMetric;
    cacheReadTokens?: UsageMetric;
    cacheRate?: ReturnType<typeof summarizeCacheRate>;
}

export interface UsageOverview {
    asOf: string;
    profileId?: string;
    account: { status: 'reported' | 'unavailable' | 'unsupported'; source: string | null; asOf?: string; observedAt?: string;
        scope?: 'provider_account'; isAvailable?: boolean;
        balances: { currency: string; available: string | number; totalUsed?: string | number; granted?: string | number; toppedUp?: string | number }[]; message?: string };
    conversation: { inputTokens: number; outputTokens: number; cachedInputTokens: number | null; cacheStatus?: UsageCompleteness;
        tokensStatus?: UsageCompleteness; inputTokensStatus?: UsageCompleteness; totalTokens: number; metrics?: UsageMetrics;
        costs: { currency: string; amountMicros: number }[]; amountStatus: UsageCompleteness };
    providerUsage: { scope: 'local_tool'; quotaScopeId?: string; profileId?: string;
        costs: { currency: string; amountMicros: number }[]; amountStatus: UsageCompleteness };
}

function tokenCount(value: unknown): value is number {
    return Number.isSafeInteger(value) && Number(value) >= 0;
}

function costsLabel(costs: { currency: string; amountMicros: number }[], status: UsageCompleteness): string {
    const amount = costs.filter(cost => typeof cost.currency === 'string' && Number.isSafeInteger(cost.amountMicros) && cost.amountMicros >= 0)
        .map(cost => `${cost.currency} ${(cost.amountMicros / 1_000_000).toFixed(6).replace(/\.?0+$/, '') || '0'}`).join(' / ');
    if (status === 'unknown') return '金额未知';
    if (status === 'partial') return `${amount ? '已知小计 ' + amount + ' · ' : ''}部分金额待提供`;
    return amount || '暂无计费记录';
}

export function usageOverviewLines(overview?: UsageOverview, state = '用量正在加载', options: { details?: boolean } = {}): string[] {
    if (!overview) return options.details ? [state, '尚未取得本对话用量、费用与账号余额'] : [state];
    const { account, conversation: usage } = overview;
    const totalMetric = usage.metrics?.totalTokens;
    const cacheMetric = usage.metrics?.cacheRate;
    const totalTokens = totalMetric ? totalMetric.value : usage.totalTokens;
    const tokenStatus = totalMetric?.status ?? usage.tokensStatus;
    const completeTokens = tokenStatus === 'known' && tokenCount(totalTokens);
    const partialTokens = tokenStatus === 'partial' && tokenCount(totalTokens);
    const completeInput = (usage.inputTokensStatus ?? usage.tokensStatus) === 'known' && tokenCount(usage.inputTokens);
    const completeCache = usage.cacheStatus === 'known' && tokenCount(usage.cachedInputTokens);
    const validCache = completeInput && completeCache && usage.cachedInputTokens! <= usage.inputTokens;
    const validMetric = cacheMetric?.status === 'known' && cacheMetric.missingRequests === 0
        && typeof cacheMetric.value === 'number' && Number.isFinite(cacheMetric.value) && cacheMetric.value >= 0 && cacheMetric.value <= 1;
    const cacheRate = cacheMetric ? validMetric ? `${(cacheMetric.value! * 100).toFixed(1)}%` : undefined
        : validCache && usage.inputTokens > 0 ? `${(usage.cachedInputTokens! / usage.inputTokens * 100).toFixed(1)}%` : undefined;
    const tokens = completeTokens ? `本对话 ${totalTokens} token`
        : partialTokens ? `本对话 已记录 ${totalTokens} token（部分用量）` : undefined;
    const balances = account.status === 'reported' ? account.balances.map(balance => `${balance.currency} ${balance.available}`).join(' / ') : '';
    const totalUsed = account.status === 'reported' ? account.balances.filter(balance => balance.totalUsed !== undefined)
        .map(balance => `${balance.currency} ${balance.totalUsed}`).join(' / ') : '';
    if (!options.details) {
        const lines: string[] = [];
        const usageLine = [tokens, cacheRate ? `缓存率 ${cacheRate}（本对话输入）` : undefined].filter(Boolean).join(' · ');
        if (usageLine) lines.push(usageLine);
        if (usage.amountStatus !== 'unknown' && usage.costs.length) lines.push(`对话费用 ${costsLabel(usage.costs, usage.amountStatus)}`);
        const accountLine = [balances ? `账号余额 ${balances}` : undefined, totalUsed ? `额度已消耗 ${totalUsed}` : undefined].filter(Boolean).join(' · ');
        if (accountLine) lines.push(accountLine + (account.isAvailable === false ? ' · ' + (account.message ?? '服务商报告当前账号不可用') : ''));
        return lines;
    }
    const cacheState = cacheRate ?? (cacheMetric ? cacheMetric.status === 'partial' ? '未提供，缓存请求覆盖或用量不完整'
        : cacheMetric.inputTokens === 0 && cacheMetric.reportedRequests > 0 ? '尚无输入' : '未提供，尚无完整缓存统计'
        : validCache && usage.inputTokens === 0 ? '尚无输入'
        : !completeInput ? '未提供，输入用量不完整'
        : usage.cacheStatus === 'partial' ? '未提供，缓存命中数据不完整'
        : completeCache && usage.cachedInputTokens! > usage.inputTokens ? '未提供，缓存命中数超过输入数' : '未提供，供应商尚未报告命中数');
    const providerScope = overview.providerUsage.quotaScopeId || overview.providerUsage.profileId || overview.profileId ? '当前配置配额范围' : '全部本地配置';
    const balanceDetails = account.status === 'reported' ? account.balances.map(balance => `${balance.currency} 余额 ${balance.available}`
        + (balance.toppedUp !== undefined ? ` · 充值 ${balance.toppedUp}` : '') + (balance.granted !== undefined ? ` · 赠送 ${balance.granted}` : '')) : [];
    return [tokens ?? '本对话 token：未知，供应商尚未提供完整用量', `缓存率 ${cacheState}（分母为本对话输入）`,
        ...(totalMetric ? [`用量覆盖：${totalMetric.reportedRequests} 次已报告，${totalMetric.missingRequests} 次缺失`] : []),
        ...(cacheMetric ? [`缓存覆盖：${cacheMetric.reportedRequests} 次已报告，${cacheMetric.missingRequests} 次缺失`] : []),
        `对话费用 ${costsLabel(usage.costs, usage.amountStatus)}`,
        `本工具历史账本（${providerScope}）${costsLabel(overview.providerUsage.costs, overview.providerUsage.amountStatus)}`,
        ...(balanceDetails.length ? balanceDetails : [`账号余额 ${account.status === 'unsupported' ? '当前服务商未提供此接口' : '暂不可用'}`]),
        ...(account.scope ? ['余额范围：服务商账号'] : []),
        ...(account.isAvailable !== undefined ? [`余额可用状态：${account.isAvailable ? '可用' : '暂不可用'}`] : []),
        ...(totalUsed ? [`额度已消耗 ${totalUsed}`] : []), ...(account.message ? [account.message] : []),
        `余额来源 ${account.source || '未提供'} · 采样时间 ${formatLocalTimestamp(account.observedAt ?? account.asOf)}`, `统计查询时间 ${formatLocalTimestamp(overview.asOf)}`];
}
