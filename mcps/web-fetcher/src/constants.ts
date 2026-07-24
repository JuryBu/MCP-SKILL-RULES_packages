import path from "path";
import os from "os";

/**
 * MCP Web Fetcher 常量配置
 */

// v6.1: 多实例隔离 — 每个 MCP 进程使用独立的浏览器 profile
// 基础目录（所有 profile 的父目录）
export const BROWSER_PROFILES_BASE_DIR = path.resolve(
    process.env.WEB_FETCHER_PROFILE_BASE_DIR
    || process.env.WEB_FETCHER_PROFILES_DIR
    || path.join(process.env.CODEX_TOOLKIT_DATA_ROOT || path.join(os.homedir(), ".codex-toolkit"), "web-fetcher-profiles"),
);

// 当前实例的浏览器 profile 目录（按 PID 隔离，避免 Chromium SingletonLock 冲突）
export const BROWSER_USER_DATA_DIR = path.join(
    BROWSER_PROFILES_BASE_DIR,
    `profile-${process.pid}`
);

// Cookie 备份文件 — 放在 profiles 基础目录下，所有实例共享
// 不再放在单个 profile 内部，确保多实例间 Cookie 同步
export const COOKIES_BACKUP_FILE = path.join(
    BROWSER_PROFILES_BASE_DIR,
    "cookies-backup.json"
);

// v6.4: localStorage 持久化备份 — SPA 站点的认证 token 可能存在 localStorage 中
export const LOCALSTORAGE_BACKUP_FILE = path.join(
    BROWSER_PROFILES_BASE_DIR,
    "localstorage-backup.json"
);

// v6.5: 下载文件临时存储目录
export const DOWNLOADS_DIR = path.join(
    os.tmpdir(),
    "mcp-web-fetcher",
    "downloads"
);

// 返回内容的最大字符数，防止过大的响应
export const CHARACTER_LIMIT = 50000;

// ========== 多挡位 compact 模式 ==========
// 各挡位字符上限
export const OUTPUT_MODE_LIMITS = {
    compact: 8000,    // 日常浏览概览，3行/段
    minimal: 3000,    // 只要标题+结构骨架，1行/段
    headings: 1500,   // 纯标题大纲，0行/段
} as const;

// 各挡位每段保留行数
export const OUTPUT_MODE_LINES = {
    compact: 3,
    minimal: 1,
    headings: 0,
} as const;

// 默认模式下写到临时文件的摘要预览长度
export const SUMMARY_PREVIEW_LENGTH = 1500;

// 临时文件目录前缀
export const TEMP_PAGE_PREFIX = "mcp-page-";

// ========== 截图质量配置（5级） ==========
export type ImageQuality = "hd" | "clear" | "default" | "compact" | "fast";

export interface QualityConfig {
    jpegQuality: number;  // JPEG 压缩质量 (1-100)
    viewportWidth: number; // 视口宽度
}

export const QUALITY_PRESETS: Record<ImageQuality, QualityConfig> = {
    hd: { jpegQuality: 90, viewportWidth: 1920 },
    clear: { jpegQuality: 72, viewportWidth: 1920 },
    default: { jpegQuality: 55, viewportWidth: 1280 },
    compact: { jpegQuality: 42, viewportWidth: 1280 },  // 1024→1280: 防止中文网站右侧截断
    fast: { jpegQuality: 30, viewportWidth: 1024 },      // 800→1024: 避免触发移动端布局
};

// 向后兼容：默认 JPEG 质量
export const SCREENSHOT_QUALITY = QUALITY_PRESETS.default.jpegQuality;

// 截图 MIME 类型
export const SCREENSHOT_MIME_TYPE = "image/jpeg";

// saveMode 类型
export type SaveMode = "file" | "inline";

// ========== 页面加载配置 ==========
// 默认页面加载超时（毫秒）
export const DEFAULT_TIMEOUT = 30000;

