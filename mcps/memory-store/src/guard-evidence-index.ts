import crypto from "crypto";
import fs from "fs";
import path from "path";
import { spawn, execFile } from "child_process";
import { promisify } from "util";
import { TEMP_DIR, ensureTempDir } from "./temp-store.js";

export const GUARD_EVIDENCE_INDEX_START = "<<<GUARD_EVIDENCE_INDEX>>>";
export const GUARD_EVIDENCE_INDEX_END = "<<<END_GUARD_EVIDENCE_INDEX>>>";
const GUARD_EVIDENCE_INDEX_VERSION = 1;
const DEFAULT_PER_FILE_CHARS = Number(process.env.MEMORY_STORE_GUARD_EVIDENCE_FILE_CHARS || 24_000);
const DEFAULT_TOTAL_CHARS = Number(process.env.MEMORY_STORE_GUARD_EVIDENCE_TOTAL_CHARS || 80_000);
const DIRECT_TEXT_MAX_BYTES = Number(process.env.MEMORY_STORE_GUARD_EVIDENCE_DIRECT_TEXT_BYTES || 2 * 1024 * 1024);
const ARTIFACT_MAX_BYTES = Number(process.env.MEMORY_STORE_GUARD_EVIDENCE_ARTIFACT_MAX_BYTES || 768 * 1024);
const CLI_TIMEOUT_MS = Number(process.env.MEMORY_STORE_GUARD_EVIDENCE_CLI_TIMEOUT_MS || 120_000);
const PYTHON_TIMEOUT_MS = Number(process.env.MEMORY_STORE_GUARD_EVIDENCE_PYTHON_TIMEOUT_MS || 90_000);
const CLI_ATTEMPTS_PER_MODEL = Math.max(1, Number(process.env.MEMORY_STORE_GUARD_EVIDENCE_CLI_RETRIES || 0) + 1);

export type GuardEvidenceKind = "text" | "csv" | "image" | "pdf" | "doc" | "sheet" | "epub" | "video" | "binary";
export type GuardEvidenceIngestMode =
    | "direct_text"
    | "image_metadata"
    | "agentic_index"
    | "structured_extract"
    | "unreadable_stub";
export type GuardEvidenceIndexMode = "auto" | "reuse" | "rebuild" | "off";

export interface GuardEvidenceAssetInput {
    path: string;
    label?: string;
    type?: string;
    role?: string;
    range?: string;
    maxChars?: number;
}

export interface GuardEvidenceIndexItem {
    path: string;
    label?: string;
    role?: string;
    kind: GuardEvidenceKind;
    ingestMode: GuardEvidenceIngestMode;
    parser: string;
    ok: boolean;
    artifactPath?: string;
    cachePath?: string;
    sizeBytes?: number;
    mtimeMs?: number;
    text: string;
    warnings: string[];
}

export interface GuardEvidenceIndexResult {
    text: string;
    items: GuardEvidenceIndexItem[];
    manifestPath: string;
}

interface BuildGuardEvidenceIndexOptions {
    indexMode?: GuardEvidenceIndexMode;
    maxTotalChars?: number;
    maxFileChars?: number;
}

interface CliIndexResult {
    cli: "gemini" | "codex";
    text: string;
    artifactPath: string;
    notes: string[];
}

interface SpawnResult {
    exitCode: number | null;
    timedOut: boolean;
    stdoutPath: string;
    stderrPath: string;
}

function killProcessTree(pid?: number): void {
    if (!pid) return;
    if (process.platform === "win32") {
        execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => {});
        return;
    }
    try {
        process.kill(-pid, "SIGKILL");
    } catch {
        try {
            process.kill(pid, "SIGKILL");
        } catch {
            // best effort cleanup
        }
    }
}

function killProcessesMatching(needle: string): void {
    if (!needle || process.platform !== "win32") return;
    const script = [
        `$needle = ${psSingleQuoted(needle)}`,
        "$current = $PID",
        "Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $current -and $_.CommandLine -like ('*' + $needle + '*') } | ForEach-Object {",
        "  Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue",
        "}",
    ].join("\n");
    execFile("powershell.exe", ["-NoProfile", "-Command", script], { windowsHide: true }, () => {});
}

const execFileAsync = promisify(execFile);

const TEXT_EXTENSIONS = new Set([
    ".txt", ".md", ".markdown", ".json", ".jsonl", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf",
    ".xml", ".html", ".htm", ".log", ".sql", ".py", ".js", ".jsx", ".ts", ".tsx", ".c", ".cc", ".cpp",
    ".h", ".hpp", ".java", ".go", ".rs", ".sh", ".ps1", ".bat", ".cmd",
]);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tiff", ".svg"]);
const PDF_EXTENSIONS = new Set([".pdf"]);
const DOC_EXTENSIONS = new Set([".docx", ".doc"]);
const SHEET_EXTENSIONS = new Set([".xlsx", ".xls", ".ods"]);
const EPUB_EXTENSIONS = new Set([".epub"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".mkv", ".avi", ".webm"]);

function clip(text: string, maxChars: number): string {
    if (text.length <= maxChars) return text;
    return `${text.slice(0, Math.max(0, maxChars - 80))}\n\n...[truncated ${text.length} -> ${maxChars} chars]`;
}

