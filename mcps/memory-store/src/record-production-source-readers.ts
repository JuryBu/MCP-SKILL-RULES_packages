import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
    collectCodexSourceEvidence,
    type CodexSourceContentMessage,
    type CodexSourceEvidencePaths,
} from "./codex-client.js";
import {
    inspectClaudeCodeSourceEvidence,
    type ClaudeCodeSourceContentMessage,
    type ClaudeCodeSourceEvidenceFileSystem,
} from "./claude-code-client.js";
import {
    createAntigravityLsSourceEvidenceAdapter,
    fetchLiveAntigravityConversation,
    listLiveAntigravityConversationIds,
    readVscdbTitlesFresh,
    type AntigravityEvidenceCallResult,
    type AntigravityEvidenceFailure,
    type AntigravityLsEvidenceCallInput,
    type AntigravityLsEvidenceExactValue,
    type AntigravityLsEvidencePage,
    type AntigravityLsEvidenceReader,
    type AntigravityLsEvidenceRequest,
    type AntigravityLiveConversationFetch,
    type AntigravityLiveConversationListing,
} from "./ls-client.js";
import {
    buildExactFetchEvidence,
    buildFullSourceReadEvidence,
    buildRecordSourceSnapshot,
    buildSourceEnumerationEvidence,
    canonicalSerialize,
    classifySourceEvidence,
    type CanonicalSourceRevision,
    type ExactFetchEvidence,
    type FullSourceReadEvidence,
    type RecordSourceSnapshot,
    type SourceEvidenceClassification,
    type SourceEnumerationEvidence,
    type SourceEvidenceHost,
    type SourceEvidenceIssue,
} from "./source-evidence-contracts.js";
import {
    scanWindsurfSourceEvidence,
    windsurfStepsToConversationRounds,
    type WindsurfLsEndpoint,
    type WindsurfLsTransport,
    type WindsurfSourceEvidenceScanOptions,
} from "./windsurf-client.js";

export const PRODUCTION_SOURCE_CONTENT_SCHEMA_VERSION = "record-source-content/v1" as const;
export const PRODUCTION_SOURCE_FORMATTER_VERSION_V1 = "canonical-json-nfc-lf/v1" as const;
export const PRODUCTION_SOURCE_FORMATTER_VERSION = "canonical-json-nfc-lf/v2" as const;
export const SUPPORTED_PRODUCTION_SOURCE_FORMATTER_VERSIONS = [
    PRODUCTION_SOURCE_FORMATTER_VERSION_V1,
    PRODUCTION_SOURCE_FORMATTER_VERSION,
] as const;
export const DEFAULT_PRODUCTION_SOURCE_MAX_CONTENT_BYTES = 16 * 1024 * 1024;
export const MAX_PRODUCTION_SOURCE_MAX_CONTENT_BYTES = 256 * 1024 * 1024;
export const MAX_PRODUCTION_SOURCE_ATTACHMENT_DECODE_BYTES = 4 * 1024 * 1024;

export type ProductionSourceFormatterVersion = typeof SUPPORTED_PRODUCTION_SOURCE_FORMATTER_VERSIONS[number];

export function isSupportedProductionSourceFormatterVersion(value: unknown): value is ProductionSourceFormatterVersion {
    return value === PRODUCTION_SOURCE_FORMATTER_VERSION_V1 || value === PRODUCTION_SOURCE_FORMATTER_VERSION;
}

export interface ProductionSourceReaderWorkspace {
    workspaceId: string;
    canonicalPath: string | null;
}

export interface CodexProductionSourceReadRequest {
    host: "codex";
    conversationId: string;
    workspace: ProductionSourceReaderWorkspace;
    paths?: CodexSourceEvidencePaths;
    enumerationLimit?: number;
    maxContentBytes?: number;
}

export interface ClaudeCodeProductionSourceReadRequest {
    host: "claude-code";
    conversationId: string;
    projectsRoot?: string;
    workspaceId?: string;
    workspacePath?: string | null;
    limit?: number;
    readChunkBytes?: number;
    maxLineBytes?: number;
    fileSystem?: Partial<ClaudeCodeSourceEvidenceFileSystem>;
    maxContentBytes?: number;
}

export interface WindsurfProductionSourceReadRequest {
    host: "windsurf";
    conversationId: string;
    transport?: WindsurfLsTransport;
    endpoint?: Pick<WindsurfLsEndpoint, "pid" | "port">;
    workspaceId?: string;
    workspacePath?: string | null;
    sourceAuthority?: string;
    authoritativeRoot?: string;
    sourceCanonicalPath?: string | null;
    maxPages?: number;
    requestClass?: WindsurfSourceEvidenceScanOptions["requestClass"];
    maxContentBytes?: number;
}

export interface AntigravityProductionSourceReadRequest {
    host: "antigravity";
    conversationId: string;
    workspaceId: string;
    workspacePath: string | null;
    source: AntigravityLsEvidenceRequest["source"];
    pageLimit?: number;
    maxContentBytes?: number;
}

export type ProductionSourceReadRequest =
    | CodexProductionSourceReadRequest
    | ClaudeCodeProductionSourceReadRequest
    | WindsurfProductionSourceReadRequest
    | AntigravityProductionSourceReadRequest;

export interface ProductionSourceCanonicalMessage {
    order: number;
    role: "user" | "assistant";
    content: string;
    attachments?: ProductionSourceCanonicalAttachment[];
}

export interface ProductionSourceCanonicalAttachment {
    kind: "image" | "file";
    source: string;
    name?: string;
    mimeType?: string;
    reference?: string;
    sizeBytes?: number;
    sha256?: string;
    exists?: boolean;
    warning?: string;
}

export interface ProductionSourceCanonicalDocument {
    schemaVersion: typeof PRODUCTION_SOURCE_CONTENT_SCHEMA_VERSION;
    formatterVersion: ProductionSourceFormatterVersion;
    source: {
        host: SourceEvidenceHost;
        conversationId: string;
    };
    messages: ProductionSourceCanonicalMessage[];
}

export interface ProductionSourceContentPayload {
    schemaVersion: typeof PRODUCTION_SOURCE_CONTENT_SCHEMA_VERSION;
    formatterVersion: ProductionSourceFormatterVersion;
    mediaType: "application/vnd.memory-store.record-source+json";
    encoding: "utf-8";
    bytes: Uint8Array;
    byteLength: number;
    contentHash: string;
}

export interface ProductionSourceAuthorityContradiction {
    kind: "same-revision-different-bytes";
    previousContentHash: string;
    observedContentHash: string;
}

export interface ProductionSourceAuthorityVerification {
    identityHash: string;
    revisionHash: string;
    identityStable: boolean;
    revisionStable: boolean;
    cacheBypassed: boolean;
    enumerationEvidenceHash: string;
    exactFetchEvidenceHash: string;
    fullReadEvidenceHash: string | null;
    contradiction?: ProductionSourceAuthorityContradiction;
}

export interface ProductionSourceFullReadComplete {
    status: "complete";
    evidence: FullSourceReadEvidence;
    payload: ProductionSourceContentPayload;
    sourceSnapshot: RecordSourceSnapshot;
    authority: ProductionSourceAuthorityVerification;
    issues: [];
}

export interface ProductionSourceFullReadUnresolved {
    status: "unresolved";
    evidence: FullSourceReadEvidence | null;
    payload: null;
    sourceSnapshot: null;
    authority: ProductionSourceAuthorityVerification;
    issues: SourceEvidenceIssue[];
}

