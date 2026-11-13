import { AgentFault } from '../protocol.js';
import type { ToolCatalogEntry } from './types.js';

const aliases = [
    ['environment', 'system', 'runtime', 'envs', '环境', '运行环境', '系统', '资源', '状态'],
    ['file', 'files', 'folder', 'directory', '文件', '文件夹', '目录'],
    ['read', 'reading', '读取', '读回', '查回'],
    ['write', 'edit', 'patch', 'modify', '写入', '修改', '补丁', '编辑'],
    ['search', 'find', 'lookup', '搜索', '查找', '检索'],
    ['history', 'conversation', '历史', '对话', '原文'],
    ['memory', 'record', '记忆', '记录'],
    ['web', 'page', 'browser', '网页', '浏览器'],
    ['plan', 'task', '计划', '任务'],
    ['command', 'execute', 'process', '命令', '执行', '程序', '进程'],
];

function matches(entry: ToolCatalogEntry, query: string): boolean {
    const haystack = `${entry.toolId} ${entry.name} ${entry.summary}`.toLocaleLowerCase('en-US');
    if (haystack.includes(query)) return true;
    return query.split(/[\s_.-]+/u).filter(Boolean).every(term => {
        const terms = new Set([term, ...aliases.filter(group => group.includes(term)).flat()]);
        return [...terms].some(candidate => haystack.includes(candidate));
    });
}

export function searchToolCatalog(entries: ToolCatalogEntry[], input: { query?: string; cursor?: string; limit?: number }) {
    const query = String(input.query ?? '').trim().toLocaleLowerCase('en-US');
    const limit = input.limit ?? 24;
    const browsing = input.cursor?.startsWith('all:') === true;
    const offset = Number(browsing ? input.cursor!.slice(4) : input.cursor ?? 0);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new AgentFault('INVALID_PARAMS', '工具目录分页参数无效');
    }
    const found = query && !browsing ? entries.filter(entry => matches(entry, query)) : entries;
    const fallback = Boolean(query) && (browsing || found.length === 0);
    const selected = fallback ? entries : found;
    const start = fallback && !browsing ? 0 : offset;
    return { entries: selected.slice(start, start + limit),
        nextCursor: start + limit < selected.length ? `${fallback ? 'all:' : ''}${start + limit}` : null,
        query: query || null, queryMatched: !fallback, fallback: fallback ? 'bounded_catalog' : null,
        nextStep: fallback ? '关键词没有匹配，已从完整可见目录分页回退；沿nextCursor继续，使用返回的toolId描述或加载工具。'
            : '使用toolId读取说明或加载工具；schema_pending表示已配置待核，下一请求可发布性以tool_load回执为准。' };
}
