import { AgentFault } from '../../protocol.js';
import type { SharedToolSpec } from './types.js';
import { ownerArguments } from './types.js';
import type { BoundToolContext } from '../types.js';
import { assertWebOutputRoot } from '../../resources/web-mcp-adapter.js';
import type { OwnedWebToolName, WebMcpResourceAdapter, WebResourceCall, WebResourceReference } from '../../resources/web-mcp-adapter.js';

const webArgumentFields: Readonly<Record<string, readonly string[]>> = Object.freeze({
    web_fetch_page: Object.freeze(['url', 'waitFor', 'timeout', 'scrollCount', 'outputMode', 'viewport']),
    web_fetch_html: Object.freeze(['url', 'selector', 'timeout', 'scrollCount']),
    web_extract_links: Object.freeze(['url', 'selector', 'timeout', 'scrollCount']),
    web_extract_tables: Object.freeze(['url', 'selector', 'format', 'timeout', 'scrollCount']),
    web_inspect: Object.freeze(['url', 'mode', 'page', 'detect', 'viewport', 'thresholds']),
    web_fetch_screenshot: Object.freeze(['url', 'selector', 'fullPage', 'viewport', 'timeout', 'scrollCount', 'quality']),
});

export function webToolAllowedArguments(name: string): readonly string[] | undefined {
    return Object.hasOwn(webArgumentFields, name) ? webArgumentFields[name] : undefined;
}

export function webToolNoModelArgumentFact(name: string): { scope: 'all_allowed_arguments'; modelEffect: 'none'; allowedArguments: readonly string[] } | undefined {
    const fields = webToolAllowedArguments(name);
    return fields ? { scope: 'all_allowed_arguments', modelEffect: 'none', allowedArguments: fields } : undefined;
}

function assertAllowedWebArguments(name: string, args: Record<string, unknown>, context: BoundToolContext, allowTemporary = false): void {
    if (context.retention.mode === 'temporary' && !allowTemporary) throw new AgentFault('TOOL_CAPABILITY_UNVERIFIED', '网页整体无正文落盘尚未验证，临时方式保持关闭');
    if (context.signal.aborted) throw new AgentFault('TOOL_CANCELLED', '所属网页任务已取消');
    const fields = webToolAllowedArguments(name);
    if (!fields) throw new AgentFault('TOOL_CAPABILITY_UNVERIFIED', '网页工具参数尚未完成分类');
    for (const field of Object.keys(args)) if (!fields.includes(field)) throw new AgentFault('TOOL_CAPABILITY_UNVERIFIED', '该字段未纳入已核实的普通网页分支', { field });
    if (args.viewport !== undefined) {
        if (!args.viewport || typeof args.viewport !== 'object' || Array.isArray(args.viewport)
            || Object.keys(args.viewport).some(field => !['width', 'height'].includes(field))) throw new AgentFault('INVALID_PARAMS', 'viewport只接受width和height');
    }
    if (args.thresholds !== undefined) {
        const fields = ['smallFontPx', 'smallFontPt', 'contrastRatio', 'titleTopVarianceEmu', 'sizeVarianceRatio', 'gapVarianceRatio'];
        if (!args.thresholds || typeof args.thresholds !== 'object' || Array.isArray(args.thresholds)
            || Object.entries(args.thresholds).some(([field, value]) => !fields.includes(field) || typeof value !== 'number' || !Number.isFinite(value) || value <= 0)) {
            throw new AgentFault('INVALID_PARAMS', '检查阈值只接受已声明的正数检测参数');
        }
    }
}

export function assertWebToolArgumentSchema(name: string, schema: Record<string, unknown>): void {
    if (!webToolAllowedArguments(name)) throw new AgentFault('TOOL_CAPABILITY_UNVERIFIED', '网页工具参数尚未完成分类');
    const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    const requireType = (field: string, type: string): void => {
        if (properties[field]?.type !== type) throw new AgentFault('TOOL_CAPABILITY_UNVERIFIED', '网页原生schema缺少必须绑定的参数类型', { field });
    };
    const requireValues = (field: string, values: readonly string[]): void => {
        const declared = properties[field]?.enum;
        if (!Array.isArray(declared) || values.some(value => !declared.includes(value))) throw new AgentFault('TOOL_CAPABILITY_UNVERIFIED', '网页原生schema未声明所需的普通读取分支', { field });
    };
    requireType('ownerId', 'string');
    requireType('url', 'string');
    requireValues('humanAssistance', ['never']);
    if (name === 'web_fetch_page') { requireValues('outputMode', ['full', 'compact', 'headings']); requireType('background', 'boolean'); }
    if (name === 'web_inspect') {
        requireValues('mode', ['structure', 'detect']); requireValues('saveMode', ['inline']);
        requireType('autoScreenshot', 'boolean'); requireType('background', 'boolean');
    }
    if (name === 'web_extract_tables') requireValues('format', ['markdown', 'csv', 'json']);
    if (name === 'web_fetch_screenshot') { requireValues('saveMode', ['inline']); requireType('autoSplit', 'boolean'); }
}

