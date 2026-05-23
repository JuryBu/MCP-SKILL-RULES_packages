import { z } from "zod";
import { randomUUID } from "crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import fs from "fs";
import { fileURLToPath } from "url";
import { browserManager } from "../browser.js";
import { touchActivity } from "../lifecycle.js";
import { generateModelText } from "../model-bridge.js";
import { ensureTempDirs, generateCacheKey, saveTempFile, TEMP_DIRS } from "../temp-store.js";
import { QUALITY_PRESETS, SUMMARY_CHAIN_VALUES, resolveSummaryModelChain, type SummaryChain } from "../constants.js";
import {
    detectPdfIssues,
    extractPdfStructure,
    resolvePdfPathFromUrl,
} from "../inspector/pdf-inspector.js";
import {
    detectPptxIssues,
    extractPptxStructure,
    localPptxPathFromUrl,
} from "../inspector/pptx-inspector.js";
import {
    detectDomIssues,
    extractDomStructure,
} from "../inspector/dom-inspector.js";
import { extractEpubStructure } from "../ebook/epub.js";
import type { AIReviewReport, InspectResult, PageStructure } from "../inspector/types.js";

const InspectInputSchema = z.object({
    action: z
        .enum(["check"])
        .optional()
        .describe("后台任务查询动作；传 check 时需提供 taskId"),
    taskId: z
        .string()
        .optional()
        .describe("后台 ai_review 任务 ID"),
    waitSeconds: z
        .number()
        .int()
        .min(1)
        .max(300)
        .optional()
        .describe("check 时等待任务完成的秒数"),
    url: z
        .string()
        .refine(s => /^(https?|file):\/\//i.test(s), "请提供有效的 URL（支持 http/https/file 协议）")
        .optional()
        .describe("要检查的网页/文件 URL"),
    mode: z
        .enum(["structure", "detect", "ai_review", "all"])
        .optional()
        .describe("检查模式：structure=结构提取, detect=异常检测, ai_review=AI审查, all=全部"),
    page: z
        .union([z.number().int().min(1), z.literal("all")])
        .optional()
        .describe("页码(数字)或'all'，适用于 PDF/PPTX"),
    detect: z
        .array(z.enum(["overlap", "overflow", "readability", "alignment"]))
        .optional()
        .describe("检测项目列表，默认全部"),
    autoScreenshot: z
        .boolean()
        .optional()
        .default(true)
        .describe("自动为检测到的问题生成局域截图"),
    scale: z
        .number()
        .min(1.0)
        .max(3.0)
        .optional()
        .default(1.4)
        .describe("局域截图放大倍率，默认 1.4"),
    modelChain: z
        .enum(SUMMARY_CHAIN_VALUES)
        .optional()
        .describe("AI 模型链路，ai_review 时使用。未填时回退到 chain，再默认 auto"),
    chain: z
        .enum(SUMMARY_CHAIN_VALUES)
        .optional()
        .describe("兼容旧参数：AI 模型链路，ai_review 时使用。modelChain 未填时使用"),
    background: z
        .boolean()
        .optional()
        .describe("后台执行，ai_review 批量时推荐"),
    batchSize: z
        .number()
        .int()
        .min(1)
        .max(10)
        .optional()
        .default(5)
        .describe("AI 批量并发大小"),
    thresholds: z
        .object({
            smallFontPx: z.number().positive().optional(),
            smallFontPt: z.number().positive().optional(),
            contrastRatio: z.number().positive().optional(),
            titleTopVarianceEmu: z.number().positive().optional(),
            sizeVarianceRatio: z.number().positive().optional(),
            gapVarianceRatio: z.number().positive().optional(),
        })
        .optional()
        .describe("可读性/一致性阈值覆盖，未提供时使用默认值"),
});

type InspectInput = z.infer<typeof InspectInputSchema>;
type InspectMode = InspectInput["mode"];
type InspectRoute = "dom" | "pdf" | "pptx" | "ebook";

interface EmptyStructure {
    page: number | "all" | null;
    dimensions: null;
    elements: [];
}

interface EmptyInspectResult {
    summary: {
        status: "not_implemented";
        message: string;
        route: InspectRoute;
        mode: InspectMode;
    };
    issues: [];
    structure?: EmptyStructure;
}

interface EmptyAIReviewReport {
    summary: string;
    aiFindings: [];
    confirmedIssues: [];
    dismissedIssues: [];
    dismissReason: Record<string, string>;
}

interface InspectResponse {
    tool: "web_inspect";
    url?: string;
    route: InspectRoute;
    mode: InspectMode;
    page: number | "all" | null;
    detect: Array<"overlap" | "overflow" | "readability" | "alignment">;
    autoScreenshot: boolean;
    scale: number;
    modelChain: SummaryChain;
    chain: SummaryChain;
    background: boolean;
    batchSize: number;
    thresholds?: InspectThresholds;
    structure?: PageStructure[] | EmptyStructure;
    detection?: InspectResult | EmptyInspectResult;
    aiReview?: AIReviewReport | EmptyAIReviewReport;
    taskId?: string;
    status?: BackgroundTaskStatus;
    progress?: BackgroundTaskProgress;
    deadlineAt?: string;
    timedOut?: boolean;
    result?: AIReviewReport;
    error?: string;
}

interface InspectThresholds {
    smallFontPx?: number;
    smallFontPt?: number;
    contrastRatio?: number;
    titleTopVarianceEmu?: number;
    sizeVarianceRatio?: number;
    gapVarianceRatio?: number;
}

const DEFAULT_DETECT_CHECKS: InspectResponse["detect"] = [
    "overlap",
    "overflow",
    "readability",
    "alignment",
];

type BackgroundTaskStatus = "running" | "done" | "error";

interface BackgroundTaskProgress {
    completed: number;
    total: number;
}

interface BackgroundTask {
    id: string;
    status: BackgroundTaskStatus;
    progress: BackgroundTaskProgress;
    startedAt: number;
    route: InspectRoute;
    params: NormalizedInspectInput;
    deadlineAt?: number;
    maxRunMs?: number;
    timedOut?: boolean;
    finishedAt?: number;
    result?: AIReviewReport;
    error?: string;
}

const backgroundTasks = new Map<string, BackgroundTask>();
function envMs(name: string): number | undefined {
    const value = process.env[name];
    if (!value) return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

const BACKGROUND_TASK_TIMEOUT_MS =
    envMs("WEB_FETCHER_INSPECT_BACKGROUND_MAX_RUN_MS")
    ?? envMs("WEB_FETCHER_WEB_AI_BACKGROUND_MAX_RUN_MS")
    ?? 15 * 60 * 1000;
const BACKGROUND_TASK_RESULT_TTL_MS = 5 * 60 * 1000;
const AI_REVIEW_TIMEOUT_MS = 60_000;
const AI_REVIEW_MAX_ELEMENTS = 80;
const AI_REVIEW_MAX_ISSUES = 50;

export function detectRoute(url: string): InspectRoute {
    let pathname = url;
    try {
        pathname = new URL(url).pathname;
    } catch {
        pathname = url;
    }

    const normalized = decodeURIComponent(pathname).toLowerCase();
    if (normalized.endsWith(".pptx")) {
        return "pptx";
    }
    if (normalized.endsWith(".epub")) {
        return "ebook";
    }
    if (/\.(pdf|docx|xlsx|odt|odp|ods|rtf)$/.test(normalized)) {
        return "pdf";
    }
    return "dom";
}

export function registerInspect(server: McpServer): void {
    server.registerTool(
        "web_inspect",
        {
            title: "检查网页/文档结构与视觉问题",
            description: `检查网页或文档的结构、重叠、溢出、可读性、一致性与 AI 视觉审查。

支持 DOM、PDF、PPTX 与 EPUB 静态结构路线的 structure/detect/ai_review/all；AI Review 会打包截图、结构树与几何检测结果，并支持后台批量处理。

参数:
  - url (string, 必须): 要检查的网页/文件 URL（支持 http/https/file 协议）
  - mode (string, 必须): structure/detect/ai_review/all
  - action (string, 可选): check，用于查询后台任务
  - taskId (string, 可选): 后台任务 ID
  - waitSeconds (number, 可选): check 等待秒数
  - page (number|string, 可选): 页码或 "all"，适用于 PDF/PPTX
  - detect (array, 可选): overlap/overflow/readability/alignment，默认全部
  - autoScreenshot (boolean, 可选): 自动为问题生成局域截图，默认 true
  - scale (number, 可选): 局域截图放大倍率，默认 1.4
  - modelChain (string, 可选): AI 模型链路，auto/antigravity/codex/claude-code；未填回退到 chain，再默认 auto
  - chain (string, 可选): 兼容旧参数，AI 模型链路；modelChain 未填时使用
  - background (boolean, 可选): 后台执行，默认 false
  - batchSize (number, 可选): AI 批量并发大小，默认 5
  - thresholds (object, 可选): smallFontPx/smallFontPt/contrastRatio/titleTopVarianceEmu/sizeVarianceRatio/gapVarianceRatio 阈值覆盖`,
            inputSchema: {
                url: InspectInputSchema.shape.url,
                mode: InspectInputSchema.shape.mode,
                action: InspectInputSchema.shape.action,
                taskId: InspectInputSchema.shape.taskId,
                waitSeconds: InspectInputSchema.shape.waitSeconds,
                page: InspectInputSchema.shape.page,
                detect: InspectInputSchema.shape.detect,
                autoScreenshot: InspectInputSchema.shape.autoScreenshot,
                scale: InspectInputSchema.shape.scale,
                modelChain: InspectInputSchema.shape.modelChain,
                chain: InspectInputSchema.shape.chain,
                background: InspectInputSchema.shape.background,
                batchSize: InspectInputSchema.shape.batchSize,
                thresholds: InspectInputSchema.shape.thresholds,
            },
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: true,
            },
        },
        async (params: InspectInput) => {
            touchActivity();
            const response = await handleInspect(params);
            return {
                content: [
                    {
                        type: "text" as const,
                        text: JSON.stringify(response, null, 2),
                    },
                ],
            };
        }
    );
}

async function handleInspect(params: InspectInput): Promise<InspectResponse> {
    if (params.action === "check") {
        return await checkBackgroundTask(params.taskId, params.waitSeconds ?? 1);
    }
    if (!params.url || !params.mode) {
        throw new Error("url 和 mode 是必填参数；查询后台任务时请使用 action=\"check\" + taskId");
    }
    const normalized = normalizeParams(params);
    const route = detectRoute(normalized.url);
    const base = {
        tool: "web_inspect" as const,
        url: normalized.url,
        route,
        mode: normalized.mode,
        page: normalized.page,
        detect: normalized.detect,
        autoScreenshot: normalized.autoScreenshot,
        scale: normalized.scale,
        modelChain: normalized.modelChain,
        chain: normalized.chain,
        background: normalized.background,
        batchSize: normalized.batchSize,
        thresholds: normalized.thresholds,
    };

    switch (normalized.mode) {
        case "structure":
            return {
                ...base,
                structure: await getStructure(route, normalized),
            };
        case "detect":
            return {
                ...base,
                detection: await runDetection(route, normalized),
            };
        case "ai_review":
            if (normalized.background) {
                const taskId = startAIReviewTask(route, normalized);
                return {
                    ...base,
                    taskId,
                    status: "running",
                    progress: backgroundTasks.get(taskId)?.progress,
                };
            }
            return {
                ...base,
                aiReview: await runAIReview(route, normalized),
            };
        case "all":
            return {
                ...base,
                structure: await getStructure(route, normalized),
                detection: await runDetection(route, normalized),
                aiReview: await runAIReview(route, normalized),
            };
    }
    throw new Error(`unsupported inspect mode: ${normalized.mode}`);
}

type NormalizedInspectInput = Required<Omit<InspectInput, "action" | "taskId" | "waitSeconds" | "url" | "mode" | "page" | "detect" | "modelChain" | "chain" | "background" | "thresholds">> & {
    url: string;
    mode: InspectMode;
    page: number | "all" | null;
    detect: InspectResponse["detect"];
    modelChain: SummaryChain;
    chain: SummaryChain;
    background: boolean;
    thresholds?: InspectThresholds;
};

function normalizeParams(params: InspectInput): NormalizedInspectInput {
    return {
        url: params.url!,
        mode: params.mode!,
        page: params.page ?? null,
        detect: params.detect ?? DEFAULT_DETECT_CHECKS,
        autoScreenshot: params.autoScreenshot ?? true,
        scale: params.scale ?? 1.4,
        modelChain: resolveSummaryModelChain(params.chain, params.modelChain),
        chain: resolveSummaryModelChain(params.chain, params.modelChain),
        background: params.background ?? false,
        batchSize: params.batchSize ?? 5,
        thresholds: params.thresholds,
    };
}

async function getStructure(route: InspectRoute, params: NormalizedInspectInput): Promise<PageStructure[] | EmptyStructure> {
    if (route === "dom") {
        return await extractDomStructure(params.url, { timeout: 30_000 });
    }
    if (route === "pdf") {
        const pdfPath = await resolvePdfPathFromUrl(params.url);
        return await extractPdfStructure(pdfPath, params.page);
    }
    if (route === "pptx") {
        const pptxPath = localPptxPathFromUrl(params.url);
        return await extractPptxStructure(pptxPath, params.page);
    }
    if (route === "ebook") {
        return extractEpubStructure(fileURLToPath(params.url));
    }

    return emptyStructure(params.page);
}

async function runDetection(route: InspectRoute, params: NormalizedInspectInput): Promise<InspectResult | EmptyInspectResult> {
    if (route === "dom") {
        return await detectDomIssues(params.url, params.detect, params.autoScreenshot, params.scale, {
            timeout: 30_000,
            smallFontThresholdPx: params.thresholds?.smallFontPx,
            contrastRatioThreshold: params.thresholds?.contrastRatio,
        });
    }
    if (route === "pdf") {
        const pdfPath = await resolvePdfPathFromUrl(params.url);
        return await detectPdfIssues(pdfPath, params.page, params.detect, params.autoScreenshot, params.scale, params.thresholds);
    }
    if (route === "pptx") {
        const pptxPath = localPptxPathFromUrl(params.url);
        return await detectPptxIssues(pptxPath, params.page, params.detect, params.thresholds);
    }
    if (route === "ebook") {
        const structure = await getStructure(route, params);
        const warnings = Array.isArray(structure) ? (structure[0]?.metadata?.warnings as unknown[] | undefined) ?? [] : [];
        return {
            summary: {
                pages: Array.isArray(structure) ? structure.length : 0,
                elements: Array.isArray(structure) ? structure.reduce((sum, page) => sum + page.elements.length, 0) : 0,
                issues: warnings.length,
                warnings: warnings.length,
                errors: 0,
            },
            issues: warnings.map((warning, index) => ({
                type: "ebook-warning",
                severity: "warning" as const,
                page: 1,
                description: String(warning),
                elements: [],
                metadata: { index },
            })),
            structure: Array.isArray(structure) ? structure : undefined,
        };
    }

    return emptyDetection(route, params.mode);
}

async function runAIReview(route: InspectRoute, params: NormalizedInspectInput, progress?: BackgroundTaskProgress): Promise<AIReviewReport> {
    if (route === "ebook") {
        const structure = await getStructure(route, params);
        return {
            summary: Array.isArray(structure)
                ? `EPUB 静态结构已提取：${structure[0]?.metadata?.chapterCount ?? 0} 个章节；第一阶段不执行截图型 AI 视觉审查。`
                : "EPUB 静态结构不可用；第一阶段不执行截图型 AI 视觉审查。",
            aiFindings: [],
            confirmedIssues: [],
            dismissedIssues: [],
            dismissReason: {},
        };
    }
    const structure = await getStructure(route, params);
    if (!Array.isArray(structure)) {
        return aiReviewError(route, "无法提取页面结构，AI 审查已跳过");
    }
    const detection = await runDetection(route, { ...params, autoScreenshot: true });
    if (!("summary" in detection) || !Array.isArray(detection.issues)) {
        return aiReviewError(route, "无法运行几何检测，AI 审查已跳过");
    }

    const pages = structure.map(page => page.page);
    progress && (progress.total = pages.length);
    const reports: AIReviewReport[] = [];
    for (let index = 0; index < pages.length; index += params.batchSize) {
        const batch = pages.slice(index, index + params.batchSize);
        const batchReports = await Promise.all(batch.map(async pageNumber => {
            const pageStructure = structure.find(page => page.page === pageNumber);
            if (!pageStructure) return null;
            const pageIssues = detection.issues.filter(issue => issue.page === pageNumber);
            const screenshotPath = await captureReviewScreenshot(route, params.url, pageNumber, params.scale);
            const prompt = buildAIReviewPrompt(route, params.url, pageNumber, pageStructure, pageIssues, screenshotPath);
            const model = await generateModelText({
                prompt,
                chain: params.modelChain,
                timeoutMs: AI_REVIEW_TIMEOUT_MS,
                schema: aiReviewSchema(),
                schemaName: "ai-review",
                imagePaths: screenshotPath ? [screenshotPath] : [],
            });
            const report = normalizeAIReviewResponse(model.text, {
                route,
                page: pageNumber,
                screenshotPath,
                chainUsed: model.chainUsed,
                providerLabel: model.providerLabel,
                error: model.error,
                knownIssues: pageIssues,
            });
            if (progress) progress.completed += 1;
            return report;
        }));
        reports.push(...batchReports.filter((report): report is AIReviewReport => report !== null));
    }

    return persistAIReviewReport(mergeAIReviewReports(reports));
}

function emptyStructure(page: number | "all" | null): EmptyStructure {
    return {
        page,
        dimensions: null,
        elements: [],
    };
}

function emptyDetection(route: InspectRoute, mode: InspectMode): EmptyInspectResult {
    return {
        summary: {
            status: "not_implemented",
            message: `Stage 17 only provides the web_inspect dispatch framework; ${route} detection is not implemented yet.`,
            route,
            mode,
        },
        issues: [],
        structure: emptyStructure(null),
    };
}

function unimplementedAIReview(route: InspectRoute): EmptyAIReviewReport {
    return {
        summary: `Stage 17 only provides the web_inspect dispatch framework; ${route} ai_review is not implemented yet.`,
        aiFindings: [],
        confirmedIssues: [],
        dismissedIssues: [],
        dismissReason: {},
    };
}

function startAIReviewTask(route: InspectRoute, params: NormalizedInspectInput): string {
    cleanupBackgroundTasks();
    const id = `inspect-ai-${randomUUID()}`;
    const task: BackgroundTask = {
        id,
        status: "running",
        progress: { completed: 0, total: 1 },
        startedAt: Date.now(),
        route,
        params,
        maxRunMs: BACKGROUND_TASK_TIMEOUT_MS,
        deadlineAt: Date.now() + BACKGROUND_TASK_TIMEOUT_MS,
    };
    backgroundTasks.set(id, task);
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const settle = (status: Exclude<BackgroundTaskStatus, "running">, value: AIReviewReport | string, timedOut = false) => {
        if (settled) return;
        settled = true;
        if (timeout) {
            clearTimeout(timeout);
            timeout = null;
        }
        task.status = status;
        task.timedOut = timedOut || undefined;
        if (status === "done") {
            task.result = value as AIReviewReport;
        } else {
            task.error = String(value);
        }
        task.finishedAt = Date.now();
    };
    timeout = setTimeout(() => {
        settle("error", "AI Review 后台任务超时", true);
    }, BACKGROUND_TASK_TIMEOUT_MS);
    timeout.unref?.();
    void (async () => {
        try {
            settle("done", await runAIReview(route, params, task.progress));
        } catch (error) {
            settle("error", error instanceof Error ? error.message : String(error));
        }
    })();
    return id;
}

async function checkBackgroundTask(taskId: string | undefined, waitSeconds: number): Promise<InspectResponse> {
    cleanupBackgroundTasks();
    if (!taskId) {
        throw new Error("action=\"check\" 需要 taskId");
    }
    const deadline = Date.now() + waitSeconds * 1000;
    let task = backgroundTasks.get(taskId);
    while (task?.status === "running" && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 250));
        task = backgroundTasks.get(taskId);
    }
    if (!task) {
        throw new Error(`未找到后台任务: ${taskId}`);
    }
    return {
        tool: "web_inspect",
        url: task.params.url,
        route: task.route,
        mode: "ai_review",
        page: task.params.page,
        detect: task.params.detect,
        autoScreenshot: task.params.autoScreenshot,
        scale: task.params.scale,
        modelChain: task.params.modelChain,
        chain: task.params.chain,
        background: true,
        batchSize: task.params.batchSize,
        thresholds: task.params.thresholds,
        taskId,
        status: task.status,
        progress: task.progress,
        deadlineAt: task.deadlineAt ? new Date(task.deadlineAt).toISOString() : undefined,
        timedOut: task.timedOut,
        result: task.result,
        error: task.error,
    };
}

