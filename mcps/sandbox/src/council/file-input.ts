import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { buildCouncilFileIndex, councilIndexDir } from "./cli-indexer.js";
import { prepareLargeInputReference, sha256Text, shouldCreateLargeInputIndex } from "./large-input.js";
import { councilArtifactPath, registerCouncilArtifact } from "./artifact-store.js";
import type { CouncilFileInput, CouncilTranscript } from "./types.js";
import type { CouncilLargeInputArtifact, CouncilLargeInputConfig } from "./types.js";

const MAX_FILE_CHARS = Number(process.env.SANDBOX_COUNCIL_FILE_MAX_CHARS || 24000);
const MAX_TOTAL_CONTEXT_CHARS = Number(process.env.SANDBOX_COUNCIL_CONTEXT_MAX_CHARS || 90000);
const PYTHON_FALLBACK_TIMEOUT_MS = Number(process.env.SANDBOX_COUNCIL_PYTHON_FALLBACK_TIMEOUT_MS || 120000);
const execFileAsync = promisify(execFile);

export type CouncilFileKind = "text" | "csv" | "image" | "pdf" | "doc" | "sheet" | "epub" | "presentation" | "legacy_presentation" | "video" | "binary";
export type CouncilIngestMode = "direct_text" | "large_input_index" | "agentic_index" | "structured_extract" | "promoted_image" | "unreadable_stub";

export type CouncilPreparedFile = CouncilTranscript["files"][number] & {
    kind?: CouncilFileKind;
    ingestMode?: CouncilIngestMode;
    parser?: string;
    warnings?: string[];
    artifactPath?: string;
    metadata?: Record<string, unknown>;
};

interface PrepareCouncilFilesOptions {
    files?: CouncilFileInput[];
    largeInput?: CouncilLargeInputConfig;
    runId?: string;
    signal?: AbortSignal;
    onProgress?: (message: string) => void;
}

function throwIfAborted(signal?: AbortSignal): void {
    if (!signal?.aborted) return;
    const error = new Error(signal.reason instanceof Error ? signal.reason.message : "文件准备已中止");
    error.name = "AbortError";
    throw error;
}

const TEXT_EXTENSIONS = new Set([
    ".txt", ".md", ".markdown", ".json", ".jsonl", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf",
    ".xml", ".html", ".htm", ".csv", ".tsv", ".log", ".sql", ".py", ".js", ".jsx", ".ts", ".tsx",
    ".c", ".cc", ".cpp", ".h", ".hpp", ".java", ".go", ".rs", ".sh", ".ps1", ".bat", ".cmd",
]);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tiff", ".svg"]);
const PDF_EXTENSIONS = new Set([".pdf"]);
const DOC_EXTENSIONS = new Set([".docx", ".doc"]);
const SHEET_EXTENSIONS = new Set([".xlsx", ".xls", ".ods"]);
const EPUB_EXTENSIONS = new Set([".epub"]);
const PRESENTATION_EXTENSIONS = new Set([".pptx"]);
const LEGACY_PRESENTATION_EXTENSIONS = new Set([".ppt"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".mkv", ".avi", ".webm"]);

function clip(text: string, maxChars: number): string {
    if (text.length <= maxChars) return text;
    return `${text.slice(0, maxChars)}\n... (truncated ${text.length - maxChars} chars)`;
}

function clipWithinBudget(text: string, maxChars: number): string {
    if (text.length <= maxChars) return text;
    if (maxChars <= 1) return text.slice(0, maxChars);
    return `${text.slice(0, maxChars - 1)}…`;
}