function sha256Text(text: string): string {
    return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function safeName(input: string): string {
    return input.replace(/[^\w.-]+/gu, "_").slice(0, 80) || "index";
}

function nowStamp(): string {
    const now = new Date();
    const random = Math.random().toString(36).slice(2, 8);
    return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}${String(now.getMilliseconds()).padStart(3, "0")}-${process.pid}-${random}`;
}

export function guardEvidenceIndexDir(): string {
    ensureTempDir();
    const directory = path.join(TEMP_DIR, "stage-guard-evidence-indexes");
    fs.mkdirSync(directory, { recursive: true });
    return directory;
}

function classifyEvidencePath(filePath: string, explicitType?: string): GuardEvidenceKind {
    const rawType = explicitType?.toLowerCase().trim();
    if (rawType && ["text", "csv", "image", "pdf", "doc", "sheet", "epub", "video", "binary"].includes(rawType)) {
        return rawType as GuardEvidenceKind;
    }
    const extension = path.extname(filePath).toLowerCase();
    if (IMAGE_EXTENSIONS.has(extension)) return "image";
    if (PDF_EXTENSIONS.has(extension)) return "pdf";
    if (DOC_EXTENSIONS.has(extension)) return "doc";
    if (SHEET_EXTENSIONS.has(extension)) return "sheet";
    if (EPUB_EXTENSIONS.has(extension)) return "epub";
    if (VIDEO_EXTENSIONS.has(extension)) return "video";
    if (extension === ".csv" || extension === ".tsv") return "csv";
    if (TEXT_EXTENSIONS.has(extension)) return "text";
    return "binary";
}

function parseRange(range: string | undefined, lines: string[]): string {
    if (!range) return lines.join("\n");
    const lineRange = range.match(/^#?(\d+)-(\d+)$/u);
    if (lineRange) {
        const start = Math.max(0, Number(lineRange[1]) - 1);
        const end = Math.min(lines.length, Number(lineRange[2]));
        return lines.slice(start, end).join("\n");
    }
    const first = range.match(/^first(\d+)$/iu);
    if (first) return lines.slice(0, Number(first[1])).join("\n");
    const last = range.match(/^last(\d+)$/iu);
    if (last) return lines.slice(-Number(last[1])).join("\n");
    return lines.join("\n");
}

function readUtf8Prefix(filePath: string, maxBytes: number): { text: string; truncated: boolean } {
    const stat = fs.statSync(filePath);
    const byteCount = Math.min(stat.size, maxBytes);
    const descriptor = fs.openSync(filePath, "r");
    try {
        const buffer = Buffer.alloc(byteCount);
        const bytesRead = fs.readSync(descriptor, buffer, 0, byteCount, 0);
        return {
            text: buffer.subarray(0, bytesRead).toString("utf-8"),
            truncated: stat.size > byteCount,
        };
    } finally {
        fs.closeSync(descriptor);
    }
}

function buildArtifactPath(filePath: string, suffix: string): string {
    return path.join(guardEvidenceIndexDir(), `${safeName(path.basename(filePath))}_${safeName(suffix)}_${nowStamp()}.md`);
}

function wrapIndexMarkdown(markdown: string): string {
    return `${GUARD_EVIDENCE_INDEX_START}\n${markdown.trim()}\n${GUARD_EVIDENCE_INDEX_END}\n`;
}

function extractMarkedIndex(text: string, artifactPath: string): string {
    const end = text.lastIndexOf(GUARD_EVIDENCE_INDEX_END);
    const start = end >= 0 ? text.lastIndexOf(GUARD_EVIDENCE_INDEX_START, end) : -1;
    if (start >= 0 && end > start) {
        return text.slice(start + GUARD_EVIDENCE_INDEX_START.length, end).trim();
    }
    throw new Error(`${artifactPath} 未找到 ${GUARD_EVIDENCE_INDEX_START}/${GUARD_EVIDENCE_INDEX_END} 标记`);
}

function readMarkedArtifact(artifactPath: string): string {
    const stat = fs.statSync(artifactPath);
    if (stat.size > ARTIFACT_MAX_BYTES) {
        throw new Error(`${artifactPath} 过大 (${stat.size} bytes > ${ARTIFACT_MAX_BYTES} bytes)，拒绝读入 Guard prompt`);
    }
    const raw = fs.readFileSync(artifactPath, "utf-8");
    const text = extractMarkedIndex(raw, artifactPath);
    if (text.length < 40) {
        throw new Error(`Guard 证据索引过短 (${text.length} chars): ${artifactPath}`);
    }
    return text;
}

function metadataFor(filePath: string): { sizeBytes: number; mtimeMs: number } {
    const stat = fs.statSync(filePath);
    return { sizeBytes: stat.size, mtimeMs: stat.mtimeMs };
}

function cacheKey(input: GuardEvidenceAssetInput, resolvedPath: string, kind: GuardEvidenceKind): string {
    const metadata = metadataFor(resolvedPath);
    return sha256Text(JSON.stringify({
        version: GUARD_EVIDENCE_INDEX_VERSION,
        path: resolvedPath,
        kind,
        label: input.label || "",
        type: input.type || "",
        role: input.role || "",
        range: input.range || "",
        sizeBytes: metadata.sizeBytes,
        mtimeMs: Math.round(metadata.mtimeMs),
    }));
}

function cachePathFor(key: string): string {
    return path.join(guardEvidenceIndexDir(), `${key}.json`);
}

function readCachedIndex(cachePath: string): GuardEvidenceIndexItem | null {
    try {
        if (!fs.existsSync(cachePath)) return null;
        const cached = JSON.parse(fs.readFileSync(cachePath, "utf-8")) as GuardEvidenceIndexItem & { version?: number };
        if (cached.version !== undefined && cached.version !== GUARD_EVIDENCE_INDEX_VERSION) return null;
        if (!cached.artifactPath || !fs.existsSync(cached.artifactPath)) return null;
        const text = readMarkedArtifact(cached.artifactPath);
        return { ...cached, text };
    } catch {
        return null;
    }
}

function writeCachedIndex(cachePath: string, item: GuardEvidenceIndexItem): void {
    fs.writeFileSync(cachePath, JSON.stringify({ version: GUARD_EVIDENCE_INDEX_VERSION, ...item, text: undefined }, null, 2), "utf-8");
}

function writeIndexArtifact(filePath: string, suffix: string, markdown: string): string {
    const artifactPath = buildArtifactPath(filePath, suffix);
    fs.writeFileSync(artifactPath, wrapIndexMarkdown(markdown), "utf-8");
    return artifactPath;
}

function formatBaseHeader(input: GuardEvidenceAssetInput, resolvedPath: string, kind: GuardEvidenceKind): string[] {
    const metadata = fs.existsSync(resolvedPath) ? metadataFor(resolvedPath) : undefined;
    return [
        `# Guard 外部证据索引：${input.label || path.basename(resolvedPath)}`,
        "",
        `- 路径：${resolvedPath}`,
        `- 类型：${kind}`,
        input.role ? `- 证据角色：${input.role}` : undefined,
        input.range ? `- 范围提示：${input.range}` : undefined,
        metadata ? `- 大小：${metadata.sizeBytes} bytes` : undefined,
        metadata ? `- 修改时间：${new Date(metadata.mtimeMs).toISOString()}` : undefined,
        "",
    ].filter((line): line is string => Boolean(line));
}

