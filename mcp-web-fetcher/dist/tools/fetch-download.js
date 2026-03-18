import { z } from "zod";
import { browserManager } from "../browser.js";
import { touchActivity } from "../lifecycle.js";
import { appendTiming } from "../constants.js";
import { saveTempFile, generateCacheKey } from "../temp-store.js";
import fs from "fs";
import path from "path";
const FetchDownloadInputSchema = z.object({
    url: z
        .string()
        .refine(s => /^(https?|file):\/\//i.test(s), "请提供有效的 URL（支持 http/https/file 协议）")
        .describe("要下载的文件 URL"),
    savePath: z
        .string()
        .optional()
        .describe("可选，保存到指定路径。不指定则保存到临时目录"),
    timeout: z
        .number()
        .int()
        .min(1000)
        .max(120000)
        .optional()
        .describe("超时毫秒数，默认 30000"),
});
export function registerFetchDownload(server) {
    server.registerTool("web_download", {
        title: "下载文件",
        description: `通过浏览器下载文件（自动携带 Cookie），保存到本地。
适用于下载需要登录态的文件（如知乎导出、Google Drive 等）。
也支持 file:// 协议复制本地文件。

参数:
  - url (string, 必须): 要下载的文件 URL（支持 http/https/file 协议）
  - savePath (string, 可选): 保存到指定路径。不指定则保存到临时目录
  - timeout (number, 可选): 超时毫秒数，默认 30000

返回: 文件路径 + 大小 + 耗时`,
        inputSchema: {
            url: FetchDownloadInputSchema.shape.url,
            savePath: FetchDownloadInputSchema.shape.savePath,
            timeout: FetchDownloadInputSchema.shape.timeout,
        },
        annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: true,
        },
    }, async (params) => {
        touchActivity();
        const startTime = Date.now();
        try {
            // file:// 协议：直接复制文件
            if (params.url.startsWith("file://")) {
                const srcPath = decodeURIComponent(params.url.replace(/^file:\/\/\/?/, ''));
                if (!fs.existsSync(srcPath)) {
                    return {
                        isError: true,
                        content: [{ type: "text", text: `文件不存在: ${srcPath}` }],
                    };
                }
                const data = fs.readFileSync(srcPath);
                const ext = path.extname(srcPath);
                const basename = path.basename(srcPath);
                let finalPath;
                if (params.savePath) {
                    const saveDir = path.dirname(params.savePath);
                    if (!fs.existsSync(saveDir))
                        fs.mkdirSync(saveDir, { recursive: true });
                    fs.copyFileSync(srcPath, params.savePath);
                    finalPath = params.savePath;
                }
                else {
                    const cacheKey = generateCacheKey(srcPath, "download");
                    finalPath = saveTempFile("downloads", cacheKey, ext, data);
                }
                const sizeStr = formatSize(data.length);
                return appendTiming({
                    content: [{
                            type: "text",
                            text: `✅ 文件复制完成\n文件名: ${basename}\n大小: ${sizeStr}\n路径: ${finalPath}`,
                        }],
                }, startTime);
            }
            // HTTP(S) 下载：通过浏览器上下文（携带 Cookie）
            const context = await browserManager.getContext();
            const timeout = params.timeout ?? 30000;
            const response = await context.request.get(params.url, { timeout });
            if (!response.ok()) {
                return appendTiming({
                    isError: true,
                    content: [{
                            type: "text",
                            text: `下载失败: HTTP ${response.status()} ${response.statusText()}\nURL: ${params.url}`,
                        }],
                }, startTime);
            }
            const body = await response.body();
            const contentType = response.headers()['content-type'] || '';
            const contentDisposition = response.headers()['content-disposition'] || '';
            // 从 Content-Disposition 或 URL 推断文件名
            let filename = '';
            const cdMatch = contentDisposition.match(/filename[*]?=(?:UTF-8''|"?)([^";\n]+)/i);
            if (cdMatch) {
                filename = decodeURIComponent(cdMatch[1].trim());
            }
            else {
                const urlPath = new URL(params.url).pathname;
                filename = path.basename(urlPath) || 'download';
            }
            const ext = path.extname(filename) || guessExtFromContentType(contentType);
            if (!path.extname(filename))
                filename += ext;
            let finalPath;
            if (params.savePath) {
                const saveDir = path.dirname(params.savePath);
                if (!fs.existsSync(saveDir))
                    fs.mkdirSync(saveDir, { recursive: true });
                fs.writeFileSync(params.savePath, body);
                finalPath = params.savePath;
            }
            else {
                const cacheKey = generateCacheKey(params.url, "download");
                finalPath = saveTempFile("downloads", cacheKey, ext, body);
            }
            const sizeStr = formatSize(body.length);
            return appendTiming({
                content: [{
                        type: "text",
                        text: `✅ 下载完成\n文件名: ${filename}\n大小: ${sizeStr}\n类型: ${contentType}\n路径: ${finalPath}`,
                    }],
            }, startTime);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return {
                isError: true,
                content: [{ type: "text", text: `下载失败: ${message}` }],
            };
        }
    });
}
function formatSize(bytes) {
    if (bytes < 1024)
        return `${bytes} B`;
    if (bytes < 1024 * 1024)
        return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
function guessExtFromContentType(ct) {
    const map = {
        'application/pdf': '.pdf',
        'application/zip': '.zip',
        'application/x-gzip': '.gz',
        'application/json': '.json',
        'text/html': '.html',
        'text/plain': '.txt',
        'text/csv': '.csv',
        'image/png': '.png',
        'image/jpeg': '.jpg',
        'image/gif': '.gif',
        'image/webp': '.webp',
        'audio/mpeg': '.mp3',
        'video/mp4': '.mp4',
    };
    for (const [mime, ext] of Object.entries(map)) {
        if (ct.includes(mime))
            return ext;
    }
    return '.bin';
}
//# sourceMappingURL=fetch-download.js.map