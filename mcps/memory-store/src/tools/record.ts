import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import fs from "fs";
import { z } from "zod";
import { touchActivity } from "../lifecycle.js";
import { listConversationsByMtime, detectWorkspaceFromSteps, fetchFirstPageSteps } from "../ls-client.js";
import {
    readRecord, writeRecord, deleteRecord, listRecords, copyRecordToHash,
    searchRecordsGlobal,
    resolveWorkspaceHashForRecord, readRecordsIndex, findRecordHash, resolveRecordConversationId,
    readRecordSidecar, writeRecordSidecar,
} from "../record-store.js";
import { ensureWorkspace, listWorkspaceHashes, readWorkspaceMeta, workspaceHash } from "../store.js";
import {
    generateRecord, countPhasesInRecord, inferCoveredRoundFromRecord, validateRecordCandidateForWrite, type RecordParallelMode,
} from "../record-generator.js";
import { saveTempFile } from "../temp-store.js";
import { DATA_CHAIN_INPUT_VALUES, DEFAULT_CHAIN, resolveChainSplit, type Chain, type ChainInput, type DataChainInput, type DataChain } from "../chain.js";
import { modelChainInputSchema } from "./schema-utils.js";
import { loadConversationData, resolveConversationChain } from "../conversation-bridge.js";
import { getCodexParentThread, getCodexThread, listRecentCodexThreads } from "../codex-client.js";
import { getClaudeCodeThread } from "../claude-code-client.js";
import { startBackgroundTask, waitForBackgroundTask, formatBackgroundTask } from "../background-tasks.js";
import type { BackgroundTaskProgress } from "../background-tasks.js";
import {
    RECORD_READER_VERSION,
    RECORD_SECTION_TYPES,
    buildOutline,
    buildRecordReaderIndex,
    formatReaderView,
    isRecordReaderIndexFresh,
    selectRecordReaderBlocks,
    type FormatReaderViewOptions,
    type ReaderBlock,
    type RecordReaderIndex,
    type RecordReaderIndexMode,
    type RecordReaderView,
    type RecordSectionType,
} from "../record-reader.js";
import { search, type SearchMode, type SearchResult, type TextBlock } from "../search-engine.js";

type RecordManageScope = "workspace" | "global" | "general";
type RecordSearchScope = "record" | "phase" | "section" | "item";
type RecordReadFormat = "text" | "json";
type RecordGuideRecommendation = {
    type: "read" | "search";
    reason: string;
    readHint?: Record<string, unknown>;
    searchHint?: Record<string, unknown>;
    provenance?: Record<string, unknown>;
};
type OwnershipSourceType =
    | "explicit_workspace"
    | "antigravity_workspace_uri"
    | "codex_cwd"
    | "claude_code_cwd"
    | "windsurf_cwd"
    | "child_parent"
    | "duplicate"
    | "unknown";
type OwnershipStatus = "ok" | "duplicate" | "migratable" | "conflict" | "unknown";

export interface RecordSourceSnapshot {
    chain: DataChain;
    rounds: number;
    totalSteps: number;
    rolloutPath?: string;
    rolloutMtimeMs?: number;
}

interface OwnershipAuditItem {
    conversationId: string;
    title: string;
    currentHash: string;
    expectedHash?: string;
    expectedWorkspace?: string;
    sourceType: OwnershipSourceType;
    status: OwnershipStatus;
    reason: string;
    suggestedAction: "keep" | "move" | "archiveDuplicate" | "manualReview";
}

const RECORD_OWNERSHIP_SIDECAR = "ownership.json";

function readOwnershipSidecar(hash: string, conversationId: string): { status?: string; supersededBy?: string } | null {
    return readRecordSidecar<{ status?: string; supersededBy?: string }>(hash, conversationId, RECORD_OWNERSHIP_SIDECAR);
}

function resolveSupersededTargetHash(hash: string, conversationId: string, visited = new Set<string>()): string | null {
    if (visited.has(hash)) return null;
    visited.add(hash);
    const sidecar = readOwnershipSidecar(hash, conversationId);
    if (sidecar?.status !== "superseded" || !sidecar.supersededBy) return null;
    const targetHash = sidecar.supersededBy;
    if (visited.has(targetHash) || !readRecord(targetHash, conversationId)) return null;
    const targetSidecar = readOwnershipSidecar(targetHash, conversationId);
    if (targetSidecar?.status === "superseded") {
        return resolveSupersededTargetHash(targetHash, conversationId, visited);
    }
    return targetHash;
}

function isSupersededRecord(hash: string, conversationId: string): boolean {
    return Boolean(resolveSupersededTargetHash(hash, conversationId));
}

/**
 * record_manage — 对话记录管理工具 v1.8
 */
export function registerRecord(server: McpServer): void {
    server.tool(
        "record_manage",
        `管理对话记录（Record）。Record 是对话的结构化过程日志，由 Flash 自动生成，抗 LS 过期。
action:
- update: 触发 Record 生成/更新（拉取对话内容 → Flash 生成）
- list: 列出工作区下所有 Record 概览
- read: 读取指定 Record（支持行范围）
- search: 在 Record 中搜索关键词
- guide: 为长 Record 生成带来源的 read/search 阅读建议，不生成事实摘要
- edit: 手动修改 Record（content 替换 / append 追加）
- delete: 删除指定 Record（不传 conversationId 则清空工作区全部 Record）
- audit_ownership: 审计 Record 归属，不按语义猜测，只看 workspaceUri/cwd/派生关系/重复副本
- repair_ownership: 归属修复，默认 dry-run，只输出迁移计划
- batch_delete: 删除工作区下所有 Record
- task_status: 查询后台任务状态`,
        {
            action: z.enum(["update", "list", "read", "search", "guide", "edit", "delete", "batch_update", "batch_delete", "task_status", "audit_ownership", "repair_ownership"])
                .describe("操作类型"),
            conversationId: z.string().optional()
                .describe("对话 ID（update 不传则自动获取当前对话）"),
            workspace: z.string().optional()
                .describe("工作区路径（不传则 general）"),
            scope: z.enum(["workspace", "global", "general"]).optional()
                .describe("search/list/audit 范围，默认 workspace；workspace 严格只读指定工作区"),
            includeGeneral: z.boolean().optional()
                .describe("list/search 兼容开关：显式把 general 也并入 workspace 结果，默认 false"),
            query: z.string().optional()
                .describe("search 模式的搜索关键词"),
            mode: z.enum(["auto", "exact", "fuzzy", "smart"]).optional()
                .describe("search 模式：auto/exact/fuzzy/smart，默认 auto"),
            content: z.string().optional()
                .describe("edit 模式：替换全文"),
            append: z.string().optional()
                .describe("edit 模式：追加到末尾"),
            startLine: z.number().optional()
                .describe("read 模式：起始行号"),
            endLine: z.number().optional()
                .describe("read 模式：结束行号"),
            view: z.enum(["raw", "outline", "state", "outputs", "lessons", "risks", "verification", "phase", "custom"]).optional()
                .describe("read 模式：结构化视图。未传则保持旧全文读取行为"),
            phaseIds: z.array(z.union([z.string(), z.number()])).optional()
                .describe("read/search：限定 Phase，例如 [1] 或 [\"phase-1\"]"),
            startBlockId: z.string().optional()
                .describe("read：从指定 reader block 继续读取，通常来自上次结构化读取的 nextReadHint.startBlockId"),
            sectionTypes: z.array(z.enum(RECORD_SECTION_TYPES)).optional()
                .describe("read/search：限定 Record 区块类型"),
            include: z.array(z.enum(RECORD_SECTION_TYPES)).optional()
                .describe("read：只包含指定区块类型"),
            exclude: z.array(z.enum(RECORD_SECTION_TYPES)).optional()
                .describe("read：排除指定区块类型"),
            maxChars: z.number().optional()
                .describe("read/search/guide：最大输出字符数，结构化读取会按 block 边界截断"),
            format: z.enum(["text", "json"]).optional()
                .describe("read/search/guide：返回格式，默认 text"),
            withCitations: z.boolean().optional()
                .describe("read：是否输出 block/行号来源，默认 true"),
            indexMode: z.enum(["auto", "reuse", "rebuild", "off"]).optional()
                .describe("read/search/guide：reader index 策略，auto=复用新鲜索引或懒重建"),
            recordIds: z.array(z.string()).optional()
                .describe("search/guide：限定多个 Record ID"),
            searchScope: z.enum(["record", "phase", "section", "item"]).optional()
                .describe("search：结果粒度，不复用 scope，避免和 workspace/global/general 冲突"),
            goal: z.string().optional()
                .describe("guide：阅读目标，用于生成 read/search 建议"),
            maxRecommendations: z.number().optional()
                .describe("guide：最多返回建议数量，默认 5"),
            after: z.string().optional()
                .describe("batch_update: 只处理此时间之后的对话(ISO/YYYY-MM-DD)"),
            before: z.string().optional()
                .describe("batch_update: 只处理此时间之前的对话"),
            limit: z.number().optional()
                .describe("batch_update: 最大处理数量(默认10, 上限50)"),
            force: z.boolean().optional()
                .describe("update/batch_update: 强制更新已有Record；update 时绕过“已是最新”短路并重新生成"),
            dryRun: z.boolean().optional()
                .describe("repair_ownership: 默认 true，只报告计划不移动文件"),
            backup: z.boolean().optional()
                .describe("repair_ownership: 真正迁移前备份 Record 正文和索引，默认 true"),
            waitSeconds: z.number().optional()
                .describe("后台任务查询等待秒数(1-300)，任务完成时提前返回"),
            background: z.boolean().optional()
                .describe("Codex 链路长模型调用建议设为 true，立即返回 taskId，后续用 task_status 查询"),
            parallelMode: z.enum(["off", "auto", "force"]).optional()
                .describe("实验性 Record 并行管线：off=关闭(默认)，auto=高密对话自动启用，force=能切出多批时强制启用"),
            taskId: z.string().optional()
                .describe("task_status: 后台任务 ID"),
            chain: z.enum(DATA_CHAIN_INPUT_VALUES).default(DEFAULT_CHAIN)
                .describe("兼容旧参数：dataChain/modelChain 未传时沿用；chain=\"windsurf\" 只作为 dataChain，modelChain 仍默认 auto"),
            dataChain: z.enum(DATA_CHAIN_INPUT_VALUES).optional()
                .describe("对话数据链路：auto=当前宿主优先，支持 antigravity/codex/claude-code/windsurf"),
            modelChain: modelChainInputSchema("modelChain", "模型链路：auto=当前宿主优先，claude-code=显式 Claude Code CLI；Windsurf 只支持 dataChain"),
        },
        async (args) => {
            const startMs = Date.now();
            touchActivity({ skipRecordAutoCheck: args.action === "update" || args.action === "batch_update" });
            try {
                const hash = resolveWorkspaceHashForRecord(args.workspace);
                const chains = resolveChainSplit({ chain: args.chain, dataChain: args.dataChain, modelChain: args.modelChain });
                switch (args.action) {
                    case "update":
                        if (args.background) {
                            return handleUpdateBackground(hash, args.conversationId, args.workspace, chains.dataChain, chains.modelChain, args.parallelMode, args.force, startMs);
                        }
                        return await handleUpdate(hash, args.conversationId, args.workspace, chains.dataChain, chains.modelChain, args.parallelMode, args.force, startMs);
                    case "list":
                        return handleList(hash, args.scope, args.includeGeneral, args.after, args.before, startMs);
                    case "read":
                        return await handleRead(hash, args.conversationId, args.startLine, args.endLine, startMs, {
                            view: args.view,
                            phaseIds: args.phaseIds,
                            startBlockId: args.startBlockId,
                            sectionTypes: args.sectionTypes,
                            include: args.include,
                            exclude: args.exclude,
                            maxChars: args.maxChars,
                            format: args.format,
                            withCitations: args.withCitations,
                            indexMode: args.indexMode,
                        });
                    case "search":
                        return handleSearch(hash, args.query, args.scope, args.includeGeneral, args.mode, chains.modelChain, startMs, {
                            conversationId: args.conversationId,
                            recordIds: args.recordIds,
                            phaseIds: args.phaseIds,
                            sectionTypes: args.sectionTypes,
                            searchScope: args.searchScope,
                            maxChars: args.maxChars,
                            format: args.format,
                            indexMode: args.indexMode,
                            limit: args.limit,
                        });
                    case "guide":
                        return await handleGuide(hash, args.conversationId, args.recordIds, args.scope, args.includeGeneral, args.goal || args.query, args.maxRecommendations, chains.modelChain, startMs, {
                            phaseIds: args.phaseIds,
                            sectionTypes: args.sectionTypes,
                            maxChars: args.maxChars,
                            format: args.format,
                            indexMode: args.indexMode,
                            background: args.background,
                        });
                    case "audit_ownership":
                        return await handleAuditOwnership(hash, args.scope, chains.dataChain, startMs);
                    case "repair_ownership":
                        return await handleRepairOwnership(hash, args.scope, chains.dataChain, args.dryRun ?? true, args.backup ?? true, startMs);
                    case "edit":
                        return await handleEdit(hash, args.conversationId, args.content, args.append, startMs);
                    case "delete":
                        return await handleDelete(hash, args.conversationId, startMs);
                    case "batch_delete":
                        return await handleBatchDelete(hash, startMs);
                    case "batch_update":
                        return await handleBatchUpdate(hash, args, startMs);
                    case "task_status":
                        return await handleTaskStatus(args.taskId, args.waitSeconds, startMs);
                    default:
                        return r(`❌ 未知 action: ${args.action}`);
                }
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                return rt(`❌ record_manage 错误: ${msg}`, startMs);
            }
        }
    );
}

