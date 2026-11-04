import type { JsonObject, JsonValue } from '../protocol.js';
import { arrayObjects, objectValue, stringValue } from './assemble.js';
import type { ProviderProtocol } from './types.js';

function streamIndex(value: unknown): number {
    if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > 4096) throw new Error('Invalid stream index');
    return Number(value);
}

function appendFields(target: JsonObject, delta: JsonObject, append: string[]): void {
    for (const [name, value] of Object.entries(delta)) {
        if (append.includes(name) && typeof value === 'string') target[name] = String(target[name] ?? '') + value;
        else if (value !== null || target[name] === undefined) target[name] = value;
    }
}

export class ProviderStreamAssembly {
    data: JsonObject = {};
    eventCount = 0;
    terminal = false;
    failed = false;
    private unsupportedDelta = false;
    private readonly argumentDeltas = new Map<number, string>();

    constructor(readonly protocol: ProviderProtocol) {}

    get responseId(): string | null { return stringValue(this.data.id ?? this.data.responseId); }

    get complete(): boolean {
        if (this.failed || this.unsupportedDelta) return false;
        if (this.protocol !== 'gemini') return this.terminal;
        const candidates = arrayObjects(this.data.candidates);
        return Boolean(objectValue(this.data.promptFeedback)?.blockReason)
            || candidates.length > 0 && candidates.every(candidate => typeof candidate.finishReason === 'string');
    }

    accept(eventType: string, event: JsonObject | null): string {
        this.eventCount++;
        if (!event) {
            if (eventType !== '[DONE]' || !['compatible_chat', 'progrok'].includes(this.protocol)) throw new Error('Unexpected stream terminator');
            this.terminal = true;
            return '';
        }
        const data = structuredClone(event);
        if (data.error || eventType === 'error') {
            this.failed = true;
            this.data.error = data.error ?? data;
            for (const field of ['usage', 'usageMetadata']) if (data[field] !== undefined) this.data[field] = data[field];
            return '';
        }
        if (this.protocol === 'anthropic') return this.anthropic(eventType, data);
        if (this.protocol === 'openai_responses') return this.responses(eventType, data);
        if (this.protocol === 'gemini') return this.gemini(data);
        return this.chat(data);
    }

    private chat(data: JsonObject): string {
        for (const [name, value] of Object.entries(data)) if (name !== 'choices') this.data[name] = value;
        const choices = (this.data.choices ??= []) as JsonValue[];
        let text = '';
        for (const choice of arrayObjects(data.choices)) {
            const index = streamIndex(choice.index);
            const accumulated: JsonObject = objectValue(choices[index]) ?? { index, message: { role: 'assistant', content: null }, finish_reason: null };
            choices[index] = accumulated;
            const message = objectValue(accumulated.message)!;
            const delta = objectValue(choice.delta);
            if (objectValue(choice.message)) accumulated.message = choice.message!;
            if (delta) {
                for (const [name, value] of Object.entries(delta)) {
                    if (name === 'tool_calls') {
                        const tools = (message.tool_calls ??= []) as JsonValue[];
                        for (const item of arrayObjects(value)) {
                            const toolIndex = streamIndex(item.index);
                            const tool = objectValue(tools[toolIndex]) ?? {};
                            tools[toolIndex] = tool;
                            for (const [field, fieldValue] of Object.entries(item)) if (!['index', 'function'].includes(field)) tool[field] = fieldValue;
                            if (objectValue(item.function)) {
                                const fn = objectValue(tool.function) ?? {};
                                tool.function = fn;
                                appendFields(fn, item.function as JsonObject, ['arguments']);
                            }
                        }
                    } else if (['content', 'refusal', 'reasoning_content', 'reasoning'].includes(name) && typeof value === 'string') {
                        message[name] = String(message[name] ?? '') + value;
                        if (name === 'content') text += value;
                    } else if (name === 'content' && Array.isArray(value)) {
                        message.content = [...(Array.isArray(message.content) ? message.content : []), ...value];
                    } else if (name === 'audio' && objectValue(value)) {
                        const audio = objectValue(message.audio) ?? {};
                        appendFields(audio, value as JsonObject, ['data', 'transcript']);
                        message.audio = audio;
                    } else if (Array.isArray(value)) message[name] = [...(Array.isArray(message[name]) ? message[name] as JsonValue[] : []), ...value];
                    else if (value !== null || message[name] === undefined) message[name] = value;
                }
            }
            for (const [name, value] of Object.entries(choice)) if (!['delta', 'message', 'index'].includes(name) && value !== null) accumulated[name] = value;
        }
        return text;
    }

