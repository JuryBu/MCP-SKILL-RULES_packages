import { createHash } from 'node:crypto';
import { canonicalJson } from './protocol.js';

export interface ToolActionScope {
    runId: string;
    stepId: string;
    attemptId: string;
    callId: string;
}

export function scopedToolActionId(scope: ToolActionScope): string {
    return `tool:${createHash('sha256').update(canonicalJson([scope.runId, scope.stepId, scope.attemptId, scope.callId])).digest('hex')}`;
}

export function matchesToolActionId(actionId: string, scope: ToolActionScope): boolean {
    return actionId === scope.callId || actionId === scopedToolActionId(scope);
}