/** 快捷构建返回值 */
function r(text: string) { return { content: [{ type: "text" as const, text }] }; }
/** 快捷构建返回值（含耗时） */
function rt(text: string, startMs: number) {
    const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
    return r(`${text}\n⏱ 耗时 ${elapsed}s`);
}

function responseText(response: ReturnType<typeof r>): string {
    return response.content.map(item => item.text).join("\n");
}

function statMtimeMs(filePath: string | undefined): number | undefined {
    if (!filePath) return undefined;
    try {
        return fs.statSync(filePath).mtimeMs;
    } catch {
        return undefined;
    }
}

export function buildSourceChangedWarning(snapshot: RecordSourceSnapshot, latestMtimeMs = statMtimeMs(snapshot.rolloutPath)): string | null {
    if (snapshot.chain !== "codex" || !snapshot.rolloutPath || snapshot.rolloutMtimeMs === undefined) return null;
    if (latestMtimeMs === undefined || latestMtimeMs <= snapshot.rolloutMtimeMs + 50) return null;
    return `目标 Codex 对话在 Record 生成期间继续追加；本次按启动快照覆盖 ${snapshot.rounds} 轮 / ${snapshot.totalSteps} 步。若要纳入新尾巴，请再执行一次 update。`;
}

function recordCompletenessScore(hash: string, conversationId: string, content?: string) {
    const entry = readRecordsIndex(hash).records[conversationId];
    return {
        coveredRounds: entry?.lastUpdatedRound || entry?.totalRounds || 0,
        updatedAt: Date.parse(entry?.lastUpdatedAt || "") || 0,
        sizeBytes: entry?.sizeBytes || (content ? Buffer.byteLength(content, "utf-8") : 0),
        nonGeneral: hash === "general" ? 0 : 1,
    };
}

function compareRecordCandidate(
    a: { hash: string; conversationId: string; content?: string },
    b: { hash: string; conversationId: string; content?: string },
): number {
    const as = recordCompletenessScore(a.hash, a.conversationId, a.content);
    const bs = recordCompletenessScore(b.hash, b.conversationId, b.content);
    if (as.coveredRounds !== bs.coveredRounds) return as.coveredRounds - bs.coveredRounds;
    if (as.updatedAt !== bs.updatedAt) return as.updatedAt - bs.updatedAt;
    if (as.sizeBytes !== bs.sizeBytes) return as.sizeBytes - bs.sizeBytes;
    return as.nonGeneral - bs.nonGeneral;
}

/** readRecord 兜底：收集 workspace/general/global 候选后按覆盖轮次、更新时间、大小选择最可信版本 */
function readRecordFallback(hash: string, convId: string): string | null {
    return resolveRecordLocation(hash, convId)?.content || null;
}

function resolveRecordLocation(hash: string, convId: string): { hash: string; conversationId: string; content: string } | null {
    const resolvedId = resolveRecordConversationId(convId, hash) || convId;
    const candidates: Array<{ hash: string; conversationId: string; content: string }> = [];
    const content = readRecord(hash, resolvedId);
    if (content && !isSupersededRecord(hash, resolvedId)) candidates.push({ hash, conversationId: resolvedId, content });
    if (hash !== "general") {
        const fromGeneral = readRecord("general", resolvedId);
        if (fromGeneral && !isSupersededRecord("general", resolvedId)) candidates.push({ hash: "general", conversationId: resolvedId, content: fromGeneral });
    }
    const foundHash = findRecordHash(resolvedId);
    if (foundHash && !candidates.some(candidate => candidate.hash === foundHash)) {
        const found = readRecord(foundHash, resolvedId);
        if (found) candidates.push({ hash: foundHash, conversationId: resolvedId, content: found });
    }
    return candidates.sort((a, b) => compareRecordCandidate(b, a))[0] || null;
}

const RECORD_READER_SIDECAR = "record_index.json";

async function writeReaderIndexForRecord(hash: string, conversationId: string, content: string): Promise<RecordReaderIndex> {
    const index = buildRecordReaderIndex(conversationId, content);
    await writeRecordSidecar(hash, conversationId, RECORD_READER_SIDECAR, index);
    return index;
}

async function readOrBuildReaderIndex(hash: string, conversationId: string, content: string, mode: RecordReaderIndexMode = "auto") {
    if (mode !== "rebuild" && mode !== "off") {
        const cached = readRecordSidecar<RecordReaderIndex>(hash, conversationId, RECORD_READER_SIDECAR);
        if (cached?.version === RECORD_READER_VERSION && isRecordReaderIndexFresh(cached, content)) {
            return { index: cached, indexStatus: "fresh" as const };
        }
        if (mode === "reuse" && cached) {
            return { index: buildRecordReaderIndex(conversationId, content), indexStatus: "rebuilt_in_memory_stale_cache" as const };
        }
    }
    const index = buildRecordReaderIndex(conversationId, content);
    if (mode === "off") return { index, indexStatus: "rebuilt_in_memory" as const };
    await writeRecordSidecar(hash, conversationId, RECORD_READER_SIDECAR, index);
    return { index, indexStatus: "rebuilt" as const };
}

function recordCoverageWarning(hash: string, conversationId: string, content: string): string | null {
    const entry = readRecordsIndex(hash).records[conversationId];
    const indexedRound = entry?.lastUpdatedRound || entry?.totalRounds || 0;
    if (!indexedRound) return null;
    const coveredRound = inferCoveredRoundFromRecord(content, indexedRound);
    if (coveredRound >= indexedRound) return null;
    return `⚠️ Record 正文疑似只覆盖 ${coveredRound}/${indexedRound} 轮；下次 update 会先修正索引并继续生成。`;
}

function normalizeSectionTypes(values?: RecordSectionType[]): RecordSectionType[] | undefined {
    if (!values || values.length === 0) return undefined;
    const allowed = new Set<RecordSectionType>(RECORD_SECTION_TYPES);
    return values.filter(value => allowed.has(value));
}

function dedupeRecordsByCompleteness(records: ReturnType<typeof listRecords>) {
    // 同 convId 保留覆盖轮次更完整、更新、体积更大的版本
    const map = new Map<string, typeof records[0]>();
    for (const rec of records) {
        const existing = map.get(rec.conversationId);
        if (
            !existing ||
            (rec.lastUpdatedRound || rec.totalRounds || 0) > (existing.lastUpdatedRound || existing.totalRounds || 0) ||
            ((rec.lastUpdatedRound || rec.totalRounds || 0) === (existing.lastUpdatedRound || existing.totalRounds || 0)
                && Date.parse(rec.lastUpdatedAt || "") > Date.parse(existing.lastUpdatedAt || "")) ||
            ((rec.lastUpdatedRound || rec.totalRounds || 0) === (existing.lastUpdatedRound || existing.totalRounds || 0)
                && Date.parse(rec.lastUpdatedAt || "") === Date.parse(existing.lastUpdatedAt || "")
                && (rec.sizeBytes || 0) > (existing.sizeBytes || 0))
        ) {
            map.set(rec.conversationId, rec);
        }
    }
    return Array.from(map.values());
}

export function recordHashesForScope(hash: string, scope: RecordManageScope | undefined, includeGeneral = false): string[] {
    if (scope === "global") {
        return ["general", ...listWorkspaceHashes()].filter((h, index, arr) => arr.indexOf(h) === index);
    }
    if (scope === "general" || hash === "general") return ["general"];
    const canonicalHash = canonicalHashForExistingRecordHash(hash) || hash;
    const workspaceHashes = [hash, ...listWorkspaceHashes().filter(h => h !== hash && canonicalHashForExistingRecordHash(h) === canonicalHash)]
        .filter((h, index, arr) => arr.indexOf(h) === index);
    return includeGeneral ? [...workspaceHashes, "general"] : workspaceHashes;
}

