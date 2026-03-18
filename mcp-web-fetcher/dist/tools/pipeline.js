import { z } from "zod";
import { browserManager } from "../browser.js";
import { touchActivity } from "../lifecycle.js";
import { sessionManager } from "../session.js";
import { extractContent, compactContent } from "../extractor.js";
import { QUALITY_PRESETS, appendTiming } from "../constants.js";
import { generateCacheKey, splitOversizedImage } from "../temp-store.js";
// 单步 action schema
const PipelineStepSchema = z.object({
    action: z.enum([
        "screenshot", "scroll", "content", "visible",
        "click", "type", "wait", "links", "find",
    ]).describe("操作类型"),
    selector: z
        .string()
        .optional()
        .describe("CSS 选择器（click/type/scroll/wait/content 用）"),
    value: z
        .string()
        .optional()
        .describe("输入值（type 用）"),
    scrollCount: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe("scroll 滚动次数（无 selector 时），默认 3"),
    waitMs: z
        .number()
        .int()
        .min(0)
        .max(30000)
        .optional()
        .describe("此步执行完后等待的毫秒数"),
    fullPage: z
        .boolean()
        .optional()
        .describe("screenshot 时是否截全页，默认 false"),
});
const PipelineInputSchema = z.object({
    url: z
        .string()
        .refine(s => /^(https?|file):\/\//i.test(s), "请提供有效的 URL（支持 http/https/file 协议）")
        .describe("要操作的网页 URL"),
    timeout: z
        .number()
        .int()
        .min(1000)
        .max(120000)
        .optional()
        .describe("页面加载超时时间（毫秒），默认 30000"),
    keepSession: z
        .boolean()
        .optional()
        .default(false)
        .describe("pipeline 完成后是否保留会话（返回 sessionId 供后续 web_interact 使用），默认 false"),
    steps: z
        .array(PipelineStepSchema)
        .min(1)
        .max(20)
        .describe("要按顺序执行的操作列表（最多 20 步）"),
    compact: z
        .enum(["full", "compact", "minimal", "headings"])
        .optional()
        .describe("文本压缩模式: full(完整)/compact(8000字)/minimal(3000字)/headings(纯标题)，默认 compact"),
});
export function registerPipeline(server) {
    server.registerTool("web_pipeline", {
        title: "批量管道操作",
        description: `一次调用按顺序执行多个网页操作，减少往返次数。
支持截图、滚动、文本提取、点击、输入等所有操作。

每步 action 类型:
  - screenshot: 截图（可选 fullPage）
  - scroll: 滚动（有 selector 时滚动到元素；无则向下滚动 scrollCount 次）
  - content: 提取文本（有 selector 时只提取该区域）
  - visible: 提取当前视口可见文本
  - click: 点击元素（需要 selector）
  - type: 输入文本（需要 selector + value）
  - wait: 等待元素出现（需要 selector）或纯等待（用 waitMs）
  - links: 提取页面链接列表
  - find: 在页面中搜索文本（需要 value），返回匹配数量和上下文

每步可选 waitMs 参数，执行完后额外等待指定毫秒。

参数:
  - url (string, 必须): 目标网页 URL（支持 http/https/file 协议）
  - timeout (number, 可选): 页面加载超时，默认 30000
  - keepSession (boolean, 可选): 完成后是否保留会话，默认 false
  - steps (array, 必须): 操作步骤列表，最多 20 步

返回: 所有步骤的结果按顺序排列（文本/截图混合）
如果某步失败，返回已完成的结果 + 错误信息`,
        inputSchema: {
            url: PipelineInputSchema.shape.url,
            timeout: PipelineInputSchema.shape.timeout,
            keepSession: PipelineInputSchema.shape.keepSession,
            compact: PipelineInputSchema.shape.compact,
            steps: PipelineInputSchema.shape.steps,
        },
        annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: true,
        },
    }, async (params) => {
        touchActivity();
        const startTime = Date.now();
        const timeout = params.timeout ?? 30000;
        const results = [];
        let sessionId = null;
        let page = null;
        try {
            // 创建会话
            sessionId = await sessionManager.create(params.url, { timeout });
            page = sessionManager.get(sessionId);
            if (!page) {
                return {
                    isError: true,
                    content: [{ type: "text", text: "无法创建页面会话" }],
                };
            }
            results.push({
                type: "text",
                text: `🚀 Pipeline 开始 (${params.steps.length} 步)\nURL: ${params.url}\nSessionId: ${sessionId}`,
            });
            // 逐步执行
            for (let i = 0; i < params.steps.length; i++) {
                touchActivity(); // 每步刷新活动时间，防止心跳误判
                const step = params.steps[i];
                const stepLabel = `[${i + 1}/${params.steps.length}]`;
                try {
                    switch (step.action) {
                        case "screenshot": {
                            const qConfig = QUALITY_PRESETS["default"];
                            let buf = await page.screenshot({
                                type: "jpeg",
                                quality: qConfig.jpegQuality,
                                fullPage: step.fullPage ?? false,
                            });
                            // 重试机制
                            if (buf.length < 5 * 1024) {
                                await page.waitForTimeout(3000);
                                buf = await page.screenshot({
                                    type: "jpeg",
                                    quality: qConfig.jpegQuality,
                                    fullPage: step.fullPage ?? false,
                                });
                            }
                            const sizeKB = (buf.length / 1024).toFixed(1);
                            // 自动分片保存
                            const cacheKey = generateCacheKey(params.url, "pipeline", i, step.fullPage);
                            const splitResult = await splitOversizedImage(buf, "screenshots", cacheKey, ".jpg");
                            if (splitResult.wasSplit) {
                                const fileList = splitResult.paths.map((p, idx) => `    片 ${idx + 1}/${splitResult.paths.length} (${splitResult.sizes[idx]} KB): ${p}`).join("\n");
                                results.push({
                                    type: "text",
                                    text: `${stepLabel} 📐 ${splitResult.description}\n${fileList}`,
                                });
                            }
                            else {
                                results.push({
                                    type: "text",
                                    text: `${stepLabel} 📸 截图 (${sizeKB} KB) → ${splitResult.paths[0]}`,
                                });
                            }
                            break;
                        }
                        case "scroll": {
                            if (step.selector) {
                                const el = await page.$(step.selector);
                                if (!el) {
                                    results.push({
                                        type: "text",
                                        text: `${stepLabel} ⚠️ scroll: 未找到 "${step.selector}"，跳过`,
                                    });
                                    break;
                                }
                                await el.scrollIntoViewIfNeeded();
                                await page.waitForTimeout(1000);
                                results.push({
                                    type: "text",
                                    text: `${stepLabel} ↕️ 已滚动到 "${step.selector}"`,
                                });
                            }
                            else {
                                const count = step.scrollCount ?? 3;
                                await browserManager.scrollPage(page, count);
                                results.push({
                                    type: "text",
                                    text: `${stepLabel} ↕️ 已向下滚动 ${count} 次`,
                                });
                            }
                            break;
                        }
                        case "content": {
                            let contentText;
                            if (step.selector) {
                                const elements = await page.$$(step.selector);
                                if (elements.length === 0) {
                                    results.push({
                                        type: "text",
                                        text: `${stepLabel} ⚠️ content: 未找到 "${step.selector}"`,
                                    });
                                    break;
                                }
                                const parts = [];
                                for (const el of elements) {
                                    const text = await el.evaluate((node) => {
                                        const clone = node.cloneNode(true);
                                        clone.querySelectorAll("script, style, noscript").forEach(e => e.remove());
                                        return clone.innerText || clone.textContent || "";
                                    });
                                    if (text.trim().length > 10)
                                        parts.push(text.trim());
                                }
                                contentText = parts.join("\n\n---\n\n");
                            }
                            else {
                                const html = await page.content();
                                const { content } = extractContent(html, page.url());
                                contentText = content;
                            }
                            // 多挡位压缩
                            const compactMode = params.compact || "compact";
                            if (compactMode !== "full") {
                                contentText = compactContent(contentText, compactMode);
                            }
                            results.push({
                                type: "text",
                                text: `${stepLabel} 📝 文本提取 [${compactMode}] (${contentText.length} 字符)\n\n${contentText}`,
                            });
                            break;
                        }
                        case "visible": {
                            const visibleText = await page.evaluate(() => {
                                const vh = window.innerHeight;
                                const vw = window.innerWidth;
                                const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
                                    acceptNode(node) {
                                        const parent = node.parentElement;
                                        if (!parent)
                                            return NodeFilter.FILTER_REJECT;
                                        const tag = parent.tagName;
                                        if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT")
                                            return NodeFilter.FILTER_REJECT;
                                        const rect = parent.getBoundingClientRect();
                                        if (rect.top < vh && rect.bottom > 0 &&
                                            rect.left < vw && rect.right > 0 &&
                                            rect.width > 0 && rect.height > 0)
                                            return NodeFilter.FILTER_ACCEPT;
                                        return NodeFilter.FILTER_REJECT;
                                    },
                                });
                                const lines = [];
                                const seen = new Set();
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
                            const truncated = visibleText.length > 8000
                                ? visibleText.slice(0, 8000) + "\n...[截断]"
                                : visibleText;
                            results.push({
                                type: "text",
                                text: `${stepLabel} 👁️ 视口文本 (${visibleText.length} 字符)\n\n${truncated}`,
                            });
                            break;
                        }
                        case "click": {
                            if (!step.selector) {
                                results.push({
                                    type: "text",
                                    text: `${stepLabel} ❌ click 需要 selector`,
                                });
                                break;
                            }
                            await page.waitForSelector(step.selector, { timeout });
                            await page.click(step.selector);
                            await page.waitForTimeout(500);
                            results.push({
                                type: "text",
                                text: `${stepLabel} 🖱️ 已点击 "${step.selector}"`,
                            });
                            break;
                        }
                        case "type": {
                            if (!step.selector || !step.value) {
                                results.push({
                                    type: "text",
                                    text: `${stepLabel} ❌ type 需要 selector 和 value`,
                                });
                                break;
                            }
                            await page.waitForSelector(step.selector, { timeout });
                            await page.fill(step.selector, step.value);
                            await page.waitForTimeout(500);
                            results.push({
                                type: "text",
                                text: `${stepLabel} ⌨️ 已在 "${step.selector}" 输入 "${step.value}"`,
                            });
                            break;
                        }
                        case "wait": {
                            if (step.selector) {
                                await page.waitForSelector(step.selector, { timeout });
                                results.push({
                                    type: "text",
                                    text: `${stepLabel} ⏳ "${step.selector}" 已出现`,
                                });
                            }
                            else {
                                // 纯等待（靠 waitMs）
                                results.push({
                                    type: "text",
                                    text: `${stepLabel} ⏳ 等待中`,
                                });
                            }
                            break;
                        }
                        case "links": {
                            const links = await page.evaluate(() => {
                                const anchors = document.querySelectorAll("a[href]");
                                const result = [];
                                const seen = new Set();
                                for (const a of Array.from(anchors)) {
                                    const href = a.href;
                                    const text = a.innerText?.trim() || "";
                                    if (href && !seen.has(href) && text.length > 0) {
                                        seen.add(href);
                                        result.push({ text: text.slice(0, 100), href });
                                    }
                                }
                                return result.slice(0, 50);
                            });
                            const linkText = links
                                .map((l, idx) => `${idx + 1}. [${l.text}](${l.href})`)
                                .join("\n");
                            results.push({
                                type: "text",
                                text: `${stepLabel} 🔗 链接 (${links.length} 个)\n\n${linkText}`,
                            });
                            break;
                        }
                        case "find": {
                            if (!step.value) {
                                results.push({
                                    type: "text",
                                    text: `${stepLabel} ❌ find 操作需要 value 参数（搜索关键词）`,
                                });
                                break;
                            }
                            const findResult = await page.evaluate((keyword) => {
                                const body = document.body;
                                const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, null);
                                const matches = [];
                                const kw = keyword.toLowerCase();
                                let node;
                                while ((node = walker.nextNode())) {
                                    const text = node.textContent || '';
                                    if (text.toLowerCase().includes(kw)) {
                                        const parent = node.parentElement;
                                        matches.push(parent?.textContent?.trim().slice(0, 200) || text.slice(0, 200));
                                        if (matches.length === 1 && parent) {
                                            parent.scrollIntoView({ behavior: 'smooth', block: 'center' });
                                        }
                                    }
                                }
                                return { total: matches.length, items: matches.slice(0, 5) };
                            }, step.value);
                            let findText = `🔍 搜索 "${step.value}": ${findResult.total} 处匹配`;
                            if (findResult.items.length > 0) {
                                findText += '\n' + findResult.items.map((m, i) => `  ${i + 1}. ${m}`).join('\n');
                            }
                            results.push({ type: "text", text: `${stepLabel} ${findText}` });
                            break;
                        }
                    }
                    // 步骤间等待
                    if (step.waitMs && step.waitMs > 0) {
                        await page.waitForTimeout(step.waitMs);
                    }
                }
                catch (stepError) {
                    const msg = stepError instanceof Error ? stepError.message : String(stepError);
                    results.push({
                        type: "text",
                        text: `${stepLabel} ❌ ${step.action} 失败: ${msg}\n\n⚠️ Pipeline 在第 ${i + 1} 步中断，以上为已完成的结果。`,
                    });
                    // 失败时中断，返回已完成的结果
                    break;
                }
            }
            // 完成后处理 session
            if (!params.keepSession && sessionId) {
                await sessionManager.close(sessionId);
                results.push({
                    type: "text",
                    text: `\n✅ Pipeline 完成，会话已关闭`,
                });
            }
            else if (sessionId) {
                results.push({
                    type: "text",
                    text: `\n✅ Pipeline 完成，会话保留: ${sessionId}\n可使用 web_interact(sessionId="${sessionId}") 继续操作`,
                });
            }
            return appendTiming({ content: results }, startTime, browserManager.lastRetryCount);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            let hint = "";
            if (message.includes("ERR_CONNECTION_CLOSED") || message.includes("ERR_CONNECTION_RESET")) {
                hint = "\n\n⚠️ 连接被关闭，可能是登录态过期。建议使用 web_login_browser 重新登录。";
            }
            else if (message.includes("Timeout") || message.includes("timeout")) {
                hint = "\n\n⏱️ 建议增加 timeout 参数或重试。";
            }
            // 如果有已完成的结果，一并返回
            if (results.length > 0) {
                results.push({
                    type: "text",
                    text: `\n❌ Pipeline 异常终止: ${message}${hint}`,
                });
                return appendTiming({ content: results }, startTime, browserManager.lastRetryCount);
            }
            return {
                isError: true,
                content: [{ type: "text", text: `Pipeline 失败: ${message}${hint}` }],
            };
        }
    });
}
//# sourceMappingURL=pipeline.js.map