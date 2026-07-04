import fs from "fs";
import os from "os";
import path from "path";
import { pathToFileURL } from "url";
import { spawn, spawnSync } from "child_process";
import { createRequire } from "module";
import MarkdownIt from "markdown-it";
import katex from "katex";

const localRequire = createRequire(import.meta.url);

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

/**
 * 用 KaTeX 把公式渲染为 HTML+MathML；失败时降级为代码样式原文，绝不抛出。
 */
function katexRender(content: string, displayMode: boolean): string {
    try {
        return katex.renderToString(content, { displayMode, throwOnError: false, output: "htmlAndMathml" });
    } catch {
        return `<code>${escapeHtml(displayMode ? `$$${content}$$` : `$${content}$`)}</code>`;
    }
}

/**
 * markdown-it 行内规则：识别 $...$（行内）与 $$...$$（块级）公式。
 * 行内 $...$ 要求首尾非空白，规避 "$5 和 $10" 这类货币误判。
 */
function mathInlineRule(state: any, silent: boolean): boolean {
    const src: string = state.src;
    const pos: number = state.pos;
    if (src.charCodeAt(pos) !== 0x24 /* $ */) return false;
    let marker = "$";
    let isBlock = false;
    if (src.charCodeAt(pos + 1) === 0x24) { marker = "$$"; isBlock = true; }
    const contentStart = pos + marker.length;
    const end = src.indexOf(marker, contentStart);
    if (end < 0 || end === contentStart) return false;
    const raw = src.slice(contentStart, end);
    if (!isBlock && /^\s|\s$/u.test(raw)) return false;
    const content = raw.trim();
    if (!content) return false;
    if (!silent) {
        const token = state.push(isBlock ? "math_block" : "math_inline", "", 0);
        token.content = content;
        token.markup = marker;
    }
    state.pos = end + marker.length;
    return true;
}

let cachedMd: MarkdownIt | null = null;
function getMarkdownRenderer(): MarkdownIt {
    if (cachedMd) return cachedMd;
    // html:true 透传 formatRound 产出的 <details> 折叠；离线 PDF 导出、内容为用户自有对话，可接受。
    const md = new MarkdownIt({ html: true, linkify: true, breaks: true, typographer: false });
    md.inline.ruler.after("escape", "math", mathInlineRule);
    md.renderer.rules.math_inline = (tokens: any, idx: number) => katexRender(tokens[idx].content, false);
    md.renderer.rules.math_block = (tokens: any, idx: number) => katexRender(tokens[idx].content, true);
    cachedMd = md;
    return md;
}

/**
 * 读取 KaTeX 官方 CSS，并把其中的 woff2 字体引用替换为 base64 data URL 内联，
 * 保证离线 file:// 打印时公式字形正确（不依赖相对路径/CDN）。失败则返回空串降级。
 */
let cachedKatexCss: string | null = null;
function buildKatexCss(): string {
    if (cachedKatexCss !== null) return cachedKatexCss;
    try {
        const cssPath = localRequire.resolve("katex/dist/katex.min.css");
        const fontsDir = path.join(path.dirname(cssPath), "fonts");
        let css = fs.readFileSync(cssPath, "utf8");
        css = css.replace(/url\(fonts\/([A-Za-z0-9_.-]+\.woff2)\)/gu, (match, file) => {
            try {
                const buf = fs.readFileSync(path.join(fontsDir, String(file)));
                return `url(data:font/woff2;base64,${buf.toString("base64")})`;
            } catch {
                return match;
            }
        });
        cachedKatexCss = css;
    } catch {
        cachedKatexCss = "";
    }
    return cachedKatexCss;
}

/**
 * 把每轮的「👤 用户」「🤖 AI」消息块各自包进气泡 <section>（仅 PDF 展示用，不改 .md）。
 * 依据 markdown-it 产出的 <h3>👤.../<h3>🤖... 作为消息块起点，<h2>（轮次/分节标题）或下一条消息作为收束点。
 */
function wrapMessageBubbles(html: string): string {
    let open = "";
    const close = (): string => {
        const closed = open ? "</section>" : "";
        open = "";
        return closed;
    };
    const re = /<h2>|<h3>\s*\u{1F464}|<h3>\s*\u{1F916}/gu;
    let result = html.replace(re, (match: string) => {
        if (match.startsWith("<h2")) return close() + match;
        const cls = match.includes("\u{1F464}") ? "user" : "ai";
        const prefix = close();
        open = cls;
        return `${prefix}<section class="msg ${cls}">${match}`;
    });
    if (open) result += "</section>";
    return result;
}

