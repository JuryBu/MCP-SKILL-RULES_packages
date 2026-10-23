import fs from "node:fs";
import { createDecipheriv } from "node:crypto";

export type LocalPbSourceFlavor = "windsurf" | "antigravity";
export type LocalPbCandidateKind = "active" | "implicit";

export type LocalPbErrorCode =
    | "MISSING_KEY"
    | "INVALID_KEY"
    | "AUTH_FAILED"
    | "TRUNCATED"
    | "MALFORMED_WIRE"
    | "UNSAFE_VARINT"
    | "PAYLOAD_TOO_LARGE"
    | "INVALID_RANGE"
    | "CANCELLED"
    | "DEADLINE_EXCEEDED";

export class LocalPbReaderError extends Error {
    constructor(
        public readonly code: LocalPbErrorCode,
        message: string,
    ) {
        super(message);
        this.name = "LocalPbReaderError";
    }
}

export interface LocalPbReaderOptions {
    /** Explicitly injected 32-byte AES key. Hex and base64 strings are supported. */
    key?: Uint8Array | string;
    /** Environment variable used only when `key` is absent. */
    keyEnv?: string;
    /** Injectable environment makes the reader deterministic in tests. */
    env?: Record<string, string | undefined>;
    /** The result is always tagged; schemas are deliberately not conflated. */
    sourceFlavor: LocalPbSourceFlavor;
    /** Upper bound after authenticated decryption, default 64 MiB. */
    maxPayloadBytes?: number;
    stepRange?: LocalPbStepRangeRequest;
    signal?: AbortSignal;
    isCancelled?: () => boolean;
    deadlineMs?: number;
}

export type LocalPbStepRangeRequest =
    | { startStep: number; endStepExclusive?: number }
    | { tailSteps: number };

export interface LocalPbStepCoverage {
    unit: "step";
    startStep: number;
    endStepExclusive: number;
    totalSteps: number;
    complete: boolean;
    encryptedEnvelopeVerified: true;
}

export interface LocalPbCandidate {
    kind: LocalPbCandidateKind;
    encrypted: Uint8Array;
    label?: string;
}

export interface LocalPbFileCandidate {
    kind: LocalPbCandidateKind;
    filePath: string;
    label?: string;
}

export interface LocalPbTimestamp {
    seconds: string;
    nanos?: number;
    iso?: string;
}

export interface LocalPbPlannerResponse {
    response?: string;
    thinking?: string;
    modifiedResponse?: string;
}

export interface LocalPbWireSummary {
    fieldNumber: number;
    wireType: number;
    value?: string;
    byteLength?: number;
    text?: string;
}

export interface LocalPbToolVariant {
    /** A wire-level name, intentionally not a cross-flavor semantic name. */
    variantName: string;
    fieldNumber: number;
    rawSubfields: LocalPbWireSummary[];
}

export interface LocalPbActivity {
    kind: "file_context" | "file_change" | "terminal_command" | "terminal_output";
    sourceFlavor: LocalPbSourceFlavor;
    fieldNumber: 10 | 14 | 28 | 37;
    uri?: string;
    cwd?: string;
    terminalId?: string;
    textFields: Array<{ fieldPath: string; text: string }>;
    lineSequence?: {
        fieldPath: string;
        lines: Array<{ text?: string; rawFlag?: string }>;
    };
    rawSubfields: LocalPbWireSummary[];
}

export interface LocalPbDiagnostic {
    kind: "checkpoint" | "partial" | "unknown_variant";
    message: string;
    fieldNumber?: number;
}

export interface LocalPbStep {
    index: number;
    timestamp?: LocalPbTimestamp;
    contextTokens?: number;
    user?: string;
    planner?: LocalPbPlannerResponse;
    system?: string;
    activities?: LocalPbActivity[];
    toolVariants: LocalPbToolVariant[];
    diagnostics: LocalPbDiagnostic[];
}

export interface LocalPbTrajectory {
    id?: string;
    steps: LocalPbStep[];
}

export interface LocalPbReadResult {
    sourceFlavor: LocalPbSourceFlavor;
    candidate: LocalPbCandidateKind;
    label?: string;
    encryptedBytes: number;
    decryptedBytes: number;
    trajectory: LocalPbTrajectory;
    diagnostics: LocalPbDiagnostic[];
    partial?: boolean;
    coverage?: LocalPbStepCoverage;
}