function parseRange(range: string | undefined, lines: string[]): string {
    if (!range) return lines.join("\n");
    const match = range.match(/^#?(\d+)-(\d+)$/u);
    if (match) {
        const start = Math.max(0, Number(match[1]) - 1);
        const end = Math.min(lines.length, Number(match[2]));
        return lines.slice(start, end).join("\n");
    }
    const first = range.match(/^first(\d+)$/iu);
    if (first) return lines.slice(0, Number(first[1])).join("\n");
    const last = range.match(/^last(\d+)$/iu);
    if (last) return lines.slice(-Number(last[1])).join("\n");
    return lines.join("\n");
}

function classifyByExtension(filePath: string): CouncilFileKind {
    const ext = path.extname(filePath).toLowerCase();
    if (IMAGE_EXTENSIONS.has(ext)) return "image";
    if (PDF_EXTENSIONS.has(ext)) return "pdf";
    if (DOC_EXTENSIONS.has(ext)) return "doc";
    if (SHEET_EXTENSIONS.has(ext)) return "sheet";
    if (EPUB_EXTENSIONS.has(ext)) return "epub";
    if (PRESENTATION_EXTENSIONS.has(ext)) return "presentation";
    if (LEGACY_PRESENTATION_EXTENSIONS.has(ext)) return "legacy_presentation";
    if (VIDEO_EXTENSIONS.has(ext)) return "video";
    if (ext === ".csv" || ext === ".tsv") return "csv";
    if (TEXT_EXTENSIONS.has(ext)) return "text";
    return "binary";
}

function buildUnreadableStub(input: CouncilFileInput, resolved: string, kind: CouncilFileKind, reason: string): CouncilPreparedFile {
    return {
        path: resolved,
        label: input.label,
        range: input.range,
        ok: false,
        text: `文件未进入讨论上下文：${reason}`,
        kind,
        ingestMode: "unreadable_stub",
        parser: "stub",
        warnings: [reason],
    };
}

function buildCsvSummary(raw: string, maxChars: number): string {
    const lines = raw.split(/\r?\n/u).filter(Boolean);
    const header = lines[0] || "";
    const preview = lines.slice(0, 10).join("\n");
    return clip([
        `CSV/TSV 行数: ${lines.length}`,
        header ? `表头: ${header}` : "表头: (empty)",
        "",
        "前几行预览:",
        preview,
    ].join("\n"), maxChars);
}

function readDirectText(resolved: string, range?: string, budget = MAX_FILE_CHARS): string {
    const raw = fs.readFileSync(resolved, "utf-8");
    return clip(parseRange(range, raw.split(/\r?\n/u)), budget);
}

function looksLikePlaceholderIndex(text: string): boolean {
    const placeholders = [
        "说明文件类型、你实际采用的读取方法、是否存在局限",
        "用分层列表写出章节/工作表/页面/段落群/媒体片段等结构",
        "提炼对讨论最重要的事实、数据、术语、图表结论、表格结论",
        "放少量高价值短摘录；如果没有可引用文字就说明原因",
        "明确哪些内容可能没读到、OCR/版式/图像/视频理解的不确定点",
    ];
    const hitCount = placeholders.filter((item) => text.includes(item)).length;
    return hitCount >= 3;
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
        `# 文件索引：${input.title}`,
        "",
        `- 路径：${input.filePath}`,
        "",
        "## 类型与读取方式",
        `- 读取方法：${input.method}`,
        "",
        "## 结构索引",
        ...(input.structure.length > 0 ? input.structure : ["- 未能提取结构信息"]),
        "",
        "## 关键内容",
        ...(input.keyPoints.length > 0 ? input.keyPoints : ["- 未提取到关键内容"]),
        "",
        "## 可引用摘录",
        ...(input.excerpts.length > 0 ? input.excerpts.map((line) => `- ${line}`) : ["- 无可直接引用摘录"]),
        "",
        "## 不确定性与盲点",
        ...(input.warnings.length > 0 ? input.warnings.map((line) => `- ${line}`) : ["- 当前结构化提取未覆盖复杂版式、图片和视觉细节"]),
    ].join("\n");
}

function safeArtifactName(input: string): string {
    return input.replace(/[^\w.-]+/gu, "_").slice(0, 80) || "fallback";
}

function fallbackArtifactBase(resolved: string, runId?: string): string {
    const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
    const baseName = `${safeArtifactName(path.basename(resolved))}_python_${stamp}_${process.pid}`;
    return runId ? councilArtifactPath(runId, "indexes", baseName) : path.join(councilIndexDir(), baseName);
}