export type ProductionSourceFullReadResult = ProductionSourceFullReadComplete | ProductionSourceFullReadUnresolved;

export interface ProductionSourceReadResult {
    host: SourceEvidenceHost;
    scanId: string;
    enumeration: SourceEnumerationEvidence;
    exactFetch: ExactFetchEvidence;
    fullSourceRead: ProductionSourceFullReadResult;
    sourceSnapshot: RecordSourceSnapshot | null;
    classification: SourceEvidenceClassification;
    qualifiedAbsence: SourceEvidenceClassification["lostObservation"] | null;
}

export interface ProductionSourceReader {
    enumerate(request: ProductionSourceReadRequest): Promise<SourceEnumerationEvidence>;
    fetchExact(request: ProductionSourceReadRequest): Promise<ExactFetchEvidence>;
    readFull(request: ProductionSourceReadRequest): Promise<ProductionSourceFullReadResult>;
    scan(request: ProductionSourceReadRequest): Promise<ProductionSourceReadResult>;
}

export interface AntigravityProductionSourceIo {
    listLive(): Promise<AntigravityLiveConversationListing>;
    fetchLive(conversationId: string): Promise<AntigravityLiveConversationFetch | null>;
    listPb(pbRoot: string): Promise<ProductionStorageListing>;
    fetchPb(pbRoot: string, conversationId: string): Promise<boolean>;
    listVscdb(vscdbPath: string): Promise<ProductionStorageListing>;
    fetchVscdb(vscdbPath: string, conversationId: string): Promise<boolean>;
}

export interface ProductionStorageListing {
    ids: string[];
    revision: string;
}

export interface ProductionSourceReaderOptions {
    now?: () => Date;
    scanIdFactory?: (host: SourceEvidenceHost) => string;
    antigravityReader?: AntigravityLsEvidenceReader;
    antigravityIo?: Partial<AntigravityProductionSourceIo>;
    maxContentBytes?: number;
}

interface ProductionSourceMessage {
    role: "user" | "assistant";
    text: string;
    attachments?: readonly ProductionSourceAttachmentInput[];
    mediaAttachments?: readonly string[];
}

interface ProductionSourceAttachmentInput {
    kind: "image" | "file";
    source: string;
    name?: string;
    mimeType?: string;
    originalPath?: string;
    dataUrl?: string;
    base64Data?: string;
    sizeBytes?: number;
    sha256?: string;
    exists?: boolean;
    warning?: string;
}

interface ProductionAntigravityScan {
    scanId: string;
    sequence: number;
    startedAt: string;
    completedAt: string;
}

function sourceHash(value: unknown): string {
    return `sha256:${createHash("sha256").update(canonicalSerialize(value), "utf8").digest("hex")}`;
}

function sourceError(error: unknown): AntigravityEvidenceFailure {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") return { code: "missing", message: "生产来源文件不存在" };
    if (code === "EACCES" || code === "EPERM") return { code: "permission", message: "生产来源文件无读取权限" };
    return { code: "io", message: error instanceof Error ? error.message : String(error) };
}

function evidenceError<T>(error: unknown): AntigravityEvidenceCallResult<T> {
    return { kind: "error", failure: sourceError(error), cache: "bypassed" };
}

function sourcePage(
    ids: string[],
    eventWatermark: string | null,
): AntigravityLsEvidencePage & AntigravityLsEvidenceExactValue {
    return {
        ids: [...new Set(ids)].sort((left, right) => left.localeCompare(right, "en")),
        nextCursor: null,
        eventWatermark,
    };
}

function isSafeConversationFilename(conversationId: string): boolean {
    return /^[0-9a-zA-Z-]+$/u.test(conversationId);
}

function pbFilePath(pbRoot: string, conversationId: string): string {
    if (!isSafeConversationFilename(conversationId)) throw new Error("Antigravity conversationId 不能映射到安全的 .pb 文件名");
    const root = path.resolve(pbRoot);
    const filePath = path.resolve(root, `${conversationId}.pb`);
    if (path.dirname(filePath) !== root) throw new Error("Antigravity .pb 路径逃逸");
    return filePath;
}

async function defaultListPb(pbRoot: string): Promise<ProductionStorageListing> {
    const root = path.resolve(pbRoot);
    const entries = await fs.readdir(root, { withFileTypes: true });
    const records = await Promise.all(entries
        .filter(entry => entry.isFile() && entry.name.endsWith(".pb"))
        .map(async entry => {
            const filePath = path.join(root, entry.name);
            const stat = await fs.stat(filePath);
            return {
                id: entry.name.slice(0, -3),
                size: stat.size,
                mtimeMs: Math.trunc(stat.mtimeMs),
            };
        }));
    records.sort((left, right) => left.id.localeCompare(right.id, "en"));
    return {
        ids: records.map(record => record.id),
        revision: sourceHash({ root, records }),
    };
}

async function defaultFetchPb(pbRoot: string, conversationId: string): Promise<boolean> {
    try {
        const stat = await fs.stat(pbFilePath(pbRoot, conversationId));
        return stat.isFile();
    } catch (error) {
        if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return false;
        throw error;
    }
}

function expectedVscdbPath(): string {
    return path.resolve(
        process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
        "Antigravity",
        "User",
        "globalStorage",
        "state.vscdb",
    );
}

async function defaultListVscdb(vscdbPath: string): Promise<ProductionStorageListing> {
    const resolved = path.resolve(vscdbPath);
    if (resolved !== expectedVscdbPath()) {
        throw new Error("vscdb 路径与 Antigravity 生产 state.vscdb 不一致，拒绝混用来源");
    }
    const stat = await fs.stat(resolved);
    const titles = readVscdbTitlesFresh();
    const records = [...titles.entries()]
        .map(([id, value]) => ({ id, summary: value.summary, steps: value.steps }))
        .sort((left, right) => left.id.localeCompare(right.id, "en"));
    return {
        ids: records.map(record => record.id),
        revision: sourceHash({ resolved, size: stat.size, mtimeMs: Math.trunc(stat.mtimeMs), records }),
    };
}

async function defaultFetchVscdb(vscdbPath: string, conversationId: string): Promise<boolean> {
    return (await defaultListVscdb(vscdbPath)).ids.includes(conversationId);
}

const DEFAULT_ANTIGRAVITY_IO: AntigravityProductionSourceIo = {
    listLive: listLiveAntigravityConversationIds,
    fetchLive: fetchLiveAntigravityConversation,
    listPb: defaultListPb,
    fetchPb: defaultFetchPb,
    listVscdb: defaultListVscdb,
    fetchVscdb: defaultFetchVscdb,
};

