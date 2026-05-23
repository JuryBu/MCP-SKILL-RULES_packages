import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { touchActivity, appendTiming } from "../lifecycle.js";
import { normalizeOwnerId } from "../owner.js";
import { runCouncil } from "../council/engine.js";
import { formatPersistentCouncilTask, startPersistentCouncilTask, waitForPersistentCouncilTask } from "../council/background.js";
import type { CouncilProvider, CouncilRunParams } from "../council/types.js";

const PROVIDERS = ["antigravity", "codex", "openai", "anthropic", "gemini", "geminiCli", "claudeCode", "customOpenAICompatible"] as const;
const MODES = ["red_blue_black", "design", "review", "guard_check", "custom"] as const;
const CONTEXT_MODES = ["none", "summary", "full", "manual"] as const;
const COUNCIL_BACKGROUND_MAX_RUN_MS = Number(process.env.SANDBOX_COUNCIL_BACKGROUND_MAX_RUN_MS || 45 * 60_000);

const ModelConfigSchema = z.object({
    id: z.string({
        required_error: "模型配置必须包含 id，例如 red / blue / moderator",
        invalid_type_error: "模型配置 id 必须是字符串，例如 red / blue / moderator",
    }).min(1).describe("模型配置 ID，如 red/blue/black/moderator；moderator 也必须提供 id"),
    role: z.string({
        required_error: "模型配置必须包含 role，例如 红队 / 蓝队 / 主持人",
        invalid_type_error: "模型配置 role 必须是字符串，例如 红队 / 蓝队 / 主持人",
    }).min(1).describe("角色说明，如 红队、蓝队、黑队、主持人；moderator 也必须提供 role"),
    provider: z.enum(PROVIDERS).describe("模型来源"),
    model: z.string().optional().describe("模型名；antigravity 可用 M132/M20/M18/M16/M36、flash、flash-medium、pro-high、sonnet、opus 等别名，也可直接传 MODEL_* 编码；旧 M37 转 M16、M47 转 M18；geminiCli 可用 auto-gemini-3/gemini-3.1-pro-preview/gemini-2.5-pro 等 Gemini CLI 模型；claudeCode 默认 sonnet；不填使用 provider 默认值"),
    params: z.record(z.unknown()).optional().describe("供应商参数。apiKeyEnv/endpoint/headers/body 可选；claudeCode 支持 maxBudgetUsd/sessionId/permissionMode/timeoutMs/allowedTools/disallowedTools；fallbackModels 可传同 provider 降级链，如 [\"gemini-3-flash\"] 或 [{\"model\":\"gemini-3.1-pro\",\"params\":{\"reasoning\":\"low\"}}]；body 只能覆盖非核心字段，不能覆盖 auth/model/input/messages/contents"),
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
    files: z.array(FileInputSchema).optional().describe("背景文件列表。纯文本文件直接抽文本；PDF/Word/Excel/EPUB/视频等复杂文件会优先用 Gemini CLI agentic 建索引，失败再 fallback 到 Codex CLI；图片文件会自动提升到 images。CLI 索引必须写入 sandbox-data/temp/council-indexes 临时文件，宿主会检查产物和标记，避免完整索引走 stdout/内存"),
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
    textProjectionModel: ModelConfigSchema.optional().describe("纯文本参与者的专用转述模型；默认使用 codex 链路 gpt-5.4-mini 生成 only-text dossier"),
    background: z.boolean().optional().describe("后台模式：true=启动后立刻返回 taskId"),
    taskId: z.string().optional().describe("查询后台 sandbox_council 任务；若启动时传 ownerId，查询必须带同一个 ownerId"),
    waitSeconds: z.number().min(1).max(300).optional().describe("查询后台任务前等待秒数"),
    ownerId: z.string().optional().describe("ownerId 任务归属 ID；后台启动和 taskId 查询必须保持一致；未传按 global 兼容旧调用"),
};

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
        result.markdownPath ? `📄 markdown: ${result.markdownPath}` : "",
        result.jsonPath ? `📄 json: ${result.jsonPath}` : "",
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

export function registerCouncil(server: McpServer): void {
    server.tool(
        "sandbox_council",
        `多模型审议工具。主持模型控制讨论节奏，参与模型独立发言，主持模型可调用有限工具（webSearch/webFetchText/simpleScript），完整讨论副本落盘。

定位：
- 适合红蓝黑队讨论、设计审议、结果复盘、做题后审议、Guard 式检查
- Antigravity provider 只走 GetModelResponse，不使用 Cascade
- 参与模型不能调用工具；工具调用只由主持模型发起
- 若存在 only-text 模型且输入里带 files/images，系统会先用 codex 链路生成纯文本专用转述；支持视觉输入的模型仍直接接收原图
- files 现在区分直接文本与复杂文件：纯文本直接抽取，PDF/Word/Excel/EPUB/视频等复杂文件优先走 Gemini CLI agentic 索引，失败再 fallback 到 Codex CLI；索引副本会落到 sandbox-data/temp/council-indexes 临时目录并写进 transcript。CLI 必须写临时 Markdown，stdout/stderr 只保留短状态；宿主会校验文件存在、大小上限和 <<<COUNCIL_INDEX>>> 标记
- input、manualContext、超长纯文本/CSV 文件超过阈值时会自动写入 sandbox-data/temp/council-large-inputs，按真实字符切分并保留相邻 chunk overlap；模型只收到索引摘录和临时文件路径，完整正文不堆在上下文里
- 检测到大输入索引、复杂文件索引或图片时，正式模型调用会自动放宽到 pressureModelTimeoutMs（默认 600s）；普通任务仍默认 120s。可用顶层 modelTimeoutMs / pressureModelTimeoutMs，或单个模型 params.timeoutMs 覆盖
- 主持模型可用旧版 toolCall 单工具格式，或 toolCalls[] 一轮最多 3 个；总次数仍受 maxToolCalls 限制；同一轮里主持人会在拿到工具结果后继续决定要不要再调工具
- afterToolInstruction 会在有效工具结果后作为下一轮参与者额外指令进入公共讨论节奏
- moderator 必须是模型配置对象，不能是字符串模型名；最小示例见下方
- 后台 taskId 查询在任务未完成时会返回当前轮次、参与者返回情况、主持摘要和工具进度
- background=true 返回 taskId 与 ownerId；后续查询必须传同一个 ownerId，例如 sandbox_council(taskId="...", ownerId="...", waitSeconds=45)，避免误以为任务丢失而重复启动
- council 后台运行时，主线程可继续做不重叠的本地检查、读文件、构建或整理证据；等待结果后合并观点并自行验证取舍，不要重复启动相同审议
- webSearch 现默认优先走 Exa MCP；Exa 失败或无结果时才降级到 360/Bing HTML fallback。DuckDuckGo 默认跳过，可传 duckDuckGo=true 强制尝试
- webFetchText 现默认优先走 Exa 或 web-fetcher，再 fallback 到轻量直抓；可做文本、HTML、链接、表格这类非视觉抽取，不做截图、不点击网页
- provider 调用有轻量稳定性保护：antigravity 默认同源并发 2，codex 默认同源并发 2，geminiCli 默认同源并发 2，customOpenAICompatible 默认同 baseUrl/source 并发 2；HTTP/空输出/超时类错误会有限 retry
- v1.12.3 支持 params.fallbackModels：同一模型 retry 仍失败且错误可降级时，按同 provider 链路切到备用模型，例如 Claude Opus → Sonnet、Gemini Pro high → Pro low / Flash；API key 缺失、图片不支持、安全拦截、输出截断等非临时错误不会自动降级
- Antigravity/OpenAI/Anthropic/Gemini/custom provider 的 fallbackModels 必须显式写在对应 participant/moderator 的 params 里；不会因为 model 写了 sonnet/opus 就自动选择备用模型。Antigravity 默认 GetModelResponse 链为 M132 → M20 → M18 → M16 → M36；Claude/Sonnet/Opus 不稳定时可传 params: {"retries":1,"fallbackModels":["M132","M20","M18","M16","M36"]}。复杂推理/Guard/审议类任务可显式指定 M16 或把 M16 放到自定义 fallback 前段
- Codex provider 未显式传 fallbackModels 时默认按 gpt-5.4 high → medium → low → gpt-5.4-mini medium → low 降级，并跳过当前已使用档位；可用 SANDBOX_COUNCIL_CODEX_DEFAULT_FALLBACKS=0 关闭
- Gemini CLI provider 可用 provider=geminiCli；这是本地 Gemini CLI 路线，不需要 GEMINI_API_KEY，支持让 supportsVision=true 的参与者直接处理图片路径。未显式传 fallbackModels 时默认按 auto-gemini-3 → gemini-3.1-pro-preview → gemini-2.5-pro → gemini-3.1-flash-lite-preview → gemini-2.5-flash-lite → gemini-2.5-flash 降级；可用 SANDBOX_COUNCIL_GEMINI_CLI_DEFAULT_FALLBACKS=0 关闭
- Claude Code provider 可用 provider=claudeCode；这是本地 claude CLI 路线，只在显式配置时调用，不进入 auto 或 Codex 默认 fallback。默认带小预算上限，可用 params.maxBudgetUsd/sessionId/permissionMode/timeoutMs/allowedTools/disallowedTools 覆盖；transcript 会记录实际模型与 sessionId/费用摘要
- moderator 调用失败时会先走 provider fallback；如果所有主持模型仍失败，会用规则兜底汇总已返回的参与者意见，并标明未经过主持模型二次综合
- CLI 文件索引本身也有 retry/fallback：Gemini 默认优先 auto-gemini-3/gemini-3.1-pro-preview/gemini-2.5-pro，容量不稳的 gemini-2.5-flash 靠后；Codex 默认 gpt-5.4:medium → gpt-5.4:low → gpt-5.4-mini:medium → gpt-5.4-mini:low。可用 SANDBOX_COUNCIL_GEMINI_INDEX_MODELS、SANDBOX_COUNCIL_CODEX_INDEX_MODELS、SANDBOX_COUNCIL_CLI_INDEX_RETRIES 覆盖
- simpleScript v1.10 仅用于受限 Node/Python 子进程文本/JSON/CSV/统计处理；默认 language=node，Python 走 AST 白名单与最小环境，不是通用命令入口

最小可用示例：
{
  "mode": "design",
  "input": "讨论这个方案的风险和下一步",
  "participants": [
    {"id":"red","role":"红队，找漏洞","provider":"codex","model":"gpt-5.4"},
    {"id":"blue","role":"蓝队，给建设性方案","provider":"antigravity","model":"M132"}
  ],
  "moderator": {"id":"moderator","role":"主持人","provider":"codex","model":"gpt-5.4"},
  "maxRounds": 4,
  "background": true,
  "ownerId": "example-owner"
}

常见错误：
- ❌ "moderator": "gpt-5.4"
- ✅ "moderator": {"id":"moderator","role":"主持人","provider":"codex","model":"gpt-5.4"}`,
        CouncilParamsShape,
        async (args: Record<string, unknown>) => {
            const startTime = Date.now();
            touchActivity();
            const ownerId = normalizeOwnerId(args.ownerId);

            if (args.taskId) {
                const task = await waitForPersistentCouncilTask(args.taskId as string, args.waitSeconds as number || 0, ownerId);
                return appendTiming({
                    content: [{ type: "text" as const, text: formatPersistentCouncilTask(task) }],
                }, startTime);
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
                            `💡 后续用 sandbox_council(taskId="${task.id}", ownerId="${task.ownerId}", waitSeconds=45) 查询；ownerId 必须与启动时一致`,
                        ].join("\n"),
                    }],
                }, startTime);
            }

            try {
                const result = await runCouncil(toRunParams(args, ownerId));
                return appendTiming({
                    content: [{ type: "text" as const, text: formatCouncilResult(result) }],
                }, startTime);
            } catch (err) {
                return appendTiming({
                    content: [{ type: "text" as const, text: `❌ sandbox_council 失败: ${err instanceof Error ? err.message : String(err)}` }],
                }, startTime);
            }
        }
    );
}

export type CouncilProviderName = CouncilProvider;
