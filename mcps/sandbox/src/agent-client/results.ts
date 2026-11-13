import { AgentFault, type RpcResult } from '../agent-server/protocol.js';
import { renderHistoryExport } from '../agent-server/rpc-history-export.js';
import type { HistoryPage } from '../agent-server/storage/port.js';
import { readCatalogVersion } from '../agent-server/models/catalog-state.js';

function record(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function safeText(value: unknown): string {
    return String(value ?? '').replace(/\x1b[\]P_^][\s\S]*?(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
        .replace(/\x1b[ -/]*[@-~]/g, '').replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
}

export function formatLocalTimestamp(value: unknown): string {
    if (typeof value !== 'string' || !value.trim()) return '未提供';
    if (value.endsWith('（本机时间）')) return safeText(value);
    const instant = Date.parse(value);
    if (!Number.isFinite(instant)) return '未提供，原时间格式无效';
    return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
        minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(instant)) + '（本机时间）';
}

export function getCatalogVersion(source: unknown): string | null | undefined {
    const root = record(source), data = record(root.data);
    const versions = [root, data, record(root.catalog), record(data.catalog)].map(value => value.catalogVersion)
        .filter((value): value is string | null => value === null || typeof value === 'string');
    if (new Set(versions).size > 1) throw new AgentFault('PROTOCOL_MISMATCH', '模型目录返回了不同版本，请重新读取原目录后操作');
    return readCatalogVersion(root) ?? readCatalogVersion(data) ?? (versions.includes(null) ? null : undefined);
}

export function resultReferenceLines(source: unknown): string[] {
    const labels: Record<string, string> = { code: '原错误码', sourceCode: '原传输码', conversationId: '对话', runId: '执行', runEpoch: '执行代次',
        attemptId: '请求尝试', actionId: '动作', clientCommandId: '原命令', requestId: '原请求', receiptId: '回执',
        artifactId: '原件', responseArtifactId: '供应商原件', resultContentId: '结果原件', rawResponseArtifactId: '响应原件',
        rawResponseRef: '响应原件', rawBodyRef: '供应商原件', eventCursor: '事件游标', nextCursor: '下一页游标', snapshotCursor: '快照游标',
        textThroughCursor: '正文水位', operationPhase: '阶段', attempt: '本次连接尝试', maxAttempts: '最多连接尝试', elapsedMs: '已等待毫秒', retryAfterMs: '建议等待毫秒' };
    const numeric = new Set(['runEpoch', 'attempt', 'maxAttempts', 'elapsedMs', 'retryAfterMs']);
    const nested = ['data', 'run', 'failure', 'error', 'details', 'result', 'artifact', 'artifacts', 'rawResponse', 'rawResponseRef', 'rawBodyRef', 'responseRef', 'artifactRefs', 'rawError', 'resultRef', 'failureArtifact'];
    const lines = new Set<string>();
    const pending: { value: unknown; depth: number }[] = [{ value: source, depth: 0 }];
    const seen = new Set<object>();
    while (pending.length) {
        const item = pending.shift()!;
        if (!item.value || typeof item.value !== 'object' || seen.has(item.value)) continue;
        seen.add(item.value);
        if (Array.isArray(item.value)) {
            if (item.depth < 5) for (const value of item.value.slice(0, 32)) pending.push({ value, depth: item.depth + 1 });
            continue;
        }
        const value = record(item.value);
        for (const [key, label] of Object.entries(labels)) if (typeof value[key] === 'string' && value[key] !== '' || numeric.has(key) && Number.isSafeInteger(value[key])) {
            lines.add(`${label}：${safeText(value[key])}`);
        }
        if (value.partial === true || value.truncated === true || value.hasMore === true) lines.add('读取范围：部分内容，沿原游标或原件继续读取');
        if (item.depth < 5) for (const key of nested) if (value[key] && typeof value[key] === 'object') pending.push({ value: value[key], depth: item.depth + 1 });
    }
    return [...lines];
}

export function errorExplanationLines(source: unknown): string[] {
    const error = record(source), details = record(error.details);
    const message = safeText(error.message || '失败原因尚未提供');
    const lines = [message];
    const codes = `${error.code ?? ''} ${details.providerCode ?? ''} ${details.rpcCode ?? ''} ${message}`;
    if (/unsupported.{0,30}(?:country|region)|(?:country|region).{0,30}(?:restrict|not supported)|地区|区域限制/i.test(codes)) {
        lines.push('服务商限制了当前地区或账号，请检查服务商的地区准入与账号条件');
    } else if (['AUTH_FAILED', 'E_CREDENTIALS_INVALID', 'E_AUTHENTICATION_FAILED'].includes(String(error.code))) {
        lines.push('请检查当前配置的账号与凭据状态，再沿原请求核对结果');
    } else if (String(error.code) === 'VERSION_CONFLICT') {
        lines.push('先重新读取当前版本，再确认要应用的修改');
    }
    return lines;
}

export function rpcFailureLines(result: RpcResult): string[] {
    if (result.ok) return [];
    const error = record(result.error);
    const explanation = errorExplanationLines(error);
    return [resultPresentationText(result) ?? '请求未完成：' + explanation[0], ...explanation.slice(1),
        error.mayHaveStarted === true ? '受理状态：原操作可能已经开始，按原命令或执行ID查询结果，保留原请求身份'
            : error.mayHaveStarted === false ? '受理状态：本次操作尚未开始' : '受理状态：尚未提供',
        ...resultReferenceLines(result)];
}

export function resultPresentationText(result: RpcResult): string | undefined {
    const presentation = result.presentation;
    return presentation?.format === 'markdown' && typeof presentation.text === 'string' && presentation.text.trim()
        ? safeText(presentation.text) : undefined;
}

export function agentResultMarkdown(method: string, result: RpcResult): string {
    return resultMarkdown(method, result, 0);
}

function resultMarkdown(method: string, result: RpcResult, depth: number): string {
    if (!result.ok) return rpcFailureLines(result).join('\n\n');
    const data = record(result.data), run = record(data.run ?? data);
    const presentation = resultPresentationText(result);
    if (presentation) {
        const lines = [['runs.get', 'runs.observe'].includes(method) ? '查询已完成' : `请求已完成：${safeText(method)}`, presentation];
        lines.push(...errorExplanationLines(record(run.failure).error).slice(1));
        if (typeof run.state === 'string') lines.push(`目标执行状态：${safeText(run.state)}`);
        if (run.resultStatus === 'partial' || data.partial === true) lines.push('结果范围：部分内容');
        if (typeof data.visibleText === 'string' && data.visibleText) lines.push(safeText(data.visibleText));
        lines.push(...resultReferenceLines(result));
        return lines.join('\n\n');
    }
    if (method === 'server.readBatch' && Array.isArray(data.results) && depth === 0) {
        const lines = [`批量查询已完成：${data.results.length} 项，每项状态分别保留`];
        for (const entry of data.results.slice(0, 16)) {
            const item = record(entry), value = record(item.result);
            lines.push(`### 项目 ${Number.isSafeInteger(item.index) ? Number(item.index) + 1 : '未知'} · ${safeText(item.method ?? '未提供方法')}`);
            lines.push(typeof value.ok === 'boolean' ? resultMarkdown(String(item.method), value as unknown as RpcResult, depth + 1)
                : '该项目缺少完整结果，保留原返回核对');
        }
        if (data.results.length > 16) lines.push('本次仅展开前16项，完整项目继续按原返回读取');
        return lines.join('\n\n');
    }
    if (method === 'conversations.readHistory' && Array.isArray(data.items) && Number.isSafeInteger(data.historyEpoch)
        && Number.isSafeInteger(data.appendSeq) && Number.isSafeInteger(data.viewRevision)) {
        const page = data as unknown as HistoryPage;
        const first = record(page.items[0]);
        const rendered = renderHistoryExport(page, { conversationId: String(data.conversationId ?? first.conversationId ?? ''),
            snapshotCursor: result.eventCursor ?? '', observedAt: typeof data.observedAt === 'string' ? data.observedAt : '', truncatedContentIds: [] });
        return ['历史读取已完成', rendered.markdown, ...resultReferenceLines(result)].filter(Boolean).join('\n\n');
    }
    const failure = record(run.failure);
    const failedRun = ['failed', 'outcome_unknown', 'cancelled'].includes(String(run.state));
    const lines = [failedRun ? `查询已完成，目标执行状态：${safeText(run.state)}` : `请求已完成：${safeText(method)}`];
    if (Object.keys(failure).length) lines.push(...errorExplanationLines(failure.error));
    if (typeof run.state === 'string' && !failedRun) lines.push(`执行状态：${safeText(run.state)}`);
    if (typeof data.final === 'boolean') lines.push(data.final ? '执行水位：最终状态' : '执行水位：当前片段');
    if (typeof data.updatedAt === 'string') lines.push(`执行更新时间：${formatLocalTimestamp(data.updatedAt)}`);
    if (typeof data.observedAt === 'string') lines.push(`读取时间：${formatLocalTimestamp(data.observedAt)}`);
    if (typeof data.text === 'string' && data.text) lines.push(safeText(data.text));
    if (typeof data.visibleText === 'string' && data.visibleText) lines.push(safeText(data.visibleText));
    if (typeof data.markdown === 'string' && data.markdown) lines.push(safeText(data.markdown));
    const items = Array.isArray(data.items) ? data.items : Array.isArray(data.entries) ? data.entries : undefined;
    if (items && method !== 'conversations.export') {
        lines.push(`本页 ${items.length} 项`);
        for (const item of items.slice(0, 50).map(record)) {
            const options = record(item.options);
            const title = item.title ?? options.title ?? item.displayName ?? item.label ?? item.modelId ?? item.runId ?? item.conversationId ?? item.artifactId ?? item.toolId;
            const state = item.state;
            if (typeof title === 'string') lines.push(`- ${safeText(title)}${typeof state === 'string' ? ' · ' + safeText(state) : ''}`);
        }
        if (items.length > 50) lines.push('本次仅展开前50项，完整项目继续按原返回读取');
    }
    if (method === 'events.read' && Array.isArray(data.events)) {
        const text = data.events.map(record).filter(event => event.type === 'run.progress')
            .map(event => record(record(event.payload).partial).textDelta).filter((value): value is string => typeof value === 'string').join('');
        if (text) lines.push(safeText(text));
        lines.push(`本页 ${data.events.length} 条事件`);
    }
    if (run.resultStatus === 'partial' || data.partial === true) lines.push('结果范围：部分内容');
    lines.push(...resultReferenceLines(result));
    return lines.join('\n\n');
}
