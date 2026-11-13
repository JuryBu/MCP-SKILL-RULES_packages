import * as pbReader from "./local-pb-reader.js";
import type { LocalPbReadResult, LocalPbStep, LocalPbSourceFlavor } from "./local-pb-reader.js";
import { assertAntigravityReadActive, type AntigravityLocalCandidate, type AntigravityLocalDiagnostic, type AntigravityLocalOptions } from "./antigravity-local-sources.js";
import { withAntigravitySqliteSnapshot } from "./antigravity-sqlite-snapshot.js";
import type { DatabaseSync } from "node:sqlite";

function protobufBytesField(payload: Uint8Array, wanted: number): Uint8Array | undefined {
    let offset = 0;
    const readVarint = () => {
        let value = 0;
        for (let shift = 0; shift <= 49 && offset < payload.length; shift += 7) {
            const byte = payload[offset++];
            value += (byte & 127) * 2 ** shift;
            if (byte < 128 && Number.isSafeInteger(value)) return value;
        }
        throw new Error("Malformed Antigravity error protobuf");
    };
    while (offset < payload.length) {
        const key = readVarint();
        const field = Math.floor(key / 8);
        const wire = key % 8;
        if (wire === 0) { readVarint(); continue; }
        if (wire === 1 || wire === 5) { offset += wire === 1 ? 8 : 4; continue; }
        if (wire !== 2) throw new Error("Unsupported Antigravity error wire type");
        const length = readVarint();
        const end = offset + length;
        if (end > payload.length) throw new Error("Truncated Antigravity error protobuf");
        if (field === wanted) return payload.subarray(offset, end);
        offset = end;
    }
    return undefined;
}

function sqliteErrorMessage(payload: Uint8Array): string {
    const error = protobufBytesField(payload, 24);
    const details = error && protobufBytesField(error, 3);
    if (!details) return "";
    return [1, 2, 3].map(field => {
        const value = protobufBytesField(details, field);
        return value ? new TextDecoder("utf-8", { fatal: true }).decode(value) : "";
    }).filter(Boolean).join("\n\n");
}

export async function readAntigravitySqliteIndices(metadata: AntigravityLocalCandidate, options: AntigravityLocalOptions, connection?: DatabaseSync): Promise<number[] | undefined> {
    const source = metadata.files.find(file => file.kind === "db" && file.path.endsWith(".db"));
    if (!source) return undefined;
    const read = async (database: DatabaseSync): Promise<number[]> => {
        const maximum = options.maxRecords ?? 100_000;
        const indices: number[] = [];
        for (const row of database.prepare("SELECT idx FROM steps ORDER BY idx LIMIT ?").iterate(maximum + 1)) {
            assertAntigravityReadActive(options);
            if (indices.length >= maximum || !Number.isSafeInteger(row.idx) || Number(row.idx) < 0) throw new Error("ANTIGRAVITY_SQLITE_INDEX_BUDGET");
            indices.push(Number(row.idx));
            if (indices.length % 128 === 0) await new Promise<void>(resolve => setImmediate(resolve));
        }
        return indices;
    };
    return connection ? read(connection) : withAntigravitySqliteSnapshot(metadata, options, read);
}