function cleanupBackgroundTasks(): void {
    const now = Date.now();
    for (const [id, task] of backgroundTasks.entries()) {
        if (task.status !== "running" && task.finishedAt && now - task.finishedAt > BACKGROUND_TASK_RESULT_TTL_MS) {
            backgroundTasks.delete(id);
        }
    }
}

async function captureReviewScreenshot(route: InspectRoute, url: string, pageNumber: number, scale: number): Promise<string | null> {
    ensureTempDirs();
    let page;
    try {
        page = await browserManager.navigateTo(url, {
            timeout: 30_000,
            pageNumber: route === "dom" ? undefined : pageNumber,
        });
        await browserManager.waitForVisualReady(page, 3_000).catch(() => undefined);
        const key = generateCacheKey("ai-review", url, route, pageNumber, scale, Date.now());
        const outputPath = `${TEMP_DIRS.screenshots}\\${key}_ai_review.jpg`;
        await page.screenshot({
            path: outputPath,
            type: "jpeg",
            quality: QUALITY_PRESETS.default.jpegQuality,
            fullPage: route === "dom",
        });
        return fs.existsSync(outputPath) ? outputPath : null;
    } catch {
        return null;
    } finally {
        if (page) {
            await page.close().catch(() => undefined);
        }
    }
}