export function listRecordsForScope(hash: string, scope: RecordManageScope | undefined, includeGeneral = false) {
    const records = recordHashesForScope(hash, scope, includeGeneral)
        .flatMap(h => listRecords(h).filter(rec => !isSupersededRecord(h, rec.conversationId)));
    return dedupeRecordsByCompleteness(records);
}

// ============= update =============

async function handleUpdate(
    hash: string, conversationId: string | undefined,
    workspace: string | undefined, dataChain: DataChain, modelChain: Chain, parallelMode: RecordParallelMode | undefined, force: boolean | undefined, startMs: number,
    options: { background?: boolean; onProgress?: (progress: BackgroundTaskProgress) => void } = {},
) {
    options.onProgress?.({
        stage: "加载对话",
        detail: `dataChain=${dataChain}`,
    });
    const loaded = await loadConversationData(dataChain, conversationId, { link: "summary" });
    if (!loaded) return rt(`❌ 无法通过 dataChain=${dataChain} 获取对话数据`, startMs);
    if (loaded.windsurfData?.partial) {
        const skipped = loaded.windsurfData.skippedSteps || [];
        const shown = skipped.slice(0, 5).map(item => `offset ${item.offset}`).join(", ");
        const more = skipped.length > 5 ? ` 等 ${skipped.length} 个` : "";
        return rt([
            "❌ Record 更新已中止：Windsurf 原文读取不完整",
            `⚠️ 已跳过超大 step ${shown || "(未知)"}${more}`,
            "原因：Windsurf Language Server 拒绝返回超过单步大小限制的内容；memory-store 可以降级 read/search，但不会把缺失原文写成正式 Record。",
            "建议：先用 conversation_read_original(read/search, dataChain=\"windsurf\") 阅读可用部分；若需要完整 Record，请回到 Windsurf UI 或官方导出补齐该超大 step 后再生成。",
        ].join("\n"), startMs);
    }

    const cascadeId = loaded.conversationId;
    const rounds = loaded.rounds;
    const totalSteps = loaded.totalSteps;
    const sourceSnapshot: RecordSourceSnapshot = {
        chain: loaded.chainUsed,
        rounds: rounds.length,
        totalSteps,
        rolloutPath: loaded.codexData?.thread.rolloutPath,
        rolloutMtimeMs: statMtimeMs(loaded.codexData?.thread.rolloutPath),
    };
    options.onProgress?.({
        stage: "解析完成",
        current: 0,
        total: rounds.length,
        unit: "轮",
        detail: `${rounds.length} 轮 / ${totalSteps} 步，开始检查 Record 索引`,
    });

    // B修复：无 workspace 时从对话元数据自动检测工作区
    let effectiveHash = hash;
    let effectiveWs = workspace || "general";
    if (hash === "general" && !workspace) {
        const detectedWs = loaded.chainUsed === "antigravity"
            ? detectWorkspaceFromSteps(loaded.trajectory?.steps || [])
            : (loaded.codexData?.thread.cwd || loaded.claudeCodeData?.thread.cwd || loaded.windsurfData?.thread.cwd);
        if (detectedWs) {
            ensureWorkspace(detectedWs);
            effectiveHash = resolveWorkspaceHashForRecord(detectedWs);
            effectiveWs = detectedWs;
        }
    }
    if (effectiveWs !== "general") {
        ensureWorkspace(effectiveWs);
        effectiveHash = resolveWorkspaceHashForRecord(effectiveWs);
    }

    const existingBestHash = findRecordHash(cascadeId);
    if (existingBestHash && existingBestHash !== effectiveHash) {
        const currentContent = readRecord(effectiveHash, cascadeId);
        const bestContent = readRecord(existingBestHash, cascadeId);
        const shouldSeedOfficial = bestContent && (
            !currentContent ||
            compareRecordCandidate(
                { hash: existingBestHash, conversationId: cascadeId, content: bestContent },
                { hash: effectiveHash, conversationId: cascadeId, content: currentContent },
            ) > 0
        );
        if (shouldSeedOfficial) {
            await copyRecordToHash(existingBestHash, effectiveHash, cascadeId, { lastUpdatedAt: new Date().toISOString() }, { backup: true });
            await writeRecordSidecar(existingBestHash, cascadeId, RECORD_OWNERSHIP_SIDECAR, {
                status: "superseded",
                supersededBy: effectiveHash,
                reason: "record update remapped existing alias/general copy to official workspace",
                updatedAt: new Date().toISOString(),
            });
        }
    }

    const result = await generateRecord(effectiveHash, cascadeId, effectiveWs, rounds, totalSteps, modelChain, {
        background: options.background,
        parallelMode,
        force,
        onProgress: options.onProgress,
    });
    if (!result.success) return rt(`❌ Record 生成失败: ${result.error}`, startMs);

    const oldRecordForGate = readRecord(effectiveHash, cascadeId) || "";
    const gate = validateRecordCandidateForWrite(result.content!, cascadeId, rounds.length, result.coveredRounds || rounds.length, {
        oldRecord: oldRecordForGate,
    });
    if (!gate.ok) {
        return rt(`❌ Record 生成失败: ${gate.error}`, startMs);
    }

    const phases = countPhasesInRecord(result.content!);
    await writeRecord(effectiveHash, cascadeId, result.content!, {
        title: extractTitle(result.content!) || `对话 ${cascadeId.slice(0, 8)}`,
        totalRounds: rounds.length,
        totalSteps,
        lastUpdatedRound: result.coveredRounds || rounds.length,
        phases,
        tags: result.tags,
    });
    let readerIndexStatus = "rebuilt";
    try {
        await writeReaderIndexForRecord(effectiveHash, cascadeId, result.content!);
    } catch (err) {
        readerIndexStatus = `error: ${err instanceof Error ? err.message : String(err)}`;
    }

    const sizeKB = (Buffer.byteLength(result.content!, "utf-8") / 1024).toFixed(1);
    let out = result.upToDate
        ? "✅ Record 已是最新（索引已刷新）"
        : `✅ Record 已${conversationId ? "更新" : "生成"}`;
    out += `\n📝 对话: ${cascadeId.slice(0, 8)}...`;
    out += `\n🔗 对话链路: ${loaded.chainUsed}`;
    out += `\n🧠 模型链路: ${modelChain}`;
    if (parallelMode) out += `\n🧪 并行模式: ${parallelMode}`;
    if (force) out += `\n♻️ force: 已绕过“已是最新”短路`;
    if (result.warnings?.length) {
        out += `\n⚠️ ${result.warnings.join("\n⚠️ ")}`;
    }
    const sourceChangedWarning = buildSourceChangedWarning(sourceSnapshot);
    if (sourceChangedWarning) out += `\n⚠️ ${sourceChangedWarning}`;
    out += `\n📊 ${rounds.length} 轮 / ${totalSteps} 步骤 → ${phases} 个 Phase`;
    out += `\n💾 大小: ${sizeKB}KB`;
    out += `\n🔎 Reader Index: ${readerIndexStatus}`;
    if (result.batches && result.batches > 1) {
        out += `\n🔄 分 ${result.batches} 批生成，覆盖到第 ${result.coveredRounds} 轮`;
    }
    return rt(out, startMs);
}

function handleUpdateBackground(
    hash: string,
    conversationId: string | undefined,
    workspace: string | undefined,
    dataChain: DataChain,
    modelChain: Chain,
    parallelMode: RecordParallelMode | undefined,
    force: boolean | undefined,
    startMs: number,
) {
    const task = startBackgroundTask("record-update", async ({ updateProgress }) => {
        const result = await handleUpdate(hash, conversationId, workspace, dataChain, modelChain, parallelMode, force, Date.now(), {
            background: true,
            onProgress: updateProgress,
        });
        return responseText(result);
    });
    return rt([
        "🚀 Record 更新已转入后台任务",
        `🆔 taskId: ${task.id}`,
        `🔗 dataChain: ${dataChain}`,
        `🧠 modelChain: ${modelChain}`,
        parallelMode ? `🧪 parallelMode: ${parallelMode}` : "",
        force ? `♻️ force: true` : "",
        "💡 后续调用 record_manage(action=\"task_status\", taskId=\"...\") 查询结果",
    ].filter(Boolean).join("\n"), startMs);
}

async function handleTaskStatus(taskId: string | undefined, waitSeconds: number | undefined, startMs: number) {
    if (!taskId) return rt("❌ task_status 需要 taskId 参数", startMs);
    const task = await waitForBackgroundTask(taskId, waitSeconds || 0);
    return rt(formatBackgroundTask(task), startMs);
}

// ============= list =============

function handleList(hash: string, scope: RecordManageScope | undefined, includeGeneral: boolean | undefined, after: string | undefined, before: string | undefined, startMs: number) {
    const recordMap = new Map<string, ReturnType<typeof listRecords>[0] & { hash: string }>();
    for (const recordHash of recordHashesForScope(hash, scope, includeGeneral === true)) {
        for (const rec of listRecords(recordHash).filter(item => !isSupersededRecord(recordHash, item.conversationId))) {
            const existing = recordMap.get(rec.conversationId);
            if (!existing || compareRecordCandidate(
                { hash: recordHash, conversationId: rec.conversationId },
                { hash: existing.hash, conversationId: existing.conversationId },
            ) > 0) {
                recordMap.set(rec.conversationId, { ...rec, hash: recordHash });
            }
        }
    }
    let records = Array.from(recordMap.values()).sort(
        (a, b) => new Date(b.lastUpdatedAt).getTime() - new Date(a.lastUpdatedAt).getTime()
    );

    // 时间筛选
    if (after) {
        const afterMs = new Date(after).getTime();
        records = records.filter(r => new Date(r.lastUpdatedAt).getTime() >= afterMs);
    }
    if (before) {
        const beforeMs = new Date(before).getTime();
        records = records.filter(r => new Date(r.lastUpdatedAt).getTime() <= beforeMs);
    }

    const lines = [`📋 Record 列表 (${records.length} 份):\n`];
    for (const rec of records) {
        const readerIndex = readRecordSidecar<RecordReaderIndex>(rec.hash, rec.conversationId, RECORD_READER_SIDECAR);
        const sectionCounts = readerIndex?.blocks
            ? readerIndex.blocks.reduce((stats, block) => {
                stats[block.sectionType] = (stats[block.sectionType] || 0) + 1;
                return stats;
            }, {} as Record<string, number>)
            : {};
        const indexStatus = readerIndex?.version === RECORD_READER_VERSION ? "ok" : "missing";
        lines.push(`  📝 ${rec.conversationId} | ${rec.title}`);
        lines.push(`     ${rec.totalRounds}轮/${rec.totalSteps}步 → ${rec.phases}Phase | ${(rec.sizeBytes / 1024).toFixed(1)}KB | ${rec.lastUpdatedAt.slice(0, 16)} | readerIndex=${indexStatus}`);
        if (readerIndex?.blocks) {
            lines.push(`     🔎 sections: ${Object.entries(sectionCounts).filter(([, count]) => count > 0).map(([type, count]) => `${type}:${count}`).join(", ")}`);
        }
        if (rec.tags && rec.tags.length > 0) {
            lines.push(`     🏷 ${rec.tags.join(", ")}`);
        }
    }
    if (records.length === 0) lines.push("  (无 Record)");
    return rt(lines.join("\n"), startMs);
}

