/**
 * Smart Search 工具 — 三模式代码搜索
 *
 * exact:  ripgrep 精确匹配（替代 grep_search）
 * fuzzy:  tree-sitter AST 符号 + fuse.js 模糊搜索
 * smart:  语义搜索（Antigravity LS / Codex 双链路）
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { spawn, spawnSync } from "child_process";
import path from "path";
import fs from "fs";
import Fuse from "fuse.js";
import { scanDirectory, flattenSymbols, flattenFunctionBounds, type SymbolInfo, type FunctionBound, type FileIndex } from "../symbol-index.js";
import { callModelBridge, isCodexCliAvailable, type ModelChain, type ResolvedModelChain } from "../model-bridge.js";
import { startBackgroundTask, waitForBackgroundTask, formatBackgroundTask } from "../background-tasks.js";
import { normalizeOwnerId } from "../owner.js";
import { initParentLs, isLsReady } from "../ls-client.js";
import {
    DEFAULT_PROGROK_FALLBACK_MODEL,
    DEFAULT_PROGROK_REASONING_EFFORT,
    isProgrokAvailable,
    normalizeProgrokReasoningEffort,
    type ProgrokAvailability,
    type ProgrokReasoningEffort,
} from "../grok-bridge.js";

const SMART_FILES_TIMEOUT_MS = Number(process.env.SANDBOX_SMART_FILES_TIMEOUT_MS || "120000");
const SMART_STAGE1_TIMEOUT_MS = Number(process.env.SANDBOX_SMART_STAGE1_TIMEOUT_MS || "90000");
const SMART_STAGE2_TIMEOUT_MS = Number(process.env.SANDBOX_SMART_STAGE2_TIMEOUT_MS || "120000");
const SMART_CODEX_FILES_TIMEOUT_MS = Number(process.env.SANDBOX_SMART_CODEX_FILES_TIMEOUT_MS || "45000");
const SMART_CODEX_STAGE_TIMEOUT_MS = Number(process.env.SANDBOX_SMART_CODEX_STAGE_TIMEOUT_MS || "15000");
const SMART_CODEX_BACKGROUND_FILES_TIMEOUT_MS = Number(process.env.SANDBOX_SMART_CODEX_BACKGROUND_FILES_TIMEOUT_MS || 5 * 60_000);
const SMART_CODEX_BACKGROUND_STAGE_TIMEOUT_MS = Number(process.env.SANDBOX_SMART_CODEX_BACKGROUND_STAGE_TIMEOUT_MS || "15000");
const SMART_CLAUDE_CODE_FILES_TIMEOUT_MS = Number(process.env.SANDBOX_SMART_CLAUDE_CODE_FILES_TIMEOUT_MS || 2 * 60_000);
const SMART_CLAUDE_CODE_STAGE_TIMEOUT_MS = Number(process.env.SANDBOX_SMART_CLAUDE_CODE_STAGE_TIMEOUT_MS || 90_000);
const SMART_CLAUDE_CODE_BACKGROUND_FILES_TIMEOUT_MS = Number(process.env.SANDBOX_SMART_CLAUDE_CODE_BACKGROUND_FILES_TIMEOUT_MS || 5 * 60_000);
const SMART_CLAUDE_CODE_BACKGROUND_STAGE_TIMEOUT_MS = Number(process.env.SANDBOX_SMART_CLAUDE_CODE_BACKGROUND_STAGE_TIMEOUT_MS || 2 * 60_000);
const SMART_GROK_TIMEOUT_MS = Number(process.env.SANDBOX_SMART_GROK_TIMEOUT_MS || 30_000);
const SMART_GROK_REASONING_EFFORT = normalizeProgrokReasoningEffort(
    process.env.SANDBOX_SMART_GROK_REASONING_EFFORT,
    DEFAULT_PROGROK_REASONING_EFFORT,
);
const SMART_GROK_FALLBACK_MODEL = (process.env.SANDBOX_SMART_GROK_FALLBACK_MODEL || DEFAULT_PROGROK_FALLBACK_MODEL).trim() || DEFAULT_PROGROK_FALLBACK_MODEL;
const SMART_BACKGROUND_MAX_RUN_MS = Number(process.env.SANDBOX_SMART_BACKGROUND_MAX_RUN_MS || 15 * 60_000);
const SMART_DEFAULT_MAX_RESULTS = Math.max(1, Number(process.env.SANDBOX_SMART_DEFAULT_MAX_RESULTS || "12"));
const SMART_LOCAL_EVIDENCE_SKIP_THRESHOLD = Math.max(0, Number(process.env.SANDBOX_SMART_LOCAL_EVIDENCE_SKIP_THRESHOLD || "8"));
const SMART_LOCAL_EVIDENCE_EXPLORATION_UNITS = Math.max(0, Number(process.env.SANDBOX_SMART_LOCAL_EVIDENCE_EXPLORATION_UNITS || "2"));
const SMART_CHAIN_RETRY_ATTEMPTS = Math.max(1, Math.min(3, Number(process.env.SANDBOX_SMART_CHAIN_RETRY_ATTEMPTS || "2")));
const SMART_CHAIN_RETRY_TIMEOUT_FACTOR = Math.min(1, Math.max(0.1, Number(process.env.SANDBOX_SMART_CHAIN_RETRY_TIMEOUT_FACTOR || "0.5")));
const SMART_INDEX_SPLIT_MAX_CHARS = Math.max(1000, Number(process.env.SANDBOX_SMART_INDEX_SPLIT_MAX_CHARS || "4000"));
const SMART_DEEP_MAX_UNITS = Math.max(1, Number(process.env.SANDBOX_SMART_DEEP_MAX_UNITS || "8"));
const MODEL_CHAIN_VALUES = ["auto", "grok", "antigravity", "codex", "claude-code", "cc"] as const;
type SmartModelPhase = "files" | "index" | "broad" | "deep";

interface SmartBridgeOptions extends Record<string, unknown> {
    signal?: AbortSignal;
    reasoningEffort?: ProgrokReasoningEffort;
    fallbackModel?: string | false;
}
function resolveModelChainParam(chain?: ModelChain, modelChain?: ModelChain): ModelChain {
    return modelChain ?? chain ?? "auto";
}

export interface SmartChainAvailability {
    grok: ProgrokAvailability;
    antigravity: { ok: boolean; detail: string };
    codex: { ok: boolean; detail: string };
}

export interface SmartConcurrencySelection {
    primary: Exclude<ModelChain, "auto" | "cc">;
    concurrency: number;
    fallback: Array<Exclude<ModelChain, "auto" | "cc">>;
}

export async function detectAvailableChains(): Promise<SmartChainAvailability> {
    const grok = await isProgrokAvailable();
    await initParentLs().catch(() => undefined);
    const antigravityOk = isLsReady();
    const codexOk = await isCodexCliAvailable();
    return {
        grok,
        antigravity: {
            ok: antigravityOk,
            detail: antigravityOk ? "Antigravity LS ready" : "Antigravity LS unavailable",
        },
        codex: {
            ok: codexOk,
            detail: codexOk ? "codex CLI available" : "codex CLI unavailable",
        },
    };
}

export function selectConcurrency(availability: SmartChainAvailability): SmartConcurrencySelection {
    if (availability.grok.ok) {
        return { primary: "grok", concurrency: 20, fallback: ["antigravity", "codex"] };
    }
    if (availability.antigravity.ok) {
        return { primary: "antigravity", concurrency: 6, fallback: ["codex"] };
    }
    if (availability.codex.ok) {
        return { primary: "codex", concurrency: 8, fallback: [] };
    }
    return { primary: "codex", concurrency: 1, fallback: [] };
}

async function resolveSmartExecutionChain(requested: ModelChain): Promise<SmartConcurrencySelection> {
    const normalized = requested === "cc" ? "claude-code" : requested;
    if (normalized !== "auto") {
        return {
            primary: normalized as Exclude<ModelChain, "auto" | "cc">,
            concurrency: normalized === "grok" ? 20 : normalized === "codex" ? 8 : 4,
            fallback: [],
        };
    }

    const availability = await detectAvailableChains();
    const selection = selectConcurrency(availability);
    if (selection.primary === "codex" && !availability.codex.ok) {
        throw new Error(`auto 链路解析失败：Grok=${availability.grok.status}，Antigravity=${availability.antigravity.detail}，Codex=${availability.codex.detail}`);
    }
    return selection;
}

export function shouldRunSmartInBackground(args: { mode?: string; background?: boolean; queries?: unknown[]; taskId?: string }): boolean {
    if (args.background === false) return false;
    if (args.taskId) return false;
    if (args.queries && args.queries.length > 0) return false;
    return args.background === true || args.mode === "smart";
}

function assertNotAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
        throw new Error("smart_search 后台任务已取消：background abort");
    }
}

// ===== ripgrep 路径发现 =====

let rgPath: string | null = null;

function findRipgrep(): string | null {
    if (rgPath !== null) return rgPath;
    if (/^(1|true|yes)$/iu.test(process.env.SANDBOX_TEST_DISABLE_RG || "")) {
        rgPath = "";
        return null;
    }

    // 1. PATH 中的 rg
    try {
        const probe = spawnSync("rg", ["--version"], {
            stdio: "ignore",
            timeout: 3000,
            windowsHide: true,
            shell: false,
        });
        if (probe.status === 0) {
            rgPath = "rg";
            return rgPath;
        }
    } catch { /* not in PATH */ }

    // 2. Antigravity 内置 rg
    const candidates = [
        path.join(process.env.LOCALAPPDATA || "", "Programs", "Antigravity", "resources", "app", "node_modules", "@vscode", "ripgrep", "bin", "rg.exe"),
    ];
    for (const p of candidates) {
        if (fs.existsSync(p)) {
            rgPath = p;
            return rgPath;
        }
    }

    rgPath = "";  // 标记为已查找但未找到
    return null;
}

// ===== exact 模式 =====

interface ExactResult {
    file: string;
    line: number;
    content: string;
    contextBefore?: string[];
    contextAfter?: string[];
}

async function searchExact(
    query: string,
    searchPath: string,
    opts: {
        caseSensitive?: boolean;
        isRegex?: boolean;
        matchPerLine?: boolean;
        context?: number;
        includes?: string[];
        excludes?: string[];
        maxResults?: number;
        signal?: AbortSignal;
    }
): Promise<{ results: ExactResult[]; fileOnly: string[]; engine: string }> {
    assertNotAborted(opts.signal);
    const rg = findRipgrep();
    if (rg) {
        return searchWithRipgrep(rg, query, searchPath, opts);
    }
    return searchWithNodeFallback(query, searchPath, opts);
}

