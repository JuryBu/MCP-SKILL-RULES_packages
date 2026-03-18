import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import {
    CHARACTER_LIMIT,
    OUTPUT_MODE_LIMITS,
    OUTPUT_MODE_LINES,
    FOOTER_GARBAGE_PATTERNS,
    SPA_LAZY_LOAD_DOMAINS,
    SPA_SKELETON_KEYWORDS,
    SPA_SKELETON_THRESHOLD,
} from "./constants.js";

export type OutputMode = "full" | "compact" | "minimal" | "headings";

// ===== SPA 空壳检测 =====

/**
 * 检测提取的内容是否为 SPA 空壳（页面未完成加载的空白/框架内容）
 * 返回提示语（如果检测到问题），或 null（内容正常）
 */
export function detectSPAIssue(content: string, url: string): string | null {
    // 计算有效文本长度（去除 markdown 标记和空白）
    const plainText = content.replace(/[#*\-_\[\]()>|`\n\r]/g, '').trim();
    if (plainText.length >= SPA_SKELETON_THRESHOLD) return null;

    // 检查是否包含 SPA 空壳关键词
    const hasSkeletonKeyword = SPA_SKELETON_KEYWORDS.some(kw =>
        content.includes(kw)
    );

    // 检查是否是已知 SPA 站点
    const isSPASite = SPA_LAZY_LOAD_DOMAINS.some(domain =>
        url.includes(domain)
    );

    if (hasSkeletonKeyword || (isSPASite && plainText.length < SPA_SKELETON_THRESHOLD)) {
        const domainHint = isSPASite ? '（已知 SPA 站点）' : '';
        return `\n\n⚠️ 检测到页面内容极少${domainHint}，可能是 SPA 懒加载未完成。建议：\n` +
            `  1. 添加 scrollCount=2~3 参数触发懒加载\n` +
            `  2. 或添加 waitFor="<内容区CSS选择器>" 等待特定元素出现`;
    }

    return null;
}

/**
 * 检测内容是否存在编码乱码（锟斤拷特征）
 * 返回 true 表示检测到严重乱码
 */
export function detectEncodingIssue(content: string): boolean {
    // "锟斤拷" 是 GBK→UTF-8 错误转换的典型产物
    const mojibakeCount = (content.match(/锟斤拷/g) || []).length;
    return mojibakeCount >= 3; // 3 次以上基本确定是编码问题
}

// 初始化 Turndown（HTML → Markdown）
const turndown = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
});

// 移除不需要的元素
turndown.remove(["script", "style", "nav", "footer", "iframe", "noscript"]);

// ======== 广告/追踪域名黑名单 ========
const AD_TRACKING_DOMAINS = [
    "cm.bilibili.com",
    "ad.bilibili.com",
    "t.bilibili.com/ajax",
    "cm.zhihu.com",
    "sugar.zhihu.com",
    "googleads.g.doubleclick.net",
    "pagead2.googlesyndication.com",
    "ad.doubleclick.net",
    "analytics.google.com",
    "www.googletagmanager.com",
    "ads.twitter.com",
    "syndication.twitter.com",
];

// ======== 平台专用 CSS 选择器配置 ========
interface PlatformConfig {
    /** URL 匹配规则 */
    match: (url: string) => boolean;
    /** 优先提取的内容区域选择器（按优先级排序） */
    contentSelectors: string[];
    /** 额外需要移除的噪音元素选择器 */
    removeSelectors: string[];
}

