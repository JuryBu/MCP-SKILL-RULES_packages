import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AgentParamsSchema, handleAgentCall, validateAgentCallParams } from './agent.js';
import { AgentFault, failure, type RpcResult } from '../agent-server/protocol.js';
import { ProgrokAdapter } from '../agent-server/providers/progrok.js';
import type { ProviderProfile } from '../agent-server/providers/types.js';
import { touchActivity } from '../lifecycle.js';

export const GrokParamsSchema = AgentParamsSchema.extend({
    profileId: z.string().min(1).max(512).optional().describe('已有protocol=progrok配置；未指定时只自动选择唯一的Progrok配置，不创建或修改全局配置'),
    modelId: z.string().min(1).max(512).optional().describe('创建、更新会话或启动任务时选模型；默认沿用原会话、配置默认模型，再用SANDBOX_PROGROK_MODEL或grok-4.5'),
}).strict();

type GrokCall = z.infer<typeof GrokParamsSchema>;
const selectionActions = new Set(['conversations.create', 'conversations.update', 'runs.start']);

function object(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function textValue(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function selectedValue(name: 'profileId' | 'modelId', values: unknown[]): string | undefined {
    const present = values.filter(value => value !== undefined);
    if (present.some(value => !textValue(value)) || new Set(present).size > 1) {
        throw new AgentFault('E_MODEL_CONFLICT', `Grok入口的${name}需要单一、非空且一致的选择`);
    }
    return present[0] as string | undefined;
}

async function invoke(call: GrokCall, action: string, params: Record<string, unknown>): Promise<RpcResult> {
    return handleAgentCall({ action, params, callerHost: call.callerHost, callerConversationId: call.callerConversationId });
}

const profileRecovery = {
    commands: ['sandbox_agent profile list --json', 'sandbox_agent help profile add',
        'sandbox_agent profile add --label Grok --protocol progrok --base-url <已有本机代理URL> --model <目录中的模型ID>'],
    next: '选择已有Progrok配置，或由可信调用方按现有本机代理建立配置；不导入OAuth或API Key，不启动另一条桥。',
};

async function onlyGrokProfile(call: GrokCall): Promise<string> {
    let cursor: string | null = null;
    const seen = new Set<string>();
    const profiles: string[] = [];
    do {
        const result = await invoke(call, 'profiles.list', { cursor, limit: 200 });
        if (!result.ok) throw new AgentFault(result.error!.code, result.error!.message, result.error!.details,
            result.error!.mayHaveStarted, result.error!.retryable);
        const page = object(result.data);
        if (!Array.isArray(page.profiles)) throw new AgentFault('PROTOCOL_MISMATCH', '配置列表缺少profiles字段');
        for (const value of page.profiles) {
            const profile = object(value);
            if (profile.protocol === 'progrok' && textValue(profile.profileId)) profiles.push(String(profile.profileId));
        }
        if (profiles.length > 1) throw new AgentFault('GROK_PROFILE_REQUIRED', '有多个Progrok配置，请显式选择profileId',
            { ...profileRecovery, profileIds: profiles });
        cursor = textValue(page.nextCursor) ?? null;
        if (cursor && seen.has(cursor)) throw new AgentFault('PROTOCOL_MISMATCH', '配置列表返回重复游标');
        if (cursor) seen.add(cursor);
    } while (cursor);
    if (!profiles.length) throw new AgentFault('GROK_PROFILE_REQUIRED', '尚无可选择的Progrok配置，未创建会话或发送模型请求', profileRecovery);
    return profiles[0];
}

async function selectGrok(call: GrokCall, params: Record<string, unknown>): Promise<RpcResult | null> {
    const options = object(params.options);
    const nested = object(options.modelSelection);
    const requestedProfile = selectedValue('profileId', [call.profileId, options.profileId, nested.profileId]);
    const requestedModel = selectedValue('modelId', [call.modelId, options.modelId, nested.modelId]);
    let previous: Record<string, unknown> = {};
    if (call.action !== 'conversations.create') {
        const result = await invoke(call, 'conversations.get', { conversationId: params.conversationId });
        if (!result.ok) return result;
        const data = object(result.data);
        previous = object(object(data.conversation ?? data).options);
    }
    const previousSelection = object(previous.modelSelection);
    const previousProfile = textValue(previous.profileId) ?? textValue(previousSelection.profileId);
    const profileId = requestedProfile ?? previousProfile ?? await onlyGrokProfile(call);
    const fetched = await invoke(call, 'profiles.get', { profileId });
    if (!fetched.ok) return { ...fetched, error: { ...fetched.error!, details: { ...fetched.error?.details, ...profileRecovery, profileId } } };
    const profile = object(object(fetched.data).profile) as unknown as ProviderProfile;
    if (profile.protocol !== 'progrok') throw new AgentFault('GROK_PROFILE_REQUIRED', 'sandbox_grok需要protocol=progrok的已有配置',
        { ...profileRecovery, profileId });
    const previousModel = profileId === previousProfile ? textValue(previous.modelId) ?? textValue(previousSelection.modelId) : undefined;
    const modelId = requestedModel ?? previousModel ?? profile.defaultModel
        ?? (process.env.SANDBOX_PROGROK_MODEL?.trim() || 'grok-4.5');
    new ProgrokAdapter().endpoint(profile, modelId);
    if (call.action === 'runs.start') {
        const budget = object(params.budget);
        if (!textValue(budget.quotaLimitId) && !profile.quotaLimitId) {
            throw new AgentFault('E_GLOBAL_BUDGET_REQUIRED', 'Grok任务需要独立配置并选择供应商总预算，尚未启动执行', {
                profileId, commands: ['sandbox_agent help budget configure-limit', 'sandbox_agent help profile edit'],
                next: '由可信调用方配置Grok的有限总上限，将quotaLimitId绑定到本配置或本次budget；Gemini与DeepSeek的测试限额各自保留。',
            });
        }
    }
    params.options = { ...options, profileId, modelId, modelSelection: { ...nested, profileId, modelId } };
    return null;
}

export async function handleGrokCall(input: unknown): Promise<RpcResult> {
    try {
        const call = GrokParamsSchema.parse(input);
        if (!selectionActions.has(call.action) && (call.profileId !== undefined || call.modelId !== undefined)) {
            throw new AgentFault('INVALID_PARAMS', 'profileId/modelId仅用于conversations.create、conversations.update或runs.start；继续或取消原执行时保留原身份');
        }
        if (call.action === 'runs.start' && !Object.keys(object(call.params.budget)).length) {
            throw new AgentFault('BUDGET_REQUIRED', 'Grok任务需要显式有限预算，尚未启动执行或发送模型请求', {
                commands: ['sandbox_agent help runs start'],
                next: '提供budget的costMode、wallMs或deadlineAt、maxModelCalls、maxOutputTokens；hard还需明确金额和币种。estimated须显式选择，供应商总上限始终有效。',
            });
        }
        const params = validateAgentCallParams(call.action, call.params);
        if (selectionActions.has(call.action)) {
            const stopped = await selectGrok(call, params);
            if (stopped) return stopped;
        }
        return await invoke(call, call.action, params);
    } catch (error) {
        if (error instanceof z.ZodError) return failure(new AgentFault('INVALID_PARAMS', 'sandbox_grok参数不完整或含未知字段', {
            fields: error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message })) }));
        return failure(error);
    }
}

