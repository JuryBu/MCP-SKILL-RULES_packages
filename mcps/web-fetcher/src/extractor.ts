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
    HUMAN_VERIFICATION_KEYWORDS,
    HUMAN_VERIFICATION_THRESHOLD,
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

// ===== 人机验证/拦截检测 (v6.0 UAV) =====

/**
 * 检测页面是否被人机验证或拦截机制阻挡
 * 覆盖：验证码、Cloudflare 盾、reCAPTCHA、hCaptcha、年龄验证、
 *       访问拒绝、地区限制、DDoS 防护、登录墙等
 * 
 * 判断条件：内容极少（< 500字） + 包含人机验证关键词
 * 
 * @returns 如果检测到拦截，返回匹配到的关键词；否则返回 null
 */
export function detectHumanVerification(content: string, url: string): string | null {
    const plainText = content.replace(/[#*\-_\[\]()\>|`\n\r]/g, '').trim();

    if (plainText.length < HUMAN_VERIFICATION_THRESHOLD) {
        const lowerText = plainText.toLowerCase();
        for (const kw of HUMAN_VERIFICATION_KEYWORDS) {
            if (lowerText.includes(kw.toLowerCase())) {
                return kw;
            }
        }
    }
    return null;
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

// ===== "加载更多" 按钮检测 (v6.8) =====

/** 常见的"加载更多"按钮文本模式（小写匹配） */
const LOAD_MORE_TEXT_PATTERNS = [
    "加载更多", "查看更多", "展开全部", "显示更多", "点击加载", "查看全部",
    "展开所有", "加载全部", "更多内容", "展示更多", "显示全部",
    "load more", "show more", "view more", "see more", "expand all",
    "show all", "load all", "view all", "read more",
];

/** 常见的"加载更多"按钮 CSS 类名模式 */
const LOAD_MORE_CLASS_PATTERNS = [
    "loadmore", "load-more", "load_more",
    "show-more", "show_more", "showmore",
    "expand-all", "expand_all", "expandall",
    "view-more", "view_more", "viewmore",
    "read-more", "read_more", "readmore",
    "more-btn", "more_btn", "morebtn",
    "load-all", "load_all", "loadall",
];

/**
 * 检测页面 DOM 中是否存在"加载更多"按钮
 * @param document JSDOM Document 对象
 * @returns 匹配到的按钮信息（含建议 selector 和文本），或 null
 */
function detectLoadMore(document: Document): { selector: string; text: string } | null {
    // 策略1: 扫描可点击元素（a, button, [role=button]）的文本内容
    const clickables = document.querySelectorAll('a, button, [role="button"], span[class*="load"], div[class*="load"], span[class*="more"], div[class*="more"]');
    for (const el of Array.from(clickables)) {
        const text = (el.textContent || '').trim().toLowerCase();
        if (text.length > 50) continue; // 过长的文本不太可能是按钮

        for (const pattern of LOAD_MORE_TEXT_PATTERNS) {
            if (text.includes(pattern)) {
                // 构造建议 selector
                const tag = el.tagName.toLowerCase();
                const className = (el as HTMLElement).className || '';
                const id = el.id;
                let selector: string;

                if (id) {
                    selector = `#${id}`;
                } else if (className) {
                    // 取第一个有意义的 class
                    const mainClass = className.split(/\s+/).find(c =>
                        c.length > 2 && !c.startsWith('el-') && !c.startsWith('v-')
                    ) || className.split(/\s+/)[0];
                    selector = `${tag}.${mainClass}`;
                } else {
                    selector = `${tag}:has-text("${(el.textContent || '').trim().slice(0, 20)}")`;
                }

                return { selector, text: (el.textContent || '').trim().slice(0, 30) };
            }
        }
    }

    // 策略2: 通过 CSS 类名匹配
    for (const classPattern of LOAD_MORE_CLASS_PATTERNS) {
        try {
            const els = document.querySelectorAll(`[class*="${classPattern}"]`);
            for (const el of Array.from(els)) {
                const text = (el.textContent || '').trim();
                if (text.length > 0 && text.length <= 50) {
                    const tag = el.tagName.toLowerCase();
                    const className = (el as HTMLElement).className || '';
                    const mainClass = className.split(/\s+/).find(c => c.includes(classPattern)) || classPattern;
                    return { selector: `${tag}.${mainClass}`, text: text.slice(0, 30) };
                }
            }
        } catch { /* 某些选择器可能在 JSDOM 中不支持 */ }
    }

    return null;
}

// ===== SPA 框架指纹检测 (v6.8) =====

function detectSPAFramework(document: Document): string | null {
    const html = document.documentElement?.outerHTML || '';
    if (html.includes('data-v-') || html.includes('__vue')) return 'Vue';
    if (html.includes('data-reactroot') || html.includes('__next') || html.includes('_reactRoot')) return 'React';
    if (html.includes('ng-app') || html.includes('ng-version')) return 'Angular';
    if (document.querySelector('[class*="svelte-"]')) return 'Svelte';
    if (document.querySelector('#app') || document.querySelector('#root')) {
        const appEl = document.querySelector('#app') || document.querySelector('#root');
        if (appEl && (appEl.children.length > 0) && (appEl.getAttribute('data-server-rendered') || html.includes('__NUXT__') || html.includes('__NEXT_DATA__'))) {
            return 'SSR-SPA';
        }
    }
    return null;
}

// ===== 交互式隐藏内容检测 (v6.8) =====

interface HiddenContentInfo { type: string; count: number; selector: string; }

function detectHiddenContent(document: Document): HiddenContentInfo[] {
    const findings: HiddenContentInfo[] = [];
    try {
        const collapsed = document.querySelectorAll('[aria-expanded="false"]');
        if (collapsed.length > 0) findings.push({ type: '折叠面板', count: collapsed.length, selector: '[aria-expanded="false"]' });
    } catch { }
    try {
        const hiddenTabs = document.querySelectorAll('[role="tabpanel"][hidden], [role="tabpanel"][aria-hidden="true"]');
        if (hiddenTabs.length > 0) findings.push({ type: '隐藏标签页', count: hiddenTabs.length, selector: '[role="tabpanel"]' });
    } catch { }
    try {
        const pagination = document.querySelectorAll('[class*="pagination"], [class*="pager"], [role="navigation"] a[href*="page"]');
        if (pagination.length > 2) findings.push({ type: '分页器', count: pagination.length, selector: '[class*="pagination"]' });
    } catch { }
    return findings;
}

// ===== 统一内容完整性分析 (v6.8) =====

interface ContentAnalysis {
    loadMore: { selector: string; text: string } | null;
    spaFramework: string | null;
    htmlTextRatio: number;
    hiddenContent: HiddenContentInfo[];
    riskLevel: 'low' | 'medium' | 'high';
    findings: string[];
}

function analyzeContentCompleteness(document: Document, html: string, extractedText: string): ContentAnalysis {
    const loadMore = detectLoadMore(document);
    const spaFramework = detectSPAFramework(document);
    const hiddenContent = detectHiddenContent(document);
    const plainText = extractedText.replace(/[#*\-_\[\]()>|`\n\r]/g, '').replace(/\s+/g, '').trim();
    const htmlTextRatio = html.length > 0 ? plainText.length / html.length : 1;

    const findings: string[] = [];
    let riskScore = 0;

    if (loadMore) {
        findings.push(`检测到可展开按钮（\`${loadMore.selector}\`，文本: "${loadMore.text}"）`);
        riskScore += 35;
    }
    if (spaFramework) {
        findings.push(`检测到 ${spaFramework} 框架，页面为 SPA 动态渲染`);
        riskScore += 20;
    }
    if (htmlTextRatio < 0.05 && html.length > 10000) {
        findings.push(`HTML体积(${(html.length / 1024).toFixed(0)}KB)远大于提取文本(${(plainText.length / 1024).toFixed(1)}KB)，存在大量未提取内容`);
        riskScore += 20;
    }
    for (const h of hiddenContent) {
        findings.push(`发现 ${h.count} 个${h.type}（\`${h.selector}\`）`);
        riskScore += 15;
    }

    const riskLevel = riskScore >= 40 ? 'high' : riskScore >= 20 ? 'medium' : 'low';
    return { loadMore, spaFramework, htmlTextRatio, hiddenContent, riskLevel, findings };
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
                const readabilityContent = deduplicateHeadings(cleanFooterGarbage(truncateContent(`# ${title}\n\n${markdown}`)));

                // v6.8: 多信号内容完整性分析
                const analysis = analyzeContentCompleteness(document, html, readabilityContent);
                let hint = '';
                if (analysis.riskLevel === 'low') {
                    hint = `\n\n---\n💡 Readability 自动提取，未发现内容缺失风险。如需精准提取可用 content + selector。`;
                } else {
                    const icon = analysis.riskLevel === 'high' ? '⚠️' : '🔍';
                    const lines = [`\n\n---\n${icon} 内容完整性分析（风险: ${analysis.riskLevel}）：`];
                    for (const f of analysis.findings) lines.push(`  - ${f}`);
                    if (analysis.loadMore) {
                        lines.push(`建议: \`web_pipeline(url, steps=[{action:"click", selector:"${analysis.loadMore.selector}"}, {action:"wait", waitMs:2000}, {action:"content", selector:"<主内容区>"}])\``);
                    }
                    lines.push(`  → 用 web_fetch_html 查看 DOM 结构，用 content + selector 精准提取`);
                    hint = lines.join('\n');
                }

                return {
                    title,
                    content: readabilityContent + hint,
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
        // body fallback 也需要内容完整性分析
        const fallbackContent = deduplicateHeadings(cleanFooterGarbage(truncateContent(`# ${docTitle}\n\n${markdown}`)));
        const analysis = analyzeContentCompleteness(document, html, fallbackContent);
        let hint = '';
        if (analysis.riskLevel !== 'low') {
            const icon = analysis.riskLevel === 'high' ? '⚠️' : '🔍';
            const lines = [`\n\n---\n${icon} 内容完整性分析（风险: ${analysis.riskLevel}）：`];
            for (const f of analysis.findings) lines.push(`  - ${f}`);
            if (analysis.loadMore) {
                lines.push(`建议: \`web_pipeline(url, steps=[{action:"click", selector:"${analysis.loadMore.selector}"}, {action:"wait", waitMs:2000}, {action:"content", selector:"<主内容区>"}])\``);
            }
            lines.push(`  → 用 web_fetch_html 查看 DOM 结构，用 content + selector 精准提取`);
            hint = lines.join('\n');
        }
        return {
            title: docTitle,
            content: fallbackContent + hint,
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

// ===== safePageEvaluate：导航安全的 page.evaluate 封装 =====

import type { Page } from "playwright-core";

/**
 * 安全执行 page.evaluate，在遇到 "Execution context was destroyed" 时
 * 自动等待导航完成并重试。适用于页面可能发生重定向的场景。
 * 
 * @param page Playwright 页面对象
 * @param fn 要在页面中执行的函数
 * @param args 传给 fn 的参数
 * @param maxRetries 最大重试次数（默认 2）
 */
export async function safePageEvaluate<T>(
    page: Page,
    fn: (...args: any[]) => T,
    args?: any,
    maxRetries = 2,
): Promise<T> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return args !== undefined
                ? await page.evaluate(fn, args)
                : await page.evaluate(fn);
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            if (msg.includes('context was destroyed') || msg.includes('Execution context')) {
                if (attempt < maxRetries) {
                    // 等待导航稳定后重试
                    await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => { });
                    await page.waitForTimeout(500);
                    continue;
                }
            }
            throw error;
        }
    }
    throw new Error('safePageEvaluate: unreachable');
}

/**
 * 安全执行 page.content()，在遇到 context destroyed 时自动等待并重试
 */
export async function safePageContent(page: Page, maxRetries = 2): Promise<string> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await page.content();
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            if (msg.includes('context was destroyed') || msg.includes('Execution context')) {
                if (attempt < maxRetries) {
                    await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => { });
                    await page.waitForTimeout(500);
                    continue;
                }
            }
            throw error;
        }
    }
    throw new Error('safePageContent: unreachable');
}
