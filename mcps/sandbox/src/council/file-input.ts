import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { buildCouncilFileIndex, councilIndexDir } from "./cli-indexer.js";
import { prepareLargeInputReference, sha256Text, shouldCreateLargeInputIndex } from "./large-input.js";
import type { CouncilFileInput, CouncilTranscript } from "./types.js";
import type { CouncilLargeInputArtifact, CouncilLargeInputConfig } from "./types.js";

const MAX_FILE_CHARS = Number(process.env.SANDBOX_COUNCIL_FILE_MAX_CHARS || 24000);
const MAX_TOTAL_CONTEXT_CHARS = Number(process.env.SANDBOX_COUNCIL_CONTEXT_MAX_CHARS || 90000);
const PYTHON_FALLBACK_TIMEOUT_MS = Number(process.env.SANDBOX_COUNCIL_PYTHON_FALLBACK_TIMEOUT_MS || 120000);
const execFileAsync = promisify(execFile);

export type CouncilFileKind = "text" | "csv" | "image" | "pdf" | "doc" | "sheet" | "epub" | "video" | "binary";
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
    onProgress?: (message: string) => void;
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
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".mkv", ".avi", ".webm"]);

function clip(text: string, maxChars: number): string {
    if (text.length <= maxChars) return text;
    return `${text.slice(0, maxChars)}\n... (truncated ${text.length - maxChars} chars)`;
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

function fallbackArtifactBase(resolved: string): string {
    const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
    return path.join(councilIndexDir(), `${safeArtifactName(path.basename(resolved))}_python_${stamp}_${process.pid}`);
}

async function runPythonStructuredFallback(kind: CouncilFileKind, resolved: string, label?: string): Promise<{ text: string; parser: string; warnings: string[]; artifactPath: string }> {
    const artifactBase = fallbackArtifactBase(resolved);
    const outputPath = `${artifactBase}.json`;
    const artifactPath = `${artifactBase}.md`;
    const script = `
import json, os, re
from pathlib import Path
kind = os.environ["SANDBOX_COUNCIL_KIND"]
file_path = Path(os.environ["SANDBOX_COUNCIL_FILE"])
title = os.environ.get("SANDBOX_COUNCIL_LABEL") or file_path.name
output_path = Path(os.environ["SANDBOX_COUNCIL_OUTPUT"])
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
            SANDBOX_COUNCIL_OUTPUT: outputPath,
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
            filePath: resolved,
            method: payload.method,
            structure: payload.structure,
            keyPoints: payload.keyPoints,
            excerpts: payload.excerpts,
            warnings: payload.warnings,
    });
    fs.writeFileSync(artifactPath, text, "utf-8");
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
        const resolved = path.resolve(input.path);
        const kind = classifyByExtension(resolved);
        options.onProgress?.(`准备读取背景文件：${path.basename(resolved)} (${kind})`);
        if (!fs.existsSync(resolved)) {
            prepared.push(buildUnreadableStub(input, resolved, kind, "文件不存在"));
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
                    onProgress: options.onProgress,
                });
                if ((kind === "doc" || kind === "sheet" || kind === "epub" || kind === "pdf") && looksLikePlaceholderIndex(indexed.text)) {
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
                if (kind === "doc" || kind === "sheet" || kind === "epub" || kind === "pdf") {
                    const fallback = await runPythonStructuredFallback(kind, resolved, input.label);
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
            prepared.push(buildUnreadableStub(input, resolved, kind, err instanceof Error ? err.message : String(err)));
        }
    }

    return { files: prepared, promotedImages, largeInputs };
}
