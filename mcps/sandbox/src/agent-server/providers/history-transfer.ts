import { AgentFault } from '../protocol.js';
import type { JsonObject } from '../protocol.js';
import { checkToolResults, immutableJson } from './assemble.js';
import type { NativeSendView, NormalizedResponse, ProviderAdapter, ProviderProtocol, ToolResult } from './types.js';

export interface HistoryExchange {
    itemId: string;
    sourceProtocol: ProviderProtocol;
    sourceModelId: string | null;
    sourceEndpoint?: string;
    response: NormalizedResponse;
    results: ToolResult[];
}

export interface HistoryTransferTarget { protocol: ProviderProtocol; modelId: string; endpoint?: string }
export interface HistoryTransferIssue { itemId: string; code: string; reason: string; nativeRefs: string[] }
export interface HistoryTransfer {
    response: NormalizedResponse;
    results: ToolResult[];
    provenance: { itemId: string; attemptId: string; sourceProtocol: ProviderProtocol; targetProtocol: ProviderProtocol;
        nativeRefs: string[]; callIds: string[]; operation: 'native_replay' | 'target_protocol_view' };
}

export function hasHistorySignature(value: unknown): boolean {
    const pending: unknown[] = [value];
    const seen = new WeakSet<object>();
    while (pending.length) {
        const current = pending.pop();
        if (!current || typeof current !== 'object') continue;
        if (seen.has(current)) continue;
        seen.add(current);
        for (const [name, entry] of Object.entries(current)) {
            if (/^(?:thought_?signature|encrypted_content)$/i.test(name) && typeof entry === 'string' && entry.length) return true;
            if (name === 'signature' && ['thinking', 'redacted_thinking', 'reasoning'].includes(String((current as Record<string, unknown>).type))
                && typeof entry === 'string' && entry.length) return true;
            if (entry && typeof entry === 'object' && !['arguments', 'args', 'input', 'response', 'result'].includes(name)) pending.push(entry);
        }
    }
    return false;
}

function transferFault(exchange: HistoryExchange, code: string, reason: string): never {
    throw new AgentFault(code, reason, { itemId: exchange.itemId, attemptId: exchange.response.attemptId,
        nativeRefs: [...exchange.response.blocks.map(block => block.nativeRef), ...exchange.response.toolCalls.map(call => call.nativeRef)] });
}

