import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { AgentClient, clientFailure } from '../agent-client/client.js';
import { AgentFault, METHOD_SPECS, SERVER_VERSION, type MethodSpec, type RpcResult } from '../agent-server/protocol.js';
import { GLOBAL_OPTIONS, OPTION_TYPES, parseDuration, parseJsonObject, usage, type ParsedArguments } from './arguments.js';
import type { ProviderProtocol } from '../agent-server/providers/types.js';
import { decodeArtifactJson } from '../agent-client/artifacts.js';
import { resolveContentPage, resolveRunResult } from './watch.js';
import { saveVerifiedArtifact } from './output.js';
import { validateBudget } from '../agent-server/state-machine.js';
import { artifactMetadata, isJsonMime } from './presentation.js';
import { parseCliInputReferences, parseCliReferenceSource, prepareCliInputReferences } from './references.js';
import type { CliReferenceSource } from './references.js';
import { installLifecycleCommandSpecs } from './lifecycle-commands.js';

const MUTATION_OPTIONS = ['command-id', 'lease-id', 'control-epoch', 'params'];
const PAGE_OPTIONS = ['cursor', 'limit'];
const INPUT_OPTIONS = ['text', 'input-file', 'stdin', 'attachment', 'reference'];
const RUN_OPTIONS = ['run-id', 'run-epoch'];
const BUDGET_OPTIONS = ['budget', 'wall-ms', 'max-model-calls', 'max-cost-micros', 'currency', 'cost-mode', 'max-output-tokens'];

export interface CommandSpec {
    name: string;
    aliases: string[];
    group: string;
    summary: string;
    examples: string[];
    method?: string;
    argsSchema: { positionals: string[]; optionalPositionals?: string[]; options: Record<string, string>; rpc?: MethodSpec['schema'] };
    mutates: boolean;
    requiresControl: boolean;
    availability: () => { available: boolean; reason?: string; recoveryCommand?: string };
    handler?: (command: ParsedCommand, context: ExecuteContext) => Promise<CommandExecution>;
}

function command(name: string, method: string | undefined, summary: string, positionals: string[] = [], options: string[] = [], aliases: string[] = [], optionalPositionals: string[] = []): CommandSpec {
    return {
        name, method, summary, aliases, group: name.split(' ')[0],
        examples: [`sandbox_agent --data-dir <目录> ${name}${positionals.map(argument => optionalPositionals.includes(argument) ? ` [${argument}]` : ` <${argument}>`).join(' ')} --json`],
        argsSchema: { positionals, ...(optionalPositionals.length ? { optionalPositionals } : {}), options: Object.fromEntries(options.map(option => [option, OPTION_TYPES[option]])), ...(method ? { rpc: METHOD_SPECS[method]?.schema } : {}) },
        mutates: method ? METHOD_SPECS[method]?.writes === true : false,
        requiresControl: method ? METHOD_SPECS[method]?.writes === true && METHOD_SPECS[method]?.scope !== 'none' : false,
        availability: () => name === 'key set' && !supportsServerSecretImport()
            ? { available: false, reason: '服务端文件导入隐藏通道尚未安装' }
            : ({ available: !method || Boolean(METHOD_SPECS[method]), ...(!method || METHOD_SPECS[method] ? {} : { reason: '核心尚未安装该控制方法', recoveryCommand: 'sandbox_agent info --json' }) }),
    };
}