export interface LocalPbCandidateOutcome {
    candidate: LocalPbCandidateKind;
    label?: string;
    result?: LocalPbReadResult;
    error?: { code: LocalPbErrorCode | "UNKNOWN"; message: string };
}

interface ProtoField {
    fieldNumber: number;
    wireType: number;
    value?: bigint;
    bytes?: Uint8Array;
}

interface ProtoMessage {
    fields: ProtoField[];
}

const DEFAULT_KEY_ENV = "MEMORY_STORE_LOCAL_PB_KEY";
const DEFAULT_APPLICATION_KEY = "safeCodeiumworldKeYsecretBalloon";
const DEFAULT_MAX_PAYLOAD_BYTES = 64 * 1024 * 1024;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const LITERAL_UTF8_DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * Reads a nonce-prefixed AES-256-GCM payload. The layout is exactly
 * nonce[12] + ciphertext + tag[16]. The application key works offline;
 * an explicit key or environment override remains available for compatibility.
 */
export function decryptLocalPb(encrypted: Uint8Array, options: LocalPbReaderOptions): Uint8Array {
    if (encrypted.byteLength < 28) {
        throw new LocalPbReaderError("TRUNCATED", "Encrypted local PB is shorter than a GCM nonce and authentication tag");
    }

    const key = resolveKey(options);
    const nonce = encrypted.subarray(0, 12);
    const tag = encrypted.subarray(encrypted.byteLength - 16);
    const ciphertext = encrypted.subarray(12, encrypted.byteLength - 16);

    try {
        const decipher = createDecipheriv("aes-256-gcm", key, nonce);
        decipher.setAuthTag(tag);
        const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
        const maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
        if (plaintext.byteLength > maxPayloadBytes) {
            throw new LocalPbReaderError("PAYLOAD_TOO_LARGE", `Decrypted local PB exceeds the ${maxPayloadBytes}-byte limit`);
        }
        return plaintext;
    } catch (error) {
        if (error instanceof LocalPbReaderError) throw error;
        throw new LocalPbReaderError("AUTH_FAILED", "Local PB AES-256-GCM authentication failed");
    }
}

/** Parse one encrypted active or implicit PB candidate without touching any client or cache. */
export function readLocalPbCandidate(candidate: LocalPbCandidate, options: LocalPbReaderOptions): LocalPbReadResult {
    checkLocalPbReadBudget(options);
    if (options.stepRange) resolveLocalPbStepCoverage(options.stepRange, 0);
    const decrypted = decryptLocalPb(candidate.encrypted, options);
    checkLocalPbReadBudget(options);
    const root = parseProtoMessage(decrypted);
    const trajectory = findTrajectory(root, candidate.kind);

    if (!trajectory) {
        throw new LocalPbReaderError("MALFORMED_WIRE", "Local PB has no trajectory-shaped protobuf message");
    }

    const stepFields = bytesFields(trajectory, 2);
    const coverage = options.stepRange ? resolveLocalPbStepCoverage(options.stepRange, stepFields.length) : undefined;
    const startStep = coverage?.startStep ?? 0;
    const endStepExclusive = coverage?.endStepExclusive ?? stepFields.length;
    const parsedSteps = stepFields.slice(startStep, endStepExclusive).map((field, offset) => {
        checkLocalPbReadBudget(options);
        const message = parseNested(field, "trajectory step");
        return parseStep(message, startStep + offset, options.sourceFlavor);
    });
    checkLocalPbReadBudget(options);
    const id = firstTextField(trajectory, 1);
    const diagnostics = parsedSteps.flatMap(step => step.diagnostics);
    if (coverage && !coverage.complete) diagnostics.push({
        kind: "partial",
        message: `PB step range [${coverage.startStep}, ${coverage.endStepExclusive}) of ${coverage.totalSteps}; omitted step bodies were not decoded`,
    });

    return {
        sourceFlavor: options.sourceFlavor,
        candidate: candidate.kind,
        ...(candidate.label ? { label: candidate.label } : {}),
        encryptedBytes: candidate.encrypted.byteLength,
        decryptedBytes: decrypted.byteLength,
        trajectory: {
            ...(id ? { id } : {}),
            steps: parsedSteps,
        },
        diagnostics,
        partial: diagnostics.some(diagnostic => diagnostic.kind === "partial" || diagnostic.kind === "unknown_variant"),
        ...(coverage ? { coverage } : {}),
    };
}

