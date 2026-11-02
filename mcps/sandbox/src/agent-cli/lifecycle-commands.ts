import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { clientFailure } from '../agent-client/client.js';
import { AgentFault, METHOD_SPECS } from '../agent-server/protocol.js';
import { CONVERSATION_LIFECYCLE_RPC_METHOD_SPECS } from '../agent-server/conversation-lifecycle/rpc-signatures.js';
import { OPTION_TYPES, parseDuration, parseJsonObject, usage } from './arguments.js';
import type { CommandExecution, CommandSpec, ExecuteContext, ParsedCommand } from './commands.js';

const mutationOptions = ['command-id', 'lease-id', 'control-epoch', 'params'];
const isReadonlyPreview = (method: string) => method === 'conversations.previewRetention' || method === 'conversations.previewBranch';
const isBranch = (method: string) => method === 'conversations.branch' || method === 'conversations.previewBranch';

function lifecycleCommand(name: string, method: keyof typeof CONVERSATION_LIFECYCLE_RPC_METHOD_SPECS,
    summary: string, positional: string, options: string[], aliases: string[]): CommandSpec {
    return { name, method, summary, aliases, group: name.startsWith('branch') ? 'conversation' : 'session',
        examples: [name.startsWith('branch')
            ? `sandbox_agent ${name} 2 --conversation <id> --write-root <当前目录> --json`
            : 'sandbox_agent session mode ttl --conversation <id> --ttl 2h --json'],
        argsSchema: { positionals: [positional], options: Object.fromEntries([...mutationOptions, ...options].map(option => [option, OPTION_TYPES[option]])),
            rpc: CONVERSATION_LIFECYCLE_RPC_METHOD_SPECS[method].schema },
        mutates: !isReadonlyPreview(method), requiresControl: !isReadonlyPreview(method),
        availability: () => ({ available: Boolean(METHOD_SPECS[method]),
            ...(METHOD_SPECS[method] ? {} : { reason: '核心尚未安装完整生命周期方法', recoveryCommand: 'sandbox_agent info --json' }) }),
        handler: executeLifecycleCommand };
}

export const LIFECYCLE_COMMAND_SPECS: CommandSpec[] = [
    lifecycleCommand('session mode', 'conversations.previewRetention', '只读预览实际范围，再用新的写命令ID及原preview-token确认', 'mode',
        ['ttl', 'policy-revision', 'preview-token'], []),
    lifecycleCommand('branch', 'conversations.branch', '从选定轮次另建独立会话，工作区文件保持当前状态', 'roundId',
        ['title', 'ttl', 'history-epoch', 'write-root', 'preview-token'], ['fork']),
    lifecycleCommand('branch preview', 'conversations.previewBranch', '只读预览所选轮次、完整原件及分支参数，返回确认令牌', 'roundId',
        ['title', 'ttl', 'history-epoch', 'write-root'], []),
];

export function installLifecycleCommandSpecs(existing: readonly CommandSpec[]): CommandSpec[] {
    const names = new Set(LIFECYCLE_COMMAND_SPECS.map(spec => spec.name));
    return [...existing.filter(spec => !names.has(spec.name)), ...LIFECYCLE_COMMAND_SPECS];
}

