import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { formatRound } from "../src/trajectory.ts";
import {
    __resetWindsurfEndpointCacheForTest,
    __setWindsurfEndpointResolverForTest,
    __setWindsurfTransportFactoryForTest,
    listWindsurfConversations,
    listRecentWindsurfThreads,
    loadWindsurfConversation,
    normalizeWindsurfTrajectoryList,
    readWindsurfCascadeSteps,
    readWindsurfSubagentParentMap,
    windsurfStepsToConversationRounds,
    type WindsurfLsEndpoint,
    type WindsurfLsTransport,
} from "../src/windsurf-client.ts";

const tinyPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const jobsTempDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-wsf-jobs-test-"));
const jobsPath = path.join(jobsTempDir, "jobs.json");
const previousJobsPath = process.env.MEMORY_STORE_WSF_SUBAGENT_JOBS_PATH;
process.env.MEMORY_STORE_WSF_SUBAGENT_JOBS_PATH = jobsPath;
process.on("exit", () => {
    if (previousJobsPath === undefined) {
        delete process.env.MEMORY_STORE_WSF_SUBAGENT_JOBS_PATH;
    } else {
        process.env.MEMORY_STORE_WSF_SUBAGENT_JOBS_PATH = previousJobsPath;
    }
    fs.rmSync(jobsTempDir, { recursive: true, force: true });
});

fs.writeFileSync(
    jobsPath,
    JSON.stringify({
        version: 1,
        jobs: {
            "job-sub": {
                job_id: "job-sub",
                sub_cid: "cascade-sub",
                main_id: "cascade-new",
                label: "test-naming-check",
                title_best_effort: "[subagent] test-naming-check",
                state: "completed",
                model: "claude-opus-4-8-xhigh",
                created_at: "2026-05-28T11:00:00Z",
                updated_at: "2026-05-28T11:10:00Z",
                result_step_count: 2,
                result_preview: JSON.stringify({
                    steps: [
                        { type: "CORTEX_STEP_TYPE_USER_INPUT", userInput: { userResponse: "子代理用户消息" } },
                        { type: "CORTEX_STEP_TYPE_PLANNER_RESPONSE", plannerResponse: { response: "子代理回复" } },
                    ],
                }),
            },
            "job-tombstone-active": {
                job_id: "job-tombstone-active",
                sub_cid: "cascade-deleted",
                main_id: "cascade-new",
                label: "deleted-check",
                title_best_effort: "[subagent] deleted-check",
                state: "completed",
            },
            "job-tombstone-deleted": {
                job_id: "job-tombstone-deleted",
                sub_cid: "cascade-deleted",
                main_id: "cascade-new",
                label: "deleted-check",
                title_best_effort: "[subagent] deleted-check",
                state: "Deleted",
            },
            "job-tombstone-first-deleted": {
                job_id: "job-tombstone-first-deleted",
                sub_cid: "cascade-deleted-first",
                main_id: "cascade-new",
                label: "deleted-first-check",
                title_best_effort: "[subagent] deleted-first-check",
                state: "deleted",
            },
            "job-tombstone-first-active": {
                job_id: "job-tombstone-first-active",
                sub_cid: "cascade-deleted-first",
                main_id: "cascade-new",
                label: "deleted-first-check",
                title_best_effort: "[subagent] deleted-first-check",
                state: "completed",
            },
        },
    }),
    "utf-8",
);

