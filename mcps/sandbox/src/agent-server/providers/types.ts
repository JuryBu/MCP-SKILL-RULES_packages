import { AgentFault } from '../protocol.js';
import type { JsonObject, JsonValue } from '../protocol.js';
import type { NormalizedUsage, PriceEntry } from '../accounting/usage.js';

export type ProviderProtocol = 'compatible_chat' | 'gemini' | 'openai_responses' | 'anthropic' | 'progrok';
export type Acceptance = 'not_sent' | 'rejected' | 'accepted' | 'unknown';
export type DispatchPhase = 'prepared' | 'reserved' | 'dispatching' | 'accepted' | 'committed' | 'rejected' | 'unknown';
export type TransportPhase = 'preflight' | 'fetch_invoked' | 'response_headers' | 'response_body';
export interface TransportCause { name: string; code?: string | number; causeCode?: string | number }
export type StopKind = 'completed' | 'tool_calls' | 'paused' | 'truncated' | 'refused' | 'cancelled' | 'failed' | 'unknown';

export interface RoutePolicy {
    version: string;
    kind: 'direct' | 'pinned_aggregator';
    allowedModels: string[];
    allowedRoutes: string[];
    provider?: string;
    requireParameters?: boolean;
    allowFallbacks: false;
    evidenceRef: string;
}

export interface ProviderProfile {
    schemaVersion: 1;
    profileId: string;
    revision: number;
    label: string;
    protocol: ProviderProtocol;
    baseUrl: string;
    credentialRef: string | null;
    credentialGeneration: number;
    quotaScopeId: string;
    quotaLimitId?: string | null;
    defaultModel: string | null;
    routePolicy: RoutePolicy;
    parameterDefaults: JsonObject;
    discovery: { enabled: boolean; pageSize: number };
    remoteRetention: 'disabled' | 'allowed';
    globalModelRulesRef: string | null;
    compressionModelRef: string | null;
}

export interface FunctionTool {
    name: string;
    description?: string;
    parameters: JsonObject;
    strict?: boolean;
}

export interface NativeSendView {
    protocol: ProviderProtocol;
    stream?: boolean;
    messages?: JsonObject[];
    contents?: JsonObject[];
    input?: JsonObject[];
    system?: JsonValue;
    systemInstruction?: JsonObject;
    tools?: FunctionTool[];
}

export interface RequestVersions {
    compressionOriginReason?: 'background' | 'hard' | 'manual' | 'fold';
    conversationId: string;
    runId: string;
    roundId: string | null;
    stepId: string;
    actionId: string;
    runEpoch: number;
    historyEpoch: number;
    appendSeq: number;
    viewRevision: number;
    workspaceRevision: number;
    catalogVersion: string;
    capabilityVersion: string;
    priceVersion: string | null;
    toolSchemaHash: string;
    skillVersions: JsonObject;
    ruleVersions?: JsonObject;
    instructionPrefixHash?: string;
    attachmentManifestHash: string;
    nativeReplayHash: string;
}

export interface RequestSnapshot extends RequestVersions {
    schemaVersion: 1;
    streaming?: boolean;
    rootBudgetId?: string;
    frozenAt: string;
    pricingSnapshot?: PriceEntry;
    price?: PriceEntry;
    profile: ProviderProfile;
    profileRevision: number;
    credentialGeneration: number;
    routePolicyVersion: string;
    modelId: string;
    effectiveParameters: JsonObject;
    adapterVersion: string;
    serializerVersion: 'canonical-json-v1';
    endpoint: string;
    body: string;
    bodyHash: string;
    snapshotHash: string;
    timeoutMs: number;
    deadlineAt: string;
}

export interface ProviderAttempt {
    attemptId: string;
    rootBudgetId: string;
    createdAt: string;
    snapshot: RequestSnapshot;
    idempotencyKey?: string;
}

export interface NativeBlock {
    index: number;
    candidateIndex: number;
    type: 'text' | 'image' | 'audio' | 'video' | 'file' | 'refusal' | 'native_unknown';
    text?: string;
    mime?: string;
    dataBase64?: string;
    byteLength?: number;
    sha256?: string;
    uri?: string;
    nativeRef: string;
    native: JsonValue;
    thoughtSignature?: string;
    thought?: boolean;
    materialization?: 'inline' | 'remote_pending';
    nativeFragments?: Array<{ index: number; nativeRef: string; native: JsonValue; thoughtSignature?: string }>;
}

export interface ToolCall {
    callId: string;
    providerCallId: string | null;
    name: string;
    arguments: JsonObject;
    candidateIndex: number;
    index: number;
    nativeRef: string;
    native: JsonObject;
}

export interface ToolResult {
    callId: string;
    name: string;
    result: JsonValue;
    isError?: boolean;
    nativeParts?: JsonObject[];
}

export interface RawProviderResponse {
    httpStatus: number;
    headers: Record<string, string>;
    body: string;
    json: JsonObject;
    parseError?: 'invalid_json_or_non_object';
    stream?: { protocol: ProviderProtocol; complete: boolean; eventCount: number };
}