async function runPythonStructuredFallback(kind: CouncilFileKind, resolved: string, label?: string, range?: string, outputBudget = MAX_FILE_CHARS, signal?: AbortSignal, runId?: string): Promise<{ text: string; parser: string; warnings: string[]; artifactPath: string }> {
    throwIfAborted(signal);
    const artifactBase = fallbackArtifactBase(resolved, runId);
    const outputPath = `${artifactBase}.json`;
    const artifactPath = `${artifactBase}.md`;
    if (kind === "presentation") {
        try {
            await execFileAsync("python", ["-c", "import pptx"], {
                windowsHide: true,
                timeout: PYTHON_FALLBACK_TIMEOUT_MS,
                maxBuffer: 1024 * 1024,
                encoding: "utf-8",
                signal,
            });
        } catch (err) {
            throwIfAborted(signal);
            throw new Error("缺少 Python 依赖 python-pptx，无法解析 PPTX；不会自动运行 pip install，请先在当前 Python 环境安装该依赖");
        }
    }
    const script = `
import json, os, re
from pathlib import Path
kind = os.environ["SANDBOX_COUNCIL_KIND"]
file_path = Path(os.environ["SANDBOX_COUNCIL_FILE"])
title = os.environ.get("SANDBOX_COUNCIL_LABEL") or file_path.name
output_path = Path(os.environ["SANDBOX_COUNCIL_OUTPUT"])
range_value = os.environ.get("SANDBOX_COUNCIL_RANGE", "")
output_budget = max(1000, int(os.environ.get("SANDBOX_COUNCIL_OUTPUT_BUDGET", "24000")))
out = {"title": title, "method": "", "structure": [], "keyPoints": [], "excerpts": [], "warnings": []}

def clean_lines(lines, limit=8):
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
    for idx, page in enumerate(reader.pages[:8], start=1):
        text = (page.extract_text() or "").strip()
        if text:
            texts.append((idx, text))
    out["method"] = "python+pypdf"
    out["structure"] = [f"- PDF 共 {len(reader.pages)} 页"] + [f"- 第 {idx} 页" for idx, _ in texts]
    all_text = "\\n".join(text for _, text in texts)
    out["keyPoints"] = [f"- {line}" for line in clean_lines(all_text.splitlines(), 12)]
    out["excerpts"] = clean_lines(all_text.splitlines(), 6)
    out["warnings"] = ["复杂图像/OCR/版式细节仍可能遗漏"]
elif kind == "doc":
    from docx import Document
    doc = Document(str(file_path))
    paragraphs = [p.text for p in doc.paragraphs if p.text.strip()]
    out["method"] = "python-docx"
    out["structure"] = [f"- 段落数: {len(paragraphs)}"]
    out["keyPoints"] = [f"- {line}" for line in clean_lines(paragraphs, 12)]
    out["excerpts"] = clean_lines(paragraphs, 6)
    out["warnings"] = ["复杂排版、图片、批注和部分表格样式不会完整保留"]
elif kind == "sheet":
    from openpyxl import load_workbook
    wb = load_workbook(str(file_path), read_only=True, data_only=True)
    out["method"] = "openpyxl"
    for ws in wb.worksheets[:6]:
        out["structure"].append(f"- 工作表: {ws.title}")
        rows = []
        for row in ws.iter_rows(min_row=1, max_row=6, values_only=True):
            values = ["" if value is None else str(value) for value in row]
            if any(values):
                rows.append(" | ".join(values))
        for row in rows[:4]:
            out["keyPoints"].append(f"- [{ws.title}] {row}")
        if rows:
            out["excerpts"].append(f"[{ws.title}] " + rows[0])
    out["warnings"] = ["公式只读取 data_only 结果，复杂样式、图表和批注未覆盖"]
elif kind == "epub":
    from ebooklib import epub, ITEM_DOCUMENT
    from bs4 import BeautifulSoup
    book = epub.read_epub(str(file_path))
    docs = [item for item in book.get_items() if item.get_type() == ITEM_DOCUMENT]
    out["method"] = "ebooklib+BeautifulSoup"
    out["structure"] = [f"- 文档片段数: {len(docs)}"]
    texts = []
    for item in docs[:8]:
        soup = BeautifulSoup(item.get_body_content(), "html.parser")
        text = " ".join(soup.get_text("\\n").split())
        if text:
            out["structure"].append(f"- 片段: {item.get_name()}")
            texts.append(text)
    out["keyPoints"] = [f"- {line}" for line in clean_lines(texts, 12)]
    out["excerpts"] = clean_lines(texts, 6)
    out["warnings"] = ["图片、封面和复杂样式未做视觉级理解"]
elif kind == "presentation":
    from pptx import Presentation
    from pptx.enum.shapes import MSO_SHAPE_TYPE
    from pptx.enum.shapes import PP_PLACEHOLDER

    def clean_text(value):
        return re.sub(r"\\s+", " ", str(value or "")).strip()

    def limit_text(value, max_chars):
        text = clean_text(value)
        if len(text) <= max_chars:
            return text
        return text[:max(0, max_chars - 1)] + "…"

    def extract_shape_texts(shape, max_chars):
        if max_chars <= 0:
            return []
        texts = []

        def append_text(value):
            remaining = max_chars - sum(len(text) for text in texts)
            text = limit_text(value, remaining)
            if text:
                texts.append(text)

        if shape.shape_type == MSO_SHAPE_TYPE.GROUP:
            for child in shape.shapes:
                remaining = max_chars - sum(len(text) for text in texts)
                if remaining <= 0:
                    break
                texts.extend(extract_shape_texts(child, remaining))
            return texts
        if shape.has_table:
            for row in shape.table.rows:
                for cell in row.cells:
                    append_text(cell.text)
                    if sum(len(text) for text in texts) >= max_chars:
                        break
                if sum(len(text) for text in texts) >= max_chars:
                    break
            return texts
        if shape.has_text_frame:
            append_text(shape.text)
        return texts

    def title_placeholder(slide, max_chars):
        for shape in slide.shapes:
            if not shape.is_placeholder:
                continue
            try:
                placeholder_type = shape.placeholder_format.type
            except (AttributeError, ValueError):
                continue
            if placeholder_type in (PP_PLACEHOLDER.TITLE, PP_PLACEHOLDER.CENTER_TITLE):
                texts = extract_shape_texts(shape, max_chars)
                if texts:
                    return texts[0]
        return ""

    def slide_indexes(total, requested):
        if not requested:
            return list(range(total)), ""
        slides_match = re.fullmatch(r"slides:(\\d+)-(\\d+)", requested.strip(), re.IGNORECASE)
        first_match = re.fullmatch(r"first(\\d+)", requested.strip(), re.IGNORECASE)
        if slides_match:
            start = max(1, int(slides_match.group(1)))
            end = min(total, int(slides_match.group(2)))
            return list(range(start - 1, end)) if start <= end else [], ""
        if first_match:
            return list(range(min(total, int(first_match.group(1))))), ""
        return list(range(total)), f"未识别的 PPTX range: {requested}，已读取全部幻灯片"

    presentation = Presentation(str(file_path))
    total_slides = len(presentation.slides)
    indexes, range_warning = slide_indexes(total_slides, range_value)
    selected = []
    selected_count = len(indexes)
    planned_page_count = min(max(selected_count, 1), 12)
    content_budget = max(240, output_budget // 2)
    slide_entry_budget = min(900, max(160, content_budget // planned_page_count))
    title_max_chars = min(160, max(48, slide_entry_budget // 4))
    slide_text_max_chars = min(900, max(120, slide_entry_budget - title_max_chars))
    structure_line_max_chars = min(220, max(96, title_max_chars + 32))
    key_point_max_chars = min(600, max(120, slide_text_max_chars))
    excerpt_max_chars = min(280, max(80, slide_text_max_chars // 2))
    consumed = 0
    for index in indexes:
        if selected and consumed + slide_entry_budget + 48 > content_budget:
            break
        slide = presentation.slides[index]
        texts = []
        for shape in slide.shapes:
            remaining = slide_text_max_chars - sum(len(text) for text in texts)
            if remaining <= 0:
                break
            texts.extend(extract_shape_texts(shape, remaining))
        title_text = limit_text(title_placeholder(slide, title_max_chars) or (texts[0] if texts else ""), title_max_chars)
        slide_text = limit_text(" | ".join(texts), slide_text_max_chars)
        selected.append((index + 1, title_text, slide_text))
        consumed += len(title_text) + len(slide_text) + 48

    out["method"] = "python-pptx"
    out["structure"] = [f"- PPTX 共 {total_slides} 页"]
    out["structure"].extend([limit_text(f"- 第 {number} 页：{title_text or '(未提取到标题)'}", structure_line_max_chars) for number, title_text, _ in selected])
    out["keyPoints"] = [limit_text(f"- [第 {number} 页] {slide_text}", key_point_max_chars) for number, _, slide_text in selected if slide_text][:12]
    out["excerpts"] = [limit_text(f"第 {number} 页：{slide_text}", excerpt_max_chars) for number, _, slide_text in selected if slide_text][:6]
    if len(selected) < selected_count:
        out["warnings"].append(f"PPTX 输出预算已限制提取：选中 {selected_count} 页，提取 {len(selected)} 页（预算 {output_budget} 字符）")
    if range_warning:
        out["warnings"].append(range_warning)
    out["warnings"].extend([
        "图片与 OCR 未覆盖",
        "动画未覆盖",
        "备注未覆盖",
        "图表未覆盖",
        "版式未覆盖",
    ])
    while len(json.dumps(out, ensure_ascii=False)) > output_budget:
        if out["excerpts"]:
            out["excerpts"].pop()
        elif out["keyPoints"]:
            out["keyPoints"].pop()
        elif len(out["structure"]) > 1:
            out["structure"].pop()
        else:
            break
else:
    raise RuntimeError(f"unsupported kind: {kind}")

output_path.write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
`;
    await execFileAsync("python", ["-c", script], {
        windowsHide: true,
        timeout: PYTHON_FALLBACK_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        encoding: "utf-8",
        env: {
            ...process.env,
            SANDBOX_COUNCIL_KIND: kind,
            SANDBOX_COUNCIL_FILE: resolved,
            SANDBOX_COUNCIL_LABEL: label || "",
            SANDBOX_COUNCIL_RANGE: range || "",
            SANDBOX_COUNCIL_OUTPUT_BUDGET: String(outputBudget),
            SANDBOX_COUNCIL_OUTPUT: outputPath,
        },
        signal,
    });
    throwIfAborted(signal);
    if (runId && fs.existsSync(outputPath)) registerCouncilArtifact(runId, outputPath);
    const payload = JSON.parse(fs.readFileSync(outputPath, "utf-8")) as {
        title: string;
        method: string;
        structure: string[];
        keyPoints: string[];
        excerpts: string[];
        warnings: string[];
    };
    const text = clipWithinBudget(formatStructuredFallbackMarkdown({
            title: payload.title,
            filePath: resolved,
            method: payload.method,
            structure: payload.structure,
            keyPoints: payload.keyPoints,
            excerpts: payload.excerpts,
            warnings: payload.warnings,
    }), outputBudget);
    fs.writeFileSync(artifactPath, text, "utf-8");
    if (runId) registerCouncilArtifact(runId, artifactPath);
    return {
        text,
        parser: payload.method,
        warnings: payload.warnings,
        artifactPath,
    };
}

