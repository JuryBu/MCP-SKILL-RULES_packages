import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import os from "os";
import { fileHashKey, saveTempFile, getTempFile } from "./temp-store.js";

const execFileAsync = promisify(execFile);

/**
 * 文档格式转换器
 * - 自动检测系统上可用的转换工具（LibreOffice / xelatex / pdflatex）
 * - 将 DOCX/PPTX/XLSX/TEX 等文件转换为 PDF
 * - 带缓存命中机制
 */

interface ConverterTools {
    libreoffice?: string; // soffice.exe 路径
    xelatex?: string;
    pdflatex?: string;
}

let detectedTools: ConverterTools | null = null;

/**
 * 检测系统上可用的转换工具
 */
export async function detectConversionTools(): Promise<ConverterTools> {
    if (detectedTools) return detectedTools;

    const tools: ConverterTools = {};

    // 检测 LibreOffice
    const loSearchPaths = [
        "C:\\Program Files\\LibreOffice\\program\\soffice.exe",
        "C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe",
    ];
    for (const p of loSearchPaths) {
        if (fs.existsSync(p)) {
            tools.libreoffice = p;
            break;
        }
    }
    if (!tools.libreoffice) {
        try {
            const { stdout } = await execFileAsync("where.exe", ["soffice"]);
            const found = stdout.trim().split("\n")[0]?.trim();
            if (found && fs.existsSync(found)) tools.libreoffice = found;
        } catch { /* not found */ }
    }

    // 检测 xelatex
    try {
        const { stdout } = await execFileAsync("where.exe", ["xelatex"]);
        const found = stdout.trim().split("\n")[0]?.trim();
        if (found) tools.xelatex = found;
    } catch { /* not found */ }

    // 检测 pdflatex
    try {
        const { stdout } = await execFileAsync("where.exe", ["pdflatex"]);
        const found = stdout.trim().split("\n")[0]?.trim();
        if (found) tools.pdflatex = found;
    } catch { /* not found */ }

    detectedTools = tools;
    const toolNames = Object.entries(tools).filter(([, v]) => v).map(([k]) => k).join(", ");
    console.error(`[web-fetcher] 检测到转换工具: ${toolNames || "无"}`);
    return tools;
}

// 支持通过 LibreOffice 转换的文件扩展名
const LIBREOFFICE_FORMATS = new Set([
    ".docx", ".doc", ".odt", ".rtf",
    ".pptx", ".ppt", ".odp",
    ".xlsx", ".xls", ".ods",
]);

// 可直接在浏览器中渲染的文件扩展名
const BROWSER_RENDERABLE = new Set([
    ".html", ".htm", ".xhtml", ".svg",
]);

// 图片文件扩展名
const IMAGE_FORMATS = new Set([
    ".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp", ".svg", ".ico",
]);

// 视频文件扩展名
const VIDEO_FORMATS = new Set([
    ".mp4", ".webm", ".avi", ".mkv", ".mov",
]);

// 纯文本文件（不需要转换，直接读取）
const TEXT_FORMATS = new Set([
    ".md", ".txt", ".csv", ".tsv", ".json", ".xml",
    ".py", ".js", ".ts", ".jsx", ".tsx", ".css",
    ".java", ".c", ".cpp", ".h", ".hpp",
    ".go", ".rs", ".rb", ".php", ".sh", ".bat",
    ".yaml", ".yml", ".toml", ".ini", ".cfg",
    ".log", ".env", ".gitignore",
]);

// TeX 文件
const TEX_FORMATS = new Set([".tex", ".latex"]);

/**
 * 判断文件类型
 */
export type FileCategory = "pdf" | "html" | "image" | "video" | "office" | "tex" | "text" | "unknown";

export function categorizeFile(filePath: string): FileCategory {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === ".pdf") return "pdf";
    if (BROWSER_RENDERABLE.has(ext)) return "html";
    if (IMAGE_FORMATS.has(ext)) return "image";
    if (VIDEO_FORMATS.has(ext)) return "video";
    if (LIBREOFFICE_FORMATS.has(ext)) return "office";
    if (TEX_FORMATS.has(ext)) return "tex";
    if (TEXT_FORMATS.has(ext)) return "text";
    return "unknown";
}

/**
 * 将文件转换为 PDF（带缓存）
 * @returns 临时 PDF 文件路径
 */
export async function convertToPDF(filePath: string): Promise<string> {
    // 检查源文件存在
    if (!fs.existsSync(filePath)) {
        throw new Error(`文件不存在: ${filePath}`);
    }

    // 缓存检查
    const cacheKey = fileHashKey(filePath);
    const cached = getTempFile("converted", cacheKey, ".pdf");
    if (cached) {
        console.error(`[web-fetcher] 转换缓存命中: ${cached}`);
        return cached;
    }

    const ext = path.extname(filePath).toLowerCase();
    const tools = await detectConversionTools();

    let pdfPath: string;

    if (LIBREOFFICE_FORMATS.has(ext)) {
        // Office 格式 → LibreOffice
        if (!tools.libreoffice) {
            throw new Error(`转换 ${ext} 文件需要 LibreOffice，但系统未检测到。请安装 LibreOffice。`);
        }
        pdfPath = await convertWithLibreOffice(tools.libreoffice, filePath, cacheKey);
    } else if (TEX_FORMATS.has(ext)) {
        // TeX → xelatex/pdflatex
        const compiler = tools.xelatex || tools.pdflatex;
        if (!compiler) {
            throw new Error(`编译 ${ext} 文件需要 xelatex 或 pdflatex，但系统未检测到。`);
        }
        pdfPath = await convertWithLatex(compiler, filePath, cacheKey);
    } else {
        throw new Error(`不支持将 ${ext} 格式转换为 PDF`);
    }

    return pdfPath;
}

