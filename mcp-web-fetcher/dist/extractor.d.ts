export type OutputMode = "full" | "compact" | "minimal" | "headings";
/**
 * 检测提取的内容是否为 SPA 空壳（页面未完成加载的空白/框架内容）
 * 返回提示语（如果检测到问题），或 null（内容正常）
 */
export declare function detectSPAIssue(content: string, url: string): string | null;
/**
 * 检测内容是否存在编码乱码（锟斤拷特征）
 * 返回 true 表示检测到严重乱码
 */
export declare function detectEncodingIssue(content: string): boolean;
/**
 * 去除重复的标题块（同标题+同URL视为重复）
 * 适用于B站等网站HTML中存在轮播/预渲染导致的DOM重复
 */
export declare function deduplicateHeadings(content: string): string;
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
export declare function extractContent(html: string, url: string): {
    title: string;
    content: string;
};
/**
 * 清除 footer 垃圾内容（ICP备案、营业执照、举报电话等）
 *
 * 双重策略：
 * 1. 从文本末尾向前扫描，找到连续垃圾区域并截断
 * 2. 全文逐行过滤：短行（<200字）中包含垃圾关键词的行直接删除
 *    （解决 SPA 站点垃圾信息出现在文本中间的问题，如小红书）
 */
export declare function cleanFooterGarbage(content: string): string;
/**
 * 截断过长的内容
 */
export declare function truncateContent(content: string): string;
/**
 * 多挡位紧凑模式内容压缩
 * @param mode - 压缩模式 compact(8000字/3行) | minimal(3000字/1行) | headings(1500字/0行)
 */
export declare function compactContent(content: string, mode?: OutputMode): string;
//# sourceMappingURL=extractor.d.ts.map