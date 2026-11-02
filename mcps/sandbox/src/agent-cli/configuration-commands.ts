import type { AgentClient } from '../agent-client/client.js';
import { AgentFault } from '../agent-server/protocol.js';
import { DEFAULT_SETTINGS, SETTING_SCHEMAS } from '../agent-server/configuration/settings.js';
import type { CliOptionValue } from './arguments.js';

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
