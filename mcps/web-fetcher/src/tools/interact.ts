import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { browserManager } from "../browser.js";
import { touchActivity } from "../lifecycle.js";
import { formatPoolPressureHint, sessionManager } from "../session.js";
import { extractContent, safePageEvaluate, safePageContent } from "../extractor.js";
import { QUALITY_PRESETS, appendTiming } from "../constants.js";
import { saveTempFile, generateCacheKey, splitOversizedImage } from "../temp-store.js";
import { buildPageSnapshot } from "./page-snapshot.js";
import * as fs from "fs";

const InteractInputSchema = z.object({
    sessionId: z
        .string()
        .optional()
        .describe("可选的会话 ID。如不提供，则基于 url 创建新页面；操作完后返回新的 sessionId 以便后续复用"),
    ownerId: z
        .string()
        .optional()
        .describe("会话所有者标识。未传时使用 global；访问或关闭已有 sessionId 时会按 owner 校验"),
    url: z
        .string()
        .refine(s => /^(https?|file):\/\//i.test(s), "请提供有效的 URL（支持 http/https/file 协议）")
        .optional()
        .describe("要打开的 URL（当不使用 sessionId 时必须提供）"),
    action: z.enum(["click", "type", "scroll", "wait", "screenshot", "content", "visible", "snapshot", "find", "press", "evaluate", "close"])
        .describe("要执行的操作类型"),
    selector: z
        .string()
        .optional()
        .describe("CSS 选择器，用于 click / type / scroll（滚动到元素）/ content（只提取该区域）操作"),
    value: z
        .string()
        .optional()
        .describe("输入值，用于 type 操作；搜索关键词，用于 find 操作"),
    scrollCount: z
        .number()
        .int()
        .min(-20)
        .max(20)
        .optional()
        .default(3)
        .describe("scroll 操作的滚动次数，默认 3。正数向下滚，负数向上滚（如 -5 表示向上滚5次，用于加载 SPA 页面顶部懒加载内容）"),
    timeout: z
        .number()
        .int()
        .min(1000)
        .max(120000)
        .optional()
        .describe("超时毫秒数，默认 30000"),
    frame: z
        .string()
        .optional()
        .describe("v6.7: iframe 的 CSS 选择器（如 'iframe.cls' 或 'iframe[src*=ide]'），操作将在该 iframe 内部执行。支持嵌套：用 ' >> ' 分隔多层 iframe"),
});

type InteractInput = z.infer<typeof InteractInputSchema>;

export function registerInteract(server: McpServer): void {
    server.registerTool(
        "web_interact",
        {
            title: "页面交互",
            description: `在网页上执行简单交互操作（点击、输入、滚动等），支持会话复用。

操作类型:
  - click: 点击指定 CSS 选择器的元素
  - type: 在指定元素中输入文字（fill模式，会替换原内容）
  - scroll: 滚动页面（无 selector 时向下滚动 scrollCount 次；有 selector 时滚动到该元素可见）
  - wait: 等待指定选择器出现
  - screenshot: 对当前页面截图
  - content: 提取正文内容（有 selector 时只提取该区域）
  - visible: 提取当前视口可见的文本（不滚动，只取屏幕上能看到的内容）
  - snapshot: 一次返回当前视口截图文件、可见文本和 DOM 摘要
  - find: 在页面中搜索文本（需要 value 参数），返回匹配数量和上下文
  - press: v6.8 键盘操作。快捷键用 value="Control+z" 等；增量输入用 value="文字内容"。有 selector 时先点击获取焦点。支持 frame 穿透
  - evaluate: v6.9 在页面上下文中执行 JS。value 为本地 .js 文件路径时自动读取文件内容执行（绕过 AI 输出长度限制）；否则作为内联 JS 直接执行。支持 async/await，返回 evaluate 结果。支持 frame 穿透
  - close: 关闭当前会话

使用方式:
  1. 首次调用提供 url，返回 sessionId
  2. 后续调用提供 sessionId 复用同一页面
  3. 操作完毕调用 action="close" 关闭会话

参数:
  - sessionId (string, 可选): 复用会话
  - ownerId (string, 可选): 会话所有者标识，未传兼容 global
  - url (string, 可选): 新页面 URL
  - action (string): click / type / scroll / wait / screenshot / content / visible / snapshot / find / press / evaluate / close
  - selector (string, 可选): CSS 选择器
  - value (string, 可选): 输入值
  - scrollCount (number, 可选): 滚动次数，默认 3
  - timeout (number, 可选): 超时毫秒数
   - frame (string, 可选): iframe CSS 选择器，操作在 iframe 内执行`,
            inputSchema: {
                sessionId: InteractInputSchema.shape.sessionId,
                ownerId: InteractInputSchema.shape.ownerId,
                url: InteractInputSchema.shape.url,
                action: InteractInputSchema.shape.action,
                selector: InteractInputSchema.shape.selector,
                value: InteractInputSchema.shape.value,
                scrollCount: InteractInputSchema.shape.scrollCount,
                timeout: InteractInputSchema.shape.timeout,
                frame: InteractInputSchema.shape.frame,
            },
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: false,
                openWorldHint: true,
            },
        },
        async (params: InteractInput) => {
            touchActivity();
            const startTime = Date.now();
            try {
                let sessionId = params.sessionId;
                const ownerId = params.ownerId;
                let page;

                // 获取或创建页面
                if (sessionId) {
                    page = sessionManager.get(sessionId, ownerId);
                    if (!page) {
                        return {
                            isError: true,
                            content: [{ type: "text" as const, text: `会话 "${sessionId}" 不存在、已过期或 ownerId 不匹配` }],
                        };
                    }
                } else if (params.url) {
                    sessionId = await sessionManager.create(params.url, {
                        timeout: params.timeout,
                        ownerId,
                    });
                    page = sessionManager.get(sessionId, ownerId)!;
                } else {
                    return {
                        isError: true,
                        content: [{ type: "text" as const, text: "必须提供 sessionId 或 url" }],
                    };
                }

                const timeout = params.timeout ?? 30000;
                const finalize = (
                    result: { content?: Array<{ type: "text"; text: string }>; isError?: boolean },
                    _startTime?: number,
                    retryCount?: number,
                ) => {
                    const hint = formatPoolPressureHint(ownerId);
                    if (hint && Array.isArray(result.content)) {
                        const content = [...result.content];
                        for (let i = content.length - 1; i >= 0; i--) {
                            if (content[i]?.type === "text" && typeof content[i].text === "string") {
                                content[i] = { ...content[i], text: `${content[i].text}\n${hint}` };
                                return appendTiming({ ...result, content }, startTime, retryCount);
                            }
                        }
                    }
                    return appendTiming(result, startTime, retryCount);
                };

                // v6.7: iframe 穿透 — 解析 frame 参数
                let frameLocator: import('playwright').FrameLocator | null = null;
                let frameObj: import('playwright').Frame | null = null;
                if (params.frame) {
                    // 支持嵌套 iframe：用 ' >> ' 分隔
                    const frameSelectors = params.frame.split(' >> ').map(s => s.trim());
                    let fl = page.frameLocator(frameSelectors[0]);
                    for (let i = 1; i < frameSelectors.length; i++) {
                        fl = fl.frameLocator(frameSelectors[i]);
                    }
                    frameLocator = fl;

                    // 同时获取 Frame 对象（用于 content/visible/find 等 evaluate 操作）
                    const iframeSrc = await page.$eval(frameSelectors[0], (el: Element) => (el as HTMLIFrameElement).src).catch(() => '');
                    if (iframeSrc) {
                        frameObj = page.frame({ url: new RegExp(iframeSrc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').slice(0, 100)) }) ?? null;
                    }
                    // 如果通过 src 找不到，尝试用 name
                    if (!frameObj) {
                        const iframeName = await page.$eval(frameSelectors[0], (el: Element) => (el as HTMLIFrameElement).name).catch(() => '');
                        if (iframeName) frameObj = page.frame(iframeName);
                    }
                    console.error(`[web-fetcher] 🖼️ iframe 穿透: frameLocator=${!!frameLocator}, frameObj=${!!frameObj}`);
                }

                switch (params.action) {
                    case "click": {
                        if (!params.selector) {
                            return {
                                isError: true,
                                content: [{ type: "text" as const, text: "click 操作需要提供 selector" }],
                            };
                        }
                        // v6.7: iframe 穿透 click
                        if (frameLocator) {
                            const loc = frameLocator.locator(params.selector);
                            await loc.waitFor({ timeout });
                        } else {
                            // v6.6: waitForSelector 失败时检测 iframe
                            try {
                                await page.waitForSelector(params.selector, { timeout });
                            } catch (selectorErr) {
                                const iframes = await page.$$eval('iframe[src]', (frames: Element[]) =>
                                    frames.map(f => ({ src: (f as HTMLIFrameElement).src, sel: f.className ? `iframe.${f.className.split(' ')[0]}` : (f.id ? `iframe#${f.id}` : 'iframe') }))
                                        .filter(f => f.src && !f.src.startsWith('about:'))
                                ).catch(() => [] as { src: string; sel: string }[]);
                                let errMsg = `click: 未找到 "${params.selector}"（超时 ${timeout}ms）`;
                                if (iframes.length > 0) {
                                    errMsg += `\n⚠️ 页面包含 ${iframes.length} 个 iframe：`;
                                    iframes.forEach((f, i) => { errMsg += `\n  ${i + 1}. ${f.sel} → ${f.src}`; });
                                    errMsg += `\n💡 添加 frame="${iframes[0].sel}" 参数即可在 iframe 内操作`;
                                }
                                return { isError: true, content: [{ type: "text" as const, text: errMsg }] };
                            }
                        }

                        // v6.5: 在点击前注册 download 和 popup 事件监听
                        let downloadFile: string | null = null;
                        let popupUrl: string | null = null;
                        let popupSessionId: string | null = null;

                        const downloadPromise = page.waitForEvent('download', { timeout: 8000 })
                            .then(async (dl) => {
                                const { DOWNLOADS_DIR } = await import('../constants.js');
                                const fs = await import('fs');
                                fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
                                const savePath = `${DOWNLOADS_DIR}/${dl.suggestedFilename()}`;
                                await dl.saveAs(savePath);
                                downloadFile = savePath;
                                console.error(`[web-fetcher] 📥 文件已下载: ${savePath}`);
                            })
                            .catch(() => { });

                        const popupPromise = page.waitForEvent('popup', { timeout: 5000 })
                            .then(async (popup) => {
                                await popup.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => { });
                                popupUrl = popup.url();
                                // v6.6: 将 popup 注册为新 session，不再 close
                                popupSessionId = sessionManager.registerPage(popup, ownerId);
                                console.error(`[web-fetcher] 🔗 新窗口 → ${popupSessionId}: ${popupUrl}`);
                            })
                            .catch(() => { });

                        // v6.7: frame-aware click
                        if (frameLocator) {
                            await frameLocator.locator(params.selector).click({ timeout });
                        } else {
                            await page.click(params.selector);
                        }
                        await Promise.all([downloadPromise, popupPromise]);
                        await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => { });

                        // 构建响应
                        let resultText = `✅ 已点击 "${params.selector}"\n当前 URL: ${page.url()}\nSessionId: ${sessionId}`;
                        if (downloadFile) resultText += `\n📥 文件已下载: ${downloadFile}`;
                        if (popupUrl) resultText += `\n🔗 新窗口已打开: ${popupUrl}`;
                        if (popupSessionId) resultText += `\n🆕 可用 sessionId="${popupSessionId}" 继续操作新窗口`;

                        return finalize({
                            content: [
                                {
                                    type: "text" as const,
                                    text: resultText,
                                },
                            ],
                        }, startTime);
                    }

                    case "type": {
                        if (!params.selector || !params.value) {
                            return {
                                isError: true,
                                content: [{ type: "text" as const, text: "type 操作需要提供 selector 和 value" }],
                            };
                        }
                        // v6.7: frame-aware type
                        if (frameLocator) {
                            const loc = frameLocator.locator(params.selector);
                            await loc.waitFor({ timeout });
                            await loc.fill(params.value);
                        } else {
                            await page.waitForSelector(params.selector, { timeout });
                            await page.fill(params.selector, params.value);
                        }
                        await page.waitForTimeout(500);

                        return finalize({
                            content: [
                                {
                                    type: "text" as const,
                                    text: `✅ 已在 "${params.selector}" 中输入 "${params.value}"\nSessionId: ${sessionId}`,
                                },
                            ],
                        }, startTime);
                    }

                    case "scroll": {
                        if (params.selector) {
                            // 有 selector：滚动到指定元素可见
                            // v6.7: frame-aware scroll to element
                            if (frameLocator) {
                                await frameLocator.locator(params.selector).scrollIntoViewIfNeeded();
                            } else {
                                const el = await page.$(params.selector);
                                if (!el) {
                                    return {
                                        isError: true,
                                        content: [{ type: "text" as const, text: `scroll 操作未找到选择器 "${params.selector}"` }],
                                    };
                                }
                                await el.scrollIntoViewIfNeeded();
                            }
                            await page.waitForTimeout(1000);
                            return finalize({
                                content: [
                                    {
                                        type: "text" as const,
                                        text: `✅ 已滚动到 "${params.selector}" 元素位置\nSessionId: ${sessionId}`,
                                    },
                                ],
                            }, startTime);
                        } else {
                            // 无 selector：滚动 N 次（正=向下，负=向上）
                            const raw = params.scrollCount ?? 3;
                            const count = Math.abs(raw);
                            const dir: 'up' | 'down' = raw < 0 ? 'up' : 'down';
                            await browserManager.scrollPage(page, count, dir);
                            return finalize({
                                content: [
                                    {
                                        type: "text" as const,
                                        text: `✅ 已${dir === 'up' ? '向上' : '向下'}滚动 ${count} 次\n当前 URL: ${page.url()}\nSessionId: ${sessionId}`,
                                    },
                                ],
                            }, startTime);
                        }
                    }

                    case "wait": {
                        if (!params.selector) {
                            return {
                                isError: true,
                                content: [{ type: "text" as const, text: "wait 操作需要提供 selector" }],
                            };
                        }
                        // v6.7: frame-aware wait
                        if (frameLocator) {
                            await frameLocator.locator(params.selector).waitFor({ timeout });
                        } else {
                            await page.waitForSelector(params.selector, { timeout });
                        }

                        return finalize({
                            content: [
                                {
                                    type: "text" as const,
                                    text: `✅ 选择器 "${params.selector}" 已出现\nSessionId: ${sessionId}`,
                                },
                            ],
                        }, startTime);
                    }

                    case "screenshot": {
                        const qConfig = QUALITY_PRESETS["default"];
                        await browserManager.waitForVisualReady(page);
                        // v6.7: frame-aware screenshot
                        let buffer: Buffer;
                        if (params.frame) {
                            buffer = await page.locator(params.frame.split(' >> ')[0]).screenshot({ type: "jpeg", quality: qConfig.jpegQuality });
                        } else {
                            buffer = await page.screenshot({ type: "jpeg", quality: qConfig.jpegQuality, fullPage: false });
                        }
                        const sizeKB = (buffer.length / 1024).toFixed(1);

                        // 自动分片保存
                        const cacheKey = generateCacheKey(page.url(), "interact", Date.now());
                        const splitResult = await splitOversizedImage(buffer, "screenshots", cacheKey, ".jpg");
                        if (splitResult.wasSplit) {
                            const fileList = splitResult.paths.map((p, i) =>
                                `  片 ${i + 1}/${splitResult.paths.length} (${splitResult.sizes[i]} KB): ${p}`
                            ).join("\n");
                            return finalize({
                                content: [{
                                    type: "text" as const,
                                    text: `📐 ${splitResult.description}\nSessionId: ${sessionId}\n当前 URL: ${page.url()}\n\n${fileList}\n\n使用 view_file 工具按顺序查看各片`,
                                }],
                            }, startTime);
                        }

                        return finalize({
                            content: [{
                                type: "text" as const,
                                text: `📸 截图 (${sizeKB} KB)\nSessionId: ${sessionId}\n当前 URL: ${page.url()}\n文件: ${splitResult.paths[0]}\n\n使用 view_file 工具查看此图片`,
                            }],
                        }, startTime);
                    }

                    case "content": {
                        let resultText: string;
                        // v6.7: frame-aware content
                        if (frameLocator && params.selector) {
                            const count = await frameLocator.locator(params.selector).count();
                            const parts: string[] = [];
                            for (let i = 0; i < count; i++) {
                                const text = await frameLocator.locator(params.selector).nth(i).innerText().catch(() => '');
                                if (text.trim().length > 10) parts.push(text.trim());
                            }
                            resultText = parts.join("\n\n---\n\n");
                        } else if (frameObj && !params.selector) {
                            const html = await frameObj.content();
                            const { content: extractedContent } = extractContent(html, frameObj.url());
                            resultText = extractedContent;
                        } else if (params.selector) {
                            const elements = await page.$$(params.selector);
                            if (elements.length === 0) {
                                return {
                                    isError: true,
                                    content: [{ type: "text" as const, text: `content 操作未找到选择器 "${params.selector}" 匹配的元素` }],
                                };
                            }
                            const parts: string[] = [];
                            for (const el of elements) {
                                const text = await el.evaluate((node: Element) => {
                                    const clone = node.cloneNode(true) as HTMLElement;
                                    clone.querySelectorAll("script, style, noscript").forEach(e => e.remove());
                                    return clone.innerText || clone.textContent || "";
                                });
                                if (text.trim().length > 10) parts.push(text.trim());
                            }
                            const pageTitle = await page.title() || "无标题";
                            resultText = `# ${pageTitle}\n\n${parts.join("\n\n---\n\n")}`;
                        } else {
                            const html = await safePageContent(page);
                            const { content: extractedContent } = extractContent(html, page.url());
                            resultText = extractedContent;
                        }

                        return finalize({
                            content: [
                                {
                                    type: "text" as const,
                                    text: `SessionId: ${sessionId}\n\n${resultText}`,
                                },
                            ],
                        }, startTime);
                    }

                    case "visible": {
                        // v6.7: frame-aware visible
                        const evalTarget = frameObj || page;
                        const visibleText = await safePageEvaluate(evalTarget as any, () => {
                            const vh = window.innerHeight;
                            const vw = window.innerWidth;

                            // 用 TreeWalker 遍历文本节点，只取叶子层级内容
                            const walker = document.createTreeWalker(
                                document.body,
                                NodeFilter.SHOW_TEXT,
                                {
                                    acceptNode(node) {
                                        const parent = node.parentElement;
                                        if (!parent) return NodeFilter.FILTER_REJECT;
                                        const tag = parent.tagName;
                                        if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT") {
                                            return NodeFilter.FILTER_REJECT;
                                        }
                                        // 检查是否在视口内
                                        const rect = parent.getBoundingClientRect();
                                        if (
                                            rect.top < vh && rect.bottom > 0 &&
                                            rect.left < vw && rect.right > 0 &&
                                            rect.width > 0 && rect.height > 0
                                        ) {
                                            return NodeFilter.FILTER_ACCEPT;
                                        }
                                        return NodeFilter.FILTER_REJECT;
                                    },
                                }
                            );

                            const lines: string[] = [];
                            const seen = new Set<string>();
                            let node;
                            while ((node = walker.nextNode())) {
                                const text = (node.textContent || "").trim();
                                if (text.length > 2 && !seen.has(text)) {
                                    seen.add(text);
                                    lines.push(text);
                                }
                            }
                            return lines.join("\n");
                        });

                        const truncated = visibleText.length > 10000
                            ? visibleText.slice(0, 10000) + "\n\n---\n*[内容已截断]*"
                            : visibleText;

                        return finalize({
                            content: [
                                {
                                    type: "text" as const,
                                    text: `SessionId: ${sessionId}\n视口可见文本 (${visibleText.length} 字符):\n\n${truncated}`,
                                },
                            ],
                        }, startTime);
                    }

                    case "snapshot": {
                        const snapshot = await buildPageSnapshot(page, { sessionId });
                        return finalize({
                            content: [
                                {
                                    type: "text" as const,
                                    text: snapshot,
                                },
                            ],
                        }, startTime);
                    }

                    case "find": {
                        if (!params.value) {
                            return {
                                isError: true,
                                content: [{ type: "text" as const, text: "find 操作需要 value 参数（搜索关键词）" }],
                            };
                        }

                        const searchResult = await safePageEvaluate(page, (keyword: string) => {
                            const body = document.body;
                            const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, null);
                            const matches: Array<{ text: string; context: string }> = [];
                            const keywordLower = keyword.toLowerCase();

                            let node: Node | null;
                            while ((node = walker.nextNode())) {
                                const text = node.textContent || '';
                                if (text.toLowerCase().includes(keywordLower)) {
                                    // 获取上下文
                                    const parent = node.parentElement;
                                    const contextText = parent?.textContent?.trim().slice(0, 200) || text.slice(0, 200);
                                    matches.push({ text: text.trim().slice(0, 100), context: contextText });

                                    // 滚动到第一个匹配
                                    if (matches.length === 1 && parent) {
                                        parent.scrollIntoView({ behavior: 'smooth', block: 'center' });
                                        parent.style.outline = '3px solid #ff6b35';
                                        parent.style.backgroundColor = 'rgba(255, 107, 53, 0.15)';
                                    }
                                }
                            }

                            return { total: matches.length, matches: matches.slice(0, 10) };
                        }, params.value);

                        let resultText = `🔍 搜索 "${params.value}"\n匹配: ${searchResult.total} 处\n`;
                        if (searchResult.matches.length > 0) {
                            resultText += '\n';
                            searchResult.matches.forEach((m, i) => {
                                resultText += `${i + 1}. ${m.context}\n`;
                            });
                            if (searchResult.total > 10) {
                                resultText += `\n...(省略 ${searchResult.total - 10} 处)`;
                            }
                            resultText += `\n已定位到第 1 处匹配`;
                        }

                        return finalize({
                            content: [{
                                type: "text" as const,
                                text: `SessionId: ${sessionId}\n\n${resultText}`,
                            }],
                        }, startTime);
                    }

                    case "press": {
                        // v6.8: keyboard.type() 增量输入 + keyboard.press() 快捷键
                        if (!params.value) {
                            return {
                                isError: true,
                                content: [{ type: "text" as const, text: "press 操作需要 value 参数（键名如 'Control+z' 或要输入的文字）" }],
                            };
                        }

                        // 有 selector 时先点击获取焦点
                        if (params.selector) {
                            if (frameLocator) {
                                await frameLocator.locator(params.selector).click({ timeout });
                            } else {
                                await page.click(params.selector, { timeout });
                            }
                            await page.waitForTimeout(200);
                        }

                        const val = params.value;
                        // 检测是否为快捷键（含修饰键前缀或单独功能键）
                        const MODIFIER_RE = /^(Control|Alt|Shift|Meta)\+/;
                        const FUNC_KEYS = ['Enter', 'Escape', 'Tab', 'Backspace', 'Delete',
                            'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
                            'Home', 'End', 'PageUp', 'PageDown', 'F1', 'F2', 'F3', 'F4',
                            'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12'];
                        const isShortcut = MODIFIER_RE.test(val) || FUNC_KEYS.includes(val);

                        if (isShortcut) {
                            // keyboard.press() 发送快捷键
                            await page.keyboard.press(val);
                            await page.waitForTimeout(300);
                            return finalize({
                                content: [{
                                    type: "text" as const,
                                    text: `⌨️ 已按下快捷键: ${val}\nSessionId: ${sessionId}`,
                                }],
                            }, startTime);
                        } else {
                            // keyboard.type() 逐字符增量输入
                            await page.keyboard.type(val, { delay: 30 });
                            await page.waitForTimeout(200);
                            return finalize({
                                content: [{
                                    type: "text" as const,
                                    text: `⌨️ 已增量输入 ${val.length} 字符\nSessionId: ${sessionId}`,
                                }],
                            }, startTime);
                        }
                    }

                    case "evaluate": {
                        // v6.9: 在页面上下文中执行 JS（支持文件路径或内联代码）
                        if (!params.value) {
                            return {
                                isError: true,
                                content: [{ type: "text" as const, text: "evaluate 需要 value 参数（JS 文件路径或内联代码）" }],
                            };
                        }

                        let jsCode = params.value;
                        let source = "inline";

                        // 自动检测文件路径：以 .js/.mjs/.cjs 结尾，或包含路径分隔符且文件存在
                        const looksLikePath = /\.(js|mjs|cjs)$/i.test(params.value) ||
                            /^[A-Z]:[\\\/]/i.test(params.value) ||
                            params.value.startsWith('/');
                        if (looksLikePath) {
                            try {
                                jsCode = fs.readFileSync(params.value, 'utf-8');
                                source = `file:${params.value} (${jsCode.length} chars)`;
                            } catch (e) {
                                return {
                                    isError: true,
                                    content: [{ type: "text" as const, text: `无法读取 JS 文件: ${params.value}\n${e}` }],
                                };
                            }
                        }

                        console.error(`[web-fetcher] evaluate: source=${source}, code length=${jsCode.length}`);

                        try {
                            // evaluate 始终在 page 级别执行（绕过 frameLocator 限制）
                            const result = await page.evaluate(jsCode);

                            // 序列化结果
                            const resultStr = result === undefined ? "(undefined)"
                                : result === null ? "(null)"
                                    : typeof result === 'string' ? result
                                        : JSON.stringify(result, null, 2);

                            return finalize({
                                content: [{
                                    type: "text" as const,
                                    text: `🔧 evaluate 完成 [${source}]\nSessionId: ${sessionId}\n\n${resultStr}`,
                                }],
                            }, startTime);
                        } catch (evalError) {
                            const msg = evalError instanceof Error ? evalError.message : String(evalError);
                            return finalize({
                                isError: true,
                                content: [{
                                    type: "text" as const,
                                    text: `evaluate 执行失败 [${source}]:\n${msg}\nSessionId: ${sessionId}`,
                                }],
                            }, startTime);
                        }
                    }

                    case "close": {
                        const closed = await sessionManager.close(sessionId!, ownerId);
                        if (!closed) {
                            return finalize({
                                isError: true,
                                content: [
                                    {
                                        type: "text" as const,
                                        text: `会话 "${sessionId}" 不存在、已过期或 ownerId 不匹配`,
                                    },
                                ],
                            }, startTime);
                        }
                        return finalize({
                            content: [
                                {
                                    type: "text" as const,
                                    text: `✅ 会话 "${sessionId}" 已关闭`,
                                },
                            ],
                        }, startTime);
                    }

                    default:
                        return {
                            isError: true,
                            content: [{ type: "text" as const, text: `不支持的操作: ${params.action}` }],
                        };
                }
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                return {
                    isError: true,
                    content: [{ type: "text" as const, text: `交互操作失败: ${message}` }],
                };
            }
        }
    );
}