export const webToolSpecs: SharedToolSpec[] = ['web_fetch_page', 'web_fetch_html', 'web_extract_links', 'web_extract_tables', 'web_inspect'].map(name => ({
    serviceId: 'web-fetcher', name, summary: `只读网页${name}，关闭AI总结和AI审查`, effects: ['read', 'network'], supportsTemporary: false,
    ...(name === 'web_extract_tables' ? { disabledReason: '原生三种表格格式都会写后端临时文件，当前任务产物归属保持pending' } : {}),
    bind(args, context) {
        assertAllowedWebArguments(name, args, context);
        if (name === 'web_fetch_page' && args.outputMode !== undefined && !['full', 'compact', 'headings'].includes(String(args.outputMode))) throw new AgentFault('TOOL_NOT_ALLOWED', '网页只开放full/compact/headings读取');
        if (name === 'web_inspect' && !['structure', 'detect'].includes(String(args.mode))) throw new AgentFault('TOOL_NOT_ALLOWED', '网页检查只开放structure/detect');
        if (name === 'web_extract_tables' && args.format !== undefined && !['markdown', 'csv', 'json'].includes(String(args.format))) throw new AgentFault('TOOL_NOT_ALLOWED', '表格只接受markdown/csv/json');
        return { ...args, ...ownerArguments(context), humanAssistance: 'never',
            ...(name === 'web_fetch_page' ? { outputMode: args.outputMode ?? 'compact', background: false } : {}),
            ...(name === 'web_inspect' ? { autoScreenshot: false, saveMode: 'inline', background: false } : {}) };
    },
}));

export const disabledWebToolSpecs: SharedToolSpec[] = ['web_interact', 'web_pipeline', 'web_fetch_screenshot', 'web_screenshot'].map(name => ({
    serviceId: 'web-fetcher', name, summary: name, effects: ['external'], supportsTemporary: false,
    disabledReason: name === 'web_fetch_screenshot'
        ? '普通HTTP单次inline截图已有独立适配定义，等待主线接入；借用会话、文件、文档与对比截图分支保持关闭'
        : '尚缺核心绑定的认证、原请求查回、租约或获准产物根，持续页面入口保持关闭',
    bind() { throw new AgentFault('TOOL_CAPABILITY_UNVERIFIED', '该能力保持关闭'); },
}));

export const oneShotWebScreenshotSpec: SharedToolSpec = {
    serviceId: 'web-fetcher', name: 'web_fetch_screenshot', summary: '普通HTTP网页单次截图，图片随原工具结果返回，不保留会话、不写独立截图文件',
    effects: ['read', 'network'], supportsTemporary: false,
    bind(args, context) {
        if (context.retention.mode === 'temporary') throw new AgentFault('TOOL_CAPABILITY_UNVERIFIED', '浏览器整体无正文落盘尚未验证，临时截图保持关闭');
        if (context.signal.aborted) throw new AgentFault('TOOL_CANCELLED', '单次截图所属任务已取消');
        assertAllowedWebArguments('web_fetch_screenshot', args, context);
        let url: URL;
        try { url = new URL(String(args.url)); }
        catch { throw new AgentFault('INVALID_PARAMS', '单次截图需要完整HTTP网页URL'); }
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
            || /\.(?:pdf|docx?|pptx?|xlsx?|epub)$/i.test(url.pathname)) {
            throw new AgentFault('TOOL_CAPABILITY_UNVERIFIED', '首版单次截图只启用普通HTTP网页');
        }
        return { ...args, ...ownerArguments(context), saveMode: 'inline', autoSplit: true, humanAssistance: 'never' };
    },
};

export function assertOneShotWebScreenshotSchema(schema: Record<string, unknown>): void {
    const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    for (const field of ['ownerId', 'saveMode', 'humanAssistance', 'autoSplit']) {
        if (!Object.hasOwn(properties, field)) throw new AgentFault('TOOL_CAPABILITY_UNVERIFIED', '单次截图原生schema缺少必须固定的分支参数', { field });
    }
    for (const [field, value] of [['saveMode', 'inline'], ['humanAssistance', 'never']]) {
        const values = properties[field].enum;
        if (!Array.isArray(values) || !values.includes(value)) throw new AgentFault('TOOL_CAPABILITY_UNVERIFIED', '单次截图原生schema尚未声明所需分支', { field });
    }
    if (properties.autoSplit.type !== 'boolean' || properties.ownerId.type !== 'string') {
        throw new AgentFault('TOOL_CAPABILITY_UNVERIFIED', '单次截图原生schema参数类型尚未核实');
    }
}