function buildAIReviewPrompt(
    route: InspectRoute,
    url: string,
    pageNumber: number,
    structure: PageStructure,
    issues: InspectResult["issues"],
    screenshotPath: string | null,
): string {
    const compactStructure = {
        ...structure,
        elements: structure.elements.slice(0, AI_REVIEW_MAX_ELEMENTS),
        metadata: {
            ...structure.metadata,
            truncatedElements: Math.max(0, structure.elements.length - AI_REVIEW_MAX_ELEMENTS),
        },
    };
    const compactIssues = issues.slice(0, AI_REVIEW_MAX_ISSUES).map((issue, index) => ({
        id: issueId(issue, index),
        type: issue.type,
        severity: issue.severity,
        description: issue.description,
        bounds: issue.bounds,
        elements: issue.elements.map(element => ({
            name: element.name,
            type: element.type,
            text: element.text,
            bounds: element.bounds,
        })),
    }));

    return `你是一个专业的视觉设计审查员。请综合截图、结构树和几何检测结果检查页面。

请只返回 JSON，不要使用 Markdown 代码块。

页面信息:
- 文件类型: ${route}
- URL: ${url}
- 页码: ${pageNumber}
- 截图文件: ${screenshotPath ?? "截图不可用，仅使用结构数据"}

结构数据:
${JSON.stringify(compactStructure).slice(0, 18_000)}

已知几何问题:
${JSON.stringify(compactIssues).slice(0, 10_000)}

审查要求:
1. 确认或排除已知几何问题。
2. 检查布局平衡、对齐、配色、字号、间距、图片裁剪/拉伸和整体风格一致性。
3. 如果重叠只是文字位于背景色块、装饰图形、阴影或刻意视觉层级上，且仍然可读，请把对应 id 放入 dismissedIssues，并在 dismissReason 说明这是设计意图内的装饰性重叠。

返回 JSON 格式:
{
  "summary": "一句话总结",
  "aiFindings": [
    {"page": ${pageNumber}, "severity": "warning|error|info", "category": "layout|readability|aesthetics|image|consistency", "description": "问题描述", "suggestion": "修改建议"}
  ],
  "confirmedIssues": ["已确认的几何问题 id"],
  "dismissedIssues": ["误报或设计意图内的问题 id"],
  "dismissReason": {"问题 id": "排除原因"}
}`;
}

