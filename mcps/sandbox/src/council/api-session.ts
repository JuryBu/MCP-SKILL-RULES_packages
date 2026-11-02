import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { AgentClient } from "../agent-client/client.js";
import { readArtifactBytes } from "../agent-client/artifacts.js";
import { AgentFault, canonicalJson, MAX_FRAME_BYTES } from "../agent-server/protocol.js";
import type { JsonValue, RpcResult } from "../agent-server/protocol.js";
import type { NormalizedResponse } from "../agent-server/providers/types.js";
import type { CouncilApiSession } from "./providers.js";
import type { CouncilModelConfig } from "./types.js";
import { councilArtifactPath, registerCouncilArtifact } from "./artifact-store.js";
import { saveCouncilApiResponse } from "./api-results.js";
export { appendCouncilUser } from "./api-input.js";

export interface CouncilAgentClient {
    request<Data = unknown>(method: string, params?: Record<string, unknown>, options?: { clientCommandId?: string }): Promise<RpcResult<Data>>;
    getReceipt<Data = unknown>(commandId: string, conversationId?: string): Promise<RpcResult<Data>>;
    close(): Promise<void>;
    startControlRenewal?(): void;
}

export type CouncilApiClientFactory = (options: { clientId: string }) => Promise<CouncilAgentClient>;
interface CallState { commandId: string; started: boolean; budget: Record<string, unknown>; runId?: string; responsePath?: string }
interface ActorState {
    schemaVersion: 1; clientId: string; configHash: string; createCommandId: string; createStarted: boolean;
    conversationId?: string; modelId?: string; calls: Record<string, CallState>;
}

function digest(value: unknown): string { return createHash("sha256").update(canonicalJson(value)).digest("hex"); }
function unwrap<Data>(result: RpcResult<Data>): Data {
    if (!result.ok) throw new AgentFault(result.error?.code ?? "E_COUNCIL_AGENT", result.error?.message ?? "Agent Server请求失败",
        result.error?.details, result.error?.mayHaveStarted, result.error?.retryable);
    return result.data as Data;
}

async function recoverReceipt<Data>(client: CouncilAgentClient, commandId: string, conversationId?: string): Promise<Data> {
    const receipt = await client.getReceipt<{ found: boolean; result?: RpcResult<Data> }>(commandId, conversationId);
    if (!receipt.ok || !receipt.data?.found || !receipt.data.result) throw new AgentFault("E_COUNCIL_RECEIPT_UNKNOWN",
        "原讨论回执暂不可查，保留原命令ID，不重新派发", { clientCommandId: commandId, conversationId }, true);
    return unwrap(receipt.data.result);
}