/** Read a filesystem candidate only; no writes, discovery, cache, or live-client calls occur. */
export function readLocalPbFileCandidate(candidate: LocalPbFileCandidate, options: LocalPbReaderOptions): LocalPbReadResult {
    checkLocalPbReadBudget(options);
    return readLocalPbCandidate({
        kind: candidate.kind,
        encrypted: fs.readFileSync(candidate.filePath),
        ...(candidate.label ? { label: candidate.label } : {}),
    }, options);
}

function checkLocalPbReadBudget(options: LocalPbReaderOptions): void {
    if (options.signal?.aborted || options.isCancelled?.()) {
        throw new LocalPbReaderError("CANCELLED", "Local PB read cancelled");
    }
    if (options.deadlineMs !== undefined && Date.now() >= options.deadlineMs) {
        throw new LocalPbReaderError("DEADLINE_EXCEEDED", "Local PB read deadline exceeded");
    }
}

function resolveLocalPbStepCoverage(request: LocalPbStepRangeRequest, totalSteps: number): LocalPbStepCoverage {
    const validIndex = (value: number) => Number.isSafeInteger(value) && value >= 0;
    let startStep: number;
    let endStepExclusive: number;
    if ("tailSteps" in request) {
        if (!validIndex(request.tailSteps) || request.tailSteps === 0 || "startStep" in request || "endStepExclusive" in request) {
            throw new LocalPbReaderError("INVALID_RANGE", "PB tailSteps must be a positive safe integer without absolute bounds");
        }
        startStep = Math.max(0, totalSteps - request.tailSteps);
        endStepExclusive = totalSteps;
    } else {
        const requestedEnd = request.endStepExclusive ?? totalSteps;
        if (!validIndex(request.startStep) || !validIndex(requestedEnd)
            || (request.endStepExclusive !== undefined && requestedEnd < request.startStep)) {
            throw new LocalPbReaderError("INVALID_RANGE", "PB step bounds must be nonnegative safe integers in ascending order");
        }
        startStep = Math.min(totalSteps, request.startStep);
        endStepExclusive = Math.min(totalSteps, Math.max(requestedEnd, startStep));
    }
    return {
        unit: "step", startStep, endStepExclusive, totalSteps,
        complete: startStep === 0 && endStepExclusive === totalSteps,
        encryptedEnvelopeVerified: true,
    };
}

/**
 * Evaluate active and implicit inputs independently so one damaged local file
 * does not hide a readable sibling. Callers can choose precedence later.
 */
export function readLocalPbCandidates(candidates: LocalPbCandidate[], options: LocalPbReaderOptions): LocalPbCandidateOutcome[] {
    return candidates.map(candidate => {
        try {
            return { candidate: candidate.kind, ...(candidate.label ? { label: candidate.label } : {}), result: readLocalPbCandidate(candidate, options) };
        } catch (error) {
            const readerError = error instanceof LocalPbReaderError ? error : null;
            return {
                candidate: candidate.kind,
                ...(candidate.label ? { label: candidate.label } : {}),
                error: {
                    code: readerError?.code ?? "UNKNOWN",
                    message: readerError?.message ?? "Unexpected local PB reader failure",
                },
            };
        }
    });
}

function resolveKey(options: LocalPbReaderOptions): Buffer {
    const environmentKey = (options.env ?? process.env)[options.keyEnv ?? DEFAULT_KEY_ENV];
    const supplied = options.key ?? environmentKey ?? (options.keyEnv ? undefined : DEFAULT_APPLICATION_KEY);
    if (supplied === undefined || supplied === "") {
        throw new LocalPbReaderError("MISSING_KEY", `Local PB key is required through options.key or ${options.keyEnv ?? DEFAULT_KEY_ENV}`);
    }

    const key = supplied instanceof Uint8Array ? Buffer.from(supplied) : decodeKeyString(supplied);
    if (key.byteLength !== 32) {
        throw new LocalPbReaderError("INVALID_KEY", "Local PB AES-256-GCM key must decode to exactly 32 bytes");
    }
    return key;
}

function decodeKeyString(value: string): Buffer {
    const compact = value.trim();
    const text = compact.startsWith("text:") ? compact.slice(5) : compact;
    if (Buffer.byteLength(text, "utf8") === 32) return Buffer.from(text, "utf8");
    const hex = compact.startsWith("hex:") ? compact.slice(4) : compact;
    if (/^[0-9a-f]{64}$/iu.test(hex)) return Buffer.from(hex, "hex");

    const base64 = compact.startsWith("base64:") ? compact.slice(7) : compact;
    if (/^[A-Za-z0-9+/]+={0,2}$/u.test(base64) && base64.length % 4 === 0) {
        return Buffer.from(base64, "base64");
    }
    throw new LocalPbReaderError("INVALID_KEY", "Local PB key must be 32-byte UTF-8 text, a 32-byte Uint8Array, 64-character hex, or base64");
}

