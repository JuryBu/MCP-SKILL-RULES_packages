import { createHash } from 'node:crypto';
import { AgentFault } from '../protocol.js';
import { canonicalJsonByteChunks } from './payload-codec.js';

export type TemporaryMemoryKind = 'content' | 'scratch';
export interface TemporaryBudgetPort {
    reserve(conversationId: string, bytes: number, kind?: TemporaryMemoryKind): void;
    release(conversationId: string, bytes: number, kind?: TemporaryMemoryKind): void;
}

export interface TemporaryBudgetUsage { contentBytes: number; scratchBytes: number; totalBytes: number }
export interface TemporaryBudgetAccount extends TemporaryBudgetPort {
    usage(conversationId?: string): TemporaryBudgetUsage;
}

function validBytes(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new AgentFault('INVALID_PARAMS', '临时内存字节数须为非负安全整数');
}

function validId(value: string): void {
    if (typeof value !== 'string' || value.length < 1 || value.length > 256) throw new AgentFault('INVALID_PARAMS', '临时内存归属标识无效');
}

export class TemporaryMemoryBudget {
    readonly maxConversationBytes: number;
    readonly maxTotalBytes: number;
    private readonly held = new Map<string, { ownerId: string; conversationId: string; kind: TemporaryMemoryKind; bytes: number }>();
    private readonly conversations = new Map<string, TemporaryBudgetUsage>();
    private totals: TemporaryBudgetUsage = { contentBytes: 0, scratchBytes: 0, totalBytes: 0 };

    constructor(options: { maxConversationBytes?: number; maxTotalBytes?: number } = {}) {
        this.maxConversationBytes = options.maxConversationBytes ?? 64 * 1024 * 1024;
        this.maxTotalBytes = options.maxTotalBytes ?? 64 * 1024 * 1024;
        validBytes(this.maxConversationBytes); validBytes(this.maxTotalBytes);
        if (!this.maxConversationBytes || !this.maxTotalBytes) throw new AgentFault('INVALID_PARAMS', '临时内存上限须大于0');
    }

    scope(ownerId: string): TemporaryBudgetAccount {
        validId(ownerId);
        return { reserve: (conversationId, bytes, kind = 'content') => this.change(ownerId, conversationId, bytes, kind, true),
            release: (conversationId, bytes, kind = 'content') => this.change(ownerId, conversationId, bytes, kind, false),
            usage: conversationId => {
                if (conversationId !== undefined) validId(conversationId);
                const usage = { contentBytes: 0, scratchBytes: 0, totalBytes: 0 };
                for (const entry of this.held.values()) if (entry.ownerId === ownerId && (conversationId === undefined || entry.conversationId === conversationId)) {
                    usage[entry.kind === 'content' ? 'contentBytes' : 'scratchBytes'] += entry.bytes; usage.totalBytes += entry.bytes;
                }
                return usage;
            } };
    }

    usage(conversationId?: string): TemporaryBudgetUsage {
        if (conversationId !== undefined) validId(conversationId);
        return { ...(conversationId === undefined ? this.totals : this.conversations.get(conversationId)
            ?? { contentBytes: 0, scratchBytes: 0, totalBytes: 0 }) };
    }

    private change(ownerId: string, conversationId: string, bytes: number, kind: TemporaryMemoryKind, reserve: boolean): void {
        validId(conversationId); validBytes(bytes);
        if (kind !== 'content' && kind !== 'scratch') throw new AgentFault('INVALID_PARAMS', '未知临时内存类别');
        if (!bytes) return;
        const key = JSON.stringify([ownerId, conversationId, kind]);
        const previous = this.held.get(key)?.bytes ?? 0;
        const current = this.usage(conversationId);
        const field = kind === 'content' ? 'contentBytes' : 'scratchBytes';
        if (!reserve && bytes > previous) throw new AgentFault('TEMPORARY_BUDGET_ACCOUNTING', '只能释放本归属已经预留的临时内存',
            { ownerId, conversationId, kind, heldBytes: previous, releaseBytes: bytes });
        const delta = reserve ? bytes : -bytes;
        const next = previous + delta;
        const nextConversation = { ...current, [field]: current[field] + delta, totalBytes: current.totalBytes + delta };
        const nextTotal = { ...this.totals, [field]: this.totals[field] + delta, totalBytes: this.totals.totalBytes + delta };
        if (!Number.isSafeInteger(nextTotal.totalBytes) || nextConversation.contentBytes > this.maxConversationBytes
            || nextTotal.totalBytes > this.maxTotalBytes) throw new AgentFault('TEMPORARY_CONTENT_LIMIT', '正文、媒体或编码缓冲达到共同临时内存上限',
            { scope: nextConversation.contentBytes > this.maxConversationBytes ? 'conversation' : 'server', conversationId,
                requestedBytes: bytes, kind, conversationContentBytes: current.contentBytes, totalBytes: this.totals.totalBytes,
                maxConversationBytes: this.maxConversationBytes, maxTotalBytes: this.maxTotalBytes });
        if (next) this.held.set(key, { ownerId, conversationId, kind, bytes: next }); else this.held.delete(key);
        if (nextConversation.totalBytes) this.conversations.set(conversationId, nextConversation); else this.conversations.delete(conversationId);
        this.totals = nextTotal;
    }
}

