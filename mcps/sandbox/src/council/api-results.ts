import fs from "node:fs";
import { createHash } from "node:crypto";
import type { NormalizedResponse } from "../agent-server/providers/types.js";
import { ProviderFault } from "../agent-server/providers/types.js";
import { councilArtifactPath, registerCouncilArtifact } from "./artifact-store.js";

export interface CouncilImageArtifact {
    path: string;
    mime: string;
    sha256: string;
    byteLength: number;
}

export function readyCouncilImages(metadata?: Record<string, unknown>): CouncilImageArtifact[] {
    if (!Array.isArray(metadata?.media)) return [];
    return metadata.media.flatMap((value: unknown): CouncilImageArtifact[] => {
        if (!value || typeof value !== "object") return [];
        const media = value as Record<string, unknown>;
        if (media.type !== "image" || media.state !== "ready") return [];
        if (typeof media.path !== "string" || typeof media.mime !== "string" || typeof media.sha256 !== "string"
            || !Number.isSafeInteger(media.byteLength) || Number(media.byteLength) < 1) {
            throw new ProviderFault("E_COUNCIL_MEDIA_INTEGRITY", "共享图片缺少原件、长度或哈希凭据", { acceptance: "not_sent" });
        }
        const stat = fs.statSync(media.path);
        if (!stat.isFile() || stat.size !== media.byteLength) {
            throw new ProviderFault("E_COUNCIL_MEDIA_INTEGRITY", "共享图片原件长度已经变化", { acceptance: "not_sent" });
        }
        const bytes = fs.readFileSync(media.path);
        if (createHash("sha256").update(bytes).digest("hex") !== media.sha256) {
            throw new ProviderFault("E_COUNCIL_MEDIA_INTEGRITY", "共享图片原件哈希已经变化", { acceptance: "not_sent" });
        }
        return [{ path: media.path, mime: media.mime, sha256: media.sha256, byteLength: bytes.length }];
    });
}

export function councilMediaDescription(metadata?: Record<string, unknown>): string {
    if (!Array.isArray(metadata?.media)) return "";
    const media = metadata.media.filter(value => value && typeof value === "object").map(value => {
        const item = value as Record<string, unknown>;
        return { type: item.type, mime: item.mime, path: item.path, uri: item.uri, sha256: item.sha256,
            byteLength: item.byteLength, state: item.state };
    });
    return media.length ? `原生媒体来源: ${JSON.stringify(media)}` : "";
}

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
