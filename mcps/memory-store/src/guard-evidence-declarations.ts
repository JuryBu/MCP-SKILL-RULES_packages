import fs from "fs";
import path from "path";
import crypto from "crypto";
import type { GuardEvidenceAssetInput } from "./guard-evidence-index.js";

const MAX_DECLARATION_BYTES = 512 * 1024;
const MAX_DECLARED_ASSETS = 128;

function readDeclarationFile(filePath: string): { text: string; sha256: string } {
    const descriptor = fs.openSync(filePath, "r");
    try {
        const buffer = Buffer.alloc(MAX_DECLARATION_BYTES + 1);
        let bytes = 0;
        while (bytes < buffer.length) {
            const count = fs.readSync(descriptor, buffer, bytes, buffer.length - bytes, bytes);
            if (!count) break;
            bytes += count;
        }
        if (bytes > MAX_DECLARATION_BYTES) throw new Error("evidence declaration exceeds 512KiB");
        const source = buffer.subarray(0, bytes);
        return { text: source.toString("utf8").replace(/^\uFEFF/u, ""), sha256: crypto.createHash("sha256").update(source).digest("hex") };
    } finally {
        fs.closeSync(descriptor);
    }
}

function normalizeDeclaredAsset(value: unknown, basePath: string): GuardEvidenceAssetInput {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("evidence asset must be an object");
    const asset = value as Record<string, unknown>;
    if (typeof asset.path !== "string" || !asset.path.trim() || asset.path.includes("\0")) throw new Error("evidence asset requires a valid path");
    for (const field of ["label", "type", "role", "range"] as const) {
        if (asset[field] !== undefined && typeof asset[field] !== "string") throw new Error(`evidence asset ${field} must be a string`);
    }
    if (asset.type === "manifest") throw new Error("nested evidence manifests are not supported");
    if (asset.maxChars !== undefined && (!Number.isSafeInteger(asset.maxChars) || Number(asset.maxChars) < 1)) throw new Error("evidence asset maxChars must be a positive integer");
    return {
        path: path.resolve(basePath, asset.path),
        label: asset.label as string | undefined,
        type: asset.type as string | undefined,
        role: asset.role as string | undefined,
        range: asset.range as string | undefined,
        maxChars: asset.maxChars as number | undefined,
    };
}

export function resolveGuardEvidenceDeclarations(input: {
    taskFiles: string[];
    stageId: string;
    childScopeId: string;
    assets?: GuardEvidenceAssetInput[];
}): { assets: GuardEvidenceAssetInput[]; gaps: string[]; declarations: Array<{ path: string; sha256: string }> } {
    const assets: GuardEvidenceAssetInput[] = [];
    const gaps: string[] = [];
    const declarations: Array<{ path: string; sha256: string }> = [];
    const append = (values: unknown, directory: string) => {
        if (!Array.isArray(values) || !values.length) throw new Error("evidence declaration requires a nonempty assets array");
        if (assets.length + values.length > MAX_DECLARED_ASSETS) throw new Error("evidence declarations exceed 128 assets");
        assets.push(...values.map(value => normalizeDeclaredAsset(value, directory)));
    };
    const manifest = (filePath: string) => {
        const { text, sha256 } = readDeclarationFile(filePath);
        const value = JSON.parse(text);
        if (value.version !== 1) throw new Error("evidence manifest version must be 1");
        if (value.stageId !== undefined && value.stageId !== input.stageId) throw new Error("evidence manifest stageId does not match the current stage");
        if (value.childScopeId !== undefined && value.childScopeId !== input.childScopeId) throw new Error("evidence manifest childScopeId does not match the current scope");
        append(value.assets, path.dirname(filePath));
        declarations.push({ path: filePath, sha256 });
    };
    for (const taskFile of input.taskFiles) {
        try {
            const { text } = readDeclarationFile(taskFile);
            for (const match of text.matchAll(/```guard-evidence\s*\r?\n([\s\S]*?)\r?\n```/gu)) {
                const value = JSON.parse(match[1]);
                if (typeof value.stageId !== "string" || !value.stageId.trim()) throw new Error("guard-evidence requires an explicit stageId");
                if (value.childScopeId !== undefined && typeof value.childScopeId !== "string") throw new Error("guard-evidence childScopeId must be a string");
                if (value.stageId !== input.stageId || (value.childScopeId || "main") !== input.childScopeId) continue;
                if (value.version !== 1) throw new Error("guard-evidence version must be 1");
                if (value.manifest !== undefined) {
                    if (typeof value.manifest !== "string" || !value.manifest.trim()) throw new Error("guard-evidence manifest requires a path");
                    manifest(path.resolve(path.dirname(taskFile), value.manifest));
                } else append(value.assets, path.dirname(taskFile));
            }
        } catch (error) {
            gaps.push(`evidence declaration ${taskFile}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    for (const asset of input.assets || []) {
        try {
            if (asset.type === "manifest") manifest(path.resolve(asset.path));
            else append([asset], process.cwd());
        } catch (error) {
            gaps.push(`evidence declaration ${asset.path}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    const unique = new Map(assets.map(asset => [JSON.stringify(asset), asset]));
    return { assets: [...unique.values()], gaps, declarations };
}