const normalized = normalizeWindsurfTrajectoryList({
    trajectorySummaries: {
        "cascade-sub": {
            summary: "普通摘要不含 marker",
            title: "普通标题不含 marker",
            stepCount: 2,
            lastModifiedTime: "2026-05-28T11:10:00Z",
            trajectoryId: "trajectory-sub",
        },
        "cascade-old": {
            summary: "旧 WSF 对话",
            stepCount: "3",
            lastModifiedTime: "2026-05-28T12:00:00Z",
            trajectoryId: "trajectory-old",
            status: "CASCADE_RUN_STATUS_IDLE",
            lastGeneratorModelUid: "claude-opus-4-6-thinking",
        },
        "cascade-new": {
            summary: "新 WSF 对话",
            renamedTitle: "步步开发对话6",
            stepCount: 5,
            lastModifiedTime: "2026-05-29T12:00:00Z",
            trajectoryId: "trajectory-new",
            status: "CASCADE_RUN_STATUS_RUNNING",
            workspaces: [
                { workspaceFolderAbsoluteUri: "file:///c:/Users/Stardust/Desktop/%E7%BE%A4%E9%A1%B9%E7%9B%AE" },
                { workspaceFolderAbsoluteUri: "file:///c:/Users/Stardust/Desktop/%E7%BE%A4%E9%A1%B9%E7%9B%AE/sub" },
            ],
            referencedFiles: [
                "file:///c:/Users/Stardust/Desktop/%E7%BE%A4%E9%A1%B9%E7%9B%AE/Task.md",
            ],
        },
    },
});

assert.equal(normalized.length, 3);
assert.equal(normalized[0].id, "cascade-new");
assert.equal(normalized[0].title, "步步开发对话6");
assert.equal(normalized[0].summary, "新 WSF 对话");
assert.equal(normalized[0].renamedTitle, "步步开发对话6");
assert.equal(normalized[0].titleSource, "renamedTitle");
assert.equal(normalized[0].workspaceUris?.length, 2);
assert.match(normalized[0].cwd || "", /Users[\\/]Stardust[\\/]Desktop[\\/]群项目/iu);
assert.match(normalized[0].referencedFiles?.[0] || "", /Task\.md$/u);
const normalizedSubagent = normalized.find(item => item.id === "cascade-sub");
assert.ok(normalizedSubagent);
assert.equal(normalizedSubagent.titleBestEffort, "[subagent] test-naming-check");
assert.equal(normalizedSubagent.isChildThread, true);
assert.equal(normalizedSubagent.parentConversationId, "cascade-new");
assert.equal(normalizedSubagent.agentRole, "test-naming-check");
assert.equal(normalizedSubagent.lastGeneratorModelUid, "claude-opus-4-8-xhigh");
const normalizedOld = normalized.find(item => item.id === "cascade-old");
assert.equal(normalizedOld?.stepCount, 3);
assert.equal(normalizedOld?.lastGeneratorModelUid, "claude-opus-4-6-thinking");
assert.deepEqual([...readWindsurfSubagentParentMap().entries()], [["cascade-sub", "cascade-new"]]);
assert.equal(normalized.some(item => item.id === "cascade-deleted"), false);
assert.equal(normalized.some(item => item.id === "cascade-deleted-first"), false);