// ============= read =============

async function handleRead(
    hash: string, conversationId: string | undefined,
    startLine: number | undefined, endLine: number | undefined, startMs: number,
    options: {
        view?: RecordReaderView;
        phaseIds?: Array<string | number>;
        startBlockId?: string;
        sectionTypes?: RecordSectionType[];
        include?: RecordSectionType[];
        exclude?: RecordSectionType[];
        maxChars?: number;
        format?: RecordReadFormat;
        withCitations?: boolean;
        indexMode?: RecordReaderIndexMode;
    } = {},
) {
    if (!conversationId) return rt("❌ read 需要 conversationId 参数", startMs);

    const location = resolveRecordLocation(hash, conversationId);
    if (!location) return rt(`❌ 未找到 ${conversationId} 的 Record`, startMs);
    const { conversationId: resolvedId, content } = location;
    const hasStructuredRead = Boolean(
        options.view && options.view !== "raw"
        || options.phaseIds?.length
        || options.sectionTypes?.length
        || options.include?.length
        || options.exclude?.length
        || options.indexMode
    );

    if (!hasStructuredRead && (startLine !== undefined || endLine !== undefined)) {
        const lines = content.split(/\r?\n/);
        const s = Math.max(1, startLine || 1);
        const e = Math.min(lines.length, endLine || lines.length);
        const slice = lines.slice(s - 1, e).join("\n");
        return rt(`📄 Record ${resolvedId.slice(0, 8)}... (行 ${s}-${e}/${lines.length}):\n\n${slice}`, startMs);
    }

    if (!hasStructuredRead) {
        if (content.length > 8000) {
            const tmpPath = saveTempFile("record", resolvedId.slice(0, 8), content);
            return rt(`📄 Record ${resolvedId.slice(0, 8)}... (${content.split(/\r?\n/).length}行, ${(Buffer.byteLength(content) / 1024).toFixed(1)}KB)\n已保存到临时文件: ${tmpPath}\n请用 view_file 查看。`, startMs);
        }

        return rt(`📄 Record ${resolvedId.slice(0, 8)}...:\n\n${content}`, startMs);
    }

    const { index, indexStatus } = await readOrBuildReaderIndex(location.hash, resolvedId, content, options.indexMode || "auto");
    const coverageWarning = recordCoverageWarning(location.hash, resolvedId, content);
    if (options.view === "outline") {
        const outline = buildOutline(index);
        const payload = { recordId: resolvedId, hash: location.hash, indexStatus, view: "outline", warning: coverageWarning || undefined, outline };
        if (options.format === "json") return rt(JSON.stringify(payload, null, 2), startMs);
        return rt(`📚 Record Outline ${resolvedId.slice(0, 8)}... (${indexStatus})${coverageWarning ? `\n${coverageWarning}` : ""}\n\n${JSON.stringify(outline, null, 2)}`, startMs);
    }

    const viewOptions: FormatReaderViewOptions = {
        view: options.view || (options.phaseIds?.length ? "phase" : "custom"),
        phaseIds: options.phaseIds,
        startBlockId: options.startBlockId,
        sectionTypes: normalizeSectionTypes(options.sectionTypes),
        include: normalizeSectionTypes(options.include),
        exclude: normalizeSectionTypes(options.exclude),
        maxChars: options.maxChars,
        format: options.format,
        withCitations: options.withCitations,
    };
    const result = formatReaderView(index, viewOptions);
    if (options.format === "json") {
        const selected = selectRecordReaderBlocks(index, viewOptions);
        return rt(JSON.stringify({
            recordId: resolvedId,
            hash: location.hash,
            indexStatus,
            warning: coverageWarning || undefined,
            view: viewOptions.view,
            truncated: selected.truncated,
            truncatedReason: selected.truncatedReason,
            nextReadHint: selected.nextReadHint,
            matchedBlockCount: selected.totalBlocks,
            returnedBlockCount: selected.blocks.length,
            blockCount: selected.blocks.length,
            blocks: selected.blocks.map(block => ({
                id: block.id,
                phaseId: block.phaseId,
                sectionType: block.sectionType,
                title: block.title,
                lineRange: block.lineRange,
                charRange: block.charRange,
                text: block.text,
            })),
        }, null, 2), startMs);
    }

    if (!result.text) {
        if (result.truncated) {
            return rt(`⚠️ Record ${resolvedId.slice(0, 8)}... 结构化读取命中区块，但当前 maxChars 太小，未返回正文（index=${indexStatus}）${coverageWarning ? `\n${coverageWarning}` : ""}\n${result.nextReadHint}`, startMs);
        }
        return rt(`📭 Record ${resolvedId.slice(0, 8)}... 结构化读取无匹配区块（index=${indexStatus}）${coverageWarning ? `\n${coverageWarning}` : ""}`, startMs);
    }
    const suffix = result.truncated ? `\n\n⚠️ 已按 block 边界截断：${result.nextReadHint}` : "";
    if (result.text.length > 8000 && !options.maxChars) {
        const tmpPath = saveTempFile("record-reader", resolvedId.slice(0, 8), result.text);
        return rt(`📄 Record ${resolvedId.slice(0, 8)}... 结构化读取结果过长，已保存结构化结果到临时文件: ${tmpPath}${coverageWarning ? `\n${coverageWarning}` : ""}\n建议补传 maxChars / phaseIds / sectionTypes 缩小读取范围。`, startMs);
    }
    return rt(`📄 Record ${resolvedId.slice(0, 8)}... 结构化读取 (${viewOptions.view}, index=${indexStatus})${coverageWarning ? `\n${coverageWarning}` : ""}\n\n${result.text}${suffix}`, startMs);
}

// ============= search =============

async function handleSearch(
    hash: string,
    query: string | undefined,
    scope: RecordManageScope | undefined,
    includeGeneral: boolean | undefined,
    mode: "auto" | "exact" | "fuzzy" | "smart" | undefined,
    chain: Chain,
    startMs: number,
    options: {
        conversationId?: string;
        recordIds?: string[];
        phaseIds?: Array<string | number>;
        sectionTypes?: RecordSectionType[];
        searchScope?: RecordSearchScope;
        maxChars?: number;
        format?: RecordReadFormat;
        indexMode?: RecordReaderIndexMode;
        limit?: number;
    } = {},
) {
    if (!query) return rt("❌ search 需要 query 参数", startMs);

    const hasStructuredSearch = Boolean(
        options.conversationId
        || options.recordIds?.length
        || options.phaseIds?.length
        || options.sectionTypes?.length
        || options.searchScope
        || options.format === "json"
        || options.maxChars
        || options.indexMode
    );

    const blocks = hasStructuredSearch
        ? await buildStructuredRecordSearchBlocks(hash, scope, includeGeneral === true, options)
        : buildRecordSearchBlocksForScope(hash, scope, includeGeneral === true);

    if (blocks.length === 0) return rt("📭 当前工作区无 Record", startMs);

    let results = await search(blocks, query, { mode: mode || "auto", limit: options.limit || 10, chain });
    if ((mode || "auto") === "auto" && results.length === 0) {
        results = await search(blocks, query, { mode: "smart", limit: options.limit || 10, chain });
    }

    if (results.length === 0) return rt(`🔍 搜索 "${query}" — 无匹配`, startMs);

    if (hasStructuredSearch) {
        return rt(formatStructuredSearchResults(query, results, options.format || "text", options.maxChars), startMs);
    }

    const lines = [`🔍 搜索 "${query}" — ${results.length} 份 Record 命中 (${results[0].matchType} 模式):\n`];
    for (const rec of results.slice(0, 5)) {
        lines.push(`📝 ${rec.id} | ${rec.title} (${rec.matchType}, score: ${rec.score.toFixed(2)})`);
        for (const m of rec.matches.slice(0, 3)) {
            const lineInfo = m.lineNum ? `L${m.lineNum}: ` : "";
            lines.push(`  ${lineInfo}${m.line.trim().slice(0, 100)}`);
        }
    }
    return rt(lines.join("\n"), startMs);
}

interface RecordSearchTarget {
    hash: string;
    conversationId: string;
    title: string;
    tags?: string[];
    updatedAt?: number;
    content: string;
}

function collectRecordSearchTargets(
    hash: string,
    scope: RecordManageScope | undefined,
    includeGeneral: boolean,
    conversationId?: string,
    recordIds?: string[],
): RecordSearchTarget[] {
    const ids = [...(conversationId ? [conversationId] : []), ...(recordIds || [])].filter(Boolean);
    if (ids.length > 0) {
        const targets: RecordSearchTarget[] = [];
        for (const id of ids) {
            const location = resolveRecordLocation(hash, id);
            if (!location) continue;
            const entry = readRecordsIndex(location.hash).records[location.conversationId];
            targets.push({
                hash: location.hash,
                conversationId: location.conversationId,
                title: entry?.title || location.conversationId,
                tags: entry?.tags || [],
                updatedAt: Date.parse(entry?.lastUpdatedAt || "") || 0,
                content: location.content,
            });
        }
        return dedupeSearchTargets(targets);
    }

    const targets: RecordSearchTarget[] = [];
    for (const h of recordHashesForScope(hash, scope, includeGeneral)) {
        const index = readRecordsIndex(h);
        for (const entry of Object.values(index.records)) {
            if (isSupersededRecord(h, entry.conversationId)) continue;
            const content = readRecord(h, entry.conversationId);
            if (!content) continue;
            targets.push({
                hash: h,
                conversationId: entry.conversationId,
                title: entry.title,
                tags: entry.tags || [],
                updatedAt: Date.parse(entry.lastUpdatedAt || "") || 0,
                content,
            });
        }
    }
    return dedupeSearchTargets(targets);
}

function dedupeSearchTargets(targets: RecordSearchTarget[]): RecordSearchTarget[] {
    const map = new Map<string, RecordSearchTarget>();
    for (const target of targets) {
        const existing = map.get(target.conversationId);
        if (!existing || compareRecordCandidate(
            { hash: target.hash, conversationId: target.conversationId, content: target.content },
            { hash: existing.hash, conversationId: existing.conversationId, content: existing.content },
        ) > 0) {
            map.set(target.conversationId, target);
        }
    }
    return Array.from(map.values());
}