export async function executeLifecycleCommand(command: ParsedCommand, context: ExecuteContext): Promise<CommandExecution> {
    const { parsed, positionals, spec } = command;
    const options = parsed.options;
    let method = spec.method!;
    if (context.signal?.aborted) throw new AgentFault('FRONTEND_CANCELLED', '前台已取消，尚未提交生命周期操作');
    const params = typeof options.params === 'string' ? parseJsonObject(options.params, '--params') : {};
    const selected = typeof options.conversation === 'string' ? options.conversation : undefined;
    const legacy = typeof options['conversation-id'] === 'string' ? options['conversation-id'] : undefined;
    if (selected && legacy && selected !== legacy) throw usage('--conversation与--conversation-id不同');
    const conversationId = selected ?? legacy ?? context.conversationId ?? (typeof params.conversationId === 'string' ? params.conversationId : undefined);
    if (!conversationId) throw usage('该命令需要--conversation <id>或当前会话');
    if (params.conversationId !== undefined && params.conversationId !== conversationId) throw usage('参数中的源会话与当前选择不同');
    params.conversationId = conversationId;
    const token = options['preview-token'] ?? params.previewToken;
    if (method === 'conversations.previewRetention' && token !== undefined) method = 'conversations.setRetention';
    if (options.observe === true && !isReadonlyPreview(method)) return { method, result: clientFailure(new AgentFault('CONTROL_REQUIRED', '观察模式只读，保存转换和分支需要当前会话控制权')) };
    const suppliedCommandId = typeof options['command-id'] === 'string' ? options['command-id'] : typeof params.clientCommandId === 'string' ? params.clientCommandId : undefined;
    const clientCommandId = isReadonlyPreview(method) ? undefined : suppliedCommandId ?? randomUUID();
    if (clientCommandId) params.clientCommandId = clientCommandId;
    if (!isReadonlyPreview(method) && options['lease-id'] !== undefined) params.controlLeaseId = options['lease-id'];
    if (!isReadonlyPreview(method) && options['control-epoch'] !== undefined) params.controlEpoch = options['control-epoch'];
    if (method === 'conversations.setRetention' || method === 'conversations.previewRetention') {
        params.mode = positionals[0] ?? params.mode;
        if (options.ttl !== undefined) params.ttlDurationMs = parseDuration(String(options.ttl));
        if (options['policy-revision'] !== undefined) params.expectedPolicyRevision = options['policy-revision'];
        if (token !== undefined) params.previewToken = token;
    } else {
        params.roundId = positionals[0] ?? params.roundId;
        if (options.title !== undefined) params.title = options.title;
        if (options.ttl !== undefined) params.ttlDurationMs = parseDuration(String(options.ttl));
        if (options['history-epoch'] !== undefined) params.expectedHistoryEpoch = options['history-epoch'];
        const roots = options['write-root'] ?? params.writeRoots ?? [context.cwd];
        if (!Array.isArray(roots) || roots.some(root => typeof root !== 'string' || !root)) throw usage('分支可写根需要明确的目录字符串');
        params.writeRoots = roots.map(root => resolve(context.cwd, root));
        if (method === 'conversations.branch' && token !== undefined) params.previewToken = token;
    }
    let knownBranchReceipt = false;
    if (method === 'conversations.branch' && suppliedCommandId) {
        const original = await context.client.request<Record<string, unknown>>('server.getReceipt', { conversationId, targetClientCommandId: suppliedCommandId });
        if (!original.ok) return { method: 'server.getReceipt', clientCommandId, result: original };
        const receipt = original.data?.result as { data?: { sourceHistoryEpoch?: unknown } } | undefined;
        knownBranchReceipt = original.data?.found === true && Boolean(receipt);
        if (knownBranchReceipt && params.expectedHistoryEpoch === undefined && Number.isSafeInteger(receipt?.data?.sourceHistoryEpoch)) {
            params.expectedHistoryEpoch = receipt!.data!.sourceHistoryEpoch;
        }
    }
    const versionField = isBranch(method) ? 'expectedHistoryEpoch' : 'expectedPolicyRevision';
    if (params[versionField] === undefined) {
        const snapshot = await context.client.request<Record<string, unknown>>('conversations.get', { conversationId });
        if (!snapshot.ok) return { method: 'conversations.get', clientCommandId, result: snapshot };
        const field = isBranch(method) ? 'historyEpoch' : 'policyRevision';
        const version = snapshot.data?.[field];
        if (!Number.isSafeInteger(version) || Number(version) < 0) throw new AgentFault('PROTOCOL_MISMATCH', '源会话快照缺少可核对的版本', { field });
        params[versionField] = version;
    }
    if (method === 'conversations.branch' && params.previewToken === undefined && !knownBranchReceipt) {
        const { clientCommandId: _commandId, controlLeaseId: _lease, controlEpoch: _epoch, ...previewInput } = params;
        const previewSchema = CONVERSATION_LIFECYCLE_RPC_METHOD_SPECS['conversations.previewBranch'].schema;
        const validPreview = previewSchema.safeParse(previewInput);
        if (!validPreview.success) throw usage(validPreview.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('；'));
        const preview = await context.client.request<Record<string, unknown>>('conversations.previewBranch', validPreview.data);
        if (!preview.ok) return { method: 'conversations.previewBranch', clientCommandId, result: preview };
        if (typeof preview.data?.previewToken !== 'string' || !preview.data.previewToken) throw new AgentFault('PROTOCOL_MISMATCH', '分支预览缺少当前来源的确认令牌');
        params.previewToken = preview.data.previewToken;
    }
    const schema = CONVERSATION_LIFECYCLE_RPC_METHOD_SPECS[method as keyof typeof CONVERSATION_LIFECYCLE_RPC_METHOD_SPECS]?.schema;
    if (!schema) throw usage('未知生命周期命令');
    const validated = schema.safeParse(params);
    if (!validated.success) throw usage(validated.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('；'));
    if (context.signal?.aborted) throw new AgentFault('FRONTEND_CANCELLED', '前台已取消，尚未提交生命周期操作');
    return { method, clientCommandId, result: await context.client.request(method, validated.data, { clientCommandId }) };
}