async function searchWithRipgrep(
    rgBin: string,
    query: string,
    searchPath: string,
    opts: any
): Promise<{ results: ExactResult[]; fileOnly: string[]; engine: string }> {
    const args: string[] = ["--json"];

    if (!opts.caseSensitive) args.push("-i");
    if (!opts.isRegex) args.push("--fixed-strings");
    if (opts.context) args.push("-C", String(opts.context));
    if (opts.maxResults) args.push("--max-count", String(opts.maxResults));

    // 排除
    const excludes = opts.excludes || [
        "node_modules", "dist", ".git", "__pycache__",
        ".next", ".nuxt", "build", "out", ".cache",
        "vendor", "target", ".tox", "*.min.js", "*.map",
        "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
    ];
    for (const e of excludes) args.push("--glob", `!${e}`);

    // 包含
    if (opts.includes) {
        for (const i of opts.includes) args.push("--glob", i);
    }

    args.push("--", query, searchPath);

    return new Promise((resolve) => {
        const child = spawn(rgBin, args, { timeout: 30000 });
        let stdout = "";
        let stderr = "";

        const onAbort = () => {
            try { child.kill(); } catch { /* ignore */ }
            resolve({ results: [], fileOnly: [], engine: "ripgrep (cancelled)" });
        };
        opts.signal?.addEventListener("abort", onAbort, { once: true });

        child.stdout.on("data", (d: Buffer) => { stdout += d.toString("utf-8"); });
        child.stderr.on("data", (d: Buffer) => { stderr += d.toString("utf-8"); });
        child.on("close", (code) => {
            opts.signal?.removeEventListener("abort", onAbort);
            // 非法正则等错误：rg 返回非 0/1 exit code
            if (code && code > 1 && stderr) {
                resolve({
                    results: [{ file: "(error)", line: 0, content: `ripgrep error: ${stderr.substring(0, 200)}` }],
                    fileOnly: [],
                    engine: `ripgrep (exit ${code})`,
                });
                return;
            }
            const results: ExactResult[] = [];
            const fileSet = new Set<string>();

            for (const line of stdout.split("\n").filter(Boolean)) {
                try {
                    const obj = JSON.parse(line);
                    if (obj.type === "match") {
                        const d = obj.data;
                        const file = d.path?.text || "";
                        fileSet.add(file);
                        if (opts.matchPerLine !== false) {
                            results.push({
                                file,
                                line: d.line_number,
                                content: d.lines?.text?.trimEnd() || "",
                            });
                        }
                    }
                } catch { /* skip malformed */ }
            }

            resolve({
                results: results.slice(0, opts.maxResults || 50),
                fileOnly: [...fileSet],
                engine: "ripgrep",
            });
        });

        child.on("error", () => {
            opts.signal?.removeEventListener("abort", onAbort);
            resolve({ results: [], fileOnly: [], engine: "ripgrep (error)" });
        });
    });
}

async function searchWithNodeFallback(
    query: string,
    searchPath: string,
    opts: any
): Promise<{ results: ExactResult[]; fileOnly: string[]; engine: string }> {
    const results: ExactResult[] = [];
    const fileSet = new Set<string>();
    const maxResults = opts.maxResults || 50;
    const regex = opts.isRegex
        ? new RegExp(query, opts.caseSensitive ? "g" : "gi")
        : null;

    function searchDir(dir: string): void {
        assertNotAborted(opts.signal);
        if (results.length >= maxResults) return;
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

        const excludes = opts.excludes || [
            "node_modules", "dist", ".git", "__pycache__",
            ".next", ".nuxt", "build", "out", ".cache",
            "vendor", "target", ".tox",
        ];
        const includes = opts.includes as string[] | undefined;
        for (const entry of entries) {
            assertNotAborted(opts.signal);
            if (results.length >= maxResults) break;
            if (excludes.includes(entry.name)) continue;

            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                searchDir(fullPath);
            } else if (entry.isFile()) {
                // includes 过滤
                if (includes && includes.length > 0) {
                    const ext = path.extname(entry.name);
                    const matched = includes.some(p => {
                        if (p.startsWith("*.")) return ext === p.substring(1);
                        return entry.name.includes(p);
                    });
                    if (!matched) continue;
                }
                try {
                    const content = fs.readFileSync(fullPath, "utf-8");
                    const lines = content.split("\n");
                    for (let i = 0; i < lines.length && results.length < maxResults; i++) {
                        const match = regex
                            ? regex.test(lines[i])
                            : opts.caseSensitive
                                ? lines[i].includes(query)
                                : lines[i].toLowerCase().includes(query.toLowerCase());
                        if (match) {
                            fileSet.add(fullPath);
                            if (opts.matchPerLine !== false) {
                                results.push({ file: fullPath, line: i + 1, content: lines[i].trimEnd() });
                            }
                        }
                        if (regex) regex.lastIndex = 0;
                    }
                } catch { /* skip binary files */ }
            }
        }
    }

    searchDir(searchPath);
    return { results, fileOnly: [...fileSet], engine: "node-fallback (降级模式)" };
}

// ===== fuzzy 模式 =====

async function searchFuzzy(
    query: string,
    searchPath: string,
    opts: { includes?: string[]; excludes?: string[]; maxResults?: number; signal?: AbortSignal }
): Promise<Array<SymbolInfo & { file: string; score: number }>> {
    assertNotAborted(opts.signal);
    const index = await scanDirectory(searchPath, {
        includes: opts.includes,
        excludes: opts.excludes,
    });
    assertNotAborted(opts.signal);

    const allSymbols = flattenSymbols(index);
    const fuse = new Fuse(allSymbols, {
        keys: ["name"],
        threshold: 0.4,
        distance: 100,
        includeScore: true,
        includeMatches: true,
    });

    const results = fuse.search(query, { limit: opts.maxResults || 20 });
    return results.map(r => ({
        ...r.item,
        score: 1 - (r.score || 0),  // 转换为相似度（1=完全匹配）
    }));
}

// ===== smart 模式 =====

async function searchSmart(
    query: string,
    searchPath: string,
    opts: {
        modelChain?: ModelChain;
        chain?: ModelChain;
        includes?: string[];
        excludes?: string[];
        maxResults?: number;
        files?: Array<{ path: string; range?: string }>;
        background?: boolean;
        signal?: AbortSignal;
    }
): Promise<{ chainUsed: ResolvedModelChain; text: string }> {
    assertNotAborted(opts.signal);
    // 入口1：有 files 参数 → 直接读文件分析
    if (opts.files && opts.files.length > 0) {
        return smartWithFiles(query, searchPath, opts.files, resolveModelChainParam(opts.chain, opts.modelChain), opts.background, opts.signal);
    }
    // 入口2：两阶段自动定位
    return smartTwoStage(query, searchPath, opts);
}

function smartTimeoutFor(chain: ResolvedModelChain | ModelChain, phase: SmartModelPhase, background = false): number {
    const normalized = chain === "cc" ? "claude-code" : chain;
    if (normalized === "grok") return SMART_GROK_TIMEOUT_MS;
    if (normalized === "codex") {
        if (phase === "files") return background ? SMART_CODEX_BACKGROUND_FILES_TIMEOUT_MS : SMART_CODEX_FILES_TIMEOUT_MS;
        return background ? SMART_CODEX_BACKGROUND_STAGE_TIMEOUT_MS : SMART_CODEX_STAGE_TIMEOUT_MS;
    }
    if (normalized === "claude-code") {
        if (phase === "files") return background ? SMART_CLAUDE_CODE_BACKGROUND_FILES_TIMEOUT_MS : SMART_CLAUDE_CODE_FILES_TIMEOUT_MS;
        return background ? SMART_CLAUDE_CODE_BACKGROUND_STAGE_TIMEOUT_MS : SMART_CLAUDE_CODE_STAGE_TIMEOUT_MS;
    }
    return phase === "deep" ? SMART_STAGE2_TIMEOUT_MS : SMART_STAGE1_TIMEOUT_MS;
}

function bridgeOptionsForSmartChain(chain: ResolvedModelChain, signal?: AbortSignal): SmartBridgeOptions {
    if (chain !== "grok") return { signal };
    return {
        signal,
        reasoningEffort: SMART_GROK_REASONING_EFFORT,
        fallbackModel: SMART_GROK_FALLBACK_MODEL,
    };
}