function buildUnreadableItem(input: GuardEvidenceAssetInput, resolvedPath: string, kind: GuardEvidenceKind, reason: string): GuardEvidenceIndexItem {
    const markdown = [
        ...formatBaseHeader(input, resolvedPath, kind),
        "## 读取状态",
        `- 状态：未能读取`,
        `- 原因：${reason}`,
        "",
        "## Guard 使用提示",
        "- 该证据文件不能作为已验证事实，只能作为缺失证据或需人工补证的提示。",
    ].join("\n");
    const artifactPath = writeIndexArtifact(resolvedPath, "unreadable", markdown);
    return {
        path: resolvedPath,
        label: input.label,
        role: input.role,
        kind,
        ingestMode: "unreadable_stub",
        parser: "stub",
        ok: false,
        artifactPath,
        text: markdown,
        warnings: [reason],
    };
}

function indexTextFile(input: GuardEvidenceAssetInput, resolvedPath: string, kind: GuardEvidenceKind, maxChars: number): GuardEvidenceIndexItem {
    const prefix = readUtf8Prefix(resolvedPath, DIRECT_TEXT_MAX_BYTES);
    const scoped = parseRange(input.range, prefix.text.split(/\r?\n/u));
    const clipped = clip(scoped, maxChars);
    const markdown = [
        ...formatBaseHeader(input, resolvedPath, kind),
        "## 类型与读取方式",
        `- 读取方式：UTF-8 前缀读取${prefix.truncated ? "（源文件过大，已按字节预算截断）" : ""}`,
        "",
        "## 文本摘录",
        "```text",
        clipped,
        "```",
        "",
        "## 不确定性与盲点",
        prefix.truncated ? "- 源文件未全量读取；如证据可能位于后半段，应补充更精确 range 或单独证据。" : "- 已读取请求范围内文本。",
    ].join("\n");
    const artifactPath = writeIndexArtifact(resolvedPath, "text", markdown);
    return {
        path: resolvedPath,
        label: input.label,
        role: input.role,
        kind,
        ingestMode: "direct_text",
        parser: kind === "csv" ? "csv/text-prefix" : "utf8-prefix",
        ok: true,
        artifactPath,
        text: markdown,
        warnings: prefix.truncated ? ["源文件超过直接读取字节预算，已截断"] : [],
        ...metadataFor(resolvedPath),
    };
}

function indexImageMetadata(input: GuardEvidenceAssetInput, resolvedPath: string): GuardEvidenceIndexItem {
    const markdown = [
        ...formatBaseHeader(input, resolvedPath, "image"),
        "## 类型与读取方式",
        "- 读取方式：图片元信息索引。当前 Guard 模型输入仍为纯文本；若未启用 CLI/视觉预处理，不能声称已看见图片内容。",
        "",
        "## Guard 使用提示",
        "- 可用于证明图片文件存在、路径可访问、作为待视觉审查证据。",
        "- 若任务验收依赖图片内容，请补充 OCR/视觉描述，或启用复杂证据 CLI 索引链路。",
        "",
        "## 不确定性与盲点",
        "- 未做 OCR、布局识别或视觉理解。",
    ].join("\n");
    const artifactPath = writeIndexArtifact(resolvedPath, "image", markdown);
    return {
        path: resolvedPath,
        label: input.label,
        role: input.role,
        kind: "image",
        ingestMode: "image_metadata",
        parser: "image-metadata",
        ok: true,
        artifactPath,
        text: markdown,
        warnings: ["图片未做 OCR/视觉理解，仅记录元信息"],
        ...metadataFor(resolvedPath),
    };
}