const resourceFields: Record<OwnedWebToolName, readonly string[]> = {
    web_interact: ['url', 'action', 'selector', 'value', 'scrollCount', 'timeout', 'frame', 'viewport', 'fullPage'],
    web_pipeline: ['url', 'steps', 'timeout', 'compact', 'viewport'],
    web_fetch_screenshot: ['url', 'fullPage', 'viewport', 'selector', 'target', 'scale', 'timeout', 'scrollCount', 'quality', 'page', 'pages'],
};
const readActions = new Set(['scroll', 'wait', 'screenshot', 'content', 'visible', 'snapshot', 'find', 'links']);

export function webPersistentToolAllowedArguments(name: string): readonly string[] | undefined {
    return Object.hasOwn(resourceFields, name) ? resourceFields[name as OwnedWebToolName] : undefined;
}

export function assertOwnedWebArguments(toolName: OwnedWebToolName, args: Record<string, unknown>, context: BoundToolContext, allowTemporary = false): void {
    if (context.retention.mode === 'temporary' && !allowTemporary) throw new AgentFault('TOOL_CAPABILITY_UNVERIFIED', '网页临时模式尚无无正文落盘保证，保持关闭');
    if (!Object.hasOwn(resourceFields, toolName)) throw new AgentFault('TOOL_NOT_ALLOWED', '网页工具尚未完成资源分类');
    for (const field of Object.keys(args)) if (!resourceFields[toolName].includes(field)) {
        throw new AgentFault('TOOL_CAPABILITY_UNVERIFIED', '网页参数尚未绑定当前资源合同', { field });
    }
    if (toolName === 'web_interact' && (!readActions.has(String(args.action)) || args.action === 'links')) {
        throw new AgentFault('TOOL_CAPABILITY_UNVERIFIED', '网页交互当前只启用已分类的普通读取动作');
    }
    if (toolName === 'web_pipeline') {
        if (!Array.isArray(args.steps) || !args.steps.length) throw new AgentFault('INVALID_PARAMS', '网页pipeline需要明确步骤');
        for (const step of args.steps as Record<string, unknown>[]) {
            if (!step || !readActions.has(String(step.action)) || Object.keys(step).some(field => !['action', 'selector', 'value', 'scrollCount', 'waitMs', 'fullPage'].includes(field))) {
                throw new AgentFault('TOOL_CAPABILITY_UNVERIFIED', '网页pipeline步骤尚未完成普通读取分类');
            }
        }
        if (args.compact !== undefined && !['full', 'compact', 'headings'].includes(String(args.compact))) throw new AgentFault('TOOL_NOT_ALLOWED', '网页pipeline只启用full/compact/headings');
    }
    if (context.signal.aborted) throw new AgentFault('TOOL_CANCELLED', '所属网页任务已取消');
}

export function assertNativeWebTableArguments(args: Record<string, unknown>, context: BoundToolContext): void {
    assertAllowedWebArguments('web_extract_tables', args, context, true);
    if (args.format !== undefined && !['markdown', 'csv', 'json'].includes(String(args.format))) {
        throw new AgentFault('TOOL_NOT_ALLOWED', '表格只接受markdown/csv/json');
    }
}

export function verifiedPersistentWebToolSpecs(adapter: Pick<WebMcpResourceAdapter, 'contract'>): SharedToolSpec[] {
    if (!adapter.contract.enabled || adapter.contract.missing.length) throw new AgentFault('TOOL_CAPABILITY_UNVERIFIED', '持续网页须先验证完整资源合同');
    return (['web_interact', 'web_pipeline'] as const).map(name => ({ serviceId: 'web-fetcher', name,
        summary: '已验证有限租约的普通持续网页读取，原请求可查回，结束只回收所属资源', effects: ['read', 'network', 'write'],
        supportsTemporary: false, bind(args, context) { assertOwnedWebArguments(name, args, context); return structuredClone(args); } }));
}

export async function bindOwnedWebResourceCall(toolName: OwnedWebToolName, args: Record<string, unknown>, context: BoundToolContext,
    outputRoot: string, reference: WebResourceReference = { kind: 'owned' }): Promise<WebResourceCall> {
    assertOwnedWebArguments(toolName, args, context);
    const bound = structuredClone(args);
    if (toolName === 'web_pipeline') bound.keepSession = true;
    if (reference.kind === 'borrowed') {
        if (!reference.externalId || args.url !== undefined) throw new AgentFault('INVALID_PARAMS', '借用网页引用须保留原页面且不同时导航');
        bound.sessionId = reference.externalId;
    } else {
        if (typeof args.url !== 'string' || !['http:', 'https:'].includes(new URL(args.url).protocol)) {
            throw new AgentFault('TOOL_CAPABILITY_UNVERIFIED', '持续网页首版只启用普通HTTP网页');
        }
    }
    await context.assertCurrent?.();
    if (context.signal.aborted) throw new AgentFault('TOOL_CANCELLED', '所属网页任务已取消');
    return { toolName, args: { ...bound, ...ownerArguments(context), saveMode: 'file', humanAssistance: 'never' },
        outputRoot: await assertWebOutputRoot(outputRoot, context), reference: structuredClone(reference) };
}
