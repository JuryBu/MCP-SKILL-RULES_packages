import { z } from "zod";
import { browserManager } from "../browser.js";
import { CHARACTER_LIMIT, appendTiming } from "../constants.js";
import { touchActivity } from "../lifecycle.js";
const FetchHtmlInputSchema = z.object({
    url: z
        .string()
        .refine(s => /^(https?|file):\/\//i.test(s), "请提供有效的 URL（支持 http/https/file 协议）")
        .describe("要抓取的网页 URL"),
    selector: z
        .string()
        .optional()
        .describe("可选的 CSS 选择器，只获取指定元素的 HTML"),
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
        .describe("页面滚动次数，用于加载懒加载内容，默认 0 不滚动"),
});
export function registerFetchHtml(server) {
    server.registerTool("web_fetch_html", {
        title: "获取网页 HTML",
        description: `使用带 Cookie 的浏览器获取网页的原始 HTML。
可选只获取指定 CSS 选择器匹配元素的 HTML。
支持 file:// 协议打开本地文件。

参数:
  - url (string, 必须): 要抓取的网页 URL（支持 http/https/file 协议）
  - selector (string, 可选): CSS 选择器，只返回匹配元素的 HTML
  - timeout (number, 可选): 超时毫秒数，默认 30000
  - scrollCount (number, 可选): 滚动次数，用于加载懒加载内容，默认 0

⚠️ 注意: PDF/DOCX/PPTX 等文件经 pdf.js 渲染为 canvas，DOM 中无语义 HTML 元素，selector 参数对这类文件无效。提取 Office 文件文本请用 web_fetch_page。

返回: 原始 HTML 字符串`,
        inputSchema: {
            url: FetchHtmlInputSchema.shape.url,
            selector: FetchHtmlInputSchema.shape.selector,
            timeout: FetchHtmlInputSchema.shape.timeout,
            scrollCount: FetchHtmlInputSchema.shape.scrollCount,
        },
        annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: true,
        },
    }, async (params) => {
        touchActivity();
        const startTime = Date.now();
        let page;
        try {
            page = await browserManager.navigateTo(params.url, {
                waitFor: params.selector,
                timeout: params.timeout,
                scrollCount: params.scrollCount,
            });
            let html;
            if (params.selector) {
                const element = await page.$(params.selector);
                if (!element) {
                    return {
                        isError: true,
                        content: [
                            {
                                type: "text",
                                text: `未找到选择器 "${params.selector}" 匹配的元素`,
                            },
                        ],
                    };
                }
                html = await element.evaluate((el) => el.outerHTML);
            }
            else {
                html = await page.content();
            }
            // 截断过长内容
            if (html.length > CHARACTER_LIMIT) {
                html =
                    html.slice(0, CHARACTER_LIMIT) +
                        `\n<!-- [HTML 已截断，原始长度: ${html.length} 字符] -->`;
            }
            return appendTiming({
                content: [
                    {
                        type: "text",
                        text: html,
                    },
                ],
            }, startTime, browserManager.lastRetryCount);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return {
                isError: true,
                content: [
                    {
                        type: "text",
                        text: `获取 HTML 失败: ${message}`,
                    },
                ],
            };
        }
        finally {
            if (page) {
                await page.close().catch(() => { });
            }
        }
    });
}
//# sourceMappingURL=fetch-html.js.map