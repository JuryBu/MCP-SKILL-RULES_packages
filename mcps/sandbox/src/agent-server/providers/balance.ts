import type { CredentialAccess } from './dispatch.js';
import { bearerHeaders, FetchTransport } from './http.js';
import type { HttpTransport, ProviderProfile } from './types.js';
import { providerRequestHeaders } from './request-identity.js';

export interface ProviderBalance {
    status: 'reported' | 'unavailable' | 'unsupported';
    source: string | null;
    balances: Array<{ currency: string; available: string; totalUsed?: string; granted?: string; toppedUp?: string }>;
    observedAt?: string;
    scope?: 'provider_account';
    isAvailable?: boolean;
    message?: string;
}

export type BalanceFetcher = HttpTransport['request'];

const deepseekBalanceUrl = 'https://api.deepseek.com/user/balance';

function isOfficialDeepSeek(profile: ProviderProfile): boolean {
    try {
        const base = new URL(profile.baseUrl);
        return base.protocol === 'https:' && base.hostname === 'api.deepseek.com' && !base.port
            && !base.username && !base.password && !base.search && !base.hash
            && ['', '/v1', '/anthropic'].includes(base.pathname.replace(/\/+$/, ''));
    } catch { return false; }
}

export async function readProviderBalance(profile: ProviderProfile, credentials: CredentialAccess,
    fetcher?: BalanceFetcher): Promise<ProviderBalance> {
    if (!isOfficialDeepSeek(profile)) return { status: 'unsupported', source: null, balances: [], message: '此供应商未提供已接入的官方余额查询接口' };
    const unavailable = (message: string): ProviderBalance => ({ status: 'unavailable', source: deepseekBalanceUrl, balances: [], message });
    if (!profile.credentialRef) return unavailable('尚未配置可用于查询余额的凭据引用');
    const transport = fetcher ? undefined : new FetchTransport();
    try {
        return await credentials.withCredential(profile.credentialRef, profile.credentialGeneration, async credential => {
            const response = await (fetcher ?? transport!.request.bind(transport))({ method: 'GET', url: deepseekBalanceUrl,
                headers: providerRequestHeaders(profile, { Accept: 'application/json', ...bearerHeaders(credential) }, { purpose: 'balance' }),
                timeoutMs: 5000, maxResponseBytes: 256 * 1024 });
            if (response.status !== 200) return unavailable(`官方余额查询未成功（HTTP ${response.status}）`);
            const data = JSON.parse(response.body) as Record<string, unknown>;
            if (!data || typeof data !== 'object' || typeof data.is_available !== 'boolean' || !Array.isArray(data.balance_infos)
                || !data.balance_infos.length || data.balance_infos.length > 16) return unavailable('官方余额响应缺少有效余额字段');
            const balances: ProviderBalance['balances'] = [];
            for (const value of data.balance_infos) {
                const item = value as Record<string, unknown> | null;
                if (!item || !['USD', 'CNY'].includes(String(item.currency)) || typeof item.total_balance !== 'string'
                    || item.total_balance.length > 128 || !/^-?\d+(?:\.\d+)?$/.test(item.total_balance)
                    || balances.some(balance => balance.currency === item.currency)) return unavailable('官方余额响应含无法识别的金额或币种');
                const amount = (value: unknown): value is string => typeof value === 'string' && value.length <= 128 && /^-?\d+(?:\.\d+)?$/.test(value);
                if (item.granted_balance !== undefined && !amount(item.granted_balance)
                    || item.topped_up_balance !== undefined && !amount(item.topped_up_balance)) return unavailable('官方余额分项含无法识别的金额');
                balances.push({ currency: String(item.currency), available: item.total_balance,
                    ...(amount(item.granted_balance) ? { granted: item.granted_balance } : {}),
                    ...(amount(item.topped_up_balance) ? { toppedUp: item.topped_up_balance } : {}) });
            }
            return { status: 'reported', source: deepseekBalanceUrl, balances, observedAt: new Date().toISOString(), scope: 'provider_account', isAvailable: data.is_available,
                ...(!data.is_available ? { message: '供应商报告当前余额不足以发起模型调用' } : {}) };
        });
    } catch { return unavailable('官方余额暂时无法取得，聊天仍可继续'); }
    finally { await transport?.close().catch(() => {}); }
}