export async function prepareCouncilFiles(options: PrepareCouncilFilesOptions): Promise<{ files: CouncilPreparedFile[]; promotedImages: string[]; largeInputs: CouncilLargeInputArtifact[] }> {
    const prepared: CouncilPreparedFile[] = [];
    const promotedImages: string[] = [];
    const largeInputs: CouncilLargeInputArtifact[] = [];
    let total = 0;

    for (const input of options.files || []) {
        throwIfAborted(options.signal);
        const resolved = path.resolve(input.path);
        const kind = classifyByExtension(resolved);
        options.onProgress?.(`准备读取背景文件：${path.basename(resolved)} (${kind})`);
        if (!fs.existsSync(resolved)) {
            prepared.push(buildUnreadableStub(input, resolved, kind, "文件不存在"));
            continue;
        }

        if (kind === "legacy_presentation") {
            prepared.push(buildUnreadableStub(input, resolved, kind, "旧二进制格式暂不支持，请先转换为 .pptx"));
            continue;
        }

        if (kind === "image") {
            promotedImages.push(resolved);
            prepared.push({
                path: resolved,
                label: input.label,
                range: input.range,
                ok: true,
                text: "该文件已自动提升为图片输入，供多模态链路直接处理。",
                kind,
                ingestMode: "promoted_image",
                parser: "image-promotion",
            });
            continue;
        }

        const budget = Math.max(1000, Math.min(MAX_FILE_CHARS, MAX_TOTAL_CONTEXT_CHARS - total));
        try {
            if (kind === "text") {
                const raw = fs.readFileSync(resolved, "utf-8");
                const selected = parseRange(input.range, raw.split(/\r?\n/u));
                if (shouldCreateLargeInputIndex(selected, options.largeInput)) {
                    const indexed = await prepareLargeInputReference({
                        text: selected,
                        sourceId: `file_${safeArtifactName(path.basename(resolved))}_${sha256Text(resolved).slice(0, 8)}`,
                        sourceKind: "file",
                        sourcePath: resolved,
                        label: input.label || path.basename(resolved),
                        config: options.largeInput,
                        runId: options.runId,
                    });
                    const text = clip(indexed.contextText, budget);
                    total += text.length;
                    largeInputs.push(indexed.artifact);
                    prepared.push({
                        path: resolved,
                        label: input.label,
                        range: input.range,
                        ok: true,
                        text,
                        kind,
                        ingestMode: "large_input_index",
                        parser: "large-input-index",
                        artifactPath: indexed.artifact.indexPath,
                        warnings: indexed.artifact.warnings,
                        metadata: {
                            sourceCharCount: indexed.artifact.sourceCharCount,
                            chunkCount: indexed.artifact.chunkCount,
                            overlap: indexed.artifact.overlap,
                            checkpointPath: indexed.artifact.checkpointPath,
                            sourceTextPath: indexed.artifact.sourceTextPath,
                        },
                    });
                    continue;
                }
                const text = clip(selected, budget);
                total += text.length;
                prepared.push({
                    path: resolved,
                    label: input.label,
                    range: input.range,
                    ok: true,
                    text,
                    kind,
                    ingestMode: "direct_text",
                    parser: "utf8",
                });
                continue;
            }

            if (kind === "csv") {
                const raw = fs.readFileSync(resolved, "utf-8");
                const selected = parseRange(input.range, raw.split(/\r?\n/u));
                if (shouldCreateLargeInputIndex(selected, options.largeInput)) {
                    const indexed = await prepareLargeInputReference({
                        text: selected,
                        sourceId: `file_${safeArtifactName(path.basename(resolved))}_${sha256Text(resolved).slice(0, 8)}`,
                        sourceKind: "file",
                        sourcePath: resolved,
                        label: input.label || path.basename(resolved),
                        config: options.largeInput,
                        runId: options.runId,
                    });
                    const text = clip(indexed.contextText, budget);
                    total += text.length;
                    largeInputs.push(indexed.artifact);
                    prepared.push({
                        path: resolved,
                        label: input.label,
                        range: input.range,
                        ok: true,
                        text,
                        kind,
                        ingestMode: "large_input_index",
                        parser: "large-input-index",
                        artifactPath: indexed.artifact.indexPath,
                        warnings: indexed.artifact.warnings,
                        metadata: {
                            sourceCharCount: indexed.artifact.sourceCharCount,
                            chunkCount: indexed.artifact.chunkCount,
                            overlap: indexed.artifact.overlap,
                            checkpointPath: indexed.artifact.checkpointPath,
                            sourceTextPath: indexed.artifact.sourceTextPath,
                        },
                    });
                    continue;
                }
                const text = buildCsvSummary(selected, budget);
                total += text.length;
                prepared.push({
                    path: resolved,
                    label: input.label,
                    range: input.range,
                    ok: true,
                    text,
                    kind,
                    ingestMode: "direct_text",
                    parser: "csv-summary",
                });
                continue;
            }

            try {
                options.onProgress?.(`复杂文件进入 agentic 索引：${path.basename(resolved)} (${kind})`);
                const indexed = await buildCouncilFileIndex({
                    filePath: resolved,
                    label: input.label,
                    range: input.range,
                    signal: options.signal,
                    runId: options.runId,
                    onProgress: options.onProgress,
                });
                throwIfAborted(options.signal);
                if ((kind === "doc" || kind === "sheet" || kind === "epub" || kind === "pdf" || kind === "presentation") && looksLikePlaceholderIndex(indexed.text)) {
                    throw new Error("CLI 返回了低质量模板化索引");
                }
                const text = clip(indexed.text, budget);
                total += text.length;
                prepared.push({
                    path: resolved,
                    label: input.label,
                    range: input.range,
                    ok: true,
                    text,
                    kind,
                    ingestMode: "agentic_index",
                    parser: `${indexed.cli}-cli`,
                    artifactPath: indexed.artifactPath,
                    warnings: indexed.notes.length > 0 ? indexed.notes : undefined,
                });
            } catch (primaryErr) {
                throwIfAborted(options.signal);
                if (kind === "doc" || kind === "sheet" || kind === "epub" || kind === "pdf" || kind === "presentation") {
                    const fallback = await runPythonStructuredFallback(kind, resolved, input.label, input.range, budget, options.signal, options.runId);
                    const text = clip(fallback.text, budget);
                    total += text.length;
                    prepared.push({
                        path: resolved,
                        label: input.label,
                        range: input.range,
                        ok: true,
                        text,
                        kind,
                        ingestMode: "structured_extract",
                        parser: fallback.parser,
                        artifactPath: fallback.artifactPath,
                        warnings: [
                            `CLI 索引已降级: ${primaryErr instanceof Error ? primaryErr.message : String(primaryErr)}`,
                            ...fallback.warnings,
                        ],
                    });
                    continue;
                }
                throw primaryErr;
            }
        } catch (err) {
            throwIfAborted(options.signal);
            prepared.push(buildUnreadableStub(input, resolved, kind, err instanceof Error ? err.message : String(err)));
        }
    }

    return { files: prepared, promotedImages, largeInputs };
}