export const COMMAND_SPECS: CommandSpec[] = installLifecycleCommandSpecs([
    command('help', undefined, '显示实际已接入的命令和参数', [], [], ['h']),
    command('info', 'server.info', '查看Agent Server版本、能力和状态'),
    command('doctor', 'server.info', '只检查本产品连接和进程版本，不发送模型请求', [], ['terminal']),
    command('exec', 'runs.start', '提交正文并等待真实结果，--detach仅返回执行身份', [], [...MUTATION_OPTIONS, ...INPUT_OPTIONS, ...BUDGET_OPTIONS, 'mode', 'ttl', 'profile', 'model', 'write-root', 'detach', 'format']),
    command('conversation create', 'conversations.create', '新建会话，默认归档保存', [], [...MUTATION_OPTIONS, 'mode', 'ttl', 'profile', 'model', 'write-root', 'title', 'allow-subagents'], ['session new', 'new']),
    command('conversation list', 'conversations.list', '分页查看会话', [], [...PAGE_OPTIONS, 'mode', 'state', 'params'], ['sessions', 'session list', 'session']),
    command('conversation get', 'conversations.get', '查看会话元数据和执行快照', ['conversationId'], ['params'], ['session show']),
    command('conversation close', 'conversations.close', '关闭会话并回收所属资源', ['conversationId'], [...MUTATION_OPTIONS, 'reason'], ['session close']),
    command('conversation reopen', 'conversations.reopen', '重开尚可恢复的会话', ['conversationId'], MUTATION_OPTIONS),
    command('conversation update', 'conversations.update', '提交下一请求使用的选项', ['conversationId'], [...MUTATION_OPTIONS, 'revision']),
    command('session rename', 'conversations.update', '按当前版本修改会话名称', ['title'], [...MUTATION_OPTIONS, 'revision']),
    command('session mode', 'conversations.setRetention', '先预览保存方式变更，提供原preview-token后才提交', ['mode'], [...MUTATION_OPTIONS, 'ttl', 'policy-revision', 'preview-token']),
    command('attach', 'conversations.get', '查看会话，并在非观察模式申请控制', ['conversationId'], ['takeover'], ['session open', 'resume']),
    command('control claim', 'server.claimControl', '申请控制权，接管须显式加--takeover', [], [...MUTATION_OPTIONS, 'scope', 'takeover']),
    command('control renew', 'server.renewControl', '续期当前客户端的控制租约', [], [...MUTATION_OPTIONS, 'scope']),
    command('control release', 'server.releaseControl', '释放当前客户端的控制租约', [], [...MUTATION_OPTIONS, 'scope']),
    command('receipt', 'server.getReceipt', '查询原命令回执，查询不会重发命令', ['clientCommandId'], ['params']),
    command('events read', 'events.read', '按已应用游标补读事件', ['conversationId'], ['after', 'limit', 'wait', 'max-bytes', 'params'], ['events']),
    command('events ack', 'events.ack', '确认已经展示或处理的事件游标', ['conversationId'], ['applied-cursor', 'subscription-id', 'params']),
    command('runs list', 'runs.list', '分页查看执行记录', ['conversationId'], [...PAGE_OPTIONS, 'params'], ['run list']),
    command('runs get', 'runs.get', '查看一个执行的真实状态', ['runId'], ['run-id', 'params'], ['run show', 'status']),
    command('runs start', 'runs.start', '用明确预算提交一轮输入', ['conversationId'], [...MUTATION_OPTIONS, ...INPUT_OPTIONS, ...BUDGET_OPTIONS, 'profile', 'model'], ['run start']),
    command('runs resume', 'runs.resume', '核对历史和执行代次后继续原执行', ['runId'], [...MUTATION_OPTIONS, ...RUN_OPTIONS, 'history-epoch', 'budget'], ['run resume']),
    command('cancel', 'runs.cancel', '取消原执行；--acknowledge-unknown结束已清理的本地等待，原结果及费用未知保留', ['runId'], [...MUTATION_OPTIONS, ...RUN_OPTIONS, 'reason', 'acknowledge-unknown'], ['runs cancel', 'stop']),
    command('interrupt', 'runs.interrupt', '中断至可继续的安全边界', ['runId'], [...MUTATION_OPTIONS, ...RUN_OPTIONS, 'reason'], ['runs interrupt']),
    command('input submit', 'inputs.submit', '将输入排到下一轮或补充当前轮', ['conversationId'], [...MUTATION_OPTIONS, ...RUN_OPTIONS, ...INPUT_OPTIONS, 'input-mode', 'history-epoch', 'draft-id', 'draft-revision', 'target-round'], ['inputs submit']),
    command('input list', 'inputs.list', '查询尚未消费的输入', ['conversationId'], [...PAGE_OPTIONS, 'run-id', 'params'], ['inputs list', 'queue list']),
    command('input update', 'inputs.update', '修改尚未认领的输入', ['inputId'], [...MUTATION_OPTIONS, ...RUN_OPTIONS, ...INPUT_OPTIONS, 'revision'], ['inputs update', 'queue edit']),
    command('input remove', 'inputs.remove', '撤回尚未认领的输入', ['inputId'], [...MUTATION_OPTIONS, ...RUN_OPTIONS, 'revision'], ['inputs remove', 'queue remove']),
    command('input reorder', 'inputs.reorder', '带队列版本提交完整顺序', ['conversationId'], [...MUTATION_OPTIONS, ...RUN_OPTIONS, 'revision', 'input-ids'], ['inputs reorder']),
    command('history', 'conversations.readHistory', '分页读取会话原文', ['conversationId'], [...PAGE_OPTIONS, 'start-round', 'end-round', 'max-bytes', 'params']),
    command('search', 'conversations.search', '有界搜索原文并保留命中来源', ['query'], [...PAGE_OPTIONS, 'scope', 'host', 'max-bytes', 'params']),
    command('artifact list', 'conversations.listArtifacts', '分页查看实际产物元数据', [], [...PAGE_OPTIONS, 'max-bytes', 'params']),
    command('ref add', 'conversations.references.prepare', '准备原图/文本/会话原文引用及SHA256；支持@conversation:agent-server:<id>#round=12-15', ['source'], [...MUTATION_OPTIONS, 'mime', 'range', 'expected-sha256']),
    command('ref show', 'conversations.references.get', '查看原件引用的来源、MIME、大小和SHA256', ['referenceId'], ['params'], ['ref preview']),
    command('artifact show', 'conversations.readArtifact', '分页读取并校验原文，不只显示内容引用', ['artifactId'], ['max-bytes', 'params']),
    command('artifact save', 'conversations.readArtifact', '校验完整原字节后保存到显式路径，默认保留已有文件', ['artifactId', 'path'], ['max-bytes', 'force', 'params']),
    command('profile list', 'profiles.list', '查看已配置的服务商', [], [...PAGE_OPTIONS, 'params'], ['profile']),
    command('profile get', 'profiles.get', '查看脱敏服务商配置', ['profileId'], ['params']),
    command('profile add', 'profiles.put', '创建服务商配置，保存过程不调用模型', [], [...MUTATION_OPTIONS, 'label', 'protocol', 'base-url', 'model', 'revision', 'quota-limit-id']),
    command('profile put', 'profiles.put', '按版本保存完整脱敏配置', [], [...MUTATION_OPTIONS, 'revision']),
    command('profile edit', 'profiles.put', '读当前配置后按版本修改显式字段', ['profileId'], [...MUTATION_OPTIONS, 'revision', 'label', 'protocol', 'base-url', 'model', 'quota-limit-id']),
    command('profile validate', 'profiles.validate', '本地校验服务商配置', ['profileId'], ['params']),
    command('profile remove', 'profiles.remove', '停用指定服务商配置', ['profileId'], [...MUTATION_OPTIONS, 'revision']),
    command('profile catalog', 'models.list', '分页查看指定配置的本地模型目录', ['profileId'], [...PAGE_OPTIONS, 'params']),
    command('key set', 'profiles.importSecret', '让服务端从私有文件导入Key，CLI只传文件引用', ['profileId'], [...MUTATION_OPTIONS, 'secret-file', 'secret-format', 'secret-field', 'revision']),
    command('model list', 'models.list', '分页查看服务商模型目录', [], [...PAGE_OPTIONS, 'profile', 'params']),
    command('model get', 'models.get', '查看精确模型及路由能力', ['modelId'], ['profile', 'route-id', 'params']),
    command('model refresh', 'models.refresh', '显式联网刷新模型目录，不发送模型任务', [], [...MUTATION_OPTIONS, 'profile']),
    command('model declare', 'models.declare', '提交带来源依据的精确模型条目，参数使用--params', [], [...MUTATION_OPTIONS, 'profile']),
    command('model set', 'conversations.update', '切换当前会话下一次请求的模型', [], [...MUTATION_OPTIONS, 'profile', 'model', 'revision']),
    command('budget configure-limit', 'budgets.configureLimit', '配置供应商跨根任务总金额上限', [], [...MUTATION_OPTIONS, 'quota-limit-id', 'currency', 'max-cost-micros', 'quota-scope-ids', 'source-ref', 'amount-mode']),
    command('budget get', 'budgets.get', '读取原根预算与总限额账本', ['rootBudgetId'], ['params']),
    command('approvals', 'interactions.list', '查看真实待批或提问', [], [...PAGE_OPTIONS, 'run-id', 'params']),
    command('approve', 'interactions.respond', '答复待批动作，默认仅本次', ['interactionId'], [...MUTATION_OPTIONS, 'decision', 'answer', 'scope-hash', 'action-hash', 'policy-revision', 'revision']),
    command('reject', 'interactions.respond', '拒绝指定待批动作', ['interactionId'], [...MUTATION_OPTIONS, 'reason', 'scope-hash', 'action-hash', 'policy-revision', 'revision']),
    command('context', 'conversations.context', '查看当前模型上下文占用', [], ['params']),
    command('compact', 'conversations.compact', '请求压缩，--preview仅查看范围', [], [...MUTATION_OPTIONS, ...BUDGET_OPTIONS, 'preview']),
    command('compact status', 'conversations.context', '查看当前压缩，或按原候选ID查回', ['candidateId'], ['params'], [], ['candidateId']),
    command('compact cancel', 'conversations.cancelCompaction', '只取消压缩并冷却，正常任务继续', ['candidateId'], [...MUTATION_OPTIONS, 'history-epoch', 'run-epoch'], [], ['candidateId']),
    command('compact restart', 'conversations.restartCompaction', '解除已确认的冷却或熔断，不新增请求', ['candidateId'], [...MUTATION_OPTIONS, 'history-epoch', 'run-epoch'], [], ['candidateId']),
    command('compact recover', 'conversations.recoverCompaction', '按原候选ID、配置和attempt恢复', ['candidateId'], [...MUTATION_OPTIONS, 'history-epoch', 'run-epoch']),
    command('rules list', 'conversations.rules.list', '查看已加载规则及来源', [], ['params']),
    command('rules show', 'conversations.rules.get', '读取指定规则的来源与固定版本', ['sourceId'], ['params']),
    command('rules reload', 'conversations.rules.reload', '为下一次请求重新加载规则', [], [...MUTATION_OPTIONS, 'revision']),
    command('skill list', 'conversations.skills.list', '查看可用技能元数据', [], [...PAGE_OPTIONS, 'params'], ['skills']),
    command('skill show', 'conversations.skills.get', '读取指定来源限定技能', ['qualifiedName'], ['params']),
    command('skill load', 'conversations.skills.load', '按版本加载明确选择的技能', ['qualifiedName'], [...MUTATION_OPTIONS, 'revision']),
    command('skill unload', 'conversations.skills.unload', '下一请求停用指定技能', ['qualifiedName'], [...MUTATION_OPTIONS, 'revision']),
    command('tools list', 'server.tools.list', '查看核心实际提供的工具', [], [...PAGE_OPTIONS, 'params']),
    command('tools show', 'server.tools.describe', '查看工具schema、权限与可用条件', ['toolId'], ['params']),
    command('changes', 'changes.list', '查看本会话受控修改', [], [...PAGE_OPTIONS, 'params'], ['diff']),
    command('changes show', 'changes.get', '查看某次修改的具体差异', ['actionId'], ['params']),
    command('changes plan', 'changes.get', '查回原恢复计划及已确认结果', ['restorePlanId'], ['params']),
    command('changes restore', 'changes.preview', '预览所选修改的文件恢复，保留聊天', ['actionId'], [...MUTATION_OPTIONS, 'history-epoch', 'workspace-revision']),
    command('rewind', 'changes.preview', '预览整轮回溯及冲突，不自动提交文件恢复', ['roundId'], [...MUTATION_OPTIONS, 'history-epoch', 'workspace-revision']),
    command('changes commit', 'changes.commit', '核原restorePlanId和版本后明确提交恢复', ['restorePlanId'], MUTATION_OPTIONS),
    command('settings show', 'server.settings.get', '查看有效配置及来源', [], ['scope', 'global', 'params'], ['settings', 'config']),
    command('settings set', 'server.settings.put', '按版本更新已安装的设置', ['key', 'value'], [...MUTATION_OPTIONS, 'scope', 'global', 'revision']),
    command('usage', 'budgets.get', '查看原根预算账本，实际usage与未知状态保持原样', [], ['root-budget-id', 'run-id', 'params'], ['cost']),
    command('send', undefined, '发送当前草稿，忙时排到下一轮'),
    command('input current', undefined, '将草稿补充到当前人工轮'),
    command('input next', undefined, '将草稿排到下一轮'),
    command('input interrupt', undefined, '中断当前模型生成并保留草稿'),
    command('queue', undefined, '打开当前执行的输入队列'),
    command('model', undefined, '打开模型与预算选择'),
    command('run control', undefined, '申请会话控制或明确接管'),
    command('run detach', undefined, '明确脱离当前前台，后台按原预算继续'),
    command('terminal show', undefined, '查看本前台的终端与输入设置'),
    command('terminal set', undefined, '修改本前台设置，例如enterBehavior newline', ['key', 'value']),
    command('terminal graphics', undefined, '选择auto/blocks/sixel/none图像模式', ['mode']),
    command('terminal motion', undefined, '选择full/reduced/off动画模式', ['mode']),
    command('terminal width', undefined, '选择本前台的模糊字符宽度', ['mode']),
    command('clear', undefined, '清理当前显示，原文保持可查'),
    command('editor', undefined, '用VISUAL/EDITOR编辑归档或限时会话草稿，失败保留原稿'),
    command('reconnect', undefined, '恢复本前台连接、原游标和回执查询，不重发写命令'),
    command('quit', undefined, '关闭或显式脱离当前会话后退出', [], ['cancel', 'detach'], ['q', 'exit']),
    command('shutdown', 'server.shutdown', '关闭当前dataDir所属核心', [], [...MUTATION_OPTIONS, 'mode', 'grace-ms']),
    command('rpc', undefined, '调用已注册的控制方法，参数仍由共享schema校验', ['method'], MUTATION_OPTIONS),
]);