export async function buildStructuredRecordSearchBlocks(
    hash: string,
    scope: RecordManageScope | undefined,
    includeGeneral = false,
    options: {
        conversationId?: string;
        recordIds?: string[];
        phaseIds?: Array<string | number>;
        sectionTypes?: RecordSectionType[];
        searchScope?: RecordSearchScope;
        indexMode?: RecordReaderIndexMode;
    } = {},
): Promise<TextBlock[]> {
    const blocks: TextBlock[] = [];
    const targets = collectRecordSearchTargets(hash, scope, includeGeneral, options.conversationId, options.recordIds);
    for (const target of targets) {
        const { index, indexStatus } = await readOrBuildReaderIndex(target.hash, target.conversationId, target.content, options.indexMode || "auto");
        const selected = blocksForSearchScope(index, options.searchScope || "section")
            .filter(block => matchesPhaseAndSection(block, options.phaseIds, options.sectionTypes));
        for (const block of selected) {
            const phaseLabel = block.phaseId || "tail";
            blocks.push({
                id: `${target.conversationId}:${block.id}`,
                title: `${target.title} / ${phaseLabel} / ${block.title || block.sectionType}`,
                content: block.text,
                tags: [...(target.tags || []), block.sectionType, phaseLabel],
                metadata: {
                    hash: target.hash,
                    recordId: target.conversationId,
                    conversationId: target.conversationId,
                    recordTitle: target.title,
                    blockId: block.id,
                    phaseId: block.phaseId,
                    sectionType: block.sectionType,
                    lineRange: block.lineRange,
                    charRange: block.charRange,
                    indexStatus,
                    readHint: {
                        action: "read",
                        conversationId: target.conversationId,
                        view: block.phaseId ? "phase" : "custom",
                        phaseIds: block.phaseId ? [block.phaseId] : undefined,
                        sectionTypes: [block.sectionType],
                        withCitations: true,
                    },
                },
            });
        }
    }
    return blocks;
}

function blocksForSearchScope(index: RecordReaderIndex, searchScope: RecordSearchScope): ReaderBlock[] {
    if (searchScope === "record") {
        return [{
            id: "record",
            blockId: "record",
            kind: "block",
            sectionType: "unknown",
            title: index.title || index.recordId,
            heading: index.title || index.recordId,
            text: index.blocks.map(block => block.text).join("\n\n"),
            lineRange: { start: 1, end: index.totalLines },
            charRange: { start: 0, end: index.totalChars },
            lineStart: 1,
            lineEnd: index.totalLines,
            charStart: 0,
            charEnd: index.totalChars,
            textPreview: index.title || index.recordId,
        }];
    }
    if (searchScope === "phase") {
        return index.phases.map(phase => {
            const phaseBlocks = index.blocks.filter(block => block.phaseId === phase.id);
            return {
                id: phase.id,
                blockId: phase.id,
                kind: "phase",
                phaseId: phase.id,
                sectionType: "phase_title",
                title: phase.title,
                heading: phase.title,
                text: phaseBlocks.map(block => block.text).join("\n\n"),
                lineRange: phase.lineRange,
                charRange: phase.charRange,
                lineStart: phase.lineStart,
                lineEnd: phase.lineEnd,
                charStart: phase.charStart,
                charEnd: phase.charEnd,
                textPreview: phase.textPreview,
            } satisfies ReaderBlock;
        });
    }
    return index.blocks.filter(block => searchScope === "item" ? block.sectionType !== "phase_title" && block.sectionType !== "header" : true);
}

function matchesPhaseAndSection(block: ReaderBlock, phaseIds?: Array<string | number>, sectionTypes?: RecordSectionType[]): boolean {
    if (phaseIds?.length) {
        const blockPhaseNumber = block.phaseId ? Number(block.phaseId.replace(/^phase-/u, "")) : undefined;
        const phaseMatch = block.phaseId && phaseIds.some(phaseId => phaseId === block.phaseId || phaseId === blockPhaseNumber || String(phaseId) === block.phaseId);
        if (!phaseMatch) return false;
    }
    if (sectionTypes?.length && !sectionTypes.includes(block.sectionType)) return false;
    return true;
}

function formatStructuredSearchResults(query: string, results: SearchResult[], format: RecordReadFormat, maxChars?: number): string {
    const payload = {
        query,
        count: results.length,
        results: results.map(result => ({
            id: result.id,
            title: result.title,
            score: result.score,
            matchType: result.matchType,
            matches: result.matches.slice(0, 3),
            provenance: {
                recordId: result.metadata?.recordId,
                blockId: result.metadata?.blockId,
                phaseId: result.metadata?.phaseId,
                sectionType: result.metadata?.sectionType,
                lineRange: result.metadata?.lineRange,
                charRange: result.metadata?.charRange,
            },
            readHint: result.metadata?.readHint,
        })),
    };
    if (format === "json") return JSON.stringify(payload, null, 2);

    const lines = [`🔍 结构化搜索 "${query}" — ${results.length} 个区块命中 (${results[0].matchType} 模式):\n`];
    let used = lines.join("\n").length;
    for (const result of results) {
        const meta = result.metadata || {};
        const itemLines = [
            `🧩 ${meta.recordId || result.id} / ${meta.phaseId || "record"} / ${meta.sectionType || "unknown"} (${result.matchType}, score: ${result.score.toFixed(2)})`,
            `   block=${meta.blockId || result.id} L${meta.lineRange?.start ?? "?"}-${meta.lineRange?.end ?? "?"}`,
            `   readHint=${JSON.stringify(meta.readHint)}`,
            ...result.matches.slice(0, 2).map(match => `   ${match.lineNum ? `L${match.lineNum}: ` : ""}${match.line.trim().slice(0, 160)}`),
        ];
        const chunk = `${itemLines.join("\n")}\n`;
        if (maxChars && used + chunk.length > maxChars) {
            lines.push(`⚠️ 已截断，增加 maxChars 或缩小 phaseIds/sectionTypes 可继续读取`);
            break;
        }
        lines.push(chunk);
        used += chunk.length;
    }
    return lines.join("\n");
}

export async function handleGuide(
    hash: string,
    conversationId: string | undefined,
    recordIds: string[] | undefined,
    scope: RecordManageScope | undefined,
    includeGeneral: boolean | undefined,
    goal: string | undefined,
    maxRecommendations: number | undefined,
    chain: Chain,
    startMs: number,
    options: {
        phaseIds?: Array<string | number>;
        sectionTypes?: RecordSectionType[];
        maxChars?: number;
        format?: RecordReadFormat;
        indexMode?: RecordReaderIndexMode;
        background?: boolean;
    } = {},
) {
    if (options.background) {
        const task = startBackgroundTask("record-guide", async () => {
            const result = await handleGuide(hash, conversationId, recordIds, scope, includeGeneral, goal, maxRecommendations, chain, Date.now(), { ...options, background: false });
            return responseText(result);
        });
        return rt([
            "🚀 Record guide 已转入后台任务",
            `🆔 taskId: ${task.id}`,
            `🧭 goal: ${goal || "(未提供，输出默认阅读路线)"}`,
            "💡 后续调用 record_manage(action=\"task_status\", taskId=\"...\") 查询结果",
        ].join("\n"), startMs);
    }

    const recommendations = await buildRecordGuideRecommendations(hash, scope, includeGeneral === true, {
        conversationId,
        recordIds,
        goal,
        phaseIds: options.phaseIds,
        sectionTypes: options.sectionTypes,
        maxRecommendations,
        indexMode: options.indexMode,
        chain,
    });
    const payload = {
        goal: goal || null,
        note: "guide 只给阅读路线、搜索路线和来源定位；不生成 Record 事实摘要，也不作为新的事实源。",
        recommendations,
    };
    if (options.format === "json") return rt(JSON.stringify(payload, null, 2), startMs);

    const lines = [
        `🧭 Record guide${goal ? `: ${goal}` : ""}`,
        "说明：这里只给 read/search 建议和来源，不替代正式 Record。",
        "",
    ];
    for (const [index, rec] of recommendations.entries()) {
        const chunk = [
            `${index + 1}. ${rec.type.toUpperCase()} — ${rec.reason}`,
            rec.readHint ? `   readHint=${JSON.stringify(rec.readHint)}` : "",
            rec.searchHint ? `   searchHint=${JSON.stringify(rec.searchHint)}` : "",
            rec.provenance ? `   provenance=${JSON.stringify(rec.provenance)}` : "",
        ].filter(Boolean).join("\n");
        if (options.maxChars && lines.join("\n").length + chunk.length > options.maxChars) {
            lines.push("⚠️ guide 输出已截断，可提高 maxChars 或缩小目标。");
            break;
        }
        lines.push(chunk);
    }
    return rt(lines.join("\n"), startMs);
}

export async function buildRecordGuideRecommendations(
    hash: string,
    scope: RecordManageScope | undefined,
    includeGeneral: boolean,
    options: {
        conversationId?: string;
        recordIds?: string[];
        goal?: string;
        phaseIds?: Array<string | number>;
        sectionTypes?: RecordSectionType[];
        maxRecommendations?: number;
        indexMode?: RecordReaderIndexMode;
        chain?: Chain;
    } = {},
): Promise<RecordGuideRecommendation[]> {
    const max = Math.max(1, Math.min(options.maxRecommendations || 5, 12));
    const ids = options.recordIds?.length ? options.recordIds : (options.conversationId ? [options.conversationId] : undefined);
    const recommendations: RecordGuideRecommendation[] = [];

    if (options.goal) {
        const blocks = await buildStructuredRecordSearchBlocks(hash, scope, includeGeneral, {
            conversationId: options.conversationId,
            recordIds: ids,
            phaseIds: options.phaseIds,
            sectionTypes: options.sectionTypes,
            searchScope: "section",
            indexMode: options.indexMode,
        });
        const results = await search(blocks, options.goal, { mode: "auto", limit: max, chain: options.chain });
        const finalResults = results.length > 0 ? results : await search(blocks, options.goal, { mode: "smart", limit: max, chain: options.chain });
        for (const result of finalResults.slice(0, max)) {
            recommendations.push({
                type: "read",
                reason: `目标与区块匹配：${result.title}`,
                readHint: result.metadata?.readHint,
                searchHint: {
                    action: "search",
                    query: options.goal,
                    conversationId: result.metadata?.recordId,
                    phaseIds: result.metadata?.phaseId ? [result.metadata.phaseId] : undefined,
                    sectionTypes: result.metadata?.sectionType ? [result.metadata.sectionType] : undefined,
                    searchScope: "section",
                },
                provenance: {
                    recordId: result.metadata?.recordId,
                    blockId: result.metadata?.blockId,
                    phaseId: result.metadata?.phaseId,
                    sectionType: result.metadata?.sectionType,
                    lineRange: result.metadata?.lineRange,
                },
            });
        }
    }

    if (recommendations.length === 0) {
        const targets = collectRecordSearchTargets(hash, scope, includeGeneral, options.conversationId, ids);
        for (const target of targets) {
            const { index } = await readOrBuildReaderIndex(target.hash, target.conversationId, target.content, options.indexMode || "auto");
            recommendations.push({
                type: "read",
                reason: `先读目录，确认 ${target.title} 的 Phase 与结构入口`,
                readHint: { action: "read", conversationId: target.conversationId, view: "outline", format: "json" },
                provenance: { recordId: target.conversationId, hash: target.hash, phaseCount: index.phases.length, blockCount: index.blocks.length },
            });
            recommendations.push({
                type: "read",
                reason: "再读当前状态与风险，快速判断后续工作入口",
                readHint: { action: "read", conversationId: target.conversationId, view: "state", withCitations: true },
                provenance: { recordId: target.conversationId, hash: target.hash },
            });
            recommendations.push({
                type: "read",
                reason: "需要文件线索时读取产出文件区块",
                readHint: { action: "read", conversationId: target.conversationId, view: "outputs", withCitations: true },
                provenance: { recordId: target.conversationId, hash: target.hash },
            });
            if (recommendations.length >= max) break;
        }
    }

    return recommendations.slice(0, max);
}