function psSingleQuoted(text: string): string {
    return `'${text.replace(/'/gu, "''")}'`;
}

function splitCsvEnv(name: string, fallback: string[]): string[] {
    const value = process.env[name];
    if (!value) return fallback;
    const items = value.split(",").map((item) => item.trim()).filter(Boolean);
    return items.length > 0 ? items : fallback;
}

function geminiAttempts(filePath: string): Array<{ model: string; approvalMode: string }> {
    const extension = path.extname(filePath).toLowerCase();
    const defaultModels = extension === ".pdf" || VIDEO_EXTENSIONS.has(extension)
        ? ["gemini-3.1-pro-preview", "auto-gemini-3", "gemini-2.5-pro", "gemini-3.1-flash-lite-preview", "gemini-2.5-flash-lite", "gemini-2.5-flash"]
        : ["auto-gemini-3", "gemini-3.1-pro-preview", "gemini-2.5-pro", "gemini-3.1-flash-lite-preview", "gemini-2.5-flash-lite", "gemini-2.5-flash"];
    const models = splitCsvEnv("MEMORY_STORE_GUARD_EVIDENCE_GEMINI_MODELS", defaultModels);
    const approvalModes = splitCsvEnv("MEMORY_STORE_GUARD_EVIDENCE_GEMINI_APPROVAL_MODES", ["auto_edit", "yolo"]);
    return models.flatMap((model) => approvalModes.map((approvalMode) => ({ model, approvalMode })));
}

function codexAttempts(): Array<{ model: string; reasoning: string }> {
    return splitCsvEnv("MEMORY_STORE_GUARD_EVIDENCE_CODEX_MODELS", [
        "gpt-5.4:medium",
        "gpt-5.4:low",
        "gpt-5.4-mini:medium",
        "gpt-5.4-mini:low",
    ]).map((item) => {
        const [model, reasoning] = item.split(":");
        return {
            model: model || "gpt-5.4",
            reasoning: reasoning || "medium",
        };
    });
}

function buildCliIndexPrompt(input: {
    filePath: string;
    label?: string;
    range?: string;
    kind: GuardEvidenceKind;
    artifactPath: string;
    cli: "gemini" | "codex";
}): string {
    const fileName = path.basename(input.filePath);
    const rangeText = input.range ? `用户额外要求的范围提示：${input.range}` : "用户没有给定范围；请自行选择最有价值的结构化读取方式。";
    const cliNote = input.cli === "gemini"
        ? "你可以使用 Gemini CLI 的文件读取、多模态和工具能力。PDF/视频/图片优先用原生多模态理解；Word/Excel/EPUB/其它复杂格式应主动用工具、脚本、解包、库解析或目录探查，不要只说无法读取。"
        : "你可以使用 Codex CLI 的本地工具、MCP、shell 和子代理能力。复杂文件应先做结构化抽取或分块读取，最终只写高密度索引。";
    return [
        "你在为 Stage Guard 准备外部证据文件索引。",
        "目标：只读分析一个证据文件，产出可供纯文本 Guard 审查的结构化索引。",
        cliNote,
        "源文件只读，禁止修改、移动或删除源文件。",
        "你必须把最终索引写入指定临时文件；不要把完整索引打印到 stdout。",
        `临时输出文件：${input.artifactPath}`,
        "stdout/stderr 只允许短状态、错误或诊断。",
        "临时输出文件必须包含以下两个标记，宿主只读取标记之间的 Markdown：",
        GUARD_EVIDENCE_INDEX_START,
        "... Markdown index ...",
        GUARD_EVIDENCE_INDEX_END,
        "",
        "索引必须包含：类型与读取方式、结构索引、关键证据、可引用短摘录、不确定性与盲点。",
        "如果文件很长，建立目录/分块索引，不要全文抄录。",
        "",
        GUARD_EVIDENCE_INDEX_START,
        `# Guard 外部证据索引：${input.label || fileName}`,
        "",
        `- 路径：${input.filePath}`,
        `- 文件名：${fileName}`,
        `- 类型：${input.kind}`,
        `- 范围提示：${rangeText}`,
        "",
        "## 类型与读取方式",
        "- 说明实际采用的读取路径、工具、失败兜底和覆盖范围",
        "",
        "## 结构索引",
        "- 按页码、章节、工作表、段落群、图片或媒体片段列出结构",
        "",
        "## 关键证据",
        "- 提炼与 Guard 验收最相关的事实、数据、命令、结果、图表/表格结论",
        "",
        "## 可引用摘录",
        "- 给出短摘录和来源位置；没有可引用文字时说明原因",
        "",
        "## 不确定性与盲点",
        "- 明确 OCR、版式、图片、视频、附件、公式或读取范围的不确定性",
        GUARD_EVIDENCE_INDEX_END,
        "",
        `现在开始处理文件：${fileName}`,
        `源文件绝对路径：${input.filePath}`,
    ].join("\n");
}

