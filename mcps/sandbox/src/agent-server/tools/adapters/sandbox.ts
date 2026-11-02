import { AgentFault } from '../../protocol.js';
import { assertNotProtected, isWithin } from '../../security/policy.js';
import type { SharedToolSpec } from './types.js';
import { ownerArguments, requireExact } from './types.js';

export const sandboxToolSpecs: SharedToolSpec[] = [
    { serviceId: 'sandbox', name: 'smart_search', summary: '只读exact代码搜索', effects: ['read'], supportsTemporary: false,
        bind(args, context) {
            requireExact(args);
            const searches = Array.isArray(args.queries) ? args.queries : [args];
            for (const entry of searches) {
                if (!entry || typeof entry !== 'object') throw new AgentFault('INVALID_PARAMS', '搜索参数无效');
                const query = entry as Record<string, unknown>;
                requireExact(query);
                const searchPath = query.searchPath ?? args.searchPath;
                if (typeof searchPath !== 'string') throw new AgentFault('INVALID_PARAMS', '代码搜索需要明确的绝对搜索根');
                assertNotProtected(searchPath, context);
                if ((context.protectedPaths ?? []).some(protectedPath => isWithin(protectedPath, searchPath))) throw new AgentFault('TOOL_NOT_ALLOWED', '该搜索根包含核心保留路径，请缩小搜索范围');
            }
            return { ...args, mode: 'exact', background: false, ...ownerArguments(context),
                ...(Array.isArray(args.queries) ? { queries: args.queries.map(query => ({ ...(query as object), mode: 'exact' })) } : {}) };
        } },
    { serviceId: 'sandbox', name: 'sandbox_status', summary: '只读环境与资源概况', effects: ['read'], supportsTemporary: true,
        bind(args) {
            if (args.action !== undefined && !['overview', 'envs'].includes(String(args.action))) throw new AgentFault('TOOL_NOT_ALLOWED', '状态入口仅开放overview和envs');
            for (const key of ['gcMode', 'gcScope', 'quarantineId']) if (key in args) throw new AgentFault('TOOL_NOT_ALLOWED', '任务模型未开放全局维护入口');
            return { ...args, action: args.action ?? 'overview' };
        } },
];
