import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { chromium } from "playwright";
import { browserManager } from "../browser.js";
import { touchActivity } from "../lifecycle.js";
import {
    COOKIES_BACKUP_FILE,
    DEFAULT_USER_AGENT,
    DEFAULT_TIMEOUT,
    QUALITY_PRESETS,
    appendTiming,
} from "../constants.js";
import { saveTempFile, generateCacheKey } from "../temp-store.js";
import { categorizeFile } from "../converter.js";
import fs from "fs";
import path from "path";
import os from "os";
import sharp from "sharp";

const RecordVideoInputSchema = z.object({
    url: z
        .string()
        .refine(s => /^(https?|file):\/\//i.test(s), "请提供有效的 URL（支持 http/https/file 协议）")
        .describe("要录制的网页 URL 或本地视频文件路径"),
    duration: z
        .number()
        .int()
        .min(1)
        .max(30)
        .optional()
        .default(5)
        .describe("录制时长（秒），默认 5 秒，最长 30 秒"),
    scrollCount: z
        .number()
        .int()
        .min(0)
        .max(10)
        .optional()
        .default(0)
        .describe("录制期间滚动页面的次数，默认 0 不滚动"),
    timeout: z
        .number()
        .int()
        .min(1000)
        .max(120000)
        .optional()
        .describe("页面加载超时时间（毫秒），默认 30000"),
    savePath: z
        .string()
        .optional()
        .describe("可选，保存视频到指定文件路径（.webm）。不指定则保存到临时目录"),
    fps: z
        .number()
        .min(1)
        .max(10)
        .optional()
        .default(2)
        .describe("本地视频帧提取速率（帧/秒），默认 2"),
});

type RecordVideoInput = z.infer<typeof RecordVideoInputSchema>;

export function registerRecordVideo(server: McpServer): void {
    server.registerTool(
        "web_record_video",
        {
            title: "录制网页/查看视频",
            description: `录制网页短视频片段 或 提取本地视频文件的关键帧。

功能模式:
  1. 网页录制（http/https URL）: 录制 WebM 视频保存到临时文件
  2. 本地视频查看（file:// .mp4/.webm）: 提取关键帧为独立 JPEG 文件序列

参数:
  - url (string, 必须): 网页 URL 或 file:// 本地视频路径
  - duration (number, 可选): 录制时长/提取时长（秒），默认 5，最长 30
  - scrollCount (number, 可选): 录制期间滚动次数，默认 0
  - timeout (number, 可选): 超时毫秒数，默认 30000
  - savePath (string, 可选): 保存路径（.webm），不指定则保存到临时目录
  - fps (number, 可选): 本地视频帧提取速率（帧/秒），默认 2，最高 10

返回:
  - 网页录制: WebM 文件路径
  - 本地视频: 关键帧 JPEG 文件路径列表，用 view_file 逐帧查看理解视频内容`,
            inputSchema: {
                url: RecordVideoInputSchema.shape.url,
                duration: RecordVideoInputSchema.shape.duration,
                scrollCount: RecordVideoInputSchema.shape.scrollCount,
                timeout: RecordVideoInputSchema.shape.timeout,
                savePath: RecordVideoInputSchema.shape.savePath,
                fps: RecordVideoInputSchema.shape.fps,
            },
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: true,
            },
        },
        async (params: RecordVideoInput) => {
            touchActivity();
            const startTime = Date.now();

            // 判断是否为本地视频文件
            if (params.url.startsWith("file://")) {
                const filePath = decodeURIComponent(params.url.replace(/^file:\/\/\/?/, ''));
                const category = categorizeFile(filePath);
                if (category === "video") {
                    return await handleLocalVideo(filePath, params.fps ?? 2, params.duration ?? 5, startTime);
                }
            }

            // 网页录制模式
            return await handleWebRecording(params, startTime);
        }
    );
}

/**
 * 本地视频帧提取：通过浏览器 <video> + canvas 截帧
 */
