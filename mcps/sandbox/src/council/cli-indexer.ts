import fs from "fs";
import os from "os";
import path from "path";
import { spawn, spawnSync } from "child_process";
import { TEMP_DIR, ensureTempDir } from "../temp-store.js";

const INDEX_START = "<<<COUNCIL_INDEX>>>";
const INDEX_END = "<<<END_COUNCIL_INDEX>>>";
const DEFAULT_TIMEOUT_MS = Number(process.env.SANDBOX_COUNCIL_CLI_INDEX_TIMEOUT_MS || 240_000);
const MAX_ARTIFACT_BYTES = Number(process.env.SANDBOX_COUNCIL_CLI_INDEX_MAX_BYTES || 768 * 1024);
const ATTEMPTS_PER_MODEL = Math.max(1, Number(process.env.SANDBOX_COUNCIL_CLI_INDEX_RETRIES || 1) + 1);

export type CouncilIndexerCli = "gemini" | "codex";

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
    preferredCli?: CouncilIndexerCli;
    onProgress?: (message: string) => void;
}

interface SpawnResult {
    exitCode: number | null;
    timedOut: boolean;
    stdoutPath: string;
    stderrPath: string;
    earlyFailureReason?: string;
}

interface GeminiAttempt {
    model: string;
    approvalMode: string;
}

interface CodexAttempt {
    model: string;
    reasoning: string;
}

function clip(text: string, maxChars: number): string {
    return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n... (truncated ${text.length - maxChars} chars)`;
}

function safeName(input: string): string {
    return input.replace(/[^\w.-]+/gu, "_").slice(0, 80) || "index";
}

function safeGeminiTempProjectName(cwd: string): string {
    const basename = path.basename(path.resolve(cwd)) || "mcp-sandbox";
    const ascii = basename
        .normalize("NFKD")
        .replace(/[^\w.-]+/gu, "")
        .toLowerCase()
        .slice(0, 48);
    return ascii || "mcp-sandbox";
}

function nowStamp(): string {
    const now = new Date();
    const random = Math.random().toString(36).slice(2, 8);
    return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}${String(now.getMilliseconds()).padStart(3, "0")}-${process.pid}-${random}`;
}

export function councilIndexDir(): string {
    ensureTempDir();
    const dir = path.join(TEMP_DIR, "council-indexes");
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function buildArtifactPath(filePath: string, cli: CouncilIndexerCli, suffix: string): string {
    const dir = cli === "gemini"
        ? geminiCliAccessibleTempDir(path.dirname(filePath), "council-indexes")
        : councilIndexDir();
    return path.join(dir, `${safeName(path.basename(filePath))}_${cli}_${safeName(suffix)}_${nowStamp()}.md`);
}

function geminiCliAccessibleTempDir(cwd: string, childDir: string): string {
    const configured = process.env.SANDBOX_COUNCIL_GEMINI_CLI_TEMP_DIR;
    const base = configured && configured.trim()
        ? configured.trim()
        : path.join(os.homedir(), ".gemini", "tmp", safeGeminiTempProjectName(cwd));
    const dir = path.join(base, childDir);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function killProcessTree(pid?: number): void {
    if (!pid) return;
    try {
        const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
            windowsHide: true,
            stdio: "ignore",
        });
        killer.unref();
    } catch {
        // Best-effort cleanup; child.kill() is still called by the timeout path.
    }
}

function psSingleQuoted(text: string): string {
    return `'${text.replace(/'/gu, "''")}'`;
}

function getPowerShellCommand(): string {
    const systemRoot = process.env.SystemRoot || process.env.WINDIR;
    if (systemRoot) {
        const candidate = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
        if (fs.existsSync(candidate)) return candidate;
    }
    return "powershell.exe";
}

function killProcessesByCommandNeedle(needle: string): void {
    if (!needle || needle.length < 12) return;
    const escaped = needle.replace(/'/gu, "''");
    const script = [
        `$needle = '${escaped}'`,
        "$self = $PID",
        "Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $self -and $_.CommandLine -like \"*$needle*\" } | ForEach-Object {",
        "  try { taskkill.exe /PID $_.ProcessId /T /F | Out-Null } catch {}",
        "}",
    ].join("\n");
    try {
        spawnSync(getPowerShellCommand(), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
            windowsHide: true,
            stdio: "ignore",
            timeout: 5000,
        });
    } catch {
        // Best-effort cleanup only.
    }
}

function splitCsvEnv(name: string, fallback: string[]): string[] {
    const value = process.env[name];
    if (!value) return fallback;
    const items = value.split(",").map((item) => item.trim()).filter(Boolean);
    return items.length > 0 ? items : fallback;
}