/**
 * 使用 LibreOffice 转换文件为 PDF
 */
async function convertWithLibreOffice(soffice: string, filePath: string, cacheKey: string): Promise<string> {
    const outDir = path.join(os.tmpdir(), "mcp-web-fetcher", "converted");
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    const tempOutName = `lo_${cacheKey}`;
    const tempDir = path.join(outDir, tempOutName);
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

    const args = ["--headless", "--convert-to", "pdf", "--outdir", tempDir, filePath];
    console.error(`[web-fetcher] LibreOffice 转换: ${soffice} ${args.join(' ')}`);

    try {
        await execFileAsync(soffice, args, { timeout: 30000 });
    } catch (err: any) {
        throw new Error(`LibreOffice 转换失败: ${err.message}`);
    }

    // 找到生成的 PDF 文件
    const files = fs.readdirSync(tempDir).filter(f => f.endsWith(".pdf"));
    if (files.length === 0) {
        throw new Error("LibreOffice 转换完成但未找到输出 PDF 文件");
    }

    const generatedPdf = path.join(tempDir, files[0]);
    const pdfData = fs.readFileSync(generatedPdf);

    // 保存到统一的临时文件位置
    const finalPath = saveTempFile("converted", cacheKey, ".pdf", pdfData);

    // 清理 LibreOffice 临时目录
    try {
        fs.rmSync(tempDir, { recursive: true, force: true });
    } catch { /* 忽略清理错误 */ }

    console.error(`[web-fetcher] 转换完成: ${finalPath} (${(pdfData.length / 1024).toFixed(1)} KB)`);
    return finalPath;
}

/**
 * 使用 LaTeX 编译 .tex 为 PDF
 */
async function convertWithLatex(compiler: string, filePath: string, cacheKey: string): Promise<string> {
    const outDir = path.join(os.tmpdir(), "mcp-web-fetcher", "converted");
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    const tempDir = path.join(outDir, `tex_${cacheKey}`);
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

    const args = ["-interaction=nonstopmode", `-output-directory=${tempDir}`, filePath];
    console.error(`[web-fetcher] LaTeX 编译: ${compiler} ${args.join(' ')}`);

    try {
        await execFileAsync(compiler, args, { timeout: 60000 });
    } catch (err: any) {
        // LaTeX 编译警告不算失败，只要有 PDF 输出就行
        console.error(`[web-fetcher] LaTeX 编译有警告/错误，检查输出...`);
    }

    const files = fs.readdirSync(tempDir).filter(f => f.endsWith(".pdf"));
    if (files.length === 0) {
        throw new Error("LaTeX 编译失败：未生成 PDF 文件");
    }

    const generatedPdf = path.join(tempDir, files[0]);
    const pdfData = fs.readFileSync(generatedPdf);
    const finalPath = saveTempFile("converted", cacheKey, ".pdf", pdfData);

    try {
        fs.rmSync(tempDir, { recursive: true, force: true });
    } catch { /* 忽略 */ }

    console.error(`[web-fetcher] 编译完成: ${finalPath} (${(pdfData.length / 1024).toFixed(1)} KB)`);
    return finalPath;
}

/**
 * 将 xlsx 文件转换为 CSV 文本摘要
 * 使用 Node.js 简单解析（不依赖外部库），读取前 N 行
 */
export async function xlsxToTextSummary(filePath: string): Promise<string> {
    // 先尝试使用 LibreOffice 转为 CSV
    const tools = await detectConversionTools();
    if (!tools.libreoffice) {
        return `⚠️ 无法解析 xlsx 文件：需要 LibreOffice。\n文件路径: ${filePath}`;
    }

    const outDir = path.join(os.tmpdir(), "mcp-web-fetcher", "converted");
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    const cacheKey = fileHashKey(filePath);
    const tempDir = path.join(outDir, `csv_${cacheKey}`);
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

    const args = ["--headless", "--convert-to", "csv", "--outdir", tempDir, filePath];

    try {
        await execFileAsync(tools.libreoffice, args, { timeout: 30000 });
    } catch (err: any) {
        return `⚠️ xlsx 转 CSV 失败: ${err.message}\n文件路径: ${filePath}`;
    }

    const files = fs.readdirSync(tempDir).filter(f => f.endsWith(".csv"));
    if (files.length === 0) {
        return `⚠️ xlsx 转 CSV 完成但未找到输出文件\n文件路径: ${filePath}`;
    }

    const csvContent = fs.readFileSync(path.join(tempDir, files[0]), "utf-8");
    const lines = csvContent.split("\n");
    const totalRows = lines.length;
    const previewRows = 30;
    const preview = lines.slice(0, previewRows).join("\n");

    try {
        fs.rmSync(tempDir, { recursive: true, force: true });
    } catch { /* 忽略 */ }

    return `📊 Excel 内容摘要\n文件: ${path.basename(filePath)}\n总行数: ${totalRows}\n\n--- 前 ${Math.min(previewRows, totalRows)} 行 ---\n${preview}${totalRows > previewRows ? `\n\n...(省略 ${totalRows - previewRows} 行)` : ""}`;
}