export interface ParsedCommand {
    spec: CommandSpec;
    parsed: ParsedArguments;
    positionals: string[];
}

export interface ExecuteContext {
    client: AgentClient;
    cwd: string;
    conversationId?: string;
    readInput: () => Promise<string | undefined>;
    signal?: AbortSignal;
}

export interface CommandExecution {
    result: RpcResult;
    method?: string;
    clientCommandId?: string;
}

export function supportsServerSecretImport(): boolean {
    const spec = METHOD_SPECS['profiles.importSecret'];
    return Boolean(spec?.schema.safeParse({ profileId: 'schema-check', expectedRevision: 0,
        clientCommandId: 'schema-check', sourcePath: 'server-owned-file-reference', format: 'plain' }).success);
}

export function parseCommand(parsed: ParsedArguments): ParsedCommand {
    const words = parsed.words.map((word, index) => index === 0 && word.startsWith('/') ? word.slice(1) : word);
    let selected: { spec: CommandSpec; length: number } | undefined;
    for (const spec of COMMAND_SPECS) {
        for (const name of [spec.name, ...spec.aliases]) {
            const parts = name.split(' ');
            if (parts.every((part, index) => words[index] === part) && (!selected || parts.length > selected.length)) selected = { spec, length: parts.length };
        }
    }
    if (!selected) throw usage(words.length === 0 ? '非交互模式需要一个命令或明确的正文输入' : `未知命令：${words.slice(0, 2).join(' ')}`);
    const allowed = new Set([...GLOBAL_OPTIONS, ...Object.keys(selected.spec.argsSchema.options)]);
    for (const option of Object.keys(parsed.options)) if (!allowed.has(option)) throw usage(`${selected.spec.name}不接受--${option}`);
    const positionals = words.slice(selected.length);
    if (selected.spec.name !== 'help' && positionals.length > selected.spec.argsSchema.positionals.length) throw usage(`${selected.spec.name}的位置参数过多`);
    return { spec: selected.spec, parsed, positionals };
}

