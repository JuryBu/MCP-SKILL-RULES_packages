import fs from "fs";
import type { ImageContent, TextContent } from "@modelcontextprotocol/sdk/types.js";
import { inlineImageContent, assertInlineImageBudget } from "./image-output.js";

export async function inspectionContent(response: unknown, saveMode?: "inline" | "file", generatedPaths: readonly string[] = []) {
    let budgetOmissions = 0;
    function countOmissions(value: unknown) {
        if (Array.isArray(value)) { for (const item of value) countOmissions(item); return; }
        if (!value || typeof value !== "object") return;
        const fields = value as Record<string, unknown>;
        if (fields.screenshotStatus === "budget_exceeded") budgetOmissions += 1;
        for (const item of Object.values(fields)) countOmissions(item);
    }
    countOmissions(response);
    const omittedMessage = budgetOmissions ? `${budgetOmissions} 个问题未生成截图：达到检查截图预算；报告已保留，请缩小检查范围。` : "";
    if (saveMode === "file") {
        return { content: [{ type: "text" as const, text: JSON.stringify(response, null, 2) },
            ...(omittedMessage ? [{ type: "text" as const, text: omittedMessage }] : [])], ...(budgetOmissions ? { isError: true } : {}) };
    }
    const references = new Map<string, string>();
    const allowed = new Set(generatedPaths);
    function withImageReferences(value: unknown): unknown {
        if (Array.isArray(value)) return value.map(withImageReferences);
        if (!value || typeof value !== "object") return value;
        return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
            if (key !== "screenshotPath" || typeof entry !== "string" || !entry) {
                return [key, withImageReferences(entry)];
            }
            if (!allowed.has(entry)) return [key, entry];
            const reference = references.get(entry) ?? `截图 ${references.size + 1}`;
            references.set(entry, reference);
            return ["screenshotRef", reference];
        }));
    }
    const serialized = JSON.stringify(withImageReferences(response), null, 2);
    const content: Array<TextContent | ImageContent> = [{ type: "text", text: serialized }];
    const errors: string[] = [];
    for (const [filePath, label] of references) {
        try {
            const images = await inlineImageContent(await fs.promises.readFile(filePath), label);
            assertInlineImageBudget([...content, ...images]);
            content.push(...images);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            errors.push(`${label} 未附加：${message.replaceAll(filePath, label)}`);
        }
    }
    if (errors.length) {
        content.push({ type: "text", text: `报告已保留，但有 ${errors.length} 张截图未交付。请缩小 page 范围，或显式设置 saveMode="file"。\n${errors.join("\n")}` });
    }
    if (omittedMessage) content.push({ type: "text", text: omittedMessage });
    return { content, ...((errors.length || budgetOmissions) ? { isError: true } : {}) };
}
