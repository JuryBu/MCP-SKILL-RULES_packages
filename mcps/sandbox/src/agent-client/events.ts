import { AgentFault, type AgentEvent } from '../agent-server/protocol.js';

export interface EventPage {
    events: AgentEvent[];
    nextCursor: string;
    hasMore: boolean;
    snapshot?: unknown;
}

export class AppliedEventCursor {
    private readonly sequences = new Map<string, bigint>();
    private readonly eventIds = new Set<string>();
    private readonly cursors = new Map<string, string>();
    private readonly maxRememberedIds = 2048;

    get(conversationId: string): string | undefined {
        return this.cursors.get(conversationId);
    }

    reset(conversationId: string, cursor?: string, eventSeq?: string): void {
        this.sequences.delete(conversationId);
        if (eventSeq !== undefined) this.sequences.set(conversationId, this.parseSequence(eventSeq));
        if (cursor === undefined) this.cursors.delete(conversationId);
        else this.cursors.set(conversationId, cursor);
        this.eventIds.clear();
    }

    async apply(conversationId: string, page: EventPage, handler: (event: AgentEvent) => void | Promise<void>): Promise<string> {
        for (const event of page.events) {
            if (event.conversationId !== conversationId) throw new AgentFault('PROTOCOL_MISMATCH', '事件页包含其他会话的事件');
            const sequence = this.parseSequence(event.eventSeq);
            const previous = this.sequences.get(conversationId);
            if (this.eventIds.has(event.eventId) || (previous !== undefined && sequence <= previous)) continue;
            if (previous !== undefined && sequence !== previous + 1n) throw new AgentFault('EVENT_GAP', '事件序号存在缺口，请从已应用游标补读', {
                conversationId, afterCursor: this.get(conversationId), expectedEventSeq: String(previous + 1n), actualEventSeq: event.eventSeq,
            });
            await handler(event);
            this.sequences.set(conversationId, sequence);
            this.eventIds.add(event.eventId);
            if (this.eventIds.size > this.maxRememberedIds) this.eventIds.delete(this.eventIds.values().next().value!);
        }
        this.cursors.set(conversationId, page.nextCursor);
        return page.nextCursor;
    }

    private parseSequence(value: string): bigint {
        if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new AgentFault('PROTOCOL_MISMATCH', '事件序号须为非负十进制字符串');
        return BigInt(value);
    }
}