const steps = [
    {
        type: "CORTEX_STEP_TYPE_USER_INPUT",
        metadata: { createdAt: "2026-05-29T16:21:53Z" },
        userInput: {
            userResponse: "  用户直接输入 \n",
            items: [{ text: "items 里的补充文本" }],
            images: [{ base64Data: tinyPng, mimeType: "image/png" }],
        },
    },
    {
        type: "CORTEX_STEP_TYPE_PLANNER_RESPONSE",
        plannerResponse: {
            response: "原始回复",
            modifiedResponse: "修改后的最终回复",
            thinking: "隐藏思考不应该默认进入正文",
            thinkingDuration: "1.2s",
            signatureType: "anthropic",
            messageId: "bot-message-1",
            toolCalls: [{ name: "run_command", argumentsJson: "{\"CommandLine\":\"npm test\"}" }],
        },
    },
    {
        type: "CORTEX_STEP_TYPE_RUN_COMMAND",
        metadata: { toolCall: { name: "run_command", argumentsJson: "{\"CommandLine\":\"npm test\",\"Cwd\":\"C:\\\\repo\"}" } },
        runCommand: {
            commandLine: "npm test",
            cwd: "C:\\repo",
            exitCode: 0,
            combinedOutput: { full: "tests passed" },
        },
    },
    {
        type: "CORTEX_STEP_TYPE_MCP_TOOL",
        mcpTool: {
            serverName: "memory-store",
            toolCall: { name: "record_manage", argumentsJson: "{\"action\":\"read\"}" },
            resultString: "Record read ok",
        },
    },
    {
        type: "CORTEX_STEP_TYPE_VIEW_FILE",
        metadata: { toolCall: { name: "read_file", argumentsJson: "{\"file_path\":\"C:\\\\repo\\\\Task.md\"}" } },
        viewFile: {
            absolutePathUri: "file:///C:/repo/Task.md",
            content: "<file name=\"Task.md\">Stage 1 done</file>",
            endLine: 12,
        },
    },
    {
        type: "CORTEX_STEP_TYPE_CODE_ACTION",
        metadata: { toolCall: { name: "write_to_file", argumentsJson: "{\"TargetFile\":\"C:\\\\repo\\\\Task.md\"}" } },
        codeAction: {
            actionSpec: {
                createFile: {
                    path: { absoluteUri: "file:///C:/repo/Task.md" },
                    instruction: "Stage 1 done",
                },
            },
            actionResult: {
                edit: {
                    absoluteUri: "file:///C:/repo/Task.md",
                    createFile: true,
                    diff: {
                        unifiedDiff: {
                            lines: [
                                { type: "UNIFIED_DIFF_LINE_TYPE_INSERT", text: "Stage 1 done" },
                            ],
                        },
                    },
                },
            },
        },
    },
    {
        type: "CORTEX_STEP_TYPE_USER_INPUT",
        userInput: {
            items: [{ text: "\t只有 item text 的用户消息  " }],
        },
    },
    {
        type: "CORTEX_STEP_TYPE_PLANNER_RESPONSE",
        plannerResponse: {
            response: "第二轮回复",
        },
    },
];

const rounds = windsurfStepsToConversationRounds(steps);
assert.equal(rounds.length, 2);
assert.equal(rounds[0].roundIndex, 1);
assert.equal(rounds[0].startStep, 0);
assert.equal(rounds[0].endStep, 5);
assert.equal(rounds[0].userMessage, "  用户直接输入 \n");
assert.doesNotMatch(rounds[0].userMessage, /items 里的补充文本/u);
assert.equal(rounds[0].aiResponses[0].response, "修改后的最终回复");
assert.equal(rounds[0].aiResponses[0].thinking, "隐藏思考不应该默认进入正文");
assert.equal(rounds[0].aiResponses[0].toolCalls[0].name, "run_command");
assert.equal((rounds[0].aiResponses[0] as any).thinkingMetadata.thinkingDuration, "1.2s");
assert.equal((rounds[0].aiResponses[0] as any).thinkingMetadata.signatureType, "anthropic");
assert.equal((rounds[0].aiResponses[0] as any).thinkingMetadata.messageId, "bot-message-1");
assert.equal(rounds[0].toolCalls.length, 4);
assert.equal(rounds[0].toolCalls[0].name, "run_command");
assert.match(rounds[0].toolCalls[0].resultSummary, /tests passed/u);
assert.equal(rounds[0].toolCalls[1].name, "record_manage");
assert.match(rounds[0].toolCalls[2].resultSummary, /Stage 1 done/u);
assert.equal(rounds[0].fileViews?.[0].kind, "windsurf_view_file");
assert.equal(rounds[0].codeActions[0].targetFile, "C:\\repo\\Task.md");
assert.match(rounds[0].codeActions[0].diffs[0].unifiedDiff || "", /\+Stage 1 done/u);
assert.equal(rounds[1].userMessage, "\t只有 item text 的用户消息  ");
assert.equal(rounds[1].aiResponses[0].response, "第二轮回复");