export async function callSmartModelWithFallback(
    selection: SmartConcurrencySelection,
    prompt: string,
    phase: Exclude<SmartModelPhase, "files">,
    opts: {
        background?: boolean;
        signal?: AbortSignal;
        preferred?: ResolvedModelChain;
        callBridge?: (
            chain: ResolvedModelChain,
            prompt: string,
            timeoutMs: number,
            options?: SmartBridgeOptions,
        ) => Promise<{ chainUsed: ResolvedModelChain; text: string }>;
    } = {},
): Promise<{ chainUsed: ResolvedModelChain; text: string }> {
    const candidates = uniqueStrings([
        opts.preferred,
        selection.primary,
        ...selection.fallback,
    ].filter((chain): chain is ResolvedModelChain => Boolean(chain))) as ResolvedModelChain[];
    const errors: string[] = [];
    const callBridge = opts.callBridge ?? callModelBridge;

    for (const chain of candidates) {
        const baseTimeout = smartTimeoutFor(chain, phase, opts.background);
        for (let attempt = 1; attempt <= SMART_CHAIN_RETRY_ATTEMPTS; attempt++) {
            assertNotAborted(opts.signal);
            const timeoutMs = attempt === 1
                ? baseTimeout
                : Math.max(1000, Math.floor(baseTimeout * SMART_CHAIN_RETRY_TIMEOUT_FACTOR));
            try {
                return await callBridge(chain, prompt, timeoutMs, bridgeOptionsForSmartChain(chain, opts.signal));
            } catch (err) {
                assertNotAborted(opts.signal);
                const message = err instanceof Error ? err.message : String(err);
                errors.push(`${chain}${attempt > 1 ? `#retry${attempt}` : ""}: ${message}`);
                if (!isRetriableSmartModelError(message) || attempt >= SMART_CHAIN_RETRY_ATTEMPTS) break;
            }
        }
    }

    throw new Error(`smart_search 模型链路全部失败：${errors.join(" | ")}`);
}

function isRetriableSmartModelError(message: string): boolean {
    if (/abort|cancel|cancelled|canceled|interrupted/iu.test(message)) return false;
    if (/auth|permission|forbidden|unauthorized|invalid api|invalid key/iu.test(message)) return false;
    return /timeout|timed out|429|rate|5\d\d|upstream|unreachable|ECONN|fetch failed|empty|truncated|length|max_tokens/iu.test(message);
}

function splitSearchUnitForIndexRetry(unit: SearchUnit): SearchUnit[] {
    if (unit.code.length <= SMART_INDEX_SPLIT_MAX_CHARS) return [];
    if (unit.type === "group") {
        const splitUnits: SearchUnit[] = [];
        for (const filePath of unit.allFiles) {
            const code = safeReadText(filePath);
            if (code === null) continue;
            const bounds = collectBoundsForFile(unit.functionBounds, filePath);
            if (code.length <= SMART_INDEX_SPLIT_MAX_CHARS) {
                splitUnits.push(buildSingleFileUnit(filePath, code, unit.hitLines, unit.hitContent, bounds));
            } else {
                splitUnits.push(...buildSplitUnits(filePath, code, unit.hitLines, unit.hitContent, bounds, SMART_INDEX_SPLIT_MAX_CHARS));
            }
        }
        return splitUnits.filter((split) => split.id !== unit.id);
    }
    const fullText = safeReadText(unit.filePath) || unit.code;
    const splitUnits = buildSplitUnits(unit.filePath, fullText, unit.hitLines, unit.hitContent, unit.functionBounds, SMART_INDEX_SPLIT_MAX_CHARS);
    return splitUnits.filter((split) => split.id !== unit.id && split.code.length < unit.code.length);
}

async function runSmartPipeline(
    query: string,
    searchPath: string,
    units: SearchUnit[],
    indices: SearchUnitIndex[],
    functionBounds: FunctionBound[],
    opts: { chain: ModelChain; background?: boolean; maxResults?: number; signal?: AbortSignal; skipModelWhenNoLocalEvidence?: boolean },
): Promise<{ chainUsed: ResolvedModelChain; text: string }> {
    const selection = await resolveSmartExecutionChain(opts.chain);
    let chainUsed: ResolvedModelChain = selection.primary as ResolvedModelChain;
    if (units.length === 0) {
        return {
            chainUsed,
            text: `🧠 语义搜索 "${query}" — 未找到候选文件\n\n建议关键词: ${expandSmartQueryTerms(query).join(", ") || "无"}`,
        };
    }
    const activeUnits = units.slice(0, Math.max(1, opts.maxResults ?? SMART_DEFAULT_MAX_RESULTS));
    const fallbackIndices = indices.filter((index) => activeUnits.some((unit) => unit.id === index.unitId));
    const activeIndices = await buildPipelineIndices(query, activeUnits, fallbackIndices, selection, {
        background: opts.background,
        signal: opts.signal,
        updateChain: (chain) => {
            chainUsed = chain;
        },
    });
    const globalIndex = aggregateIndices(activeIndices, query);
    const broadResults = await broadSearch(activeUnits, activeIndices, {
        query,
        concurrency: selection.concurrency,
        callModel: async (prompt) => {
            const result = await callSmartModelWithFallback(selection, prompt, "broad", {
                background: opts.background,
                signal: opts.signal,
            });
            chainUsed = result.chainUsed;
            return result.text;
        },
        skipModelWhenNoLocalEvidence: opts.skipModelWhenNoLocalEvidence ?? false,
        skipNoLocalEvidenceAfter: SMART_LOCAL_EVIDENCE_SKIP_THRESHOLD,
        keepNoEvidenceModelCalls: SMART_LOCAL_EVIDENCE_EXPLORATION_UNITS,
    });
    const deepResults = await deepSearch(activeUnits, activeIndices, broadResults, {
        query,
        concurrency: selection.concurrency,
        maxResults: SMART_DEEP_MAX_UNITS,
        callModel: async (prompt) => {
            const result = await callSmartModelWithFallback(selection, prompt, "deep", {
                background: opts.background,
                signal: opts.signal,
                preferred: chainUsed,
            });
            chainUsed = result.chainUsed;
            return result.text;
        },
    });
    const resolved = resolveLineNumbers(query, deepResults, functionBounds);
    const text = [
        formatSmartResult(resolved, searchPath),
        "",
        `阶段摘要: units=${activeUnits.length}, indexFallback=${activeIndices.filter((index) => index.fallback).length}, links=${globalIndex.links.length}, broad=${broadResults.length}, deep=${deepResults.length}`,
    ].join("\n");
    return { chainUsed, text };
}

async function buildPipelineIndices(
    query: string,
    units: SearchUnit[],
    fallbackIndices: SearchUnitIndex[],
    selection: SmartConcurrencySelection,
    opts: {
        background?: boolean;
        signal?: AbortSignal;
        updateChain?: (chain: ResolvedModelChain) => void;
    },
): Promise<SearchUnitIndex[]> {
    const fallbackById = new Map(fallbackIndices.map((index) => [index.unitId, index]));
    const results = await parallelDispatch(units, async (unit) => generateIndex(unit, {
        query,
        callModel: async (prompt) => {
            const result = await callSmartModelWithFallback(selection, prompt, "index", {
                background: opts.background,
                signal: opts.signal,
            });
            opts.updateChain?.(result.chainUsed);
            return result.text;
        },
        splitUnit: splitSearchUnitForIndexRetry,
    }), { concurrency: selection.concurrency, retryFailures: false });

    return results.map((result) => {
        if (result.status === "fulfilled" && result.value) return result.value;
        return fallbackById.get(result.item.id) || {
            unitId: result.item.id,
            unitType: result.item.type,
            files: result.item.allFiles.map((filePath) => ({
                file: filePath,
                functions: [],
                fileSummary: `索引生成失败：${path.basename(filePath)}`,
                fallback: true,
            })),
            fallback: true,
            errors: result.error ? [result.error] : ["index generation not executed"],
        };
    });
}

async function smartWithFiles(
    query: string,
    basePath: string,
    files: Array<{ path: string; range?: string }>,
    chain: ModelChain,
    background = false,
    signal?: AbortSignal,
): Promise<{ chainUsed: ResolvedModelChain; text: string }> {
    const units = await buildUnitsFromFiles(files, basePath, { signal });
    const indices = await Promise.all(units.map((unit) => fallbackCrossSearch(unit, query)));
    return runSmartPipeline(query, basePath, units, indices, units.flatMap((unit) => unit.functionBounds), {
        chain,
        background,
        maxResults: units.length,
        signal,
    });
}

async function smartTwoStage(
    query: string,
    searchPath: string,
    opts: { modelChain?: ModelChain; chain?: ModelChain; includes?: string[]; excludes?: string[]; maxResults?: number; background?: boolean; signal?: AbortSignal }
): Promise<{ chainUsed: ResolvedModelChain; text: string }> {
    assertNotAborted(opts.signal);
    // 阶段1：本地预处理 + fallback索引摘要 → 当前模型链路快速选文件
    const preprocess = await preprocessSearch(query, searchPath, {
        includes: opts.includes,
        excludes: opts.excludes,
        maxResults: opts.maxResults,
        signal: opts.signal,
    });
    const searchUnits = groupSearchUnits(preprocess);
    const unitLimit = Math.max(1, opts.maxResults ?? SMART_DEFAULT_MAX_RESULTS);
    const localIndices = await Promise.all(searchUnits.slice(0, unitLimit).map((unit) => fallbackCrossSearch(unit, query)));
    const result = await runSmartPipeline(query, searchPath, searchUnits, localIndices, preprocess.functionBounds, {
        chain: resolveModelChainParam(opts.chain, opts.modelChain),
        background: opts.background,
        maxResults: opts.maxResults,
        signal: opts.signal,
        skipModelWhenNoLocalEvidence: true,
    });
    return {
        chainUsed: result.chainUsed,
        text: result.text,
    };
}

// ===== 格式化输出 =====

function formatExactResult(
    query: string,
    data: { results: ExactResult[]; fileOnly: string[]; engine: string },
    matchPerLine: boolean
): string {
    if (matchPerLine) {
        if (data.results.length === 0) return `🔍 精确搜索 "${query}" — 0 条结果 (${data.engine})`;

        const grouped = new Map<string, ExactResult[]>();
        for (const r of data.results) {
            if (!grouped.has(r.file)) grouped.set(r.file, []);
            grouped.get(r.file)!.push(r);
        }

        let output = `🔍 精确搜索 "${query}" — ${data.results.length} 条结果 (${data.engine})\n`;
        for (const [file, matches] of grouped) {
            output += `\n📄 ${file}\n`;
            for (const m of matches) {
                output += `  L${m.line}: ${m.content}\n`;
            }
        }
        return output;
    } else {
        if (data.fileOnly.length === 0) return `🔍 精确搜索 "${query}" — 0 个文件 (${data.engine})`;
        return `🔍 精确搜索 "${query}" — ${data.fileOnly.length} 个文件 (${data.engine})\n\n${data.fileOnly.map(f => `📄 ${f}`).join("\n")}`;
    }
}

function formatFuzzyResult(query: string, results: Array<SymbolInfo & { file: string; score: number }>): string {
    if (results.length === 0) return `🔍 模糊搜索 "${query}" — 0 条匹配`;
    let output = `🔍 模糊搜索 "${query}" — ${results.length} 条最佳匹配\n`;
    for (const r of results) {
        output += `\n📄 ${r.file}\n  L${r.line}: ${r.name} (${r.type})    — 匹配度: ${r.score.toFixed(2)}\n`;
    }
    return output;
}

// ===== smart v2 前半段：预处理 / 分组 / 索引 =====

export interface SmartSearchHit {
    file: string;
    line: number;
    content: string;
    terms: string[];
}

export interface SmartPreprocessResult {
    query: string;
    queryTerms: string[];
    candidateFiles: string[];
    hits: SmartSearchHit[];
    fuzzySymbols: Array<SymbolInfo & { file: string; score: number; matchedTerm: string }>;
    hitLines: Map<string, number[]>;
    hitContent: Map<string, string[]>;
    functionBounds: FunctionBound[];
    index: Map<string, FileIndex>;
}

export interface SearchUnit {
    id: string;
    type: "file" | "split" | "group";
    filePath: string;
    allFiles: string[];
    code: string;
    hitLines: Map<string, number[]>;
    hitContent: Map<string, string[]>;
    functionBounds: FunctionBound[];
    startLine?: number;
    endLine?: number;
}

export interface SmartFunctionIndex {
    name: string;
    tag: string;
    filePath: string;
    fallback?: boolean;
}

export interface SmartFileIndex {
    file: string;
    functions: SmartFunctionIndex[];
    fileSummary: string;
    fallback?: boolean;
    fallbackHits?: Array<{ line: number; functionName: string; content: string }>;
}

export interface SearchUnitIndex {
    unitId: string;
    unitType: SearchUnit["type"];
    files: SmartFileIndex[];
    fallback: boolean;
    errors: string[];
}

export interface SmartIndexLink {
    sourceFile: string;
    sourceName: string;
    targetFile: string;
    targetName: string;
    score: number;
    reason: string;
}

export interface SmartGlobalIndex {
    files: SmartFileIndex[];
    links: SmartIndexLink[];
}

export interface BroadSearchResult {
    unitId: string;
    unitType: SearchUnit["type"];
    filePath: string;
    allFiles: string[];
    relevant: "yes" | "maybe" | "no";
    summary: string;
    snippets: string[];
    fallback: boolean;
    errors: string[];
}

export interface DeepSearchResult {
    unitId: string;
    filePath: string;
    functionName: string;
    snippets: string[];
    explanation: string;
    fallback: boolean;
    errors: string[];
}

export interface ResolvedSnippet {
    filePath: string;
    functionName: string;
    functionStartLine?: number;
    functionEndLine?: number;
    startLine: number;
    endLine: number;
    snippet: string;
    explanation: string;
    matchType: "exact" | "normalized";
}

export interface ResolvedSmartResult {
    query: string;
    results: ResolvedSnippet[];
    suggestedKeywords: string[];
    discardedSnippets: Array<{ filePath: string; functionName: string; snippet: string; reason: string }>;
}

export interface DispatchResult<T, R> {
    index: number;
    item: T;
    status: "fulfilled" | "rejected";
    attempts: number;
    value?: R;
    error?: string;
}

const SMART_QUERY_EXPANSIONS: Array<{ pattern: RegExp; terms: string[] }> = [
    { pattern: /鉴权|认证|授权|权限|登录|登陆|token|jwt|auth/iu, terms: ["auth", "authenticate", "authorize", "permission", "token", "jwt", "verify", "checkAuth", "verifyToken"] },
    { pattern: /用户|账号|账户|user|account/iu, terms: ["user", "account", "profile"] },
    { pattern: /配置|设置|config|setting/iu, terms: ["config", "setting", "option"] },
    { pattern: /启动|运行|进程|命令|执行|launch|process|spawn/iu, terms: ["start", "launch", "process", "spawn", "exec", "run"] },
    { pattern: /超时|取消|中断|timeout|abort|cancel/iu, terms: ["timeout", "abort", "cancel", "deadline", "signal"] },
    { pattern: /搜索|查找|索引|search|index/iu, terms: ["search", "find", "index", "query"] },
    { pattern: /文件|路径|目录|file|path|dir/iu, terms: ["file", "path", "directory", "dir"] },
    { pattern: /缓存|持久|恢复|cache|persist|resume|restore/iu, terms: ["cache", "persist", "resume", "restore", "checkpoint"] },
];

function uniqueStrings(values: string[]): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const value of values) {
        const trimmed = value.trim();
        if (!trimmed) continue;
        const key = trimmed.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(trimmed);
    }
    return result;
}