async function spawnPowerShellScript(script: string, cwd: string, logBasePath: string, timeoutMs = CLI_TIMEOUT_MS): Promise<SpawnResult> {
    const scriptPath = `${logBasePath}.ps1`;
    const stdoutPath = `${logBasePath}.stdout.txt`;
    const stderrPath = `${logBasePath}.stderr.txt`;
    fs.writeFileSync(scriptPath, `\uFEFF${script}`, "utf-8");
    fs.writeFileSync(stdoutPath, "", "utf-8");
    fs.writeFileSync(stderrPath, "", "utf-8");
    return await new Promise<SpawnResult>((resolve, reject) => {
        const stdoutDescriptor = fs.openSync(stdoutPath, "a");
        const stderrDescriptor = fs.openSync(stderrPath, "a");
        let settled = false;
        let timedOut = false;
        const child = spawn("powershell.exe", [
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            scriptPath,
        ], {
            cwd,
            windowsHide: true,
            stdio: ["ignore", stdoutDescriptor, stderrDescriptor],
        });
        const timer = setTimeout(() => {
            timedOut = true;
            killProcessTree(child.pid);
            killProcessesMatching(path.basename(logBasePath).replace(/\.run$/u, ""));
            child.kill();
        }, timeoutMs);
        child.on("error", (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            fs.closeSync(stdoutDescriptor);
            fs.closeSync(stderrDescriptor);
            reject(error);
        });
        child.on("close", (exitCode) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            fs.closeSync(stdoutDescriptor);
            fs.closeSync(stderrDescriptor);
            resolve({ exitCode, timedOut, stdoutPath, stderrPath });
        });
    });
}

function readLogClip(filePath: string, maxChars: number): string {
    try {
        if (!fs.existsSync(filePath)) return "";
        const prefix = readUtf8Prefix(filePath, Math.max(4096, maxChars * 4));
        return clip(prefix.text, maxChars);
    } catch {
        return "";
    }
}

function buildGeminiScript(promptPath: string, artifactPath: string, model: string, approvalMode: string): string {
    const indexDir = path.dirname(artifactPath);
    return [
        "$ErrorActionPreference = 'Continue'",
        `$prompt = Get-Content -LiteralPath ${psSingleQuoted(promptPath)} -Raw -Encoding UTF8`,
        `& gemini --skip-trust --include-directories ${psSingleQuoted(indexDir)} --approval-mode ${psSingleQuoted(approvalMode)} -m ${psSingleQuoted(model)} -p $prompt --output-format text`,
        "exit $LASTEXITCODE",
    ].join("\n");
}

function buildCodexScript(promptPath: string, artifactPath: string, model: string, reasoning: string, cwd: string): string {
    const prompt = `Read and follow the full UTF-8 instructions in ${promptPath}. You must write the final Stage Guard evidence index to ${artifactPath}. Do not print the full index to stdout.`;
    return [
        "$ErrorActionPreference = 'Continue'",
        `$prompt = ${psSingleQuoted(prompt)}`,
        `& codex exec --dangerously-bypass-approvals-and-sandbox --ephemeral --skip-git-repo-check -C ${psSingleQuoted(cwd)} -m ${psSingleQuoted(model)} -c ${psSingleQuoted(`model_reasoning_effort=${reasoning}`)} $prompt`,
        "exit $LASTEXITCODE",
    ].join("\n");
}

async function runGeminiCliIndex(filePath: string, kind: GuardEvidenceKind, label?: string, range?: string): Promise<CliIndexResult> {
    const cwd = path.dirname(filePath);
    const notes: string[] = [];
    for (const attempt of geminiAttempts(filePath)) {
        for (let retry = 1; retry <= CLI_ATTEMPTS_PER_MODEL; retry += 1) {
            const artifactPath = buildArtifactPath(filePath, `gemini_${attempt.model}_${attempt.approvalMode}_try${retry}`);
            const promptPath = `${artifactPath}.prompt.txt`;
            fs.writeFileSync(promptPath, buildCliIndexPrompt({ filePath, label, range, kind, artifactPath, cli: "gemini" }), "utf-8");
            const logBase = `${artifactPath}.run`;
            try {
                const result = await spawnPowerShellScript(buildGeminiScript(promptPath, artifactPath, attempt.model, attempt.approvalMode), cwd, logBase);
                const text = readMarkedArtifact(artifactPath);
                return {
                    cli: "gemini",
                    text,
                    artifactPath,
                    notes: [
                        `Gemini CLI index ok: model=${attempt.model}, approvalMode=${attempt.approvalMode}, attempt=${retry}, timedOut=${result.timedOut}`,
                        `stdout=${result.stdoutPath}`,
                        `stderr=${result.stderrPath}`,
                    ],
                };
            } catch (error) {
                const stderr = readLogClip(`${logBase}.stderr.txt`, 900).trim();
                notes.push(`gemini model=${attempt.model} approval=${attempt.approvalMode} attempt=${retry} failed: ${error instanceof Error ? error.message : String(error)}${stderr ? ` | stderr: ${stderr}` : ""}`);
            }
        }
    }
    throw new Error(notes.join("\n") || "Gemini CLI 索引失败");
}

