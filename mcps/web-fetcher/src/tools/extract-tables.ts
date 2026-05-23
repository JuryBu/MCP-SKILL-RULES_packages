import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { browserManager } from "../browser.js";
import { touchActivity } from "../lifecycle.js";
import { appendTiming } from "../constants.js";
import { saveTempFile, generateCacheKey } from "../temp-store.js";

const ExtractTablesInputSchema = z.object({
    url: z
        .string()
        .refine(s => /^(https?|file):\/\//i.test(s), "请提供有效的 URL")
        .describe("要提取表格的网页 URL"),
    selector: z
        .string()
        .optional()
        .describe("可选 CSS 选择器，只从指定区域提取表格"),
    format: z
        .enum(["markdown", "csv", "json"])
        .optional()
        .default("markdown")
        .describe("输出格式: markdown(默认) / csv / json"),
    timeout: z
        .number()
        .int()
        .min(1000)
        .max(120000)
        .optional()
        .describe("超时毫秒数，默认 30000"),
    scrollCount: z
        .number()
        .int()
        .min(0)
        .max(20)
        .optional()
        .describe("提取前滚动次数，默认 0"),
});

type ExtractTablesInput = z.infer<typeof ExtractTablesInputSchema>;

export function registerExtractTables(server: McpServer): void {
    server.registerTool(
        "web_extract_tables",
        {
            title: "提取网页表格",
            description: `智能识别并提取网页中的 HTML 表格。

支持输出为 Markdown 表格、CSV 或 JSON 格式。
适合从网页报表、数据页面中批量提取结构化数据。

参数:
  - url (string, 必须): 要提取表格的网页 URL（支持 http/https/file 协议）
  - selector (string, 可选): CSS 选择器，只从指定区域提取
  - format (string, 可选): 输出格式 markdown/csv/json，默认 markdown
  - timeout (number, 可选): 超时毫秒数，默认 30000
  - scrollCount (number, 可选): 提取前滚动次数，默认 0

返回: 提取的表格数据（完整数据保存到文件，返回每表预览：表头+前3行）`,
            inputSchema: {
                url: ExtractTablesInputSchema.shape.url,
                selector: ExtractTablesInputSchema.shape.selector,
                format: ExtractTablesInputSchema.shape.format,
                timeout: ExtractTablesInputSchema.shape.timeout,
                scrollCount: ExtractTablesInputSchema.shape.scrollCount,
            },
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: true,
            },
        },
        async (params: ExtractTablesInput) => {
            touchActivity();
            const startTime = Date.now();

            let page;
            try {
                page = await browserManager.navigateTo(params.url, {
                    waitFor: params.selector,
                    timeout: params.timeout,
                    scrollCount: params.scrollCount,
                });

                // 在浏览器中提取所有表格数据
                const tables = await page.evaluate((selector?: string) => {
                    const container = selector
                        ? document.querySelector(selector) || document.body
                        : document.body;

                    const tableElements = container.querySelectorAll("table");
                    const results: Array<{
                        index: number;
                        caption: string;
                        headers: string[];
                        rows: string[][];
                        rowCount: number;
                        colCount: number;
                    }> = [];

                    for (let t = 0; t < tableElements.length; t++) {
                        const table = tableElements[t];

                        // 跳过隐藏或极小的表格
                        const rect = table.getBoundingClientRect();
                        if (rect.width < 50 || rect.height < 20) continue;

                        // 获取表格标题
                        const captionEl = table.querySelector("caption");
                        const caption = captionEl?.textContent?.trim() || "";

                        // 提取表头
                        const headers: string[] = [];
                        const headerRow = table.querySelector("thead tr") || table.querySelector("tr");
                        if (headerRow) {
                            const ths = headerRow.querySelectorAll("th, td");
                            ths.forEach(th => headers.push((th as HTMLElement).innerText?.trim() || ""));
                        }

                        // 提取数据行
                        const rows: string[][] = [];
                        const bodyRows = table.querySelectorAll("tbody tr, tr");
                        const startIdx = headerRow && !table.querySelector("thead") ? 1 : 0;

                        for (let r = startIdx; r < bodyRows.length; r++) {
                            const row = bodyRows[r];
                            // 跳过 thead 中的行
                            if (row.closest("thead")) continue;

                            const cells: string[] = [];
                            const tds = row.querySelectorAll("td, th");
                            tds.forEach(td => cells.push((td as HTMLElement).innerText?.trim() || ""));

                            if (cells.length > 0 && cells.some(c => c.length > 0)) {
                                rows.push(cells);
                            }
                        }

                        if (rows.length > 0 || headers.length > 0) {
                            const colCount = Math.max(headers.length, ...rows.map(r => r.length));
                            results.push({
                                index: t + 1,
                                caption,
                                headers,
                                rows,
                                rowCount: rows.length,
                                colCount,
                            });
                        }
                    }

                    return results;
                }, params.selector);

                if (tables.length === 0) {
                    return appendTiming({
                        content: [{ type: "text" as const, text: "未找到任何表格。" }],
                    }, startTime, browserManager.lastRetryCount);
                }

                const format = params.format || "markdown";

                // 格式化完整数据（纯数据，不含 Markdown 标题）
                const formatted = tables.map(table => {
                    const title = table.caption
                        ? `### 表格 ${table.index}: ${table.caption}`
                        : `### 表格 ${table.index}`;
                    const meta = `${table.rowCount} 行 × ${table.colCount} 列`;

                    if (format === "csv") {
                        return formatCsv(table);
                    } else if (format === "json") {
                        return formatJson(table);
                    } else {
                        return formatMarkdown(title, meta, table);
                    }
                });

                // 保存文件：CSV/JSON 用纯数据分隔符，Markdown 用标题分隔
                let fullContent: string;
                if (format === "csv") {
                    fullContent = formatted.join("\n"); // CSV: 空行分隔多表
                } else if (format === "json") {
                    // JSON: 合并为数组
                    const allData = tables.map(table => {
                        if (table.headers.length > 0) {
                            return table.rows.map(row => {
                                const obj: Record<string, string> = {};
                                table.headers.forEach((h, i) => {
                                    obj[h || `col_${i + 1}`] = row[i] || "";
                                });
                                return obj;
                            });
                        }
                        return table.rows;
                    });
                    fullContent = JSON.stringify(allData.length === 1 ? allData[0] : allData, null, 2);
                } else {
                    fullContent = `# 表格提取结果\n\n共找到 ${tables.length} 个表格\n\n` + formatted.join("\n\n---\n\n");
                }
                const ext = format === "csv" ? ".csv" : format === "json" ? ".json" : ".md";
                const cacheKey = generateCacheKey(params.url, "tables", format);
                const filePath = saveTempFile("pages", cacheKey, ext, fullContent);

                // 生成摘要预览（每表: 表头 + 前3行）
                const PREVIEW_ROWS = 3;
                const previews = tables.map(table => {
                    const title = table.caption
                        ? `**表格 ${table.index}: ${table.caption}** (${table.rowCount}行 × ${table.colCount}列)`
                        : `**表格 ${table.index}** (${table.rowCount}行 × ${table.colCount}列)`;

                    const pad = (arr: string[], len: number) => {
                        while (arr.length < len) arr.push("");
                        return arr.slice(0, len);
                    };

                    const headers = pad([...table.headers], table.colCount);
                    let preview = `${title}\n`;
                    preview += `| ${headers.map(h => h || " ").join(" | ")} |\n`;
                    preview += `| ${headers.map(() => "---").join(" | ")} |\n`;

                    const previewRows = table.rows.slice(0, PREVIEW_ROWS);
                    for (const row of previewRows) {
                        const cells = pad([...row], table.colCount);
                        preview += `| ${cells.map(c => c.replace(/\|/g, "\\|").replace(/\n/g, " ").slice(0, 60)).join(" | ")} |\n`;
                    }
                    if (table.rowCount > PREVIEW_ROWS) {
                        preview += `| ... | (省略 ${table.rowCount - PREVIEW_ROWS} 行) |\n`;
                    }
                    return preview;
                });

                const summary = `📊 提取了 ${tables.length} 个表格 → ${filePath}\n\n${previews.join("\n")}\n完整数据: ${filePath}`;

                return appendTiming({
                    content: [{ type: "text" as const, text: summary }],
                }, startTime, browserManager.lastRetryCount);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                return {
                    isError: true,
                    content: [{ type: "text" as const, text: `表格提取失败: ${message}` }],
                };
            } finally {
                if (page) await page.close().catch(() => { });
            }
        }
    );
}