function historyEndpointIdentity(endpoint: string, protocol: ProviderProtocol, modelId: string): string | null {
    if (protocol !== 'gemini') return endpoint;
    try {
        const url = new URL(endpoint);
        const operation = url.pathname.match(/^(.*\/models\/([^/]+)):(generateContent|streamGenerateContent)$/);
        if (!operation || operation[2] !== encodeURIComponent(modelId.replace(/^models\//, ''))
            || url.username || url.password || url.hash) return null;
        if (operation[3] === 'streamGenerateContent') {
            const formats = url.searchParams.getAll('alt');
            if (formats.length && (formats.length !== 1 || formats[0] !== 'sse')) return null;
            url.searchParams.delete('alt');
        }
        url.pathname = `${operation[1]}:generateContent`;
        return url.href;
    } catch { return null; }
}

function compatibleHistoryEndpoints(exchange: HistoryExchange, target: HistoryTransferTarget): boolean {
    if (exchange.sourceEndpoint === undefined && target.endpoint === undefined) return true;
    if (!exchange.sourceEndpoint || !target.endpoint) return false;
    if (exchange.sourceEndpoint === target.endpoint) return true;
    const source = historyEndpointIdentity(exchange.sourceEndpoint, exchange.sourceProtocol, exchange.sourceModelId ?? '');
    const destination = historyEndpointIdentity(target.endpoint, target.protocol, target.modelId);
    return source !== null && source === destination;
}

export function convertHistoryExchange(exchange: HistoryExchange, target: HistoryTransferTarget): HistoryTransfer {
    const { response, results } = exchange;
    if (!response.complete || response.problems.length || !Array.isArray(response.replayMessages)) {
        transferFault(exchange, 'E_HISTORY_INCOMPLETE', '该历史响应尚未完整确认，需要沿原尝试核实');
    }
    checkToolResults(response.toolCalls, results);
    if (response.toolCalls.length && !response.canExecuteTools) {
        transferFault(exchange, 'E_HISTORY_INCOMPLETE', '该历史工具响应尚未通过原执行的有效性检查');
    }
    const nativeRefs = [...response.blocks.map(block => block.nativeRef), ...response.toolCalls.map(call => call.nativeRef)];
    const sameProtocol = exchange.sourceProtocol === target.protocol;
    const signed = hasHistorySignature([response.replayMessages, response.blocks, response.toolCalls, results]);
    if (signed && (!sameProtocol || exchange.sourceModelId !== target.modelId
        || !compatibleHistoryEndpoints(exchange, target))) {
        transferFault(exchange, 'E_HISTORY_SIGNATURE_INCOMPATIBLE', '该历史含原生签名，当前目标协议或模型尚无已核实的签名复用证据');
    }
    const provenance = { itemId: exchange.itemId, attemptId: response.attemptId, sourceProtocol: exchange.sourceProtocol,
        targetProtocol: target.protocol, nativeRefs, callIds: response.toolCalls.map(call => call.callId),
        operation: sameProtocol ? 'native_replay' as const : 'target_protocol_view' as const };
    if (sameProtocol) return immutableJson({ response, results, provenance });
    const opaqueReasoning = response.replayMessages.some(message => message.type === 'reasoning'
        || message.reasoning_content !== undefined || message.reasoning !== undefined
        || Array.isArray(message.content) && message.content.some(part => part && typeof part === 'object' && !Array.isArray(part)
            && ['thinking', 'redacted_thinking'].includes(String(part.type))));
    if (response.blocks.some(block => block.type !== 'text' || block.thought || typeof block.text !== 'string')
        || opaqueReasoning || results.some(result => result.nativeParts?.length)) {
        transferFault(exchange, 'E_HISTORY_CONTENT_UNSUPPORTED', '当前跨协议转换支持可见文本和完整工具配对，媒体及其它原生块需要单独核实');
    }
    if (response.toolCalls.some(call => call.candidateIndex !== 0) || response.blocks.some(block => block.candidateIndex !== 0)) {
        transferFault(exchange, 'E_HISTORY_CONTENT_UNSUPPORTED', '多候选历史需要先确定原会话采用的候选');
    }
    const ordinal = (index: number, nativeRef: string): number => {
        const position = nativeRef.match(/^output\/([0-9]+)(?:\/content\/([0-9]+))?$/);
        return exchange.sourceProtocol === 'openai_responses' && position ? Number(position[1]) * 1_000_000 + Number(position[2] ?? 0) : index;
    };
    const atoms = [
        ...response.blocks.map(block => ({ index: ordinal(block.index, block.nativeRef), text: block.text!, call: null })),
        ...response.toolCalls.map(call => ({ index: ordinal(call.index, call.nativeRef), text: null, call })),
    ].sort((left, right) => left.index - right.index || Number(left.call !== null) - Number(right.call !== null));
    const orderedResults = response.toolCalls.map(call => results.find(result => result.callId === call.callId)!);
    let replayMessages: JsonObject[];
    const toolCalls = response.toolCalls.map(call => ({ ...call, providerCallId: call.callId }));
    if (target.protocol === 'gemini') {
        const parts: JsonObject[] = atoms.map((atom): JsonObject => atom.call
            ? { functionCall: { name: atom.call.name, id: atom.call.callId, args: atom.call.arguments } } : { text: atom.text! });
        replayMessages = [{ role: 'model', parts }];
    } else if (target.protocol === 'compatible_chat' || target.protocol === 'progrok') {
        const text = response.blocks.map(block => block.text!).join('');
        replayMessages = [{ role: 'assistant', content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls.map(call => ({
            id: call.callId, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) } : {}) }];
    } else if (target.protocol === 'anthropic') {
        const content: JsonObject[] = atoms.map((atom): JsonObject => atom.call ? { type: 'tool_use', id: atom.call.callId,
            name: atom.call.name, input: atom.call.arguments } : { type: 'text', text: atom.text! });
        replayMessages = [{ role: 'assistant', content }];
    } else {
        replayMessages = atoms.map((atom): JsonObject => atom.call ? { type: 'function_call', call_id: atom.call.callId, name: atom.call.name,
            arguments: JSON.stringify(atom.call.arguments) } : { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: atom.text! }] });
    }
    if (!atoms.length) transferFault(exchange, 'E_HISTORY_CONTENT_UNSUPPORTED', '该历史没有可转换的文本或工具调用');
    return immutableJson({ response: { ...response, toolCalls, replayMessages }, results: orderedResults, provenance });
}

