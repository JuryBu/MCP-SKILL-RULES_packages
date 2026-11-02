import { AgentFault } from '../protocol.js';
import type { ModelStepPairing, ModelStepPairingQuery } from './port.js';

export const MAX_MODEL_STEP_PAIRINGS = 100;

export function validateModelStepPairingQuery(query: ModelStepPairingQuery): void {
    if (!query || typeof query.conversationId !== 'string' || !query.conversationId
        || !Array.isArray(query.stepIds) || query.stepIds.length > MAX_MODEL_STEP_PAIRINGS
        || query.stepIds.some(stepId => typeof stepId !== 'string' || !stepId)) {
        throw new AgentFault('INVALID_PARAMS', '模型步骤配对读取须包含会话及至多100个步骤标识');
    }
}

export function modelStepPairing(value: Record<string, unknown> | undefined): ModelStepPairing {
    if (!value || value.kind !== 'model' || value.complete !== true) return 'incomplete';
    const calls = Array.isArray(value.toolCalls) ? value.toolCalls as { callId: string }[] : [];
    const resolved = Array.isArray(value.resolvedCallIds) ? value.resolvedCallIds : [];
    if (new Set(calls.map(call => call.callId)).size !== calls.length || new Set(resolved).size !== resolved.length) return 'conflict';
    return calls.some(call => !resolved.includes(call.callId)) ? 'pending' : 'complete';
}
