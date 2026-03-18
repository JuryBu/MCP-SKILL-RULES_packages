import path from "path";
import os from "os";
/**
 * MCP Web Fetcher 常量配置
 */
// 浏览器用户数据目录 — 独立 profile，不与 browser_subagent 冲突
export const BROWSER_USER_DATA_DIR = path.join(os.homedir(), "AppData", "Local", "ms-playwright", "mcp-web-fetcher-profile");
// Cookie 备份文件 — 保证服务重启后 Cookie 不丢失
export const COOKIES_BACKUP_FILE = path.join(BROWSER_USER_DATA_DIR, "cookies-backup.json");
// 返回内容的最大字符数，防止过大的响应
export const CHARACTER_LIMIT = 50000;
// ========== 多挡位 compact 模式 ==========
// 各挡位字符上限
export const OUTPUT_MODE_LIMITS = {
    compact: 8000, // 日常浏览概览，3行/段
    minimal: 3000, // 只要标题+结构骨架，1行/段
    headings: 1500, // 纯标题大纲，0行/段
};
// 各挡位每段保留行数
export const OUTPUT_MODE_LINES = {
    compact: 3,
    minimal: 1,
    headings: 0,
};
// 默认模式下写到临时文件的摘要预览长度
export const SUMMARY_PREVIEW_LENGTH = 1500;
// 临时文件目录前缀
export const TEMP_PAGE_PREFIX = "mcp-page-";
export const QUALITY_PRESETS = {
    hd: { jpegQuality: 90, viewportWidth: 1920 },
    clear: { jpegQuality: 72, viewportWidth: 1920 },
    default: { jpegQuality: 55, viewportWidth: 1280 },
    compact: { jpegQuality: 42, viewportWidth: 1280 }, // 1024→1280: 防止中文网站右侧截断
    fast: { jpegQuality: 30, viewportWidth: 1024 }, // 800→1024: 避免触发移动端布局
};
// 向后兼容：默认 JPEG 质量
export const SCREENSHOT_QUALITY = QUALITY_PRESETS.default.jpegQuality;
// 截图 MIME 类型
export const SCREENSHOT_MIME_TYPE = "image/jpeg";
// ========== 页面加载配置 ==========
// 默认页面加载超时（毫秒）
export const DEFAULT_TIMEOUT = 30000;
// 默认 User-Agent
export const DEFAULT_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36";
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
export function appendTiming(result, startTime, retries = 0) {
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
];
/** SPA 空壳内容检测关键词（页面未加载完成时常见的文本） */
export const SPA_SKELETON_KEYWORDS = [
    'Loading', 'loading', '加载中', '正在加载',
    '页面跳转', '即将跳转', '请稍候', '请等待',
    'skeleton', 'placeholder',
];
/** SPA 空壳内容判定阈值：有效文本低于此字数视为空壳 */
export const SPA_SKELETON_THRESHOLD = 200;
//# sourceMappingURL=constants.js.map