export function commandMetadata(): Record<string, unknown> {
    return {
        name: 'sandbox_agent', clientVersion: SERVER_VERSION, protocolVersion: 1, features: ['control', 'interactive', 'json', 'jsonl'],
        commands: COMMAND_SPECS.map(spec => ({
            name: spec.name, aliases: spec.aliases, summary: spec.summary, positionals: spec.argsSchema.positionals,
            ...(spec.argsSchema.optionalPositionals ? { optionalPositionals: spec.argsSchema.optionalPositionals } : {}),
            options: spec.argsSchema.options, method: spec.method, mutates: spec.mutates, requiresControl: spec.requiresControl,
            availability: spec.availability(), examples: spec.examples,
        })),
        globalOptions: Object.fromEntries(GLOBAL_OPTIONS.map(name => [name, OPTION_TYPES[name]])),
        methods: Object.entries(METHOD_SPECS).map(([name, spec]) => ({ name, writes: spec.writes, scope: spec.scope, description: spec.description })),
    };
}

export function renderHelp(target?: string, diagnostics = false): string {
    const selected = target ? COMMAND_SPECS.filter(spec => [spec.name, ...spec.aliases].some(name => name === target || name.startsWith(target + ' '))) : COMMAND_SPECS;
    if (target && selected.length === 0) throw usage(`未找到命令：${target}`);
    return [
        'Sandbox Agent CLI · 人工与脚本共用控制入口',
        '用法：sandbox_agent [--data-dir <目录>] <命令> [参数] [--json]',
        '',
        ...selected.map(spec => `  ${spec.name}${spec.argsSchema.positionals.map(name => spec.argsSchema.optionalPositionals?.includes(name) ? ` [${name}]` : ` <${name}>`).join(' ')}  ${spec.summary}${spec.availability().available ? '' : ' [不可用：' + spec.availability().reason + ']'}${target ? '\n    参数：' + Object.keys(spec.argsSchema.options).map(name => `--${name}`).join(' ') : ''}`),
        '',
        '正文：--text <文字>、--input-file <UTF-8文件>、--stdin三选一',
        '预算：--budget <JSON对象>，或--wall-ms/--max-model-calls/--max-cost-micros/--currency',
        '会话：可用--conversation <id>代替会话位置参数；临时模式使用--mode temporary；限时需--mode ttl --ttl 2h',
        '单命令JSON输出不含ANSI；诊断和交互提示写入stderr；帮助不会连接服务',
        '全局参数：' + GLOBAL_OPTIONS.filter(name => !['renderer', 'image-cache'].includes(name)).map(name => '--' + name).join(' '),
        ...(diagnostics ? ['诊断参数：--diagnostics --renderer full|diff --image-cache off|on；仅本次进程测量，不记录正文或Key'] : []),
    ].join('\n') + '\n';
}