export async function readAntigravitySqliteBody(metadata: AntigravityLocalCandidate, options: AntigravityLocalOptions, indices?: number[], connection?: DatabaseSync): Promise<{ result?: LocalPbReadResult; diagnostics: AntigravityLocalDiagnostic[] }> {
    const source = metadata.files.find(file => file.kind === "db" && file.path.endsWith(".db"));
    if (!source) return { diagnostics: [] };
    const diagnostics: AntigravityLocalDiagnostic[] = [];
    const diagnose = (code: string, message: string) => diagnostics.push({ code, message, sourcePath: source.path, conversationId: metadata.id });
    const decode = (pbReader as unknown as { decodeLocalPbStepPayload?: (payload: Uint8Array, index: number, flavor: LocalPbSourceFlavor) => LocalPbStep }).decodeLocalPbStepPayload;
    if (!decode) {
        diagnose("ANTIGRAVITY_SQLITE_DECODER_UNAVAILABLE", "step_format=0 requires the shared decodeLocalPbStepPayload export");
        return { diagnostics };
    }
    const read = async (database: DatabaseSync): Promise<{ result?: LocalPbReadResult; diagnostics: AntigravityLocalDiagnostic[] }> => {
        const columns = new Set(database.prepare("PRAGMA table_info(steps)").all().map(row => String(row.name)));
        if (!["idx", "step_payload", "step_format"].every(column => columns.has(column))) {
            diagnose("ANTIGRAVITY_SQLITE_SCHEMA_UNSUPPORTED", "Expected steps(idx,step_payload,step_format)");
            return { diagnostics };
        }
        const maximumRecords = options.maxRecords ?? 100_000;
        const maximumBytes = options.maxBytes ?? 128 * 1024 * 1024;
        if (!Number.isSafeInteger(maximumRecords) || maximumRecords < 1 || !Number.isSafeInteger(maximumBytes) || maximumBytes < 1) throw new Error("Invalid Antigravity SQLite read budget");
        const steps: LocalPbStep[] = [];
        let bytes = 0;
        const where = indices?.length ? ` WHERE idx IN (${indices.map(() => "?").join(",")})` : "";
        const size = database.prepare(`SELECT count(*) AS count,coalesce(sum(length(step_payload)),0) AS bytes FROM steps${where}`).get(...(indices || []));
        if (Number(size?.bytes) > maximumBytes) throw new Error("ANTIGRAVITY_SQLITE_BYTE_BUDGET");
        if (Number(size?.count) > maximumRecords) throw new Error("ANTIGRAVITY_SQLITE_RECORD_BUDGET");
        const rows = database.prepare(`SELECT idx,step_format,step_payload${columns.has("step_type") ? ",step_type" : ""} FROM steps${where} ORDER BY idx LIMIT ?`).iterate(...(indices || []), maximumRecords + 1);
        for (const row of rows) {
            assertAntigravityReadActive(options);
            if (steps.length >= maximumRecords) throw new Error("ANTIGRAVITY_SQLITE_RECORD_BUDGET");
            if (row.step_format !== 0 || !Number.isSafeInteger(row.idx) || Number(row.idx) < 0 || !(row.step_payload instanceof Uint8Array)) {
                diagnose("ANTIGRAVITY_SQLITE_STEP_UNSUPPORTED", `idx=${String(row.idx)} step_format=${String(row.step_format)} retained as unavailable`);
                continue;
            }
            bytes += row.step_payload.byteLength;
            if (bytes > maximumBytes) throw new Error("ANTIGRAVITY_SQLITE_BYTE_BUDGET");
            try {
                const step = decode(row.step_payload, Number(row.idx), "antigravity");
                if (row.step_type === 17) {
                    const message = sqliteErrorMessage(row.step_payload);
                    if (message) {
                        step.system = step.system || message;
                        step.diagnostics = step.diagnostics.filter(diagnostic => !(diagnostic.kind === "unknown_variant" && diagnostic.fieldNumber === 24));
                    }
                }
                steps.push(step);
            }
            catch (error) { diagnose("ANTIGRAVITY_SQLITE_STEP_DECODE_FAILED", `idx=${row.idx}: ${String(error)}`); }
            if (steps.length % 32 === 0) await new Promise<void>(resolve => setImmediate(resolve));
        }
        let trajectoryId: string | undefined;
        try {
            const identity = database.prepare("SELECT trajectory_id,cascade_id FROM trajectory_meta LIMIT 1").get();
            if (identity?.cascade_id && identity.cascade_id !== metadata.nativeId) diagnose("ANTIGRAVITY_SQLITE_IDENTITY_CONFLICT", `cascade_id=${String(identity.cascade_id)} differs from filename ${metadata.nativeId}`);
            trajectoryId = typeof identity?.trajectory_id === "string" ? identity.trajectory_id : undefined;
        } catch (error) { diagnose("ANTIGRAVITY_SQLITE_IDENTITY_UNAVAILABLE", String(error)); }
        const wireDiagnostics = steps.flatMap(step => step.diagnostics);
        for (const diagnostic of wireDiagnostics) if (diagnostic.kind === "partial" || diagnostic.kind === "unknown_variant") diagnose(`ANTIGRAVITY_SQLITE_${diagnostic.kind.toUpperCase()}`, diagnostic.message);
        return { result: { sourceFlavor: "antigravity", candidate: "active", label: "sqlite-step-format-0", encryptedBytes: 0, decryptedBytes: bytes,
            trajectory: { id: trajectoryId, steps }, diagnostics: wireDiagnostics, partial: diagnostics.length > 0 }, diagnostics };
    };
    return connection ? read(connection) : withAntigravitySqliteSnapshot(metadata, options, read);
}
