// Record 生成引擎 —— Prompt 构造函数。
// 由 record-generator.ts 拆分而来（E2-B2），纯结构搬运、零行为变更。
import type { RecordPatch, LocalComposeBoundary, LocalComposeDelta } from "./record-types.js";

// ============= Prompt 模板 =============

export function buildNewRecordPrompt(
    conversationId: string,
    workspace: string,
    totalRounds: number,
    totalSteps: number,
    conversationContent: string,
): string {
    return `你是一个技术文档助手。请根据以下对话内容，按固定模板生成一份对话记录（Record）。

## 模板要求

1. 开头元数据：对话ID、工作区、时间跨度、总轮次/步骤/工具调用数
2. 按主题/任务切换点将对话划分为多个 Phase
3. 每个 Phase 包含：标题（含轮次范围）、时间、用户操作、AI执行、关键决策、产出文件（如有）
4. 末尾：产出文件总清单（如有）+ 经验教训
5. 输出纯 markdown，不要用 \`\`\` 代码块包裹整个输出
6. Phase 标题格式：## Phase N：{标题}（轮次 X-Y）
7. 在 Record 最末尾单独一行输出标签，格式：<!-- TAGS: 标签1, 标签2, 标签3 -->
   标签 5-10 个，包含：项目名、核心技术栈、关键事件、模型/工具名等
8. “对话ID”“工作区”“总轮次”“总步骤”必须逐字使用下方“对话元数据”，不要根据正文猜测或改写；如需记录其它路径，可另写“关联工作区”或“相关文件”

## 对话元数据

- 对话ID: ${conversationId}
- 工作区: ${workspace}
- 总轮次: ${totalRounds}
- 总步骤: ${totalSteps}

## 对话内容

${conversationContent}`;
}

export function buildUpdateRecordPrompt(
    conversationId: string,
    workspace: string,
    totalRounds: number,
    totalSteps: number,
    existingRecord: string,
    newContent: string,
): string {
    return `你是一个技术文档助手。以下是一个对话的已有 Record 和新增内容。
请基于已有 Record 和新增对话内容，更新并输出完整的 Record。

## 重要规则

1. 保持固定模板格式（Phase 结构）
2. 已有 Record 中标记了 "[手动补充]" 的内容必须保留
3. 根据新增内容合理扩展或新增 Phase
4. 输出完整的 Record（不是增量，是全文）
5. 输出纯 markdown，不要用 \`\`\` 代码块包裹整个输出
6. 在 Record 最末尾单独一行输出标签：<!-- TAGS: 标签1, 标签2, 标签3 -->
   标签 5-10 个，包含：项目名、核心技术栈、关键事件等
7. “对话ID”“工作区”“总轮次”“总步骤”必须逐字使用下方“对话元数据”，不要根据正文猜测或改写；如需记录其它路径，可另写“关联工作区”或“相关文件”

## 对话元数据

- 对话ID: ${conversationId}
- 工作区: ${workspace}
- 总轮次: ${totalRounds}
- 总步骤: ${totalSteps}

## 现有 Record

${existingRecord}

## 新增对话内容

${newContent}`;
}

export function buildRecordPatchPrompt(
    conversationId: string,
    workspace: string,
    totalRounds: number,
    totalSteps: number,
    recordSummary: string,
    chunkText: string,
    adjacentContext: string,
    startRound: number,
    endRound: number,
): string {
    return `你是一个技术文档助手。请把指定轮次区段整理为 RecordPatch 草稿。

## 输出格式

先输出一个 JSON 代码块，再输出 Markdown 草稿。

\`\`\`json
{
  "startRound": ${startRound},
  "endRound": ${endRound},
  "title": "本区段标题",
  "files": ["主要产出文件路径"],
  "tags": ["标签"],
  "risks": ["风险或失败点"],
  "status": "ok"
}
\`\`\`

## Phase Draft

用现有 Record 的 Phase 风格，写本区段应该纳入完整 Record 的草稿。只覆盖第 ${startRound}-${endRound} 轮，不要生成完整 Record，不要改写其它轮次。

## 对话元数据

- 对话ID: ${conversationId}
- 工作区: ${workspace}
- 总轮次: ${totalRounds}
- 总步骤: ${totalSteps}

## 旧 Record 结构摘要

${recordSummary || "(无旧 Record)"}

## 相邻轮次上下文（只用于理解边界，不要覆盖这些轮次）

${adjacentContext || "(无相邻上下文)"}

## 当前区段正文（必须覆盖）

${chunkText}`;
}

