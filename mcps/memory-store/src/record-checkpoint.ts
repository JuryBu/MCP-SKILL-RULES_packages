// Record 生成引擎 —— RecordPatch checkpoint 持久化。
// 由 record-generator.ts 拆分而来（E2-B2），纯结构搬运、零行为变更。
import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { TEMP_DIR } from "./temp-store.js";
import type { Chain } from "./chain.js";
import type { RecordPatch, RecordPatchCheckpoint } from "./record-types.js";
import { RECORD_PATCH_CHECKPOINT_ENABLED, RECORD_PATCH_CHECKPOINT_VERSION } from "./record-config.js";

export function hashText(text: string): string {
    return createHash("sha256").update(text).digest("hex");
}

export function safePathSegment(value: string): string {
    return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "unknown";
}

export function recordPatchCheckpointDir(conversationId: string): string {
    return path.join(TEMP_DIR, "record-patch-checkpoints", safePathSegment(conversationId));
}

export function recordPatchCheckpointPath(
    kind: RecordPatchCheckpoint["kind"],
    conversationId: string,
    modelChain: Chain,
    startRound: number,
    endRound: number,
    promptHash: string,
): string {
    const filename = [
        kind,
        safePathSegment(modelChain),
        `${startRound}-${endRound}`,
        promptHash.slice(0, 16),
    ].join("__") + ".json";
    return path.join(recordPatchCheckpointDir(conversationId), filename);
}

export function readRecordPatchCheckpoint(
    kind: RecordPatchCheckpoint["kind"],
    conversationId: string,
    modelChain: Chain,
    startRound: number,
    endRound: number,
    prompt: string,
): RecordPatch | null {
    if (!RECORD_PATCH_CHECKPOINT_ENABLED) return null;
    const promptHash = hashText(prompt);
    const filePath = recordPatchCheckpointPath(kind, conversationId, modelChain, startRound, endRound, promptHash);
    try {
        const checkpoint = JSON.parse(fs.readFileSync(filePath, "utf-8")) as RecordPatchCheckpoint;
        if (
            checkpoint.version === RECORD_PATCH_CHECKPOINT_VERSION
            && checkpoint.status === "done"
            && checkpoint.promptHash === promptHash
            && checkpoint.patch
        ) {
            return checkpoint.patch;
        }
    } catch {
        return null;
    }
    return null;
}

export function writeRecordPatchCheckpoint(
    kind: RecordPatchCheckpoint["kind"],
    conversationId: string,
    workspace: string,
    modelChain: Chain,
    startRound: number,
    endRound: number,
    prompt: string,
    status: RecordPatchCheckpoint["status"],
    patch?: RecordPatch,
    error?: string,
): string | null {
    if (!RECORD_PATCH_CHECKPOINT_ENABLED) return null;
    const promptHash = hashText(prompt);
    const dir = recordPatchCheckpointDir(conversationId);
    fs.mkdirSync(dir, { recursive: true });
    const filePath = recordPatchCheckpointPath(kind, conversationId, modelChain, startRound, endRound, promptHash);
    const checkpoint: RecordPatchCheckpoint = {
        version: RECORD_PATCH_CHECKPOINT_VERSION,
        kind,
        status,
        conversationId,
        workspace,
        modelChain,
        startRound,
        endRound,
        promptHash,
        savedAt: new Date().toISOString(),
        patch,
        error,
    };
    fs.writeFileSync(filePath, JSON.stringify(checkpoint, null, 2), "utf-8");
    return filePath;
}