// ========== Chrome 版本号集中管理 ==========
// stealth / UA / Client Hints 全链路统一引用这里
// 更新时只需修改这三个值
export const CHROME_VERSION = '146';
export const CHROME_FULL_VERSION = '146.0.7680.166';
export const CHROMIUM_BRANDS = [
    { brand: 'Chromium', version: CHROME_VERSION },
    { brand: 'Not/A)Brand', version: '8' },
    { brand: 'Google Chrome', version: CHROME_VERSION },
];
export const CHROMIUM_FULL_VERSION_LIST = [
    { brand: 'Chromium', version: CHROME_FULL_VERSION },
    { brand: 'Not/A)Brand', version: '8.0.0.0' },
    { brand: 'Google Chrome', version: CHROME_FULL_VERSION },
];

// WebGL 显卡型号（取市占率高的通用显卡，避免引人注目）
export const WEBGL_VENDOR = 'Google Inc. (NVIDIA)';
export const WEBGL_RENDERER = 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)';

// 默认 User-Agent
export const DEFAULT_USER_AGENT =
    `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_VERSION}.0.0.0 Safari/537.36`;

// 页面加载后的随机延迟范围（毫秒），用于降低反爬检测
export const ANTI_BOT_DELAY_MIN = 500;
export const ANTI_BOT_DELAY_MAX = 1500;

// ========== 域名限速配置 ==========
// 域名级请求最小间隔（毫秒）— 防止高频请求触发 IP 级封禁
export const DOMAIN_REQUEST_COOLDOWN = 3000;

// 高风控域名列表 — 这些站点对无头浏览器检测严格，需要额外延迟
export const HIGH_RISK_DOMAINS = [
    'reddit.com',
    'x.com',
    'twitter.com',
    'google.com',
];

// 高风控站点的额外延迟范围（毫秒）
export const HIGH_RISK_DELAY_MIN = 1500;
export const HIGH_RISK_DELAY_MAX = 3500;

// 真实 Chrome 标准 Accept Headers
export const BROWSER_ACCEPT_HEADERS = {
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
    'Accept-Language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
    'DNT': '1',
    'Upgrade-Insecure-Requests': '1',
};

// ========== Footer 垃圾清理关键词 ==========
export const FOOTER_GARBAGE_PATTERNS = [
    'ICP备',
    'ICP证',
    '营业执照',
    '网安备',
    '公安备',
    '违法不良信息举报',
    '有害信息举报',
    '网络文化经营许可',
    '互联网药品信息服务',
    '医疗器械网络交易',
    '增值电信业务经营许可',
    '个性化推荐算法',
    '网信算备',
    '食品经营许可',
    '广播电视节目制作经营许可',
    '出版物网络交易平台',
];

// ========== 工具计时辅助 ==========
/**
 * 在工具返回结果的文本内容中追加耗时和重试信息
 * @param result MCP 工具返回值
 * @param startTime Date.now() 起始时间
 * @param retries 重试次数（0=无重试）
 */
export function appendTiming(
    result: any,
    startTime: number,
    retries = 0,
): any {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const retryStr = retries > 0 ? ` (含${retries}次重试)` : '';
    const timingStr = `\n⏱ 耗时 ${elapsed}s${retryStr}`;
    // 找到最后一个 text 类型的 content 追加
    for (let i = result.content.length - 1; i >= 0; i--) {
        if (result.content[i].type === 'text' && result.content[i].text) {
            result.content[i].text += timingStr;
            break;
        }
    }
    return result;
}

// ========== AI Summary 配置 ==========
/** AI Summary 输入文本最大长度（字符）— 避免 prompt 过长 */
export const AI_SUMMARY_MAX_INPUT = 12000;

/** AI Summary 链路类型 */
export type SummaryChain = "auto" | "antigravity" | "codex" | "claude-code";

export const SUMMARY_CHAIN_VALUES = ["auto", "antigravity", "codex", "claude-code"] as const;

export function resolveSummaryModelChain(
    chain?: SummaryChain,
    modelChain?: SummaryChain,
): SummaryChain {
    return modelChain ?? chain ?? "auto";
}

