import { AgentFault } from '../../protocol.js';
import type { BoundToolContext } from '../types.js';

export class LocalSequentialThinking {
    private readonly records = new Map<string, { thoughtNumber: number; totalThoughts: number; thought: string }[]>();

    execute(args: Record<string, unknown>, context: BoundToolContext): Record<string, unknown> {
        if (typeof args.thought !== 'string' || args.thought.length > 8000 || !Number.isInteger(args.thoughtNumber)
            || !Number.isInteger(args.totalThoughts) || Number(args.thoughtNumber) < 1 || Number(args.totalThoughts) < Number(args.thoughtNumber)
            || Number(args.totalThoughts) > 128 || typeof args.nextThoughtNeeded !== 'boolean') throw new AgentFault('INVALID_PARAMS', '本地步骤参数无效');
        const key = JSON.stringify([context.conversationId, context.runId]);
        const records = this.records.get(key) ?? [];
        if (records.length >= 128) throw new AgentFault('TOOL_LIMIT_REACHED', '本地执行步骤数达到128上限');
        records.push({ thoughtNumber: Number(args.thoughtNumber), totalThoughts: Number(args.totalThoughts), thought: args.thought });
        this.records.set(key, records);
        return { locality: 'local', thoughtNumber: args.thoughtNumber, totalThoughts: args.totalThoughts,
            nextThoughtNeeded: args.nextThoughtNeeded, storedSteps: records.length, externalModelCalls: 0 };
    }

    release(conversationId: string, runId: string): void { this.records.delete(JSON.stringify([conversationId, runId])); }
    clear(): void { this.records.clear(); }
}