export function buildRecordSearchBlocksForScope(hash: string, scope: RecordManageScope | undefined, includeGeneral = false) {
    // 三级搜索：构建 TextBlock 列表
    const blockMap = new Map<string, import("../search-engine.js").TextBlock>();

    const addBlocks = (h: string) => {
        const index = readRecordsIndex(h);
        for (const [convId, entry] of Object.entries(index.records) as [string, any][]) {
            if (isSupersededRecord(h, convId)) continue;
            const content = readRecord(h, convId);
            if (!content) continue;
            const existing = blockMap.get(convId);
            const updatedAt = Date.parse(entry.lastUpdatedAt || "") || 0;
            const existingUpdatedAt = existing ? Number(existing.metadata?.updatedAt || 0) : 0;
            // 同一 conversationId 可能因 workspace hash 变化存在多份 Record，优先保留最新索引。
            if (!existing || updatedAt > existingUpdatedAt || (updatedAt === existingUpdatedAt && content.length > existing.content.length)) {
                blockMap.set(convId, {
                    id: convId,
                    title: entry.title,
                    content,
                    tags: entry.tags || [],
                    metadata: { hash: h, updatedAt },
                });
            }
        }
    };

    for (const h of recordHashesForScope(hash, scope, includeGeneral)) addBlocks(h);
    return Array.from(blockMap.values());
}

// ============= ownership audit / repair =============

function collectRecordLocations(hash: string, scope: RecordManageScope | undefined) {
    const hashes = recordHashesForScope(hash, scope, false);
    const locations: Array<{ hash: string; conversationId: string; title: string; totalRounds: number; lastUpdatedRound: number; lastUpdatedAt: string; sizeBytes: number }> = [];
    for (const h of hashes) {
        const index = readRecordsIndex(h);
        for (const entry of Object.values(index.records)) {
            locations.push({
                hash: h,
                conversationId: entry.conversationId,
                title: entry.title,
                totalRounds: entry.totalRounds,
                lastUpdatedRound: entry.lastUpdatedRound,
                lastUpdatedAt: entry.lastUpdatedAt,
                sizeBytes: entry.sizeBytes,
            });
        }
    }
    return locations;
}

function betterRecordLocation<T extends { lastUpdatedAt: string; totalRounds: number; lastUpdatedRound: number; sizeBytes: number }>(items: T[]): T | null {
    return [...items].sort((a, b) => {
        const roundDiff = (b.lastUpdatedRound || b.totalRounds || 0) - (a.lastUpdatedRound || a.totalRounds || 0);
        if (roundDiff !== 0) return roundDiff;
        const updatedDiff = (Date.parse(b.lastUpdatedAt || "") || 0) - (Date.parse(a.lastUpdatedAt || "") || 0);
        if (updatedDiff !== 0) return updatedDiff;
        return (b.sizeBytes || 0) - (a.sizeBytes || 0);
    })[0] || null;
}

function canonicalHashForExistingRecordHash(hash: string): string | null {
    if (hash === "general") return "general";
    const meta = readWorkspaceMeta(hash);
    if (!meta) return null;
    return workspaceHash(meta.canonicalPath || meta.originalPath);
}

function isWorkspacePathAliasHash(currentHash: string, expectedHash: string): boolean {
    if (currentHash === "general" || currentHash === expectedHash) return false;
    return canonicalHashForExistingRecordHash(currentHash) === expectedHash;
}

async function detectOwnershipSource(conversationId: string, dataChain: DataChain): Promise<{
    expectedHash?: string;
    expectedWorkspace?: string;
    sourceType: OwnershipSourceType;
    conflict?: string;
}> {
    const sources: Array<{ hash: string; identityHash: string; workspace: string; sourceType: OwnershipSourceType }> = [];
    const allowAntigravity = dataChain === "auto" || dataChain === "antigravity";
    const allowCodex = dataChain === "auto" || dataChain === "codex";
    const allowClaudeCode = dataChain === "auto" || dataChain === "claude-code";
    const allowWindsurf = dataChain === "windsurf";

    if (allowAntigravity) {
        try {
            const steps = await fetchFirstPageSteps(conversationId);
            const workspace = steps ? detectWorkspaceFromSteps(steps) : null;
            if (workspace) sources.push({ workspace, hash: resolveWorkspaceHashForRecord(workspace), identityHash: workspaceHash(workspace), sourceType: "antigravity_workspace_uri" });
        } catch {
            // keep unknown; audit must not fail because one chain is unavailable
        }
    }

    if (allowCodex) {
        try {
            const thread = getCodexThread(conversationId);
            if (thread?.cwd) {
                sources.push({ workspace: thread.cwd, hash: resolveWorkspaceHashForRecord(thread.cwd), identityHash: workspaceHash(thread.cwd), sourceType: "codex_cwd" });
            } else {
                const parent = getCodexParentThread(conversationId);
                if (parent?.cwd) {
                    sources.push({ workspace: parent.cwd, hash: resolveWorkspaceHashForRecord(parent.cwd), identityHash: workspaceHash(parent.cwd), sourceType: "child_parent" });
                }
            }
        } catch {
            // keep unknown; audit must not fail because one chain is unavailable
        }
    }

    if (allowClaudeCode) {
        try {
            const thread = getClaudeCodeThread(conversationId);
            if (thread?.cwd) {
                sources.push({ workspace: thread.cwd, hash: resolveWorkspaceHashForRecord(thread.cwd), identityHash: workspaceHash(thread.cwd), sourceType: "claude_code_cwd" });
            }
        } catch {
            // keep unknown; audit must not fail because one chain is unavailable
        }
    }

    if (allowWindsurf) {
        try {
            const { loadWindsurfConversation } = await import("../windsurf-client.js");
            const conversation = await loadWindsurfConversation(conversationId);
            const workspace = conversation?.thread.cwd;
            if (workspace) {
                sources.push({ workspace, hash: resolveWorkspaceHashForRecord(workspace), identityHash: workspaceHash(workspace), sourceType: "windsurf_cwd" });
            }
        } catch {
            // keep unknown; audit must not fail because WSF LS is unavailable
        }
    }

    if (sources.length === 0) return { sourceType: "unknown" };
    const first = sources[0];
    const conflict = sources.find(s => s.identityHash !== first.identityHash);
    if (conflict) {
        return {
            expectedHash: first.hash,
            expectedWorkspace: first.workspace,
            sourceType: first.sourceType,
            conflict: `${first.sourceType}:${first.workspace} vs ${conflict.sourceType}:${conflict.workspace}`,
        };
    }
    return { expectedHash: first.hash, expectedWorkspace: first.workspace, sourceType: first.sourceType };
}

export async function auditRecordOwnership(
    hash: string,
    scope: RecordManageScope | undefined,
    dataChain: DataChain,
    sourceResolver: typeof detectOwnershipSource = detectOwnershipSource,
): Promise<OwnershipAuditItem[]> {
    const locations = collectRecordLocations(hash, scope);
    const byConversation = new Map<string, typeof locations>();
    for (const loc of locations) {
        const group = byConversation.get(loc.conversationId) || [];
        group.push(loc);
        byConversation.set(loc.conversationId, group);
    }

    const items: OwnershipAuditItem[] = [];
    for (const loc of locations) {
        const siblings = byConversation.get(loc.conversationId) || [loc];
        const best = betterRecordLocation(siblings);
        const detected = await sourceResolver(loc.conversationId, dataChain);

        if (detected.conflict) {
            items.push({
                conversationId: loc.conversationId,
                title: loc.title,
                currentHash: loc.hash,
                expectedHash: detected.expectedHash,
                expectedWorkspace: detected.expectedWorkspace,
                sourceType: detected.sourceType,
                status: "conflict",
                reason: `结构来源冲突：${detected.conflict}`,
                suggestedAction: "manualReview",
            });
            continue;
        }

        if (detected.expectedHash) {
            if (loc.hash === detected.expectedHash) {
                items.push({
                    conversationId: loc.conversationId,
                    title: loc.title,
                    currentHash: loc.hash,
                    expectedHash: detected.expectedHash,
                    expectedWorkspace: detected.expectedWorkspace,
                    sourceType: detected.sourceType,
                    status: "ok",
                    reason: "当前位置与结构来源一致",
                    suggestedAction: "keep",
                });
            } else if (loc.hash === "general") {
                const targetSibling = siblings.find(s => s.hash === detected.expectedHash);
                const locIsBest = best?.hash === loc.hash;
                items.push({
                    conversationId: loc.conversationId,
                    title: loc.title,
                    currentHash: loc.hash,
                    expectedHash: detected.expectedHash,
                    expectedWorkspace: detected.expectedWorkspace,
                    sourceType: detected.sourceType,
                    status: targetSibling && !locIsBest ? "duplicate" : "migratable",
                    reason: targetSibling
                        ? "general 中存在副本，目标 workspace 已有同 ID Record"
                        : "general 中 Record 可由结构来源确定目标 workspace",
                    suggestedAction: targetSibling && !locIsBest ? "archiveDuplicate" : "move",
                });
            } else if (isWorkspacePathAliasHash(loc.hash, detected.expectedHash)) {
                const targetSibling = siblings.find(s => s.hash === detected.expectedHash);
                const locIsBest = best?.hash === loc.hash;
                items.push({
                    conversationId: loc.conversationId,
                    title: loc.title,
                    currentHash: loc.hash,
                    expectedHash: detected.expectedHash,
                    expectedWorkspace: detected.expectedWorkspace,
                    sourceType: detected.sourceType,
                    status: !targetSibling || locIsBest ? "migratable" : "duplicate",
                    reason: targetSibling
                        ? "当前 Record 位于同一 workspace 的旧路径别名桶，目标 official workspace 已有同 ID Record"
                        : "当前 Record 位于同一 workspace 的旧路径别名桶，可迁回 official workspace",
                    suggestedAction: !targetSibling || locIsBest ? "move" : "archiveDuplicate",
                });
            } else {
                items.push({
                    conversationId: loc.conversationId,
                    title: loc.title,
                    currentHash: loc.hash,
                    expectedHash: detected.expectedHash,
                    expectedWorkspace: detected.expectedWorkspace,
                    sourceType: detected.sourceType,
                    status: "conflict",
                    reason: "当前位置与结构来源不一致，且不是 general 兜底副本",
                    suggestedAction: "manualReview",
                });
            }
            continue;
        }

        const nonGeneralBest = best?.hash !== "general" ? best : siblings.find(s => s.hash !== "general");
        if (loc.hash === "general" && nonGeneralBest) {
            items.push({
                conversationId: loc.conversationId,
                title: loc.title,
                currentHash: loc.hash,
                expectedHash: nonGeneralBest.hash,
                sourceType: "duplicate",
                status: "duplicate",
                reason: "同 ID 已存在非 general 副本，但无法从结构来源确认真实 workspace",
                suggestedAction: "archiveDuplicate",
            });
        } else {
            items.push({
                conversationId: loc.conversationId,
                title: loc.title,
                currentHash: loc.hash,
                sourceType: "unknown",
                status: "unknown",
                reason: "未找到 workspaceUri、Codex cwd 或 parent/root 派生关系",
                suggestedAction: "keep",
            });
        }
    }
    return items;
}