export async function executeCommand(command: ParsedCommand, context: ExecuteContext): Promise<CommandExecution> {
    const { spec, parsed, positionals } = command;
    if (spec.handler) return spec.handler(command, context);
    const options = parsed.options;
    const rawParams = typeof options.params === 'string' ? parseJsonObject(options.params, '--params') : {};
    let method = spec.method;
    if (spec.name === 'rpc') {
        method = positionals[0];
        if (!method || !METHOD_SPECS[method]) throw usage('rpc仅接受当前注册表中的正式控制方法');
        if (/Secret|authenticate|hello/.test(method)) throw usage('该方法须使用专用隐藏输入通道');
    }
    if (!method) throw usage('该命令没有远程操作');
    const methodSpec = METHOD_SPECS[method];
    if (!methodSpec) return { method, result: clientFailure(new AgentFault('METHOD_NOT_AVAILABLE', '当前核心尚未安装此能力', { method })) };
    if (options.observe === true && methodSpec.writes) return { method, result: clientFailure(new AgentFault('CONTROL_REQUIRED', '观察模式仅允许只读命令')) };
    const params: Record<string, unknown> = { ...rawParams };
    let pendingReferenceSources: CliReferenceSource[] = [];
    const stringOption = (name: string): string | undefined => typeof options[name] === 'string' ? options[name] as string : undefined;
    if (['runs start', 'exec', 'input submit', 'input update'].includes(spec.name)) {
        const text = await context.readInput();
        const field = spec.name === 'runs start' || spec.name === 'exec' ? 'input' : 'content';
        if (text !== undefined) params[field] = { ...(params[field] as Record<string, unknown> | undefined), text };
        const content = params[field] as Record<string, unknown> | undefined;
        const references = parseCliInputReferences(String(content?.text ?? ''), { cwd: context.cwd,
            attachments: options.attachment as string[] | undefined, references: options.reference as string[] | undefined });
        pendingReferenceSources = references.sources;
        params[field] = { ...(content ?? {}), text: references.text };
        if (!references.text.trim() && !pendingReferenceSources.length && !(Array.isArray(content?.references) && content.references.length)) throw usage('该命令需要非空正文或明确引用，请使用--text、--input-file、--stdin、--attachment或--reference');
    }
    const firstIsConversation = spec.argsSchema.positionals[0] === 'conversationId';
    const positionalConversation = firstIsConversation ? positionals[0] : undefined;
    const explicitConversation = stringOption('conversation') ?? stringOption('conversation-id');
    if (positionalConversation && explicitConversation && positionalConversation !== explicitConversation) throw usage('会话位置参数与--conversation不同');
    let conversationId = explicitConversation ?? positionalConversation ?? context.conversationId ?? (typeof params.conversationId === 'string' ? params.conversationId : undefined);
    if (spec.name === 'exec' && !conversationId) {
        const budget = parseBudget(parsed, params.budget);
        const explicitRootCommandId = stringOption('command-id') ?? (typeof params.clientCommandId === 'string' ? params.clientCommandId : undefined);
        let rootCommandId = explicitRootCommandId ?? randomUUID();
        const preflight = methodSpec.schema.safeParse({ ...params, budget, conversationId: 'cli-pending-conversation', clientCommandId: rootCommandId });
        if (!preflight.success) throw usage('exec参数不符合正式runs.start定义：' + preflight.error.issues.map(issue => issue.path.join('.') + ' ' + issue.message).join('；'));
        if (context.signal?.aborted) throw new AgentFault('FRONTEND_CANCELLED', '前台已取消，尚未创建会话或提交执行');
        if (options.detach === true && options.mode === 'temporary') throw usage('临时会话关闭即清，exec不支持--detach；请选择archive或ttl');
        const createParams = conversationCreateParams(parsed, context);
        let createCommandId = 'cli-exec-create-' + createHash('sha256').update(rootCommandId).digest('hex');
        if ((createParams.retention as { mode?: string }).mode === 'temporary') {
            if (explicitRootCommandId?.startsWith('temporary-create-v1:')) createCommandId = explicitRootCommandId;
            else if (explicitRootCommandId === undefined) {
                const prepared = await context.client.request<{ clientCommandId: string }>('conversations.prepareTemporaryCreate');
                if (!prepared.ok) return { method: 'conversations.prepareTemporaryCreate', result: prepared };
                if (typeof prepared.data?.clientCommandId !== 'string') return { method, result: clientFailure(new AgentFault('PROTOCOL_MISMATCH', '临时新建准备结果缺少原命令号')) };
                createCommandId = prepared.data.clientCommandId;
                rootCommandId = createCommandId;
            }
        }
        const create = await context.client.request<Record<string, unknown>>('conversations.create', { ...createParams, clientCommandId: createCommandId }, { clientCommandId: createCommandId });
        if (!create.ok) return { method: 'conversations.create', clientCommandId: createCommandId, result: { ...create,
            ...(create.error ? { error: { ...create.error, details: { ...create.error.details, rootClientCommandId: rootCommandId } } } : {}) } };
        conversationId = typeof create.data?.conversationId === 'string' ? create.data.conversationId : undefined;
        if (!conversationId) return { method, result: clientFailure(new AgentFault('PROTOCOL_MISMATCH', '创建回执缺少会话ID')) };
        params.clientCommandId = rootCommandId;
    }
    if (spec.name === 'exec' && conversationId && options.detach === true) {
        const snapshot = await context.client.request<Record<string, unknown>>('conversations.get', { conversationId });
        if (!snapshot.ok) return { method: 'conversations.get', result: snapshot };
        if ((snapshot.data?.retention as Record<string, unknown> | undefined)?.mode === 'temporary') throw usage('临时会话不接受exec --detach，请使用归档或限时会话');
    }
    const hasConversation = methodSpec.scope === 'conversation' || ['server.getReceipt', 'server.claimControl', 'server.renewControl', 'server.releaseControl'].includes(method);
    if (hasConversation && conversationId) params.conversationId = conversationId;
    if (spec.name === 'ref add') {
        const source = positionals[0];
        Object.assign(params, parseCliReferenceSource(source, context.cwd));
        if (stringOption('mime')) params.mime = stringOption('mime');
        if (stringOption('range')) params.range = stringOption('range');
        if (stringOption('expected-sha256')) params.expectedSha256 = stringOption('expected-sha256');
    }
    if (spec.name === 'ref show') params.referenceId = positionals[0];
    if (spec.name === 'session rename') {
        if (!conversationId) throw usage('session rename需要当前会话或--conversation');
        if (!positionals[0]) throw usage('session rename需要新的会话名称');
        params.options = { title: positionals[0] };
        if (params.expectedRevision === undefined && options.revision === undefined) {
            const snapshot = await context.client.request<Record<string, unknown>>('conversations.get', { conversationId });
            if (!snapshot.ok) return { method: 'conversations.get', result: snapshot };
            params.expectedRevision = snapshot.data?.revision;
        }
    }
    if (spec.argsSchema.positionals[0] === 'runId') params.runId = positionals[0] ?? stringOption('run-id') ?? params.runId;
    if (spec.argsSchema.positionals[0] === 'inputId') params.inputId = positionals[0] ?? params.inputId;
    const copyOptions: Record<string, string> = {
        cursor: 'cursor', limit: 'limit', state: 'state', reason: 'reason', 'run-id': 'runId', 'run-epoch': 'expectedRunEpoch',
        'acknowledge-unknown': 'acknowledgeUnknown',
        'history-epoch': 'expectedHistoryEpoch', revision: 'expectedRevision', after: 'afterCursor', wait: 'waitMs', 'max-bytes': 'maxBytes',
        'applied-cursor': 'appliedCursor', 'subscription-id': 'subscriptionId', 'draft-id': 'draftId', 'draft-revision': 'draftRevision',
        'target-round': 'targetRoundId', 'grace-ms': 'graceMs', 'start-round': 'startRound', 'end-round': 'endRound',
        'lease-id': 'controlLeaseId', 'control-epoch': 'controlEpoch',
        'workspace-revision': 'expectedWorkspaceRevision',
    };
    for (const [option, field] of Object.entries(copyOptions)) if (options[option] !== undefined) params[field] = options[option];
    if (spec.name === 'conversation create') {
        Object.assign(params, conversationCreateParams(parsed, context, params));
    }
    if (spec.name === 'session mode') {
        params.mode = positionals[0]; params.expectedPolicyRevision = options['policy-revision'];
        if (typeof options.ttl === 'string') params.ttlDurationMs = parseDuration(options.ttl);
        params.dryRun = !stringOption('preview-token');
        if (stringOption('preview-token')) params.previewToken = stringOption('preview-token');
    }
    if (spec.name === 'rules show') params.sourceId = positionals[0];
    if (['skill show', 'skill load', 'skill unload'].includes(spec.name)) params.qualifiedName = positionals[0];
    if (spec.name === 'tools show') params.toolId = positionals[0];
    if (spec.name === 'search') {
        params.query = positionals[0];
        if (stringOption('scope')) params.scope = stringOption('scope');
        if (stringOption('host')) params.sourceHost = stringOption('host');
    }
    if (spec.name === 'changes show') params.actionId = positionals[0];
    if (spec.name === 'changes plan') params.restorePlanId = positionals[0];
    if (spec.name === 'changes restore') { params.mode = 'files_only'; params.actionIds = [positionals[0]]; }
    if (spec.name === 'rewind') { params.mode = 'round_restart'; params.roundId = positionals[0]; }
    if (spec.name === 'changes commit') params.restorePlanId = positionals[0];
    if (spec.name === 'conversation list' && stringOption('mode')) params.mode = stringOption('mode');
    if (spec.name === 'conversation update' && !params.options) throw usage('conversation update需要--params中的options对象');
    if (spec.name === 'receipt') params.targetClientCommandId = positionals[0] ?? params.targetClientCommandId;
    if (spec.name.startsWith('control ')) {
        params.scope = stringOption('scope') ?? (conversationId ? 'conversation' : 'server');
        if (params.scope === 'conversation' && !conversationId) throw usage('会话控制需要--conversation <id>');
        if (spec.name === 'control claim') params.takeover = options.takeover === true;
        else if (!params.controlLeaseId) {
            const claimed = await context.client.claimControl(params.scope as 'server' | 'conversation', conversationId);
            if (!claimed.ok) return { method, result: claimed };
            const lease = context.client.getControlLease(params.scope as 'server' | 'conversation', conversationId);
            if (!lease) return { method, result: clientFailure(new AgentFault('PROTOCOL_MISMATCH', '控制回执缺少租约字段')) };
            params.controlLeaseId = lease.controlLeaseId;
            params.controlEpoch = lease.controlEpoch;
        }
    }
    if (spec.name === 'runs start' || spec.name === 'exec') {
        params.budget = parseBudget(parsed, params.budget);
        const selection = { ...(stringOption('profile') ? { profileId: stringOption('profile') } : {}), ...(stringOption('model') ? { modelId: stringOption('model') } : {}) };
        const previous = params.options as Record<string, unknown> | undefined;
        if (Object.keys(selection).length) params.options = { ...previous, modelSelection: { ...(previous?.modelSelection as Record<string, unknown> | undefined), ...selection }, ...selection };
    }
    if (spec.name === 'runs resume' && stringOption('budget')) params.budget = parseJsonObject(stringOption('budget')!, '--budget');
    if (spec.name === 'input submit') {
        params.mode = stringOption('input-mode') ?? params.mode ?? 'queue';
        params.draftId ??= randomUUID();
        params.draftRevision ??= 0;
    }
    if (spec.name === 'input reorder' && stringOption('input-ids')) {
        try { params.inputIds = JSON.parse(stringOption('input-ids')!); }
        catch { throw usage('--input-ids须为完整输入ID数组的JSON'); }
    }
    if (spec.name === 'shutdown') params.mode = stringOption('mode') ?? params.mode ?? 'drain';
    if (spec.group === 'profile' || spec.name === 'key set') {
        if (positionals[0]) params.profileId = positionals[0];
        if (spec.name === 'profile edit') {
            if (!['label', 'protocol', 'base-url', 'model', 'quota-limit-id'].some(name => stringOption(name) !== undefined)) throw usage('profile edit需要至少一个明确修改字段');
            const current = await context.client.request('profiles.get', { profileId: params.profileId });
            if (!current.ok) return { method: 'profiles.get', result: current };
            const value = current.data as Record<string, unknown>;
            const profile = { ...(value.profile ?? value) as Record<string, unknown> };
            for (const [option, field] of Object.entries({ label: 'label', protocol: 'protocol', 'base-url': 'baseUrl', model: 'defaultModel', 'quota-limit-id': 'quotaLimitId' })) {
                if (stringOption(option) !== undefined) profile[field] = stringOption(option);
            }
            params.profile = profile; params.expectedRevision ??= profile.revision;
            delete params.profileId;
        }
        if (spec.name === 'profile add') {
            if (!stringOption('label') || !stringOption('protocol') || !stringOption('base-url')) throw usage('profile add需要--label、--protocol及--base-url');
            const { newProfile } = await import('../agent-server/profiles/profile-store.js');
            params.profile = newProfile({ label: stringOption('label')!, protocol: stringOption('protocol') as ProviderProtocol, baseUrl: stringOption('base-url')!, modelId: stringOption('model') });
            params.expectedRevision ??= 0;
            if (stringOption('quota-limit-id')) params.profile = { ...(params.profile as Record<string, unknown>), quotaLimitId: stringOption('quota-limit-id') };
        }
        if (spec.name === 'profile validate' && params.profileId) {
            const existing = await context.client.request('profiles.get', { profileId: params.profileId });
            if (!existing.ok) return { method: 'profiles.get', result: existing };
            const value = existing.data as Record<string, unknown>;
            params.profile = value?.profile ?? value;
            delete params.profileId;
        }
        if (spec.name === 'key set') {
            if (!supportsServerSecretImport()) return { method, result: clientFailure(new AgentFault('CAPABILITY_REQUIRED', '服务端文件导入隐藏通道尚未安装，CLI不会读取Key文件')) };
            if (params.secret !== undefined) throw usage('key set只提交服务端文件引用，请使用--secret-file');
            if (!stringOption('secret-file')) throw usage('key set需要--secret-file，文件内容仅由服务端读取');
            params.sourcePath = resolve(context.cwd, stringOption('secret-file')!);
            params.format = stringOption('secret-format') ?? 'plain';
            if (stringOption('secret-field')) params.field = stringOption('secret-field');
            if (params.format !== 'plain' && !params.field) throw usage('env或json导入需要--secret-field指定变量名或字段');
        }
    }
    if (spec.name.startsWith('model ')) {
        if (stringOption('profile')) params.profileId = stringOption('profile');
        if (spec.name === 'model get') {
            params.modelId = positionals[0] ?? stringOption('model');
            if (stringOption('route-id')) params.routeId = stringOption('route-id');
        }
        if (spec.name === 'model set') {
            delete params.profileId;
            const previous = params.options as Record<string, unknown> | undefined;
            const previousSelection = previous?.modelSelection as Record<string, unknown> | undefined;
            const selected = { profileId: stringOption('profile') ?? previousSelection?.profileId ?? previous?.profileId,
                modelId: stringOption('model') ?? previousSelection?.modelId ?? previous?.modelId };
            if (typeof selected.profileId !== 'string' || !selected.profileId || typeof selected.modelId !== 'string' || !selected.modelId) throw usage('model set需要明确--profile和--model');
            params.options = { ...previous, ...selected, modelSelection: { ...previousSelection, ...selected } };
        }
    }
    if (spec.name === 'budget configure-limit') {
        if (!params.definition) {
            let quotaScopeIds: unknown;
            try { quotaScopeIds = JSON.parse(stringOption('quota-scope-ids') ?? '[]'); } catch { throw usage('--quota-scope-ids需要账户额度组ID数组的JSON'); }
            params.definition = { quotaLimitId: stringOption('quota-limit-id'), currency: stringOption('currency'), maxCostMicros: options['max-cost-micros'], quotaScopeIds, sourceRef: stringOption('source-ref') };
            if (stringOption('amount-mode')) params.definition = { ...params.definition as Record<string, unknown>, amountMode: stringOption('amount-mode') };
            delete params.maxCostMicros;
        }
    }
    if (spec.name === 'budget get') params.rootBudgetId = positionals[0] ?? params.rootBudgetId;
    if (spec.name === 'usage') {
        params.rootBudgetId = stringOption('root-budget-id') ?? params.rootBudgetId;
        if (!params.rootBudgetId && stringOption('run-id') && conversationId) {
            const run = await context.client.request<Record<string, unknown>>('runs.get', { conversationId, runId: stringOption('run-id') });
            if (!run.ok) return { method: 'runs.get', result: run };
            params.rootBudgetId = run.data?.rootRunId ?? run.data?.runId;
        }
        delete params.runId;
    }
    if (spec.name === 'artifact show' || spec.name === 'artifact save') {
        const artifactId = positionals[0] ?? params.artifactId;
        if (!conversationId || typeof artifactId !== 'string') throw usage('artifact show需要artifactId及--conversation');
        if (spec.name === 'artifact show') {
            const metadata = await context.client.request<Record<string, unknown>>(method, { conversationId, artifactId, offset: 0, maxBytes: 1 });
            if (!metadata.ok || !metadata.data) return { method, result: metadata };
            if (typeof metadata.data.mime === 'string' && !isJsonMime(metadata.data.mime) && !metadata.data.mime.startsWith('text/')) return { method,
                result: { ok: true, data: { ...artifactMetadata(metadata.data, conversationId, context.client.dataDir), bodyComplete: false, inspectedBytes: Math.min(1, Number(metadata.data.totalBytes ?? 0)) } } };
        }
        const artifact = await context.client.readArtifact(conversationId, artifactId, { maxBytes: typeof options['max-bytes'] === 'number' ? options['max-bytes'] : undefined });
        if (!artifact.ok || !artifact.data) return { method, result: artifact };
        const { bytes: _bytes, ...reference } = artifact.data;
        if (spec.name === 'artifact save') {
            if (!positionals[1]) throw usage('artifact save需要明确的目标路径');
            const path = await saveVerifiedArtifact(resolve(context.cwd, positionals[1]), artifact.data.bytes, options.force === true);
            return { method, result: { ok: true, data: { ...reference, path, verified: true } } };
        }
        return { method, result: { ok: true, data: { ...reference, value: isJsonMime(reference.mime) ? decodeArtifactJson(artifact.data) : new TextDecoder('utf-8', { fatal: true }).decode(artifact.data.bytes), verified: true } } };
    }
    if (spec.name === 'approve' || spec.name === 'reject') {
        params.interactionId = positionals[0];
        params.decision = spec.name === 'reject' ? 'deny' : stringOption('decision') ?? 'approve';
        if (stringOption('answer')) {
            try { params.answer = JSON.parse(stringOption('answer')!); } catch { params.answer = stringOption('answer'); }
        }
        for (const [option, field] of Object.entries({ 'scope-hash': 'scopeHash', 'action-hash': 'actionHash', 'policy-revision': 'policyRevision' })) if (options[option] !== undefined) params[field] = options[option];
    }
    if (spec.name === 'compact') {
        params.mode = options.preview === true ? 'preview' : 'manual';
        if (params.budget !== undefined || BUDGET_OPTIONS.some(option => options[option] !== undefined)) params.budget = parseBudget(parsed, params.budget);
    }
    if (spec.name.startsWith('compact ') && positionals[0] !== undefined) params.candidateId = positionals[0];
    if (spec.name === 'compact recover' && !params.candidateId) throw usage('compact recover需要原candidateId，可先用compact status查看');
    if (spec.name.startsWith('settings ')) {
        params.scope = stringOption('scope') ?? 'global';
        if (spec.name === 'settings set') {
            let value: unknown = positionals[1];
            try { value = JSON.parse(positionals[1]); } catch {}
            params.values = { [positionals[0]]: value };
        }
    }
    const explicitCommandId = stringOption('command-id') ?? (typeof params.clientCommandId === 'string' ? params.clientCommandId : undefined);
    let clientCommandId = methodSpec.writes ? explicitCommandId ?? randomUUID() : undefined;
    if (method === 'conversations.create' && (params.retention as { mode?: string } | undefined)?.mode === 'temporary'
        && explicitCommandId === undefined && !context.signal?.aborted) {
        const prepared = await context.client.request<{ clientCommandId: string }>('conversations.prepareTemporaryCreate');
        if (!prepared.ok) return { method: 'conversations.prepareTemporaryCreate', result: prepared };
        if (typeof prepared.data?.clientCommandId !== 'string') return { method, result: clientFailure(new AgentFault('PROTOCOL_MISMATCH', '临时新建准备结果缺少原命令号')) };
        clientCommandId = prepared.data.clientCommandId;
    }
    if (clientCommandId) params.clientCommandId = clientCommandId;
    const inputField = spec.name === 'runs start' || spec.name === 'exec' ? 'input' : 'content';
    const existingInput = params[inputField] as { text?: string; references?: unknown[] } | undefined;
    if (['runs start', 'exec', 'input submit', 'input update'].includes(spec.name) && (pendingReferenceSources.length || existingInput?.references?.length)) {
        if (!conversationId || !clientCommandId) throw usage('附件输入需要明确会话和原提交命令ID');
        const field = spec.name === 'runs start' || spec.name === 'exec' ? 'input' : 'content';
        const content = params[field] as { text: string; references?: unknown[] };
        params[field] = await prepareCliInputReferences(context.client, { conversationId, commandId: clientCommandId,
            cwd: context.cwd, text: content.text, existing: content.references, sources: pendingReferenceSources, signal: context.signal });
    }
    if (methodSpec.writes && context.signal?.aborted) return { method, clientCommandId, result: clientFailure(new AgentFault('FRONTEND_CANCELLED', '前台已取消，本次执行尚未提交', { conversationId })) };
    let result = await context.client.request(method, params, { clientCommandId });
    if (spec.name === 'doctor' && result.ok) result = { ...result, data: { product: result.data, cli: { version: SERVER_VERSION, node: process.version, platform: process.platform, architecture: process.arch },
        ...(options.terminal ? { terminal: { scope: '仅当前CLI终端', recovery: '光标或输入异常时，在同一终端重新运行本CLI；已退出的执行用原runId查询，不重新提交' } } : {}), modelRequestPerformed: false } };
    if (spec.name === 'runs get' && conversationId) result = await resolveRunResult(context.client, conversationId, result as RpcResult<Record<string, unknown>>);
    if (spec.name === 'history' && conversationId) result = await resolveContentPage(context.client, conversationId, result as RpcResult<Record<string, unknown>>, 'value');
    if (spec.name === 'input list' && conversationId) result = await resolveContentPage(context.client, conversationId, result as RpcResult<Record<string, unknown>>, 'content');
    if (spec.name === 'attach' && result.ok && options.observe !== true) {
        const claimed = await context.client.claimControl('conversation', conversationId, options.takeover === true);
        if (!claimed.ok) return { method, result: { ...result, data: { conversation: result.data, control: claimed, observing: true } } };
        return { method, result: { ...result, data: { conversation: result.data, control: claimed.data, observing: false } } };
    }
    return { method, clientCommandId, result };
}

