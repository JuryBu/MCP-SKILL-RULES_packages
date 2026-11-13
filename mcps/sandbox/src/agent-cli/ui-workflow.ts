import { basename, resolve } from 'node:path';
import { usageOverviewLines, type UsageOverview } from './usage-view.js';

export interface CliProject { name: string; roots: string[] }
export interface CliModelSelection { profileId: string; modelId: string; parameters?: Record<string, unknown>; maxOutputTokens?: number }
export interface CliPreparation {
    mode: string;
    title: string;
    roots: string[];
    projectName: string;
    ttl?: string;
    compression?: CliModelSelection | null;
    parameters: Record<string, unknown>;
    toolsEnabled?: boolean;
}
export interface CliProviderGroup {
    identity: string;
    label: string;
    protocol: string;
    baseUrl: string;
    profiles: Record<string, unknown>[];
}
export interface CliParameterField {
    key: string;
    label: string;
    defaultValue?: string;
    choices?: string[];
    validate?: (text: string, values: Readonly<Record<string, string>>) => string | undefined;
}

export function idleAppearance(lastInputAt: number, replyFinishedAt: number, now = Date.now(), active = false): { appearance: 'human' | 'cat'; appearanceStartedAt: number } {
    const since = Math.max(lastInputAt, replyFinishedAt);
    return active || now - since < 30_000 ? { appearance: 'human', appearanceStartedAt: since }
        : { appearance: 'cat', appearanceStartedAt: since + 30_000 };
}