async function handleLocalVideo(
    filePath: string,
    fps: number,
    maxDuration: number,
    startTime: number,
): Promise<any> {
    if (!fs.existsSync(filePath)) {
        return { isError: true, content: [{ type: "text" as const, text: `视频文件不存在: ${filePath}` }] };
    }

    const ext = path.extname(filePath).toLowerCase();
    // 浏览器只支持 mp4/webm
    if (ext !== ".mp4" && ext !== ".webm") {
        return {
            isError: true,
            content: [{ type: "text" as const, text: `浏览器不支持 ${ext} 格式的视频。支持: .mp4, .webm\n如需查看其他格式，请先用 ffmpeg 转换。` }],
        };
    }

    const videoBuffer = fs.readFileSync(filePath);
    const mime = ext === ".mp4" ? "video/mp4" : "video/webm";
    const videoB64 = videoBuffer.toString("base64");

    console.error(`[web-fetcher] 本地视频帧提取: ${filePath} (${(videoBuffer.length / 1024 / 1024).toFixed(1)}MB), fps=${fps}`);

    let page;
    try {
        // 用主浏览器打开视频
        page = await browserManager.navigateTo("about:blank", { timeout: 5000 });

        // 设置视口为 fast 级大小
        const qConfig = QUALITY_PRESETS["fast"];
        await page.setViewportSize({ width: qConfig.viewportWidth, height: 450 });

        // 注入视频
        await page.setContent(`
            <!DOCTYPE html>
            <html><head><style>
                html, body { margin: 0; padding: 0; background: #000; overflow: hidden; }
                video { width: 100%; height: auto; display: block; }
            </style></head>
            <body>
                <video id="vid" muted preload="auto">
                    <source src="data:${mime};base64,${videoB64}" type="${mime}">
                </video>
                <canvas id="cv" style="display:none;"></canvas>
            </body></html>
        `, { waitUntil: "load" });

        // 等待视频元数据加载
        const videoInfo = await page.evaluate(() => {
            return new Promise<{ duration: number; width: number; height: number }>((resolve, reject) => {
                const vid = document.getElementById("vid") as HTMLVideoElement;
                if (vid.readyState >= 1) {
                    resolve({ duration: vid.duration, width: vid.videoWidth, height: vid.videoHeight });
                } else {
                    vid.onloadedmetadata = () => resolve({ duration: vid.duration, width: vid.videoWidth, height: vid.videoHeight });
                    vid.onerror = () => reject(new Error("视频加载失败"));
                    setTimeout(() => reject(new Error("视频元数据加载超时")), 10000);
                }
            });
        });

        console.error(`[web-fetcher] 视频信息: ${videoInfo.width}x${videoInfo.height}, ${videoInfo.duration.toFixed(1)}s`);

        // 计算要提取的帧
        const actualDuration = Math.min(videoInfo.duration, maxDuration);
        const frameInterval = 1 / fps;
        const frameCount = Math.ceil(actualDuration * fps);
        const maxFrames = 20; // 最多提取20帧

        const framePaths: string[] = [];
        const targetWidth = qConfig.viewportWidth;

        for (let i = 0; i < Math.min(frameCount, maxFrames); i++) {
            const timestamp = i * frameInterval;

            // seek 到指定时间
            const frameData = await page.evaluate(async (args: { t: number; w: number }) => {
                const vid = document.getElementById("vid") as HTMLVideoElement;
                const cv = document.getElementById("cv") as HTMLCanvasElement;

                await new Promise<void>((resolve, _reject) => {
                    vid.currentTime = args.t;
                    vid.onseeked = () => resolve();
                    setTimeout(() => resolve(), 3000); // 超时也继续
                });

                // 计算等比缩放
                const scale = args.w / vid.videoWidth;
                cv.width = args.w;
                cv.height = Math.round(vid.videoHeight * scale);

                const ctx = cv.getContext("2d")!;
                ctx.drawImage(vid, 0, 0, cv.width, cv.height);

                return cv.toDataURL("image/jpeg", 0.65);
            }, { t: timestamp, w: targetWidth });

            if (frameData && frameData.startsWith("data:image")) {
                const jpegB64 = frameData.split(",")[1];
                const jpegBuffer = Buffer.from(jpegB64, "base64");

                // 用 sharp 进一步压缩到 fast 质量
                const compressed = await sharp(jpegBuffer)
                    .jpeg({ quality: qConfig.jpegQuality })
                    .toBuffer();

                const frameKey = generateCacheKey(filePath, "frame", i);
                const framePath = saveTempFile("recordings", frameKey, ".jpg", compressed);
                framePaths.push(framePath);
            }
        }
        const frameList = framePaths.map((p, i) => {
            const t = (i / fps).toFixed(1);
            return `帧 ${i + 1} (${t}s): ${p}`;
        }).join("\n");

        return appendTiming({
            content: [{
                type: "text" as const,
                text: `🎬 视频关键帧提取完成\n文件: ${path.basename(filePath)}\n分辨率: ${videoInfo.width}×${videoInfo.height}\n时长: ${videoInfo.duration.toFixed(1)}s\n提取: ${framePaths.length} 帧 (${fps}fps)\n\n${frameList}\n\n使用 view_file 工具逐帧查看`,
            }],
        }, startTime);
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { isError: true, content: [{ type: "text" as const, text: `视频帧提取失败: ${msg}` }] };
    } finally {
        if (page) await page.close().catch(() => { });
    }
}

/**
 * 网页录制（保留原有 Playwright 录制逻辑，改为默认 file 模式）
 */