function aiReviewSchema(): Record<string, unknown> {
    return {
        type: "object",
        additionalProperties: false,
        required: ["summary", "aiFindings", "confirmedIssues", "dismissedIssues", "dismissReason"],
        properties: {
            summary: { type: "string" },
            aiFindings: {
                type: "array",
                items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["page", "severity", "category", "description", "suggestion"],
                    properties: {
                        page: { type: "number" },
                        severity: { type: "string" },
                        category: { type: "string" },
                        description: { type: "string" },
                        suggestion: { type: "string" },
                    },
                },
            },
            confirmedIssues: { type: "array", items: { type: "string" } },
            dismissedIssues: { type: "array", items: { type: "string" } },
            dismissReason: {
                type: "object",
                additionalProperties: false,
                properties: {},
            },
        },
    };
}

function normalizeAIReviewResponse(text: string | null, context: {
    route: InspectRoute;
    page: number;
    screenshotPath: string | null;
    chainUsed: string | null;
    providerLabel: string | null;
    error?: string;
    knownIssues: InspectResult["issues"];
}): AIReviewReport {
    if (!text) {
        return {
            summary: `AI 审查失败：${context.error ?? "模型无返回"}`,
            aiFindings: [],
            confirmedIssues: [],
            dismissedIssues: [],
            dismissReason: {},
            chainUsed: context.chainUsed,
            providerLabel: context.providerLabel,
            error: context.error ?? "AI 模型无返回",
        };
    }

    const parsed = parseJsonObject(text);
    const rawFindings = Array.isArray(parsed.aiFindings) ? parsed.aiFindings : [];
    const aiFindings = rawFindings.map((finding: any) => ({
        page: Number.isFinite(Number(finding.page)) ? Number(finding.page) : context.page,
        severity: normalizeSeverity(finding.severity),
        category: typeof finding.category === "string" ? finding.category : "visual",
        description: typeof finding.description === "string" ? finding.description : String(finding.description ?? ""),
        suggestion: typeof finding.suggestion === "string" ? finding.suggestion : undefined,
        metadata: {
            screenshotPath: context.screenshotPath,
            route: context.route,
        },
    })).filter(finding => finding.description);

    return {
        summary: typeof parsed.summary === "string" ? parsed.summary : `AI 审查第 ${context.page} 页完成`,
        aiFindings,
        confirmedIssues: normalizeStringArray(parsed.confirmedIssues),
        dismissedIssues: normalizeStringArray(parsed.dismissedIssues),
        dismissReason: normalizeDismissReason(parsed.dismissReason),
        chainUsed: context.chainUsed,
        providerLabel: context.providerLabel,
        rawResponse: text,
    };
}