async function runCodexCliIndex(filePath: string, kind: GuardEvidenceKind, label?: string, range?: string): Promise<CliIndexResult> {
    const cwd = path.dirname(filePath);
    const notes: string[] = [];
    for (const attempt of codexAttempts()) {
        for (let retry = 1; retry <= CLI_ATTEMPTS_PER_MODEL; retry += 1) {
            const artifactPath = buildArtifactPath(filePath, `codex_${attempt.model}_${attempt.reasoning}_try${retry}`);
            const promptPath = `${artifactPath}.prompt.txt`;
            fs.writeFileSync(promptPath, buildCliIndexPrompt({ filePath, label, range, kind, artifactPath, cli: "codex" }), "utf-8");
            const logBase = `${artifactPath}.run`;
            try {
                const result = await spawnPowerShellScript(buildCodexScript(promptPath, artifactPath, attempt.model, attempt.reasoning, cwd), cwd, logBase);
                const text = readMarkedArtifact(artifactPath);
                return {
                    cli: "codex",
                    text,
                    artifactPath,
                    notes: [
                        `Codex CLI index ok: model=${attempt.model}, reasoning=${attempt.reasoning}, attempt=${retry}, timedOut=${result.timedOut}`,
                        `stdout=${result.stdoutPath}`,
                        `stderr=${result.stderrPath}`,
                    ],
                };
            } catch (error) {
                const stderr = readLogClip(`${logBase}.stderr.txt`, 900).trim();
                notes.push(`codex model=${attempt.model} reasoning=${attempt.reasoning} attempt=${retry} failed: ${error instanceof Error ? error.message : String(error)}${stderr ? ` | stderr: ${stderr}` : ""}`);
            }
        }
    }
    throw new Error(notes.join("\n") || "Codex CLI 索引失败");
}

function shouldTryCli(kind: GuardEvidenceKind): boolean {
    const mode = (process.env.MEMORY_STORE_GUARD_EVIDENCE_CLI_MODE || "auto").toLowerCase();
    if (mode === "off" || mode === "0" || mode === "false") return false;
    if (mode === "force" || mode === "always" || mode === "1" || mode === "true") return true;
    return kind === "pdf" || kind === "video";
}