const PLATFORM_CONFIGS: PlatformConfig[] = [
    // B站 视频页
    {
        match: (url) => /bilibili\.com\/video\//.test(url),
        contentSelectors: [
            "#viewbox_report",          // 视频标题区
            "#v_desc",                  // 视频简介
            ".video-desc",             // 视频描述（备用）
            ".video-info-detail",      // 视频详情
            "#comment",                // 评论区
            ".bb-comment",             // 评论区（旧版）
        ],
        removeSelectors: [
            ".ad-report",
            ".bili-header",
            ".bili-footer",
            "#biliMainFooter",
            ".pop-live-small-mode",
            ".bili-mini-mask",
            ".bpx-player-container",   // 播放器本身（无文本价值）
            '[class*="ad-"]',
            '[class*="Ad-"]',
            ".slide-ad-exp",
            ".activity-banner",
            ".eva-banner",
            ".banner-card",
            ".floor-single-card",      // 首页广告卡片
            ".bili-header__banner",
        ],
    },
    // B站 首页/分区
    {
        match: (url) => /bilibili\.com\/?($|\?|#)/.test(url) || /bilibili\.com\/v\//.test(url),
        contentSelectors: [
            ".recommended-container",   // 推荐容器
            ".feed-card",              // Feed 卡片
            ".bili-video-card",        // 视频卡片
            ".video-list",             // 视频列表
        ],
        removeSelectors: [
            ".ad-report",
            ".bili-header",
            ".bili-footer",
            "#biliMainFooter",
            ".slide-ad-exp",
            ".activity-banner",
            ".eva-banner",
            ".banner-card",
            ".floor-single-card",
            ".bili-header__banner",
            '[class*="ad-"]',
            '[class*="Ad-"]',
        ],
    },
    // 知乎 问题/回答页
    {
        match: (url) => /zhihu\.com\/question\//.test(url),
        contentSelectors: [
            ".QuestionHeader",
            ".QuestionAnswer-content",
            ".ContentItem",
            ".RichContent",
            ".List-item",
        ],
        removeSelectors: [
            ".AppHeader",
            ".Pc-word",
            ".Sticky",
            ".AdblockBanner",
            '[class*="Ad"]',
            ".Recommendations-Main",
        ],
    },
    // 知乎 热榜
    {
        match: (url) => /zhihu\.com\/hot/.test(url),
        contentSelectors: [
            ".HotList-list",
            ".HotItem",
            ".HotItem-content",
        ],
        removeSelectors: [
            ".AppHeader",
            ".Pc-word",
            ".AdblockBanner",
            '[class*="Ad"]',
        ],
    },
    // 知乎 搜索/信息流
    {
        match: (url) => /zhihu\.com\/(search|follow|explore)/.test(url),
        contentSelectors: [
            ".SearchResult-Card",
            ".ContentItem",
            ".Feed",
            ".List-item",
        ],
        removeSelectors: [
            ".AppHeader",
            ".Pc-word",
            ".AdblockBanner",
        ],
    },
];

// ======== 通用噪音移除选择器 ========
const UNIVERSAL_REMOVE_SELECTORS = [
    "script", "style", "noscript",
    "nav", "header", "footer",
    ".nav", ".navbar", ".header", ".footer", ".sidebar",
    ".ad", ".ads", ".advertisement",
    '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]',
    '[style*="display:none"]', '[style*="display: none"]',
    '[aria-hidden="true"]',
];

// ======== 页脚垃圾特征 ========
const FOOTER_PATTERNS = [
    "营业执照", "ICP备案", "经营许可证", "不良信息举报",
    "公安备案", "增值电信", "京公网安备", "互联网药品信息",
    "网络文化经营许可证", "广播电视节目制作经营许可证",
];

/**
 * 预清洗 DOM — 在任何提取逻辑之前移除广告/追踪噪音
 */
function preCleanDOM(document: Document): void {
    // 1) 移除已知广告域名的 <a> 标签（含其父 wrapper）
    const allLinks = document.querySelectorAll("a[href]");
    for (const link of Array.from(allLinks)) {
        const href = (link as HTMLAnchorElement).href || "";
        // 检查是否命中广告域名
        const isAdLink = AD_TRACKING_DOMAINS.some((domain) => href.includes(domain));
        // 检查超长 href（>500字符通常是追踪 URL）
        const isSuperLongHref = href.length > 500;

        if (isAdLink || isSuperLongHref) {
            // 如果这个 <a> 的父元素只包含这一个子元素，整个父元素都移除
            const parent = link.parentElement;
            if (parent && parent.children.length === 1 && parent.tagName !== "BODY") {
                parent.remove();
            } else {
                link.remove();
            }
        }
    }

    // 2) 移除通用噪音元素
    for (const selector of UNIVERSAL_REMOVE_SELECTORS) {
        try {
            document.querySelectorAll(selector).forEach((el) => el.remove());
        } catch { /* 某些选择器可能在 JSDOM 中不支持 */ }
    }
}

/**
 * 检测提取结果是否是垃圾内容
 * 返回 true 表示内容质量差，应该尝试其他提取策略
 */
function isGarbageContent(markdown: string): boolean {
    if (!markdown || markdown.trim().length < 100) return true;

    const text = markdown.trim();

    // 1) 页脚垃圾检测
    const hasFooterJunk = FOOTER_PATTERNS.some((p) => text.includes(p));
    if (hasFooterJunk && text.length < 2000) return true;

    // 2) URL 密度检测 — 如果超过40%的字符在URL中，内容基本是链接垃圾
    const urlMatches = text.match(/https?:\/\/\S{20,}/g) || [];
    const totalUrlChars = urlMatches.reduce((sum, u) => sum + u.length, 0);
    const urlDensity = totalUrlChars / text.length;
    if (urlDensity > 0.4) {
        console.error(`[web-fetcher] 垃圾检测: URL密度 ${(urlDensity * 100).toFixed(1)}% (${urlMatches.length} 个长URL)`);
        return true;
    }

    // 3) Base64/追踪数据密度检测
    const base64Chunks = text.match(/[A-Za-z0-9+/=]{100,}/g) || [];
    const totalBase64Chars = base64Chunks.reduce((sum, c) => sum + c.length, 0);
    if (totalBase64Chars > text.length * 0.3) {
        console.error(`[web-fetcher] 垃圾检测: base64密度 ${((totalBase64Chars / text.length) * 100).toFixed(1)}%`);
        return true;
    }

    return false;
}

/**
 * 尝试使用平台专用选择器提取内容
 */
function extractByPlatformSelectors(
    document: Document,
    _url: string,
    config: PlatformConfig,
    docTitle: string,
): string | null {
    // 先移除平台特定噪音
    for (const selector of config.removeSelectors) {
        try {
            document.querySelectorAll(selector).forEach((el) => el.remove());
        } catch { /* 可能不支持的选择器 */ }
    }

    // 收集所有匹配到的内容元素
    const contentParts: string[] = [];
    for (const selector of config.contentSelectors) {
        try {
            const elements = document.querySelectorAll(selector);
            for (const el of Array.from(elements)) {
                const html = (el as HTMLElement).innerHTML;
                if (html && html.trim().length > 50) {
                    const md = turndown.turndown(html);
                    if (md.trim().length > 30) {
                        contentParts.push(md);
                    }
                }
            }
        } catch { /* 选择器不匹配 */ }
    }

    if (contentParts.length === 0) return null;

    const combined = contentParts.join("\n\n---\n\n");
    if (combined.trim().length < 100) return null;

    // 质量检查
    if (isGarbageContent(combined)) {
        console.error(`[web-fetcher] 平台选择器提取的内容未通过质量检查`);
        return null;
    }

    return truncateContent(`# ${docTitle}\n\n${combined}`);
}

/**
 * 去除重复的标题块（同标题+同URL视为重复）
 * 适用于B站等网站HTML中存在轮播/预渲染导致的DOM重复
 */
export function deduplicateHeadings(content: string): string {
    const lines = content.split("\n");
    const result: string[] = [];
    const seenHeadings = new Set<string>();
    let skipping = false;

    for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim();

        // 检测 markdown 标题行（## 或 ###）
        if (/^#{2,4}\s/.test(trimmed)) {
            // 提取标题的标准化 key（去掉 # 前缀，去掉首尾空格）
            const headingKey = trimmed.replace(/^#+\s*/, "").trim();

            if (seenHeadings.has(headingKey)) {
                // 重复标题，开始跳过直到下一个同级或更高级标题
                skipping = true;
                continue;
            }
            seenHeadings.add(headingKey);
            skipping = false;
        }

        if (!skipping) {
            result.push(lines[i]);
        }
    }

    return result.join("\n");
}

/**
 * 从 HTML 中提取正文内容并转换为 Markdown
 *
 * 提取优先级：
 * 1. 平台专用 CSS 选择器（如果 URL 匹配已知平台）
 * 2. Readability 智能提取
 * 3. body 全文 fallback
 *
 * 每一层都经过垃圾内容质量检查，不合格则降级到下一层。
 */
export function extractContent(
    html: string,
    url: string
): { title: string; content: string } {
    const dom = new JSDOM(html, { url });
    const document = dom.window.document;
    const docTitle = document.title || "无标题";

    // === 第0步：预清洗 DOM ===
    preCleanDOM(document);

    // === 第1步：尝试平台专用选择器 ===
    const platformConfig = PLATFORM_CONFIGS.find((p) => p.match(url));
    if (platformConfig) {
        console.error(`[web-fetcher] 检测到平台配置，使用专用选择器提取`);
        // 使用克隆的 document 避免影响后续 fallback
        const cloneForPlatform = document.cloneNode(true) as Document;
        const platformResult = extractByPlatformSelectors(cloneForPlatform, url, platformConfig, docTitle);
        if (platformResult) {
            console.error(`[web-fetcher] 平台选择器提取成功 (${platformResult.length} 字符)`);
            return { title: docTitle, content: platformResult };
        }
        console.error(`[web-fetcher] 平台选择器提取失败，降级到 Readability`);
    }

    // === 第2步：Readability 提取 ===
    try {
        const reader = new Readability(document.cloneNode(true) as Document);
        const article = reader.parse();

        if (article && article.content) {
            const markdown = turndown.turndown(article.content);
            const title = article.title || docTitle;

            if (!isGarbageContent(markdown)) {
                return {
                    title,
                    content: deduplicateHeadings(cleanFooterGarbage(truncateContent(`# ${title}\n\n${markdown}`))),
                };
            }
            console.error(`[web-fetcher] Readability 提取未通过质量检查 (${markdown.length} 字符), 降级到 body`);
        }
    } catch (e) {
        console.error(`[web-fetcher] Readability 解析异常: ${e}`);
    }

    // === 第3步：body 全文 fallback ===
    const body = document.body;
    if (body) {
        // 平台特定噪音在 fallback 时也需要移除
        if (platformConfig) {
            for (const selector of platformConfig.removeSelectors) {
                try {
                    body.querySelectorAll(selector).forEach((el: Element) => el.remove());
                } catch { /* ignore */ }
            }
        }

        const markdown = turndown.turndown(body.innerHTML);
        return {
            title: docTitle,
            content: deduplicateHeadings(cleanFooterGarbage(truncateContent(`# ${docTitle}\n\n${markdown}`))),
        };
    }

    return {
        title: "无标题",
        content: "无法从页面中提取内容。",
    };
}

/**
 * 清除 footer 垃圾内容（ICP备案、营业执照、举报电话等）
 * 
 * 双重策略：
 * 1. 从文本末尾向前扫描，找到连续垃圾区域并截断
 * 2. 全文逐行过滤：短行（<200字）中包含垃圾关键词的行直接删除
 *    （解决 SPA 站点垃圾信息出现在文本中间的问题，如小红书）
 */
export function cleanFooterGarbage(content: string): string {
    const lines = content.split("\n");

    // === 策略1：末尾截断 ===
    let cutIndex = lines.length;
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 50); i--) {
        const line = lines[i].trim();
        if (line.length === 0) continue;
        const isGarbage = FOOTER_GARBAGE_PATTERNS.some(p => line.includes(p));
        if (isGarbage) {
            cutIndex = i;
        } else if (cutIndex < lines.length && line.length > 20) {
            break;
        }
    }

    const afterCut = cutIndex < lines.length
        ? lines.slice(0, cutIndex)
        : lines;

    // === 策略2：全文逐行过滤（垃圾关键词密度策略） ===
    const filtered = afterCut.filter(line => {
        const trimmed = line.trim();
        if (trimmed.length === 0) return true;

        // 计算匹配的垃圾关键词数量
        const matchCount = FOOTER_GARBAGE_PATTERNS.filter(p => trimmed.includes(p)).length;

        // 2+ 个关键词命中 → 确定是垃圾行，不管多长都删
        if (matchCount >= 2) return false;
        // 1 个关键词命中 + 短行 → 删除（长行可能是正文讨论）
        if (matchCount === 1 && trimmed.length <= 500) return false;

        return true;
    });

    return filtered.join("\n").trimEnd();
}