export function councilImageReferences(imagePaths: string[]): Record<string, unknown>[] {
    return imagePaths.map(source => {
        const mime = ({ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" } as Record<string, string>)[path.extname(source).toLowerCase()];
        if (!mime) throw new AgentFault("E_COUNCIL_IMAGE_MIME", "图片须使用PNG/JPEG/WebP/GIF原件");
        if (fs.statSync(source).size > MAX_FRAME_BYTES / 2) throw new AgentFault("E_COUNCIL_IMAGE_LIMIT", "图片超过控制通道上限，请先准备较小的原件");
        const bytes = fs.readFileSync(source);
        return { kind: "council_image", mime, dataBase64: bytes.toString("base64"), byteLength: bytes.length,
            sha256: createHash("sha256").update(bytes).digest("hex") };
    });
}

export class AgentCouncilSession implements CouncilApiSession {
    private readonly clients = new Map<string, Promise<CouncilAgentClient>>();
    constructor(private readonly options: { runId: string; sourceRunId?: string; ownerId?: string; clientFactory?: CouncilApiClientFactory }) {}

    async close(): Promise<void> {
        await Promise.all([...this.clients.values()].map(async client => (await client).close()));
        this.clients.clear();
    }

    async call(config: CouncilModelConfig, prompt: string, imagePaths: string[], timeoutMs: number, signal?: AbortSignal): Promise<NormalizedResponse> {
        if (!config.profileId) throw new AgentFault("E_PROFILE_REQUIRED", "Council API参与者需要profileId");
        if (["apiKey", "apiKeyEnv", "baseUrl", "endpoint", "headers", "body", "fallbackModels"].some(key => Object.hasOwn(config.params ?? {}, key))) {
            throw new AgentFault("E_COUNCIL_PROFILE_PARAMETERS", "API参与者只接受模型参数，连接和凭据由profile管理");
        }
        const budget = config.budget;
        if (!budget || !Number.isSafeInteger(budget.maxModelCalls) || Number(budget.maxModelCalls) < 1
            || !Number.isSafeInteger(budget.maxOutputTokens) || Number(budget.maxOutputTokens) < 1 || typeof budget.currency !== "string"
            || !(Number.isFinite(budget.wallMs) && Number(budget.wallMs) > 0 || typeof budget.deadlineAt === "string" && Number.isFinite(Date.parse(budget.deadlineAt)))
            || budget.costMode !== "estimated" && (!Number.isSafeInteger(budget.maxCostMicros) || Number(budget.maxCostMicros) < 0)) {
            throw new AgentFault("BUDGET_REQUIRED", "API讨论需要明确的有限次数、输出、时间、币种与金额预算");
        }
        const key = digest({ id: config.id, profileId: config.profileId });
        const sourceRun = this.options.sourceRunId ?? this.options.runId;
        const statePath = councilArtifactPath(sourceRun, "api-sessions", `${key}.json`);
        const configHash = digest({ profileId: config.profileId, model: config.model ?? null, params: config.params ?? {}, budget });
        const state: ActorState = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : {
            schemaVersion: 1, clientId: digest({ sourceRun, key, kind: "client" }), configHash,
            createCommandId: digest({ sourceRun, key, kind: "create" }), createStarted: false, calls: {},
        };
        if (state.configHash !== configHash) throw new AgentFault("E_COUNCIL_CONFIG_CONFLICT", "恢复的参与者配置已变化，请使用新的参与者身份");
        const save = () => {
            const temporary = `${statePath}.${process.pid}.tmp`;
            fs.writeFileSync(temporary, JSON.stringify(state), "utf8");
            fs.renameSync(temporary, statePath);
            registerCouncilArtifact(sourceRun, statePath);
        };
        const references = councilImageReferences(imagePaths);
        const input = { text: prompt, ...(references.length ? { references } : {}) };
        if (Buffer.byteLength(canonicalJson(input)) > MAX_FRAME_BYTES / 2) throw new AgentFault("E_COUNCIL_INPUT_LIMIT", "已准备材料超过控制通道单次上限");
        const operation = digest(input);
        const previous = state.calls[operation];
        if (previous?.responsePath) return JSON.parse(fs.readFileSync(previous.responsePath, "utf8"));
        if (signal?.aborted) throw new AgentFault("E_CANCELLED", "Council讨论已取消");
        if (!this.clients.has(key)) this.clients.set(key, (this.options.clientFactory ?? (options => AgentClient.connect(options)))({ clientId: state.clientId }));
        const client = await this.clients.get(key)!;
        client.startControlRenewal?.();
        const profileResult = unwrap(await client.request<{ profile: { defaultModel?: string; quotaLimitId?: string } }>("profiles.get", { profileId: config.profileId }));
        const modelId = state.modelId ?? config.model ?? profileResult.profile.defaultModel;
        if (!modelId) throw new AgentFault("E_MODEL_REQUIRED", "API配置尚未选择模型");
        state.modelId = modelId;
        if (!profileResult.profile.quotaLimitId && !budget.quotaLimitId) throw new AgentFault("E_GLOBAL_BUDGET_REQUIRED", "API讨论须沿用已配置的供应商累计费用上限");
        unwrap(await client.request("models.get", { profileId: config.profileId, modelId }));
        const options = { profileId: config.profileId, modelId, parameters: config.params ?? {}, toolsEnabled: false, tools: [], discussionOnly: true,
            delegation: { enabled: false }, instructions: "Council只讨论已准备材料。不要提出执行命令、写文件、调用工具或派发模型。" };
        if (!state.conversationId) {
            if (state.createStarted) {
                state.conversationId = (await recoverReceipt<{ conversationId: string }>(client, state.createCommandId)).conversationId;
            } else {
                state.createStarted = true;
                save();
                state.conversationId = unwrap(await client.request<{ conversationId: string }>("conversations.create", {
                    retention: { mode: "archive" }, options, callerHost: "sandbox_council", ...(this.options.ownerId ? { callerConversationId: this.options.ownerId } : {}),
                }, { clientCommandId: state.createCommandId })).conversationId;
            }
            save();
        }
        const conversationId = state.conversationId;
        let call = state.calls[operation];
        if (!call) {
            const deadlineAt = new Date(Math.min(Date.now() + timeoutMs, Date.now() + Number(budget.wallMs ?? timeoutMs),
                typeof budget.deadlineAt === "string" ? Date.parse(budget.deadlineAt) : Infinity)).toISOString();
            call = state.calls[operation] = { commandId: digest({ sourceRun, key, operation, kind: "run" }), started: false,
                budget: { ...budget, deadlineAt, wallMs: Math.max(1, Date.parse(deadlineAt) - Date.now()), maxModelCalls: 1 } };
            if (Date.parse(deadlineAt) <= Date.now()) throw new AgentFault("BUDGET_EXCEEDED", "原讨论预算期限已到，保持未派发");
            save();
        }
        if (!call.runId) {
            if (call.started) {
                call.runId = (await recoverReceipt<{ runId: string }>(client, call.commandId, conversationId)).runId;
            } else {
                call.started = true;
                save();
                call.runId = unwrap(await client.request<{ runId: string }>("runs.start", { conversationId, input, budget: call.budget },
                    { clientCommandId: call.commandId })).runId;
            }
            save();
        }
        const deadline = Date.parse(String(call.budget.deadlineAt));
        while (true) {
            const run = unwrap(await client.request<Record<string, unknown>>("runs.get", { conversationId, runId: call.runId }));
            if (run.state === "succeeded") {
                const response = await this.readResponse(client, conversationId, call.runId!, run.activeRoundId as string | undefined);
                call.responsePath = saveCouncilApiResponse(sourceRun, response).responsePath as string;
                save();
                return response;
            }
            if (["outcome_unknown", "failed", "paused", "cancelled", "budget_exceeded", "expired"].includes(String(run.state)) || run.executorAvailable === false) {
                throw new AgentFault(String(run.stopReason ?? "E_COUNCIL_RUN_INCOMPLETE"), "原讨论尚无完整成功结果，保留原执行与费用状态", { conversationId, runId: call.runId, state: run.state, failure: run.failure }, run.state === "outcome_unknown");
            }
            if (signal?.aborted || Date.now() >= deadline) {
                await client.request("runs.cancel", { conversationId, runId: call.runId, expectedRunEpoch: run.runEpoch, reason: "Council调用已取消或达到原期限" });
                throw new AgentFault("E_COUNCIL_WAIT_ENDED", "已停止等待原讨论，原请求与费用可查", { conversationId, runId: call.runId }, true);
            }
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }

    private async readResponse(client: CouncilAgentClient, conversationId: string, runId: string, roundId?: string): Promise<NormalizedResponse> {
        let cursor: string | undefined;
        for (let pageIndex = 0; pageIndex < 100; pageIndex++) {
            const page = unwrap(await client.request<{ items: { role: string; runId?: string; roundId?: string; contentId: string }[]; hasMore: boolean; nextCursor?: string }>(
                "conversations.readHistory", { conversationId, ...(cursor ? { cursor } : {}), limit: 100, maxBytes: 256 * 1024 }));
            for (const item of [...page.items].reverse()) {
                if (item.role !== "assistant" || item.runId !== runId && (!roundId || item.roundId !== roundId)) continue;
                const artifact = await readArtifactBytes(client, conversationId, item.contentId, { maxTotalBytes: 64 * 1024 * 1024 });
                const value = JSON.parse(artifact.bytes.toString("utf8"));
                if (value.response) return value.response as NormalizedResponse;
            }
            if (!page.hasMore) break;
            if (!page.nextCursor || page.nextCursor === cursor) throw new AgentFault("E_COUNCIL_HISTORY_CURSOR", "原生结果分页未前进");
            cursor = page.nextCursor;
        }
        throw new AgentFault("E_COUNCIL_NATIVE_RESULT_MISSING", "原执行已结束，但原生结果引用未取回", { conversationId, runId }, true);
    }
}
