import { callModelResponse } from "./model-bridge.js";
import type { Chain } from "./chain.js";
import { DEFAULT_ANTIGRAVITY_LS_MODEL } from "./ls-model-defaults.js";

const AUTO_SUMMARY_MODEL = process.env.MEMORY_STORE_AUTOSUMMARY_MODEL || process.env.MEMORY_STORE_LS_MODEL || DEFAULT_ANTIGRAVITY_LS_MODEL;
const AUTO_SUMMARY_TIMEOUT_MS = Number(process.env.MEMORY_STORE_AUTOSUMMARY_TIMEOUT_MS || "30000");

export async function generateAutoSummary(
    title: string,
    tags: string[],
    content: string,
    chain: Chain = "auto",
): Promise<string | null> {
    const truncatedContent = content.length > 6000
        ? content.slice(0, 6000) + "\n\n[内容已截断]"
        : content;

    const prompt = `请为以下记忆生成一段简洁的中文摘要，用于未来快速理解和检索。

要求：
- 80-150 字
- 概括核心内容、关键决策、技术点或问题解决方案
- 不要重复标题
- 直接输出摘要文本，不要加前缀

标题: ${title}
标签: ${tags.join(", ")}

内容:
${truncatedContent}`;

    const result = await callModelResponse(AUTO_SUMMARY_MODEL, prompt, chain, AUTO_SUMMARY_TIMEOUT_MS);
    return result.text?.trim() || null;
}