export function expandSmartQueryTerms(query: string): string[] {
    const rawTokens = query
        .split(/[^\p{L}\p{N}_$]+/u)
        .map((part) => part.trim())
        .filter(Boolean);
    const terms = [query, ...rawTokens];
    for (const entry of SMART_QUERY_EXPANSIONS) {
        if (entry.pattern.test(query)) {
            terms.push(...entry.terms);
        }
    }
    return uniqueStrings(terms);
}

function normalizeSearchFilePath(searchPath: string, filePath: string): string {
    return path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(searchPath, filePath);
}

function safeReadText(filePath: string): string | null {
    try {
        return fs.readFileSync(filePath, "utf-8");
    } catch {
        return null;
    }
}

function addMapValue<T>(map: Map<string, T[]>, key: string, value: T): void {
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(value);
}

function dedupeNumberArray(values: number[]): number[] {
    return [...new Set(values)].sort((a, b) => a - b);
}

function cloneHitLines(source: Map<string, number[]>, files: string[]): Map<string, number[]> {
    const result = new Map<string, number[]>();
    for (const file of files) {
        const values = source.get(file);
        if (values) result.set(file, [...values]);
    }
    return result;
}

function cloneHitContent(source: Map<string, string[]>, files: string[]): Map<string, string[]> {
    const result = new Map<string, string[]>();
    for (const file of files) {
        const values = source.get(file);
        if (values) result.set(file, [...values]);
    }
    return result;
}

function unitId(type: SearchUnit["type"], filePath: string, suffix: string): string {
    return `${type}:${filePath}:${suffix}`;
}

export async function preprocessSearch(
    query: string,
    searchPath: string,
    opts: { includes?: string[]; excludes?: string[]; maxResults?: number; signal?: AbortSignal } = {},
): Promise<SmartPreprocessResult> {
    assertNotAborted(opts.signal);
    const index = await scanDirectory(searchPath, {
        includes: opts.includes,
        excludes: opts.excludes,
    });
    assertNotAborted(opts.signal);

    const allSymbols = flattenSymbols(index);
    const functionBounds = flattenFunctionBounds(index);
    const queryTerms = expandSmartQueryTerms(query);

    const fuse = new Fuse(allSymbols, {
        keys: ["name", "type", "file"],
        threshold: 0.5,
        distance: 100,
        includeScore: true,
    });
    const fuzzySymbols = fuse.search(queryTerms.join(" "), { limit: 10 }).map((result) => ({
        ...result.item,
        score: 1 - (result.score || 0),
        matchedTerm: query,
    }));

    for (const term of queryTerms) {
        for (const result of fuse.search(term, { limit: 5 })) {
            const item = {
                ...result.item,
                score: 1 - (result.score || 0),
                matchedTerm: term,
            };
            if (!fuzzySymbols.some((existing) => existing.file === item.file && existing.name === item.name)) {
                fuzzySymbols.push(item);
            }
        }
    }

    const exactTerms = uniqueStrings([...queryTerms, ...fuzzySymbols.map((symbol) => symbol.name.split(".").at(-1) || symbol.name)]);
    const hitLines = new Map<string, number[]>();
    const hitContent = new Map<string, string[]>();
    const hitTerms = new Map<string, Set<string>>();
    const hits: SmartSearchHit[] = [];

    for (const term of exactTerms) {
        assertNotAborted(opts.signal);
        const data = await searchExact(term, searchPath, {
            caseSensitive: false,
            isRegex: false,
            matchPerLine: true,
            context: 0,
            includes: opts.includes,
            excludes: opts.excludes,
            maxResults: opts.maxResults ?? 100,
            signal: opts.signal,
        });
        for (const result of data.results) {
            const file = normalizeSearchFilePath(searchPath, result.file);
            addMapValue(hitLines, file, result.line);
            addMapValue(hitContent, file, result.content);
            if (!hitTerms.has(file)) hitTerms.set(file, new Set());
            hitTerms.get(file)!.add(term);
            hits.push({
                file,
                line: result.line,
                content: result.content,
                terms: [term],
            });
        }
    }

    for (const [file, lines] of [...hitLines.entries()]) {
        hitLines.set(file, dedupeNumberArray(lines));
    }

    const fileScores = new Map<string, number>();
    for (const [file, lines] of hitLines) {
        fileScores.set(file, (fileScores.get(file) || 0) + lines.length * 2);
    }
    for (const symbol of fuzzySymbols) {
        const file = normalizeSearchFilePath(searchPath, symbol.file);
        fileScores.set(file, (fileScores.get(file) || 0) + symbol.score);
        if (!hitTerms.has(file)) hitTerms.set(file, new Set());
        hitTerms.get(file)!.add(symbol.matchedTerm);
    }

    const candidateFiles = [...fileScores.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([file]) => file);

    for (const hit of hits) {
        hit.terms = [...(hitTerms.get(hit.file) || new Set(hit.terms))];
    }

    return {
        query,
        queryTerms,
        candidateFiles,
        hits,
        fuzzySymbols,
        hitLines,
        hitContent,
        functionBounds,
        index,
    };
}

function sliceLines(text: string, startLine: number, endLine: number): string {
    const lines = text.split(/\r?\n/);
    return lines.slice(Math.max(0, startLine - 1), Math.min(lines.length, endLine)).join("\n");
}

function collectBoundsForFile(bounds: FunctionBound[], filePath: string): FunctionBound[] {
    return bounds
        .filter((bound) => path.resolve(bound.filePath) === path.resolve(filePath))
        .sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
}

function buildSingleFileUnit(
    filePath: string,
    code: string,
    hitLines: Map<string, number[]>,
    hitContent: Map<string, string[]>,
    bounds: FunctionBound[],
): SearchUnit {
    return {
        id: unitId("file", filePath, "full"),
        type: "file",
        filePath,
        allFiles: [filePath],
        code,
        hitLines: cloneHitLines(hitLines, [filePath]),
        hitContent: cloneHitContent(hitContent, [filePath]),
        functionBounds: bounds,
        startLine: 1,
        endLine: code.split(/\r?\n/).length,
    };
}

function buildSplitUnits(
    filePath: string,
    code: string,
    hitLines: Map<string, number[]>,
    hitContent: Map<string, string[]>,
    bounds: FunctionBound[],
    maxChars: number,
): SearchUnit[] {
    const lineCount = code.split(/\r?\n/).length;
    if (bounds.length === 0) {
        return [buildSingleFileUnit(filePath, code, hitLines, hitContent, bounds)];
    }

    const units: SearchUnit[] = [];
    let chunkStart = Math.max(1, bounds[0].startLine - 3);
    let chunkEnd = Math.min(lineCount, bounds[0].endLine + 3);
    let chunkBounds: FunctionBound[] = [];

    function flush(): void {
        const unitCode = sliceLines(code, chunkStart, chunkEnd);
        units.push({
            id: unitId("split", filePath, `${chunkStart}-${chunkEnd}`),
            type: "split",
            filePath,
            allFiles: [filePath],
            code: unitCode,
            hitLines: cloneHitLines(hitLines, [filePath]),
            hitContent: cloneHitContent(hitContent, [filePath]),
            functionBounds: chunkBounds,
            startLine: chunkStart,
            endLine: chunkEnd,
        });
    }

    for (const bound of bounds) {
        const nextStart = Math.max(1, bound.startLine - 3);
        const nextEnd = Math.min(lineCount, bound.endLine + 3);
        const nextCode = sliceLines(code, Math.min(chunkStart, nextStart), Math.max(chunkEnd, nextEnd));
        if (chunkBounds.length > 0 && nextCode.length > maxChars) {
            flush();
            chunkStart = nextStart;
            chunkEnd = nextEnd;
            chunkBounds = [bound];
        } else {
            chunkStart = Math.min(chunkStart, nextStart);
            chunkEnd = Math.max(chunkEnd, nextEnd);
            chunkBounds.push(bound);
        }
    }
    if (chunkBounds.length > 0) flush();
    return units;
}