async function handleWebRecording(params: RecordVideoInput, startTime: number): Promise<any> {
    const tempDir = path.join(os.tmpdir(), `mcp-video-${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });

    let context: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | null = null;
    let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;

    try {
        const timeout = params.timeout ?? DEFAULT_TIMEOUT;
        const duration = (params.duration ?? 5) * 1000;

        console.error(`[web-fetcher] 开始录制: ${params.url}, 时长 ${duration / 1000}s`);

        browser = await chromium.launch({ headless: true });
        context = await browser.newContext({
            userAgent: DEFAULT_USER_AGENT,
            viewport: { width: 1280, height: 720 }, // 降低分辨率减小文件体积
            locale: "zh-CN",
            timezoneId: "Asia/Shanghai",
            recordVideo: {
                dir: tempDir,
                size: { width: 1280, height: 720 },
            },
        }) as any;

        // 恢复 Cookie
        if (fs.existsSync(COOKIES_BACKUP_FILE)) {
            try {
                const cookieData = fs.readFileSync(COOKIES_BACKUP_FILE, "utf-8");
                const cookies = JSON.parse(cookieData);
                if (Array.isArray(cookies) && cookies.length > 0) {
                    await context!.addCookies(cookies);
                }
            } catch { /* 忽略 */ }
        }

        const page = await context!.newPage();

        await page.goto(params.url, { waitUntil: "domcontentloaded", timeout });
        await page.waitForLoadState("networkidle", { timeout }).catch(() => { });
        await waitForContentStable(page);

        console.error("[web-fetcher] 页面加载完毕，开始录制...");

        // 录制 + 滚动
        if (params.scrollCount && params.scrollCount > 0) {
            const scrollInterval = duration / (params.scrollCount + 1);
            for (let i = 0; i < params.scrollCount; i++) {
                await page.waitForTimeout(scrollInterval);
                await page.evaluate(() =>
                    window.scrollBy({ top: window.innerHeight * 0.8, behavior: "smooth" })
                );
            }
            await page.waitForTimeout(scrollInterval);
        } else {
            await page.waitForTimeout(duration);
        }

        const video = page.video();
        await page.close();

        if (!video) throw new Error("视频录制失败：Playwright 未生成视频");

        const videoPath = await video.path();
        console.error(`[web-fetcher] 视频录制完成: ${videoPath}`);

        await context!.close();
        context = null;
        await browser.close();
        browser = null;

        if (!fs.existsSync(videoPath)) throw new Error(`视频文件不存在: ${videoPath}`);

        const videoBuffer = fs.readFileSync(videoPath);
        const sizeKB = (videoBuffer.length / 1024).toFixed(1);

        // 保存到指定路径或临时目录
        let finalPath: string;
        if (params.savePath) {
            const saveDir = path.dirname(params.savePath);
            if (!fs.existsSync(saveDir)) fs.mkdirSync(saveDir, { recursive: true });
            fs.copyFileSync(videoPath, params.savePath);
            finalPath = params.savePath;
        } else {
            const cacheKey = generateCacheKey(params.url, "recording", params.duration);
            finalPath = saveTempFile("recordings", cacheKey, ".webm", videoBuffer);
        }

        // 清理 Playwright 临时目录
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* 忽略 */ }

        return appendTiming({
            content: [{
                type: "text" as const,
                text: `✅ 视频录制完成 (${sizeKB} KB)\n时长: ${(params.duration ?? 5)}s | 分辨率: 1280×720\n文件: ${finalPath}`,
            }],
        }, startTime);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { isError: true, content: [{ type: "text" as const, text: `视频录制失败: ${message}` }] };
    } finally {
        if (context) {
            try { await context.close(); } catch { /* 忽略 */ }
        }
        if (browser) {
            try { await browser.close(); } catch { /* 忽略 */ }
        }
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
    }
}

/**
 * 简化版内容稳定检测
 */
async function waitForContentStable(page: any): Promise<void> {
    const maxWait = 5000;
    const interval = 500;
    let stableCount = 0;
    let lastCount = 0;
    const start = Date.now();

    try {
        while (Date.now() - start < maxWait) {
            const count = await page.evaluate(() => {
                const els = document.querySelectorAll("img, video, p, h1, h2, h3, span, a, li, article");
                let visible = 0;
                els.forEach((el: Element) => {
                    const r = (el as HTMLElement).getBoundingClientRect();
                    if (r.width > 0 && r.height > 0) visible++;
                });
                return visible;
            });

            if (count === lastCount && count > 0) {
                stableCount++;
                if (stableCount >= 2) break;
            } else {
                stableCount = 0;
            }
            lastCount = count;
            await page.waitForTimeout(interval);
        }
    } catch { /* 忽略 */ }
}
