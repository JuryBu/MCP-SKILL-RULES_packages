import { z } from "zod";
import { browserManager } from "../browser.js";
import { touchActivity } from "../lifecycle.js";
const ListCookiesInputSchema = z.object({
    domain: z
        .string()
        .optional()
        .describe("可选，过滤特定域名的 Cookie（如 'zhihu.com'）"),
});
export function registerListCookies(server) {
    server.registerTool("web_list_cookies", {
        title: "列出浏览器 Cookie",
        description: `列出浏览器中存储的 Cookie 概要信息（不显示实际值）。
用于调试和确认特定网站的登录态是否有效。

参数:
  - domain (string, 可选): 过滤特定域名，如 'zhihu.com'

返回: Cookie 列表，包含域名、名称、过期时间等，隐藏实际值`,
        inputSchema: {
            domain: ListCookiesInputSchema.shape.domain,
        },
        annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
        },
    }, async (params) => {
        touchActivity();
        try {
            const cookies = await browserManager.getCookies(params.domain);
            if (cookies.length === 0) {
                const hint = params.domain
                    ? `域名 "${params.domain}" 下没有找到 Cookie。可能需要先登录该网站。\n使用 web_login_browser 工具打开有头浏览器进行登录。`
                    : "浏览器中没有任何 Cookie。请先使用 web_login_browser 工具登录需要的网站。";
                return {
                    content: [
                        {
                            type: "text",
                            text: hint,
                        },
                    ],
                };
            }
            // 按域名分组
            const grouped = new Map();
            for (const cookie of cookies) {
                const domain = cookie.domain;
                if (!grouped.has(domain)) {
                    grouped.set(domain, []);
                }
                grouped.get(domain).push(cookie);
            }
            let output = `# Cookie 概要\n\n`;
            output += `共找到 ${cookies.length} 个 Cookie`;
            if (params.domain) {
                output += `（域名: ${params.domain}）`;
            }
            output += `\n\n`;
            for (const [domain, domainCookies] of grouped) {
                output += `## ${domain}\n\n`;
                output += `| 名称 | 过期时间 | HttpOnly | Secure | SameSite |\n`;
                output += `|------|----------|----------|--------|----------|\n`;
                for (const c of domainCookies) {
                    const expires = c.expires === -1
                        ? "会话"
                        : new Date(c.expires * 1000).toLocaleString("zh-CN");
                    output += `| ${c.name} | ${expires} | ${c.httpOnly ? "✓" : "✗"} | ${c.secure ? "✓" : "✗"} | ${c.sameSite} |\n`;
                }
                output += `\n`;
            }
            return {
                content: [
                    {
                        type: "text",
                        text: output,
                    },
                ],
            };
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return {
                isError: true,
                content: [
                    {
                        type: "text",
                        text: `获取 Cookie 列表失败: ${message}`,
                    },
                ],
            };
        }
    });
}
//# sourceMappingURL=list-cookies.js.map