function buildGroupUnit(
    files: Array<{ filePath: string; code: string; lineCount: number; bounds: FunctionBound[] }>,
    hitLines: Map<string, number[]>,
    hitContent: Map<string, string[]>,
    groupIndex: number,
): SearchUnit {
    const allFiles = files.map((file) => file.filePath);
    const code = files.map((file) => {
        const rel = path.basename(file.filePath);
        return `=== ${rel} (${file.lineCount}行) ===\n${file.code}`;
    }).join("\n\n");
    return {
        id: unitId("group", allFiles[0], String(groupIndex)),
        type: "group",
        filePath: allFiles[0],
        allFiles,
        code,
        hitLines: cloneHitLines(hitLines, allFiles),
        hitContent: cloneHitContent(hitContent, allFiles),
        functionBounds: files.flatMap((file) => file.bounds),
    };
}

export function groupSearchUnits(
    preprocess: SmartPreprocessResult,
    opts: { splitMaxChars?: number; smallFileMaxLines?: number; groupMaxChars?: number } = {},
): SearchUnit[] {
    const splitMaxChars = opts.splitMaxChars ?? 8000;
    const smallFileMaxLines = opts.smallFileMaxLines ?? 50;
    const groupMaxChars = opts.groupMaxChars ?? 5000;
    const units: SearchUnit[] = [];
    const smallFiles: Array<{ filePath: string; code: string; lineCount: number; bounds: FunctionBound[] }> = [];
    let groupIndex = 1;

    function flushSmallFiles(): void {
        if (smallFiles.length === 0) return;
        units.push(buildGroupUnit([...smallFiles], preprocess.hitLines, preprocess.hitContent, groupIndex++));
        smallFiles.length = 0;
    }

    for (const filePath of preprocess.candidateFiles) {
        const code = safeReadText(filePath);
        if (code === null) continue;
        const lineCount = code.split(/\r?\n/).length;
        const bounds = collectBoundsForFile(preprocess.functionBounds, filePath);

        if (lineCount < smallFileMaxLines && code.length <= groupMaxChars) {
            const projected = [...smallFiles, { filePath, code, lineCount, bounds }];
            const projectedCode = projected.map((file) => `=== ${path.basename(file.filePath)} (${file.lineCount}行) ===\n${file.code}`).join("\n\n");
            if (projectedCode.length > groupMaxChars) {
                flushSmallFiles();
            }
            smallFiles.push({ filePath, code, lineCount, bounds });
            continue;
        }

        flushSmallFiles();
        if (code.length <= splitMaxChars) {
            units.push(buildSingleFileUnit(filePath, code, preprocess.hitLines, preprocess.hitContent, bounds));
        } else {
            units.push(...buildSplitUnits(filePath, code, preprocess.hitLines, preprocess.hitContent, bounds, splitMaxChars));
        }
    }
    flushSmallFiles();
    return units;
}

export async function buildUnitsFromFiles(
    files: Array<{ path: string; range?: string }>,
    basePath: string,
    opts: { includes?: string[]; excludes?: string[]; signal?: AbortSignal } = {},
): Promise<SearchUnit[]> {
    const index = await scanDirectory(basePath, {
        includes: opts.includes,
        excludes: opts.excludes,
    });
    const bounds = flattenFunctionBounds(index);
    const units: SearchUnit[] = [];
    const base = path.resolve(basePath);

    for (const file of files) {
        assertNotAborted(opts.signal);
        const fullPath = path.isAbsolute(file.path) ? file.path : path.join(basePath, file.path);
        const resolved = path.resolve(fullPath);
        if (!resolved.startsWith(base + path.sep) && resolved !== base) {
            continue;
        }
        const text = safeReadText(resolved);
        if (text === null) continue;
        const lines = text.split(/\r?\n/);
        let startLine = 1;
        let endLine = lines.length;
        let code = text;
        if (file.range) {
            const range = file.range.match(/^#?(\d+)-(\d+)$/);
            if (range) {
                startLine = Math.max(1, Number(range[1]));
                endLine = Math.min(lines.length, Number(range[2]));
                code = lines.slice(startLine - 1, endLine).join("\n");
            } else if (file.range.startsWith("first")) {
                endLine = Math.min(lines.length, Number(file.range.replace("first", "")) || 20);
                code = lines.slice(0, endLine).join("\n");
            } else if (file.range.startsWith("last")) {
                const count = Number(file.range.replace("last", "")) || 20;
                startLine = Math.max(1, lines.length - count + 1);
                code = lines.slice(startLine - 1).join("\n");
            }
        }
        const fileBounds = collectBoundsForFile(bounds, resolved)
            .filter((bound) => bound.endLine >= startLine && bound.startLine <= endLine);
        units.push({
            id: unitId("file", resolved, `${startLine}-${endLine}`),
            type: "file",
            filePath: resolved,
            allFiles: [resolved],
            code,
            hitLines: new Map(),
            hitContent: new Map(),
            functionBounds: fileBounds,
            startLine,
            endLine,
        });
    }
    return units;
}

function extractJsonObject(text: string): unknown {
    const trimmed = text.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        return JSON.parse(trimmed);
    }
    const match = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i) || trimmed.match(/(\{[\s\S]*\})/);
    if (!match) throw new Error("模型未返回 JSON");
    return JSON.parse(match[1]);
}

function validateFileIndex(fileIndex: SmartFileIndex): void {
    if (fileIndex.fileSummary.length > 80) {
        throw new Error(`fileSummary 超过80字: ${fileIndex.file}`);
    }
    for (const fn of fileIndex.functions) {
        if (fn.tag.length > 50) {
            throw new Error(`tag 超过50字: ${fn.name}`);
        }
    }
}

function normalizeIndexFile(file: any, defaultFile: string): SmartFileIndex {
    const normalized: SmartFileIndex = {
        file: String(file.file || defaultFile),
        functions: Array.isArray(file.functions)
            ? file.functions.map((fn: any) => ({
                name: String(fn.name || ""),
                tag: String(fn.tag || ""),
                filePath: String(fn.filePath || file.file || defaultFile),
            })).filter((fn: SmartFunctionIndex) => fn.name && fn.tag)
            : [],
        fileSummary: String(file.fileSummary || ""),
    };
    validateFileIndex(normalized);
    return normalized;
}

function normalizeIndexPayload(payload: unknown, unit: SearchUnit): SmartFileIndex[] {
    if (Array.isArray(payload)) {
        return payload.map((file) => normalizeIndexFile(file, unit.filePath));
    }
    if (!payload || typeof payload !== "object") {
        throw new Error("JSON 索引不是对象");
    }
    const obj = payload as any;
    if (Array.isArray(obj.files)) {
        return obj.files.map((file: any) => normalizeIndexFile(file, unit.filePath));
    }
    return [normalizeIndexFile(obj, unit.filePath)];
}

function buildIndexPrompt(unit: SearchUnit): string {
    return `请为以下代码生成结构化 JSON 索引。只输出 JSON，不要解释。

约束：
- 单文件输出 {"file":"...","functions":[{"name":"...","tag":"50字以内"}],"fileSummary":"80字以内"}
- group 输出 {"files":[...]}，必须按文件展开
- 不输出行号

SearchUnit: ${unit.type}
Files: ${unit.allFiles.join(", ")}

代码：
${unit.code}`;
}

export async function fallbackCrossSearch(unit: SearchUnit, query: string): Promise<SearchUnitIndex> {
    const queryTerms = expandSmartQueryTerms(query);
    const files: SmartFileIndex[] = [];
    for (const filePath of unit.allFiles) {
        const bounds = collectBoundsForFile(unit.functionBounds, filePath);
        const fuse = new Fuse(bounds, {
            keys: ["name", "type"],
            threshold: 0.55,
            includeScore: true,
        });
        const matched = new Map<string, FunctionBound>();
        for (const term of queryTerms) {
            for (const result of fuse.search(term, { limit: 8 })) {
                matched.set(`${result.item.filePath}:${result.item.name}`, result.item);
            }
        }
        const lineHits = unit.hitLines.get(filePath) || [];
        const contentHits = unit.hitContent.get(filePath) || [];
        const functions: SmartFunctionIndex[] = [...matched.values()].map((bound) => ({
            name: bound.name,
            tag: `本地fuzzy命中 ${query}`,
            filePath,
            fallback: true,
        }));
        files.push({
            file: filePath,
            functions,
            fileSummary: `本地退化索引：${path.basename(filePath)}`,
            fallback: true,
            fallbackHits: lineHits.map((line, index) => ({
                line,
                functionName: bounds.find((bound) => line >= bound.startLine && line <= bound.endLine)?.name || "(unknown)",
                content: contentHits[index] || "",
            })),
        });
    }
    return {
        unitId: unit.id,
        unitType: unit.type,
        files,
        fallback: true,
        errors: [],
    };
}

export async function generateIndex(
    unit: SearchUnit,
    opts: {
        query: string;
        callModel?: (prompt: string, unit: SearchUnit) => Promise<string>;
        splitUnit?: (unit: SearchUnit) => SearchUnit[];
    },
): Promise<SearchUnitIndex> {
    const errors: string[] = [];
    if (!opts.callModel) {
        return fallbackCrossSearch(unit, opts.query);
    }
    const callModel: (prompt: string, unit: SearchUnit) => Promise<string> = opts.callModel;

    async function tryGenerate(target: SearchUnit): Promise<SmartFileIndex[]> {
        const response = await callModel(buildIndexPrompt(target), target);
        return normalizeIndexPayload(extractJsonObject(response), target);
    }

    try {
        const files = await tryGenerate(unit);
        return { unitId: unit.id, unitType: unit.type, files, fallback: false, errors };
    } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
    }

    const splitUnits = opts.splitUnit ? opts.splitUnit(unit) : [];
    if (splitUnits.length > 0) {
        try {
            const files = (await Promise.all(splitUnits.map((split) => tryGenerate(split)))).flat();
            return { unitId: unit.id, unitType: unit.type, files, fallback: false, errors };
        } catch (err) {
            errors.push(err instanceof Error ? err.message : String(err));
        }
    }

    const fallback = await fallbackCrossSearch(unit, opts.query);
    fallback.errors = errors;
    return fallback;
}

function scoreIndexText(query: string, text: string): number {
    const fuse = new Fuse([{ text }], {
        keys: ["text"],
        threshold: 0.55,
        includeScore: true,
    });
    const result = fuse.search(query, { limit: 1 })[0];
    return result ? 1 - (result.score || 0) : 0;
}

