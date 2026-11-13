import type { JsonObject, JsonValue } from '../protocol.js';
import { canonicalJson } from '../protocol.js';
import type { ToolResult } from '../providers/types.js';
import type { StoreKey, StorePort } from '../storage/port.js';
import { hashBytes, hashContext } from './config.js';
import { ContextFault } from './errors.js';

export interface ToolDeliveryIdentity {
    conversationId: string;
    runId: string;
    runEpoch: number;
    stepId: string;
    callId: string;
}

export interface ToolDeliverySource {
    artifactId: string;
    sha256: string;
    byteLength: number;
    receivedComplete: true;
    upstreamCompleteness: 'complete' | 'partial' | 'unknown';
}

export interface ToolDeliveryPolicy {
    kind?: 'auto' | 'log' | 'page' | 'receipt';
    maxTextChars?: number;
    upstreamCompleteness?: ToolDeliverySource['upstreamCompleteness'];
    existingSource?: Pick<ToolDeliverySource, 'artifactId' | 'sha256' | 'byteLength'>;
}

export interface ToolDelivery extends Record<string, unknown> {
    schemaVersion: 1;
    identity: ToolDeliveryIdentity;
    source: ToolDeliverySource;
    receivedHash: string;
    sentHash: string;
    shortened: boolean;
    sent: ToolResult;
}

interface StoredToolDelivery extends Record<string, unknown> {
    schemaVersion: 2;
    identity: ToolDeliveryIdentity;
    source: ToolDeliverySource;
    receivedHash: string;
    sentHash: string;
    shortened: boolean;
    sentArtifact: { artifactId: string; sha256: string; byteLength: number };
}

function deliveryKey(identity: ToolDeliveryIdentity): StoreKey {
    if (!identity.conversationId || !identity.runId || !identity.stepId || !identity.callId
        || !Number.isSafeInteger(identity.runEpoch) || identity.runEpoch < 1) {
        throw new ContextFault('CONFIG_INVALID', '工具发送版本需要完整对话、run、步骤和调用身份');
    }
    return { conversationId: identity.conversationId, kind: 'step', id: `context:tool-delivery:${hashContext(identity)}` };
}

function pagedResult(result: ToolResult): boolean {
    if (/history[._-]?(read|search)|read[._-]?original|read[._-]?file|file[._-]?read|artifacts?[._-]?read|code[._-]?page/i.test(result.name)) return true;
    const page = (value: JsonValue, depth = 0): boolean => {
        if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 8) return false;
        if (['items', 'nextCursor', 'continuationCursor', 'nextOffset', 'rangeRef', 'page', 'hasMore', 'nextRead'].some(key => key in value)) return true;
        return value.data !== undefined && page(value.data, depth + 1) || value.result !== undefined && page(value.result, depth + 1);
    };
    return page(result.result);
}

export function projectToolDelivery(received: ToolResult, source: ToolDeliverySource, policy: ToolDeliveryPolicy = {}): {
    sent: ToolResult; shortened: boolean;
} {
    const maxTextChars = policy.maxTextChars ?? 12_000;
    if (!Number.isSafeInteger(maxTextChars) || maxTextChars < 256) throw new ContextFault('CONFIG_INVALID', '工具短版文本预算须为至少256个字符');
    if (policy.kind === 'page' || policy.kind === 'receipt' || policy.kind !== 'log' && pagedResult(received)) {
        return { sent: structuredClone(received), shortened: false };
    }
    let remaining = maxTextChars;
    let shortened = false;
    const shorten = (text: string): string => {
        if (text.length <= remaining) { remaining -= text.length; return text; }
        const retained = Math.max(0, remaining);
        remaining = 0;
        const head = Math.ceil(retained * 0.6);
        const tail = retained - head;
        const prefix = text.slice(0, head).replace(/[\uD800-\uDBFF]$/, '');
        const suffix = tail ? text.slice(-tail).replace(/^[\uDC00-\uDFFF]/, '') : '';
        shortened = true;
        return `${prefix}\n[工具发送短版：省略${text.length - prefix.length - suffix.length}个字符；本次收到的原件已完整保存；上游完整性=${source.upstreamCompleteness}；原件 artifact=${source.artifactId}；sha256=${source.sha256}；bytes=${source.byteLength}；查回 history_read({artifactId:"${source.artifactId}",offset:0,maxBytes:65536})，按nextOffset继续]\n${suffix}`;
    };
    const project = (value: JsonValue, depth = 0): JsonValue => {
        if (typeof value === 'string') return shorten(value);
        if (Array.isArray(value)) return value.map(block => block && typeof block === 'object' && !Array.isArray(block)
            && block.type === 'text' && typeof block.text === 'string' ? { ...structuredClone(block), text: shorten(block.text) } : structuredClone(block));
        if (!value || typeof value !== 'object' || depth > 8) return structuredClone(value);
        const object: JsonObject = structuredClone(value);
        for (const key of ['stdout', 'stderr', 'output', 'text', 'log']) {
            if (typeof object[key] === 'string') object[key] = shorten(object[key] as string);
        }
        const rawFields = ['stdoutBase64', 'stderrBase64'].filter(key => typeof object[key] === 'string' && (object[key] as string).length > maxTextChars);
        if (rawFields.length) {
            for (const key of rawFields) delete object[key];
            object.rawBytesSource = { artifactId: source.artifactId, sha256: source.sha256, byteLength: source.byteLength, fields: rawFields };
            shortened = true;
        }
        for (const key of ['data', 'result']) if (object[key] !== undefined) object[key] = project(object[key], depth + 1);
        if (Array.isArray(object.content)) object.content = object.content.map(block => {
            if (!block || typeof block !== 'object' || Array.isArray(block) || block.type !== 'text' || typeof block.text !== 'string') return block;
            return { ...block, text: shorten(block.text) };
        });
        return object;
    };
    const result = project(received.result);
    return { sent: { ...structuredClone(received), result }, shortened };
}