function object(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function protocolLabel(protocol: unknown): string {
    return ({ compatible_chat: '兼容聊天 API', openai_responses: 'OpenAI Responses 接口', anthropic: 'Anthropic 消息接口', gemini: 'Gemini API', progrok: '本地 Grok 服务' } as Record<string, string>)[String(protocol)] ?? '自定义 API 接口';
}

export function modelToolSupport(entry: unknown, now = Date.now()): { supported: boolean; label: string; reason: string } {
    const evidence = object(object(entry).tools);
    const observed = typeof evidence.observedAt === 'string' ? Date.parse(evidence.observedAt) : NaN;
    const expires = typeof evidence.expiresAt === 'string' ? Date.parse(evidence.expiresAt) : NaN;
    if (Number.isFinite(expires) && expires <= now) return { supported: false, label: '工具能力信息已过期', reason: '工具能力信息已过期，文件读写等任务需要先刷新并核实模型能力' };
    if (Number.isFinite(observed) && observed > now) return { supported: false, label: '工具能力记录时间超前', reason: '工具能力记录时间超前，核实后再开始需要工具的任务' };
    if (evidence.status === 'unsupported' || evidence.status === 'supported' && evidence.value === false) return { supported: false, label: '当前模型未支持工具', reason: '当前模型的能力声明未支持工具，请选择支持工具的模型完成文件读写等任务' };
    if (evidence.status === 'supported' && evidence.value === true && Number.isFinite(observed) && Number.isFinite(expires)) return { supported: true, label: '工具能力已确认', reason: '可使用当前允许的工具完成任务' };
    return { supported: false, label: '工具能力尚未确认', reason: '模型目录尚无有效的工具能力证据，文件读写等任务需要先核实' };
}

export function projectFromOptions(options: unknown, cwd: string): CliProject {
    const values = object(options);
    const declared = values.writeRoots ?? values.workspaceRoots;
    const roots = Array.isArray(declared) && declared.length ? declared.filter((value): value is string => typeof value === 'string' && Boolean(value)) : [cwd];
    const effective = roots.length ? roots.map(value => resolve(cwd, value)) : [resolve(cwd)];
    return { name: typeof values.projectName === 'string' && values.projectName.trim() ? values.projectName.trim() : basename(effective[0]) || effective[0], roots: effective };
}

export function groupProviderProfiles(profiles: Record<string, unknown>[]): CliProviderGroup[] {
    const groups = new Map<string, CliProviderGroup>();
    for (const profile of profiles) {
        const protocol = String(profile.protocol ?? 'compatible_chat');
        let baseUrl = '';
        let host = '自定义API';
        try {
            const address = new URL(String(profile.baseUrl));
            host = address.host;
            address.username = ''; address.password = ''; address.search = ''; address.hash = '';
            baseUrl = address.toString().replace(/\/+$/, '');
        } catch {}
        const provider = ({ 'api.deepseek.com': 'DeepSeek', 'api.openai.com': 'OpenAI', 'api.anthropic.com': 'Anthropic', 'generativelanguage.googleapis.com': 'Google Gemini' } as Record<string, string>)[host.toLowerCase()] ?? host;
        const identity = JSON.stringify([protocol, baseUrl || String(profile.profileId)]);
        const group = groups.get(identity) ?? { identity, label: provider, protocol, baseUrl, profiles: [] };
        group.profiles.push(profile);
        groups.set(identity, group);
    }
    return [...groups.values()];
}

export function declaredParameterFields(entry: unknown, current: Record<string, unknown>, now = Date.now()): CliParameterField[] {
    const labels: Record<string, string> = { reasoningEffort: '推理强度', temperature: '温度', maxOutputTokens: '最大输出token', topP: 'Top P', topK: 'Top K', thinkingBudget: '思考token预算' };
    return Object.entries(object(object(entry).parameters)).flatMap(([key, raw]) => {
        const evidence = object(raw);
        const definition = object(evidence.value);
        if (evidence.status !== 'supported' || !Object.keys(definition).length || typeof evidence.expiresAt === 'string' && Date.parse(evidence.expiresAt) <= now || typeof evidence.observedAt === 'string' && Date.parse(evidence.observedAt) > now) return [];
        const enumeration = Array.isArray(definition.enum) ? definition.enum : definition.type === 'boolean' ? [true, false] : undefined;
        if (!enumeration && !['integer', 'number', 'string'].includes(String(definition.type))) return [];
        const choices = enumeration ? ['', ...enumeration.map(String)] : undefined;
        const bounds = [definition.min === undefined ? '' : '最小' + definition.min, definition.max === undefined ? '' : '最大' + definition.max].filter(Boolean).join('，');
        const fallback = definition.default === undefined ? '留空沿有效默认值' : `留空使用默认${definition.default}`;
        return [{ key, label: `${labels[key] ?? key}（${bounds ? bounds + '，' : ''}${fallback}）`, defaultValue: current[key] === undefined ? '' : String(current[key]), choices,
            validate: (text: string) => {
                if (!text || choices) return undefined;
                if (definition.type === 'string') return undefined;
                const value = Number(text);
                if (!Number.isFinite(value) || definition.type === 'integer' && !Number.isSafeInteger(value)) return '请填写有效' + (definition.type === 'integer' ? '整数' : '数字');
                if (typeof definition.min === 'number' && value < definition.min || typeof definition.max === 'number' && value > definition.max) return '请按当前模型支持的范围填写';
                return undefined;
            } }];
    });
}

export function readParameterValues(entry: unknown, values: Record<string, string>, current: Record<string, unknown>): Record<string, unknown> {
    const parameters = { ...current };
    const definitions = object(object(entry).parameters);
    for (const [key, text] of Object.entries(values)) {
        if (!text) { delete parameters[key]; continue; }
        const definition = object(object(definitions[key]).value);
        const enumeration = Array.isArray(definition.enum) ? definition.enum : definition.type === 'boolean' ? [true, false] : undefined;
        parameters[key] = enumeration ? enumeration.find(value => String(value) === text)
            : ['integer', 'number'].includes(String(definition.type)) ? Number(text) : text;
    }
    return parameters;
}

export function chatUsageLines(overview?: UsageOverview): string[] {
    return overview ? usageOverviewLines(overview) : [];
}

export function detailedUsageLines(overview?: UsageOverview, state = '用量正在加载'): string[] {
    if (!overview) return usageOverviewLines(undefined, state, { details: true });
    const account = object(overview.account);
    const observed = typeof account.observedAt === 'string' ? account.observedAt : overview.account.asOf;
    const display = { ...overview, asOf: localTime(overview.asOf), account: { ...overview.account, ...(observed ? { asOf: localTime(observed) } : {}) } };
    return usageOverviewLines(display, state, { details: true });
}

export function localTime(value: unknown): string {
    if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return '未记录';
    return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(value)) + '（本机时间）';
}

export function optionalDateTime(value: string): string | null {
    if (!value.trim()) return null;
    const text = value.trim().replace(' ', 'T');
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?$/.test(text) || !Number.isFinite(Date.parse(text))) throw new Error('时间请填写为2026-11-20 18:00，或带时区的ISO时间');
    const [year, month, day] = text.slice(0, 10).split('-').map(Number);
    const calendar = new Date(Date.UTC(year, month - 1, day));
    if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day || Number(text.slice(11, 13)) > 23 || Number(text.slice(14, 16)) > 59) throw new Error('请核对实际日期与时间');
    return new Date(text).toISOString();
}