export function aggregateIndices(indices: SearchUnitIndex[], query = ""): SmartGlobalIndex {
    const files = indices.flatMap((index) => index.files);
    const links: SmartIndexLink[] = [];
    const functions = files.flatMap((file) => file.functions.map((fn) => ({ file, fn })));

    for (const source of functions) {
        const sourceText = `${source.fn.name} ${source.fn.tag}`;
        for (const target of functions) {
            if (source === target || source.file.file === target.file.file) continue;
            const targetText = `${target.fn.name} ${target.fn.tag}`;
            const score = Math.max(
                scoreIndexText(source.fn.tag, targetText),
                query ? Math.min(scoreIndexText(query, sourceText), scoreIndexText(query, targetText)) : 0,
            );
            if (score >= 0.45) {
                links.push({
                    sourceFile: source.file.file,
                    sourceName: source.fn.name,
                    targetFile: target.file.file,
                    targetName: target.fn.name,
                    score,
                    reason: "fuzzy tag/function association",
                });
            }
        }
    }

    links.sort((a, b) => b.score - a.score);
    return { files, links: links.slice(0, 50) };
}

export function hasLocalSearchEvidence(unit: SearchUnit, index?: SearchUnitIndex): boolean {
    const hasExactLineHits = [...unit.hitLines.values()].some((lines) => lines.length > 0);
    const hasExactContentHits = [...unit.hitContent.values()].some((snippets) => snippets.length > 0);
    const hasIndexedEvidence = Boolean(index?.files.some((file) =>
        file.functions.length > 0 || (file.fallbackHits?.length ?? 0) > 0
    ));
    return hasExactLineHits || hasExactContentHits || hasIndexedEvidence;
}

export async function parallelDispatch<T, R>(
    items: T[],
    worker: (item: T, index: number, attempt: number) => Promise<R>,
    opts: { concurrency?: number; retryFailures?: boolean } = {},
): Promise<Array<DispatchResult<T, R>>> {
    const concurrency = Math.max(1, opts.concurrency ?? 4);
    const retryFailures = opts.retryFailures ?? true;
    const results: Array<DispatchResult<T, R> | undefined> = new Array(items.length);
    let cursor = 0;

    async function runBatch(attempt: number, indexes: number[]): Promise<number[]> {
        const failed: number[] = [];
        cursor = 0;
        async function next(): Promise<void> {
            while (cursor < indexes.length) {
                const local = cursor++;
                const index = indexes[local];
                const item = items[index];
                try {
                    const value = await worker(item, index, attempt);
                    results[index] = { index, item, status: "fulfilled", attempts: attempt, value };
                } catch (err) {
                    results[index] = {
                        index,
                        item,
                        status: "rejected",
                        attempts: attempt,
                        error: err instanceof Error ? err.message : String(err),
                    };
                    failed.push(index);
                }
            }
        }
        await Promise.all(Array.from({ length: Math.min(concurrency, indexes.length) }, () => next()));
        return failed;
    }

    const firstFailed = await runBatch(1, items.map((_, index) => index));
    if (retryFailures && firstFailed.length > 0) {
        await runBatch(2, firstFailed);
    }
    return results.map((result, index) => result || {
        index,
        item: items[index],
        status: "rejected",
        attempts: 0,
        error: "not executed",
    });
}

function findUnitIndex(indices: SearchUnitIndex[], unit: SearchUnit): SearchUnitIndex | undefined {
    return indices.find((index) => index.unitId === unit.id);
}

function unitHitSnippets(unit: SearchUnit): string[] {
    return uniqueStrings([...unit.hitContent.values()].flat()).slice(0, 12);
}

function collectExactFallbackSnippets(unit: SearchUnit, query: string): string[] {
    const terms = expandSmartQueryTerms(query).map((term) => term.toLowerCase());
    const snippets: string[] = [];
    const sources = unit.allFiles.length > 0
        ? unit.allFiles.map((filePath) => safeReadText(filePath)).filter((text): text is string => text !== null)
        : [];
    if (sources.length === 0) sources.push(unit.code);

    for (const text of sources) {
        for (const line of text.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            const lowered = trimmed.toLowerCase();
            if (terms.some((term) => lowered.includes(term))) {
                snippets.push(trimmed);
            }
        }
    }
    return uniqueStrings(snippets).slice(0, 12);
}

function fuzzyFallbackBounds(unit: SearchUnit, query: string): FunctionBound[] {
    const terms = expandSmartQueryTerms(query);
    if (unit.functionBounds.length === 0) return [];
    const fuse = new Fuse(unit.functionBounds, {
        keys: ["name", "type"],
        threshold: 0.55,
        includeScore: true,
    });
    const matched = new Map<string, FunctionBound>();
    for (const term of terms) {
        for (const result of fuse.search(term, { limit: 6 })) {
            matched.set(`${result.item.filePath}:${result.item.name}`, result.item);
        }
    }
    return [...matched.values()];
}

function buildUnitIndexText(index: SearchUnitIndex | undefined): string {
    if (!index) return "无";
    return index.files.map((file) => {
        const functions = file.functions.map((fn) => `${fn.name}: ${fn.tag}`).join("; ");
        return `${file.file}: ${file.fileSummary}${functions ? ` | ${functions}` : ""}`;
    }).join("\n");
}

function parseBroadPayload(payload: unknown, unit: SearchUnit): Omit<BroadSearchResult, "unitId" | "unitType" | "filePath" | "allFiles" | "fallback" | "errors"> {
    if (!payload || typeof payload !== "object") throw new Error("broadSearch JSON 不是对象");
    const obj = payload as any;
    const relevant = obj.relevant === "yes" || obj.relevant === "maybe" || obj.relevant === "no" ? obj.relevant : "no";
    const summary = String(obj.summary || "").slice(0, 120);
    const snippets = Array.isArray(obj.snippets)
        ? uniqueStrings(obj.snippets.map((snippet: unknown) => String(snippet))).filter((snippet) => unit.code.includes(snippet))
        : [];
    if (relevant !== "no" && snippets.length === 0) {
        throw new Error("相关结果未提供逐字引用 snippets");
    }
    return { relevant, summary, snippets };
}

function fallbackBroadResult(unit: SearchUnit, query: string, errors: string[] = []): BroadSearchResult {
    const exactSnippets = collectExactFallbackSnippets(unit, query);
    const fuzzyBounds = fuzzyFallbackBounds(unit, query);
    const snippets = uniqueStrings([...unitHitSnippets(unit), ...exactSnippets]);
    const relevant: BroadSearchResult["relevant"] = snippets.length > 0 || fuzzyBounds.length > 0
        ? "maybe"
        : "no";
    return {
        unitId: unit.id,
        unitType: unit.type,
        filePath: unit.filePath,
        allFiles: unit.allFiles,
        relevant,
        summary: relevant === "no" ? "本地 exact/fuzzy 兜底命中不足，暂判不相关" : "本地 exact/fuzzy 兜底命中，需后续深挖",
        snippets,
        fallback: true,
        errors,
    };
}

function buildBroadPrompt(query: string, unit: SearchUnit, index: SearchUnitIndex | undefined): string {
    return `你是代码相关性判断助手。用户想找: "${query}"

SearchUnit: ${unit.id}
文件: ${unit.allFiles.join(", ")}
索引:
${buildUnitIndexText(index)}

命中片段（不含行号）:
${unitHitSnippets(unit).join("\n") || "无"}

请判断这个单元与用户查询是否相关。只输出 JSON：
{"relevant":"yes|maybe|no","summary":"80字以内","snippets":["必须从命中片段或代码中逐字引用"]}`;
}

export async function broadSearch(
    units: SearchUnit[],
    indices: SearchUnitIndex[],
    opts: {
        query: string;
        callModel?: (prompt: string, unit: SearchUnit, index: SearchUnitIndex | undefined) => Promise<string>;
        concurrency?: number;
        skipModelWhenNoLocalEvidence?: boolean;
        skipNoLocalEvidenceAfter?: number;
        keepNoEvidenceModelCalls?: number;
    },
): Promise<BroadSearchResult[]> {
    const skippedNoEvidence = new Set<string>();
    if (opts.skipModelWhenNoLocalEvidence && units.length > (opts.skipNoLocalEvidenceAfter ?? 0)) {
        let kept = 0;
        const keep = opts.keepNoEvidenceModelCalls ?? 0;
        for (const unit of units) {
            const index = findUnitIndex(indices, unit);
            if (hasLocalSearchEvidence(unit, index)) continue;
            if (kept < keep) {
                kept++;
                continue;
            }
            skippedNoEvidence.add(unit.id);
        }
    }
    const results = await parallelDispatch(units, async (unit) => {
        const index = findUnitIndex(indices, unit);
        if (skippedNoEvidence.has(unit.id)) {
            return fallbackBroadResult(unit, opts.query, ["skipped: no local exact/fuzzy/function evidence"]);
        }
        if (!opts.callModel) return fallbackBroadResult(unit, opts.query);
        const response = await opts.callModel(buildBroadPrompt(opts.query, unit, index), unit, index);
        const parsed = parseBroadPayload(extractJsonObject(response), unit);
        return {
            unitId: unit.id,
            unitType: unit.type,
            filePath: unit.filePath,
            allFiles: unit.allFiles,
            ...parsed,
            fallback: false,
            errors: [],
        };
    }, { concurrency: opts.concurrency ?? 4, retryFailures: true });

    return results.map((result) => result.status === "fulfilled" && result.value
        ? result.value
        : fallbackBroadResult(result.item, opts.query, result.error ? [result.error] : []));
}

function parseDeepPayload(payload: unknown, broad: BroadSearchResult): Omit<DeepSearchResult, "unitId" | "filePath" | "fallback" | "errors"> {
    if (!payload || typeof payload !== "object") throw new Error("deepSearch JSON 不是对象");
    const obj = payload as any;
    const functionName = String(obj.function || obj.functionName || "");
    const snippets = Array.isArray(obj.snippets)
        ? uniqueStrings(obj.snippets.map((snippet: unknown) => String(snippet))).filter(Boolean)
        : [];
    if (!functionName) throw new Error("deepSearch 缺少 function/functionName");
    if (snippets.length === 0) throw new Error("deepSearch 缺少 snippets");
    return {
        functionName,
        snippets,
        explanation: String(obj.explanation || broad.summary || "").slice(0, 240),
    };
}

function fallbackDeepResult(unit: SearchUnit, broad: BroadSearchResult, errors: string[] = []): DeepSearchResult {
    const firstBound = unit.functionBounds.find((bound) => broad.snippets.some((snippet) => {
        const lines = safeReadText(bound.filePath);
        return lines ? sliceLines(lines, bound.startLine, bound.endLine).includes(snippet) : false;
    })) || unit.functionBounds[0];
    return {
        unitId: broad.unitId,
        filePath: broad.filePath,
        functionName: firstBound?.name || "(unknown)",
        snippets: broad.snippets,
        explanation: broad.summary,
        fallback: true,
        errors,
    };
}