const normalFormatted = formatRound(rounds[0], "normal");
assert.match(normalFormatted, /修改后的最终回复/u);
assert.match(normalFormatted, /run_command/u);
assert.doesNotMatch(normalFormatted, /隐藏思考不应该默认进入正文/u);
assert.doesNotMatch(normalFormatted, new RegExp(tinyPng.slice(0, 24), "u"));

const fullFormatted = formatRound(rounds[0], "full", ["thinking"]);
assert.match(fullFormatted, /隐藏思考不应该默认进入正文/u);
const evidenceFormatted = formatRound(rounds[0], "full", ["tool_results", "code_actions", "code_diffs", "file_views"]);
assert.match(evidenceFormatted, /tests passed/u);
assert.match(evidenceFormatted, /Record read ok/u);
assert.match(evidenceFormatted, /Stage 1 done/u);
assert.match(evidenceFormatted, /C:\\repo\\Task.md/u);

const firstAttachment = rounds[0].attachments?.[0] as any;
assert.ok(firstAttachment);
assert.equal(firstAttachment.kind, "image");
assert.equal(firstAttachment.source, "windsurf-data-url");
assert.equal(firstAttachment.mimeType, "image/png");
assert.equal(firstAttachment.name, "wsf-step-0-image-1.png");
assert.equal(firstAttachment.sizeBytes, Buffer.from(tinyPng, "base64").length);
assert.equal(firstAttachment.sha256.length, 64);
assert.match(firstAttachment.dataUrl, /^data:image\/png;base64,/u);

const oversizedAttachmentRound = windsurfStepsToConversationRounds([
    {
        type: "CORTEX_STEP_TYPE_USER_INPUT",
        userInput: {
            images: [{ mimeType: "image/png", base64Data: "A".repeat((8 * 1024 * 1024) + 1) }],
        },
    },
])[0];
const oversizedAttachment = oversizedAttachmentRound?.attachments?.[0] as any;
assert.ok(oversizedAttachment);
assert.equal(oversizedAttachment.dataUrl, undefined);
assert.equal(oversizedAttachment.sha256, undefined);
assert.match(oversizedAttachment.warning || "", /encoded input exceeds.*safety limit/u);

const calledOffsets: number[] = [];
const pagedTransport = async (method: string, payload?: Record<string, unknown>): Promise<unknown> => {
    assert.equal(method, "GetCascadeTrajectorySteps");
    assert.equal(payload?.cascadeId, "cascade-paged");
    calledOffsets.push(Number(payload?.stepOffset));
    if (payload?.stepOffset === 0) {
        return { steps: [{ type: "CORTEX_STEP_TYPE_USER_INPUT", userInput: { userResponse: "第一页用户" } }, { type: "CORTEX_STEP_TYPE_PLANNER_RESPONSE", plannerResponse: { response: "第一页回复" } }] };
    }
    if (payload?.stepOffset === 2) {
        return { steps: [{ type: "CORTEX_STEP_TYPE_USER_INPUT", userInput: { userResponse: "第二页用户" } }] };
    }
    return { steps: [] };
};

const paged = await readWindsurfCascadeSteps(pagedTransport, "cascade-paged");
assert.deepEqual(calledOffsets, [0, 2, 3]);
assert.equal(paged.pagesRead, 3);
assert.equal(paged.steps.length, 3);
assert.equal(paged.partial, false);
assert.equal(paged.skippedSteps.length, 0);

const oversizedOffsets: number[] = [];
const oversizedTransport = async (method: string, payload?: Record<string, unknown>): Promise<unknown> => {
    assert.equal(method, "GetCascadeTrajectorySteps");
    assert.equal(payload?.cascadeId, "cascade-oversized");
    const offset = Number(payload?.stepOffset);
    oversizedOffsets.push(offset);
    if (offset === 0) {
        return { steps: [{ type: "CORTEX_STEP_TYPE_USER_INPUT", userInput: { userResponse: "超大前用户" } }, { type: "CORTEX_STEP_TYPE_PLANNER_RESPONSE", plannerResponse: { response: "超大前回复" } }] };
    }
    if (offset === 2) {
        throw new Error('WSF LS GetCascadeTrajectorySteps failed: HTTP 500: {"code":"unknown","message":"step at offset 2 larger than 4194304 byte limit"}');
    }
    if (offset === 3) {
        return { steps: [{ type: "CORTEX_STEP_TYPE_USER_INPUT", userInput: { userResponse: "超大后用户" } }] };
    }
    return { steps: [] };
};

