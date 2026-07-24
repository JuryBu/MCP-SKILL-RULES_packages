import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { touchActivity, appendTiming } from "../lifecycle.js";
import { normalizeOwnerId } from "../owner.js";
import { runCouncil } from "../council/engine.js";
import { formatPersistentCouncilTask, readCouncilResumeSource, startPersistentCouncilTask, waitForPersistentCouncilTask } from "../council/background.js";
import type { CouncilProvider, CouncilRunParams } from "../council/types.js";
import { createCouncilArtifactRun } from "../council/artifact-store.js";
import { formatCouncilArtifactSummary } from "../council/transcript.js";

const PROVIDERS = ["antigravity", "codex", "openai", "anthropic", "gemini", "antigravityCli", "geminiCli", "grok", "claudeCode", "customOpenAICompatible"] as const;
const MODES = ["red_blue_black", "design", "review", "guard_check", "custom"] as const;
const CONTEXT_MODES = ["none", "summary", "full", "manual"] as const;
const COUNCIL_BACKGROUND_MAX_RUN_MS = Number(process.env.SANDBOX_COUNCIL_BACKGROUND_MAX_RUN_MS || 45 * 60_000);
const COUNCIL_TOOL_DESCRIPTION = "多模型审议工具。主持模型控制讨论节奏，参与模型独立发言，主持模型可调用有限工具（webSearch/webFetchText/simpleScript）。\n\n产物与任务：\n- 每次 run 使用稳定 council-artifacts/<runId>/ 根目录，目录内 manifest.json 记录状态、依赖、主要产物和外部引用；后台 task 目录 sandbox-data/temp/council-tasks/<taskId>/ 只保存后台状态、checkpoint 和 resume transcript 快照，核心文件包括 spec.json/progress.json/done.json，用于查询、恢复和结束状态，不是完整 artifact 根目录\n- 服务启动时会自动先执行托管产物的 apply GC（includeLegacy=false），再按 15 天清理过期 council task；legacy 迁移不会自动执行，仍需人工调用 sandbox_status(action=\"gc\", gcScope=\"council\", gcMode=\"apply\")\n- 显式 transcriptPath/outputDir 只登记为外部引用，不属于 council GC 删除范围\n- sandbox_status(action=\"gc\", gcScope=\"council\") 的 gcMode 支持 dryRun/apply/restore/purge；TTL 默认 14 天，最小 7 天；apply 只处理终态 run 组，每次最多 100 个\n- running、dependsOn 引用、文件名恰为 .preserve 的标记文件和损坏 manifest 受保护并报告，不盲删；legacy apply 逐文件隔离到 council-quarantine/<quarantineId>/并写 manifest，restore 可复原，purge 可清除隔离组\n\n定位：\n- 适合红蓝黑队讨论、设计审议、结果复盘、做题后审议和 Guard 式检查，参与模型不能调用工具\n- 使用 provider=\"antigravityCli\" 调本地 agy，使用 provider=\"grok\" 调本机 progrok；模型可用性取决于本机服务与凭据\n- simpleScript 仅用于受限 Node/Python 子进程的文本、JSON、CSV 和统计处理，不是通用命令入口";

