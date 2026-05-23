import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { browserManager } from "../browser.js";
import { touchActivity } from "../lifecycle.js";
import { appendTiming } from "../constants.js";

const ExtractLinksInputSchema = z.object({
    url: z
        .string()
        .refine(s => /^(https?|file):\/\//i.test(s), "请提供有效的 URL（支持 http/https/file 协议）")
        .describe("要提取链接的网页 URL"),
    selector: z
        .string()
        .optional()
        .describe("可选的 CSS 选择器，只从指定区域提取链接"),
    timeout: z
        .number()
        .int()
        .min(1000)
        .max(120000)
        .optional()
        .describe("页面加载超时时间（毫秒），默认 30000"),
    scrollCount: z
        .number()
        .int()
        .min(0)
        .max(20)
        .optional()
        .describe("提取前页面滚动次数，默认 0"),
});

type ExtractLinksInput = z.infer<typeof ExtractLinksInputSchema>;

export function registerExtractLinks(server: McpServer): void {
    server.registerTool(
        "web_extract_links",
        {
            title: "提取页面链接",
            description: `提取网页中的所有链接（<a href>），返回结构化的链接列表。
方便 AI 进行链式跳转和内容探索。

参数:
  - url (string, 必须): 要提取链接的网页 URL（支持 http/https/file 协议）
  - selector (string, 可选): CSS 选择器，只从指定区域提取
  - timeout (number, 可选): 超时毫秒数，默认 30000
  - scrollCount (number, 可选): 提取前滚动次数，默认 0

返回: 链接列表（文本 + URL），按出现顺序排列`,
            inputSchema: {
                url: ExtractLinksInputSchema.shape.url,
                selector: ExtractLinksInputSchema.shape.selector,
                timeout: ExtractLinksInputSchema.shape.timeout,
                scrollCount: ExtractLinksInputSchema.shape.scrollCount,
            },
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: true,
            },
        },
        async (params: ExtractLinksInput) => {
            touchActivity();
            const startTime = Date.now();
            let page;
            try {
                page = await browserManager.navigateTo(params.url, {
                    waitFor: params.selector,
                    timeout: params.timeout,
                    scrollCount: params.scrollCount,
                });

                // 在指定范围内或全页面提取链接
                const links = await page.evaluate((selector?: string) => {
                    const container = selector
                        ? document.querySelector(selector) || document.body
                        : document.body;

                    const anchors = container.querySelectorAll("a[href]");
                    const result: Array<{ text: string; href: string }> = [];
                    const seen = new Set<string>();

                    for (const a of anchors) {
                        const href = (a as HTMLAnchorElement).href;
                        const text = (a as HTMLElement).innerText?.trim() || "";

                        // 跳过空链接、锚点链接、javascript:
                        if (!href || href.startsWith("javascript:") || href === "#") continue;
                        // 去重
                        if (seen.has(href)) continue;
                        seen.add(href);

                        result.push({ text: text.slice(0, 200), href });
                    }

                    return result;
                }, params.selector);

                if (links.length === 0) {
                    return {
                        content: [
                            {
                                type: "text" as const,
                                text: "未找到任何链接。",
                            },
                        ],
                    };
                }

                // 格式化为 Markdown 表格
                let output = `# 页面链接提取结果\n\n`;
                output += `共找到 ${links.length} 个链接\n\n`;
                output += `| # | 文本 | URL |\n`;
                output += `|---|------|-----|\n`;

                for (let i = 0; i < links.length; i++) {
                    const text = links[i].text.replace(/\|/g, "\\|").replace(/\n/g, " ");
                    const href = links[i].href.replace(/\|/g, "\\|");
                    output += `| ${i + 1} | ${text || "(无文本)"} | ${href} |\n`;
                }

                return appendTiming({
                    content: [
                        {
                            type: "text" as const,
                            text: output,
                        },
                    ],
                }, startTime, browserManager.lastRetryCount);
            } catch (error) {
                const message =
                    error instanceof Error ? error.message : String(error);
                return {
                    isError: true,
                    content: [
                        {
                            type: "text" as const,
                            text: `提取链接失败: ${message}`,
                        },
                    ],
                };
            } finally {
                if (page) {
                    await page.close().catch(() => { });
                }
            }
        }
    );
}