function parseJsonObject(text: string): Record<string, any> {
    const cleaned = text
        .replace(/^```json\s*/iu, "")
        .replace(/^```\s*/iu, "")
        .replace(/```$/u, "")
        .trim();
    try {
        const parsed = JSON.parse(cleaned);
        return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
        const first = cleaned.indexOf("{");
        const last = cleaned.lastIndexOf("}");
        if (first >= 0 && last > first) {
            try {
                const parsed = JSON.parse(cleaned.slice(first, last + 1));
                return parsed && typeof parsed === "object" ? parsed : {};
            } catch {
                return { summary: cleaned };
            }
        }
        return { summary: cleaned };
    }
}

function normalizeSeverity(value: unknown): "info" | "warning" | "error" {
    return value === "error" || value === "warning" || value === "info" ? value : "warning";
}

function normalizeStringArray(value: unknown): string[] {
    return Array.isArray(value) ? value.map(item => String(item)).filter(Boolean) : [];
}

function normalizeDismissReason(value: unknown): Record<string, string> {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).map(([key, reason]) => [key, String(reason)]));
}

function mergeAIReviewReports(reports: AIReviewReport[]): AIReviewReport {
    const errors = reports.map(report => report.error).filter(Boolean) as string[];
    return {
        summary: reports.length === 1
            ? reports[0].summary
            : `AI 审查 ${reports.length} 页，发现 ${reports.reduce((sum, report) => sum + report.aiFindings.length, 0)} 个视觉问题`,
        aiFindings: reports.flatMap(report => report.aiFindings),
        confirmedIssues: [...new Set(reports.flatMap(report => report.confirmedIssues))],
        dismissedIssues: [...new Set(reports.flatMap(report => report.dismissedIssues))],
        dismissReason: Object.assign({}, ...reports.map(report => report.dismissReason)),
        chainUsed: reports.find(report => report.chainUsed)?.chainUsed ?? null,
        providerLabel: reports.find(report => report.providerLabel)?.providerLabel ?? null,
        error: errors.length ? errors.join("; ") : undefined,
    };
}

function persistAIReviewReport(report: AIReviewReport): AIReviewReport {
    const reportPath = saveTempFile(
        "pages",
        generateCacheKey("ai-review-report", Date.now(), report.summary),
        ".json",
        JSON.stringify(report, null, 2),
    );
    return { ...report, reportPath };
}

function aiReviewError(route: InspectRoute, message: string): AIReviewReport {
    return persistAIReviewReport({
        summary: `${route} AI 审查失败：${message}`,
        aiFindings: [],
        confirmedIssues: [],
        dismissedIssues: [],
        dismissReason: {},
        error: message,
    });
}

function issueId(issue: InspectResult["issues"][number], index: number): string {
    return `${issue.type}_p${issue.page}_${index}`;
}
