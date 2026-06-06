import fs from "fs";
import os from "os";
import path from "path";
import { pathToFileURL } from "url";
import { spawn, spawnSync } from "child_process";

export interface PdfRenderOptions {
    title?: string;
    exportDir: string;
    markdownPath: string;
    pdfPath: string;
    attachmentFiles?: Array<{ path: string; name: string; sizeBytes?: number }>;
    embedAttachments?: "off" | "auto" | "force";
    timeoutMs?: number;
}

export interface PdfRenderResult {
    ok: boolean;
    pdfPath?: string;
    htmlPath?: string;
    browserPath?: string;
    warnings: string[];
    embeddedAttachments: number;
}

const DEFAULT_PDF_TIMEOUT_MS = 120_000;
const MAX_EMBED_ATTACHMENT_BYTES = 20 * 1024 * 1024;

function escapeHtml(input: string): string {
    return input
        .replace(/&/gu, "&amp;")
        .replace(/</gu, "&lt;")
        .replace(/>/gu, "&gt;")
        .replace(/"/gu, "&quot;");
}

function inlineMarkdown(input: string): string {
    let text = escapeHtml(input);
    text = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/gu, (_match, alt, url) => {
        const src = String(url).replace(/^<|>$/gu, "");
        return `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" />`;
    });
    text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/gu, (_match, label, url) => {
        const href = String(url).replace(/^<|>$/gu, "");
        return `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`;
    });
    text = text.replace(/`([^`]+)`/gu, "<code>$1</code>");
    text = text.replace(/\*\*([^*]+)\*\*/gu, "<strong>$1</strong>");
    return text;
}

export function markdownToHtml(markdown: string, options: { title?: string } = {}): string {
    const body: string[] = [];
    const lines = markdown.replace(/\r\n?/gu, "\n").split("\n");
    let inCode = false;
    let codeLang = "";
    let codeLines: string[] = [];
    let inList = false;
    let paragraph: string[] = [];
    let inDetails = false;

    const flushParagraph = () => {
        if (paragraph.length === 0) return;
        body.push(`<p>${inlineMarkdown(paragraph.join(" "))}</p>`);
        paragraph = [];
    };
    const closeList = () => {
        if (!inList) return;
        body.push("</ul>");
        inList = false;
    };
    const flushCode = () => {
        body.push(`<pre class="language-${escapeHtml(codeLang)}"><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
        codeLines = [];
        codeLang = "";
    };

    for (const line of lines) {
        const fence = /^```(.*)$/u.exec(line);
        if (fence) {
            if (inCode) {
                flushCode();
                inCode = false;
                continue;
            }
            flushParagraph();
            closeList();
            inCode = true;
            codeLang = fence[1].trim();
            codeLines = [];
            continue;
        }
        if (inCode) {
            codeLines.push(line);
            continue;
        }

        if (!line.trim()) {
            flushParagraph();
            closeList();
            continue;
        }
        const detailsOpen = /^<details><summary>(.+)<\/summary>\s*$/u.exec(line.trim());
        if (detailsOpen) {
            flushParagraph();
            closeList();
            if (inDetails) body.push("</section>");
            body.push(`<section class="details-expanded"><h4>${inlineMarkdown(detailsOpen[1])}</h4>`);
            inDetails = true;
            continue;
        }
        if (line.trim() === "</details>") {
            flushParagraph();
            closeList();
            if (inDetails) {
                body.push("</section>");
                inDetails = false;
            }
            continue;
        }
        const heading = /^(#{1,6})\s+(.+)$/u.exec(line);
        if (heading) {
            flushParagraph();
            closeList();
            const level = heading[1].length;
            body.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
            continue;
        }
        if (/^---+\s*$/u.test(line.trim())) {
            flushParagraph();
            closeList();
            body.push("<hr />");
            continue;
        }
        const quote = /^>\s*(.*)$/u.exec(line);
        if (quote) {
            flushParagraph();
            closeList();
            body.push(`<blockquote>${inlineMarkdown(quote[1])}</blockquote>`);
            continue;
        }
        const listItem = /^[-*]\s+(.+)$/u.exec(line);
        if (listItem) {
            flushParagraph();
            if (!inList) {
                body.push("<ul>");
                inList = true;
            }
            body.push(`<li>${inlineMarkdown(listItem[1])}</li>`);
            continue;
        }
        paragraph.push(line.trim());
    }

    if (inCode) flushCode();
    flushParagraph();
    closeList();
    if (inDetails) body.push("</section>");

    const title = escapeHtml(options.title || "Conversation Export");
    return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>${title}</title>
<style>
  :root { color-scheme: light; }
  body {
    font-family: "Microsoft YaHei UI", "Microsoft YaHei", "Segoe UI Emoji", "Segoe UI", Arial, sans-serif;
    color: #1f2937;
    background: #ffffff;
    line-height: 1.65;
    max-width: 980px;
    margin: 0 auto;
    padding: 32px 42px;
  }
  h1, h2, h3, h4, h5, h6 { color: #111827; line-height: 1.25; page-break-after: avoid; }
  h1 { font-size: 28px; border-bottom: 2px solid #e5e7eb; padding-bottom: 12px; }
  h2 { font-size: 22px; margin-top: 32px; border-bottom: 1px solid #e5e7eb; padding-bottom: 8px; }
  h3 { font-size: 18px; margin-top: 22px; }
  p, li, blockquote { font-size: 13px; }
  blockquote { border-left: 4px solid #d1d5db; padding-left: 12px; color: #4b5563; margin-left: 0; }
  code { font-family: "Cascadia Code", Consolas, monospace; background: #f3f4f6; padding: 1px 4px; border-radius: 4px; }
  pre {
    font-family: "Cascadia Code", Consolas, monospace;
    background: #111827;
    color: #f9fafb;
    padding: 14px;
    border-radius: 10px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font-size: 11px;
    line-height: 1.45;
  }
  pre code { background: transparent; color: inherit; padding: 0; }
  img {
    display: block;
    max-width: 100%;
    max-height: 720px;
    margin: 12px 0;
    border: 1px solid #e5e7eb;
    border-radius: 10px;
  }
  .details-expanded {
    border: 1px solid #d1d5db;
    border-radius: 10px;
    padding: 10px 12px;
    margin: 12px 0;
    background: #f9fafb;
  }
  .details-expanded h4 { margin: 0 0 8px; font-size: 13px; color: #374151; }
  a { color: #2563eb; text-decoration: none; overflow-wrap: anywhere; }
  hr { border: 0; border-top: 1px solid #e5e7eb; margin: 24px 0; }
  ul { padding-left: 22px; }
  @page { margin: 18mm 14mm; }
</style>
</head>
<body>
${body.join("\n")}
</body>
</html>`;
}