const ModelConfigSchema = z.object({
    id: z.string({
        required_error: "模型配置必须包含 id，例如 red / blue / moderator",
        invalid_type_error: "模型配置 id 必须是字符串，例如 red / blue / moderator",
    }).min(1).describe("模型配置 ID，如 red/blue/black/moderator；moderator 也必须提供 id"),
    role: z.string({
        required_error: "模型配置必须包含 role，例如 红队 / 蓝队 / 主持人",
        invalid_type_error: "模型配置 role 必须是字符串，例如 红队 / 蓝队 / 主持人",
    }).min(1).describe("角色说明，如 红队、蓝队、黑队、主持人；moderator 也必须提供 role"),
    provider: z.enum(PROVIDERS).describe("模型来源；grok 走本机 progrok OpenAI-compatible API；Windsurf/WSF 没有 sandbox_council provider，WSF 中调用本工具时仍应选择现有 provider"),
    model: z.string().optional().describe("模型名；antigravity 可用 M132/M20/M18/M16/M36、flash、flash-medium、pro-high、sonnet、opus 等别名，也可直接传 MODEL_* 编码；旧 M37 转 M16、M47 转 M18；antigravityCli 使用 agy 完整模型标签（如 Gemini 3.1 Pro (High)），geminiCli 是一个版本周期的弃用别名；grok 默认 grok-4.5；claudeCode 默认 sonnet；不填使用 provider 默认值"),
    params: z.record(z.unknown()).optional().describe("供应商参数。apiKeyEnv/baseUrl/endpoint/headers/body 可选；grok 可用 baseUrl/endpoint 指向 progrok、fallbackModels 或 SANDBOX_COUNCIL_GROK_MODEL_CHAIN 做显式同 provider 降级；claudeCode 支持 maxBudgetUsd/sessionId/permissionMode/timeoutMs/allowedTools/disallowedTools；fallbackModels 可传同 provider 降级链，如 [\"gemini-3-flash\"] 或 [{\"model\":\"gemini-3.1-pro\",\"params\":{\"reasoning\":\"low\"}}]；body 只能覆盖非核心字段，不能覆盖 auth/model/input/messages/contents"),
    supportsVision: z.boolean().optional().describe("该模型是否支持直接接收 images"),
});

const FileInputSchema = z.object({
    path: z.string().describe("背景文件路径，支持绝对路径或相对当前工作目录"),
    range: z.string().optional().describe("可选行号范围，如 10-80 / #10-80 / first80 / last80"),
    label: z.string().optional().describe("文件标签"),
});