/** Antigravity LS 链路展示名 */
export const AI_SUMMARY_ANTIGRAVITY_LABEL = "Antigravity LS GetModelResponse";

/** Codex 链路展示名 */
export const AI_SUMMARY_CODEX_LABEL = `${process.env.WEB_FETCHER_CODEX_MODEL || "gpt-5.5"} via Codex CLI`;

/** Claude Code 链路展示名 */
export const AI_SUMMARY_CLAUDE_CODE_LABEL = `${process.env.WEB_FETCHER_CLAUDE_CODE_MODEL || "sonnet"} via Claude Code CLI`;

/** Codex CLI 默认模型 */
export const CODEX_AI_SUMMARY_MODEL = process.env.WEB_FETCHER_CODEX_MODEL || "gpt-5.5";

/** Codex CLI 默认推理强度 */
export const CODEX_AI_SUMMARY_REASONING_EFFORT = process.env.WEB_FETCHER_CODEX_REASONING || "medium";

/** Codex CLI 默认速度档 */
export const CODEX_AI_SUMMARY_SPEED_TIER = process.env.WEB_FETCHER_CODEX_SPEED || "fast";

/** Codex CLI AI Summary 超时 */
export const CODEX_AI_SUMMARY_TIMEOUT = 45000;

/** Claude Code CLI 默认模型 */
export const CLAUDE_CODE_AI_SUMMARY_MODEL = process.env.WEB_FETCHER_CLAUDE_CODE_MODEL || "sonnet";

/** Claude Code CLI 默认推理强度 */
export const CLAUDE_CODE_AI_SUMMARY_EFFORT = process.env.WEB_FETCHER_CLAUDE_CODE_EFFORT || "low";

/** Claude Code CLI AI Summary 超时 */
export const CLAUDE_CODE_AI_SUMMARY_TIMEOUT = Number(process.env.WEB_FETCHER_CLAUDE_CODE_TIMEOUT_MS || 40000);

/** Claude Code CLI 后台任务超时 */
export const CLAUDE_CODE_AI_SUMMARY_BACKGROUND_TIMEOUT = Number(process.env.WEB_FETCHER_CLAUDE_CODE_BACKGROUND_TIMEOUT_MS || 240000);

/** AI Summary prompt 模板 */
export const AI_SUMMARY_PROMPT_TEMPLATE = `请用中文概括以下网页内容，生成一段精炼摘要（500-1000字）。
要求：
1. 保留核心信息和关键数据
2. 保留重要的人名、时间、数字
3. 去除导航、广告、推荐等噪音
4. 结构化输出（标题 + 要点列表）
5. 如果是英文内容，用中文概括但保留关键英文术语

网页标题：{pageTitle}
网页 URL：{url}
网页内容（前\${AI_SUMMARY_MAX_INPUT}字）：
{content}`;

// ========== SPA 懒加载检测 ==========
/** 已知需要滚动触发懒加载的 SPA 站点域名 */
export const SPA_LAZY_LOAD_DOMAINS = [
    'bilibili.com',
    'miyoushe.com',
    'mihoyo.com',
    'xiaohongshu.com',
    'douyin.com',
    'tiktok.com',
    'weibo.com',
    'zhihu.com',
    'taobao.com',
    'jd.com',
    'x.com',
    'twitter.com',
    'reddit.com',
    'instagram.com',
    'threads.net',
    'youtube.com',
    'linkedin.com',
    'facebook.com',
    'notion.so',
    'tencentarena.com',
];

/** SPA 空壳内容检测关键词（页面未加载完成时常见的文本） */
export const SPA_SKELETON_KEYWORDS = [
    'Loading', 'loading', '加载中', '正在加载',
    '页面跳转', '即将跳转', '请稍候', '请等待',
    'skeleton', 'placeholder',
];

/** SPA 空壳内容判定阈值：有效文本低于此字数视为空壳 */
export const SPA_SKELETON_THRESHOLD = 200;

// ========== 智能内容加载检测 (SmartLoad v6.1) ==========