function summarizeOwnershipAudit(items: OwnershipAuditItem[], title: string): string {
    const counts = items.reduce((map, item) => {
        map.set(item.status, (map.get(item.status) || 0) + 1);
        return map;
    }, new Map<OwnershipStatus, number>());
    const lines = [
        title,
        `📊 ok=${counts.get("ok") || 0} duplicate=${counts.get("duplicate") || 0} migratable=${counts.get("migratable") || 0} conflict=${counts.get("conflict") || 0} unknown=${counts.get("unknown") || 0}`,
        "",
    ];
    for (const item of items.filter(i => i.status !== "ok").slice(0, 20)) {
        lines.push(`- ${item.status} | ${item.conversationId.slice(0, 8)} | ${item.title}`);
        lines.push(`  ${item.currentHash}${item.expectedHash ? ` → ${item.expectedHash}` : ""} | ${item.sourceType} | ${item.suggestedAction}`);
        lines.push(`  ${item.reason}`);
    }
    if (items.filter(i => i.status !== "ok").length > 20) {
        lines.push(`... 另有 ${items.filter(i => i.status !== "ok").length - 20} 条未显示`);
    }
    return lines.join("\n");
}

async function handleAuditOwnership(hash: string, scope: RecordManageScope | undefined, dataChain: DataChain, startMs: number) {
    const items = await auditRecordOwnership(hash, scope || "general", dataChain);
    return rt(summarizeOwnershipAudit(items, "🔎 Record 归属审计（只读）"), startMs);
}

async function handleRepairOwnership(hash: string, scope: RecordManageScope | undefined, dataChain: DataChain, dryRun: boolean, backup: boolean, startMs: number) {
    const { moves } = await planOwnershipRepair(hash, scope || "general", dataChain);
    if (dryRun) {
        return rt(summarizeOwnershipAudit(moves, "🧭 Record 归属修复计划（dry-run，未改文件）"), startMs);
    }

    const lines = [`🛠 Record 归属修复执行（copy/upsert，不删除来源；backup=${backup}）`];
    let moved = 0;
    for (const item of moves) {
        if (!item.expectedHash || !item.expectedWorkspace) continue;
        ensureWorkspace(item.expectedWorkspace);
        const stamp = new Date().toISOString();
        const ok = await copyRecordToHash(item.currentHash, item.expectedHash, item.conversationId, { lastUpdatedAt: stamp }, { backup });
        if (ok) {
            await writeRecordSidecar(item.currentHash, item.conversationId, RECORD_OWNERSHIP_SIDECAR, {
                status: "superseded",
                supersededBy: item.expectedHash,
                sourceType: item.sourceType,
                reason: item.reason,
                updatedAt: stamp,
            });
            moved++;
            lines.push(`✅ ${item.conversationId.slice(0, 8)} ${item.currentHash} → ${item.expectedHash}`);
        } else {
            lines.push(`❌ ${item.conversationId.slice(0, 8)} 复制失败`);
        }
    }
    if (moved === 0) lines.push("无可自动迁移项");
    lines.push("⚠️ 首版 repair 不删除或归档旧副本；duplicate 清理需后续显式 prune。");
    return rt(lines.join("\n"), startMs);
}

export async function planOwnershipRepair(
    hash: string,
    scope: RecordManageScope | undefined,
    dataChain: DataChain,
    sourceResolver: typeof detectOwnershipSource = detectOwnershipSource,
) {
    const items = await auditRecordOwnership(hash, scope || "general", dataChain, sourceResolver);
    const moves = items.filter(item => item.status === "migratable" && item.expectedHash && item.expectedWorkspace && item.suggestedAction === "move");
    return { items, moves };
}

// ============= edit =============

async function handleEdit(
    hash: string, conversationId: string | undefined,
    content: string | undefined, append: string | undefined, startMs: number,
) {
    if (!conversationId) return rt("❌ edit 需要 conversationId 参数", startMs);
    const resolvedId = resolveRecordConversationId(conversationId, hash) || conversationId;

    const existing = readRecordFallback(hash, resolvedId);
    if (!existing && !content) return rt(`❌ 未找到 ${conversationId} 的 Record，且未提供 content`, startMs);

    let newContent: string;
    if (content) {
        newContent = content;
    } else if (append) {
        newContent = (existing || "") + "\n\n" + `[手动补充] ${new Date().toISOString().slice(0, 16)}\n\n` + append;
    } else {
        return rt("❌ edit 需要 content 或 append 参数", startMs);
    }

    const phases = countPhasesInRecord(newContent);
    await writeRecord(hash, resolvedId, newContent, { phases });
    let readerIndexStatus = "rebuilt";
    try {
        await writeReaderIndexForRecord(hash, resolvedId, newContent);
    } catch (err) {
        readerIndexStatus = `error: ${err instanceof Error ? err.message : String(err)}`;
    }
    return rt(`✅ Record ${resolvedId.slice(0, 8)}... 已更新 (${phases} Phase, ${(Buffer.byteLength(newContent) / 1024).toFixed(1)}KB)\n🔎 Reader Index: ${readerIndexStatus}`, startMs);
}

// ============= delete =============

async function handleDelete(hash: string, conversationId: string | undefined, startMs: number) {
    if (!conversationId) {
        // 不传 conversationId → 清空工作区全部 Record
        return await handleBatchDelete(hash, startMs);
    }
    const resolvedId = resolveRecordConversationId(conversationId, hash) || conversationId;
    const deleted = await deleteRecord(hash, resolvedId);
    if (!deleted) return rt(`❌ 未找到 ${conversationId} 的 Record`, startMs);
    return rt(`✅ Record ${resolvedId.slice(0, 8)}... 已删除`, startMs);
}

// ============= batch_delete =============

async function handleBatchDelete(hash: string, startMs: number) {
    const records = listRecords(hash);
    if (records.length === 0) return rt("📦 该工作区下无 Record", startMs);
    let count = 0;
    for (const rec of records) {
        await deleteRecord(hash, rec.conversationId);
        count++;
    }
    return rt(`✅ 已删除 ${count} 份 Record`, startMs);
}

// ============= batch_update（后台模式）=============

interface BatchTask {
    status: "running" | "done";
    startMs: number;
    total: number;
    success: number;
    failed: number;
    skipped: number;
    current: string;  // 当前处理的对话 ID
    errors: string[];
    result?: string;
}

let _batchTask: BatchTask | null = null;

interface BatchConversationCandidate {
    id: string;
    workspace?: string;
}

