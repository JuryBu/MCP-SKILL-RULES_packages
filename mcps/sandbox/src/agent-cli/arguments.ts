import { AgentFault } from '../agent-server/protocol.js';

export type OptionKind = 'string' | 'number' | 'boolean' | 'strings';
export type CliOptionValue = string | number | boolean | string[];

export const OPTION_TYPES: Record<string, OptionKind> = {
    'data-dir': 'string', 'client-id': 'string', 'server-entry': 'string', 'deadline-at': 'string',
    'timeout-ms': 'number', 'startup-timeout-ms': 'number', json: 'boolean', help: 'boolean', version: 'boolean',
    observe: 'boolean', plain: 'boolean', diagnostics: 'boolean', conversation: 'string', 'conversation-id': 'string',
    'command-id': 'string', 'lease-id': 'string', 'control-epoch': 'number', params: 'string',
    mode: 'string', ttl: 'string', profile: 'string', model: 'string', 'write-root': 'strings',
    title: 'string', 'allow-subagents': 'boolean', state: 'string', cursor: 'string', limit: 'number',
    reason: 'string', scope: 'string', takeover: 'boolean', after: 'string', wait: 'number', 'max-bytes': 'number',
    'applied-cursor': 'string', 'subscription-id': 'string', 'run-id': 'string', 'run-epoch': 'number',
    'history-epoch': 'number', revision: 'number', text: 'string', 'input-file': 'string', stdin: 'boolean',
    budget: 'string', 'wall-ms': 'number', 'max-model-calls': 'number', 'max-cost-micros': 'number',
    currency: 'string', 'cost-mode': 'string', 'max-output-tokens': 'number', 'input-mode': 'string',
    'draft-id': 'string', 'draft-revision': 'number', 'target-round': 'string', 'input-ids': 'string',
    'grace-ms': 'number', 'start-round': 'number', 'end-round': 'number', detach: 'boolean', format: 'string',
    protocol: 'string', 'base-url': 'string', label: 'string', 'secret-file': 'string', 'route-id': 'string',
    refresh: 'boolean', global: 'boolean', key: 'string', value: 'string', preview: 'boolean',
    'interaction-id': 'string', decision: 'string', answer: 'string', 'scope-hash': 'string', 'action-hash': 'string',
    'policy-revision': 'number', graphics: 'string', color: 'string', 'reduce-motion': 'boolean', accessible: 'boolean',
    'cell-size': 'string', renderer: 'string', 'image-cache': 'string',
    cancel: 'boolean', 'acknowledge-unknown': 'boolean', 'retry-known-failure': 'boolean', 'config-fingerprint': 'string',
    'quota-limit-id': 'string', 'quota-scope-ids': 'string', 'source-ref': 'string', 'root-budget-id': 'string', 'amount-mode': 'string',
    'secret-format': 'string', 'secret-field': 'string',
    terminal: 'boolean', force: 'boolean',
    query: 'string', host: 'string', 'source-id': 'string', 'tool-id': 'string',
    'restore-plan-id': 'string', 'workspace-revision': 'number', 'preview-token': 'string', raw: 'boolean', summary: 'boolean',
    attachment: 'strings', reference: 'strings', mime: 'string', range: 'string', 'expected-sha256': 'string',
};

export const GLOBAL_OPTIONS = [
    'data-dir', 'client-id', 'server-entry', 'deadline-at', 'timeout-ms', 'startup-timeout-ms',
    'json', 'help', 'version', 'observe', 'plain', 'diagnostics', 'conversation', 'conversation-id',
    'graphics', 'color', 'reduce-motion', 'accessible', 'cell-size', 'renderer', 'image-cache',
];

export interface ParsedArguments {
    words: string[];
    options: Record<string, CliOptionValue>;
}

export function parseArguments(argv: string[]): ParsedArguments {
    const words: string[] = [];
    const options: Record<string, CliOptionValue> = {};
    let literal = false;
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (literal) { words.push(argument); continue; }
        if (argument === '--') { literal = true; continue; }
        const normalized = argument === '-h' ? '--help' : argument === '-V' ? '--version' : argument;
        if (!normalized.startsWith('--')) {
            if (normalized.startsWith('-')) throw usage(`未知短参数：${normalized}`);
            words.push(normalized);
            continue;
        }
        const separator = normalized.indexOf('=');
        const name = normalized.slice(2, separator === -1 ? undefined : separator);
        const kind = OPTION_TYPES[name];
        if (!kind) throw usage(`未知参数：--${name}`);
        if (options[name] !== undefined && kind !== 'strings') throw usage(`参数重复：--${name}`);
        const inline = separator === -1 ? undefined : normalized.slice(separator + 1);
        if (kind === 'boolean') {
            if (inline !== undefined && inline !== 'true' && inline !== 'false') throw usage(`--${name}仅接受true或false`);
            options[name] = inline !== 'false';
            continue;
        }
        const value = inline ?? argv[++index];
        if (value === undefined || (inline === undefined && value.startsWith('--'))) throw usage(`--${name}需要一个值`);
        if (kind === 'number') {
            if (!/^-?[0-9]+$/.test(value) || !Number.isSafeInteger(Number(value))) throw usage(`--${name}需要安全整数`);
            options[name] = Number(value);
        } else if (kind === 'strings') {
            const previous = options[name] as string[] | undefined;
            options[name] = [...(previous ?? []), value];
        } else options[name] = value;
    }
    return { words, options };
}

export function tokenizeCommand(line: string): string[] {
    const tokens: string[] = [];
    let token = '';
    let quote: string | null = null;
    let started = false;
    for (let index = 0; index < line.length; index += 1) {
        const character = line[index];
        if (quote) {
            if (character === quote) quote = null;
            else token += character;
            started = true;
        } else if (character === '"' || character === "'") {
            quote = character;
            started = true;
        } else if (/\s/.test(character)) {
            if (started) tokens.push(token);
            token = '';
            started = false;
        } else {
            token += character;
            started = true;
        }
    }
    if (quote) throw usage('引号尚未闭合，输入仍保留在草稿中');
    if (started) tokens.push(token);
    return tokens;
}

export function parseDuration(value: string): number {
    const match = /^([0-9]+(?:\.[0-9]+)?)(ms|s|m|h|d)$/.exec(value);
    if (!match) throw usage('保存时长需写明单位，例如30m、2h或7d');
    const units: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
    const duration = Number(match[1]) * units[match[2]];
    if (!Number.isSafeInteger(duration) || duration < 60_000 || duration > 365 * 86_400_000) throw usage('限时保存时长须在1分钟至365天之间');
    return duration;
}

export function parseJsonObject(value: string, optionName: string): Record<string, unknown> {
    try {
        const parsed: unknown = JSON.parse(value);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {}
    throw usage(`${optionName}须为JSON对象`);
}

export function usage(message: string): AgentFault {
    return new AgentFault('E_CLI_USAGE', message, { recovery: 'sandbox_agent --help' });
}
