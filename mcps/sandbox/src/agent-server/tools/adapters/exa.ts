import { AgentFault } from '../../protocol.js';
import type { SharedToolSpec } from './types.js';

export const exaToolSpecs: SharedToolSpec[] = ['web_search_exa', 'web_fetch_exa'].map(name => ({ serviceId: 'exa', name,
    summary: name === 'web_search_exa' ? '有界网页搜索，保留来源URL' : '有界网页正文提取，保留来源URL', effects: ['network', 'read'], supportsTemporary: false,
    bind(args) {
        if (args.type !== undefined && !['auto', 'fast', 'neural', 'keyword'].includes(String(args.type))) throw new AgentFault('TOOL_NOT_ALLOWED', '该Exa搜索类型未分类，保持关闭');
        for (const key of ['model', 'provider', 'modelChain', 'summary', 'ai_summary', 'answer']) if (key in args) throw new AgentFault('TOOL_NOT_ALLOWED', 'Exa未开放生成式回答分支');
        const count = args.numResults ?? 5;
        const characters = args.maxCharacters ?? 20000;
        if (!Number.isInteger(count) || Number(count) < 1 || Number(count) > 10 || !Number.isInteger(characters) || Number(characters) < 1 || Number(characters) > 20000) throw new AgentFault('INVALID_PARAMS', 'Exa结果数或字符预算超出当前范围');
        return { ...args };
    } }));