export function registerGrok(server: McpServer): void {
    const description = '通过已有Progrok配置使用Grok，与sandbox_agent及CLI共用Agent Server、会话、工具循环、交互、取消、保存和费用账本。'
        + '用户指定或任务确需外部模型时使用；普通辅助沿宿主原生工具。action/params使用正式RPC，callerHost/callerConversationId显式标识外部主调用方。'
        + '仅创建、更新会话或runs.start可选profileId/modelId；未指定时优先沿用原会话，再选唯一Progrok配置及其默认模型，多配置须明确选择。'
        + 'runs.start须给有限budget及Grok供应商累计上限；本入口保持显式配置，不自动建预算、改estimated、重试、fallback或发模型探测。'
        + '费用默认hard并要求完整计费上界；估计运行须显式新quota amountMode=estimated及根costMode=estimated，单笔实收可超过估计。max_tokens约束可见输出，estimated累计额度的未知费用按原账本停发。'
        + '交互用interactions.list/respond，查询和取消沿原conversationId/runId/expectedRunEpoch，写操作保留稳定clientCommandId，未知结果先server.getReceipt。'
        + '普通读取、批准根写入、危险动作批准和默认关闭的单层内部子任务沿用Agent规则。保存方式及acknowledgeUnknown结束等待的原结果、费用保留合同见包内src/agent-cli/README.md；内部Agent禁止调用模型类MCP工具。';
    const handler = async (params: unknown) => {
        touchActivity();
        const result = await handleGrokCall(params);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: { ...result }, isError: !result.ok };
    };
    const compatible = server as unknown as {
        registerTool?: (name: string, config: { description: string; inputSchema: typeof GrokParamsSchema;
            annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean } }, callback: typeof handler) => unknown;
        tool?: (name: string, description: string, shape: typeof GrokParamsSchema.shape, callback: typeof handler) => unknown;
    };
    if (compatible.registerTool) compatible.registerTool('sandbox_grok', { description, inputSchema: GrokParamsSchema,
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } }, handler);
    else if (compatible.tool) compatible.tool('sandbox_grok', description, GrokParamsSchema.shape, handler);
    else throw new Error('MCP server lacks tool registration support');
}