function commonBrowserCandidates(): string[] {
    const env = process.env.MEMORY_STORE_CONVERSATION_EXPORT_BROWSER;
    const localAppData = process.env.LOCALAPPDATA || "";
    const programFiles = process.env.ProgramFiles || "C:\\Program Files";
    const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    return [
        env || "",
        path.join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"),
        path.join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
        path.join(localAppData, "Microsoft", "Edge", "Application", "msedge.exe"),
        path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
        path.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
        path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
        process.platform === "win32" ? "" : "/usr/bin/google-chrome",
        process.platform === "win32" ? "" : "/usr/bin/chromium-browser",
        process.platform === "win32" ? "" : "/usr/bin/chromium",
    ].filter(Boolean);
}

export function findPdfBrowser(): string | null {
    for (const candidate of commonBrowserCandidates()) {
        try {
            if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
        } catch {
            // ignore
        }
    }
    return null;
}

async function runBrowserPrint(browserPath: string, htmlPath: string, pdfPath: string, exportDir: string, timeoutMs: number): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const profileDir = path.join(exportDir, ".pdf-browser-profile");
        fs.mkdirSync(profileDir, { recursive: true });
        const child = spawn(browserPath, [
            "--headless=new",
            "--disable-gpu",
            "--no-sandbox",
            `--user-data-dir=${profileDir}`,
            `--print-to-pdf=${pdfPath}`,
            "--allow-file-access-from-files",
            pathToFileURL(htmlPath).href,
        ], { windowsHide: true, stdio: "ignore" });
        const timer = setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error(`PDF 渲染超时 ${timeoutMs}ms`));
        }, timeoutMs);
        child.on("error", error => {
            clearTimeout(timer);
            reject(error);
        });
        child.on("exit", code => {
            clearTimeout(timer);
            if (code === 0 && fs.existsSync(pdfPath) && fs.statSync(pdfPath).size > 0) {
                resolve();
            } else {
                reject(new Error(`浏览器 PDF 打印失败，退出码 ${code}`));
            }
        });
    });
}

function findPythonCommand(): string | null {
    for (const command of ["python", "py"]) {
        const check = spawnSync(command, command === "py" ? ["-3", "-c", "import sys; print(sys.version)"] : ["-c", "import sys; print(sys.version)"], {
            encoding: "utf-8",
            windowsHide: true,
        });
        if (check.status === 0) return command;
    }
    return null;
}