export function buildReduceRecordPrompt(
    conversationId: string,
    workspace: string,
    totalRounds: number,
    totalSteps: number,
    existingRecord: string,
    patches: RecordPatch[],
): string {
    const patchText = patches
        .sort((a, b) => a.startRound - b.startRound)
        .map((patch, index) => {
            const meta = {
                startRound: patch.startRound,
                endRound: patch.endRound,
                title: patch.title,
                files: patch.files,
                tags: patch.tags,
                risks: patch.risks,
                status: patch.status,
            };
            return `### Patch ${index + 1}\n\n\`\`\`json\n${JSON.stringify(meta, null, 2)}\n\`\`\`\n\n${patch.markdown}`;
        })
        .join("\n\n---\n\n");

    return `你是一个技术文档助手。以下是已有 Record 和多个并行生成的 RecordPatch 草稿。
请整合所有 Patch，输出完整更新后的 Record。

## 重要规则

1. 输出完整 Record，不是增量
2. 保持 Phase 模板和轮次范围
3. 合并相邻或重复主题，避免重复文件清单
4. 保留已有 Record 中标记为 "[手动补充]" 的内容
5. 末尾输出标签：<!-- TAGS: 标签1, 标签2, 标签3 -->
6. 输出纯 markdown，不要用代码块包裹整个输出
7. 不要为了缩短篇幅而删除已有 Record 的关键 Phase 细节；已有 Phase 的任务、文件、验证和风险应尽量保留
8. 新增 Patch 可以压缩表达，但最终 Record 不能退化成只剩总览

## 对话元数据

- 对话ID: ${conversationId}
- 工作区: ${workspace}
- 总轮次: ${totalRounds}
- 总步骤: ${totalSteps}

## 现有 Record

${existingRecord || "(无旧 Record)"}

## RecordPatch 草稿

${patchText}`;
}

export function buildCompressRecordPatchesPrompt(
    conversationId: string,
    workspace: string,
    totalRounds: number,
    totalSteps: number,
    patches: RecordPatch[],
    groupIndex: number,
    totalGroups: number,
): string {
    const startRound = patches[0]?.startRound ?? 0;
    const endRound = patches[patches.length - 1]?.endRound ?? startRound;
    const patchText = patches
        .sort((a, b) => a.startRound - b.startRound)
        .map((patch, index) => {
            const meta = {
                startRound: patch.startRound,
                endRound: patch.endRound,
                title: patch.title,
                files: patch.files,
                tags: patch.tags,
                risks: patch.risks,
                status: patch.status,
            };
            return `### Patch ${index + 1}\n\n\`\`\`json\n${JSON.stringify(meta, null, 2)}\n\`\`\`\n\n${patch.markdown}`;
        })
        .join("\n\n---\n\n");

    return `你是一个技术文档助手。请把多个 RecordPatch 草稿压缩为一个中间 RecordPatch。

## 输出格式

先输出一个 JSON 代码块，再输出 Markdown 草稿。

\`\`\`json
{
  "startRound": ${startRound},
  "endRound": ${endRound},
  "title": "本组标题",
  "files": ["主要产出文件路径"],
  "tags": ["标签"],
  "risks": ["风险或失败点"],
  "status": "ok"
}
\`\`\`

## Phase Draft

合并本组 Patch 的重复内容，保留关键决策、文件、风险、验证结果和未完成事项。只覆盖第 ${startRound}-${endRound} 轮，不要生成完整 Record。

## 对话元数据

- 对话ID: ${conversationId}
- 工作区: ${workspace}
- 总轮次: ${totalRounds}
- 总步骤: ${totalSteps}
- 当前组: ${groupIndex + 1}/${totalGroups}

## RecordPatch 草稿

${patchText}`;
}