export function createProductionAntigravityLsEvidenceReader(
    source: AntigravityLsEvidenceRequest["source"],
    overrides: Partial<AntigravityProductionSourceIo> = {},
): AntigravityLsEvidenceReader {
    const io = { ...DEFAULT_ANTIGRAVITY_IO, ...overrides };
    const listLsPage = async (input: AntigravityLsEvidenceCallInput): Promise<AntigravityEvidenceCallResult<AntigravityLsEvidencePage>> => {
        try {
            if (input.cursor !== null) {
                return evidenceError(new Error("Antigravity 生产 LS 列表不支持继续页，但未声明 truncated"));
            }
            const listing = await io.listLive();
            const eventWatermark = listing.eventWatermarks[input.cascadeId] || null;
            const revision = sourceHash({ endpointIds: listing.endpointIds, ids: listing.ids, eventWatermarks: listing.eventWatermarks });
            return {
                kind: "ok",
                value: sourcePage(listing.ids, eventWatermark),
                revision,
                contentCursor: eventWatermark,
                cache: "bypassed",
            };
        } catch (error) {
            return evidenceError(error);
        }
    };
    const listStorage = (
        label: "pb" | "vscdb",
        list: (sourcePath: string) => Promise<ProductionStorageListing>,
        sourcePath: (input: AntigravityLsEvidenceCallInput) => string,
    ) => async (input: AntigravityLsEvidenceCallInput): Promise<AntigravityEvidenceCallResult<AntigravityLsEvidencePage>> => {
        try {
            const listing = await list(sourcePath(input));
            return {
                kind: "ok",
                value: sourcePage(listing.ids, null),
                revision: listing.revision,
                contentCursor: null,
                cache: "bypassed",
            };
        } catch (error) {
            return evidenceError(new Error(`${label} enumeration failed: ${error instanceof Error ? error.message : String(error)}`));
        }
    };
    const fetchLs = async (input: AntigravityLsEvidenceCallInput): Promise<AntigravityEvidenceCallResult<AntigravityLsEvidenceExactValue>> => {
        try {
            const listing = await io.listLive();
            const expectedWatermark = listing.eventWatermarks[input.cascadeId] || null;
            const revision = sourceHash({ endpointIds: listing.endpointIds, ids: listing.ids, eventWatermarks: listing.eventWatermarks });
            if (!listing.ids.includes(input.cascadeId)) {
                return { kind: "not_found", revision, contentCursor: expectedWatermark, cache: "bypassed" };
            }
            const fetched = await io.fetchLive(input.cascadeId);
            if (!fetched) return { kind: "not_found", revision, contentCursor: expectedWatermark, cache: "bypassed" };
            if (fetched.eventWatermark !== expectedWatermark) {
                return evidenceError(new Error("Antigravity LS exact fetch 的 lastModifiedTime 与枚举不一致"));
            }
            return {
                kind: "ok",
                value: { eventWatermark: fetched.eventWatermark },
                revision,
                contentCursor: expectedWatermark,
                cache: "bypassed",
            };
        } catch (error) {
            return evidenceError(error);
        }
    };
    const fetchStorage = (
        list: (sourcePath: string) => Promise<ProductionStorageListing>,
        fetch: (sourcePath: string, conversationId: string) => Promise<boolean>,
        sourcePath: (input: AntigravityLsEvidenceCallInput) => string,
    ) => async (input: AntigravityLsEvidenceCallInput): Promise<AntigravityEvidenceCallResult<AntigravityLsEvidenceExactValue>> => {
        try {
            const root = sourcePath(input);
            const listing = await list(root);
            if (!listing.ids.includes(input.cascadeId)) {
                return { kind: "not_found", revision: listing.revision, contentCursor: null, cache: "bypassed" };
            }
            if (!(await fetch(root, input.cascadeId))) {
                return evidenceError(new Error("存储枚举命中后精确读取失败"));
            }
            return {
                kind: "ok",
                value: {},
                revision: listing.revision,
                contentCursor: null,
                cache: "bypassed",
            };
        } catch (error) {
            return evidenceError(error);
        }
    };
    const reader: AntigravityLsEvidenceReader = {
        listLsPage,
        listPb: listStorage("pb", io.listPb, () => source.pbRoot),
        listVscdb: listStorage("vscdb", io.listVscdb, () => source.vscdbPath),
        fetchLs,
        fetchPb: fetchStorage(io.listPb, io.fetchPb, () => source.pbRoot),
        fetchVscdb: fetchStorage(io.listVscdb, io.fetchVscdb, () => source.vscdbPath),
        readFullLs: async (input) => {
            try {
                const listing = await io.listLive();
                const expectedWatermark = listing.eventWatermarks[input.cascadeId] || null;
                const revision = sourceHash({ endpointIds: listing.endpointIds, ids: listing.ids, eventWatermarks: listing.eventWatermarks });
                if (!listing.ids.includes(input.cascadeId)) {
                    return { kind: "not_found", revision, contentCursor: expectedWatermark, cache: "bypassed" };
                }
                const fetched = await io.fetchLive(input.cascadeId);
                if (!fetched) return { kind: "not_found", revision, contentCursor: expectedWatermark, cache: "bypassed" };
                if (fetched.eventWatermark !== expectedWatermark) {
                    return evidenceError(new Error("Antigravity LS 完整读取的 lastModifiedTime 与枚举不一致"));
                }
                const content = canonicalSerialize(fetched.trajectory);
                const steps = Array.isArray(fetched.trajectory.steps) ? fetched.trajectory.steps : [];
                return {
                    kind: "ok",
                    value: {
                        content,
                        roundRange: { start: 1, end: Math.max(1, steps.length) },
                    },
                    revision,
                    contentCursor: expectedWatermark,
                    cache: "bypassed",
                };
            } catch (error) {
                return evidenceError(error);
            }
        },
    };
    return reader;
}

function productionSourceIssue(code: SourceEvidenceIssue["code"], message: string): SourceEvidenceIssue {
    return { code, message };
}