/** SmartLoad: DOM 稳定性检测轮询间隔（毫秒） */
export const SMART_LOAD_CHECK_INTERVAL = 500;

/** SmartLoad: 文本内容变化小于此字符数视为"稳定" */
export const SMART_LOAD_STABILITY_THRESHOLD = 50;

/** SmartLoad: 连续稳定次数达到此值则判定加载完成 */
export const SMART_LOAD_STABLE_CHECKS = 3;

/** SmartLoad: 普通页面最大等待时间（毫秒） */
export const SMART_LOAD_MAX_WAIT_NORMAL = 8000;

/** SmartLoad: SPA 域名额外等待时间（毫秒） */
export const SMART_LOAD_MAX_WAIT_SPA = 15000;

/** SmartLoad: 最小有效内容长度（字符），低于此值不认为加载完成 */
export const SMART_LOAD_MIN_CONTENT_LENGTH = 100;

// ========== 截图视觉就绪检测 (v6.1 Stage 16) ==========

/** VisualReady: 最大等待时间（毫秒），默认 10s */
export const IMAGE_LOAD_MAX_WAIT = 10000;

/** VisualReady: 轮询检测间隔（毫秒） */
export const IMAGE_LOAD_CHECK_INTERVAL = 500;

/** VisualReady: 连续稳定次数（ready 数量不变则判定停滞） */
export const IMAGE_LOAD_STABLE_CHECKS = 2;

/** VisualReady: CSS 背景图最小检测面积（px²），低于此面积跳过 */
export const IMAGE_LOAD_BG_MIN_AREA = 10000;

// ========== 人机验证/拦截检测 (v6.0 UAV) ==========

/**
 * 人机验证/拦截页面检测关键词
 * 覆盖：验证码、Cloudflare 盾、reCAPTCHA、年龄验证、访问拒绝、
 *       地区限制、OAuth 弹窗、DDoS 防护等所有常见人机验证场景
 */
export const HUMAN_VERIFICATION_KEYWORDS = [
    // === 中文验证码 ===
    '验证码', '请完成验证', '请完成下列验证', '请完成下列验证后继续',
    '滑动验证', '拼图验证', '按住左边按钮', '请拖动', '安全验证',
    '人机验证', '请点击', '请通过安全验证', '图形验证',
    // === 英文验证码 ===
    'captcha', 'verify you are human', 'human verification',
    'not a robot', 'prove you are human', 'are you a robot',
    'security check', 'bot detection',
    // === Cloudflare 防护 ===
    'just a moment', 'checking your browser', 'ray id',
    'enable javascript and cookies', 'cloudflare',
    'attention required', 'please wait while we verify',
    // === reCAPTCHA / hCaptcha ===
    'recaptcha', 'hcaptcha', 'select all images',
    'click each image', 'verify you\'re not a robot',
    // === 访问拒绝 / 封锁 ===
    'access denied', '访问被拒绝', '请求被拦截',
    'forbidden', '403 forbidden', 'ip blocked',
    '您的ip', '异常访问', '访问频率过高',
    // === 年龄 / 地区验证 ===
    '请确认您的年龄', 'age verification', 'age gate',
    '年龄确认', 'confirm your age', 'region is not supported',
    // === DDoS 防护 ===
    'ddos protection', 'under attack mode',
    'please stand by', 'checking if the site connection is secure',
    // === 登录墙 / 付费墙 ===
    'sign in to continue', '请登录后继续', '登录后查看',
    '请先登录', 'please log in', 'login required',
    // === v6.1: 短链重定向/等待页 + 抖音/TikTok 特有 ===
    'please wait', '请稍候', '正在跳转', '页面跳转中',
    '请求过于频繁', '操作太频繁', 'too many requests', '429 too many requests', '网络异常',
];

/**
 * 人机验证页面内容长度阈值
 * 验证码/拦截页面通常内容极少（< 500 字）
 * 比 SPA 检测的 200 字更宽松，因为某些拦截页面带有说明文字
 */
export const HUMAN_VERIFICATION_THRESHOLD = 500;