export function buildLocalComposePrompt(
    conversationId: string,
    workspace: string,
    totalRounds: number,
    totalSteps: number,
    stableEndRound: number,
    rewriteStartRound: number,
    rollbackPhaseText: string,
    oldTail: string,
    manualSupplementSnippets: string[],
    patches: RecordPatch[],
): string {
    const patchText = patches
        .sort((a, b) => a.startRound - b.startRound)
        .map((patch, index) => {
            const meta = {
                startRound: patch.startRound,
                endRound: patch.endRound,
                title: patch.title,
                files: patch.files,
                tags: patch.tags,
                risks: patch.risks,
                status: patch.status,
            };
            return `### Patch ${index + 1}\n\n\`\`\`json\n${JSON.stringify(meta, null, 2)}\n\`\`\`\n\n${patch.markdown}`;
        })
        .join("\n\n---\n\n");
    const manualText = manualSupplementSnippets.length > 0
        ? manualSupplementSnippets.map((snippet, index) => `${index + 1}. ${snippet}`).join("\n")
        : "(无手动补充)";

    return `你是一个技术文档助手。请输出 Record 的结构化增量，不要输出完整 Record。

## 重要规则

1. 只生成第 ${rewriteStartRound}-${totalRounds} 轮附近的衔接 Phase、新增 Phase 和新版尾部。
2. 不要复述稳定区旧 Phase；稳定区已由代码原样保留到第 ${stableEndRound} 轮。
3. 回滚 Phase 可以被延展、拆分、改名或与新增 Phase 合并，但不能丢失其中关键文件、验证、风险和结论。
4. 新增 Patch 边界要自然合并，不要保留“本批开始/本批结束”这类中间痕迹。
5. tailMarkdown 生成新版产出文件总清单、经验教训、风险/后续建议等结尾内容。
6. 输出一个 JSON 代码块，JSON 字段必须包含 rewriteStartRound、rewriteEndRound、phaseMarkdown、tailMarkdown、tags、warnings。
7. phaseMarkdown 内的 Phase 轮次必须按顺序连续覆盖 ${rewriteStartRound}-${totalRounds}，不要互相重叠，也不要留下断档；如果多个 Patch 覆盖同一阶段，请合并成一个更大的 Phase，而不是写成多个重叠 Phase。
8. 每个 Phase 标题只保留最终自然阶段名，不要保留 Patch 编号、批次编号或“压缩区段”字样。
9. 下方“必须保留的手动补充”必须原文出现在 phaseMarkdown 或 tailMarkdown 中，不得改写、摘要或删除。

## 输出格式

\`\`\`json
{
  "rewriteStartRound": ${rewriteStartRound},
  "rewriteEndRound": ${totalRounds},
  "phaseMarkdown": "## Phase ...",
  "tailMarkdown": "# 产出文件总清单\\n...",
  "tags": ["标签"],
  "warnings": []
}
\`\`\`

## 对话元数据

- 对话ID: ${conversationId}
- 工作区: ${workspace}
- 总轮次: ${totalRounds}
- 总步骤: ${totalSteps}
- 稳定区已覆盖到: ${stableEndRound}
- 需要重写起点: ${rewriteStartRound}

## 旧 Record 回滚 Phase（需要自然衔接）

${rollbackPhaseText || "(无回滚 Phase)"}

## 旧 Record 尾部（用于更新新版尾部）

${oldTail || "(无旧尾部)"}

## 必须保留的手动补充

${manualText}

## 新增/压缩后的 RecordPatch

${patchText}`;
}

export function buildLocalComposeRepairPrompt(
    totalRounds: number,
    boundary: LocalComposeBoundary,
    delta: LocalComposeDelta,
    errors: string[],
    manualSupplementSnippets: string[] = [],
): string {
    const manualText = manualSupplementSnippets.length > 0
        ? manualSupplementSnippets.map((snippet, index) => `${index + 1}. ${snippet}`).join("\n")
        : "(无手动补充)";
    return `你是一个技术文档助手。下面是一份 Record 结构化增量，质量检查发现 Phase 轮次范围或结构有问题。请只修复增量 JSON，不要输出完整 Record。

## 必须修复的问题

${errors.map((error, index) => `${index + 1}. ${error}`).join("\n")}

## 修复规则

1. phaseMarkdown 必须从第 ${boundary.rewriteStartRound} 轮开始，覆盖到第 ${totalRounds} 轮。
2. Phase 按顺序排列，后一 Phase 的开始轮次必须晚于前一 Phase 的结束轮次；不要写 48-58 后又写 51-58 这类重叠范围。
3. 如果多个 Phase 在语义上属于并行/交叠工作，请合并、改名或拆成连续区间，优先保证范围连续和不重叠。
4. 保留原增量里的关键文件、验证结果、风险、经验和结论。
5. tailMarkdown 与 tags 可沿用原内容，但仍要保持唯一尾部和唯一标签语义。
6. 只输出一个 JSON 代码块，字段仍是 rewriteStartRound、rewriteEndRound、phaseMarkdown、tailMarkdown、tags、warnings。
7. 下方“必须保留的手动补充”必须原文出现在 phaseMarkdown 或 tailMarkdown 中，不得改写、摘要或删除。

## 必须保留的手动补充

${manualText}

## 原增量 JSON

\`\`\`json
${JSON.stringify(delta, null, 2)}
\`\`\``;
}

