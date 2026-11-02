import { randomUUID } from 'node:crypto';
import { AgentFault, canonicalJson } from './protocol.js';
import type { AgentEvent } from './protocol.js';

export interface EventHead { conversationId: string; eventGeneration: string; eventSeq: string }

export function eventCursor(head: EventHead, seq = head.eventSeq): string {
    return `v1.${Buffer.from(JSON.stringify([head.conversationId, head.eventGeneration, seq])).toString('base64url')}`;
}

export function parseEventCursor(cursor: string | undefined, head: EventHead): string {
    if (!cursor) return '0';
    try {
        if (!cursor.startsWith('v1.')) throw new Error();
        const decoded: unknown = JSON.parse(Buffer.from(cursor.slice(3), 'base64url').toString('utf8'));
        if (!Array.isArray(decoded) || decoded.length !== 3 || decoded[0] !== head.conversationId
            || decoded[1] !== head.eventGeneration || typeof decoded[2] !== 'string' || !/^(0|[1-9][0-9]*)$/.test(decoded[2])
            || BigInt(decoded[2]) > BigInt(head.eventSeq)) throw new Error();
        return decoded[2];
    } catch {
        throw new AgentFault('CURSOR_EXPIRED', '事件游标不属于当前会话日志或已失效', { snapshotMethod: 'conversations.get' });
    }
}

export function makeEvent(head: EventHead, type: string, payload: Record<string, unknown>, now: number,
    run: { runId: string; runEpoch: number } | null = null): AgentEvent {
    const event: AgentEvent = { schemaVersion: 1, eventId: randomUUID(), eventSeq: (BigInt(head.eventSeq) + 1n).toString(),
        conversationId: head.conversationId, runId: run?.runId ?? null, runEpoch: run?.runEpoch ?? null,
        occurredAt: new Date(now).toISOString(), type, payload };
    if (Buffer.byteLength(canonicalJson(event)) > 64 * 1024) throw new AgentFault('FRAME_TOO_LARGE', '事件超过64KiB，请用内容对象引用');
    head.eventSeq = event.eventSeq;
    return event;
}

export class EventListeners {
    private readonly listeners = new Set<(event: AgentEvent) => void>();

    subscribe(listener: (event: AgentEvent) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    publish(events: AgentEvent[]): void {
        for (const event of events) for (const listener of this.listeners) {
            try { listener(structuredClone(event)); } catch { }
        }
    }

    close(): void { this.listeners.clear(); }
}