function buildDeepPrompt(query: string, broad: BroadSearchResult, index: SearchUnitIndex | undefined, summaries: BroadSearchResult[]): string {
    const summaryText = summaries.map((item) => `${item.allFiles.join(", ")}: ${item.summary} (${item.relevant})`).join("\n");
    return `你是代码深挖分析助手。用户想找: "${query}"

全局 summary:
${summaryText}

当前文件: ${broad.allFiles.join(", ")}
索引:
${buildUnitIndexText(index)}

hit片段（不是全文，不含行号）:
${broad.snippets.join("\n") || "无"}

请输出 JSON：
{"function":"函数名","snippets":["逐字引用代码片段"],"explanation":"逻辑说明"}`;
}

export async function deepSearch(
    units: SearchUnit[],
    indices: SearchUnitIndex[],
    broadResults: BroadSearchResult[],
    opts: {
        query: string;
        callModel?: (prompt: string, unit: SearchUnit, broad: BroadSearchResult, index: SearchUnitIndex | undefined) => Promise<string>;
        concurrency?: number;
        maxResults?: number;
    },
): Promise<DeepSearchResult[]> {
    const relevant = selectDeepSearchCandidates(broadResults, opts.maxResults);
    const byId = new Map(units.map((unit) => [unit.id, unit]));
    const results = await parallelDispatch(relevant, async (broad) => {
        const unit = byId.get(broad.unitId);
        if (!unit) throw new Error(`找不到 SearchUnit: ${broad.unitId}`);
        const index = findUnitIndex(indices, unit);
        if (!opts.callModel) return fallbackDeepResult(unit, broad);
        const response = await opts.callModel(buildDeepPrompt(opts.query, broad, index, broadResults), unit, broad, index);
        const parsed = parseDeepPayload(extractJsonObject(response), broad);
        return {
            unitId: broad.unitId,
            filePath: broad.filePath,
            ...parsed,
            fallback: false,
            errors: [],
        };
    }, { concurrency: opts.concurrency ?? 4, retryFailures: true });

    return results.map((result) => {
        if (result.status === "fulfilled" && result.value) return result.value;
        const unit = byId.get(result.item.unitId);
        return fallbackDeepResult(unit!, result.item, result.error ? [result.error] : []);
    });
}

export function selectDeepSearchCandidates(broadResults: BroadSearchResult[], maxResults = Number.POSITIVE_INFINITY): BroadSearchResult[] {
    const yes = broadResults.filter((result) => result.relevant === "yes");
    const maybe = broadResults.filter((result) => result.relevant === "maybe");
    return [...yes, ...maybe].slice(0, Math.max(1, maxResults));
}

function lineStarts(text: string): number[] {
    const starts = [0];
    for (let index = 0; index < text.length; index++) {
        if (text[index] === "\n") starts.push(index + 1);
    }
    return starts;
}

function lineForOffset(starts: number[], offset: number): number {
    let low = 0;
    let high = starts.length - 1;
    while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        if (starts[mid] <= offset) low = mid + 1;
        else high = mid - 1;
    }
    return Math.max(1, high + 1);
}

function exactSnippetMatches(text: string, snippet: string): Array<{ startLine: number; endLine: number; matchType: "exact" }> {
    const starts = lineStarts(text);
    const matches: Array<{ startLine: number; endLine: number; matchType: "exact" }> = [];
    let offset = text.indexOf(snippet);
    while (offset >= 0) {
        matches.push({
            startLine: lineForOffset(starts, offset),
            endLine: lineForOffset(starts, offset + Math.max(0, snippet.length - 1)),
            matchType: "exact",
        });
        offset = text.indexOf(snippet, offset + Math.max(1, snippet.length));
    }
    return matches;
}

function normalizeWithMap(text: string): { normalized: string; offsets: number[] } {
    let normalized = "";
    const offsets: number[] = [];
    for (let index = 0; index < text.length; index++) {
        const char = text[index];
        if (/\s/u.test(char)) continue;
        normalized += char;
        offsets.push(index);
    }
    return { normalized, offsets };
}

function normalizedSnippetMatches(text: string, snippet: string): Array<{ startLine: number; endLine: number; matchType: "normalized" }> {
    const starts = lineStarts(text);
    const haystack = normalizeWithMap(text);
    const needle = normalizeWithMap(snippet).normalized;
    if (!needle) return [];
    const matches: Array<{ startLine: number; endLine: number; matchType: "normalized" }> = [];
    let normalizedOffset = haystack.normalized.indexOf(needle);
    while (normalizedOffset >= 0) {
        const startOffset = haystack.offsets[normalizedOffset];
        const endOffset = haystack.offsets[normalizedOffset + needle.length - 1] ?? startOffset;
        matches.push({
            startLine: lineForOffset(starts, startOffset),
            endLine: lineForOffset(starts, endOffset),
            matchType: "normalized",
        });
        normalizedOffset = haystack.normalized.indexOf(needle, normalizedOffset + Math.max(1, needle.length));
    }
    return matches;
}

function findFunctionBound(functionBounds: FunctionBound[], filePath: string, functionName: string): FunctionBound | undefined {
    const wanted = functionName.toLowerCase();
    return functionBounds.find((bound) => path.resolve(bound.filePath) === path.resolve(filePath) && bound.name.toLowerCase() === wanted)
        || functionBounds.find((bound) => path.resolve(bound.filePath) === path.resolve(filePath) && bound.name.toLowerCase().endsWith(`.${wanted}`))
        || functionBounds.find((bound) => path.resolve(bound.filePath) === path.resolve(filePath) && wanted.endsWith(bound.name.toLowerCase()));
}

export function resolveLineNumbers(
    query: string,
    deepResults: DeepSearchResult[],
    functionBounds: FunctionBound[],
): ResolvedSmartResult {
    const results: ResolvedSnippet[] = [];
    const discardedSnippets: ResolvedSmartResult["discardedSnippets"] = [];

    for (const result of deepResults) {
        const text = safeReadText(result.filePath);
        if (text === null) {
            for (const snippet of result.snippets) {
                discardedSnippets.push({ filePath: result.filePath, functionName: result.functionName, snippet, reason: "文件读取失败" });
            }
            continue;
        }
        const bound = findFunctionBound(functionBounds, result.filePath, result.functionName);
        for (const snippet of result.snippets) {
            const matches = exactSnippetMatches(text, snippet);
            const finalMatches = matches.length > 0 ? matches : normalizedSnippetMatches(text, snippet);
            if (finalMatches.length === 0) {
                discardedSnippets.push({ filePath: result.filePath, functionName: result.functionName, snippet, reason: "未匹配到代码片段" });
                continue;
            }
            for (const match of finalMatches) {
                results.push({
                    filePath: result.filePath,
                    functionName: result.functionName,
                    functionStartLine: bound?.startLine,
                    functionEndLine: bound?.endLine,
                    startLine: match.startLine,
                    endLine: match.endLine,
                    snippet,
                    explanation: result.explanation,
                    matchType: match.matchType,
                });
            }
        }
    }

    return {
        query,
        results,
        suggestedKeywords: expandSmartQueryTerms(query).slice(0, 12),
        discardedSnippets,
    };
}

