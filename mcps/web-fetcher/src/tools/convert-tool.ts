import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { touchActivity } from "../lifecycle.js";
import { appendTiming } from "../constants.js";
import { convertToPDF, detectConversionTools, categorizeFile } from "../converter.js";
import { browserManager } from "../browser.js";
import { saveTempFile, fileHashKey, getTempFile } from "../temp-store.js";
import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import os from "os";

const execFileAsync = promisify(execFile);

const ConvertInputSchema = z.object({
    input: z
        .string()
        .describe("输入文件的绝对路径"),
    format: z
        .enum(["pdf", "html", "txt"])
        .describe("目标格式: pdf / html / txt"),
    savePath: z
        .string()
        .optional()
        .describe("可选，保存到指定路径。不指定则保存到临时目录"),
});

type ConvertInput = z.infer<typeof ConvertInputSchema>;

export function registerConvertTool(server: McpServer): void {
    server.registerTool(
        "web_convert",
        {
            title: "文件格式转换",
            description: `将文件转换为其他格式。

支持的转换:
  - Office (DOCX/PPTX/XLSX) → PDF（通过 LibreOffice）
  - Office → HTML（通过 LibreOffice）
  - Office → TXT（通过 LibreOffice）
  - HTML/Markdown → PDF（通过 Playwright 渲染）

参数:
  - input (string, 必须): 输入文件的绝对路径
  - format (string, 必须): 目标格式 pdf / html / txt
  - savePath (string, 可选): 保存到指定路径。不指定则保存到临时目录

返回: 输出文件路径 + 大小 + 耗时`,
            inputSchema: {
                input: ConvertInputSchema.shape.input,
                format: ConvertInputSchema.shape.format,
                savePath: ConvertInputSchema.shape.savePath,
            },
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
        },
        async (params: ConvertInput) => {
            touchActivity();
            const startTime = Date.now();

            try {
                if (!fs.existsSync(params.input)) {
                    return {
                        isError: true,
                        content: [{ type: "text" as const, text: `文件不存在: ${params.input}` }],
                    };
                }

                const ext = path.extname(params.input).toLowerCase();
                const category = categorizeFile(params.input);
                let outputPath: string;
                let outputSize: number;

                if (params.format === "pdf") {
                    // 分两种路径: Office→PDF(LibreOffice) 和 HTML/MD→PDF(Playwright)
                    if (category === "office") {
                        outputPath = await convertToPDF(params.input);
                    } else if (category === "html" || category === "text" && (ext === ".md" || ext === ".html" || ext === ".htm")) {
                        outputPath = await convertWithPlaywright(params.input, ext);
                    } else {
                        // 尝试用已有的 convertToPDF（它支持 TeX 等）
                        outputPath = await convertToPDF(params.input);
                    }
                    outputSize = fs.statSync(outputPath).size;
                } else if (params.format === "html" || params.format === "txt") {
                    // Office → html/txt 通过 LibreOffice
                    if (category !== "office") {
                        return {
                            isError: true,
                            content: [{ type: "text" as const, text: `仅 Office 文件 (DOCX/PPTX/XLSX) 支持转换为 ${params.format} 格式。当前文件类型: ${category}` }],
                        };
                    }
                    outputPath = await convertWithLibreOfficeTo(params.input, params.format);
                    outputSize = fs.statSync(outputPath).size;
                } else {
                    return {
                        isError: true,
                        content: [{ type: "text" as const, text: `不支持的目标格式: ${params.format}` }],
                    };
                }

                // 如果指定了 savePath，复制过去
                if (params.savePath) {
                    const saveDir = path.dirname(params.savePath);
                    if (!fs.existsSync(saveDir)) fs.mkdirSync(saveDir, { recursive: true });
                    fs.copyFileSync(outputPath, params.savePath);
                    outputPath = params.savePath;
                }

                const sizeStr = formatSize(outputSize);
                return appendTiming({
                    content: [{
                        type: "text" as const,
                        text: `✅ 转换完成\n输入: ${path.basename(params.input)}\n输出格式: ${params.format.toUpperCase()}\n大小: ${sizeStr}\n路径: ${outputPath}`,
                    }],
                }, startTime);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                return {
                    isError: true,
                    content: [{ type: "text" as const, text: `转换失败: ${message}` }],
                };
            }
        }
    );
}

/**
 * 通过 Playwright 将 HTML/Markdown 转换为 PDF
 */
async function convertWithPlaywright(filePath: string, _ext: string): Promise<string> {
    const cacheKey = fileHashKey(filePath);
    const cached = getTempFile("converted", cacheKey, ".pdf");
    if (cached) return cached;

    // 在浏览器中打开文件
    const fileUrl = `file:///${filePath.replace(/\\/g, '/')}`;
    const page = await browserManager.navigateTo(fileUrl, { timeout: 15000 });

    try {
        const pdfBuffer = await page.pdf({
            format: 'A4',
            printBackground: true,
            margin: { top: '20mm', right: '15mm', bottom: '20mm', left: '15mm' },
        });

        return saveTempFile("converted", cacheKey, ".pdf", Buffer.from(pdfBuffer));
    } finally {
        await page.close().catch(() => { });
    }
}

/**
 * 通过 LibreOffice 将 Office 文件转换为指定格式 (html/txt)
 */
async function convertWithLibreOfficeTo(filePath: string, format: string): Promise<string> {
    const tools = await detectConversionTools();
    if (!tools.libreoffice) {
        throw new Error("转换需要 LibreOffice，但系统未安装。");
    }

    const cacheKey = fileHashKey(filePath);
    const cachedExt = format === "html" ? ".html" : ".txt";
    const cached = getTempFile("converted", cacheKey, cachedExt);
    if (cached) return cached;

    const outDir = path.join(os.tmpdir(), "mcp-web-fetcher", "converted");
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    const tempDir = path.join(outDir, `cvt_${cacheKey}`);
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

    // 根据文件类型选择正确的过滤器
    const fileExt = path.extname(filePath).toLowerCase();
    let targetFormat: string;
    if (format === "html") {
        // PPTX 用专门的 impress 导出
        if (fileExt === ".pptx" || fileExt === ".ppt" || fileExt === ".odp") {
            targetFormat = "html:impress_html_Export";
        } else {
            targetFormat = "html:HTML:UTF8";
        }
    } else {
        // txt 格式：XLSX 用 CSV 过滤器，其他用 Text (encoded)
        if (fileExt === ".xlsx" || fileExt === ".xls" || fileExt === ".ods") {
            targetFormat = "csv:Text - txt - csv (StarCalc):44,34,76,1";
        } else {
            targetFormat = "txt:Text (encoded):UTF8";
        }
    }

    const args = ["--headless", "--convert-to", targetFormat, "--outdir", tempDir, filePath];

    try {
        await execFileAsync(tools.libreoffice, args, { timeout: 30000 });
    } catch (err: any) {
        throw new Error(`LibreOffice 转换失败: ${err.message}`);
    }

    const files = fs.readdirSync(tempDir).filter(f =>
        f.endsWith(`.${format}`) || f.endsWith(".html") || f.endsWith(".txt")
    );
    if (files.length === 0) {
        throw new Error(`转换完成但未找到 ${format} 输出文件`);
    }

    const data = fs.readFileSync(path.join(tempDir, files[0]));
    const finalPath = saveTempFile("converted", cacheKey, cachedExt, data);

    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { }

    return finalPath;
}

function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
