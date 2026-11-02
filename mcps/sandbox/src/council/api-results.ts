import fs from "node:fs";
import { createHash } from "node:crypto";
import type { NormalizedResponse } from "../agent-server/providers/types.js";
import { ProviderFault } from "../agent-server/providers/types.js";
import { councilArtifactPath, registerCouncilArtifact } from "./artifact-store.js";

export function saveCouncilApiResponse(runId: string, response: NormalizedResponse): Record<string, unknown> {
    const key = createHash("sha256").update(response.attemptId).digest("hex");
    const responsePath = councilArtifactPath(runId, "api-results", `${key}.json`);
    fs.writeFileSync(responsePath, JSON.stringify(response), "utf8");
    registerCouncilArtifact(runId, responsePath);
    const media: Record<string, unknown>[] = [];
    for (const block of response.blocks) {
        if (!["image", "audio", "video", "file"].includes(block.type)) continue;
        if (block.dataBase64 === undefined) {
            media.push({ type: block.type, mime: block.mime, uri: block.uri, state: "remote_pending", nativeRef: block.nativeRef });
            continue;
        }
        const bytes = Buffer.from(block.dataBase64, "base64");
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        if (bytes.toString("base64") !== block.dataBase64 || block.sha256 && block.sha256 !== sha256
            || block.byteLength !== undefined && block.byteLength !== bytes.length) {
            throw new ProviderFault("E_COUNCIL_MEDIA_INTEGRITY", "原媒体长度或哈希校验失败，已保存原生结果", { acceptance: "accepted", rawResponse: response.raw });
        }
        const extension = ({ "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "audio/wav": "wav", "audio/mpeg": "mp3", "video/mp4": "mp4" } as Record<string, string>)[block.mime ?? ""] ?? "bin";
        const path = councilArtifactPath(runId, "api-results", `${key}-${block.candidateIndex}-${block.index}.${extension}`);
        fs.writeFileSync(path, bytes);
        registerCouncilArtifact(runId, path);
        media.push({ path, type: block.type, mime: block.mime, byteLength: bytes.length, sha256, nativeRef: block.nativeRef, state: "ready" });
    }
    return { responsePath, media };
}
