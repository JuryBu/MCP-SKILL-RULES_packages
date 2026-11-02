import { AgentFault } from '../../protocol.js';
import type { BoundToolContext, EffectKind } from '../types.js';

export type SharedServiceId = 'sandbox' | 'memory-store' | 'web-fetcher' | 'exa' | 'sequential-thinking';

export interface SharedToolSpec {
    serviceId: SharedServiceId;
    name: string;
    summary: string;
    effects: readonly EffectKind[];
    supportsTemporary: boolean;
    disabledReason?: string;
    local?: boolean;
    bind(args: Record<string, unknown>, context: BoundToolContext): Record<string, unknown>;
}

export function ownerArguments(context: BoundToolContext): Record<string, unknown> {
    return { ownerId: `sandbox-agent:${context.conversationId}:${context.rootRunId}` };
}

export function requireExact(args: Record<string, unknown>): void {
    if (args.mode !== undefined && args.mode !== 'exact') throw new AgentFault('TOOL_NOT_ALLOWED', '此工具只启用不调用外部模型的exact模式');
    for (const key of ['model', 'modelChain', 'chain', 'provider', 'apiKey']) if (key in args) throw new AgentFault('TOOL_NOT_ALLOWED', '此工具未开放模型选择分支', { field: key });
    if (args.background === true) throw new AgentFault('TOOL_CAPABILITY_UNVERIFIED', '后台能力尚未绑定认证、原请求查回和租约，当前保持关闭');
}