    private anthropic(eventType: string, data: JsonObject): string {
        const type = stringValue(data.type) ?? eventType;
        if (type === 'message_start') this.data = objectValue(data.message) ?? {};
        else if (type === 'content_block_start') {
            const content = (this.data.content ??= []) as JsonValue[];
            content[streamIndex(data.index)] = data.content_block ?? {};
        } else if (type === 'content_block_delta') {
            const index = streamIndex(data.index);
            const content = this.data.content as JsonValue[];
            const block = objectValue(content?.[index]);
            const delta = objectValue(data.delta);
            if (!block || !delta) throw new Error('Content delta without block');
            if (delta.type === 'text_delta' && typeof delta.text === 'string') { block.text = String(block.text ?? '') + delta.text; return delta.text; }
            if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') block.thinking = String(block.thinking ?? '') + delta.thinking;
            else if (delta.type === 'signature_delta' && typeof delta.signature === 'string') block.signature = String(block.signature ?? '') + delta.signature;
            else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
                this.argumentDeltas.set(index, (this.argumentDeltas.get(index) ?? '') + delta.partial_json);
            } else if (delta.type === 'citations_delta' && objectValue(delta.citation)) {
                block.citations = [...(Array.isArray(block.citations) ? block.citations : []), delta.citation!];
            } else if (delta.type !== 'thinking_delta') {
                block.unhandled_deltas = [...(Array.isArray(block.unhandled_deltas) ? block.unhandled_deltas : []), delta];
                this.unsupportedDelta = true;
            }
        } else if (type === 'content_block_stop') {
            const index = streamIndex(data.index);
            if (this.argumentDeltas.has(index)) {
                const block = objectValue((this.data.content as JsonValue[])?.[index]);
                if (!block) throw new Error('Tool stop without block');
                block.input = JSON.parse(this.argumentDeltas.get(index)!);
            }
        } else if (type === 'message_delta') {
            Object.assign(this.data, objectValue(data.delta) ?? {});
            if (objectValue(data.usage)) this.data.usage = { ...(objectValue(this.data.usage) ?? {}), ...data.usage as JsonObject };
        } else if (type === 'message_stop') this.terminal = true;
        return '';
    }

    private responses(eventType: string, data: JsonObject): string {
        const type = stringValue(data.type) ?? eventType;
        if (objectValue(data.response)) {
            this.data = data.response as JsonObject;
            if (['response.completed', 'response.failed', 'response.incomplete'].includes(type)) this.terminal = true;
            return '';
        }
        const output = (this.data.output ??= []) as JsonValue[];
        if (['response.output_item.added', 'response.output_item.done'].includes(type)) {
            output[streamIndex(data.output_index)] = data.item ?? {};
            return '';
        }
        if (data.output_index === undefined) return '';
        const index = streamIndex(data.output_index);
        const item = objectValue(output[index]);
        if (!item) throw new Error('Response delta without item');
        if (['response.content_part.added', 'response.content_part.done'].includes(type)) {
            const content = (item.content ??= []) as JsonValue[];
            content[streamIndex(data.content_index)] = data.part ?? {};
        } else if (['response.output_text.delta', 'response.refusal.delta'].includes(type) && typeof data.delta === 'string') {
            const content = (item.content ??= []) as JsonValue[];
            const partIndex = streamIndex(data.content_index);
            const refusal = type === 'response.refusal.delta';
            const part = objectValue(content[partIndex]) ?? { type: refusal ? 'refusal' : 'output_text' };
            content[partIndex] = part;
            const field = refusal ? 'refusal' : 'text';
            part[field] = String(part[field] ?? '') + data.delta;
            return data.delta;
        } else if (type === 'response.function_call_arguments.delta' && typeof data.delta === 'string') {
            item.arguments = String(item.arguments ?? '') + data.delta;
        }
        return '';
    }

    private gemini(data: JsonObject): string {
        for (const [name, value] of Object.entries(data)) if (name !== 'candidates') this.data[name] = value;
        const candidates = (this.data.candidates ??= []) as JsonValue[];
        let text = '';
        for (const [position, candidate] of arrayObjects(data.candidates).entries()) {
            const index = streamIndex(candidate.index ?? position);
            const accumulated: JsonObject = objectValue(candidates[index]) ?? { index };
            candidates[index] = accumulated;
            const incoming = objectValue(candidate.content);
            if (incoming) {
                const content = objectValue(accumulated.content) ?? { role: 'model', parts: [] };
                for (const [name, value] of Object.entries(incoming)) if (name !== 'parts') content[name] = value;
                if (incoming.parts !== undefined && !Array.isArray(incoming.parts)) throw new Error('Invalid Gemini stream parts');
                content.parts = [...(Array.isArray(content.parts) ? content.parts : []), ...(incoming.parts as JsonValue[] ?? [])];
                accumulated.content = content;
                text += arrayObjects(incoming.parts).filter(part => part.thought !== true).map(part => stringValue(part.text) ?? '').join('');
            }
            for (const [name, value] of Object.entries(candidate)) if (name !== 'content') accumulated[name] = value;
        }
        return text;
    }
}