function geminiAttempts(filePath: string): GeminiAttempt[] {
    const ext = path.extname(filePath).toLowerCase();
    const defaultModels = ext === ".pdf" || [".mp4", ".mov", ".mkv", ".avi", ".webm"].includes(ext)
        ? ["gemini-3.1-pro-preview", "auto-gemini-3", "gemini-2.5-pro", "gemini-3.1-flash-lite-preview", "gemini-2.5-flash-lite"]
        : ["auto-gemini-3", "gemini-3.1-pro-preview", "gemini-2.5-pro", "gemini-3.1-flash-lite-preview", "gemini-2.5-flash-lite"];
    const models = splitCsvEnv("SANDBOX_COUNCIL_GEMINI_INDEX_MODELS", defaultModels);
    const approvalModes = splitCsvEnv("SANDBOX_COUNCIL_GEMINI_INDEX_APPROVAL_MODES", ["yolo", "auto_edit"]);
    return models.flatMap((model) => approvalModes.map((approvalMode) => ({ model, approvalMode })));
}

function codexAttempts(): CodexAttempt[] {
    const rawItems = splitCsvEnv("SANDBOX_COUNCIL_CODEX_INDEX_MODELS", [
        "gpt-5.4:medium",
        "gpt-5.4:low",
        "gpt-5.4-mini:medium",
        "gpt-5.4-mini:low",
    ]);
    return rawItems.map((item) => {
        const [model, reasoning] = item.split(":");
        return {
            model: model || "gpt-5.4",
            reasoning: reasoning || process.env.SANDBOX_COUNCIL_CODEX_INDEX_REASONING || "medium",
        };
    });
}

function extractMarkedSection(text: string, artifactPath: string): string {
    const end = text.lastIndexOf(INDEX_END);
    const start = end >= 0 ? text.lastIndexOf(INDEX_START, end) : -1;
    if (start >= 0 && end > start) {
        return text.slice(start + INDEX_START.length, end).trim();
    }
    throw new Error(`${artifactPath} 未找到 ${INDEX_START}/${INDEX_END} 标记`);
}