export function markdownToHtml(markdown: string, options: { title?: string } = {}): string {
    const md = getMarkdownRenderer();
    let bodyHtml = md.render(markdown);
    // formatRound 用 <details> 折叠思考；PDF 静态页需展开才能看到内容
    bodyHtml = bodyHtml.replace(/<details>/gu, "<details open>");
    // 把每轮的 用户/AI 消息块各自包进气泡（仅 PDF 展示，不影响 .md）
    bodyHtml = wrapMessageBubbles(bodyHtml);

    const title = escapeHtml(options.title || "Conversation Export");
    const katexCss = buildKatexCss();
    return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>${title}</title>
<style>
${katexCss}
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
  p, li, blockquote, td, th { font-size: 13px; }
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
    break-inside: avoid;
  }
  pre code { background: transparent; color: inherit; padding: 0; }
  img {
    display: block;
    max-width: 100%;
    max-height: 720px;
    margin: 12px 0;
    border: 1px solid #e5e7eb;
    border-radius: 10px;
    break-inside: avoid;
  }
  table { border-collapse: collapse; margin: 12px 0; width: auto; max-width: 100%; break-inside: avoid; }
  th, td { border: 1px solid #d1d5db; padding: 6px 12px; text-align: left; vertical-align: top; }
  thead th { background: #f3f4f6; font-weight: 600; }
  tbody tr:nth-child(even) { background: #fafafa; }
  del { color: #9ca3af; }
  details {
    border: 1px solid #d1d5db;
    border-radius: 10px;
    padding: 10px 12px;
    margin: 12px 0;
    background: #f9fafb;
    break-inside: avoid;
  }
  details > summary { font-weight: 600; font-size: 13px; color: #374151; cursor: default; margin-bottom: 8px; list-style: none; }
  details > summary::-webkit-details-marker { display: none; }
  a { color: #2563eb; text-decoration: none; overflow-wrap: anywhere; }
  hr { border: 0; border-top: 1px solid #e5e7eb; margin: 24px 0; }
  ul, ol { padding-left: 22px; }
  .msg { border-radius: 12px; padding: 2px 18px 12px; margin: 16px 0; break-inside: avoid; }
  .msg.user { background: #eff6ff; border: 1px solid #bfdbfe; }
  .msg.ai { background: #fafafa; border: 1px solid #e8eaed; }
  .msg > h3:first-child { margin-top: 12px; }
  .katex { font-size: 1.05em; }
  .katex-display { margin: 12px 0; overflow-x: auto; overflow-y: hidden; break-inside: avoid; }
  @page { margin: 18mm 14mm; }
</style>
</head>
<body>
${bodyHtml}
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

async function runBrowserPrintCli(browserPath: string, htmlPath: string, pdfPath: string, exportDir: string, timeoutMs: number): Promise<void> {
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

/**
 * 通过 Chrome DevTools Protocol 的 Page.printToPDF 打印，关键是能精确控制：
 *   - displayHeaderFooter:false → 去掉浏览器默认页眉页脚（file:// 地址 + 页码），解决用户反馈的页脚乱码
 *   - printBackground:true     → 渲染 CSS 背景色（气泡底色），命令行 --print-to-pdf 无法保证
 *   - preferCSSPageSize:true   → 使用 HTML 里的 @page 边距
 * 命令行 `--print-to-pdf` 强制带页眉页脚且无 flag 可关（实测 --print-to-pdf-no-header 在 Edge 149 已失效），故改用 CDP。
 * node >=21 自带全局 WebSocket，无需第三方依赖。失败由调用方回退到命令行打印。
 */
async function runBrowserPrintCdp(browserPath: string, htmlPath: string, pdfPath: string, exportDir: string, timeoutMs: number): Promise<void> {
    const WebSocketCtor = (globalThis as { WebSocket?: any }).WebSocket;
    if (!WebSocketCtor) throw new Error("当前 Node 运行时无内置 WebSocket（需 Node >=21），无法走 CDP 打印");

    const profileDir = path.join(exportDir, ".pdf-browser-profile-cdp");
    fs.mkdirSync(profileDir, { recursive: true });
    const fileUrl = pathToFileURL(htmlPath).href;
    const child = spawn(browserPath, [
        "--headless=new",
        "--disable-gpu",
        "--no-sandbox",
        `--user-data-dir=${profileDir}`,
        "--remote-debugging-port=0",
        "--allow-file-access-from-files",
        "about:blank",
    ], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });

    let ws: any = null;
    const cleanup = () => {
        try { if (ws) ws.close(); } catch { /* ignore */ }
        try { child.kill("SIGKILL"); } catch { /* ignore */ }
    };

    try {
        const wsEndpoint = await new Promise<string>((resolve, reject) => {
            let buf = "";
            const timer = setTimeout(() => reject(new Error(`等待 CDP endpoint 超时；stderr=${buf.slice(0, 400)}`)), Math.min(timeoutMs, 20_000));
            const onData = (d: Buffer) => {
                buf += d.toString();
                const m = /ws:\/\/[^\s]+/u.exec(buf);
                if (m) { clearTimeout(timer); child.stderr?.off("data", onData); resolve(m[0]); }
            };
            child.stderr?.on("data", onData);
            child.on("error", err => { clearTimeout(timer); reject(err); });
            child.on("exit", code => { clearTimeout(timer); reject(new Error(`浏览器在建立 CDP 前退出，code=${code}`)); });
        });

        ws = new WebSocketCtor(wsEndpoint);
        let nextId = 1;
        const pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
        const sessionHandlers: Array<(msg: any) => void> = [];
        ws.addEventListener("message", (ev: any) => {
            let msg: any;
            try { msg = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data)); } catch { return; }
            if (msg.id && pending.has(msg.id)) {
                const p = pending.get(msg.id)!;
                pending.delete(msg.id);
                if (msg.error) p.reject(new Error(JSON.stringify(msg.error))); else p.resolve(msg.result);
            } else {
                for (const h of sessionHandlers) h(msg);
            }
        });

        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("CDP WebSocket 连接超时")), Math.min(timeoutMs, 15_000));
            ws.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
            ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("CDP WebSocket 连接错误")); }, { once: true });
        });

        const send = (method: string, params?: any, sessionId?: string, opTimeout = 30_000): Promise<any> => {
            const id = nextId++;
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP ${method} 超时 ${opTimeout}ms`)); }, opTimeout);
                pending.set(id, {
                    resolve: (v: any) => { clearTimeout(timer); resolve(v); },
                    reject: (e: any) => { clearTimeout(timer); reject(e); },
                });
                ws.send(JSON.stringify({ id, method, params: params || {}, sessionId }));
            });
        };

        const { targetId } = await send("Target.createTarget", { url: fileUrl });
        const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
        await send("Page.enable", {}, sessionId);
        await new Promise<void>((resolve) => {
            const to = setTimeout(resolve, Math.min(timeoutMs, 8_000));
            sessionHandlers.push(msg => {
                if (msg.method === "Page.loadEventFired" && msg.sessionId === sessionId) { clearTimeout(to); resolve(); }
            });
        });

        // load 事件早于内嵌图片解码完成 → 直接 printToPDF 会偶发缺图/裂图。
        // 显式等所有 <img> decode 完成（单图失败不阻塞整体），用 awaitPromise 让 CDP 等 Promise 落定。
        // 失败/超时都不抛错——decode 只是尽力而为，宁可缺图也不让导出整体失败。
        try {
            await send("Runtime.evaluate", {
                expression: "Promise.all([...document.images].map(img => img.decode().catch(() => {})))",
                awaitPromise: true,
                returnByValue: true,
            }, sessionId, Math.min(timeoutMs, 15_000));
        } catch { /* decode 等待失败不阻塞打印 */ }

        const result = await send("Page.printToPDF", {
            displayHeaderFooter: false,
            printBackground: true,
            preferCSSPageSize: true,
        }, sessionId, timeoutMs);
        if (!result?.data) throw new Error("CDP printToPDF 返回空数据");

        const bytes = Buffer.from(result.data, "base64");
        const tmpPath = `${pdfPath}.${process.pid}.cdp.tmp`;
        fs.writeFileSync(tmpPath, bytes);
        fs.renameSync(tmpPath, pdfPath);
        if (!(fs.existsSync(pdfPath) && fs.statSync(pdfPath).size > 0)) throw new Error("CDP 输出 PDF 为空");
        try { await send("Browser.close", {}, undefined, 5_000); } catch { /* ignore */ }
    } finally {
        cleanup();
    }
}

/**
 * 打印调度：默认走 CDP（可控页眉页脚 + 背景），失败回退命令行 --print-to-pdf（旧逻辑，健壮性兜底）。
 * 环境变量 MEMORY_STORE_CONVERSATION_EXPORT_PDF_ENGINE=cdp|cli 可强制引擎，便于排障。
 */
async function runBrowserPrint(browserPath: string, htmlPath: string, pdfPath: string, exportDir: string, timeoutMs: number, warnings: string[]): Promise<void> {
    const engine = (process.env.MEMORY_STORE_CONVERSATION_EXPORT_PDF_ENGINE || "cdp").trim().toLowerCase();
    if (engine !== "cli") {
        try {
            await runBrowserPrintCdp(browserPath, htmlPath, pdfPath, exportDir, timeoutMs);
            return;
        } catch (error) {
            warnings.push(`CDP 打印失败，回退命令行打印（页眉页脚可能残留）：${error instanceof Error ? error.message : String(error)}`);
            try { if (fs.existsSync(pdfPath)) fs.unlinkSync(pdfPath); } catch { /* ignore */ }
        }
    }
    await runBrowserPrintCli(browserPath, htmlPath, pdfPath, exportDir, timeoutMs);
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
            warnings,
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
