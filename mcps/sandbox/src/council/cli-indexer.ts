import fs from "fs";
import os from "os";
import path from "path";
import { buildAntigravityCliEnvironment, spawnPowerShellScript, withAntigravityCliLease } from "./agy-runtime.js";
import { councilRuntimeDirectory } from "./paths.js";
import { councilArtifactPath, registerCouncilArtifact } from "./artifact-store.js";

const INDEX_START = "<<<COUNCIL_INDEX>>>";
const INDEX_END = "<<<END_COUNCIL_INDEX>>>";
const DEFAULT_TIMEOUT_MS = Number(process.env.SANDBOX_COUNCIL_CLI_INDEX_TIMEOUT_MS || 240_000);
const MAX_ARTIFACT_BYTES = Number(process.env.SANDBOX_COUNCIL_CLI_INDEX_MAX_BYTES || 768 * 1024);
const ATTEMPTS_PER_MODEL = Math.max(1, Number(process.env.SANDBOX_COUNCIL_CLI_INDEX_RETRIES || 1) + 1);
const LEGACY_MODEL_LABELS: Record<string, string> = {
    "auto-gemini-3": "Gemini 3.5 Flash (Medium)",
    "gemini-3.1-pro-preview": "Gemini 3.1 Pro (Low)",
    "gemini-3.1-flash-lite-preview": "Gemini 3.5 Flash (Low)",
};

export type CouncilIndexerCli = "antigravity" | "codex";

export interface CouncilCliIndexResult {
    cli: CouncilIndexerCli;
    text: string;
    artifactPath: string;
    notes: string[];
}

interface BuildCouncilFileIndexRequest {
    filePath: string;
    label?: string;
    range?: string;
    preferredCli?: CouncilIndexerCli | "gemini";
    onProgress?: (message: string) => void;
    signal?: AbortSignal;
    timeoutMs?: number;
    imagePaths?: string[];
    command?: string;
    cli?: string;
    params?: {
        command?: string;
        cli?: string;
    };
    runId?: string;
}

type FailureKind = "terminal" | "capacity" | "timeout" | "empty" | "transient";

class CliIndexerFailure extends Error {
    constructor(message: string, readonly kind: FailureKind) {
        super(message);
    }
}

function clip(text: string, maxChars: number): string {
    return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n... (truncated ${text.length - maxChars} chars)`;
}

function safeName(input: string): string {
    return input.replace(/[^\w.-]+/gu, "_").slice(0, 80) || "index";
}

function nowStamp(): string {
    const now = new Date();
    const random = Math.random().toString(36).slice(2, 8);
    return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}${String(now.getMilliseconds()).padStart(3, "0")}-${process.pid}-${random}`;
}

