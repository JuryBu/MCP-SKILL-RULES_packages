import { AgentFault, canonicalJson } from '../protocol.js';

export interface EvidenceScope {
    endpoint: string;
    modelId: string;
    routeId: string | null;
}

export interface Evidence<Value> {
    value: Value | null;
    status: 'supported' | 'unsupported' | 'unknown';
    source: 'api' | 'official_doc' | 'verified_fixture' | 'manual';
    sourceRef: string;
    observedAt: string;
    expiresAt: string;
    scope: EvidenceScope;
    version: string;
    confidence: 'declared' | 'contract_checked' | 'live_verified';
    conflicts?: Evidence<Value>[];
}

export function validateEvidence<Value>(evidence: Evidence<Value>): void {
    if (!evidence || typeof evidence !== 'object' || !evidence.scope || typeof evidence.scope !== 'object'
        || !evidence.sourceRef || !evidence.version || !evidence.scope.endpoint || !evidence.scope.modelId
        || !['api', 'official_doc', 'verified_fixture', 'manual'].includes(evidence.source)
        || !['supported', 'unsupported', 'unknown'].includes(evidence.status)
        || !['declared', 'contract_checked', 'live_verified'].includes(evidence.confidence)
        || !Number.isFinite(Date.parse(evidence.observedAt)) || !Number.isFinite(Date.parse(evidence.expiresAt))
        || Date.parse(evidence.expiresAt) <= Date.parse(evidence.observedAt)
        || (evidence.source === 'verified_fixture' && evidence.confidence === 'live_verified')
        || (evidence.status === 'supported' && evidence.value === null)
        || (evidence.status === 'unknown' && evidence.value !== null)) {
        throw new AgentFault('E_EVIDENCE_INVALID', '模型证据的来源、范围、状态或时效不完整');
    }
}

export function requireEvidence<Value>(evidence: Evidence<Value>, scope: EvidenceScope, now = Date.now()): Value {
    validateEvidence(evidence);
    if (canonicalJson(evidence.scope) !== canonicalJson(scope) || Date.parse(evidence.expiresAt) <= now
        || Date.parse(evidence.observedAt) > now || evidence.status === 'unknown') {
        throw new AgentFault('E_CAPABILITY_UNKNOWN', '该模型能力缺少当前端点和路由的有效证据');
    }
    if (evidence.status === 'unsupported') throw new AgentFault('E_PARAMETER_UNSUPPORTED', '当前模型明确不支持这项能力');
    return evidence.value!;
}

export function mergeEvidence<Value>(left: Evidence<Value>, right: Evidence<Value>): Evidence<Value> {
    validateEvidence(left);
    validateEvidence(right);
    if (canonicalJson(left.scope) !== canonicalJson(right.scope)) throw new AgentFault('E_EVIDENCE_SCOPE', '不能合并不同模型或路由的证据');
    if (left.status !== right.status || canonicalJson(left.value) !== canonicalJson(right.value)) {
        return { ...right, status: 'unknown', value: null, confidence: 'declared', conflicts: [structuredClone(left), structuredClone(right)] };
    }
    return structuredClone(Date.parse(right.observedAt) >= Date.parse(left.observedAt) ? right : left);
}