function parseProtoMessage(input: Uint8Array): ProtoMessage {
    const fields: ProtoField[] = [];
    let offset = 0;
    while (offset < input.byteLength) {
        const key = readVarint(input, offset, "field key");
        offset = key.offset;
        const keyNumber = asSafeNumber(key.value, "field key");
        const fieldNumber = keyNumber >>> 3;
        const wireType = keyNumber & 0x07;
        if (fieldNumber === 0 || wireType === 3 || wireType === 4 || wireType > 5) {
            throw new LocalPbReaderError("MALFORMED_WIRE", `Invalid protobuf field key ${keyNumber}`);
        }

        if (wireType === 0) {
            const value = readVarint(input, offset, `field ${fieldNumber} varint`);
            fields.push({ fieldNumber, wireType, value: value.value });
            offset = value.offset;
            continue;
        }
        if (wireType === 1) {
            offset = requireBytes(input, offset, 8, `field ${fieldNumber} fixed64`);
            fields.push({ fieldNumber, wireType });
            continue;
        }
        if (wireType === 5) {
            offset = requireBytes(input, offset, 4, `field ${fieldNumber} fixed32`);
            fields.push({ fieldNumber, wireType });
            continue;
        }

        const length = readVarint(input, offset, `field ${fieldNumber} length`);
        offset = length.offset;
        const byteLength = asSafeNumber(length.value, `field ${fieldNumber} length`);
        const end = requireBytes(input, offset, byteLength, `field ${fieldNumber} payload`);
        fields.push({ fieldNumber, wireType, bytes: input.subarray(offset, end) });
        offset = end;
    }
    return { fields };
}

function readVarint(input: Uint8Array, initialOffset: number, context: string): { value: bigint; offset: number } {
    let value = 0n;
    let offset = initialOffset;
    for (let index = 0; index < 10; index += 1) {
        if (offset >= input.byteLength) {
            throw new LocalPbReaderError("TRUNCATED", `Truncated protobuf varint while reading ${context}`);
        }
        const byte = input[offset++];
        if (index === 9 && (byte & 0xfe) !== 0) {
            throw new LocalPbReaderError("UNSAFE_VARINT", `Protobuf varint overflows uint64 while reading ${context}`);
        }
        value |= BigInt(byte & 0x7f) << BigInt(index * 7);
        if ((byte & 0x80) === 0) return { value, offset };
    }
    throw new LocalPbReaderError("UNSAFE_VARINT", `Protobuf varint is longer than uint64 while reading ${context}`);
}

function asSafeNumber(value: bigint, context: string): number {
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new LocalPbReaderError("UNSAFE_VARINT", `Protobuf ${context} exceeds JavaScript's safe integer range`);
    }
    return Number(value);
}

function requireBytes(input: Uint8Array, offset: number, byteLength: number, context: string): number {
    if (byteLength < 0 || byteLength > input.byteLength - offset) {
        throw new LocalPbReaderError("TRUNCATED", `Truncated protobuf ${context}`);
    }
    return offset + byteLength;
}

function bytesFields(message: ProtoMessage, fieldNumber: number): ProtoField[] {
    return message.fields.filter(field => field.fieldNumber === fieldNumber && field.wireType === 2 && field.bytes !== undefined);
}

function parseNested(field: ProtoField, context: string): ProtoMessage {
    if (!field.bytes) throw new LocalPbReaderError("MALFORMED_WIRE", `Missing length-delimited bytes for ${context}`);
    return parseProtoMessage(field.bytes);
}

function findTrajectory(root: ProtoMessage, kind: LocalPbCandidateKind): ProtoMessage | null {
    const candidates: ProtoMessage[] = [root];

    // implicit files commonly put a trajectory in their top-level field 1 wrapper.
    if (kind === "implicit") {
        for (const field of bytesFields(root, 1)) {
            try {
                const nested = parseNested(field, "implicit trajectory wrapper");
                candidates.push(nested);
            } catch {
                // Continue scanning: implicit field 1 may be absent or use a different wrapper.
            }
        }
    }

    let best: ProtoMessage | null = null;
    let bestScore = -1;
    for (const candidate of candidates) {
        const steps = bytesFields(candidate, 2).length;
        const id = firstTextField(candidate, 1);
        const score = (steps * 10) + (id ? 2 : 0);
        if (steps > 0 && score > bestScore) {
            best = candidate;
            bestScore = score;
        }
    }
    return best;
}

