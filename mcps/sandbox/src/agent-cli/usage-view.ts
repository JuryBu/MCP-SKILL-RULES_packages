export interface UsageOverview {
    asOf: string;
    profileId?: string;
    account: { status: 'reported' | 'unavailable' | 'unsupported'; source: string | null;
        balances: { currency: string; available: string | number; totalUsed?: string | number }[]; message?: string };
    conversation: { inputTokens: number; outputTokens: number; cachedInputTokens: number | null; cacheStatus?: 'known' | 'partial' | 'unknown'; totalTokens: number;
        costs: { currency: string; amountMicros: number }[]; amountStatus: 'known' | 'partial' | 'unknown' };
    providerUsage: { scope: 'local_tool'; costs: { currency: string; amountMicros: number }[]; amountStatus: 'known' | 'partial' | 'unknown' };
}

function costsLabel(costs: { currency: string; amountMicros: number }[], status: string): string {
    const amount = costs.map(cost => `${cost.currency} ${(cost.amountMicros / 1_000_000).toFixed(6).replace(/\.?0+$/, '') || '0'}`).join(' / ');
    return status === 'known' ? amount || '0' : `${amount ? amount + ' · ' : ''}${status === 'partial' ? '部分金额待提供' : '金额未提供'}`;
}

export function usageOverviewLines(overview?: UsageOverview, state = '用量正在加载'): string[] {
    if (!overview) return ['本对话 token未提供 · 缓存率未提供', '对话费用 未提供 · 本工具累计 未提供', `API已用 未提供 · 余额 未提供 · ${state}`];
    const account = overview.account;
    const balances = account.status === 'reported' && account.balances.length
        ? account.balances.map(balance => `${balance.currency} 余额 ${balance.available}`).join(' / ')
        : `API余额${account.status === 'unsupported' ? '未提供' : '暂不可用'}${account.message ? ' · ' + account.message : ''}`;
    const usage = overview.conversation;
    const cached = usage.cachedInputTokens;
    const knownCache = typeof cached === 'number' && Number.isFinite(cached) && cached >= 0;
    const cacheRate = usage.cacheStatus === 'partial' ? '数据不完整'
        : usage.cacheStatus !== 'known' || !knownCache ? '未提供'
        : usage.inputTokens > 0 ? `${(cached / usage.inputTokens * 100).toFixed(1)}%` : '—（尚无输入）';
    const totalUsed = account.balances.filter(balance => balance.totalUsed !== undefined).map(balance => `${balance.currency} ${balance.totalUsed}`).join(' / ');
    return [`本对话 ${usage.totalTokens} token · 缓存率 ${cacheRate}（本对话输入）`,
        `对话费用 ${costsLabel(usage.costs, usage.amountStatus)} · 本工具累计 ${costsLabel(overview.providerUsage.costs, overview.providerUsage.amountStatus)}`,
        `API已用 ${totalUsed || '未提供'} · ${balances} · 来源 ${account.source || '未提供'}`];
}