function redactSensitive(text: string): string {
    const home = os.homedir().replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    return text
        .replace(new RegExp(home, "giu"), "<user-home>")
        .replace(/[A-Za-z]:\\Users\\[^\\\s"']+/gu, "<user-dir>")
        .replace(/(authorization|bearer|api[_-]?key|access[_-]?token|refresh[_-]?token|token)\s*[:=]\s*([^\s,;]+)/giu, "$1=<redacted>")
        .replace(/https?:\/\/[^\s"']+(?:[?&](?:token|code|state|key|auth|access_token)=[^\s"']*)?/giu, "<authentication-url>");
}

function redactRunLogs(stdoutPath: string, stderrPath: string): void {
    for (const logPath of [stdoutPath, stderrPath]) {
        let contents = "";
        try {
            contents = fs.readFileSync(logPath, "utf-8");
        } catch {}
        try {
            fs.writeFileSync(logPath, redactSensitive(contents), "utf-8");
        } catch {}
    }
}

function councilIndexDir(runId?: string): string {
    if (runId) return path.dirname(councilArtifactPath(runId, "indexes", "artifact"));
    return councilRuntimeDirectory("council-indexes");
}

export { councilIndexDir };

function antigravityCliAccessibleTempDir(runId?: string): string {
    return runId ? councilIndexDir(runId) : councilRuntimeDirectory("council-indexes");
}

function buildArtifactPath(filePath: string, cli: CouncilIndexerCli, suffix: string, runId?: string): string {
    const dir = cli === "antigravity" ? antigravityCliAccessibleTempDir(runId) : councilIndexDir(runId);
    return path.join(dir, `${safeName(path.basename(filePath))}_${cli}_${safeName(suffix)}_${nowStamp()}.md`);
}

function registerExistingRunArtifacts(runId: string | undefined, paths: string[]): void {
    if (!runId) return;
    for (const artifactPath of paths) {
        if (fs.existsSync(artifactPath)) registerCouncilArtifact(runId, artifactPath);
    }
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

function antigravityAttempts(filePath: string, notes: string[], onProgress?: (message: string) => void): string[] {
    const newEnv = process.env.SANDBOX_COUNCIL_ANTIGRAVITY_INDEX_MODELS;
    const oldEnv = process.env.SANDBOX_COUNCIL_GEMINI_INDEX_MODELS;
    const ext = path.extname(filePath).toLowerCase();
    const multimodal = [".pdf", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".mp4", ".mov", ".mkv", ".avi", ".webm"].includes(ext);
    const defaults = multimodal
        ? ["Gemini 3.5 Flash (High)", "Gemini 3.1 Pro (Low)", "Gemini 3.5 Flash (Medium)"]
        : ["Gemini 3.5 Flash (Low)", "Gemini 3.5 Flash (Medium)", "Gemini 3.1 Pro (Low)"];
    const rawModels = newEnv ? splitCsvEnv("SANDBOX_COUNCIL_ANTIGRAVITY_INDEX_MODELS", defaults) : oldEnv ? splitCsvEnv("SANDBOX_COUNCIL_GEMINI_INDEX_MODELS", defaults) : defaults;
    if (!newEnv && oldEnv) {
        const warning = "弃用环境变量 SANDBOX_COUNCIL_GEMINI_INDEX_MODELS 已映射到 Antigravity CLI；请迁移到 SANDBOX_COUNCIL_ANTIGRAVITY_INDEX_MODELS。";
        notes.push(warning);
        onProgress?.(warning);
    }
    return rawModels.map((model) => LEGACY_MODEL_LABELS[model.toLowerCase()] || model);
}

function codexAttempts(): Array<{ model: string; reasoning: string }> {
    const rawItems = splitCsvEnv("SANDBOX_COUNCIL_CODEX_INDEX_MODELS", ["gpt-5.4:medium", "gpt-5.4:low", "gpt-5.4-mini:medium", "gpt-5.4-mini:low"]);
    return rawItems.map((item) => {
        const [model, reasoning] = item.split(":");
        return { model: model || "gpt-5.4", reasoning: reasoning || process.env.SANDBOX_COUNCIL_CODEX_INDEX_REASONING || "medium" };
    });
}

function extractMarkedSection(text: string): string {
    const end = text.lastIndexOf(INDEX_END);
    const start = end >= 0 ? text.lastIndexOf(INDEX_START, end) : -1;
    if (start >= 0 && end > start) return text.slice(start + INDEX_START.length, end).trim();
    throw new CliIndexerFailure(`未找到 ${INDEX_START}/${INDEX_END} 标记`, "empty");
}

function readFileIfSmall(filePath: string, maxBytes: number): string {
    const stat = fs.statSync(filePath);
    if (stat.size > maxBytes) throw new Error(`索引文件过大 (${stat.size} bytes > ${maxBytes} bytes)`);
    return fs.readFileSync(filePath, "utf-8");
}

function readClip(filePath: string, maxChars: number): string {
    try {
        if (!fs.existsSync(filePath)) return "";
        const stat = fs.statSync(filePath);
        const byteBudget = Math.min(stat.size, Math.max(maxChars * 4, 4096));
        const fd = fs.openSync(filePath, "r");
        try {
            const buffer = Buffer.alloc(byteBudget);
            const bytesRead = fs.readSync(fd, buffer, 0, byteBudget, 0);
            return clip(buffer.subarray(0, bytesRead).toString("utf-8"), maxChars);
        } finally {
            fs.closeSync(fd);
        }
    } catch {
        return "";
    }
}

function classifyAntigravityFailure(text: string): FailureKind {
    if (/You are not logged into Antigravity|Opening authentication page|Do you want to continue|Path not in workspace|resolves outside the allowed workspace directories|not recognized as the name of a cmdlet|command not found|ENOENT/iu.test(text)) return "terminal";
    if (/MODEL_CAPACITY_EXHAUSTED|RESOURCE_EXHAUSTED|No capacity available|\b429\b|rate limit/iu.test(text)) return "capacity";
    if (/timed out|timeout|索引文件为空|未找到 <<<COUNCIL_INDEX>>>/iu.test(text)) return /timed out|timeout/iu.test(text) ? "timeout" : "empty";
    return "transient";
}

function validateArtifact(artifactPath: string): string {
    if (!fs.existsSync(artifactPath)) throw new CliIndexerFailure("CLI 索引文件为空或未写入", "empty");
    const raw = readFileIfSmall(artifactPath, MAX_ARTIFACT_BYTES);
    if (!raw.trim()) throw new CliIndexerFailure("CLI 索引文件为空", "empty");
    const text = extractMarkedSection(raw);
    if (text.length < 120) throw new CliIndexerFailure(`CLI 索引过短 (${text.length} chars)`, "empty");
    return text;
}

function buildIndexPrompt(input: { filePath: string; artifactPath: string; label?: string; range?: string; cli: CouncilIndexerCli }): string {
    const fileName = path.basename(input.filePath);
    const title = input.label || fileName;
    const rangeText = input.range ? `用户额外要求的范围提示：${input.range}` : "用户没有给定行号范围；你应自行选择最有价值的结构化读取方式。";
    const cliNote = input.cli === "antigravity"
        ? "你可以使用 Antigravity CLI 的文件读取、搜索、子任务和多模态能力；遇到 PDF、视频或图片时优先利用原生多模态理解，再写成纯文本索引。"
        : [
            "你可以使用 Codex CLI 的本地工具、shell 和子代理能力；复杂文件可先做结构化抽取或让子代理并行读文件，但最终索引必须落盘。",
            "严禁使用 COM、win32com 或任何 Office 自动化接口，严禁启动 PowerPoint、Word、Excel 或其它有头 GUI 应用。",
            "只可使用 python-pptx、python-docx、openpyxl 等无头解析库读取 Office 文件。",
            ...(process.env.SANDBOX_COUNCIL_CODEX_INDEX_ALLOW_WEB_FETCHER === "1" ? ["允许在可用时显式调用 web-fetcher MCP 读取文件。"] : []),
        ].join("\n");
    return [
        "你在为 sandbox_council 准备文件索引材料。",
        "目标：对一个文件做 agentic 读取，产出给多模型讨论直接使用的结构化纯文本索引。",
        cliNote,
        "源文件只读，禁止修改、移动或删除源文件。",
        "你必须把最终索引写入下方指定的临时文件；不要把完整索引打印到 stdout。",
        `临时输出文件：${input.artifactPath}`,
        "stdout/stderr 只允许简短状态、错误或诊断，不要输出完整正文。",
        "如果读取失败，也要尽量把失败原因和已尝试路径写入同一个临时输出文件。",
        "临时输出文件必须包含下面两个标记；宿主只会读取这两个标记之间的 Markdown：",
        INDEX_START,
        "... Markdown index ...",
        INDEX_END,
        "",
        "请优先提取：文件类型、结构、关键事实、关键数据、表格/章节摘要、可直接引用的短摘录、不确定性。",
        "如果文件是 PDF、Word、Excel、EPUB、视频、图片或其它复杂格式，请主动使用最合适的读取路径，而不是只说“无法读取”。",
        "如果文件内容很长，请建立高密度索引，而不是全文抄录。",
        "",
        "建议写入格式：",
        INDEX_START,
        `# 文件索引：${title}`,
        "",
        `- 路径：${input.filePath}`,
        `- 文件名：${fileName}`,
        `- 范围提示：${rangeText}`,
        "",
        "## 类型与读取方式",
        "- 说明文件类型、你实际采用的读取方法、是否存在局限",
        "",
        "## 结构索引",
        "- 用分层列表写出章节/工作表/页面/段落群/媒体片段等结构",
        "",
        "## 关键内容",
        "- 提炼对讨论最重要的事实、数据、术语、图表结论、表格结论",
        "",
        "## 可引用摘录",
        "- 放少量高价值短摘录；如果没有可引用文字就说明原因",
        "",
        "## 不确定性与盲点",
        "- 明确哪些内容可能没读到、OCR/版式/图像/视频理解的不确定点",
        INDEX_END,
        "",
        `现在开始处理文件：${fileName}`,
        `源文件绝对路径：${input.filePath}`,
    ].join("\n");
}

function buildAntigravityScript(promptPath: string, artifactPath: string, model: string, command: string, addDirs: string[]): string {
    const prompt = `Read and follow the full UTF-8 instructions in ${promptPath}. You must write the final sandbox_council index to ${artifactPath}. Do not print the full index to stdout.`;
    const addDirArgs = addDirs.map((dir) => `--add-dir ${psSingleQuoted(dir)}`).join(" ");
    return [
        `$prompt = ${psSingleQuoted(prompt)}`,
        `& ${psSingleQuoted(command)} -p $prompt --dangerously-skip-permissions --model ${psSingleQuoted(model)} ${addDirArgs}`,
        "exit $LASTEXITCODE",
    ].join("\n");
}

function buildCodexScript(promptPath: string, artifactPath: string, model: string, reasoning: string): string {
    const prompt = `Read and follow the full UTF-8 instructions in ${promptPath}. You must write the final sandbox_council index to ${artifactPath}. Do not print the full index to stdout.`;
    return [
        "$ErrorActionPreference = 'Continue'",
        `$prompt = ${psSingleQuoted(prompt)}`,
        `& codex exec --dangerously-bypass-approvals-and-sandbox --ephemeral --skip-git-repo-check -m ${psSingleQuoted(model)} -c ${psSingleQuoted(`model_reasoning_effort=${reasoning}`)} $prompt`,
        "exit $LASTEXITCODE",
    ].join("\n");
}

function resolveAntigravityCommand(request: BuildCouncilFileIndexRequest): string {
    return request.params?.command?.trim() || request.params?.cli?.trim() || request.command?.trim() || request.cli?.trim() || process.env.SANDBOX_COUNCIL_ANTIGRAVITY_CLI_COMMAND?.trim() || "agy";
}

function authorizedDirectories(filePath: string, promptPath: string, artifactPath: string, imagePaths: string[]): string[] {
    return [...new Set([path.dirname(filePath), path.dirname(promptPath), path.dirname(artifactPath), ...imagePaths.map((imagePath) => path.dirname(imagePath))].map((dir) => path.resolve(dir)))];
}

function isAbortError(error: unknown): boolean {
    return error instanceof Error && error.name === "AbortError";
}

async function runAntigravityIndexer(request: BuildCouncilFileIndexRequest): Promise<CouncilCliIndexResult> {
    const cwd = path.dirname(request.filePath);
    const notes: string[] = [];
    const exhaustedModels = new Set<string>();
    const command = resolveAntigravityCommand(request);
    const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const models = antigravityAttempts(request.filePath, notes, request.onProgress);
    const childEnvironment = buildAntigravityCliEnvironment();
    notes.push(...childEnvironment.diagnostics);
    for (const model of models) {
        if (exhaustedModels.has(model)) continue;
        for (let retry = 1; retry <= ATTEMPTS_PER_MODEL; retry += 1) {
            const artifactPath = buildArtifactPath(request.filePath, "antigravity", `${model}_try${retry}`, request.runId);
            const promptPath = `${artifactPath}.prompt.txt`;
            const logBase = `${artifactPath}.run`;
            try {
                fs.writeFileSync(promptPath, buildIndexPrompt({ ...request, artifactPath, cli: "antigravity" }), "utf-8");
                request.onProgress?.(`正在用 Antigravity CLI 索引文件 ${path.basename(request.filePath)}：model=${model}, attempt=${retry}`);
                const result = await withAntigravityCliLease(request.signal, async () => await spawnPowerShellScript(
                    buildAntigravityScript(promptPath, artifactPath, model, command, authorizedDirectories(request.filePath, promptPath, artifactPath, request.imagePaths || [])),
                    cwd,
                    logBase,
                    { timeoutMs, signal: request.signal, env: childEnvironment.env, diagnostics: childEnvironment.diagnostics, earlyFailure: (stderr) => classifyAntigravityFailure(stderr) === "terminal" ? redactSensitive(clip(stderr, 320)) : undefined },
                ));
                if (result.aborted) throw Object.assign(new Error("CLI 索引已中止"), { name: "AbortError" });
                if (result.timedOut) throw new CliIndexerFailure("Antigravity CLI 索引超时", "timeout");
                if (result.earlyFailureReason) throw new CliIndexerFailure(`Antigravity CLI terminal failure: ${result.earlyFailureReason}`, "terminal");
                const text = validateArtifact(artifactPath);
                const stderr = redactSensitive(readClip(result.stderrPath, 900).trim());
                return {
                    cli: "antigravity",
                    text,
                    artifactPath,
                    notes: [
                        ...notes,
                        `Antigravity CLI index ok: model=${model}, attempt=${retry}`,
                        `stdout=${path.basename(result.stdoutPath)}`,
                        `stderr=${path.basename(result.stderrPath)}`,
                        ...(stderr ? [stderr] : []),
                    ],
                };
            } catch (error) {
                if (isAbortError(error) || request.signal?.aborted) throw error;
                const stderr = redactSensitive(readClip(`${logBase}.stderr.txt`, 900).trim());
                const message = redactSensitive(error instanceof Error ? error.message : String(error));
                const detectedKind = classifyAntigravityFailure(`${message}\n${stderr}`);
                const kind = detectedKind === "terminal" || detectedKind === "capacity"
                    ? detectedKind
                    : error instanceof CliIndexerFailure ? error.kind : detectedKind;
                notes.push(`antigravity model=${model} attempt=${retry} failed (${kind}): ${message}${stderr ? ` | stderr: ${stderr}` : ""}`);
                request.onProgress?.(`Antigravity CLI 索引失败，准备降级/重试：model=${model}, reason=${clip(message, 180)}`);
                if (kind === "terminal") throw new Error(notes.join("\n"));
                if (kind === "capacity") {
                    exhaustedModels.add(model);
                    break;
                }
            } finally {
                registerExistingRunArtifacts(request.runId, [promptPath, artifactPath, `${logBase}.ps1`, `${logBase}.stdout.txt`, `${logBase}.stderr.txt`]);
            }
        }
    }
    throw new Error(notes.length > 0 ? notes.join("\n") : "Antigravity CLI 索引失败");
}

async function runCodexIndexer(request: BuildCouncilFileIndexRequest): Promise<CouncilCliIndexResult> {
    const cwd = path.dirname(request.filePath);
    const notes: string[] = [];
    const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    for (const attempt of codexAttempts()) {
        for (let retry = 1; retry <= ATTEMPTS_PER_MODEL; retry += 1) {
            const artifactPath = buildArtifactPath(request.filePath, "codex", `${attempt.model}_${attempt.reasoning}_try${retry}`, request.runId);
            const promptPath = `${artifactPath}.prompt.txt`;
            const logBase = `${artifactPath}.run`;
            try {
                fs.writeFileSync(promptPath, buildIndexPrompt({ ...request, artifactPath, cli: "codex" }), "utf-8");
                request.onProgress?.(`正在用 Codex CLI 索引文件 ${path.basename(request.filePath)}：model=${attempt.model}, reasoning=${attempt.reasoning}, attempt=${retry}`);
                const result = await spawnPowerShellScript(buildCodexScript(promptPath, artifactPath, attempt.model, attempt.reasoning), cwd, logBase, { timeoutMs, signal: request.signal });
                if (result.aborted) throw Object.assign(new Error("CLI 索引已中止"), { name: "AbortError" });
                if (result.timedOut) throw new CliIndexerFailure("Codex CLI 索引超时", "timeout");
                const text = validateArtifact(artifactPath);
                const stderr = redactSensitive(readClip(result.stderrPath, 900).trim());
                return {
                    cli: "codex",
                    text,
                    artifactPath,
                    notes: [
                        `Codex CLI index ok: model=${attempt.model}, reasoning=${attempt.reasoning}, attempt=${retry}`,
                        `stdout=${path.basename(result.stdoutPath)}`,
                        `stderr=${path.basename(result.stderrPath)}`,
                        ...(stderr ? [stderr] : []),
                    ],
                };
            } catch (error) {
                if (isAbortError(error) || request.signal?.aborted) throw error;
                const stderr = redactSensitive(readClip(`${logBase}.stderr.txt`, 900).trim());
                const message = redactSensitive(error instanceof Error ? error.message : String(error));
                notes.push(`codex model=${attempt.model} reasoning=${attempt.reasoning} attempt=${retry} failed: ${message}${stderr ? ` | stderr: ${stderr}` : ""}`);
                request.onProgress?.(`Codex CLI 索引失败，准备降级/重试：model=${attempt.model}, reasoning=${attempt.reasoning}, reason=${clip(message, 180)}`);
            } finally {
                registerExistingRunArtifacts(request.runId, [promptPath, artifactPath, `${logBase}.ps1`, `${logBase}.stdout.txt`, `${logBase}.stderr.txt`]);
            }
        }
    }
    throw new Error(notes.length > 0 ? notes.join("\n") : "Codex CLI 索引失败");
}

function isStructuredFile(filePath: string): boolean {
    return [".pdf", ".doc", ".docx", ".odt", ".rtf", ".xls", ".xlsx", ".ods", ".csv", ".epub", ".ppt", ".pptx"].includes(path.extname(filePath).toLowerCase());
}

function isPptxFile(filePath: string): boolean {
    return path.extname(filePath).toLowerCase() === ".pptx";
}

function allowsStructuredCodexFallback(filePath: string): boolean {
    return [".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ods", ".epub"].includes(path.extname(filePath).toLowerCase());
}

function structuredCodexFallbackEnabled(): boolean {
    return process.env.SANDBOX_COUNCIL_STRUCTURED_CODEX_FALLBACK === "1";
}

export async function buildCouncilFileIndex(request: BuildCouncilFileIndexRequest): Promise<CouncilCliIndexResult> {
    if (request.signal?.aborted) throw Object.assign(new Error("CLI 索引已中止"), { name: "AbortError" });
    const preferredCli = request.preferredCli === "gemini" ? "antigravity" : request.preferredCli;
    const plan: CouncilIndexerCli[] = isPptxFile(request.filePath)
        ? ["antigravity"]
        : isStructuredFile(request.filePath)
            ? allowsStructuredCodexFallback(request.filePath) && structuredCodexFallbackEnabled()
                ? ["antigravity", "codex"]
                : ["antigravity"]
        : preferredCli === "codex" ? ["codex", "antigravity"] : ["antigravity", "codex"];
    const failures: string[] = [];
    for (const cli of plan) {
        try {
            request.onProgress?.(`开始 ${cli === "antigravity" ? "Antigravity CLI" : "Codex CLI"} 文件索引：${path.basename(request.filePath)}`);
            const result = cli === "antigravity" ? await runAntigravityIndexer(request) : await runCodexIndexer(request);
            if (cli === "codex" && allowsStructuredCodexFallback(request.filePath)) {
                result.notes.unshift("结构化文件已启用 SANDBOX_COUNCIL_STRUCTURED_CODEX_FALLBACK=1，Codex CLI 作为最后兜底运行");
            }
            return result;
        } catch (error) {
            if (isAbortError(error) || request.signal?.aborted) throw error;
            failures.push(`${cli}: ${redactSensitive(error instanceof Error ? error.message : String(error))}`);
            request.onProgress?.(`${cli === "antigravity" ? "Antigravity CLI" : "Codex CLI"} 文件索引整体失败，切换下一条索引链路：${path.basename(request.filePath)}`);
        }
    }
    throw new Error(`文件索引失败\n- ${failures.join("\n- ")}`);
}