function readFileIfSmall(filePath: string, maxBytes: number): string {
    const stat = fs.statSync(filePath);
    if (stat.size > maxBytes) {
        throw new Error(`${filePath} 过大 (${stat.size} bytes > ${maxBytes} bytes)，拒绝读入内存`);
    }
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

function getEarlyCliFailureReason(text: string): string | undefined {
    if (/MODEL_CAPACITY_EXHAUSTED|RESOURCE_EXHAUSTED|No capacity available/iu.test(text)) {
        return "Gemini CLI model capacity exhausted";
    }
    if (/Path not in workspace|resolves outside the allowed workspace directories/iu.test(text)) {
        return "Gemini CLI workspace path rejected";
    }
    if (/AttachConsole failed/iu.test(text)) {
        return "Gemini CLI terminal attachment failed";
    }
    return undefined;
}

function isGeminiCapacityError(text: string): boolean {
    return /MODEL_CAPACITY_EXHAUSTED|RESOURCE_EXHAUSTED|No capacity available/iu.test(text);
}

function validateArtifact(artifactPath: string): string {
    if (!fs.existsSync(artifactPath)) {
        throw new Error(`CLI 未写入索引文件: ${artifactPath}`);
    }
    const raw = readFileIfSmall(artifactPath, MAX_ARTIFACT_BYTES);
    const text = extractMarkedSection(raw, artifactPath);
    if (text.length < 120) {
        throw new Error(`CLI 索引过短 (${text.length} chars): ${artifactPath}`);
    }
    return text;
}

function buildIndexPrompt(input: {
    filePath: string;
    artifactPath: string;
    label?: string;
    range?: string;
    cli: CouncilIndexerCli;
}): string {
    const fileName = path.basename(input.filePath);
    const title = input.label || fileName;
    const rangeText = input.range ? `用户额外要求的范围提示：${input.range}` : "用户没有给定行号范围；你应自行选择最有价值的结构化读取方式。";
    const cliNote = input.cli === "gemini"
        ? "你可以使用 Gemini CLI 的文件读取、搜索、子任务和多模态能力；遇到 PDF/视频/图片时优先利用原生多模态理解，再写成纯文本索引。"
        : "你可以使用 Codex CLI 的本地工具、MCP、shell 和子代理能力；复杂文件可先做结构化抽取或让子代理并行读文件，但最终索引必须落盘。";
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

async function spawnPowerShellScript(
    script: string,
    cwd: string,
    logBasePath: string,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    earlyFailure?: (stderr: string) => string | undefined,
): Promise<SpawnResult> {
    const scriptPath = `${logBasePath}.ps1`;
    const stdoutPath = `${logBasePath}.stdout.txt`;
    const stderrPath = `${logBasePath}.stderr.txt`;
    const artifactNeedle = path.basename(logBasePath).replace(/\.run$/u, "");
    fs.writeFileSync(scriptPath, script, "utf-8");
    fs.writeFileSync(stdoutPath, "", "utf-8");
    fs.writeFileSync(stderrPath, "", "utf-8");
    return await new Promise<SpawnResult>((resolve, reject) => {
        const stdoutFd = fs.openSync(stdoutPath, "a");
        const stderrFd = fs.openSync(stderrPath, "a");
        let settled = false;
        let timedOut = false;
        let earlyFailureReason: string | undefined;
        const child = spawn(getPowerShellCommand(), [
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            scriptPath,
        ], {
            cwd,
            windowsHide: true,
            stdio: ["ignore", stdoutFd, stderrFd],
        });
        const timer = setTimeout(() => {
            timedOut = true;
            killProcessTree(child.pid);
            child.kill();
        }, timeoutMs);
        const earlyFailureTimer = earlyFailure ? setInterval(() => {
            const stderr = readClip(stderrPath, 4096);
            const reason = earlyFailure(stderr);
            if (!reason) return;
            earlyFailureReason = reason;
            killProcessTree(child.pid);
            killProcessesByCommandNeedle(artifactNeedle);
            child.kill();
        }, 1500) : null;
        earlyFailureTimer?.unref?.();
        const clearTimers = () => {
            clearTimeout(timer);
            if (earlyFailureTimer) clearInterval(earlyFailureTimer);
        };
        child.on("error", (err) => {
            if (settled) return;
            settled = true;
            clearTimers();
            fs.closeSync(stdoutFd);
            fs.closeSync(stderrFd);
            reject(err);
        });
        child.on("close", (exitCode) => {
            if (settled) return;
            settled = true;
            clearTimers();
            fs.closeSync(stdoutFd);
            fs.closeSync(stderrFd);
            if (timedOut || earlyFailureReason) {
                killProcessesByCommandNeedle(artifactNeedle);
            }
            resolve({ exitCode, timedOut, stdoutPath, stderrPath, earlyFailureReason });
        });
    });
}

function buildGeminiScript(promptPath: string, artifactPath: string, model: string, approvalMode: string): string {
    const prompt = `Read and follow the full UTF-8 instructions in ${promptPath}. Write the final sandbox_council index to ${artifactPath}. Do not print the full index to stdout.`;
    return [
        "$ErrorActionPreference = 'Continue'",
        `$prompt = ${psSingleQuoted(prompt)}`,
        `& gemini --skip-trust --approval-mode ${psSingleQuoted(approvalMode)} -m ${psSingleQuoted(model)} -p $prompt --output-format text`,
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

async function runGeminiIndexer(filePath: string, label?: string, range?: string, onProgress?: (message: string) => void): Promise<CouncilCliIndexResult> {
    const cwd = path.dirname(filePath);
    const notes: string[] = [];
    const exhaustedModels = new Set<string>();
    for (const attempt of geminiAttempts(filePath)) {
        if (exhaustedModels.has(attempt.model)) continue;
        for (let retry = 1; retry <= ATTEMPTS_PER_MODEL; retry += 1) {
            const suffix = `${attempt.model}_${attempt.approvalMode}_try${retry}`;
            const artifactPath = buildArtifactPath(filePath, "gemini", suffix);
            const promptPath = `${artifactPath}.prompt.txt`;
            const prompt = buildIndexPrompt({ filePath, artifactPath, label, range, cli: "gemini" });
            fs.writeFileSync(promptPath, prompt, "utf-8");
            const logBase = `${artifactPath}.run`;
            try {
                onProgress?.(`正在用 Gemini CLI 索引文件 ${path.basename(filePath)}：model=${attempt.model}, approval=${attempt.approvalMode}, attempt=${retry}`);
                const result = await spawnPowerShellScript(
                    buildGeminiScript(promptPath, artifactPath, attempt.model, attempt.approvalMode),
                    cwd,
                    logBase,
                    DEFAULT_TIMEOUT_MS,
                    getEarlyCliFailureReason,
                );
                if (result.earlyFailureReason) {
                    throw new Error(`${result.earlyFailureReason}; stderr=${result.stderrPath}`);
                }
                const text = validateArtifact(artifactPath);
                const stderr = readClip(result.stderrPath, 900).trim();
                return {
                    cli: "gemini",
                    text,
                    artifactPath,
                    notes: [
                        `Gemini CLI index ok: model=${attempt.model}, approvalMode=${attempt.approvalMode}, attempt=${retry}`,
                        `stdout=${result.stdoutPath}`,
                        `stderr=${result.stderrPath}`,
                        ...(stderr ? [stderr] : []),
                    ],
                };
            } catch (err) {
                const stderr = readClip(`${logBase}.stderr.txt`, 900).trim();
                const message = err instanceof Error ? err.message : String(err);
                notes.push(`gemini model=${attempt.model} approval=${attempt.approvalMode} attempt=${retry} failed: ${message}${stderr ? ` | stderr: ${stderr}` : ""}`);
                onProgress?.(`Gemini CLI 索引失败，准备降级/重试：model=${attempt.model}, approval=${attempt.approvalMode}, reason=${clip(message, 180)}`);
                if (isGeminiCapacityError(`${message}\n${stderr}`)) {
                    exhaustedModels.add(attempt.model);
                    break;
                }
            }
        }
    }
    throw new Error(notes.length > 0 ? notes.join("\n") : "Gemini CLI 索引失败");
}

async function runCodexIndexer(filePath: string, label?: string, range?: string, onProgress?: (message: string) => void): Promise<CouncilCliIndexResult> {
    const cwd = path.dirname(filePath);
    const notes: string[] = [];
    for (const attempt of codexAttempts()) {
        for (let retry = 1; retry <= ATTEMPTS_PER_MODEL; retry += 1) {
            const suffix = `${attempt.model}_${attempt.reasoning}_try${retry}`;
            const artifactPath = buildArtifactPath(filePath, "codex", suffix);
            const promptPath = `${artifactPath}.prompt.txt`;
            const prompt = buildIndexPrompt({ filePath, artifactPath, label, range, cli: "codex" });
            fs.writeFileSync(promptPath, prompt, "utf-8");
            const logBase = `${artifactPath}.run`;
            try {
                onProgress?.(`正在用 Codex CLI 索引文件 ${path.basename(filePath)}：model=${attempt.model}, reasoning=${attempt.reasoning}, attempt=${retry}`);
                const result = await spawnPowerShellScript(
                    buildCodexScript(promptPath, artifactPath, attempt.model, attempt.reasoning),
                    cwd,
                    logBase,
                );
                const text = validateArtifact(artifactPath);
                const stderr = readClip(result.stderrPath, 900).trim();
                return {
                    cli: "codex",
                    text,
                    artifactPath,
                    notes: [
                        `Codex CLI index ok: model=${attempt.model}, reasoning=${attempt.reasoning}, attempt=${retry}`,
                        `stdout=${result.stdoutPath}`,
                        `stderr=${result.stderrPath}`,
                        ...(stderr ? [stderr] : []),
                    ],
                };
            } catch (err) {
                const stderr = readClip(`${logBase}.stderr.txt`, 900).trim();
                const message = err instanceof Error ? err.message : String(err);
                notes.push(`codex model=${attempt.model} reasoning=${attempt.reasoning} attempt=${retry} failed: ${message}${stderr ? ` | stderr: ${stderr}` : ""}`);
                onProgress?.(`Codex CLI 索引失败，准备降级/重试：model=${attempt.model}, reasoning=${attempt.reasoning}, reason=${clip(message, 180)}`);
            }
        }
    }
    throw new Error(notes.length > 0 ? notes.join("\n") : "Codex CLI 索引失败");
}

export async function buildCouncilFileIndex(request: BuildCouncilFileIndexRequest): Promise<CouncilCliIndexResult> {
    const plan: CouncilIndexerCli[] = request.preferredCli === "codex"
        ? ["codex", "gemini"]
        : ["gemini", "codex"];
    const failures: string[] = [];
    for (const cli of plan) {
        try {
            request.onProgress?.(`开始 ${cli === "gemini" ? "Gemini CLI" : "Codex CLI"} 文件索引：${path.basename(request.filePath)}`);
            return cli === "gemini"
                ? await runGeminiIndexer(request.filePath, request.label, request.range, request.onProgress)
                : await runCodexIndexer(request.filePath, request.label, request.range, request.onProgress);
        } catch (err) {
            failures.push(`${cli}: ${err instanceof Error ? err.message : String(err)}`);
            request.onProgress?.(`${cli === "gemini" ? "Gemini CLI" : "Codex CLI"} 文件索引整体失败，切换下一条索引链路：${path.basename(request.filePath)}`);
        }
    }
    throw new Error(`文件索引失败\n- ${failures.join("\n- ")}`);
}