export function conversationCreateParams(parsed: ParsedArguments, context: Pick<ExecuteContext, 'cwd'>, base: Record<string, unknown> = {}): Record<string, unknown> {
    const options = parsed.options;
    const retention = { ...(base.retention as Record<string, unknown> | undefined), mode: options.mode ?? (base.retention as Record<string, unknown> | undefined)?.mode ?? 'archive',
        ...(typeof options.ttl === 'string' ? { ttlDurationMs: parseDuration(options.ttl) } : {}) };
    const selected = { ...(typeof options.profile === 'string' ? { profileId: options.profile } : {}), ...(typeof options.model === 'string' ? { modelId: options.model } : {}) };
    const existingOptions = base.options as Record<string, unknown> | undefined;
    const conversationOptions: Record<string, unknown> = { allowSubagents: false, ...existingOptions, ...selected,
        writeRoots: existingOptions?.writeRoots ?? existingOptions?.workspaceRoots ?? existingOptions?.writableRoots ?? [context.cwd] };
    delete conversationOptions.writableRoots;
    if (Object.keys(selected).length) conversationOptions.modelSelection = { ...(conversationOptions.modelSelection as Record<string, unknown> | undefined), ...selected };
    if (options['write-root']) conversationOptions.writeRoots = (options['write-root'] as string[]).map(path => resolve(context.cwd, path));
    if (options.title !== undefined) conversationOptions.title = options.title;
    if (options['allow-subagents'] !== undefined) conversationOptions.allowSubagents = options['allow-subagents'];
    return { ...base, retention, options: conversationOptions, callerHost: 'standalone-cli', callerConversationId: null };
}