async function handleBatchUpdate(
    hash: string,
    args: { after?: string; before?: string; limit?: number; force?: boolean; workspace?: string; waitSeconds?: number; chain?: ChainInput | DataChainInput; dataChain?: DataChainInput; modelChain?: ChainInput },
    startMs: number,
) {
    // check 模式：查询进度
    if (_batchTask) {
        // force=true 取消当前任务
        if (args.force && _batchTask.status === "running") {
            const elapsed = ((Date.now() - _batchTask.startMs) / 1000).toFixed(0);
            const progress = _batchTask.success + _batchTask.failed + _batchTask.skipped;
            const out = `🛑 批量更新已取消 (${progress}/${_batchTask.total})\n  ✅ ${_batchTask.success} ❌ ${_batchTask.failed} ⏭ ${_batchTask.skipped}\n  ⏱ 已用 ${elapsed}s`;
            _batchTask = null;  // 循环中 if (!_batchTask) break 会触发
            return r(out);
        }
        // waitSeconds: 等待任务完成再返回
        const ws = Math.min(Math.max(args.waitSeconds || 0, 0), 300);
        if (ws > 0 && _batchTask.status === "running") {
            await new Promise<void>(resolve => {
                const deadline = Date.now() + ws * 1000;
                const poll = () => {
                    if (!_batchTask || _batchTask.status === "done" || Date.now() >= deadline) { resolve(); return; }
                    setTimeout(poll, 2000);
                };
                poll();
            });
        }
        if (_batchTask && _batchTask.status === "running") {
            const elapsed = ((Date.now() - _batchTask.startMs) / 1000).toFixed(0);
            const progress = _batchTask.success + _batchTask.failed + _batchTask.skipped;
            return r(`⏳ 批量更新进行中 (${progress}/${_batchTask.total})\n  ✅ ${_batchTask.success} ❌ ${_batchTask.failed} ⏭ ${_batchTask.skipped}\n  🔄 当前: ${_batchTask.current}\n  ⏱ 已用 ${elapsed}s`);
        }
        // done：返回最终结果并清理
        const result = _batchTask?.result || "完成";
        _batchTask = null;
        return r(result);
    }

    // 启动模式：筛选候选对话 + 后台执行
    const maxLimit = Math.min(args.limit || 10, 50);
    const batchChains = resolveChainSplit({ chain: args.chain, dataChain: args.dataChain, modelChain: args.modelChain });
    const requestedDataChain = batchChains.dataChain;
    const requestedModelChain = batchChains.modelChain;
    const resolvedChain = await resolveConversationChain(requestedDataChain);
    if (!resolvedChain) {
        return rt(`❌ 指定 dataChain ${requestedDataChain} 当前不可用`, startMs);
    }

    let candidates: BatchConversationCandidate[] = [];
    if (resolvedChain === "antigravity") {
        const conversations = listConversationsByMtime({
            after: args.after, before: args.before, limit: maxLimit * 3,
        });
        if (conversations.length === 0) return rt("📦 无符合条件的对话", startMs);
        candidates = conversations.map(conv => ({ id: conv.id }));
    } else if (resolvedChain === "codex") {
        const afterMs = args.after ? new Date(args.after).getTime() : null;
        const beforeMs = args.before ? new Date(args.before).getTime() : null;
        const norm = (s: string) => s.replace(/\\/g, "/").toLowerCase();
        candidates = listRecentCodexThreads(maxLimit * 5)
            .filter(thread => {
                if (afterMs !== null && (thread.updatedAtMs || 0) < afterMs) return false;
                if (beforeMs !== null && (thread.updatedAtMs || 0) > beforeMs) return false;
                if (args.workspace) {
                    const threadWs = norm(thread.cwd || "");
                    const targetWs = norm(args.workspace);
                    if (!threadWs.includes(targetWs) && !targetWs.includes(threadWs)) return false;
                }
                return true;
            })
            .map(thread => ({ id: thread.id, workspace: thread.cwd }));
        if (candidates.length === 0) return rt("📦 无符合条件的对话", startMs);
    } else if (resolvedChain === "claude-code") {
        const { listRecentClaudeCodeThreads } = await import("../claude-code-client.js");
        const afterMs = args.after ? new Date(args.after).getTime() : null;
        const beforeMs = args.before ? new Date(args.before).getTime() : null;
        const norm = (s: string) => s.replace(/\\/g, "/").toLowerCase();
        candidates = listRecentClaudeCodeThreads(maxLimit * 5)
            .filter(thread => {
                if (afterMs !== null && (thread.updatedAtMs || 0) < afterMs) return false;
                if (beforeMs !== null && (thread.updatedAtMs || 0) > beforeMs) return false;
                if (args.workspace) {
                    const threadWs = norm(thread.cwd || "");
                    const targetWs = norm(args.workspace);
                    if (!threadWs.includes(targetWs) && !targetWs.includes(threadWs)) return false;
                }
                return true;
            })
            .map(thread => ({ id: thread.id, workspace: thread.cwd }));
        if (candidates.length === 0) return rt("📦 无符合条件的对话", startMs);
    } else {
        const { listRecentWindsurfThreads } = await import("../windsurf-client.js");
        const afterMs = args.after ? new Date(args.after).getTime() : null;
        const beforeMs = args.before ? new Date(args.before).getTime() : null;
        const norm = (s: string) => s.replace(/\\/g, "/").toLowerCase();
        candidates = (await listRecentWindsurfThreads(maxLimit * 5))
            .filter(thread => {
                const updatedMs = Date.parse(thread.lastModifiedTime || thread.createdTime || "") || 0;
                if (afterMs !== null && updatedMs < afterMs) return false;
                if (beforeMs !== null && updatedMs > beforeMs) return false;
                if (args.workspace && thread.cwd) {
                    const threadWs = norm(thread.cwd || "");
                    const targetWs = norm(args.workspace);
                    if (!threadWs.includes(targetWs) && !targetWs.includes(threadWs)) return false;
                }
                return true;
            })
            .map(thread => ({ id: thread.id, workspace: thread.cwd }));
        if (candidates.length === 0) return rt("📦 无符合条件的 WSF 对话", startMs);
    }

    const { readRecordsIndex } = await import("../record-store.js");
    const index = readRecordsIndex(hash);
    candidates = args.force ? candidates : candidates.filter(c => !index.records[c.id]);

    if (candidates.length === 0) return rt("📦 所有对话已有 Record（使用 force=true 强制更新）", startMs);

    // 工作区预扫描：并行检查所有候选对话的工作区归属
    if (args.workspace && resolvedChain === "antigravity") {
        const norm = (s: string) => s.replace(/\\/g, "/").toLowerCase();
        const targetWs = norm(args.workspace);
        const scanResults = await Promise.allSettled(
            candidates.map(async conv => {
                const steps = await fetchFirstPageSteps(conv.id);
                if (!steps) return null;
                const ws = detectWorkspaceFromSteps(steps);
                if (ws && (norm(ws).includes(targetWs) || targetWs.includes(norm(ws)))) return conv;
                return null;
            })
        );
        candidates = scanResults
            .filter((r): r is PromiseFulfilledResult<typeof candidates[0]> => r.status === "fulfilled" && r.value !== null)
            .map(r => r.value);
        if (candidates.length === 0) return rt(`📦 无属于 ${args.workspace} 的对话`, startMs);
    }

    candidates = candidates.slice(0, maxLimit);

    // 初始化后台任务
    _batchTask = {
        status: "running", startMs, total: candidates.length,
        success: 0, failed: 0, skipped: 0, current: "", errors: [],
    };

    // 后台异步执行（不 await），2 并发 worker 池
    (async () => {
        const CONCURRENCY = 2;
        let nextIdx = 0; // 共享任务指针

        // 单个 worker：从共享队列取任务，执行完整流程
        const worker = async (workerId: number) => {
            while (true) {
                if (!_batchTask) break;
                const idx = nextIdx++;
                if (idx >= candidates.length) break;

                const conv = candidates[idx];
                _batchTask.current = conv.id.slice(0, 8) + "...";
                try {
                    console.error(`[batch-w${workerId}] 处理 ${conv.id.slice(0, 8)}... (${idx + 1}/${candidates.length})`);
                    const t0 = Date.now();
                    const loaded = await loadConversationData(resolvedChain, conv.id, { link: "summary" });
                    const fetchMs = Date.now() - t0;
                    if (!loaded) { _batchTask.skipped++; continue; }

                    const t1 = Date.now();
                    const rounds = loaded.rounds;
                    const parseMs = Date.now() - t1;
                    if (rounds.length < 3) { _batchTask.skipped++; continue; }

                    const totalSteps = loaded.totalSteps;

                    // 自动检测对话所属工作区
                    const detectedWs = loaded.chainUsed === "antigravity"
                        ? detectWorkspaceFromSteps(loaded.trajectory?.steps || [])
                        : (conv.workspace || loaded.codexData?.thread.cwd || loaded.claudeCodeData?.thread.cwd || loaded.windsurfData?.thread.cwd || "");
                    const actualWs = detectedWs || args.workspace || "general";

                    // 工作区筛选（预扫描已过滤，这是双重保险）
                    if (args.workspace && detectedWs) {
                        const norm = (s: string) => s.replace(/\\/g, "/").toLowerCase();
                        if (!norm(detectedWs).includes(norm(args.workspace)) && !norm(args.workspace).includes(norm(detectedWs))) {
                            _batchTask.skipped++;
                            continue;
                        }
                    }

                    const actualHash = resolveWorkspaceHashForRecord(actualWs);

                    const t2 = Date.now();
                    const result = await generateRecord(actualHash, conv.id, actualWs, rounds, totalSteps, requestedModelChain);
                    const flashMs = Date.now() - t2;
                    if (!result.success || !result.content) {
                        _batchTask.failed++;
                        _batchTask.errors.push(`${conv.id.slice(0, 8)}: ${result.error || "unknown"}`);
                        continue;
                    }

                    const gate = validateRecordCandidateForWrite(result.content, conv.id, rounds.length, result.coveredRounds || rounds.length, {
                        oldRecord: readRecord(actualHash, conv.id) || "",
                    });
                    if (!gate.ok) {
                        _batchTask.failed++;
                        _batchTask.errors.push(`${conv.id.slice(0, 8)}: ${gate.error}`);
                        continue;
                    }

                    const phases = countPhasesInRecord(result.content);
                    await writeRecord(actualHash, conv.id, result.content, {
                        title: extractTitle(result.content) || `对话 ${conv.id.slice(0, 8)}`,
                        totalRounds: rounds.length,
                        totalSteps,
                        lastUpdatedRound: result.coveredRounds || rounds.length,
                        phases,
                        tags: result.tags,
                    });
                    try {
                        await writeReaderIndexForRecord(actualHash, conv.id, result.content);
                    } catch (err) {
                        console.error(`[batch-w${workerId}] reader index build failed: ${err instanceof Error ? err.message : String(err)}`);
                    }
                    _batchTask.success++;
                    const totalMs = Date.now() - t0;
                    console.error(`[batch-w${workerId}] ✅ ${conv.id.slice(0, 8)}: fetch=${(fetchMs / 1000).toFixed(1)}s parse=${(parseMs / 1000).toFixed(1)}s flash=${(flashMs / 1000).toFixed(1)}s total=${(totalMs / 1000).toFixed(1)}s (${rounds.length}轮/${totalSteps}步)`);
                } catch (err) {
                    _batchTask.failed++;
                    _batchTask.errors.push(`${conv.id.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`);
                }
            }
        };

        // 启动 worker 池
        await Promise.allSettled(
            Array.from({ length: Math.min(CONCURRENCY, candidates.length) }, (_, i) => worker(i))
        );

        // 完成
        if (_batchTask) {
            const elapsed = ((Date.now() - _batchTask.startMs) / 1000).toFixed(0);
            let out = `📦 批量更新完成\n  ✅ 成功: ${_batchTask.success} 份`;
            if (_batchTask.failed > 0) out += `\n  ❌ 失败: ${_batchTask.failed} 份`;
            if (_batchTask.skipped > 0) out += `\n  ⏭ 跳过: ${_batchTask.skipped} 份`;
            if (_batchTask.errors.length > 0) out += `\n  📋 错误: ${_batchTask.errors.join("; ")}`;
            out += `\n  📊 总耗时: ${elapsed}s`;
            _batchTask.result = out;
            _batchTask.status = "done";
            console.error(`[batch] ${out}`);
        }
    })().catch(err => {
        if (_batchTask) {
            _batchTask.result = `📦 批量更新异常终止: ${err}`;
            _batchTask.status = "done";
        }
    });

    return r(`🚀 批量更新已启动（后台处理 ${candidates.length} 个对话）\n💡 再次调用 batch_update（同参数）查看进度`);
}

// ============= 辅助 =============

function extractTitle(content: string): string | null {
    const match = content.match(/^# Record[:：]\s*(.+)$/m);
    return match ? match[1].trim() : null;
}