function tryEmbedPdfAttachments(pdfPath: string, attachments: Array<{ path: string; name: string; sizeBytes?: number }>, warnings: string[]): number {
    const eligible = attachments.filter(item => {
        try {
            return fs.existsSync(item.path)
                && fs.statSync(item.path).isFile()
                && fs.statSync(item.path).size <= Number(process.env.MEMORY_STORE_CONVERSATION_EXPORT_PDF_EMBED_MAX_BYTES || MAX_EMBED_ATTACHMENT_BYTES);
        } catch {
            return false;
        }
    });
    if (eligible.length === 0) return 0;
    const python = findPythonCommand();
    if (!python) {
        warnings.push("未找到 Python，跳过 PDF 原生附件嵌入");
        return 0;
    }
    const scriptPath = path.join(os.tmpdir(), `memory-store-pdf-attach-${process.pid}-${Date.now()}.py`);
    const payloadPath = path.join(os.tmpdir(), `memory-store-pdf-attach-${process.pid}-${Date.now()}.json`);
    const outputPath = `${pdfPath}.attachments.tmp.pdf`;
    const script = `
import json, sys
from pathlib import Path
try:
    from pypdf import PdfReader, PdfWriter
except Exception as exc:
    print(f"NO_PYPDF: {exc}", file=sys.stderr)
    sys.exit(2)
payload = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
reader = PdfReader(payload["pdf"])
writer = PdfWriter()
for page in reader.pages:
    writer.add_page(page)
count = 0
for item in payload["attachments"]:
    data = Path(item["path"]).read_bytes()
    writer.add_attachment(item["name"], data)
    count += 1
with open(payload["output"], "wb") as f:
    writer.write(f)
print(count)
`;
    try {
        fs.writeFileSync(scriptPath, script, "utf-8");
        fs.writeFileSync(payloadPath, JSON.stringify({
            pdf: pdfPath,
            output: outputPath,
            attachments: eligible.map(item => ({ path: item.path, name: item.name })),
        }), "utf-8");
        const args = python === "py" ? ["-3", scriptPath, payloadPath] : [scriptPath, payloadPath];
        const result = spawnSync(python, args, { encoding: "utf-8", windowsHide: true, timeout: 60_000 });
        if (result.status !== 0) {
            warnings.push(`PDF 原生附件嵌入不可用：${(result.stderr || result.stdout || "unknown").trim()}`);
            return 0;
        }
        fs.renameSync(outputPath, pdfPath);
        return Number((result.stdout || "0").trim()) || eligible.length;
    } catch (error) {
        warnings.push(`PDF 原生附件嵌入失败：${error instanceof Error ? error.message : String(error)}`);
        return 0;
    } finally {
        for (const file of [scriptPath, payloadPath, outputPath]) {
            try {
                if (fs.existsSync(file)) fs.unlinkSync(file);
            } catch {
                // ignore
            }
        }
    }
}

export async function renderConversationPdf(options: PdfRenderOptions): Promise<PdfRenderResult> {
    const warnings: string[] = [];
    const markdown = fs.readFileSync(options.markdownPath, "utf-8");
    const html = markdownToHtml(markdown, { title: options.title });
    const htmlPath = path.join(options.exportDir, "conversation.html");
    fs.writeFileSync(htmlPath, html, "utf-8");

    const browserPath = findPdfBrowser();
    if (!browserPath) {
        return {
            ok: false,
            htmlPath,
            warnings: ["未找到 Edge/Chrome 浏览器，无法生成 PDF；Markdown 导出仍可用"],
            embeddedAttachments: 0,
        };
    }

    try {
        await runBrowserPrint(
            browserPath,
            htmlPath,
            options.pdfPath,
            options.exportDir,
            options.timeoutMs ?? Number(process.env.MEMORY_STORE_CONVERSATION_EXPORT_PDF_TIMEOUT_MS || DEFAULT_PDF_TIMEOUT_MS),
        );
    } catch (error) {
        return {
            ok: false,
            htmlPath,
            browserPath,
            warnings: [`PDF 渲染失败：${error instanceof Error ? error.message : String(error)}`],
            embeddedAttachments: 0,
        };
    }

    let embeddedAttachments = 0;
    const embedMode = options.embedAttachments || "auto";
    if (embedMode !== "off" && options.attachmentFiles?.length) {
        embeddedAttachments = tryEmbedPdfAttachments(options.pdfPath, options.attachmentFiles, warnings);
        if (embedMode === "force" && embeddedAttachments === 0) {
            return {
                ok: false,
                pdfPath: options.pdfPath,
                htmlPath,
                browserPath,
                warnings: [...warnings, "pdfEmbedAttachments=force 但没有成功嵌入任何附件"],
                embeddedAttachments,
            };
        }
    }

    return {
        ok: true,
        pdfPath: options.pdfPath,
        htmlPath,
        browserPath,
        warnings,
        embeddedAttachments,
    };
}