export function parseBudget(parsed: ParsedArguments, fallback?: unknown): Record<string, unknown> {
    const options = parsed.options;
    const budget = typeof options.budget === 'string' ? parseJsonObject(options.budget, '--budget') : fallback && typeof fallback === 'object' && !Array.isArray(fallback) ? { ...fallback as Record<string, unknown> } : {};
    const fields: Record<string, string> = {
        'wall-ms': 'wallMs', 'max-model-calls': 'maxModelCalls', 'max-cost-micros': 'maxCostMicros', currency: 'currency',
        'cost-mode': 'costMode', 'max-output-tokens': 'maxOutputTokens',
    };
    for (const [option, field] of Object.entries(fields)) if (options[option] !== undefined) budget[field] = options[option];
    if (Object.keys(budget).length === 0) throw new AgentFault('BUDGET_REQUIRED', '提交执行需要明确预算，尚未发送模型请求', { recovery: 'sandbox_agent help runs start' });
    budget.wallMs ??= 3_600_000;
    budget.maxModelCalls ??= 128;
    budget.maxOutputTokens ??= 4096;
    budget.costMode ??= 'hard';
    validateBudget(budget, Date.now());
    if (!Number.isSafeInteger(budget.maxOutputTokens) || Number(budget.maxOutputTokens) < 1) throw usage('maxOutputTokens须为有限正整数');
    return budget;
}
