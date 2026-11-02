import { AgentFault, canonicalJson } from '../protocol.js';
import { pathIdentity } from './policy.js';

function names(value: unknown): string[] | null {
    if (value === undefined || value === null) return null;
    if (!Array.isArray(value) || value.some(name => typeof name !== 'string')) {
        throw new AgentFault('INVALID_PARAMS', '工具选择须为工具名称数组');
    }
    return [...new Set(value as string[])].sort();
}

function roots(options: Record<string, unknown>): string[] {
    const configured = options.writeRoots ?? options.workspaceRoots ?? [];
    if (!Array.isArray(configured) || configured.some(root => typeof root !== 'string')) {
        throw new AgentFault('INVALID_PARAMS', '写入根须为完整绝对路径数组');
    }
    return [...new Set((configured as string[]).map(pathIdentity))].sort();
}

export function permissionConfiguration(options: Record<string, unknown>): string {
    const toolsEnabled = options.toolsEnabled !== false && options.discussionOnly !== true;
    const allowChildren = toolsEnabled && (options.allowSubagents === true || options.allowInternalAgents === true);
    return canonicalJson({ roots: roots(options), tools: toolsEnabled ? names(options.tools) : [],
        commandApproval: toolsEnabled ? options.commandApproval ?? null : null,
        allowChildren, modelRulesRef: allowChildren ? options.modelRulesRef ?? null : null,
        delegationDepth: options.delegationDepth ?? 0 });
}
