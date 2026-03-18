import http from "http";
import fs from "fs";
import path from "path";

/**
 * 临时 HTTP 服务器
 * 为本地多文件 Web 项目（HTML + CSS + JS）提供 HTTP 服务
 * 解决 file:// 协议下 ES modules / fetch / CORS 不可用的问题
 */

const MIME_TYPES: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".txt": "text/plain; charset=utf-8",
    ".xml": "text/xml; charset=utf-8",
    ".pdf": "application/pdf",
};

interface ServerInstance {
    server: http.Server;
    rootDir: string;
    port: number;
    lastAccess: number;
    autoCloseTimer: NodeJS.Timeout;
}

// 活跃的服务器实例（按 rootDir 索引）
const activeServers = new Map<string, ServerInstance>();

// 自动关闭超时（10 分钟）
const AUTO_CLOSE_MS = 10 * 60 * 1000;

/**
 * 为指定目录启动 HTTP 服务器
 * 同一目录复用已有服务器实例
 */
export async function serveDirectory(rootDir: string): Promise<{ url: string; port: number }> {
    const normalizedDir = path.resolve(rootDir);

    // 检查是否已有服务器
    const existing = activeServers.get(normalizedDir);
    if (existing) {
        existing.lastAccess = Date.now();
        // 重置自动关闭计时器
        clearTimeout(existing.autoCloseTimer);
        existing.autoCloseTimer = setTimeout(() => stopServer(normalizedDir), AUTO_CLOSE_MS);
        return { url: `http://localhost:${existing.port}`, port: existing.port };
    }

    // 选择端口（8900-8999）
    const port = await findAvailablePort(8900, 8999);

    const server = http.createServer((req, res) => {
        const instance = activeServers.get(normalizedDir);
        if (instance) {
            instance.lastAccess = Date.now();
            // 每次请求重置自动关闭计时器
            clearTimeout(instance.autoCloseTimer);
            instance.autoCloseTimer = setTimeout(() => stopServer(normalizedDir), AUTO_CLOSE_MS);
        }

        let reqPath = decodeURIComponent(req.url || "/");
        // 去掉 query string
        reqPath = reqPath.split("?")[0];

        // 默认 index.html
        if (reqPath === "/") reqPath = "/index.html";

        const filePath = path.join(normalizedDir, reqPath);

        // 安全检查：防止路径遍历（使用 path.sep 防止同前缀目录绕过）
        const normalizedFilePath = path.resolve(filePath);
        if (!normalizedFilePath.startsWith(normalizedDir + path.sep) && normalizedFilePath !== normalizedDir) {
            res.writeHead(403);
            res.end("Forbidden");
            return;
        }

        if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
            res.writeHead(404);
            res.end("Not Found");
            return;
        }

        const ext = path.extname(filePath).toLowerCase();
        const contentType = MIME_TYPES[ext] || "application/octet-stream";

        try {
            const data = fs.readFileSync(filePath);
            res.writeHead(200, {
                "Content-Type": contentType,
                "Content-Length": data.length,
                "Access-Control-Allow-Origin": "*",
            });
            res.end(data);
        } catch (err) {
            res.writeHead(500);
            res.end("Internal Server Error");
        }
    });

    return new Promise((resolve, reject) => {
        server.listen(port, "127.0.0.1", () => {
            const autoCloseTimer = setTimeout(() => stopServer(normalizedDir), AUTO_CLOSE_MS);

            activeServers.set(normalizedDir, {
                server,
                rootDir: normalizedDir,
                port,
                lastAccess: Date.now(),
                autoCloseTimer,
            });

            console.error(`[web-fetcher] 临时 HTTP 服务器启动: http://localhost:${port} → ${normalizedDir}`);
            resolve({ url: `http://localhost:${port}`, port });
        });

        server.on("error", (err) => {
            reject(new Error(`HTTP 服务器启动失败: ${err.message}`));
        });
    });
}

/**
 * 关闭指定目录的服务器
 */
export function stopServer(rootDir: string): void {
    const normalizedDir = path.resolve(rootDir);
    const instance = activeServers.get(normalizedDir);
    if (instance) {
        clearTimeout(instance.autoCloseTimer);
        instance.server.close();
        activeServers.delete(normalizedDir);
        console.error(`[web-fetcher] HTTP 服务器关闭: port ${instance.port} → ${normalizedDir}`);
    }
}

/**
 * 关闭所有活跃的服务器
 */
export function stopAllServers(): void {
    for (const [dir] of activeServers) {
        stopServer(dir);
    }
}

/**
 * 检查 HTML 文件是否属于多文件项目（同目录下有 .js/.css/.json 等关联文件）
 */
export function isMultiFileProject(htmlFilePath: string): boolean {
    const dir = path.dirname(htmlFilePath);
    try {
        const files = fs.readdirSync(dir);
        const associatedExts = [".js", ".css", ".json", ".mjs", ".ts", ".jsx", ".tsx"];
        return files.some(f => associatedExts.includes(path.extname(f).toLowerCase()));
    } catch {
        return false;
    }
}

/**
 * 找到可用端口
 */
function findAvailablePort(start: number, end: number): Promise<number> {
    return new Promise((resolve, reject) => {
        let port = start;
        const tryPort = () => {
            if (port > end) {
                reject(new Error(`端口范围 ${start}-${end} 全部被占用`));
                return;
            }
            const server = http.createServer();
            server.listen(port, "127.0.0.1", () => {
                server.close(() => resolve(port));
            });
            server.on("error", () => {
                port++;
                tryPort();
            });
        };
        tryPort();
    });
}