function uniqueProductionSourceIssues(issues: SourceEvidenceIssue[]): SourceEvidenceIssue[] {
    const seen = new Set<string>();
    return issues.filter((issue) => {
        const key = `${issue.code}\u0000${issue.message}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function sameCanonicalValue(left: unknown, right: unknown): boolean {
    return canonicalSerialize(left) === canonicalSerialize(right);
}

function sameAuthorityRevision(left: CanonicalSourceRevision, right: CanonicalSourceRevision): boolean {
    return left.revision === right.revision && left.sequence === right.sequence;
}

function validMaxContentBytes(value: number | undefined, fallback: number): number {
    const resolved = value ?? fallback;
    if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > MAX_PRODUCTION_SOURCE_MAX_CONTENT_BYTES) {
        throw new Error(`production source reader maxContentBytes 必须在 1 到 ${MAX_PRODUCTION_SOURCE_MAX_CONTENT_BYTES} 之间`);
    }
    return resolved;
}

function normalizeProductionSourceText(value: string): string {
    return value.replace(/\r\n?/gu, "\n").normalize("NFC");
}

function normalizedProductionSourceField(value: unknown, maxLength = 512): string | undefined {
    if (typeof value !== "string") return undefined;
    const normalized = normalizeProductionSourceText(value.slice(0, maxLength));
    return normalized || undefined;
}

function productionSourceSha256(value: string | Uint8Array): string {
    return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function normalizedProductionSourceHash(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;
    const match = /^(?:sha256:)?([a-f0-9]{64})$/iu.exec(value.trim());
    return match ? `sha256:${match[1].toLowerCase()}` : undefined;
}

const KNOWN_PRODUCTION_SOURCE_ATTACHMENT_SOURCES = new Set([
    "claude-code-data-url",
    "claude-code-local-file",
    "codex-data-url",
    "codex-local-image",
    "codex-local-file",
    "files-mentioned",
    "windsurf-data-url",
    "windsurf-media-attachment",
    "antigravity-raw-attachment",
]);

const KNOWN_PRODUCTION_SOURCE_ATTACHMENT_WARNINGS = new Set([
    "attachment descriptor could not be parsed",
    "attachment descriptor could not be fully resolved",
    "attachment data URL could not be decoded",
    "attachment data URL is not a supported base64 descriptor",
    "attachment base64 descriptor is invalid",
    "attachment base64 exceeds safe decode limit",
    "attachment base64 decoded length verification failed",
    "attachment has no stable data URL or path reference",
]);

const MAX_PRODUCTION_SOURCE_ATTACHMENT_BASE64_CHARACTERS = Math.ceil((MAX_PRODUCTION_SOURCE_ATTACHMENT_DECODE_BYTES * 4) / 3) + 4;
const MAX_PRODUCTION_SOURCE_ATTACHMENT_DATA_URL_HEADER_CHARACTERS = 512;

function canonicalProductionSourceAttachmentSource(value: unknown): string {
    const source = normalizedProductionSourceField(value, 128)?.toLowerCase();
    return source && KNOWN_PRODUCTION_SOURCE_ATTACHMENT_SOURCES.has(source)
        ? source
        : "attachment-metadata-redacted";
}

function canonicalProductionSourceAttachmentName(value: unknown): string | undefined {
    const name = normalizedProductionSourceField(value, 256);
    if (!name) return undefined;
    const extension = /\.([a-z0-9]{1,16})$/iu.exec(name)?.[1]?.toLowerCase();
    return extension ? `attachment.${extension}` : "attachment";
}

function canonicalProductionSourceAttachmentMimeType(value: unknown): string | undefined {
    const mimeType = normalizedProductionSourceField(value, 128)?.toLowerCase();
    return mimeType && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(mimeType) ? mimeType : undefined;
}

function canonicalProductionSourceAttachmentWarning(value: unknown): string | undefined {
    const warning = normalizedProductionSourceField(value, 512);
    if (!warning) return undefined;
    return KNOWN_PRODUCTION_SOURCE_ATTACHMENT_WARNINGS.has(warning)
        ? warning
        : "attachment metadata warning redacted";
}

function attachmentPolicyReference(reason: string): string {
    return `attachment-policy:${productionSourceSha256(reason)}`;
}

function canonicalProductionSourcePath(value: string): string {
    let windowsPath = value;
    if (windowsPath.startsWith("\\\\?\\") || windowsPath.startsWith("//?/")) {
        windowsPath = windowsPath.slice(4);
        if (/^unc[\\/]/iu.test(windowsPath)) windowsPath = `\\\\${windowsPath.slice(4)}`;
    }
    if (!/^[a-z]:[\\/]/iu.test(windowsPath) && !/^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/u.test(windowsPath)) {
        return value;
    }
    const normalized = path.win32.normalize(windowsPath).replace(/\//gu, "\\").toLowerCase();
    const root = path.win32.parse(normalized).root.toLowerCase();
    return normalized.length > root.length ? normalized.replace(/\\+$/u, "") : normalized;
}

function isProductionSourceBase64Whitespace(codePoint: number): boolean {
    return codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0c || codePoint === 0x0d || codePoint === 0x20;
}

function isProductionSourceBase64Character(codePoint: number): boolean {
    return (codePoint >= 0x41 && codePoint <= 0x5a)
        || (codePoint >= 0x61 && codePoint <= 0x7a)
        || (codePoint >= 0x30 && codePoint <= 0x39)
        || codePoint === 0x2b
        || codePoint === 0x2f;
}

function inspectProductionSourceBase64(value: string, start = 0): {
    status: "valid" | "invalid" | "too-large";
    byteLength?: number;
} {
    if (value.length - start > MAX_PRODUCTION_SOURCE_ATTACHMENT_BASE64_CHARACTERS) return { status: "too-large" };
    let characterCount = 0;
    let paddingCount = 0;
    for (let index = start; index < value.length; index += 1) {
        const codePoint = value.charCodeAt(index);
        if (isProductionSourceBase64Whitespace(codePoint)) continue;
        if (isProductionSourceBase64Character(codePoint)) {
            if (paddingCount > 0) return { status: "invalid" };
            characterCount += 1;
            continue;
        }
        if (codePoint !== 0x3d || paddingCount >= 2) return { status: "invalid" };
        paddingCount += 1;
        characterCount += 1;
    }
    if (characterCount === 0 || characterCount % 4 !== 0) return { status: "invalid" };
    const byteLength = (characterCount / 4) * 3 - paddingCount;
    if (byteLength < 0 || byteLength > MAX_PRODUCTION_SOURCE_ATTACHMENT_DECODE_BYTES) return { status: "too-large" };
    return { status: "valid", byteLength };
}

function productionSourceDataUrlBase64Start(value: string): { base64Start: number; mimeType?: string } | null {
    if (!value.startsWith("data:") || value.length > MAX_PRODUCTION_SOURCE_ATTACHMENT_BASE64_CHARACTERS + MAX_PRODUCTION_SOURCE_ATTACHMENT_DATA_URL_HEADER_CHARACTERS) {
        return null;
    }
    const delimiter = value.indexOf(",", 5);
    if (delimiter < 0 || delimiter - 5 > MAX_PRODUCTION_SOURCE_ATTACHMENT_DATA_URL_HEADER_CHARACTERS) return null;
    const header = value.slice(5, delimiter);
    const match = /^([^;,]+);base64$/u.exec(header);
    if (!match) return null;
    return { base64Start: delimiter + 1, mimeType: canonicalProductionSourceAttachmentMimeType(match[1]) };
}

function canonicalProductionSourceAttachment(input: ProductionSourceAttachmentInput): ProductionSourceCanonicalAttachment {
    const attachment: ProductionSourceCanonicalAttachment = {
        kind: input.kind === "image" ? "image" : "file",
        source: canonicalProductionSourceAttachmentSource(input.source),
    };
    const name = canonicalProductionSourceAttachmentName(input.name);
    const mimeType = canonicalProductionSourceAttachmentMimeType(input.mimeType);
    const warning = canonicalProductionSourceAttachmentWarning(input.warning);
    const originalPath = normalizedProductionSourceField(input.originalPath, 4096);
    const declaredSize = typeof input.sizeBytes === "number" && Number.isSafeInteger(input.sizeBytes) && input.sizeBytes >= 0
        ? input.sizeBytes
        : undefined;
    if (name) attachment.name = name;
    if (mimeType) attachment.mimeType = mimeType;
    if (declaredSize !== undefined) attachment.sizeBytes = declaredSize;
    if (typeof input.exists === "boolean") attachment.exists = input.exists;
    const dataUrl = typeof input.dataUrl === "string" ? input.dataUrl : undefined;
    const base64Data = typeof input.base64Data === "string" ? input.base64Data : undefined;
    if (dataUrl || base64Data !== undefined) {
        if (dataUrl && dataUrl.length > MAX_PRODUCTION_SOURCE_ATTACHMENT_BASE64_CHARACTERS + MAX_PRODUCTION_SOURCE_ATTACHMENT_DATA_URL_HEADER_CHARACTERS) {
            attachment.reference = attachmentPolicyReference("base64-decode-limit");
            attachment.warning = "attachment base64 exceeds safe decode limit";
            return attachment;
        }
        const dataUrlDescriptor = dataUrl ? productionSourceDataUrlBase64Start(dataUrl) : null;
        const encoded = dataUrl || base64Data || "";
        const base64Start = dataUrlDescriptor?.base64Start ?? 0;
        if (dataUrl && !dataUrlDescriptor) {
            attachment.reference = attachmentPolicyReference("unsupported-data-url");
            attachment.warning = "attachment data URL is not a supported base64 descriptor";
            return attachment;
        }
        const inspection = inspectProductionSourceBase64(encoded, base64Start);
        if (inspection.status === "too-large") {
            attachment.reference = attachmentPolicyReference("base64-decode-limit");
            attachment.warning = "attachment base64 exceeds safe decode limit";
            return attachment;
        }
        if (inspection.status === "invalid" || inspection.byteLength === undefined) {
            attachment.reference = attachmentPolicyReference("invalid-base64");
            attachment.warning = "attachment base64 descriptor is invalid";
            return attachment;
        }
        try {
            const bytes = Buffer.from(encoded.slice(base64Start), "base64");
            if (bytes.byteLength !== inspection.byteLength) {
                attachment.reference = attachmentPolicyReference("base64-length-mismatch");
                attachment.warning = "attachment base64 decoded length verification failed";
                return attachment;
            }
            attachment.sha256 = productionSourceSha256(bytes);
            if (attachment.sizeBytes === undefined) attachment.sizeBytes = bytes.byteLength;
            if (!attachment.mimeType && dataUrlDescriptor?.mimeType) attachment.mimeType = dataUrlDescriptor.mimeType;
            if (warning) attachment.warning = warning;
        } catch {
            attachment.reference = attachmentPolicyReference("base64-decode-failed");
            attachment.warning = "attachment data URL could not be decoded";
        }
        return attachment;
    }
    const sha256 = normalizedProductionSourceHash(input.sha256);
    if (sha256) attachment.sha256 = sha256;
    if (originalPath) {
        attachment.reference = `path-sha256:${createHash("sha256").update(canonicalProductionSourcePath(originalPath), "utf8").digest("hex")}`;
    } else {
        attachment.reference = `attachment-sha256:${createHash("sha256").update(canonicalSerialize({
            kind: attachment.kind,
            source: attachment.source,
            name: attachment.name || null,
            mimeType: attachment.mimeType || null,
            sizeBytes: attachment.sizeBytes ?? null,
            sha256: attachment.sha256 || null,
        }), "utf8").digest("hex")}`;
        attachment.warning = warning || "attachment has no stable data URL or path reference";
    }
    if (warning && !attachment.warning) attachment.warning = warning;
    return attachment;
}

function rawProductionSourceAttachments(value: unknown, fallbackSource: string): ProductionSourceAttachmentInput[] {
    if (!Array.isArray(value)) return [];
    const attachments: ProductionSourceAttachmentInput[] = [];
    for (const rawAttachment of value) {
        if (typeof rawAttachment === "string") {
            attachments.push({
                kind: "image",
                source: fallbackSource,
                ...(rawAttachment.startsWith("data:") ? { dataUrl: rawAttachment } : { originalPath: rawAttachment }),
            });
            continue;
        }
        if (!rawAttachment || typeof rawAttachment !== "object" || Array.isArray(rawAttachment)) {
            attachments.push({ kind: "file", source: fallbackSource, warning: "attachment descriptor could not be parsed" });
            continue;
        }
        const fields = rawAttachment as Record<string, unknown>;
        const base64Data = typeof fields.base64Data === "string"
            ? fields.base64Data
            : typeof fields.base64 === "string"
                ? fields.base64
                : undefined;
        const mimeType = typeof fields.mimeType === "string"
            ? fields.mimeType
            : typeof fields.mime_type === "string"
                ? fields.mime_type
                : undefined;
        const dataUrl = typeof fields.dataUrl === "string"
            ? fields.dataUrl
            : typeof fields.url === "string" && fields.url.startsWith("data:")
                ? fields.url
                : undefined;
        const originalPath = typeof fields.originalPath === "string"
            ? fields.originalPath
            : typeof fields.path === "string"
                ? fields.path
                : typeof fields.uri === "string"
                    ? fields.uri
                    : undefined;
        attachments.push({
            kind: fields.kind === "image" ? "image" : "file",
            source: typeof fields.source === "string" ? fields.source : fallbackSource,
            name: typeof fields.name === "string" ? fields.name : undefined,
            mimeType,
            dataUrl,
            base64Data: dataUrl ? undefined : base64Data,
            originalPath,
            sizeBytes: typeof fields.sizeBytes === "number" ? fields.sizeBytes : undefined,
            sha256: typeof fields.sha256 === "string" ? fields.sha256 : undefined,
            exists: typeof fields.exists === "boolean" ? fields.exists : undefined,
            warning: typeof fields.warning === "string" ? fields.warning : (!dataUrl && !originalPath ? "attachment descriptor could not be fully resolved" : undefined),
        });
    }
    return attachments;
}

function canonicalProductionSourceAttachments(message: ProductionSourceMessage): ProductionSourceCanonicalAttachment[] {
    const attachments = [
        ...(message.attachments || []),
        ...(message.mediaAttachments || []).map(media => ({
            kind: "image" as const,
            source: "windsurf-media-attachment",
            ...(media.startsWith("data:") ? { dataUrl: media } : { originalPath: media }),
        })),
    ];
    return attachments.map(canonicalProductionSourceAttachment);
}

function canonicalProductionSourceMessages(messages: ProductionSourceMessage[]): ProductionSourceCanonicalMessage[] {
    const canonical: ProductionSourceCanonicalMessage[] = [];
    for (const message of messages) {
        const content = normalizeProductionSourceText(message.text);
        const attachments = canonicalProductionSourceAttachments(message);
        canonical.push({
            order: canonical.length + 1,
            role: message.role,
            content,
            ...(attachments.length > 0 ? { attachments } : {}),
        });
    }
    return canonical;
}

function jsonStringUtf8ByteLength(value: string): number {
    let byteLength = 2;
    for (let index = 0; index < value.length; index += 1) {
        const codeUnit = value.charCodeAt(index);
        if (codeUnit === 0x22 || codeUnit === 0x5c || codeUnit === 0x08 || codeUnit === 0x09
            || codeUnit === 0x0a || codeUnit === 0x0c || codeUnit === 0x0d) {
            byteLength += 2;
            continue;
        }
        if (codeUnit <= 0x1f) {
            byteLength += 6;
            continue;
        }
        if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
            const next = value.charCodeAt(index + 1);
            if (next >= 0xdc00 && next <= 0xdfff) {
                byteLength += 4;
                index += 1;
            } else {
                byteLength += 6;
            }
            continue;
        }
        if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
            byteLength += 6;
        } else if (codeUnit <= 0x7f) {
            byteLength += 1;
        } else if (codeUnit <= 0x7ff) {
            byteLength += 2;
        } else {
            byteLength += 3;
        }
    }
    return byteLength;
}

function canonicalDocumentByteLength(document: ProductionSourceCanonicalDocument, maxContentBytes: number): number | null {
    if (document.messages.length * 32 > maxContentBytes) return null;
    const emptyDocument: ProductionSourceCanonicalDocument = {
        ...document,
        messages: document.messages.map(message => ({ ...message, content: "" })),
    };
    let byteLength = Buffer.byteLength(canonicalSerialize(emptyDocument), "utf8");
    for (const message of document.messages) {
        byteLength += jsonStringUtf8ByteLength(message.content) - 2;
        if (byteLength > maxContentBytes) return null;
    }
    return byteLength;
}

function buildProductionSourcePayload(
    host: SourceEvidenceHost,
    conversationId: string,
    messages: ProductionSourceMessage[],
    maxContentBytes: number,
): { payload: ProductionSourceContentPayload | null; issue: SourceEvidenceIssue | null } {
    const canonicalMessages = canonicalProductionSourceMessages(messages);
    const meaningfulBytes = canonicalMessages.reduce((total, message) => total + Buffer.byteLength(message.content, "utf8"), 0);
    if (meaningfulBytes > maxContentBytes) {
        return {
            payload: null,
            issue: productionSourceIssue("limit_reached", `canonical source content exceeds maxContentBytes=${maxContentBytes}`),
        };
    }
    const document: ProductionSourceCanonicalDocument = {
        schemaVersion: PRODUCTION_SOURCE_CONTENT_SCHEMA_VERSION,
        formatterVersion: PRODUCTION_SOURCE_FORMATTER_VERSION,
        source: { host, conversationId },
        messages: canonicalMessages,
    };
    const expectedByteLength = canonicalDocumentByteLength(document, maxContentBytes);
    if (expectedByteLength === null) {
        return {
            payload: null,
            issue: productionSourceIssue("limit_reached", `canonical source payload exceeds maxContentBytes=${maxContentBytes}`),
        };
    }
    const bytes = Buffer.from(canonicalSerialize(document), "utf8");
    if (bytes.byteLength !== expectedByteLength || bytes.byteLength > maxContentBytes) {
        return {
            payload: null,
            issue: productionSourceIssue("parse_error", "canonical source payload length verification failed"),
        };
    }
    return {
        payload: {
            schemaVersion: PRODUCTION_SOURCE_CONTENT_SCHEMA_VERSION,
            formatterVersion: PRODUCTION_SOURCE_FORMATTER_VERSION,
            mediaType: "application/vnd.memory-store.record-source+json",
            encoding: "utf-8",
            bytes: Uint8Array.from(bytes),
            byteLength: bytes.byteLength,
            contentHash: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
        },
        issue: null,
    };
}

function messagesFromWindsurfRounds(
    rounds: ReturnType<typeof windsurfStepsToConversationRounds>,
): ProductionSourceMessage[] {
    const messages: ProductionSourceMessage[] = [];
    for (const round of rounds) {
        messages.push({
            role: "user",
            text: round.userMessage,
            attachments: round.attachments,
            mediaAttachments: round.mediaAttachments,
        });
        for (const response of round.aiResponses) {
            if (!response.response && response.toolCalls.length > 0) continue;
            messages.push({ role: "assistant", text: response.response });
        }
    }
    return messages;
}

function directAntigravityMessages(value: unknown): ProductionSourceMessage[] {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const fields = value as Record<string, unknown>;
    const rawMessages = Array.isArray(fields.messages) ? fields.messages : [];
    const messageValues = rawMessages.length > 0
        ? rawMessages
        : Array.isArray(fields.steps)
            ? fields.steps
            : [];
    const messages: ProductionSourceMessage[] = [];
    for (const rawMessage of messageValues) {
        if (!rawMessage || typeof rawMessage !== "object" || Array.isArray(rawMessage)) continue;
        const message = rawMessage as Record<string, unknown>;
        const role = message.role === "user" || message.role === "assistant" ? message.role : null;
        const text = typeof message.text === "string"
            ? message.text
            : typeof message.content === "string"
                ? message.content
                : null;
        const attachments = rawProductionSourceAttachments(message.attachments, "antigravity-raw-attachment");
        const mediaAttachments = Array.isArray(message.mediaAttachments)
            ? message.mediaAttachments.filter((attachment): attachment is string => typeof attachment === "string")
            : [];
        if (role && (text !== null || attachments.length > 0 || mediaAttachments.length > 0)) {
            messages.push({
                role,
                text: text || "",
                attachments,
                mediaAttachments,
            });
        }
    }
    return messages;
}

function parseAntigravityMessages(content: string | null): {
    messages: ProductionSourceMessage[] | null;
    issues: SourceEvidenceIssue[];
} {
    if (content === null) return { messages: null, issues: [] };
    try {
        const trajectory = JSON.parse(content) as unknown;
        const fields = trajectory && typeof trajectory === "object" && !Array.isArray(trajectory)
            ? trajectory as Record<string, unknown>
            : null;
        const steps = fields && Array.isArray(fields.steps) ? fields.steps : [];
        const roundMessages = messagesFromWindsurfRounds(windsurfStepsToConversationRounds(steps));
        return {
            messages: roundMessages.length > 0 ? roundMessages : directAntigravityMessages(trajectory),
            issues: [],
        };
    } catch {
        return {
            messages: null,
            issues: [productionSourceIssue("parse_error", "Antigravity full source content is not valid JSON")],
        };
    }
}

function authorityVerification(
    enumeration: SourceEnumerationEvidence,
    exactFetch: ExactFetchEvidence,
    fullSourceRead: FullSourceReadEvidence | null,
): ProductionSourceAuthorityVerification {
    const identities = [enumeration.identity, exactFetch.identity, ...(fullSourceRead ? [fullSourceRead.identity] : [])];
    const revisions = [enumeration.sourceRevision, exactFetch.sourceRevision, ...(fullSourceRead ? [fullSourceRead.sourceRevision] : [])];
    const observations = [enumeration.observedAt, exactFetch.observedAt, ...(fullSourceRead ? [fullSourceRead.observedAt] : [])];
    return {
        identityHash: sourceHash(enumeration.identity),
        revisionHash: sourceHash(enumeration.sourceRevision),
        identityStable: identities.every(identity => sameCanonicalValue(identity, identities[0])),
        revisionStable: revisions.every(revision => sameAuthorityRevision(revision, revisions[0]))
            && observations.every(observation => observation.scanId === observations[0]?.scanId),
        cacheBypassed: enumeration.cacheBypassed && exactFetch.cacheBypassed && (fullSourceRead?.cacheBypassed ?? true),
        enumerationEvidenceHash: enumeration.evidenceHash,
        exactFetchEvidenceHash: exactFetch.evidenceHash,
        fullReadEvidenceHash: fullSourceRead?.evidenceHash || null,
    };
}

function fullReadSafetyIssues(
    enumeration: SourceEnumerationEvidence,
    exactFetch: ExactFetchEvidence,
    fullSourceRead: FullSourceReadEvidence | null,
    authority: ProductionSourceAuthorityVerification,
): SourceEvidenceIssue[] {
    const evidence = [enumeration, exactFetch, ...(fullSourceRead ? [fullSourceRead] : [])];
    const issues = evidence.flatMap(item => [...item.errors, ...item.warnings]);
    if (!authority.identityStable) issues.push(productionSourceIssue("revision_drift", "source identity changed between enumeration, exact fetch, and full read"));
    if (!authority.revisionStable) issues.push(productionSourceIssue("revision_drift", "source revision or scan identity changed during full read"));
    if (!authority.cacheBypassed) issues.push(productionSourceIssue("cache_only", "full read did not bypass every host cache"));
    if (exactFetch.exactFetchResult !== "present") issues.push(productionSourceIssue("exact_fetch_failed", "full read requires an exact present result"));
    if (!fullSourceRead) issues.push(productionSourceIssue("source_unavailable", "host did not return full source evidence"));
    for (const item of evidence) {
        if (!item.enumerationComplete) issues.push(productionSourceIssue("pagination_incomplete", `${item.kind} is not complete`));
        if (item.pagination.cursor !== null || item.pagination.truncated || item.pagination.limit !== null) {
            issues.push(productionSourceIssue("pagination_incomplete", `${item.kind} pagination is not exhausted`));
        }
    }
    if (fullSourceRead?.content.truncated) issues.push(productionSourceIssue("pagination_incomplete", "full source content is truncated"));
    if (fullSourceRead?.content.staleCache) issues.push(productionSourceIssue("cache_only", "full source content came from stale cache"));
    return uniqueProductionSourceIssues(issues);
}

function unverifiedProductionSourceAttachmentIssues(messages: ProductionSourceMessage[]): SourceEvidenceIssue[] {
    const issues: SourceEvidenceIssue[] = [];
    for (const message of canonicalProductionSourceMessages(messages)) {
        for (const [index, attachment] of (message.attachments || []).entries()) {
            if (!attachment.sha256) {
                issues.push(productionSourceIssue(
                    "source_unavailable",
                    `attachment ${message.order}.${index + 1} has no verifiable content SHA-256`,
                ));
            }
        }
    }
    return issues;
}

function rebuildProductionFullEvidence(
    fullSourceRead: FullSourceReadEvidence,
    payload: Pick<ProductionSourceContentPayload, "byteLength" | "contentHash"> | null,
    issues: SourceEvidenceIssue[],
): FullSourceReadEvidence {
    const { schemaVersion, kind, evidenceHash, ...input } = fullSourceRead;
    void schemaVersion;
    void kind;
    void evidenceHash;
    return buildFullSourceReadEvidence({
        ...input,
        enumerationComplete: fullSourceRead.enumerationComplete,
        errors: uniqueProductionSourceIssues([...fullSourceRead.errors, ...issues]),
        content: {
            ...fullSourceRead.content,
            byteLength: payload?.byteLength ?? fullSourceRead.content.byteLength,
            contentHash: payload?.contentHash ?? fullSourceRead.content.contentHash,
        },
    });
}

function unresolvedFullRead(
    nativeEvidence: FullSourceReadEvidence | null,
    authority: ProductionSourceAuthorityVerification,
    issues: SourceEvidenceIssue[],
    payload: ProductionSourceContentPayload | null = null,
): ProductionSourceFullReadUnresolved {
    const uniqueIssues = uniqueProductionSourceIssues(issues);
    return {
        status: "unresolved",
        evidence: nativeEvidence ? rebuildProductionFullEvidence(nativeEvidence, payload, uniqueIssues) : null,
        payload: null,
        sourceSnapshot: null,
        authority,
        issues: uniqueIssues,
    };
}

function normalizeClassification(
    enumeration: SourceEnumerationEvidence,
    exactFetch: ExactFetchEvidence,
    fullSourceRead: ProductionSourceFullReadResult,
): { classification: SourceEvidenceClassification; qualifiedAbsence: SourceEvidenceClassification["lostObservation"] | null } {
    const base = classifySourceEvidence({ enumeration, exactFetch });
    if (base.state === "Lost") {
        return {
            classification: { state: "Unresolved", reason: "loss-gate-failed" },
            qualifiedAbsence: base.lostObservation || null,
        };
    }
    if (base.state === "Present" && fullSourceRead.status === "unresolved") {
        const reason = fullSourceRead.issues.some(issue => issue.code === "revision_drift")
            ? "revision-drift" as const
            : fullSourceRead.issues.some(issue => issue.code === "cache_only")
                ? "cache-not-bypassed" as const
                : fullSourceRead.issues.some(issue => issue.code === "pagination_incomplete")
                    ? "pagination-incomplete" as const
                    : "adapter-error" as const;
        return { classification: { state: "Unresolved", reason }, qualifiedAbsence: null };
    }
    return { classification: base, qualifiedAbsence: null };
}

function hostSourceMessages(
    messages: readonly (CodexSourceContentMessage | ClaudeCodeSourceContentMessage)[] | undefined,
): ProductionSourceMessage[] | null {
    return messages ? messages.map(message => ({ role: message.role, text: message.text, attachments: message.attachments })) : null;
}

function buildProductionFullRead(
    input: {
        host: SourceEvidenceHost;
        conversationId: string;
        enumeration: SourceEnumerationEvidence;
        exactFetch: ExactFetchEvidence;
        nativeEvidence: FullSourceReadEvidence | null;
        messages: ProductionSourceMessage[] | null;
        messageIssues?: SourceEvidenceIssue[];
        maxContentBytes: number;
    },
    contentHashesByAuthorityRevision: Map<string, string>,
): ProductionSourceFullReadResult {
    const authority = authorityVerification(input.enumeration, input.exactFetch, input.nativeEvidence);
    const issues = fullReadSafetyIssues(input.enumeration, input.exactFetch, input.nativeEvidence, authority);
    issues.push(...(input.messageIssues || []));
    if (input.nativeEvidence && input.messages === null) {
        issues.push(productionSourceIssue("parse_error", "host full read did not expose meaningful user/assistant source messages"));
    }
    if (input.messages !== null) issues.push(...unverifiedProductionSourceAttachmentIssues(input.messages));
    const safetyIssues = uniqueProductionSourceIssues(issues);
    if (safetyIssues.length > 0 || !input.nativeEvidence || input.messages === null) {
        return unresolvedFullRead(input.nativeEvidence, authority, safetyIssues);
    }

    const formatted = buildProductionSourcePayload(
        input.host,
        input.conversationId,
        input.messages,
        input.maxContentBytes,
    );
    if (!formatted.payload) {
        return unresolvedFullRead(
            input.nativeEvidence,
            authority,
            formatted.issue ? [formatted.issue] : [productionSourceIssue("limit_reached", "canonical source payload is unavailable")],
        );
    }

    const authorityRevisionKey = `${input.host}\u0000${authority.identityHash}\u0000${authority.revisionHash}`;
    const previousContentHash = contentHashesByAuthorityRevision.get(authorityRevisionKey);
    if (previousContentHash && previousContentHash !== formatted.payload.contentHash) {
        authority.contradiction = {
            kind: "same-revision-different-bytes",
            previousContentHash,
            observedContentHash: formatted.payload.contentHash,
        };
        return unresolvedFullRead(
            input.nativeEvidence,
            authority,
            [productionSourceIssue(
                "revision_drift",
                "the same source identity/revision produced different canonical payload bytes",
            )],
            formatted.payload,
        );
    }
    contentHashesByAuthorityRevision.set(authorityRevisionKey, formatted.payload.contentHash);

    const evidence = rebuildProductionFullEvidence(input.nativeEvidence, formatted.payload, []);
    const sourceSnapshot = buildRecordSourceSnapshot({
        snapshotId: `${input.host}:${input.conversationId}:${evidence.sourceRevision.revision}:${formatted.payload.contentHash}`,
        fullSourceRead: evidence,
    });
    return {
        status: "complete",
        evidence,
        payload: formatted.payload,
        sourceSnapshot,
        authority,
        issues: [],
    };
}

function validNow(now: () => Date): Date {
    const value = now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error("production source reader now() 必须返回有效 Date");
    return value;
}

function rebaseAntigravityEvidence(
    enumeration: SourceEnumerationEvidence,
    exactFetch: ExactFetchEvidence,
    fullSourceRead: FullSourceReadEvidence | null,
    scan: ProductionAntigravityScan,
): { enumeration: SourceEnumerationEvidence; exactFetch: ExactFetchEvidence; fullSourceRead: FullSourceReadEvidence | null } {
    const observedAt = (sequence: number) => ({
        scanId: scan.scanId,
        sequence,
        startedAt: scan.startedAt,
        completedAt: scan.completedAt,
    });
    const { schemaVersion: enumerationSchemaVersion, kind: enumerationKind, evidenceHash: enumerationHash, ...enumerationInput } = enumeration;
    const { schemaVersion: exactSchemaVersion, kind: exactKind, evidenceHash: exactHash, ...exactInput } = exactFetch;
    void enumerationSchemaVersion;
    void enumerationKind;
    void enumerationHash;
    void exactSchemaVersion;
    void exactKind;
    void exactHash;
    const rebasedEnumeration = buildSourceEnumerationEvidence({
        ...enumerationInput,
        observedAt: observedAt(1),
    });
    const rebasedExactFetch = buildExactFetchEvidence({
        ...exactInput,
        observedAt: observedAt(2),
    });
    let rebasedFullSourceRead: FullSourceReadEvidence | null = null;
    if (fullSourceRead) {
        const { schemaVersion, kind, evidenceHash, ...fullInput } = fullSourceRead;
        void schemaVersion;
        void kind;
        void evidenceHash;
        rebasedFullSourceRead = buildFullSourceReadEvidence({ ...fullInput, observedAt: observedAt(3) });
    }
    return {
        enumeration: rebasedEnumeration,
        exactFetch: rebasedExactFetch,
        fullSourceRead: rebasedFullSourceRead,
    };
}

export function createProductionSourceReader(options: ProductionSourceReaderOptions = {}): ProductionSourceReader {
    const now = options.now || (() => new Date());
    const defaultMaxContentBytes = validMaxContentBytes(
        options.maxContentBytes,
        DEFAULT_PRODUCTION_SOURCE_MAX_CONTENT_BYTES,
    );
    const issuedScanIds = new Set<string>();
    const contentHashesByAuthorityRevision = new Map<string, string>();
    let scanSequence = 0;
    const nextScanId = (host: SourceEvidenceHost): string => {
        scanSequence += 1;
        const scanId = options.scanIdFactory?.(host) || `production-source:${host}:${randomUUID()}`;
        if (!scanId.trim() || issuedScanIds.has(scanId)) throw new Error(`生产 source reader scanId 必须独立且非空: ${scanId}`);
        issuedScanIds.add(scanId);
        return scanId;
    };

    const scan = async (request: ProductionSourceReadRequest): Promise<ProductionSourceReadResult> => {
        const scanId = nextScanId(request.host);
        const maxContentBytes = validMaxContentBytes(request.maxContentBytes, defaultMaxContentBytes);
        if (request.host === "codex") {
            const result = await collectCodexSourceEvidence({
                conversationId: request.conversationId,
                workspace: request.workspace,
                scanId,
                sequence: 1,
                cacheBypassed: true,
                enumerationLimit: request.enumerationLimit,
                paths: request.paths,
                now,
            });
            const fullSourceRead = buildProductionFullRead({
                host: request.host,
                conversationId: request.conversationId,
                enumeration: result.enumeration,
                exactFetch: result.evidence,
                nativeEvidence: result.fullSourceRead || null,
                messages: hostSourceMessages(result.sourceMessages),
                maxContentBytes,
            }, contentHashesByAuthorityRevision);
            const normalized = normalizeClassification(result.enumeration, result.evidence, fullSourceRead);
            return {
                host: request.host,
                scanId,
                enumeration: result.enumeration,
                exactFetch: result.evidence,
                fullSourceRead,
                sourceSnapshot: fullSourceRead.sourceSnapshot,
                ...normalized,
            };
        }
        if (request.host === "claude-code") {
            const result = inspectClaudeCodeSourceEvidence({
                conversationId: request.conversationId,
                projectsRoot: request.projectsRoot,
                workspaceId: request.workspaceId,
                workspacePath: request.workspacePath,
                limit: request.limit,
                cacheBypassed: true,
                readChunkBytes: request.readChunkBytes,
                maxLineBytes: request.maxLineBytes,
                fileSystem: request.fileSystem,
                scanId,
                sequence: 1,
                now,
            });
            const fullSourceRead = buildProductionFullRead({
                host: request.host,
                conversationId: request.conversationId,
                enumeration: result.enumeration,
                exactFetch: result.exactFetch,
                nativeEvidence: result.fullSourceRead,
                messages: hostSourceMessages(result.sourceMessages),
                maxContentBytes,
            }, contentHashesByAuthorityRevision);
            const normalized = normalizeClassification(result.enumeration, result.exactFetch, fullSourceRead);
            return {
                host: request.host,
                scanId,
                enumeration: result.enumeration,
                exactFetch: result.exactFetch,
                fullSourceRead,
                sourceSnapshot: fullSourceRead.sourceSnapshot,
                ...normalized,
            };
        }
        if (request.host === "windsurf") {
            const result = await scanWindsurfSourceEvidence(request.conversationId, {
                transport: request.transport,
                endpoint: request.endpoint,
                workspaceId: request.workspaceId,
                workspacePath: request.workspacePath,
                sourceAuthority: request.sourceAuthority,
                authoritativeRoot: request.authoritativeRoot,
                sourceCanonicalPath: request.sourceCanonicalPath,
                maxPages: request.maxPages,
                requestClass: request.requestClass,
                scanId,
                sequence: 1,
                now,
            });
            const messageIssues = result.readResult?.partial
                ? [productionSourceIssue("pagination_incomplete", "Windsurf source steps are partial")]
                : [];
            const fullSourceRead = buildProductionFullRead({
                host: request.host,
                conversationId: request.conversationId,
                enumeration: result.enumeration,
                exactFetch: result.exactFetch,
                nativeEvidence: result.fullSourceRead || null,
                messages: result.readResult ? messagesFromWindsurfRounds(result.readResult.rounds) : null,
                messageIssues,
                maxContentBytes,
            }, contentHashesByAuthorityRevision);
            const normalized = normalizeClassification(result.enumeration, result.exactFetch, fullSourceRead);
            return {
                host: request.host,
                scanId,
                enumeration: result.enumeration,
                exactFetch: result.exactFetch,
                fullSourceRead,
                sourceSnapshot: fullSourceRead.sourceSnapshot,
                ...normalized,
            };
        }

        const startedAt = validNow(now).toISOString();
        const provisionalScan: ProductionAntigravityScan = {
            scanId,
            sequence: scanSequence,
            startedAt,
            completedAt: startedAt,
        };
        const adapter = createAntigravityLsSourceEvidenceAdapter(
            options.antigravityReader || createProductionAntigravityLsEvidenceReader(request.source, options.antigravityIo),
        );
        const nativeRequest: AntigravityLsEvidenceRequest = {
            cascadeId: request.conversationId,
            workspaceId: request.workspaceId,
            workspacePath: request.workspacePath,
            source: request.source,
            pageLimit: request.pageLimit,
            scan: provisionalScan,
        };
        const result = await adapter.readFull(nativeRequest, `antigravity:${request.conversationId}:${scanId}`);
        const completedAt = validNow(now).toISOString();
        const rebased = rebaseAntigravityEvidence(result.enumeration, result.exactFetch, result.evidence, {
            ...provisionalScan,
            completedAt,
        });
        const parsedMessages = parseAntigravityMessages(result.content);
        const fullSourceRead = buildProductionFullRead({
            host: request.host,
            conversationId: request.conversationId,
            enumeration: rebased.enumeration,
            exactFetch: rebased.exactFetch,
            nativeEvidence: rebased.fullSourceRead,
            messages: parsedMessages.messages,
            messageIssues: [...result.errors, ...parsedMessages.issues],
            maxContentBytes,
        }, contentHashesByAuthorityRevision);
        const normalized = normalizeClassification(rebased.enumeration, rebased.exactFetch, fullSourceRead);
        return {
            host: request.host,
            scanId,
            enumeration: rebased.enumeration,
            exactFetch: rebased.exactFetch,
            fullSourceRead,
            sourceSnapshot: fullSourceRead.sourceSnapshot,
            ...normalized,
        };
    };
    return {
        scan,
        enumerate: async request => (await scan(request)).enumeration,
        fetchExact: async request => (await scan(request)).exactFetch,
        readFull: async request => (await scan(request)).fullSourceRead,
    };
}