/**
 * 截断过长的内容
 */
export function truncateContent(content: string): string {
    if (content.length <= CHARACTER_LIMIT) {
        return content;
    }

    const truncated = content.slice(0, CHARACTER_LIMIT);
    const lastNewline = truncated.lastIndexOf("\n");
    const cutPoint = lastNewline > CHARACTER_LIMIT * 0.8 ? lastNewline : CHARACTER_LIMIT;

    return (
        truncated.slice(0, cutPoint) +
        `\n\n---\n*[内容已截断，原始长度: ${content.length} 字符，已显示: ${cutPoint} 字符]*`
    );
}

/**
 * 多挡位紧凑模式内容压缩
 * @param mode - 压缩模式 compact(8000字/3行) | minimal(3000字/1行) | headings(1500字/0行)
 */
export function compactContent(content: string, mode: OutputMode = "compact"): string {
    if (mode === "full") return content;

    const charLimit = OUTPUT_MODE_LIMITS[mode as keyof typeof OUTPUT_MODE_LIMITS] || OUTPUT_MODE_LIMITS.compact;
    const maxBodyLines = OUTPUT_MODE_LINES[mode as keyof typeof OUTPUT_MODE_LINES] ?? 3;

    // 先清理 footer 垃圾 + 标题去重
    content = deduplicateHeadings(cleanFooterGarbage(content));

    if (content.length <= charLimit) {
        return content;
    }

    // 预处理：去除 markdown 图片（含嵌套链接图片）
    let cleaned = content
        .replace(/\[!\[.*?\]\(.*?\)\]\(.*?\)/g, "")  // [![alt](img)](link)
        .replace(/!\[.*?\]\(.*?\)/g, "");              // ![alt](url)

    const lines = cleaned.split("\n");
    const result: string[] = [];
    let totalLength = 0;
    let consecutiveBodyLines = 0;
    let lastWasEmpty = false;
    const MAX_LIST_ITEM_LEN = mode === "headings" ? 60 : 120;

    for (const line of lines) {
        const trimmed = line.trim();

        // 跳过纯链接残留 + 孤立的 [ 残留（如 HN 投票按钮）
        if (/^\]?\(/.test(trimmed) || trimmed === "[" || (/^\[?\s*$/.test(trimmed) && trimmed.startsWith("["))) {
            continue;
        }

        // 压缩连续空行
        if (trimmed === "") {
            if (lastWasEmpty) continue;
            lastWasEmpty = true;
            result.push("");
            totalLength += 1;
            continue;
        }
        lastWasEmpty = false;

        // 标题行：始终保留
        if (trimmed.startsWith("#")) {
            consecutiveBodyLines = 0;
            result.push(line);
            totalLength += line.length + 1;
        }
        // 分隔符
        else if (trimmed === "---" || trimmed === "***") {
            result.push(trimmed);
            totalLength += trimmed.length + 1;
        }
        // headings 模式只保留标题
        else if (mode === "headings") {
            // 跳过所有非标题内容
            continue;
        }
        // 列表项（含独占一行的编号如 "1." "30."）：保留但截断
        else if (/^[-*]\s|^\d+\.\s|^\d+\.$/.test(trimmed)) {
            consecutiveBodyLines = 0;
            const truncated = trimmed.length > MAX_LIST_ITEM_LEN
                ? trimmed.slice(0, MAX_LIST_ITEM_LEN) + "…"
                : trimmed;
            result.push(truncated);
            totalLength += truncated.length + 1;
        }
        // 普通段落：每章节只留前 N 行
        else {
            consecutiveBodyLines++;
            if (consecutiveBodyLines <= maxBodyLines) {
                const truncated = trimmed.length > 200
                    ? trimmed.slice(0, 200) + "…"
                    : trimmed;
                result.push(truncated);
                totalLength += truncated.length + 1;
            } else if (consecutiveBodyLines === maxBodyLines + 1 && maxBodyLines > 0) {
                result.push("*[…]*");
                totalLength += 6;
            }
        }

        if (totalLength >= charLimit) {
            result.push(`\n---\n*[${mode}: ${totalLength}/${content.length} 字符]*`);
            break;
        }
    }

    // 最终清理：压缩 3+ 连续空行为 1 空行（防止过滤残留导致稀疏输出）
    return result.join("\n").replace(/\n{3,}/g, "\n\n");
}