const CouncilParamsShape = {
    participants: z.array(ModelConfigSchema).min(1).optional().describe("参与模型数组；启动模式必需。每项都必须是对象，包含 id/role/provider，可选 model/params/supportsVision；参与模型不能直接调用工具"),
    moderator: ModelConfigSchema.optional().describe("主持模型对象；启动模式必需。必须是 {id, role, provider, model?, params?, supportsVision?}，不能写成 \"gpt-5.4\" 字符串。例如 {\"id\":\"moderator\",\"role\":\"主持人\",\"provider\":\"codex\",\"model\":\"gpt-5.4\"}"),
    input: z.string().min(1).optional().describe("本次审议的输入文本；启动模式必需"),
    files: z.array(FileInputSchema).optional().describe("背景文件列表。纯文本文件直接抽文本；PDF/Word/Excel/EPUB/PPTX 默认先由 Antigravity CLI (agy) 索引、再走本地结构化解析；PPTX 硬隔离，永不进入 Codex。PDF/Word/Excel/EPUB 仅在 SANDBOX_COUNCIL_STRUCTURED_CODEX_FALLBACK=1 时才允许 Codex 作为最后兜底；图片文件会自动提升到 images，视频与未知二进制可在 agy 失败后走 Codex。CLI 索引必须写入 sandbox-data/temp/council-indexes 临时文件，宿主会检查产物和标记，避免完整索引走 stdout/内存"),
    images: z.array(z.string()).optional().describe("图片路径。支持视觉输入的模型会直接收到原图；若存在纯文本模型，系统会额外先生成一份 only-text 转述供它们使用"),
    contextMode: z.enum(CONTEXT_MODES).optional().describe("上下文模式：none/summary/full/manual"),
    manualContext: z.string().optional().describe("手动附加上下文"),
    largeInput: z.object({
        enabled: z.boolean().optional().describe("是否启用大输入分块索引，默认 true"),
        thresholdChars: z.number().min(1000).optional().describe("超过多少真实字符后改为临时文件分块索引，默认 60000"),
        chunkSize: z.number().min(1000).optional().describe("每个 chunk 的真实字符数，默认 24000"),
        overlap: z.number().min(0).optional().describe("相邻 chunk 的真实字符重叠数，默认 1200，必须小于 chunkSize"),
        maxChunks: z.number().min(1).optional().describe("最多生成多少 chunk；通常不建议限制，限制会在质量报告中暴露未覆盖范围"),
        previewChars: z.number().min(80).optional().describe("索引里每个 chunk 的预览字符数，默认 600"),
        contextMaxChars: z.number().min(1000).optional().describe("注入 council 上下文的 LargeInputIndex 摘录上限，默认 24000；完整索引仍在临时文件"),
        includeChunkText: z.boolean().optional().describe("是否把完整 chunk 正文写进 Markdown 索引；默认 false，只写预览和 checkpoint/source 临时文件"),
    }).optional().describe("大输入处理配置。input、manualContext、超长纯文本/CSV 文件超过阈值时，会写入 sandbox-data/temp/council-large-inputs 并生成带 overlap 的索引，避免把全文塞进模型上下文"),
    modelTimeoutMs: z.number().min(10000).max(1800000).optional().describe("单次正式模型调用超时毫秒数；不填时普通任务默认 120000，检测到大输入/复杂文件/图片时自动使用 pressureModelTimeoutMs 或默认 600000"),
    pressureModelTimeoutMs: z.number().min(10000).max(1800000).optional().describe("压力输入场景的单次正式模型调用超时毫秒数，默认 600000；单个 participant/moderator 仍可用 params.timeoutMs 覆盖"),
    mode: z.enum(MODES).optional().describe("讨论模式"),
    roles: z.record(z.string()).optional().describe("角色补充说明"),
    tools: z.object({
        webSearch: z.boolean().optional(),
        webFetchText: z.boolean().optional(),
        simpleScript: z.boolean().optional(),
    }).optional().describe("主持模型可调用的工具开关，默认都启用"),
    maxRounds: z.number().min(1).max(8).optional().describe("最大讨论轮数，默认 4，上限 8"),
    maxToolCalls: z.number().min(0).max(10).optional().describe("最大工具调用次数，默认 6，上限 10"),
    transcriptPath: z.string().optional().describe("Markdown 讨论副本输出路径；JSON 会写到同名 .json"),
    outputDir: z.string().optional().describe("未指定 transcriptPath 时的输出目录"),
    transcriptionModel: ModelConfigSchema.optional().describe("图片观察转述模型；未填时使用第一个 supportsVision 参与者"),
    textProjectionModel: ModelConfigSchema.optional().describe("纯文本参与者的专用转述模型；默认使用 codex/gpt-5.6-luna，reasoning=high、speed=fast 生成 only-text dossier"),
    background: z.boolean().optional().describe("后台模式：true=启动后立刻返回 taskId"),
    taskId: z.string().optional().describe("查询后台 sandbox_council 任务；若启动时传 ownerId，查询必须带同一个 ownerId"),
    resume: z.boolean().optional().describe("恢复模式：true 时从 resumeTaskId 指向的旧后台任务继续，创建新的后台 taskId"),
    resumeTaskId: z.string().optional().describe("要恢复的旧 sandbox_council 后台任务 ID；会读取旧 spec/checkpoint/transcript，不需要重新传 participants/moderator/input"),
    waitSeconds: z.number().min(1).max(300).optional().describe("查询后台任务前等待秒数"),
    ownerId: z.string().optional().describe("ownerId 任务归属 ID；后台启动和 taskId 查询必须保持一致；未传按 global 兼容旧调用"),
};
const CouncilParamsSchema = z.object(CouncilParamsShape).strict();

function formatCouncilResult(result: Awaited<ReturnType<typeof runCouncil>>): string {
    const lastRound = result.rounds.at(-1);
    const toolCalls = result.rounds.reduce((total, round) => total + (round.toolResults?.length ?? (round.toolResult ? 1 : 0)), 0);
    const participants = result.participants.map((p) => `${p.id}(${p.provider}${p.model ? `:${p.model}` : ""})`).join(", ");
    const largeInputCount = result.largeInputs?.length || 0;
    return [
        "✅ sandbox_council 完成",
        `🆔 id: ${result.id}`,
        `📌 mode: ${result.mode}`,
        `👥 participants: ${participants}`,
        `🔁 rounds: ${result.rounds.length}`,
        `🧰 toolCalls: ${toolCalls}`,
        largeInputCount > 0 ? `🧩 largeInputs: ${largeInputCount}` : "",
        `🛑 terminationReason: ${result.terminationReason}`,
        "",
        formatCouncilArtifactSummary(result.runId),
        "",
        "## 最终结论",
        result.finalAnswer,
        lastRound?.moderator.summary ? `\n## 最后一轮主持摘要\n${lastRound.moderator.summary}` : "",
    ].filter(Boolean).join("\n");
}

