import { createHash } from 'node:crypto';
import { AgentFault } from '../agent-server/protocol.js';
import type { JsonValue } from '../agent-server/protocol.js';
import type { NativeSendView } from '../agent-server/providers/types.js';

export function appendCouncilUser(view: NativeSendView, content: JsonValue): NativeSendView {
    const input = content as { text?: string; references?: Record<string, unknown>[] };
    const text = input.text ?? '';
    const images = (input.references ?? []).map(reference => {
        if (reference.kind !== 'council_image' || typeof reference.mime !== 'string' || typeof reference.dataBase64 !== 'string') {
            throw new AgentFault('E_COUNCIL_REFERENCE', 'Council只能发送已准备的原图引用');
        }
        const bytes = Buffer.from(reference.dataBase64, 'base64');
        if (bytes.toString('base64') !== reference.dataBase64 || bytes.length !== reference.byteLength
            || createHash('sha256').update(bytes).digest('hex') !== reference.sha256) throw new AgentFault('E_COUNCIL_REFERENCE', '原图引用完整性检查失败');
        return { mime: reference.mime, data: reference.dataBase64 };
    });
    if (view.protocol === 'gemini') return { ...view, contents: [...(view.contents ?? []), { role: 'user', parts: [{ text },
        ...images.map(image => ({ inlineData: { mimeType: image.mime, data: image.data } }))] }] };
    if (view.protocol === 'anthropic') return { ...view, messages: [...(view.messages ?? []), { role: 'user', content: [{ type: 'text', text },
        ...images.map(image => ({ type: 'image', source: { type: 'base64', media_type: image.mime, data: image.data } }))] }] };
    if (view.protocol === 'openai_responses') return { ...view, input: [...(view.input ?? []), { role: 'user', content: [{ type: 'input_text', text },
        ...images.map(image => ({ type: 'input_image', image_url: `data:${image.mime};base64,${image.data}` }))] }] };
    return { ...view, messages: [...(view.messages ?? []), { role: 'user', content: images.length ? [{ type: 'text', text },
        ...images.map(image => ({ type: 'image_url', image_url: { url: `data:${image.mime};base64,${image.data}` } }))] : text }] };
}