function parseStep(message: ProtoMessage, index: number, sourceFlavor: LocalPbSourceFlavor): LocalPbStep {
    const plannerMessage = firstNestedField(message, 20);
    const metadataMessage = firstNestedField(message, 5);
    const timestamp = extractTimestamp(message);
    const contextTokens = metadataMessage ? firstVarintField(metadataMessage, 25) : undefined;
    const activities = message.fields.flatMap(field => {
        const activity = parseActivity(field, message, sourceFlavor);
        return activity ? [activity] : [];
    });
    const mappedFields = new Set<number>(activities.map(activity => activity.fieldNumber));
    const toolVariants = extractUnknownVariants(message, mappedFields);
    const diagnostics = [
        ...detectMarkerDiagnostics({ fields: message.fields.filter(field => !mappedFields.has(field.fieldNumber)) }),
        ...activities.filter(activity => activity.textFields.some(field =>
            (field.fieldPath === "28.21.1" || field.fieldPath === "37.9" || field.fieldPath === "37.12")
            && /^<truncated \d+ lines?>/mu.test(field.text)))
            .map(activity => ({ kind: "partial" as const, fieldNumber: activity.fieldNumber,
                message: "PB terminal output contains an explicit truncated-lines marker" })),
        ...toolVariants.map(variant => ({
            kind: "unknown_variant" as const,
            fieldNumber: variant.fieldNumber,
            message: `Unmapped local PB variant ${variant.variantName}; retained as wire data rather than assigned cross-flavor meaning`,
        })),
    ];

    return {
        index,
        ...(timestamp ? { timestamp } : {}),
        ...(contextTokens !== undefined ? { contextTokens } : {}),
        ...(firstTextFromNestedField(message, 19) ? { user: firstTextFromNestedField(message, 19) } : {}),
        ...(plannerMessage ? { planner: {
            ...(firstTextField(plannerMessage, 1) ? { response: firstTextField(plannerMessage, 1) } : {}),
            ...(firstTextField(plannerMessage, 2) ? { thinking: firstTextField(plannerMessage, 2) } : {}),
            ...(firstTextField(plannerMessage, 3) ? { modifiedResponse: firstTextField(plannerMessage, 3) } : {}),
        } } : {}),
        ...(firstTextFromNestedField(message, 114) ? { system: firstTextFromNestedField(message, 114) } : {}),
        activities,
        toolVariants,
        diagnostics,
    };
}

function hasWireShape(message: ProtoMessage, allowed: Record<number, number>, repeated: number[] = []): boolean {
    const seen = new Set<number>();
    return message.fields.every(field => {
        if (allowed[field.fieldNumber] !== field.wireType) return false;
        if (seen.has(field.fieldNumber) && !repeated.includes(field.fieldNumber)) return false;
        seen.add(field.fieldNumber);
        return true;
    });
}

function directTextField(message: ProtoMessage, fieldNumber: number): string | undefined {
    const field = bytesFields(message, fieldNumber)[0];
    if (!field?.bytes) return undefined;
    return field.bytes.byteLength === 0 ? "" : decodeUtf8(field.bytes, true);
}