function toRunParams(args: Record<string, unknown>, ownerId: string): CouncilRunParams {
    if (!args.participants || !args.moderator || !args.input) {
        throw new Error("启动 sandbox_council 需要 participants、moderator、input 参数");
    }
    if (typeof args.moderator === "string") {
        throw new Error("moderator 不能是字符串模型名；请传对象，例如 {\"id\":\"moderator\",\"role\":\"主持人\",\"provider\":\"codex\",\"model\":\"gpt-5.4\"}");
    }
    return {
        participants: args.participants as CouncilRunParams["participants"],
        moderator: args.moderator as CouncilRunParams["moderator"],
        input: args.input as string,
        files: args.files as CouncilRunParams["files"],
        images: args.images as string[] | undefined,
        contextMode: args.contextMode as CouncilRunParams["contextMode"],
        manualContext: args.manualContext as string | undefined,
        mode: args.mode as CouncilRunParams["mode"],
        roles: args.roles as Record<string, string> | undefined,
        tools: args.tools as CouncilRunParams["tools"],
        maxRounds: args.maxRounds as number | undefined,
        maxToolCalls: args.maxToolCalls as number | undefined,
        transcriptPath: args.transcriptPath as string | undefined,
        outputDir: args.outputDir as string | undefined,
        transcriptionModel: args.transcriptionModel as CouncilRunParams["transcriptionModel"],
        textProjectionModel: args.textProjectionModel as CouncilRunParams["textProjectionModel"],
        largeInput: args.largeInput as CouncilRunParams["largeInput"],
        modelTimeoutMs: args.modelTimeoutMs as number | undefined,
        pressureModelTimeoutMs: args.pressureModelTimeoutMs as number | undefined,
        ownerId,
    };
}

const RESUME_OVERRIDE_KEYS = [
    "participants",
    "moderator",
    "input",
    "files",
    "images",
    "contextMode",
    "manualContext",
    "mode",
    "roles",
    "tools",
    "maxRounds",
    "maxToolCalls",
    "transcriptPath",
    "outputDir",
    "transcriptionModel",
    "textProjectionModel",
    "largeInput",
    "modelTimeoutMs",
    "pressureModelTimeoutMs",
] as const;

function toResumeRunParams(args: Record<string, unknown>, ownerId: string): { runParams: CouncilRunParams; resumeSource: ReturnType<typeof readCouncilResumeSource> } {
    const resumeTaskId = args.resumeTaskId as string | undefined;
    if (!resumeTaskId) {
        throw new Error("resume 模式需要 resumeTaskId");
    }
    const resumeSource = readCouncilResumeSource(resumeTaskId, ownerId);
    const runParams: CouncilRunParams = {
        ...resumeSource.spec.params,
        ownerId,
    };
    for (const key of RESUME_OVERRIDE_KEYS) {
        if (args[key] !== undefined) {
            (runParams as unknown as Record<string, unknown>)[key] = args[key];
        }
    }
    return { runParams, resumeSource };
}