/** 构造逐段压缩用的聚焦 prompt。 */
export function buildRoundPartCompressionPrompt(
    roundIndex: number,
    startStep: number,
    endStep: number,
    partOrder: number,
    partTotal: number,
    prevSummary: string,
    partText: string,
): string {
    const prevBlock = prevSummary
        ? `前一段（已压缩）摘要，供你衔接上下文、避免重复：\n${prevSummary}\n\n`
        : "（这是第一段，无前序摘要）\n\n";
    return [
        `你在压缩一个超长对话轮（轮次 ${roundIndex}）的第 ${partOrder}/${partTotal} 段（覆盖 steps ${startStep}-${endStep}）。`,
        `目标：把本段压缩成简洁的纯文本摘要，保留关键操作、涉及的文件、执行的命令、得出的结论、出现的报错；删除冗余的进度条、重复日志、无信息量的刷屏。`,
        `要求：`,
        `- 只输出本段的纯文本摘要，不要复述前一段内容。`,
        `- 不要添加任何 Markdown 标题（不要出现 ## / ### 等），不要输出 JSON、代码围栏或额外说明。`,
        `- 保留具体的文件路径、命令、错误信息原文（可适度精简但不要捏造）。`,
        ``,
        prevBlock,
        `===== 本段原文（steps ${startStep}-${endStep}）开始 =====`,
        partText,
        `===== 本段原文结束 =====`,
    ].join("\n");
}