function parseActivity(field: ProtoField, step: ProtoMessage, sourceFlavor: LocalPbSourceFlavor): LocalPbActivity | undefined {
    const expectedTypes: Record<number, number> = { 10: 5, 14: 8, 28: 21, 37: 28 };
    if (!expectedTypes[field.fieldNumber] || field.wireType !== 2 || !field.bytes) return undefined;
    if (step.fields.filter(item => item.fieldNumber === field.fieldNumber).length !== 1) return undefined;
    if (firstVarintField(step, 1) !== expectedTypes[field.fieldNumber] || firstVarintField(step, 4) !== 3) return undefined;
    if (sourceFlavor === "antigravity" && field.fieldNumber !== 10) return undefined;
    try {
        const nested = parseNested(field, "activity variant");
        const base = { sourceFlavor, rawSubfields: nested.fields.map(summarizeField) };
        if (field.fieldNumber === 10) return parseFileContext(nested, sourceFlavor);
        if (field.fieldNumber === 14) {
            if (!hasWireShape(nested, { 1: 2, 2: 0, 3: 0, 4: 2, 9: 2, 17: 0 })) return undefined;
            const uri = directTextField(nested, 1);
            const content = directTextField(nested, 4);
            const snapshot = directTextField(nested, 9);
            if (!uri?.startsWith("file://") || content === undefined || snapshot === undefined
                || firstVarintField(nested, 3) === undefined || firstVarintField(nested, 17) === undefined) return undefined;
            return { ...base, kind: "file_change", fieldNumber: 14, uri,
                textFields: [{ fieldPath: "14.4", text: content }, { fieldPath: "14.9", text: snapshot }] };
        }
        if (field.fieldNumber === 28) {
            if (!hasWireShape(nested, { 2: 2, 6: 0, 11: 0, 13: 2, 21: 2, 22: 0, 23: 2, 25: 2 })) return undefined;
            const cwd = directTextField(nested, 2);
            const command = directTextField(nested, 23);
            const alternateCommand = directTextField(nested, 25);
            const terminalId = directTextField(nested, 13);
            const output = firstNestedField(nested, 21);
            const hasStatus = firstVarintField(nested, 11) !== undefined;
            if (!cwd || command === undefined || alternateCommand === undefined || !output
                || !hasWireShape(output, { 1: 2 }) || hasStatus === (terminalId !== undefined)
                || firstVarintField(nested, 6) === undefined || firstVarintField(nested, 22) === undefined) return undefined;
            const text = directTextField(output, 1);
            if (output.fields.length && text === undefined) return undefined;
            return { ...base, kind: "terminal_command", fieldNumber: 28, cwd,
                ...(terminalId !== undefined ? { terminalId } : {}),
                textFields: [
                    { fieldPath: "28.23", text: command },
                    { fieldPath: "28.25", text: alternateCommand },
                    ...(text !== undefined ? [{ fieldPath: "28.21.1", text }] : []),
                ] };
        }
        if (!hasWireShape(nested, { 1: 2, 2: 0, 5: 0, 9: 2, 12: 2 })) return undefined;
        const terminalId = directTextField(nested, 1);
        const output = directTextField(nested, 9);
        const alternateOutput = directTextField(nested, 12);
        if (!terminalId || output === undefined || firstVarintField(nested, 2) === undefined
            || (firstVarintField(nested, 5) !== undefined) !== (alternateOutput !== undefined)) return undefined;
        return { ...base, kind: "terminal_output", fieldNumber: 37, terminalId,
            textFields: [{ fieldPath: "37.9", text: output },
                ...(alternateOutput !== undefined ? [{ fieldPath: "37.12", text: alternateOutput }] : [])] };
    } catch {
        return undefined;
    }
}

function parseFileContext(nested: ProtoMessage, sourceFlavor: LocalPbSourceFlavor): LocalPbActivity | undefined {
    if (!hasWireShape(nested, { 1: 2, 2: 2 })) return undefined;
    const input = firstNestedField(nested, 1);
    const output = firstNestedField(nested, 2);
    if (!input || !isFileContextInput(input, sourceFlavor)
        || !output || !hasWireShape(output, { 1: 2 })) return undefined;
    const resource = firstNestedField(output, 1);
    if (!resource || !hasWireShape(resource, sourceFlavor === "windsurf" ? { 2: 2, 8: 2, 10: 2 } : { 2: 2, 8: 2, 11: 0 })) return undefined;
    const uri = directTextField(resource, 8);
    const content = firstNestedField(resource, 2);
    if (!uri?.startsWith("file://") || !content
        || !hasWireShape(content, sourceFlavor === "windsurf" ? { 1: 0, 2: 0, 3: 2 } : { 3: 2 })) return undefined;
    const lineMessage = firstNestedField(content, 3);
    if (!lineMessage || !hasWireShape(lineMessage, { 3: 2 }, [3])) return undefined;
    const lines: Array<{ text?: string; rawFlag?: string }> = [];
    for (const lineField of lineMessage.fields) {
        const line = parseNested(lineField, "file context line");
        if (!hasWireShape(line, { 1: 2, 2: 0 })) return undefined;
        const text = directTextField(line, 1);
        const rawFlag = line.fields.find(item => item.fieldNumber === 2)?.value?.toString();
        if (rawFlag === undefined || (bytesFields(line, 1).length && text === undefined)) return undefined;
        lines.push({ ...(text !== undefined ? { text } : {}), rawFlag });
    }
    const snapshot = directTextField(resource, 10);
    if (bytesFields(resource, 10).length && snapshot === undefined) return undefined;
    return { kind: "file_context", sourceFlavor, fieldNumber: 10, uri,
        textFields: snapshot === undefined ? [] : [{ fieldPath: "10.2.1.10", text: snapshot }],
        lineSequence: { fieldPath: "10.2.1.2.3.3", lines },
        rawSubfields: nested.fields.map(summarizeField) };
}