function formatMarkdown(
    title: string, meta: string,
    table: { headers: string[]; rows: string[][]; colCount: number }
): string {
    let output = `${title}\n*${meta}*\n\n`;

    // 确保所有行都有统一列数
    const pad = (arr: string[], len: number) => {
        while (arr.length < len) arr.push("");
        return arr.slice(0, len);
    };

    const headers = pad([...table.headers], table.colCount);
    output += `| ${headers.map(h => h || " ").join(" | ")} |\n`;
    output += `| ${headers.map(() => "---").join(" | ")} |\n`;

    for (const row of table.rows) {
        const cells = pad([...row], table.colCount);
        output += `| ${cells.map(c => c.replace(/\|/g, "\\|").replace(/\n/g, " ")).join(" | ")} |\n`;
    }

    return output;
}

function formatCsv(
    table: { headers: string[]; rows: string[][] }
): string {
    let output = "";
    const escape = (s: string) => {
        if (s.includes(",") || s.includes('"') || s.includes("\n")) {
            return `"${s.replace(/"/g, '""')}"`;
        }
        return s;
    };

    if (table.headers.length > 0) {
        output += table.headers.map(escape).join(",") + "\n";
    }
    for (const row of table.rows) {
        output += row.map(escape).join(",") + "\n";
    }
    return output;
}

function formatJson(
    table: { headers: string[]; rows: string[][] }
): string {
    if (table.headers.length > 0) {
        const objects = table.rows.map(row => {
            const obj: Record<string, string> = {};
            table.headers.forEach((h, i) => {
                obj[h || `col_${i + 1}`] = row[i] || "";
            });
            return obj;
        });
        return JSON.stringify(objects, null, 2);
    }
    return JSON.stringify(table.rows, null, 2);
}
