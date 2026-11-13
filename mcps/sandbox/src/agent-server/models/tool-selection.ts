import { AgentFault } from '../protocol.js';
import type { ProviderProfile } from '../providers/types.js';
import { modelScope } from './catalog.js';
import type { ModelEntry } from './catalog.js';
import { requireEvidence } from './evidence.js';

export function selectRequestedTools(options: Record<string, unknown>, profile: ProviderProfile, entry: ModelEntry,
    now = Date.now()): string[] | null {
    const configured = Array.isArray(options.tools) ? options.tools.filter((tool): tool is string => typeof tool === 'string') : null;
    if (options.toolsEnabled === false || configured?.length === 0) return [];
    if (options.toolsEnabled === true || configured?.length) {
        if (!requireEvidence(entry.tools, modelScope(profile, entry.modelId, entry.routeId), now)) {
            throw new AgentFault('E_PARAMETER_UNSUPPORTED', '当前模型明确不支持工具调用，请更换模型或明确关闭工具');
        }
    }
    return configured ?? (entry.tools.status === 'supported' && entry.tools.value === true ? null : []);
}