function isFileContextInput(input: ProtoMessage, sourceFlavor: LocalPbSourceFlavor): boolean {
    if (input.fields.length !== 1 || !hasWireShape(input, sourceFlavor === "windsurf" ? { 1: 2, 4: 2 } : { 2: 2, 4: 2 })) return false;
    const outerNumber = input.fields[0].fieldNumber;
    const outer = firstNestedField(input, outerNumber);
    const innerNumber = outerNumber === 1 ? 7 : outerNumber === 2 ? 2 : 1;
    if (!outer || !hasWireShape(outer, { [innerNumber]: 2 })) return false;
    const inner = firstNestedField(outer, innerNumber);
    if (!inner) return false;
    return outerNumber === 1
        ? hasWireShape(inner, { 1: 2, 2: 0, 3: 0 }) && directTextField(inner, 1)?.startsWith("file://") === true
        : hasWireShape(inner, { 5: 2 }) && directTextField(inner, 5)?.startsWith("file://") === true;
}

function firstVarintField(message: ProtoMessage, fieldNumber: number): number | undefined {
    const field = message.fields.find(candidate => candidate.fieldNumber === fieldNumber && candidate.wireType === 0 && candidate.value !== undefined);
    return field?.value === undefined ? undefined : asSafeNumber(field.value, `field ${fieldNumber}`);
}

function firstNestedField(message: ProtoMessage, fieldNumber: number): ProtoMessage | undefined {
    const field = bytesFields(message, fieldNumber)[0];
    if (!field) return undefined;
    try {
        return parseNested(field, `field ${fieldNumber}`);
    } catch {
        return undefined;
    }
}

function firstTextFromNestedField(message: ProtoMessage, fieldNumber: number): string | undefined {
    const field = bytesFields(message, fieldNumber)[0];
    if (!field?.bytes) return undefined;
    try {
        const nested = parseNested(field, `field ${fieldNumber}`);
        return firstTextLeaf(nested);
    } catch {
        return decodeUtf8(field.bytes);
    }
}

function firstTextField(message: ProtoMessage, fieldNumber: number): string | undefined {
    for (const field of bytesFields(message, fieldNumber)) {
        if (!field.bytes) continue;
        const direct = decodeUtf8(field.bytes);
        if (direct) return direct;
        try {
            const nested = parseNested(field, `field ${fieldNumber}`);
            const nestedText = firstTextLeaf(nested);
            if (nestedText) return nestedText;
        } catch {
            // Binary payloads are not text and do not make this message invalid.
        }
    }
    return undefined;
}

function firstTextLeaf(message: ProtoMessage, remainingDepth = 3): string | undefined {
    for (const field of message.fields) {
        if (!field.bytes) continue;
        const direct = decodeUtf8(field.bytes);
        if (direct) return direct;
        if (remainingDepth > 0) {
            try {
                const nested = parseNested(field, "text leaf");
                const text = firstTextLeaf(nested, remainingDepth - 1);
                if (text) return text;
            } catch {
                // Not a nested message.
            }
        }
    }
    return undefined;
}

function decodeUtf8(bytes: Uint8Array, literal = false): string | undefined {
    try {
        const text = (literal ? LITERAL_UTF8_DECODER : UTF8_DECODER).decode(bytes);
        return text.length > 0 && !/[\u0000-\u0008\u000e-\u001f]/u.test(text) ? text : undefined;
    } catch {
        return undefined;
    }
}