export function summarizeClosedPhasesOutline(closedPhaseMarkdown: string[]): string {
    if (closedPhaseMarkdown.length === 0) return "(还没有已收尾的 Phase)";
    const lines: string[] = [];
    for (const md of closedPhaseMarkdown) {
        const titleMatch = md.match(/^##\s*Phase\b[^\n]*/imu);
        if (titleMatch) lines.push(titleMatch[0].trim());
    }
    return lines.length > 0 ? lines.join("\n") : "(已收尾 Phase 标题解析失败)";
}

export function summarizePatchForStep(patches: RecordPatch[]): string {
    return patches
        .sort((a, b) => a.startRound - b.startRound)
        .map((patch, idx) => {
            const meta = {
                startRound: patch.startRound,
                endRound: patch.endRound,
                title: patch.title,
                files: patch.files,
                tags: patch.tags,
                risks: patch.risks,
                status: patch.status,
            };
            return `### Patch ${idx + 1}\n\n\`\`\`json\n${JSON.stringify(meta, null, 2)}\n\`\`\`\n\n${patch.markdown}`;
        })
        .join("\n\n---\n\n");
}

export function buildSerialComposeStepPrompt(
    conversationId: string,
    workspace: string,
    totalRounds: number,
    totalSteps: number,
    rewriteStartRound: number,
    windowStartRound: number,
    windowEndRound: number,
    closedOutline: string,
    openPhaseSnippet: string,
    windowPatches: RecordPatch[],
    rollbackContext: string,
    manualSupplementSnippets: string[],
    isFirstWindow: boolean,
    isLastWindow: boolean,
): string {
    const patchText = summarizePatchForStep(windowPatches);
    const manualText = manualSupplementSnippets.length > 0
        ? manualSupplementSnippets.map((snippet, index) => `${index + 1}. ${snippet}`).join("\n")
        : "(无手动补充)";
    return `你是一个技术文档助手，正在串行累积一段长 Record 的重写区（第 ${rewriteStartRound}-${totalRounds} 轮）。请只输出本子窗口（第 ${windowStartRound}-${windowEndRound} 轮）的衔接增量。

## 关键规则

1. 你的输出 phases 字段是若干 Phase 的结构化数组，覆盖本子窗口的轮次范围。每个 phase 都要给完整 markdown 段（含 \`## Phase ?：自然阶段名（轮次 X-Y）\` 标题；Phase 编号写 ? 即可，最终编号由代码统一重排）。
2. ${isFirstWindow ? '本子窗口是重写区起点' : '上一步可能留下了一个「未收尾的 Phase」（见下方），请判断它是否应被你延续/合并到本窗口的第一个 Phase；若是，请把延续后的完整 markdown 放进 phases[0]（含历史已写部分），并把覆盖轮次设为「未收尾 Phase 的 startRound」到本子窗口该 Phase 实际结束的 endRound。'}
3. 若本子窗口最后一个自然阶段尚未在 ${windowEndRound} 轮自然结束（可能延伸到后续轮次），把它标记为 \`open: true\`。\`open: true\` 表示后续窗口可能续写它。其余 Phase 一律 \`open: false\`。
4. ${isLastWindow ? '这是最后一个子窗口，所有 phase 都应 `open: false`（必须把所有阶段收尾，覆盖到第 ' + totalRounds + ' 轮）。' : '不要在本步生成全局尾部（产出文件总清单/经验教训等），那个由后续单独步骤处理。'}
5. 不要生成"本批开始/本批结束/RecordPatch 编号/压缩区段"这类中间痕迹，只保留自然阶段名。
6. 多个 Patch 若属于同一阶段，请合并；轮次范围必须连续不重叠（按 startRound..endRound）；不要给同一阶段拆成多个重叠 Phase。
7. ${manualSupplementSnippets.length > 0 ? '"必须保留的手动补充"中与本子窗口相关的条目必须原文出现在某个 Phase 的 markdown 中。' : ''}

## 输出格式（必须是 JSON 代码块）

\`\`\`json
{
  "phases": [
    {
      "title": "自然阶段名",
      "startRound": ${windowStartRound},
      "endRound": ${windowEndRound},
      "open": false,
      "markdown": "## Phase ?：自然阶段名（轮次 X-Y）\\n\\n- 要点..."
    }
  ],
  "warnings": []
}
\`\`\`

## 对话元数据

- 对话ID: ${conversationId}
- 工作区: ${workspace}
- 总轮次: ${totalRounds}
- 总步骤: ${totalSteps}
- 重写区起点: ${rewriteStartRound}
- 本子窗口轮次范围: ${windowStartRound}-${windowEndRound}
- 是否首窗口: ${isFirstWindow}
- 是否末窗口: ${isLastWindow}

## 已收尾 Phase 提纲（不要重复其内容）

${closedOutline}

${openPhaseSnippet ? `## 上一步留下的未收尾 Phase（请判断是否延续/合并到本窗口首个 Phase）\n\n${openPhaseSnippet}\n` : ""}

${isFirstWindow && rollbackContext ? `## 旧 Record 回滚 Phase（需要自然衔接，与本窗口合并/改写）\n\n${rollbackContext}\n` : ""}

## 必须保留的手动补充

${manualText}

## 本子窗口的 RecordPatch 草稿

${patchText}`;
}

export function buildSerialComposeTailPrompt(
    conversationId: string,
    workspace: string,
    totalRounds: number,
    totalSteps: number,
    closedOutline: string,
    oldTail: string,
    fileHints: string[],
    manualSupplementSnippets: string[],
): string {
    const manualText = manualSupplementSnippets.length > 0
        ? manualSupplementSnippets.map((snippet, index) => `${index + 1}. ${snippet}`).join("\n")
        : "(无手动补充)";
    const fileText = fileHints.length > 0 ? fileHints.map(f => `- ${f}`).join("\n") : "(无)";
    return `你是一个技术文档助手。请基于以下 Record 提纲，生成 Record 的全局尾部（产出文件总清单 / 经验教训 / 风险与后续建议等）。

## 关键规则

1. 只输出 tailMarkdown 段（多个 \`#\` 二级或一级标题段落，如 \`# 产出文件总清单\`、\`# 经验教训\`、\`# 风险与后续建议\`）。不要生成 Phase 段（## Phase 开头）。
2. 内容必须基于下方提纲和文件线索，不要凭空捏造未在提纲中出现的事实。
3. ${manualSupplementSnippets.length > 0 ? '"必须保留的手动补充"必须原文出现在 tailMarkdown 中。' : ''}

## 输出格式（JSON 代码块）

\`\`\`json
{
  "tailMarkdown": "# 产出文件总清单\\n\\n- ...\\n\\n# 经验教训\\n\\n- ...",
  "tags": ["标签"]
}
\`\`\`

## 对话元数据

- 对话ID: ${conversationId}
- 工作区: ${workspace}
- 总轮次: ${totalRounds}
- 总步骤: ${totalSteps}

## Record 提纲（所有 Phase）

${closedOutline}

## 文件线索

${fileText}

## 旧 Record 尾部（参考）

${oldTail || "(无)"}

## 必须保留的手动补充

${manualText}`;
}
