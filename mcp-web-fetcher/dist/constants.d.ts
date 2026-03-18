/**
 * MCP Web Fetcher 常量配置
 */
export declare const BROWSER_USER_DATA_DIR: string;
export declare const COOKIES_BACKUP_FILE: string;
export declare const CHARACTER_LIMIT = 50000;
export declare const OUTPUT_MODE_LIMITS: {
    readonly compact: 8000;
    readonly minimal: 3000;
    readonly headings: 1500;
};
export declare const OUTPUT_MODE_LINES: {
    readonly compact: 3;
    readonly minimal: 1;
    readonly headings: 0;
};
export declare const SUMMARY_PREVIEW_LENGTH = 1500;
export declare const TEMP_PAGE_PREFIX = "mcp-page-";
export type ImageQuality = "hd" | "clear" | "default" | "compact" | "fast";
export interface QualityConfig {
    jpegQuality: number;
    viewportWidth: number;
}
export declare const QUALITY_PRESETS: Record<ImageQuality, QualityConfig>;
export declare const SCREENSHOT_QUALITY: number;
export declare const SCREENSHOT_MIME_TYPE = "image/jpeg";
export type SaveMode = "file" | "inline";
export declare const DEFAULT_TIMEOUT = 30000;
export declare const DEFAULT_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36";
export declare const ANTI_BOT_DELAY_MIN = 500;
export declare const ANTI_BOT_DELAY_MAX = 1500;
export declare const DOMAIN_REQUEST_COOLDOWN = 3000;
export declare const HIGH_RISK_DOMAINS: string[];
export declare const HIGH_RISK_DELAY_MIN = 1500;
export declare const HIGH_RISK_DELAY_MAX = 3500;
export declare const BROWSER_ACCEPT_HEADERS: {
    Accept: string;
    'Accept-Language': string;
    DNT: string;
    'Upgrade-Insecure-Requests': string;
};
export declare const FOOTER_GARBAGE_PATTERNS: string[];
/**
 * 在工具返回结果的文本内容中追加耗时和重试信息
 * @param result MCP 工具返回值
 * @param startTime Date.now() 起始时间
 * @param retries 重试次数（0=无重试）
 */
export declare function appendTiming(result: any, startTime: number, retries?: number): any;
/** AI Summary 输入文本最大长度（字符）— 避免 prompt 过长 */
export declare const AI_SUMMARY_MAX_INPUT = 12000;
/** AI Summary prompt 模板 */
export declare const AI_SUMMARY_PROMPT_TEMPLATE = "\u8BF7\u7528\u4E2D\u6587\u6982\u62EC\u4EE5\u4E0B\u7F51\u9875\u5185\u5BB9\uFF0C\u751F\u6210\u4E00\u6BB5\u7CBE\u70BC\u6458\u8981\uFF08500-1000\u5B57\uFF09\u3002\n\u8981\u6C42\uFF1A\n1. \u4FDD\u7559\u6838\u5FC3\u4FE1\u606F\u548C\u5173\u952E\u6570\u636E\n2. \u4FDD\u7559\u91CD\u8981\u7684\u4EBA\u540D\u3001\u65F6\u95F4\u3001\u6570\u5B57\n3. \u53BB\u9664\u5BFC\u822A\u3001\u5E7F\u544A\u3001\u63A8\u8350\u7B49\u566A\u97F3\n4. \u7ED3\u6784\u5316\u8F93\u51FA\uFF08\u6807\u9898 + \u8981\u70B9\u5217\u8868\uFF09\n5. \u5982\u679C\u662F\u82F1\u6587\u5185\u5BB9\uFF0C\u7528\u4E2D\u6587\u6982\u62EC\u4F46\u4FDD\u7559\u5173\u952E\u82F1\u6587\u672F\u8BED\n\n\u7F51\u9875\u6807\u9898\uFF1A{pageTitle}\n\u7F51\u9875 URL\uFF1A{url}\n\u7F51\u9875\u5185\u5BB9\uFF08\u524D${AI_SUMMARY_MAX_INPUT}\u5B57\uFF09\uFF1A\n{content}";
/** 已知需要滚动触发懒加载的 SPA 站点域名 */
export declare const SPA_LAZY_LOAD_DOMAINS: string[];
/** SPA 空壳内容检测关键词（页面未加载完成时常见的文本） */
export declare const SPA_SKELETON_KEYWORDS: string[];
/** SPA 空壳内容判定阈值：有效文本低于此字数视为空壳 */
export declare const SPA_SKELETON_THRESHOLD = 200;
//# sourceMappingURL=constants.d.ts.map