async function runCliIndex(filePath: string, kind: GuardEvidenceKind, label?: string, range?: string): Promise<CliIndexResult> {
    const failures: string[] = [];
    try {
        return await runGeminiCliIndex(filePath, kind, label, range);
    } catch (error) {
        failures.push(`gemini: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
        return await runCodexCliIndex(filePath, kind, label, range);
    } catch (error) {
        failures.push(`codex: ${error instanceof Error ? error.message : String(error)}`);
    }
    throw new Error(failures.join("\n"));
}

function formatStructuredFallbackMarkdown(input: {
    title: string;
    filePath: string;
    method: string;
    structure: string[];
    keyPoints: string[];
    excerpts: string[];
    warnings: string[];
}): string {
    return [
        `# Guard 外部证据索引：${input.title}`,
        "",
        `- 路径：${input.filePath}`,
        "",
        "## 类型与读取方式",
        `- 读取方法：${input.method}`,
        "",
        "## 结构索引",
        ...(input.structure.length > 0 ? input.structure : ["- 未能提取结构信息"]),
        "",
        "## 关键证据",
        ...(input.keyPoints.length > 0 ? input.keyPoints : ["- 未提取到关键证据"]),
        "",
        "## 可引用摘录",
        ...(input.excerpts.length > 0 ? input.excerpts.map((line) => `- ${line}`) : ["- 无可直接引用摘录"]),
        "",
        "## 不确定性与盲点",
        ...(input.warnings.length > 0 ? input.warnings.map((line) => `- ${line}`) : ["- 当前结构化提取未覆盖复杂版式、图片和视觉细节"]),
    ].join("\n");
}

async function runPythonStructuredFallback(kind: GuardEvidenceKind, resolvedPath: string, label?: string): Promise<{ text: string; parser: string; warnings: string[]; artifactPath: string }> {
    const outputPath = buildArtifactPath(resolvedPath, "python-output").replace(/\.md$/u, ".json");
    const artifactPath = buildArtifactPath(resolvedPath, "python");
    const script = `
import json, os, re
from pathlib import Path
kind = os.environ["MEMORY_STORE_GUARD_EVIDENCE_KIND"]
file_path = Path(os.environ["MEMORY_STORE_GUARD_EVIDENCE_FILE"])
title = os.environ.get("MEMORY_STORE_GUARD_EVIDENCE_LABEL") or file_path.name
output_path = Path(os.environ["MEMORY_STORE_GUARD_EVIDENCE_OUTPUT"])
out = {"title": title, "method": "", "structure": [], "keyPoints": [], "excerpts": [], "warnings": []}

def clean_lines(lines, limit=10):
    cleaned = []
    for line in lines:
        text = re.sub(r"\\s+", " ", str(line)).strip()
        if text:
            cleaned.append(text)
    return cleaned[:limit]

if kind == "pdf":
    from pypdf import PdfReader
    reader = PdfReader(str(file_path))
    texts = []
    for idx, page in enumerate(reader.pages[:10], start=1):
        text = (page.extract_text() or "").strip()
        if text:
            texts.append((idx, text))
    out["method"] = "python+pypdf"
    out["structure"] = [f"- PDF 共 {len(reader.pages)} 页"] + [f"- 第 {idx} 页有可提取文本" for idx, _ in texts]
    all_text = "\\n".join(text for _, text in texts)
    out["keyPoints"] = [f"- {line}" for line in clean_lines(all_text.splitlines(), 12)]
    out["excerpts"] = clean_lines(all_text.splitlines(), 6)
    out["warnings"] = ["仅提取前 10 页可读文本；扫描件/OCR/复杂版式可能遗漏"]
elif kind == "doc":
    from docx import Document
    doc = Document(str(file_path))
    paragraphs = [p.text for p in doc.paragraphs if p.text.strip()]
    out["method"] = "python-docx"
    out["structure"] = [f"- 段落数: {len(paragraphs)}", f"- 表格数: {len(doc.tables)}"]
    out["keyPoints"] = [f"- {line}" for line in clean_lines(paragraphs, 12)]
    out["excerpts"] = clean_lines(paragraphs, 6)
    out["warnings"] = ["复杂排版、嵌入图片、批注和样式不会完整保留"]
elif kind == "sheet":
    from openpyxl import load_workbook
    wb = load_workbook(str(file_path), read_only=True, data_only=True)
    out["method"] = "openpyxl"
    for ws in wb.worksheets[:8]:
        out["structure"].append(f"- 工作表: {ws.title}")
        rows = []
        for row in ws.iter_rows(min_row=1, max_row=8, values_only=True):
            values = ["" if value is None else str(value) for value in row]
            if any(values):
                rows.append(" | ".join(values))
        for row in rows[:5]:
            out["keyPoints"].append(f"- [{ws.title}] {row}")
        if rows:
            out["excerpts"].append(f"[{ws.title}] " + rows[0])
    out["warnings"] = ["公式只读取 data_only 结果；复杂样式、图表和批注未覆盖"]
elif kind == "epub":
    from ebooklib import epub, ITEM_DOCUMENT
    from bs4 import BeautifulSoup
    book = epub.read_epub(str(file_path))
    docs = [item for item in book.get_items() if item.get_type() == ITEM_DOCUMENT]
    out["method"] = "ebooklib+BeautifulSoup"
    out["structure"] = [f"- 文档片段数: {len(docs)}"]
    texts = []
    for item in docs[:10]:
        soup = BeautifulSoup(item.get_body_content(), "html.parser")
        text = " ".join(soup.get_text("\\n").split())
        if text:
            out["structure"].append(f"- 片段: {item.get_name()}")
            texts.append(text)
    out["keyPoints"] = [f"- {line}" for line in clean_lines(texts, 12)]
    out["excerpts"] = clean_lines(texts, 6)
    out["warnings"] = ["图片、封面和复杂样式未做视觉级理解"]
else:
    raise RuntimeError(f"unsupported kind: {kind}")

output_path.write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
`;
    await execFileAsync("python", ["-c", script], {
        windowsHide: true,
        timeout: PYTHON_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        encoding: "utf-8",
        env: {
            ...process.env,
            MEMORY_STORE_GUARD_EVIDENCE_KIND: kind,
            MEMORY_STORE_GUARD_EVIDENCE_FILE: resolvedPath,
            MEMORY_STORE_GUARD_EVIDENCE_LABEL: label || "",
            MEMORY_STORE_GUARD_EVIDENCE_OUTPUT: outputPath,
        },
    });
    const payload = JSON.parse(fs.readFileSync(outputPath, "utf-8")) as {
        title: string;
        method: string;
        structure: string[];
        keyPoints: string[];
        excerpts: string[];
        warnings: string[];
    };
    const text = formatStructuredFallbackMarkdown({
        title: payload.title,
        filePath: resolvedPath,
        method: payload.method,
        structure: payload.structure,
        keyPoints: payload.keyPoints,
        excerpts: payload.excerpts,
        warnings: payload.warnings,
    });
    fs.writeFileSync(artifactPath, wrapIndexMarkdown(text), "utf-8");
    return { text, parser: payload.method, warnings: payload.warnings, artifactPath };
}

async function buildOneIndex(input: GuardEvidenceAssetInput, options: Required<BuildGuardEvidenceIndexOptions>, remainingChars: number): Promise<GuardEvidenceIndexItem> {
    const resolvedPath = path.resolve(input.path);
    const kind = classifyEvidencePath(resolvedPath, input.type);
    if (!fs.existsSync(resolvedPath)) {
        return buildUnreadableItem(input, resolvedPath, kind, "文件不存在");
    }
    const metadata = metadataFor(resolvedPath);
    const maxChars = Math.max(800, Math.min(input.maxChars || options.maxFileChars, remainingChars));
    const cachePath = cachePathFor(cacheKey(input, resolvedPath, kind));
    if (options.indexMode === "reuse" || options.indexMode === "auto") {
        const cached = readCachedIndex(cachePath);
        if (cached) return { ...cached, cachePath };
        if (options.indexMode === "reuse") {
            return buildUnreadableItem(input, resolvedPath, kind, `未找到可复用索引缓存: ${cachePath}`);
        }
    }
    if (options.indexMode === "off") {
        return buildUnreadableItem(input, resolvedPath, kind, "evidenceIndexMode=off，未读取外部证据文件");
    }

    let item: GuardEvidenceIndexItem;
    try {
        if (kind === "text" || kind === "csv") {
            item = indexTextFile(input, resolvedPath, kind, maxChars);
        } else if (kind === "image" && !shouldTryCli(kind)) {
            item = indexImageMetadata(input, resolvedPath);
        } else {
            try {
                if (!shouldTryCli(kind)) throw new Error(`当前类型 ${kind} 未启用 CLI agentic 索引`);
                const cliResult = await runCliIndex(resolvedPath, kind, input.label, input.range);
                item = {
                    path: resolvedPath,
                    label: input.label,
                    role: input.role,
                    kind,
                    ingestMode: "agentic_index",
                    parser: `${cliResult.cli}-cli`,
                    ok: true,
                    artifactPath: cliResult.artifactPath,
                    text: clip(cliResult.text, maxChars),
                    warnings: cliResult.notes,
                    ...metadata,
                };
            } catch (cliError) {
                if (kind === "pdf" || kind === "doc" || kind === "sheet" || kind === "epub") {
                    try {
                        const fallback = await runPythonStructuredFallback(kind, resolvedPath, input.label);
                        item = {
                            path: resolvedPath,
                            label: input.label,
                            role: input.role,
                            kind,
                            ingestMode: "structured_extract",
                            parser: fallback.parser,
                            ok: true,
                            artifactPath: fallback.artifactPath,
                            text: clip(fallback.text, maxChars),
                            warnings: [`CLI 索引降级: ${cliError instanceof Error ? cliError.message : String(cliError)}`, ...fallback.warnings],
                            ...metadata,
                        };
                    } catch (fallbackError) {
                        item = buildUnreadableItem(input, resolvedPath, kind, `CLI 与本地结构化兜底均失败：${cliError instanceof Error ? cliError.message : String(cliError)} | ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`);
                    }
                } else if (kind === "image") {
                    item = {
                        ...indexImageMetadata(input, resolvedPath),
                        warnings: [`CLI 视觉索引失败，退回图片元信息：${cliError instanceof Error ? cliError.message : String(cliError)}`],
                    };
                } else {
                    item = buildUnreadableItem(input, resolvedPath, kind, `复杂文件无本地兜底且 CLI 失败：${cliError instanceof Error ? cliError.message : String(cliError)}`);
                }
            }
        }
    } catch (error) {
        item = buildUnreadableItem(input, resolvedPath, kind, error instanceof Error ? error.message : String(error));
    }

    item.text = clip(item.text, maxChars);
    item.cachePath = cachePath;
    if (item.ok && item.artifactPath) writeCachedIndex(cachePath, item);
    return item;
}

export async function buildGuardEvidenceIndexes(
    inputs: GuardEvidenceAssetInput[] | undefined,
    options: BuildGuardEvidenceIndexOptions = {},
): Promise<GuardEvidenceIndexResult> {
    const normalizedOptions: Required<BuildGuardEvidenceIndexOptions> = {
        indexMode: options.indexMode || "auto",
        maxTotalChars: options.maxTotalChars || DEFAULT_TOTAL_CHARS,
        maxFileChars: options.maxFileChars || DEFAULT_PER_FILE_CHARS,
    };
    const items: GuardEvidenceIndexItem[] = [];
    let usedChars = 0;
    for (const input of inputs || []) {
        if (!input.path?.trim()) continue;
        const remainingChars = normalizedOptions.maxTotalChars - usedChars;
        if (remainingChars <= 800) {
            items.push(buildUnreadableItem(input, path.resolve(input.path), classifyEvidencePath(input.path, input.type), "Guard 外部证据索引总预算已用尽，未读取该文件"));
            continue;
        }
        const item = await buildOneIndex(input, normalizedOptions, remainingChars);
        items.push(item);
        usedChars += item.text.length + 80;
    }

    const text = items.length === 0
        ? ""
        : [
            "## 外部证据文件索引",
            "",
            items.map((item, index) => [
                `### 证据文件 ${index + 1}: ${item.label || path.basename(item.path)}`,
                `- path: ${item.path}`,
                `- kind: ${item.kind}`,
                `- ingestMode: ${item.ingestMode}`,
                `- parser: ${item.parser}`,
                `- ok: ${item.ok}`,
                item.artifactPath ? `- artifactPath: ${item.artifactPath}` : undefined,
                item.warnings.length ? `- warnings: ${item.warnings.slice(0, 3).join(" | ")}` : undefined,
                "",
                item.text,
            ].filter((line): line is string => Boolean(line)).join("\n")).join("\n\n---\n\n"),
        ].join("\n");

    const manifestPath = path.join(guardEvidenceIndexDir(), `guard_evidence_manifest_${nowStamp()}.json`);
    fs.writeFileSync(manifestPath, JSON.stringify({
        version: GUARD_EVIDENCE_INDEX_VERSION,
        createdAt: new Date().toISOString(),
        indexMode: normalizedOptions.indexMode,
        maxTotalChars: normalizedOptions.maxTotalChars,
        maxFileChars: normalizedOptions.maxFileChars,
        items: items.map((item) => ({ ...item, text: undefined })),
    }, null, 2), "utf-8");

    return { text: clip(text, normalizedOptions.maxTotalChars), items, manifestPath };
}