export function registerCouncil(server: McpServer): void {
    const handleCouncil = async (input: Record<string, unknown>) => {
            const args = input;
            const startTime = Date.now();
            touchActivity();
            const ownerId = normalizeOwnerId(args.ownerId);

            if (args.taskId) {
                const task = await waitForPersistentCouncilTask(args.taskId as string, args.waitSeconds as number || 0, ownerId);
                return appendTiming({
                    content: [{ type: "text" as const, text: formatPersistentCouncilTask(task) }],
                }, startTime);
            }

            if (args.resume || args.resumeTaskId) {
                try {
                    const { runParams, resumeSource } = toResumeRunParams(args, ownerId);
                    const task = startPersistentCouncilTask(runParams, ownerId, COUNCIL_BACKGROUND_MAX_RUN_MS, resumeSource);
                    return appendTiming({
                        content: [{
                            type: "text" as const,
                            text: [
                                "🚀 sandbox_council resume 已转入后台任务",
                                `🆔 taskId: ${task.id}`,
                                `🔁 resumeFrom: ${resumeSource.sourceTaskId}`,
                                `👤 ownerId: ${task.ownerId}`,
                                `⏳ deadlineAt: ${task.deadlineAt}`,
                                "",
                                formatCouncilArtifactSummary(task.runId),
                                `💡 后续用 sandbox_council(taskId="${task.id}", ownerId="${task.ownerId}", waitSeconds=45) 查询；ownerId 必须与启动时一致`,
                            ].join("\n"),
                        }],
                    }, startTime);
                } catch (err) {
                    return appendTiming({
                        content: [{ type: "text" as const, text: `❌ sandbox_council resume 失败: ${err instanceof Error ? err.message : String(err)}` }],
                    }, startTime);
                }
            }

            if (args.background) {
                if (!args.participants || !args.moderator || !args.input) {
                    return {
                        content: [{ type: "text" as const, text: "❌ 后台启动需要 participants、moderator、input 参数" }],
                    };
                }
                const runParams = toRunParams(args, ownerId);
                const task = startPersistentCouncilTask(runParams, ownerId, COUNCIL_BACKGROUND_MAX_RUN_MS);
                return appendTiming({
                    content: [{
                        type: "text" as const,
                        text: [
                            "🚀 sandbox_council 已转入后台任务",
                            `🆔 taskId: ${task.id}`,
                            `👤 ownerId: ${task.ownerId}`,
                            `⏳ deadlineAt: ${task.deadlineAt}`,
                            "",
                            formatCouncilArtifactSummary(task.runId),
                            `💡 后续用 sandbox_council(taskId="${task.id}", ownerId="${task.ownerId}", waitSeconds=45) 查询；ownerId 必须与启动时一致`,
                        ].join("\n"),
                    }],
                }, startTime);
            }

            let synchronousRunId = "";
            try {
                const baseParams = toRunParams(args, ownerId);
                const artifactRun = createCouncilArtifactRun({ ownerId });
                synchronousRunId = artifactRun.runId;
                const result = await runCouncil({
                    ...baseParams,
                    runId: artifactRun.runId,
                    artifactManifestPath: artifactRun.artifactManifestPath,
                });
                return appendTiming({
                    content: [{ type: "text" as const, text: formatCouncilResult(result) }],
                }, startTime);
            } catch (err) {
                return appendTiming({
                    content: [{ type: "text" as const, text: [`❌ sandbox_council 失败: ${err instanceof Error ? err.message : String(err)}`, synchronousRunId ? formatCouncilArtifactSummary(synchronousRunId) : ""].filter(Boolean).join("\n\n") }],
                }, startTime);
            }
        };
    const compatibleServer = server as unknown as {
        registerTool?: (name: string, config: { description: string; inputSchema: typeof CouncilParamsSchema }, handler: typeof handleCouncil) => unknown;
        tool?: (name: string, description: string, shape: typeof CouncilParamsShape, handler: typeof handleCouncil) => unknown;
    };
    if (typeof compatibleServer.registerTool === "function") {
        compatibleServer.registerTool("sandbox_council", { description: COUNCIL_TOOL_DESCRIPTION, inputSchema: CouncilParamsSchema }, handleCouncil);
        return;
    }
    if (typeof compatibleServer.tool === "function") {
        compatibleServer.tool("sandbox_council", COUNCIL_TOOL_DESCRIPTION, CouncilParamsShape, handleCouncil);
        return;
    }
    throw new Error("MCP server 不支持 registerTool/tool 注册接口");
}

export type CouncilProviderName = CouncilProvider;