export function createToolDeliveryStore(store: Pick<StorePort, 'getRecord' | 'commitTransition' | 'readArtifact'>) {
    const pending = new Map<string, { receivedHash: string; completion: Promise<ToolDelivery> }>();
    const readSent = async (identity: ToolDeliveryIdentity, reference: StoredToolDelivery['sentArtifact']): Promise<ToolResult> => {
        if (!reference?.artifactId || !/^[a-f0-9]{64}$/.test(reference.sha256)
            || !Number.isSafeInteger(reference.byteLength) || reference.byteLength < 1) throw new ContextFault('SOURCE_GAP', '工具发送正文引用无效');
        const parts: Buffer[] = [];
        let offset = 0;
        for (;;) {
            const page = await store.readArtifact({ conversationId: identity.conversationId, artifactId: reference.artifactId, offset, maxBytes: 64 * 1024 });
            const bytes = Buffer.from(page.dataBase64, 'base64');
            if (page.artifactId !== reference.artifactId || page.sha256 !== reference.sha256 || page.totalBytes !== reference.byteLength
                || page.offset !== offset || !bytes.length || offset + bytes.length > reference.byteLength) {
                throw new ContextFault('SOURCE_GAP', '工具发送正文分片与冻结引用不同');
            }
            parts.push(bytes);
            offset += bytes.length;
            if (page.complete) {
                if (offset !== reference.byteLength || page.nextOffset !== null) throw new ContextFault('SOURCE_GAP', '工具发送正文终段长度无效');
                break;
            }
            if (page.nextOffset !== offset) throw new ContextFault('SOURCE_GAP', '工具发送正文分页没有连续推进');
        }
        const bytes = Buffer.concat(parts, reference.byteLength);
        if (hashBytes(bytes) !== reference.sha256) throw new ContextFault('SOURCE_GAP', '工具发送正文哈希与冻结版本不同');
        try { return JSON.parse(bytes.toString('utf8')) as ToolResult; }
        catch { throw new ContextFault('SOURCE_GAP', '工具发送正文缺少完整JSON'); }
    };
    const read = async (identity: ToolDeliveryIdentity, received?: ToolResult): Promise<ToolDelivery | null> => {
        const record = await store.getRecord<ToolDelivery | StoredToolDelivery>(deliveryKey(identity));
        if (!record) return null;
        const stored = record.value;
        if (stored.schemaVersion !== 1 && stored.schemaVersion !== 2) throw new ContextFault('SOURCE_GAP', '工具发送状态版本无效');
        if (hashContext(stored.identity) !== hashContext(identity)) throw new ContextFault('SOURCE_GAP', '工具发送状态与原调用身份不同');
        if (stored.schemaVersion === 2 && stored.sentArtifact?.sha256 !== stored.sentHash) throw new ContextFault('SOURCE_GAP', '工具发送正文引用与发送哈希不同');
        const delivery: ToolDelivery = stored.schemaVersion === 2
            ? { schemaVersion: 1, identity: stored.identity, source: stored.source, receivedHash: stored.receivedHash,
                sentHash: stored.sentHash, shortened: stored.shortened, sent: await readSent(identity, stored.sentArtifact) }
            : stored;
        if (delivery.schemaVersion !== 1 || hashContext(delivery.identity) !== hashContext(identity)
            || delivery.sent.callId !== identity.callId || delivery.sentHash !== hashContext(delivery.sent)
            || !delivery.source || delivery.source.receivedComplete !== true || delivery.source.sha256 !== delivery.receivedHash
            || !/^[a-f0-9]{64}$/.test(delivery.receivedHash) || !delivery.source.artifactId
            || !Number.isSafeInteger(delivery.source.byteLength) || delivery.source.byteLength < 1
            || received && delivery.receivedHash !== hashContext(received)) {
            throw new ContextFault('SOURCE_GAP', '工具发送版本与原调用或收到的原件不同');
        }
        return structuredClone(delivery);
    };
    const preserveOnce = async (identity: ToolDeliveryIdentity, received: ToolResult, policy: ToolDeliveryPolicy,
        transform?: (received: ToolResult) => Promise<ToolResult>): Promise<ToolDelivery> => {
        const existing = await read(identity, received);
        if (existing) return existing;
        if (received.callId !== identity.callId) throw new ContextFault('SOURCE_GAP', '工具结果callId与保存身份不同');
        const serialized = canonicalJson(received);
        const receivedHash = hashBytes(serialized);
        const byteLength = Buffer.byteLength(serialized);
        const artifactId = policy.existingSource?.artifactId ?? `context:tool-original:${hashContext(identity)}:${receivedHash}`;
        if (policy.existingSource) {
            if (policy.existingSource.sha256 !== receivedHash || policy.existingSource.byteLength !== byteLength) {
                throw new ContextFault('SOURCE_GAP', '已有工具原件引用与实际收到内容不同');
            }
            const source = await store.readArtifact({ conversationId: identity.conversationId, artifactId, offset: 0, maxBytes: 1 });
            if (source.sha256 !== receivedHash || source.totalBytes !== byteLength || source.artifactId !== artifactId) {
                throw new ContextFault('SOURCE_GAP', '已有工具原件尚未持久保存或哈希不同');
            }
        } else {
            let saveError: unknown;
            try {
                await store.commitTransition({ expected: [], records: [], contents: [{ conversationId: identity.conversationId,
                    contentId: artifactId, kind: 'context_tool_original', value: structuredClone(received) as unknown as JsonValue, indexHistory: false }] });
            } catch (error) { saveError = error; }
            try {
                const saved = await store.readArtifact({ conversationId: identity.conversationId, artifactId, offset: 0, maxBytes: 1 });
                if (saved.sha256 !== receivedHash || saved.totalBytes !== byteLength || saved.artifactId !== artifactId) {
                    throw new ContextFault('SOURCE_GAP', '工具原件在转换前尚未取得完整保存回执');
                }
            } catch (error) { throw saveError ?? error; }
        }
        const partial = (value: JsonValue, depth = 0): boolean => {
            if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 8) return false;
            return value.partial === true || value.truncated === true
                || value.data !== undefined && partial(value.data, depth + 1) || value.result !== undefined && partial(value.result, depth + 1);
        };
        const upstreamCompleteness = policy.upstreamCompleteness ?? (partial(received.result) ? 'partial' : 'unknown');
        const source: ToolDeliverySource = { artifactId, sha256: receivedHash, byteLength, receivedComplete: true, upstreamCompleteness };
        const transformed = transform ? await transform(structuredClone(received)) : received;
        if (transformed.callId !== received.callId || transformed.name !== received.name) throw new ContextFault('SOURCE_GAP', '工具图片转换改变了原调用身份');
        const projected = projectToolDelivery(transformed, source, policy);
        const delivery: ToolDelivery = { schemaVersion: 1, identity: structuredClone(identity), source, receivedHash,
            sentHash: hashContext(projected.sent), shortened: projected.shortened, sent: projected.sent };
        const sentArtifact = { artifactId: delivery.sentHash === receivedHash ? artifactId : `context:tool-sent:${hashContext(identity)}:${delivery.sentHash}`,
            sha256: delivery.sentHash, byteLength: Buffer.byteLength(canonicalJson(delivery.sent)) };
        const stored: StoredToolDelivery = { schemaVersion: 2, identity: delivery.identity, source, receivedHash,
            sentHash: delivery.sentHash, shortened: delivery.shortened, sentArtifact };
        const key = deliveryKey(identity);
        try {
            await store.commitTransition({ expected: [{ key, revision: null }], records: [{ key, revision: 1, value: stored }],
                ...(delivery.sentHash === receivedHash ? {} : { contents: [{ conversationId: identity.conversationId,
                    contentId: sentArtifact.artifactId, kind: 'context_tool_sent', value: structuredClone(delivery.sent) as unknown as JsonValue, indexHistory: false }] }) });
        } catch (error) {
            const committed = await read(identity, received);
            if (committed) return committed;
            throw error;
        }
        return delivery;
    };
    const preserve = (identity: ToolDeliveryIdentity, received: ToolResult, policy: ToolDeliveryPolicy = {},
        transform?: (received: ToolResult) => Promise<ToolResult>): Promise<ToolDelivery> => {
        const key = hashContext(deliveryKey(identity));
        const receivedHash = hashContext(received);
        const running = pending.get(key);
        if (running) {
            if (running.receivedHash !== receivedHash) return Promise.reject(new ContextFault('SOURCE_GAP', '并发工具发送版本的raw原件不同'));
            return running.completion.then(delivery => structuredClone(delivery));
        }
        const completion = preserveOnce(identity, received, policy, transform).finally(() => {
            if (pending.get(key)?.completion === completion) pending.delete(key);
        });
        pending.set(key, { receivedHash, completion });
        return completion;
    };
    return { read, preserve };
}
