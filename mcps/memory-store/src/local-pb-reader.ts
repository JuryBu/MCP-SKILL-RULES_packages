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
    | "PAYLOAD_TOO_LARGE";

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

export interface LocalPbDiagnostic {
    kind: "checkpoint" | "partial" | "unknown_variant";
    message: string;
    fieldNumber?: number;
}

export interface LocalPbStep {
    index: number;
    timestamp?: LocalPbTimestamp;
    user?: string;
    planner?: LocalPbPlannerResponse;
    system?: string;
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
    const decrypted = decryptLocalPb(candidate.encrypted, options);
    const root = parseProtoMessage(decrypted);
    const trajectory = findTrajectory(root, candidate.kind);

    if (!trajectory) {
        throw new LocalPbReaderError("MALFORMED_WIRE", "Local PB has no trajectory-shaped protobuf message");
    }

    const parsedSteps = bytesFields(trajectory, 2).map((field, index) => {
        const message = parseNested(field, "trajectory step");
        return parseStep(message, index);
    });
    const id = firstTextField(trajectory, 1);
    const diagnostics = parsedSteps.flatMap(step => step.diagnostics);

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
    };
}

/** Read a filesystem candidate only; no writes, discovery, cache, or live-client calls occur. */
export function readLocalPbFileCandidate(candidate: LocalPbFileCandidate, options: LocalPbReaderOptions): LocalPbReadResult {
    return readLocalPbCandidate({
        kind: candidate.kind,
        encrypted: fs.readFileSync(candidate.filePath),
        ...(candidate.label ? { label: candidate.label } : {}),
    }, options);
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

function parseStep(message: ProtoMessage, index: number): LocalPbStep {
    const plannerMessage = firstNestedField(message, 20);
    const timestamp = extractTimestamp(message);
    const toolVariants = extractUnknownVariants(message);
    const diagnostics = [
        ...detectMarkerDiagnostics(message),
        ...toolVariants.map(variant => ({
            kind: "unknown_variant" as const,
            fieldNumber: variant.fieldNumber,
            message: `Unmapped local PB variant ${variant.variantName}; retained as wire data rather than assigned cross-flavor meaning`,
        })),
    ];

    return {
        index,
        ...(timestamp ? { timestamp } : {}),
        ...(firstTextFromNestedField(message, 19) ? { user: firstTextFromNestedField(message, 19) } : {}),
        ...(plannerMessage ? { planner: {
            ...(firstTextField(plannerMessage, 1) ? { response: firstTextField(plannerMessage, 1) } : {}),
            ...(firstTextField(plannerMessage, 2) ? { thinking: firstTextField(plannerMessage, 2) } : {}),
            ...(firstTextField(plannerMessage, 3) ? { modifiedResponse: firstTextField(plannerMessage, 3) } : {}),
        } } : {}),
        ...(firstTextFromNestedField(message, 114) ? { system: firstTextFromNestedField(message, 114) } : {}),
        toolVariants,
        diagnostics,
    };
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

function decodeUtf8(bytes: Uint8Array): string | undefined {
    try {
        const text = UTF8_DECODER.decode(bytes);
        return text.length > 0 && !/[\u0000-\u0008\u000e-\u001f]/u.test(text) ? text : undefined;
    } catch {
        return undefined;
    }
}

function extractTimestamp(message: ProtoMessage): LocalPbTimestamp | undefined {
    const candidates: ProtoMessage[] = [message];
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

function extractUnknownVariants(message: ProtoMessage): LocalPbToolVariant[] {
    const reserved = new Set([19, 20, 114]);
    const variants: LocalPbToolVariant[] = [];
    for (const field of message.fields) {
        if (reserved.has(field.fieldNumber) || field.wireType !== 2 || !field.bytes) continue;
        try {
            const nested = parseNested(field, `variant field ${field.fieldNumber}`);
            if (nested.fields.length === 0) continue;
            if (containsTimestampMessage(nested) || hasDiagnosticMarker(nested)) continue;
            variants.push({
                variantName: `field_${field.fieldNumber}`,
                fieldNumber: field.fieldNumber,
                rawSubfields: nested.fields.map(summarizeField),
            });
        } catch {
            // Length-delimited text and binary blobs are not represented as tool variants.
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