export interface ProviderPartial {
    attemptId: string;
    seq: number;
    receivedAt: string;
    kind: 'transport' | 'event';
    eventType: string;
    native: JsonObject | null;
    providerResponseId: string | null;
    textDelta?: string;
    receivedBytes?: number;
}

export interface NormalizedResponse {
    attemptId: string;
    providerRequestId: string | null;
    providerResponseId: string | null;
    modelId: string | null;
    routeId: string | null;
    blocks: NativeBlock[];
    toolCalls: ToolCall[];
    stop: { kind: StopKind; native: JsonValue };
    usage: NormalizedUsage;
    raw: RawProviderResponse;
    complete: boolean;
    canExecuteTools: boolean;
    replayMessages: JsonObject[];
    problems: string[];
}

export interface HttpRequest {
    method: 'GET' | 'POST';
    url: string;
    headers: Record<string, string>;
    body?: string;
    timeoutMs: number;
    maxResponseBytes?: number;
    onChunk?: (chunk: Uint8Array, response: { status: number; headers: Record<string, string> }) => void | Promise<void>;
}

export interface HttpResponse {
    status: number;
    headers: Record<string, string>;
    body: string;
}

export interface HttpTransport {
    request(request: HttpRequest, signal?: AbortSignal): Promise<HttpResponse>;
    close?(): Promise<void> | void;
}

export interface SendContext {
    transport: HttpTransport;
    credential?: string;
    onPartial?: (partial: ProviderPartial) => void | Promise<void>;
}

export interface DiscoveryPage {
    models: JsonObject[];
    nextCursor: string | null;
    complete: boolean;
}

export type LookupResult = { status: 'unsupported' | 'pending' | 'not_found'; provesNotAccepted?: boolean }
    | { status: 'found'; response: NormalizedResponse };

export interface ProviderLookupHandle { attemptId: string; providerResponseId?: string; snapshot?: RequestSnapshot }

export interface ProviderAdapter {
    readonly protocol: ProviderProtocol;
    readonly version: string;
    endpoint(profile: ProviderProfile, modelId: string, stream?: boolean): string;
    encode(view: NativeSendView, modelId: string, parameters: JsonObject): JsonObject;
    encodeForMeasurement?(view: NativeSendView, modelId: string, parameters: JsonObject): JsonObject;
    validate(snapshot: RequestSnapshot): void;
    send(attempt: ProviderAttempt, context: SendContext, signal?: AbortSignal): Promise<NormalizedResponse>;
    discover(profile: ProviderProfile, cursor: string | null, context: SendContext, signal?: AbortSignal): Promise<DiscoveryPage>;
    continueView(view: NativeSendView, response: NormalizedResponse, results: ToolResult[]): NativeSendView;
    lookup(handle: ProviderLookupHandle, context: SendContext, signal?: AbortSignal): Promise<LookupResult>;
}

export class ProviderFault extends AgentFault {
    readonly acceptance: Acceptance;
    readonly phase: DispatchPhase;
    readonly httpStatus?: number;
    readonly nativeCode?: string;
    readonly nativeReason?: string;
    readonly transportCause?: TransportCause;
    readonly transportPhase?: TransportPhase;
    readonly retryAfterMs?: number;
    readonly rawResponse?: RawProviderResponse;
    readonly partialResponse?: NormalizedResponse;
    readonly usage?: NormalizedUsage;

    constructor(code: string, message: string, options: {
        acceptance: Acceptance; phase?: DispatchPhase; httpStatus?: number; nativeCode?: string; nativeReason?: string;
        transportCause?: TransportCause; transportPhase?: TransportPhase;
        retryAfterMs?: number; retryable?: boolean; rawResponse?: RawProviderResponse;
        partialResponse?: NormalizedResponse; usage?: NormalizedUsage;
    }) {
        const phase = options.phase ?? (options.acceptance === 'not_sent' ? 'prepared' : options.acceptance === 'unknown' ? 'unknown' : options.acceptance);
        super(code, message, { acceptance: options.acceptance, phase,
            httpStatus: options.httpStatus, nativeCode: options.nativeCode, nativeReason: options.nativeReason, retryAfterMs: options.retryAfterMs,
            ...(options.transportCause ? { transportCause: { ...options.transportCause } } : {}),
            ...(options.transportPhase ? { transportPhase: options.transportPhase } : {}) },
        options.acceptance === 'accepted' || options.acceptance === 'unknown', options.retryable ?? false);
        this.name = 'ProviderFault';
        this.acceptance = options.acceptance;
        this.phase = phase;
        this.httpStatus = options.httpStatus;
        this.nativeCode = options.nativeCode;
        this.nativeReason = options.nativeReason;
        this.transportCause = options.transportCause ? Object.freeze({ ...options.transportCause }) : undefined;
        this.transportPhase = options.transportPhase;
        this.retryAfterMs = options.retryAfterMs;
        this.rawResponse = options.rawResponse;
        this.partialResponse = options.partialResponse;
        this.usage = options.usage;
    }
}
