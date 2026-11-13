import type { CommandExecution } from './commands.js';
import { humanJson } from './presentation.js';
import { runFailureLines } from './run-view.js';
import { agentResultMarkdown, resultPresentationText, rpcFailureLines } from '../agent-client/results.js';

export function graphicsSummary(graphics: 'none' | 'blocks' | 'sixel' | 'kitty' | 'native', color: boolean): string {
    if (graphics === 'none' || !color) return '纯文字';
    return graphics === 'native' ? '高清动画（原生CMD）' : graphics === 'sixel' ? '高清动画（Sixel）' : graphics === 'kitty' ? '高清动画（Kitty）' : '字符兼容（低清）';
}

function record(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function conversationSummary(source: unknown, titleHint?: string): string[] | undefined {
    const value = record(source);
    if (typeof value.conversationId !== 'string' && !(typeof value.revision === 'number' && value.options && typeof value.options === 'object')) return undefined;
    const options = record(value.options), retention = record(value.retention);
    const names: Record<string, string> = { archive: '长期保存', temporary: '临时，关闭后清除', ttl: '限时保存' };
    const states: Record<string, string> = { open: '已打开', closed: '已关闭', closing: '正在收尾', deleted: '已清理' };
    const title = typeof options.title === 'string' && options.title ? options.title : titleHint;
    const lines = [title ? `会话：${title}` : '会话已就绪'];
    if (typeof retention.mode === 'string') lines.push(`保存方式：${names[retention.mode] ?? retention.mode}`);
    if (typeof value.state === 'string') lines.push(`状态：${states[value.state] ?? value.state}`);
    if (typeof options.modelId === 'string') lines.push(`模型：${options.modelId}`);
    if (Array.isArray(options.writeRoots)) {
        for (const directory of options.writeRoots) if (typeof directory === 'string') lines.push(`可写目录：${directory}`);
    }
    return lines;
}

export function profileCatalogRefreshLines(source: unknown): string[] {
    const refresh = record(record(source).catalogRefresh);
    if (!Object.keys(refresh).length) return [];
    const result = record(refresh.result), error = record(result.error);
    if (result.ok === true) return ['模型目录：已按保存后的配置刷新'];
    return ['配置已保存，模型目录' + (error.mayHaveStarted ? '刷新结果待确认' : '尚未刷新'),
        ...(typeof error.message === 'string' ? [error.message] : []), '输入草稿已保留，可在服务商菜单查看刷新详情'];
}

export function workspaceUpdateLines(source: unknown): string[] {
    const options = record(source);
    const roots = Array.isArray(options.writeRoots) ? options.writeRoots.filter((root): root is string => typeof root === 'string') : [];
    return ['工作目录：' + (typeof options.workingDirectory === 'string' ? options.workingDirectory : roots[0] ?? '沿当前目录'),
        ...roots.map(root => '允许写入：' + root), '生效范围：本对话的后续请求', '原始回执：/status → 最近设置的原始回执'];
}

export function interactiveResultLines(execution: CommandExecution, options: { raw?: boolean; titleHint?: string } = {}): string[] {
    if (options.raw) return humanJson(execution.result).split('\n');
    if (!execution.result.ok) return rpcFailureLines(execution.result);
    if (resultPresentationText(execution.result)) return agentResultMarkdown(execution.method ?? '', execution.result).split('\n');
    const readable = new Set(['conversations.create', 'conversations.get', 'conversations.close', 'conversations.reopen', 'conversations.update']);
    if (!options.raw && readable.has(execution.method ?? '')) {
        const summary = conversationSummary(execution.result.data, options.titleHint);
        if (summary) return summary;
    }
    const data = record(execution.result.data);
    if (!options.raw && (['runs.observe', 'server.readBatch', 'conversations.export', 'conversations.readHistory', 'events.read'].includes(execution.method ?? '')
        || execution.method?.endsWith('.list'))) return agentResultMarkdown(execution.method ?? '', execution.result).split('\n');
    if (!options.raw && execution.method === 'runs.get') {
        const failure = runFailureLines(data);
        if (failure.length) return ['查询已完成，目标执行未完成', ...failure];
    }
    if (!options.raw && execution.method?.startsWith('profiles.')) {
        const profile = record(data.profile ?? data);
        return [String(profile.label ?? '服务商设置已返回'), ...(typeof profile.baseUrl === 'string' ? ['API地址：' + profile.baseUrl] : []),
            ...(typeof profile.defaultModel === 'string' ? ['主模型：' + profile.defaultModel] : []),
            'Key：' + (profile.credentialRef || profile.configured ? '已配置 · ********' : '尚未配置'), ...profileCatalogRefreshLines(data), '完整配置可用/profile get --json查看'];
    }
    const estimated = record(data.quotaLimit).amountMode === 'estimated' || record(data.budget).effectiveAmountMode === 'estimated';
    return [...(estimated ? ['估计金额累计模式：单次实际费用可能超过预估，未知收费待核实后继续。'] : []), ...humanJson(execution.result.data ?? {}).split('\n')];
}