export function measureCanonicalJsonBytes(value: unknown, options: { maxBytes?: number; maxNodes?: number; maxDepth?: number } = {}): number {
    const maxBytes = options.maxBytes ?? Number.MAX_SAFE_INTEGER;
    const maxNodes = options.maxNodes ?? 200_000;
    const maxDepth = options.maxDepth ?? 96;
    validBytes(maxBytes); validBytes(maxNodes); validBytes(maxDepth);
    const ancestors = new Set<object>();
    let bytes = 0;
    let nodes = 0;
    const add = (amount: number): void => {
        bytes += amount;
        if (!Number.isSafeInteger(bytes) || bytes > maxBytes) throw new AgentFault('TEMPORARY_CONTENT_LIMIT', 'JSON在实际分配前超过编码字节预算', { maxBytes });
    };
    const string = (text: string): void => {
        add(Buffer.byteLength(text) + 2);
        for (let index = 0; index < text.length; index += 1) {
            const code = text.charCodeAt(index);
            if (code === 34 || code === 92) add(1);
            else if (code < 32) add([8, 9, 10, 12, 13].includes(code) ? 1 : 5);
            else if (code >= 0xd800 && code <= 0xdbff) {
                const next = text.charCodeAt(index + 1);
                if (next >= 0xdc00 && next <= 0xdfff) index += 1; else add(3);
            } else if (code >= 0xdc00 && code <= 0xdfff) add(3);
        }
    };
    const visit = (entry: unknown, depth: number): void => {
        nodes += 1;
        if (nodes > maxNodes || depth > maxDepth) throw new AgentFault('TEMPORARY_CONTENT_LIMIT', 'JSON在实际分配前超过结构预算');
        if (entry === null) { add(4); return; }
        if (typeof entry === 'boolean') { add(entry ? 4 : 5); return; }
        if (typeof entry === 'number') {
            if (!Number.isFinite(entry)) throw new AgentFault('INVALID_PARAMS', '数值必须有限');
            add(JSON.stringify(entry).length); return;
        }
        if (typeof entry === 'string') { string(entry); return; }
        if (typeof entry !== 'object') throw new AgentFault('INVALID_PARAMS', '正文须为JSON兼容值');
        if (ancestors.has(entry)) throw new AgentFault('INVALID_PARAMS', '正文JSON不能包含循环引用');
        ancestors.add(entry);
        if (Array.isArray(entry)) {
            add(2);
            for (let index = 0; index < entry.length; index += 1) { if (index) add(1); visit(entry[index], depth + 1); }
        } else {
            add(2);
            let first = true;
            for (const key of Object.keys(entry)) {
                const child = (entry as Record<string, unknown>)[key];
                if (child === undefined) continue;
                if (!first) add(1); first = false;
                string(key); add(1); visit(child, depth + 1);
            }
        }
        ancestors.delete(entry);
    };
    visit(value, 0);
    return bytes;
}

export interface TemporaryJsonBuffer { bytes: Buffer; sha256: string; release(): void }

export function encodeTemporaryJson(budget: TemporaryBudgetPort, conversationId: string, value: unknown,
    options: { maxBytes?: number; maxNodes?: number; maxDepth?: number } = {}): TemporaryJsonBuffer {
    const bytes = measureCanonicalJsonBytes(value, options);
    const scratchBytes = Math.min(512 * 1024, bytes * 3 + 256);
    budget.reserve(conversationId, bytes);
    let scratchHeld = false;
    let contentHeld = true;
    let buffer: Buffer | undefined;
    try {
        budget.reserve(conversationId, scratchBytes, 'scratch'); scratchHeld = true;
        buffer = Buffer.allocUnsafe(bytes);
        let offset = 0;
        const checksum = createHash('sha256');
        for (const chunk of canonicalJsonByteChunks(value, { ...options, maxBytes: bytes })) {
            if (offset + chunk.length > bytes) throw new AgentFault('TEMPORARY_BUDGET_ACCOUNTING', 'JSON编码超过分配前测得的长度');
            buffer.set(chunk, offset); offset += chunk.length; checksum.update(chunk);
        }
        if (offset !== bytes) throw new AgentFault('TEMPORARY_BUDGET_ACCOUNTING', 'JSON在测量与编码之间发生变化');
        budget.release(conversationId, scratchBytes, 'scratch'); scratchHeld = false;
        const result = { bytes: buffer, sha256: checksum.digest('hex'), release: (): void => {
            if (!contentHeld) return;
            budget.release(conversationId, bytes); contentHeld = false; buffer!.fill(0);
        } };
        return result;
    } catch (error) {
        buffer?.fill(0);
        if (scratchHeld) budget.release(conversationId, scratchBytes, 'scratch');
        if (contentHeld) { budget.release(conversationId, bytes); contentHeld = false; }
        throw error;
    }
}
