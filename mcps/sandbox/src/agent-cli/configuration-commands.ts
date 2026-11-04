import { randomUUID } from 'node:crypto';
import type { AgentClient } from '../agent-client/client.js';
import { AgentFault, type RpcResult } from '../agent-server/protocol.js';
import { DEFAULT_SETTINGS, SETTING_SCHEMAS } from '../agent-server/configuration/settings.js';
import type { CliOptionValue } from './arguments.js';

export async function refreshSavedProfileCatalog(client: Pick<AgentClient, 'request'>, saved: RpcResult, signal?: AbortSignal): Promise<RpcResult> {
    if (!saved.ok || !saved.data || typeof saved.data !== 'object' || Array.isArray(saved.data)) return saved;
    const data = saved.data as Record<string, unknown>;
    const profile = data.profile && typeof data.profile === 'object' ? data.profile as Record<string, unknown> : data;
    if (typeof profile.profileId !== 'string' || !profile.profileId || !Number.isSafeInteger(profile.revision)) return saved;
    if (!profile.credentialRef && profile.configured !== true && profile.protocol !== 'progrok') return saved;
    const clientCommandId = randomUUID();
    let result: RpcResult;
    if (signal?.aborted) result = { ok: false, error: { code: 'FRONTEND_CANCELLED', message: '前台已取消，模型目录尚未刷新', retryable: true, mayHaveStarted: false } };
    else {
        try { result = await client.request('models.refresh', { profileId: profile.profileId }, { clientCommandId }); }
        catch { result = { ok: false, error: { code: 'RECEIPT_UNKNOWN', message: '模型目录刷新结果待确认，请保留原刷新回执', retryable: true, mayHaveStarted: true } }; }
    }
    return { ...saved, data: { ...data, catalogRefresh: { profileId: profile.profileId, profileRevision: profile.revision, clientCommandId, result } } };
}

export async function readConfigurationCliPreferences(client: Pick<AgentClient, 'request'>, explicit: Record<string, CliOptionValue> = {}) {
    const result = await client.request<{ revision: number; values: Record<string, unknown>; sources: Record<string, string> }>(
        'server.settings.get', { scope: 'global' });
    if (!result.ok || !result.data) throw new AgentFault(result.error?.code ?? 'CONFIGURATION_UNAVAILABLE', result.error?.message ?? '本产品全局设置暂不可读');
    const read = (key: string) => {
        const value = result.data!.values[key] ?? DEFAULT_SETTINGS[key];
        const parsed = SETTING_SCHEMAS[key].safeParse(value);
        if (!parsed.success) throw new AgentFault('CONFIGURATION_INVALID', '已保存的前台设置不符合公开类型', { key });
        return parsed.data;
    };
    return { revision: result.data.revision, sources: result.data.sources,
        enterBehavior: read('terminal.enterBehavior') as 'send' | 'newline',
        historyPageSize: read('history.pageSize') as number,
        ambiguousWidth: read('terminal.width') as 'narrow' | 'wide',
        motion: read('terminal.motion') as 'full' | 'reduced' | 'off',
        options: { ...explicit,
            graphics: explicit.graphics ?? read('terminal.graphics'),
            color: explicit.color ?? read('terminal.color'),
            'reduce-motion': explicit['reduce-motion'] ?? read('terminal.motion') !== 'full',
        } as Record<string, CliOptionValue> };
}