const oversized = await readWindsurfCascadeSteps(oversizedTransport, "cascade-oversized");
assert.deepEqual(oversizedOffsets, [0, 2, 3, 4]);
assert.equal(oversized.partial, true);
assert.equal(oversized.skippedSteps.length, 1);
assert.equal(oversized.skippedSteps[0].offset, 2);
assert.equal(oversized.steps.length, 4);
const oversizedRounds = windsurfStepsToConversationRounds(oversized.steps);
assert.equal(oversizedRounds.length, 3);
assert.match(oversizedRounds[1].userMessage, /WSF 原始 step 2 超过 4194304 字节读取限制/u);
assert.match(oversizedRounds[2].userMessage, /超大后用户/u);

const listTransport = async (method: string): Promise<unknown> => {
    assert.equal(method, "GetAllCascadeTrajectories");
    return { trajectorySummaries: { "cascade-list": { summary: "transport list", stepCount: 1 } } };
};
const listed = await listWindsurfConversations(listTransport);
assert.equal(listed[0].id, "cascade-list");
assert.equal(listed[0].title, "transport list");

const fakeEndpoint: WindsurfLsEndpoint = { pid: 1, port: 1, csrfToken: "token" };
__resetWindsurfEndpointCacheForTest();
__setWindsurfEndpointResolverForTest(async () => [fakeEndpoint]);
__setWindsurfTransportFactoryForTest((_endpoint: WindsurfLsEndpoint): WindsurfLsTransport => {
    return async (method: string, payload?: Record<string, unknown>): Promise<unknown> => {
        if (method === "GetAllCascadeTrajectories") {
            return {
                trajectorySummaries: {
                    "cascade-new": {
                        summary: "新 WSF 对话",
                        renamedTitle: "步步开发对话6",
                        stepCount: 5,
                        lastModifiedTime: "2026-05-29T12:00:00Z",
                    },
                },
            };
        }
        if (method === "GetCascadeTrajectorySteps") {
            assert.equal(payload?.cascadeId, "cascade-new");
            return { steps: [] };
        }
        throw new Error(`unexpected method ${method}`);
    };
});

const recent = await listRecentWindsurfThreads(20);
const recentSubagent = recent.find(item => item.id === "cascade-sub");
assert.ok(recentSubagent, "WSF list should synthesize subagent candidates from jobs.json even when LS does not list sub_cid");
assert.equal(recentSubagent.parentConversationId, "cascade-new");
assert.equal(recentSubagent.titleBestEffort, "[subagent] test-naming-check");
assert.equal(recentSubagent.cwd, recent.find(item => item.id === "cascade-new")?.cwd);
assert.equal(recent.some(item => item.id === "cascade-deleted"), false);
assert.equal(recent.some(item => item.id === "cascade-deleted-first"), false);

const loadedSubagent = await loadWindsurfConversation("cascade-sub");
assert.ok(loadedSubagent);
assert.equal(loadedSubagent.thread.isChildThread, true);
assert.equal(loadedSubagent.thread.parentConversationId, "cascade-new");
assert.equal(loadedSubagent.rounds.length, 1);
assert.match(loadedSubagent.rounds[0].userMessage, /子代理用户消息/u);
assert.match(loadedSubagent.rounds[0].aiResponses[0].response, /子代理回复/u);

__setWindsurfEndpointResolverForTest(null);
__setWindsurfTransportFactoryForTest(null);
__resetWindsurfEndpointCacheForTest();
