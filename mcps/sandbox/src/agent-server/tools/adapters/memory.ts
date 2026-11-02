import { AgentFault } from '../../protocol.js';
import type { SharedToolSpec } from './types.js';
import { requireExact } from './types.js';

const names = ['memory_query', 'memory_read', 'record_manage', 'conversation_read_original'] as const;

export const memoryToolSpecs: SharedToolSpec[] = names.map(name => ({ serviceId: 'memory-store', name,
    summary: `只读${name}，搜索固定exact`, effects: ['read'], supportsTemporary: false,
    bind(args, context) {
        requireExact(args);
        if (name === 'record_manage' && !['list', 'read', 'search'].includes(String(args.action))) throw new AgentFault('TOOL_NOT_ALLOWED', 'Record仅开放list/read/exact search');
        if (name === 'conversation_read_original' && !['list', 'fetch', 'read', 'search', 'recall'].includes(String(args.action))) throw new AgentFault('TOOL_NOT_ALLOWED', '原文入口仅开放已批准的读取动作');
        if (name === 'memory_read' && (args.enhance === true || args.ai_summary === true)) throw new AgentFault('TOOL_NOT_ALLOWED', '读取未开放模型增强');
        if (name === 'memory_read' && (!Number.isInteger(args.startLine) || !Number.isInteger(args.endLine))) throw new AgentFault('INVALID_PARAMS', '记忆读取需要明确行范围，避免将正文写入共享临时文件');
        if ((name === 'record_manage' || name === 'conversation_read_original') && !context.callerConversationId) throw new AgentFault('TOOL_CAPABILITY_UNVERIFIED', '宿主记忆入口需要核心绑定真实callerConversationId，核心新会话ID保留独立');
        return { ...args, ...(name === 'memory_query' || args.action === 'search' ? { mode: 'exact' } : {}),
            ...(name === 'record_manage' || name === 'conversation_read_original' ? { conversationId: context.callerConversationId } : {}),
            ...(name === 'record_manage' || name === 'conversation_read_original' ? { background: false } : {}) };
    } }));