function extractTimestamp(message: ProtoMessage): LocalPbTimestamp | undefined {
    const candidates = [firstNestedField(message, 5), firstNestedField(message, 4)]
        .filter((candidate): candidate is ProtoMessage => candidate !== undefined);
    for (let index = 0; index < candidates.length && index < 32; index += 1) {
        for (const field of candidates[index].fields) {
            if (!field.bytes) continue;
            try {
                candidates.push(parseNested(field, "timestamp candidate"));
            } catch {
                // Not a nested protobuf value.
            }
        }
    }
    for (const candidate of candidates) {
        const seconds = candidate.fields.find(field => field.fieldNumber === 1 && field.wireType === 0)?.value;
        const nanos = candidate.fields.find(field => field.fieldNumber === 2 && field.wireType === 0)?.value;
        if (seconds === undefined) continue;
        if (nanos !== undefined && nanos > 999_999_999n) continue;
        const timestamp: LocalPbTimestamp = { seconds: seconds.toString() };
        if (nanos !== undefined) timestamp.nanos = Number(nanos);
        const safeSeconds = seconds <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(seconds) : undefined;
        if (safeSeconds !== undefined && safeSeconds >= -8_640_000_000 && safeSeconds <= 8_640_000_000) {
            const milliseconds = safeSeconds * 1_000 + Math.floor(Number(nanos ?? 0n) / 1_000_000);
            timestamp.iso = new Date(milliseconds).toISOString();
        }
        return timestamp;
    }
    return undefined;
}

function extractUnknownVariants(message: ProtoMessage, mappedFields: Set<number>): LocalPbToolVariant[] {
    const reserved = new Set([5, 19, 20, 114]);
    const variants: LocalPbToolVariant[] = [];
    for (const field of message.fields) {
        if (reserved.has(field.fieldNumber) || mappedFields.has(field.fieldNumber) || field.wireType !== 2 || !field.bytes) continue;
        try {
            const nested = parseNested(field, `variant field ${field.fieldNumber}`);
            if (field.fieldNumber === 4 && containsTimestampMessage(nested)) continue;
            if (field.fieldNumber === 60 && hasDiagnosticMarker(nested)) continue;
            variants.push({
                variantName: `field_${field.fieldNumber}`,
                fieldNumber: field.fieldNumber,
                rawSubfields: nested.fields.map(summarizeField),
            });
        } catch {
            variants.push({
                variantName: `field_${field.fieldNumber}`,
                fieldNumber: field.fieldNumber,
                rawSubfields: [summarizeField(field)],
            });
        }
    }
    return variants;
}

function isTimestampMessage(message: ProtoMessage): boolean {
    const seconds = message.fields.find(field => field.fieldNumber === 1 && field.wireType === 0)?.value;
    const nanos = message.fields.find(field => field.fieldNumber === 2 && field.wireType === 0)?.value;
    return seconds !== undefined && (nanos === undefined || nanos <= 999_999_999n);
}

function containsTimestampMessage(message: ProtoMessage, remainingDepth = 2): boolean {
    if (isTimestampMessage(message)) return true;
    if (remainingDepth === 0) return false;
    return message.fields.some(field => {
        if (!field.bytes) return false;
        try {
            return containsTimestampMessage(parseNested(field, "timestamp child"), remainingDepth - 1);
        } catch {
            return false;
        }
    });
}

function hasDiagnosticMarker(message: ProtoMessage): boolean {
    const text = collectText(message).join("\n").toLowerCase();
    return text.includes("checkpoint") || text.includes("partial") || text.includes("truncated");
}

function summarizeField(field: ProtoField): LocalPbWireSummary {
    const summary: LocalPbWireSummary = { fieldNumber: field.fieldNumber, wireType: field.wireType };
    if (field.value !== undefined) summary.value = field.value.toString();
    if (field.bytes) {
        summary.byteLength = field.bytes.byteLength;
        const text = decodeUtf8(field.bytes);
        if (text) summary.text = text;
    }
    return summary;
}

function detectMarkerDiagnostics(message: ProtoMessage): LocalPbDiagnostic[] {
    const text = collectText(message).join("\n").toLowerCase();
    const diagnostics: LocalPbDiagnostic[] = [];
    if (text.includes("checkpoint")) diagnostics.push({ kind: "checkpoint", message: "PB step contains a checkpoint marker" });
    if (text.includes("partial") || text.includes("truncated")) diagnostics.push({ kind: "partial", message: "PB step contains a partial or truncated marker" });
    return diagnostics;
}

function collectText(message: ProtoMessage, remainingDepth = 3): string[] {
    const values: string[] = [];
    for (const field of message.fields) {
        if (!field.bytes) continue;
        const direct = decodeUtf8(field.bytes);
        if (direct) values.push(direct);
        if (remainingDepth > 0) {
            try {
                values.push(...collectText(parseNested(field, "diagnostic text"), remainingDepth - 1));
            } catch {
                // Not a nested protobuf payload.
            }
        }
    }
    return values;
}