export function formatSmartResult(resolved: ResolvedSmartResult, searchPath = process.cwd()): string {
    if (resolved.results.length === 0) {
        return `🧠 语义搜索 "${resolved.query}" — 未定位到可靠代码片段\n\n建议关键词: ${resolved.suggestedKeywords.join(", ") || "无"}`;
    }
    const grouped = new Map<string, ResolvedSnippet[]>();
    for (const result of resolved.results) {
        if (!grouped.has(result.filePath)) grouped.set(result.filePath, []);
        grouped.get(result.filePath)!.push(result);
    }
    const files = [...grouped.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    const lines = [`找到 ${files.length} 个相关文件。`];
    let fileIndex = 1;
    for (const [filePath, snippets] of files) {
        lines.push("", `[${fileIndex++}/${files.length}] ${path.relative(searchPath, filePath)}`);
        const sorted = snippets.sort((a, b) => a.startLine - b.startLine || a.functionName.localeCompare(b.functionName));
        for (const snippet of sorted) {
            const functionRange = snippet.functionStartLine
                ? ` (L${snippet.functionStartLine}-L${snippet.functionEndLine || snippet.functionStartLine})`
                : "";
            const lineRange = snippet.startLine === snippet.endLine ? `L${snippet.startLine}` : `L${snippet.startLine}-L${snippet.endLine}`;
            lines.push(`  函数: ${snippet.functionName}${functionRange}`);
            lines.push(`    ${lineRange}: ${snippet.explanation}`);
            lines.push(`    代码: ${snippet.snippet}`);
        }
    }
    if (resolved.discardedSnippets.length > 0) {
        lines.push("", `丢弃 ${resolved.discardedSnippets.length} 个无法定位的片段。`);
    }
    lines.push("", `建议关键词: ${resolved.suggestedKeywords.join(", ") || "无"}`);
    return lines.join("\n");
}

// ===== 工具注册 =====

export function registerSmartSearch(server: McpServer): void {
    // QueryItem schema for batch queries
    const QueryItemSchema = z.object({
        query: z.string().describe("搜索内容"),
        mode: z.enum(["exact", "fuzzy", "smart"]).optional().describe("覆盖顶层 mode"),
        searchPath: z.string().optional().describe("覆盖顶层 searchPath"),
        includes: z.array(z.string()).optional(),
        excludes: z.array(z.string()).optional(),
        maxResults: z.number().optional(),
        caseSensitive: z.boolean().optional(),
        isRegex: z.boolean().optional(),
        matchPerLine: z.boolean().optional(),
        context: z.number().optional(),
        files: z.array(z.object({ path: z.string(), range: z.string().optional() })).optional(),
        modelChain: z.enum(MODEL_CHAIN_VALUES).optional().describe("smart: 模型链路选择，auto=Grok→Antigravity→Codex，grok=强制 progrok API；未填时回退到 chain，再默认 auto；claude-code/cc 必须显式指定，不进入 auto；Windsurf/WSF 没有 sandbox 模型链路，modelChain=windsurf 不受支持"),
        chain: z.enum(MODEL_CHAIN_VALUES).optional().describe("兼容旧参数：smart 模型链路选择，modelChain 未填时使用"),
    });

    server.tool(
        "smart_search",
        "智能代码搜索（三模式：exact 精确 / fuzzy 模糊 / smart 语义）。⚠️ 禁止使用 grep_search，所有代码搜索必须使用本工具。",
        {
            query: z.string().optional().describe("搜索内容（符号名 / 自然语言描述）"),
            mode: z.enum(["exact", "fuzzy", "smart"]).optional().describe("搜索模式"),
            searchPath: z.string().optional().describe("搜索根目录"),
            includes: z.array(z.string()).optional().describe("文件类型过滤 [\"*.ts\", \"*.py\"]"),
            excludes: z.array(z.string()).optional().describe("排除目录/文件"),
                maxResults: z.number().optional().describe("最大返回条数：exact 默认 50，fuzzy/smart 自动定位默认 12"),
            caseSensitive: z.boolean().optional().describe("exact: 大小写敏感（默认 false）"),
            isRegex: z.boolean().optional().describe("exact: 正则模式（默认 false）"),
            matchPerLine: z.boolean().optional().describe("exact: true=行级结果, false=文件级（默认 true）"),
            context: z.number().optional().describe("exact: 上下文行数（默认 2）"),
            files: z.array(z.object({
                path: z.string(),
                range: z.string().optional(),
            })).optional().describe("smart: 指定文件+范围"),
            modelChain: z.enum(MODEL_CHAIN_VALUES).optional()
                .describe("smart: 模型链路，auto=Grok→Antigravity→Codex，grok=强制 progrok API，antigravity=强制 LS，codex=强制 Codex bridge，claude-code/cc=显式 Claude Code CLI；未填回退到 chain；Windsurf/WSF 只能作为 MCP 客户端，不支持 modelChain=windsurf"),
            chain: z.enum(MODEL_CHAIN_VALUES).optional()
                .describe("兼容旧参数：smart 模型链路，modelChain 未填时使用"),
            // 批量查询（v1.8+）
            queries: z.array(QueryItemSchema).optional()
                .describe("批量查询：每项可继承或覆盖顶层参数，内部并行执行"),
            background: z.boolean().optional()
                .describe("smart 模式默认后台；设为 false 可强制前台，true 会先返回 taskId，后续用 taskId 查询"),
            taskId: z.string().optional()
                .describe("查询后台 smart_search 任务的 taskId"),
            waitSeconds: z.number().optional()
                .describe("查询后台任务时等待秒数(1-300)，任务完成时提前返回"),
            ownerId: z.string().optional()
                .describe("任务归属 ID；未传按 global 兼容旧调用"),
        },
        async (args) => {
            const globalStart = Date.now();
            const ownerId = normalizeOwnerId(args.ownerId);

            // ── 单查询执行函数 ──
            async function executeSingleQuery(q: {
                query: string;
                mode: string;
                searchPath: string;
                includes?: string[];
                excludes?: string[];
                maxResults?: number;
                caseSensitive?: boolean;
                isRegex?: boolean;
                matchPerLine?: boolean;
                context?: number;
                files?: Array<{ path: string; range?: string }>;
                modelChain?: ModelChain;
                chain?: ModelChain;
                background?: boolean;
                signal?: AbortSignal;
            }): Promise<string> {
                switch (q.mode) {
                    case "exact": {
                        const data = await searchExact(q.query, q.searchPath, {
                            caseSensitive: q.caseSensitive,
                            isRegex: q.isRegex,
                            matchPerLine: q.matchPerLine,
                            context: q.context ?? 2,
                            includes: q.includes,
                            excludes: q.excludes,
                            maxResults: q.maxResults ?? 50,
                            signal: q.signal,
                        });
                        return formatExactResult(q.query, data, q.matchPerLine !== false);
                    }
                    case "fuzzy": {
                        const results = await searchFuzzy(q.query, q.searchPath, {
                            includes: q.includes,
                            excludes: q.excludes,
                            maxResults: q.maxResults ?? SMART_DEFAULT_MAX_RESULTS,
                            signal: q.signal,
                        });
                        return formatFuzzyResult(q.query, results);
                    }
                    case "smart": {
                        const smartOutput = await searchSmart(q.query, q.searchPath, {
                            modelChain: q.modelChain,
                            chain: q.chain,
                            includes: q.includes,
                            excludes: q.excludes,
                            maxResults: q.maxResults,
                            files: q.files,
                            background: q.background,
                            signal: q.signal,
                        });
                        return `🧠 语义搜索 "${q.query}" (chain=${smartOutput.chainUsed})\n\n${smartOutput.text}`;
                    }
                    default:
                        return `❌ 未知模式: ${q.mode}`;
                }
            }

            if (args.taskId) {
                const task = await waitForBackgroundTask(args.taskId, args.waitSeconds || 0, ownerId);
                const elapsed = Date.now() - globalStart;
                return {
                    content: [{
                        type: "text" as const,
                        text: `${formatBackgroundTask(task)}\n\n⏱ 耗时: ${(elapsed / 1000).toFixed(1)}s`,
                    }],
                };
            }

            if (shouldRunSmartInBackground({
                mode: args.mode,
                background: args.background,
                queries: args.queries,
                taskId: args.taskId,
            })) {
                if (args.queries && args.queries.length > 0) {
                    return { content: [{ type: "text" as const, text: "❌ smart_search 后台模式暂只支持单查询；批量查询请拆成多个 taskId。" }] };
                }
                if (!args.query || !args.mode || !args.searchPath) {
                    return { content: [{ type: "text" as const, text: "❌ 后台模式需要提供 query、mode、searchPath 参数" }] };
                }
                const task = startBackgroundTask("smart-search", async (_progress, signal) => {
                    const start = Date.now();
                    const output = await executeSingleQuery({
                        query: args.query!,
                        mode: args.mode!,
                        searchPath: args.searchPath!,
                        includes: args.includes,
                        excludes: args.excludes,
                        maxResults: args.maxResults,
                        caseSensitive: args.caseSensitive,
                        isRegex: args.isRegex,
                        matchPerLine: args.matchPerLine,
                        context: args.context,
                        files: args.files,
                        modelChain: args.modelChain as ModelChain | undefined,
                        chain: args.chain as ModelChain | undefined,
                        background: true,
                        signal,
                    });
                    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
                    return `${output}\n\n⏱ 耗时: ${elapsed}s`;
                }, {
                    ownerId,
                    maxRunMs: SMART_BACKGROUND_MAX_RUN_MS,
                });
                return {
                    content: [{
                        type: "text" as const,
                        text: [
                            "🚀 smart_search 已转入后台任务",
                            `🆔 taskId: ${task.id}`,
                            `👤 ownerId: ${task.ownerId}`,
                            `⏳ deadlineAt: ${task.deadlineAt}`,
                            `🔗 modelChain: ${resolveModelChainParam(args.chain as ModelChain | undefined, args.modelChain as ModelChain | undefined)}`,
                            "💡 后续调用 smart_search(taskId=\"...\") 查询结果",
                        ].join("\n"),
                    }],
                };
            }

            try {
                // ── 批量模式 ──
                if (args.queries && args.queries.length > 0) {
                    const defaultMode = args.mode ?? "exact";
                    const defaultPath = args.searchPath ?? ".";
                    const total = args.queries.length;

                    // 并发限制：smart 模式最多 2 并发，其他最多 5
                    const hasSmartQuery = args.queries.some(q => (q.mode ?? defaultMode) === "smart");
                    const concurrencyLimit = hasSmartQuery ? 2 : 5;

                    // 带并发限制的执行器
                    const results: string[] = new Array(total);
                    let cursor = 0;

                    async function runNext(): Promise<void> {
                        while (cursor < total) {
                            const idx = cursor++;
                            const q = args.queries![idx];
                            const merged = {
                                query: q.query,
                                mode: q.mode ?? defaultMode,
                                searchPath: q.searchPath ?? defaultPath,
                                includes: q.includes ?? args.includes,
                                excludes: q.excludes ?? args.excludes,
                                maxResults: q.maxResults ?? args.maxResults,
                                caseSensitive: q.caseSensitive ?? args.caseSensitive,
                                isRegex: q.isRegex ?? args.isRegex,
                                matchPerLine: q.matchPerLine ?? args.matchPerLine,
                                context: q.context ?? args.context,
                                files: q.files ?? args.files,
                                modelChain: (q.modelChain as ModelChain | undefined) ?? (args.modelChain as ModelChain | undefined),
                                chain: (q.chain as ModelChain | undefined) ?? (args.chain as ModelChain | undefined),
                                background: false,
                                signal: undefined,
                            };
                            const start = Date.now();
                            try {
                                const output = await executeSingleQuery(merged);
                                const elapsed = ((Date.now() - start) / 1000).toFixed(1);
                                results[idx] = `[${idx + 1}/${total}] ${merged.mode} "${q.query}" (${elapsed}s)\n${output}`;
                            } catch (err: any) {
                                results[idx] = `[${idx + 1}/${total}] ❌ "${q.query}" 失败: ${err.message}`;
                            }
                        }
                    }

                    const workers = Array.from({ length: Math.min(concurrencyLimit, total) }, () => runNext());
                    await Promise.all(workers);

                    const elapsed = ((Date.now() - globalStart) / 1000).toFixed(1);
                    const output = `🔍 批量搜索 — ${total} 个查询\n\n${results.join("\n\n")}\n\n⏱ 总耗时: ${elapsed}s（并发=${Math.min(concurrencyLimit, total)}）`;
                    return { content: [{ type: "text" as const, text: output }] };
                }

                // ── 单查询模式（向后兼容） ──
                if (!args.query) {
                    return { content: [{ type: "text" as const, text: "❌ 需要提供 query 或 queries 参数" }] };
                }
                if (!args.mode) {
                    return { content: [{ type: "text" as const, text: "❌ 需要提供 mode 参数" }] };
                }
                if (!args.searchPath) {
                    return { content: [{ type: "text" as const, text: "❌ 需要提供 searchPath 参数" }] };
                }

                let output = await executeSingleQuery({
                    query: args.query,
                    mode: args.mode,
                    searchPath: args.searchPath,
                    includes: args.includes,
                    excludes: args.excludes,
                    maxResults: args.maxResults,
                    caseSensitive: args.caseSensitive,
                    isRegex: args.isRegex,
                    matchPerLine: args.matchPerLine,
                    context: args.context,
                    files: args.files,
                    modelChain: args.modelChain as ModelChain | undefined,
                    chain: args.chain as ModelChain | undefined,
                    background: false,
                    signal: undefined,
                });

                const elapsed = Date.now() - globalStart;
                output += `\n\n⏱ 耗时: ${(elapsed / 1000).toFixed(1)}s`;
                return { content: [{ type: "text" as const, text: output }] };
            } catch (err: any) {
                return { content: [{ type: "text" as const, text: `❌ 搜索失败: ${err.message}` }] };
            }
        }
    );
}