export function preflightHistoryTransfer(exchanges: HistoryExchange[], target: HistoryTransferTarget): {
    allowed: boolean; target: HistoryTransferTarget; checkedItems: number; issues: HistoryTransferIssue[];
} {
    const issues: HistoryTransferIssue[] = [];
    for (const exchange of exchanges) {
        try { convertHistoryExchange(exchange, target); }
        catch (error) {
            if (!(error instanceof AgentFault)) throw error;
            issues.push({ itemId: exchange.itemId, code: error.code, reason: error.message,
                nativeRefs: [...exchange.response.blocks.map(block => block.nativeRef), ...exchange.response.toolCalls.map(call => call.nativeRef)] });
        }
    }
    return { allowed: issues.length === 0, target: { ...target }, checkedItems: exchanges.length, issues };
}

export function appendTransferredHistory(adapter: Pick<ProviderAdapter, 'protocol' | 'continueView'> & {
    continueHistoryView?: ProviderAdapter['continueView'];
}, view: NativeSendView, exchange: HistoryExchange, modelId: string, endpoint?: string): { view: NativeSendView; provenance: HistoryTransfer['provenance'] } {
    if (view.protocol !== adapter.protocol) throw new AgentFault('E_PROTOCOL_MISMATCH', '目标历史视图与目标适配器协议不同');
    const converted = convertHistoryExchange(exchange, { protocol: adapter.protocol, modelId, ...(endpoint ? { endpoint } : {}) });
    let next: NativeSendView;
    if (converted.response.toolCalls.length) {
        const append = adapter.continueHistoryView?.bind(adapter) ?? adapter.continueView.bind(adapter);
        next = append(view, converted.response, converted.results);
    } else if (view.protocol === 'gemini') next = { ...view, contents: [...(view.contents ?? []), ...converted.response.replayMessages] };
    else if (view.protocol === 'openai_responses') next = { ...view, input: [...(view.input ?? []), ...converted.response.replayMessages] };
    else next = { ...view, messages: [...(view.messages ?? []), ...converted.response.replayMessages] };
    return { view: immutableJson(next), provenance: converted.provenance };
}

export function validateHistoryTransferBoundary(view: NativeSendView, transfers: HistoryTransfer['provenance'][]): void {
    if (view.protocol !== 'gemini') return;
    const migrated = transfers.filter(item => item.sourceProtocol !== 'gemini' && item.targetProtocol === 'gemini' && item.callIds.length);
    if (!migrated.length) return;
    const callIds = new Set(migrated.flatMap(item => item.callIds));
    let latestImportedCall = -1;
    let latestUserText = -1;
    for (const [index, message] of (view.contents ?? []).entries()) {
        if (!Array.isArray(message.parts)) continue;
        for (const part of message.parts) {
            if (!part || typeof part !== 'object' || Array.isArray(part)) continue;
            if (message.role === 'user' && typeof part.text === 'string' && part.text.length) latestUserText = index;
            const call = part.functionCall;
            if (call && typeof call === 'object' && !Array.isArray(call) && typeof call.id === 'string' && callIds.has(call.id)) latestImportedCall = index;
        }
    }
    if (latestImportedCall >= latestUserText) throw new AgentFault('E_HISTORY_TARGET_TURN_REQUIRED',
        '迁移到Gemini的无签名工具历史需要在完整工具配对后接续一条真实用户文本，保留原工具结果',
        { itemIds: migrated.map(item => item.itemId), latestImportedCall, latestUserText });
}
