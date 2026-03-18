import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { browserManager } from "../browser.js";
import { touchActivity } from "../lifecycle.js";
import { sessionManager } from "../session.js";
import { extractContent } from "../extractor.js";
import { QUALITY_PRESETS, appendTiming } from "../constants.js";
import { saveTempFile, generateCacheKey, splitOversizedImage } from "../temp-store.js";

const InteractInputSchema = z.object({
    sessionId: z
        .string()
        .optional()
        .describe("可选的会话 ID。如不提供，则基于 url 创建新页面；操作完后返回新的 sessionId 以便后续复用"),
    url: z
        .string()
        .refine(s => /^(https?|file):\/\//i.test(s), "请提供有效的 URL（支持 http/https/file 协议）")
        .optional()
        .describe("要打开的 URL（当不使用 sessionId 时必须提供）"),
    action: z.enum(["click", "type", "scroll", "wait", "screenshot", "content", "visible", "find", "close"])
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
        .min(1)
        .max(20)
        .optional()
        .default(3)
        .describe("scroll 操作的滚动次数，默认 3"),
    timeout: z
        .number()
        .int()
        .min(1000)
        .max(120000)
        .optional()
        .describe("超时毫秒数，默认 30000"),
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
  - type: 在指定元素中输入文字
  - scroll: 滚动页面（无 selector 时向下滚动 scrollCount 次；有 selector 时滚动到该元素可见）
  - wait: 等待指定选择器出现
  - screenshot: 对当前页面截图
  - content: 提取正文内容（有 selector 时只提取该区域）
  - visible: 提取当前视口可见的文本（不滚动，只取屏幕上能看到的内容）
  - find: 在页面中搜索文本（需要 value 参数），返回匹配数量和上下文
  - close: 关闭当前会话

使用方式:
  1. 首次调用提供 url，返回 sessionId
  2. 后续调用提供 sessionId 复用同一页面
  3. 操作完毕调用 action="close" 关闭会话

参数:
  - sessionId (string, 可选): 复用会话
  - url (string, 可选): 新页面 URL
  - action (string): click / type / scroll / wait / screenshot / content / close
  - selector (string, 可选): CSS 选择器
  - value (string, 可选): 输入值
  - scrollCount (number, 可选): 滚动次数，默认 3
  - timeout (number, 可选): 超时毫秒数`,
            inputSchema: {
                sessionId: InteractInputSchema.shape.sessionId,
                url: InteractInputSchema.shape.url,
                action: InteractInputSchema.shape.action,
                selector: InteractInputSchema.shape.selector,
                value: InteractInputSchema.shape.value,
                scrollCount: InteractInputSchema.shape.scrollCount,
                timeout: InteractInputSchema.shape.timeout,
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
                let page;

                // 获取或创建页面
                if (sessionId) {
                    page = sessionManager.get(sessionId);
                    if (!page) {
                        return {
                            isError: true,
                            content: [{ type: "text" as const, text: `会话 "${sessionId}" 不存在或已过期` }],
                        };
                    }
                } else if (params.url) {
                    sessionId = await sessionManager.create(params.url, {
                        timeout: params.timeout,
                    });
                    page = sessionManager.get(sessionId)!;
                } else {
                    return {
                        isError: true,
                        content: [{ type: "text" as const, text: "必须提供 sessionId 或 url" }],
                    };
                }

                const timeout = params.timeout ?? 30000;

                switch (params.action) {
                    case "click": {
                        if (!params.selector) {
                            return {
                                isError: true,
                                content: [{ type: "text" as const, text: "click 操作需要提供 selector" }],
                            };
                        }
                        await page.waitForSelector(params.selector, { timeout });
                        await page.click(params.selector);
                        await page.waitForTimeout(1000);
                        // 等待可能的导航或内容加载
                        await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => { });

                        return appendTiming({
                            content: [
                                {
                                    type: "text" as const,
                                    text: `✅ 已点击 "${params.selector}"\n当前 URL: ${page.url()}\nSessionId: ${sessionId}`,
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
                        await page.waitForSelector(params.selector, { timeout });
                        await page.fill(params.selector, params.value);
                        await page.waitForTimeout(500);

                        return appendTiming({
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
                            const el = await page.$(params.selector);
                            if (!el) {
                                return {
                                    isError: true,
                                    content: [{ type: "text" as const, text: `scroll 操作未找到选择器 "${params.selector}"` }],
                                };
                            }
                            await el.scrollIntoViewIfNeeded();
                            await page.waitForTimeout(1000);
                            return appendTiming({
                                content: [
                                    {
                                        type: "text" as const,
                                        text: `✅ 已滚动到 "${params.selector}" 元素位置\nSessionId: ${sessionId}`,
                                    },
                                ],
                            }, startTime);
                        } else {
                            // 无 selector：向下滚动 N 次
                            const count = params.scrollCount ?? 3;
                            await browserManager.scrollPage(page, count);
                            return appendTiming({
                                content: [
                                    {
                                        type: "text" as const,
                                        text: `✅ 已滚动 ${count} 次\n当前 URL: ${page.url()}\nSessionId: ${sessionId}`,
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
                        await page.waitForSelector(params.selector, { timeout });

                        return appendTiming({
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
                        const buffer = await page.screenshot({ type: "jpeg", quality: qConfig.jpegQuality, fullPage: false });
                        const sizeKB = (buffer.length / 1024).toFixed(1);

                        // 自动分片保存
                        const cacheKey = generateCacheKey(page.url(), "interact", Date.now());
                        const splitResult = await splitOversizedImage(buffer, "screenshots", cacheKey, ".jpg");
                        if (splitResult.wasSplit) {
                            const fileList = splitResult.paths.map((p, i) =>
                                `  片 ${i + 1}/${splitResult.paths.length} (${splitResult.sizes[i]} KB): ${p}`
                            ).join("\n");
                            return appendTiming({
                                content: [{
                                    type: "text" as const,
                                    text: `📐 ${splitResult.description}\nSessionId: ${sessionId}\n当前 URL: ${page.url()}\n\n${fileList}\n\n使用 view_file 工具按顺序查看各片`,
                                }],
                            }, startTime);
                        }

                        return appendTiming({
                            content: [{
                                type: "text" as const,
                                text: `📸 截图 (${sizeKB} KB)\nSessionId: ${sessionId}\n当前 URL: ${page.url()}\n文件: ${splitResult.paths[0]}\n\n使用 view_file 工具查看此图片`,
                            }],
                        }, startTime);
                    }

                    case "content": {
                        let resultText: string;
                        if (params.selector) {
                            // 有 selector 时：只提取指定区域的内容
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
                                    // 克隆并清理噪音
                                    const clone = node.cloneNode(true) as HTMLElement;
                                    clone.querySelectorAll("script, style, noscript").forEach(e => e.remove());
                                    return clone.innerText || clone.textContent || "";
                                });
                                if (text.trim().length > 10) {
                                    parts.push(text.trim());
                                }
                            }
                            const pageTitle = await page.title() || "无标题";
                            resultText = `# ${pageTitle}\n\n${parts.join("\n\n---\n\n")}`;
                        } else {
                            // 无 selector：使用完整提取逻辑
                            const html = await page.content();
                            const { content: extractedContent } = extractContent(html, page.url());
                            resultText = extractedContent;
                        }

                        return appendTiming({
                            content: [
                                {
                                    type: "text" as const,
                                    text: `SessionId: ${sessionId}\n\n${resultText}`,
                                },
                            ],
                        }, startTime);
                    }

                    case "visible": {
                        // 提取当前视口可见的文本内容（优化去重）
                        const visibleText = await page.evaluate(() => {
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

                        return appendTiming({
                            content: [
                                {
                                    type: "text" as const,
                                    text: `SessionId: ${sessionId}\n视口可见文本 (${visibleText.length} 字符):\n\n${truncated}`,
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

                        const searchResult = await page.evaluate((keyword: string) => {
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

                        return appendTiming({
                            content: [{
                                type: "text" as const,
                                text: `SessionId: ${sessionId}\n\n${resultText}`,
                            }],
                        }, startTime);
                    }

                    case "close": {
                        await sessionManager.close(sessionId!);
                        return appendTiming({
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
