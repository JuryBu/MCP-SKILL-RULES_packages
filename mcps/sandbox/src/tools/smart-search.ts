/**
 * Smart Search 工具 — 三模式代码搜索
 *
 * exact:  ripgrep 精确匹配（替代 grep_search）
 * fuzzy:  tree-sitter AST 符号 + fuse.js 模糊搜索
 * smart:  语义搜索（Antigravity LS / Codex 双链路）
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import Fuse from "fuse.js";
import { scanDirectory, flattenSymbols, type SymbolInfo, type FileIndex } from "../symbol-index.js";
import { callModelBridge, type ModelChain } from "../model-bridge.js";
import { startBackgroundTask, waitForBackgroundTask, formatBackgroundTask } from "../background-tasks.js";
import { normalizeOwnerId } from "../owner.js";

const SMART_FILES_TIMEOUT_MS = Number(process.env.SANDBOX_SMART_FILES_TIMEOUT_MS || "120000");
const SMART_STAGE1_TIMEOUT_MS = Number(process.env.SANDBOX_SMART_STAGE1_TIMEOUT_MS || "90000");
const SMART_STAGE2_TIMEOUT_MS = Number(process.env.SANDBOX_SMART_STAGE2_TIMEOUT_MS || "120000");
const SMART_CODEX_FILES_TIMEOUT_MS = Number(process.env.SANDBOX_SMART_CODEX_FILES_TIMEOUT_MS || "45000");
const SMART_CODEX_STAGE_TIMEOUT_MS = Number(process.env.SANDBOX_SMART_CODEX_STAGE_TIMEOUT_MS || "25000");
const SMART_CODEX_BACKGROUND_FILES_TIMEOUT_MS = Number(process.env.SANDBOX_SMART_CODEX_BACKGROUND_FILES_TIMEOUT_MS || 5 * 60_000);
const SMART_CODEX_BACKGROUND_STAGE_TIMEOUT_MS = Number(process.env.SANDBOX_SMART_CODEX_BACKGROUND_STAGE_TIMEOUT_MS || 2 * 60_000);
const SMART_CLAUDE_CODE_FILES_TIMEOUT_MS = Number(process.env.SANDBOX_SMART_CLAUDE_CODE_FILES_TIMEOUT_MS || 2 * 60_000);
const SMART_CLAUDE_CODE_STAGE_TIMEOUT_MS = Number(process.env.SANDBOX_SMART_CLAUDE_CODE_STAGE_TIMEOUT_MS || 90_000);
const SMART_CLAUDE_CODE_BACKGROUND_FILES_TIMEOUT_MS = Number(process.env.SANDBOX_SMART_CLAUDE_CODE_BACKGROUND_FILES_TIMEOUT_MS || 5 * 60_000);
const SMART_CLAUDE_CODE_BACKGROUND_STAGE_TIMEOUT_MS = Number(process.env.SANDBOX_SMART_CLAUDE_CODE_BACKGROUND_STAGE_TIMEOUT_MS || 2 * 60_000);
const SMART_BACKGROUND_MAX_RUN_MS = Number(process.env.SANDBOX_SMART_BACKGROUND_MAX_RUN_MS || 15 * 60_000);
const MODEL_CHAIN_VALUES = ["auto", "antigravity", "codex", "claude-code", "cc"] as const;

function resolveModelChainParam(chain?: ModelChain, modelChain?: ModelChain): ModelChain {
    return modelChain ?? chain ?? "auto";
}

// ===== ripgrep 路径发现 =====

let rgPath: string | null = null;

function findRipgrep(): string | null {
    if (rgPath !== null) return rgPath;

    // 1. PATH 中的 rg
    try {
        const { execSync } = require("child_process");
        execSync("rg --version", { stdio: "pipe", timeout: 3000 });
        rgPath = "rg";
        return rgPath;
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
    }
): Promise<{ results: ExactResult[]; fileOnly: string[]; engine: string }> {
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

        child.stdout.on("data", (d: Buffer) => { stdout += d.toString("utf-8"); });
        child.stderr.on("data", (d: Buffer) => { stderr += d.toString("utf-8"); });
        child.on("close", (code) => {
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
    opts: { includes?: string[]; excludes?: string[]; maxResults?: number }
): Promise<Array<SymbolInfo & { file: string; score: number }>> {
    const index = await scanDirectory(searchPath, {
        includes: opts.includes,
        excludes: opts.excludes,
    });

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
    }
): Promise<{ chainUsed: "antigravity" | "codex" | "claude-code"; text: string }> {
    // 入口1：有 files 参数 → 直接读文件分析
    if (opts.files && opts.files.length > 0) {
        return smartWithFiles(query, searchPath, opts.files, resolveModelChainParam(opts.chain, opts.modelChain), opts.background);
    }
    // 入口2：两阶段自动定位
    return smartTwoStage(query, searchPath, opts);
}

async function smartWithFiles(
    query: string,
    basePath: string,
    files: Array<{ path: string; range?: string }>,
    chain: ModelChain,
    background = false,
): Promise<{ chainUsed: "antigravity" | "codex" | "claude-code"; text: string }> {
    const contents: string[] = [];

    for (const f of files) {
        const fullPath = path.isAbsolute(f.path) ? f.path : path.join(basePath, f.path);
        // 🔴 路径遍历防护：确保文件在 basePath 内
        const resolved = path.resolve(fullPath);
        const base = path.resolve(basePath);
        if (!resolved.startsWith(base + path.sep) && resolved !== base) {
            contents.push(`=== ${f.path} — 拒绝访问（路径越界） ===`);
            continue;
        }
        try {
            const text = fs.readFileSync(fullPath, "utf-8");
            const lines = text.split("\n");

            if (f.range) {
                const match = f.range.match(/^#?(\d+)-(\d+)$/);
                if (match) {
                    const start = parseInt(match[1]) - 1;
                    const end = parseInt(match[2]);
                    contents.push(`=== ${f.path} (L${match[1]}-L${match[2]}) ===\n${lines.slice(start, end).join("\n")}`);
                } else if (f.range.startsWith("first")) {
                    const n = parseInt(f.range.replace("first", "")) || 20;
                    contents.push(`=== ${f.path} (前${n}行) ===\n${lines.slice(0, n).join("\n")}`);
                } else if (f.range.startsWith("last")) {
                    const n = parseInt(f.range.replace("last", "")) || 20;
                    contents.push(`=== ${f.path} (后${n}行) ===\n${lines.slice(-n).join("\n")}`);
                } else {
                    contents.push(`=== ${f.path} (未知 range: ${f.range}; 全文, ${lines.length}行) ===\n${text}`);
                }
            } else {
                contents.push(`=== ${f.path} (全文, ${lines.length}行) ===\n${text}`);
            }
        } catch {
            contents.push(`=== ${f.path} — 读取失败 ===`);
        }
    }

    const prompt = `你是一个代码分析助手。用户想在以下代码中找到: "${query}"

请分析代码并返回：
- 最相关的函数/类/变量名
- 所在行号范围
- 简短逻辑说明

代码内容：
${contents.join("\n\n")}`;

    const timeoutMs = chain === "codex"
        ? (background ? SMART_CODEX_BACKGROUND_FILES_TIMEOUT_MS : SMART_CODEX_FILES_TIMEOUT_MS)
        : (chain === "claude-code" || chain === "cc")
            ? (background ? SMART_CLAUDE_CODE_BACKGROUND_FILES_TIMEOUT_MS : SMART_CLAUDE_CODE_FILES_TIMEOUT_MS)
        : SMART_FILES_TIMEOUT_MS;
    const result = await callModelBridge(chain, prompt, timeoutMs);
    return { chainUsed: result.chainUsed, text: result.text };
}

async function smartTwoStage(
    query: string,
    searchPath: string,
    opts: { modelChain?: ModelChain; chain?: ModelChain; includes?: string[]; excludes?: string[]; maxResults?: number; background?: boolean }
): Promise<{ chainUsed: "antigravity" | "codex" | "claude-code"; text: string }> {
    // 阶段1：符号索引 + fuzzy 线索 → 当前模型链路快速选文件
    const index = await scanDirectory(searchPath, {
        includes: opts.includes,
        excludes: opts.excludes,
    });

    const allSymbols = flattenSymbols(index);

    // 构建文件概览
    const fileOverview = [...index.entries()].map(([filePath, fi]) => {
        const relPath = path.relative(searchPath, filePath);
        const symbols = fi.symbols.map(s => `${s.name}(${s.type})`).join(", ");
        return `${relPath}: ${fi.headerComment.split("\n")[0]} | 符号: ${symbols || "无"}`;
    }).join("\n");

    // fuzzy 线索
    const fuse = new Fuse(allSymbols, {
        keys: ["name"],
        threshold: 0.5,
        includeScore: true,
    });
    const fuzzyHints = fuse.search(query, { limit: 5 })
        .map(r => `${r.item.name}(${r.item.type}) @ ${(r.item as any).file}`)
        .join(", ");

    const stage1Prompt = `你是代码文件定位助手。用户想找: "${query}"

以下是项目文件概览和符号列表：
${fileOverview.substring(0, 8000)}

模糊匹配线索: ${fuzzyHints || "无"}

请返回 JSON 格式：最相关的 3-5 个文件的相对路径列表。
格式: ["file1.ts", "file2.ts", ...]`;

    const requestedChain = resolveModelChainParam(opts.chain, opts.modelChain);
    const stage1TimeoutMs = requestedChain === "codex"
        ? (opts.background ? SMART_CODEX_BACKGROUND_STAGE_TIMEOUT_MS : SMART_CODEX_STAGE_TIMEOUT_MS)
        : (requestedChain === "claude-code" || requestedChain === "cc")
            ? (opts.background ? SMART_CLAUDE_CODE_BACKGROUND_STAGE_TIMEOUT_MS : SMART_CLAUDE_CODE_STAGE_TIMEOUT_MS)
        : SMART_STAGE1_TIMEOUT_MS;
    const stage1 = await callModelBridge(requestedChain, stage1Prompt, stage1TimeoutMs);
    const stage1Result = stage1.text;

    // 解析候选文件
    let candidateFiles: string[] = [];
    try {
        const jsonMatch = stage1Result.match(/\[[\s\S]*?\]/);
        if (jsonMatch) {
            candidateFiles = JSON.parse(jsonMatch[0]);
        }
    } catch { /* fallback */ }

    if (candidateFiles.length === 0) {
        return {
            chainUsed: stage1.chainUsed,
            text: `⚠️ 阶段1未返回有效文件列表\n\n模型原始回复:\n${stage1Result}`,
        };
    }

    // 阶段2：读候选文件全文 → 同链路深度分析；Antigravity auto 会按 M132→M20→M18→M16→M36 fallback
    const fileContents: string[] = [];
    for (const relPath of candidateFiles.slice(0, 5)) {
        const fullPath = path.resolve(path.join(searchPath, relPath));
        const base = path.resolve(searchPath);
        // 🔴 路径遍历防护
        if (!fullPath.startsWith(base + path.sep) && fullPath !== base) {
            fileContents.push(`=== ${relPath} — 已跳过（路径越界） ===`);
            continue;
        }
        try {
            const text = fs.readFileSync(fullPath, "utf-8");
            fileContents.push(`=== ${relPath} (${text.split("\n").length}行) ===\n${text}`);
        } catch {
            fileContents.push(`=== ${relPath} — 读取失败 ===`);
        }
    }

    const stage2Prompt = `你是代码分析助手。用户想找: "${query}"

以下是候选文件的完整代码：
${fileContents.join("\n\n")}

请分析并返回（中文）：
- 最相关的函数/类型/变量名及所在文件和行号
- 每个匹配的简短逻辑说明
- 按相关度排序`;

    const stage2TimeoutMs = stage1.chainUsed === "codex"
        ? (opts.background ? SMART_CODEX_BACKGROUND_STAGE_TIMEOUT_MS : SMART_CODEX_STAGE_TIMEOUT_MS)
        : stage1.chainUsed === "claude-code"
            ? (opts.background ? SMART_CLAUDE_CODE_BACKGROUND_STAGE_TIMEOUT_MS : SMART_CLAUDE_CODE_STAGE_TIMEOUT_MS)
        : SMART_STAGE2_TIMEOUT_MS;
    const stage2 = await callModelBridge(stage1.chainUsed, stage2Prompt, stage2TimeoutMs);
    return { chainUsed: stage2.chainUsed, text: stage2.text };
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
        modelChain: z.enum(MODEL_CHAIN_VALUES).optional().describe("smart: 模型链路选择，未填时回退到 chain，再默认 auto；claude-code/cc 必须显式指定，不进入 auto"),
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
            maxResults: z.number().optional().describe("最大返回条数（默认 50）"),
            caseSensitive: z.boolean().optional().describe("exact: 大小写敏感（默认 false）"),
            isRegex: z.boolean().optional().describe("exact: 正则模式（默认 false）"),
            matchPerLine: z.boolean().optional().describe("exact: true=行级结果, false=文件级（默认 true）"),
            context: z.number().optional().describe("exact: 上下文行数（默认 2）"),
            files: z.array(z.object({
                path: z.string(),
                range: z.string().optional(),
            })).optional().describe("smart: 指定文件+范围"),
            modelChain: z.enum(MODEL_CHAIN_VALUES).optional()
                .describe("smart: 模型链路，auto=当前宿主优先且不会默认调用 Claude Code，antigravity=强制 LS，codex=强制 Codex bridge，claude-code/cc=显式 Claude Code CLI；未填回退到 chain"),
            chain: z.enum(MODEL_CHAIN_VALUES).optional()
                .describe("兼容旧参数：smart 模型链路，modelChain 未填时使用"),
            // 批量查询（v1.8+）
            queries: z.array(QueryItemSchema).optional()
                .describe("批量查询：每项可继承或覆盖顶层参数，内部并行执行"),
            background: z.boolean().optional()
                .describe("smart 模式可设为 true，先返回 taskId，后续用 taskId 查询"),
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
                        });
                        return formatExactResult(q.query, data, q.matchPerLine !== false);
                    }
                    case "fuzzy": {
                        const results = await searchFuzzy(q.query, q.searchPath, {
                            includes: q.includes,
                            excludes: q.excludes,
                            maxResults: q.maxResults ?? 20,
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

            if (args.background) {
                if (args.queries && args.queries.length > 0) {
                    return { content: [{ type: "text" as const, text: "❌ smart_search 后台模式暂只支持单查询；批量查询请拆成多个 taskId。" }] };
                }
                if (!args.query || !args.mode || !args.searchPath) {
                    return { content: [{ type: "text" as const, text: "❌ 后台模式需要提供 query、mode、searchPath 参数" }] };
                }
                const task = startBackgroundTask("smart-search", async () => {
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

