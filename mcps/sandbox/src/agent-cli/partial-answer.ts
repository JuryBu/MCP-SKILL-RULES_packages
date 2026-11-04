import { terminalSafeText } from './renderer.js';

export const MAX_PARTIAL_ANSWER_BYTES = 128 * 1024;
export const MAX_PARTIAL_SEGMENT_BYTES = 64 * 1024;
export const MAX_PARTIAL_SEGMENTS = 4;
export type PartialAnswerState = 'receiving' | 'previous' | 'stopping' | 'cancelled' | 'failed' | 'unknown' | 'paused' | 'awaiting_final';
interface PartialSegment {
    actionId: string;
    attemptId: string;
    ordinal: number;
    seq: number;
    text: string;
    bytes: number;
    receivedAt?: string;
    truncated: boolean;
    state: PartialAnswerState;
}

const stateLabels: Record<PartialAnswerState, string> = {
    receiving: '正在接收', previous: '已切换到下一次响应', stopping: '正在停止，保留已接片段', cancelled: '已取消，保留已接片段',
    failed: '执行失败，保留已接片段', unknown: '结果待核实，保留已接片段', paused: '已暂停，保留已接片段', awaiting_final: '等待正式回答',
};

export class PartialAnswerBuffer {
    readonly segments: PartialSegment[] = [];
    private readonly attempts = new Set<string>();
    private count = 0;
    private cachedLines?: string[];
    constructor(readonly conversationId: string, readonly runId: string) {}

    get current(): PartialSegment | undefined { return this.segments.at(-1); }
    get retainedBytes(): number { return this.segments.reduce((sum, segment) => sum + segment.bytes, 0); }
    get caption(): string { return this.current ? `临时回答 · 响应${this.current.ordinal} · ${stateLabels[this.current.state]}` : ''; }

    append(payload: Record<string, unknown>): boolean {
        const partial = payload.partial && typeof payload.partial === 'object' ? payload.partial as Record<string, unknown> : {};
        if (typeof payload.actionId !== 'string' || !payload.actionId || payload.actionId.length > 512
            || typeof payload.attemptId !== 'string' || !payload.attemptId || payload.attemptId.length > 512
            || !Number.isSafeInteger(partial.seq) || Number(partial.seq) < 0 || typeof partial.textDelta !== 'string') return false;
        const key = JSON.stringify([payload.actionId, payload.attemptId]);
        let segment = this.current;
        if (!segment || segment.actionId !== payload.actionId || segment.attemptId !== payload.attemptId) {
            if (this.attempts.has(key)) return false;
            if (segment) segment.state = 'previous';
            this.attempts.add(key);
            while (this.attempts.size > 256) this.attempts.delete(this.attempts.values().next().value!);
            segment = { actionId: payload.actionId, attemptId: payload.attemptId, ordinal: ++this.count,
                seq: -1, text: '', bytes: 0, truncated: false, state: 'receiving' };
            this.segments.push(segment);
        }
        if (Number(partial.seq) <= segment.seq) return false;
        segment.seq = Number(partial.seq);
        segment.receivedAt = typeof partial.receivedAt === 'string' ? partial.receivedAt : undefined;
        const combined = Buffer.from(segment.text + partial.textDelta, 'utf8');
        segment.truncated ||= combined.length > MAX_PARTIAL_SEGMENT_BYTES;
        segment.text = combined.subarray(Math.max(0, combined.length - MAX_PARTIAL_SEGMENT_BYTES)).toString('utf8').replace(/^\uFFFD/, '');
        segment.bytes = Buffer.byteLength(segment.text, 'utf8');
        while (this.segments.length > MAX_PARTIAL_SEGMENTS || this.retainedBytes > MAX_PARTIAL_ANSWER_BYTES) this.segments.shift();
        this.cachedLines = undefined;
        return true;
    }

    mark(state: PartialAnswerState): void {
        if (this.current && this.current.state !== state) { this.current.state = state; this.cachedLines = undefined; }
    }

    lines(): string[] {
        this.cachedLines ??= this.segments.flatMap(segment => [
            `临时回答 · 响应${segment.ordinal} · ${stateLabels[segment.state]}`,
            ...(segment.truncated ? ['[较早片段已超出前台保留范围，仅显示最近片段]'] : []),
            ...terminalSafeText(segment.text).split('\n'), '',
        ]);
        return this.cachedLines;
    }
}
