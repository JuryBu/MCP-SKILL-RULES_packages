import fs from "node:fs";
import { desktopFiles, devinPaths, digest, isFile, sourceIdentity } from "./devin-sqlite-store.js";
import type { ConversationSourceFingerprint } from "./conversation-source-cache.js";

export function devinSourceValidationRevision(maxDesktopFiles = 512, check?: () => void): string {
    const paths = devinPaths();
    const filenames = [...(isFile(paths.cli) ? [paths.cli] : []), ...desktopFiles(paths.desktop, maxDesktopFiles, check)].sort();
    const states = filenames.map(filename => {
        check?.();
        return [filename, ...[filename, `${filename}-wal`, `${filename}-journal`].map(source => {
            try {
                const stat = fs.statSync(source, { bigint: true });
                if (source !== filename && stat.size === 0n) return null;
                const descriptor = fs.openSync(source, "r");
                try {
                    const header = Buffer.alloc(source === filename ? 100 : 32);
                    const bytes = fs.readSync(descriptor, header, 0, header.length, 0);
                    return [sourceIdentity(source), String(stat.size), String(stat.mtimeNs), String(stat.ctimeNs), header.subarray(0, bytes).toString("hex")];
                } finally { fs.closeSync(descriptor); }
            } catch (error: any) {
                if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
                throw error;
            }
        })];
    });
    return `devin-sqlite/source-v2:${digest([paths, states])}`;
}

export function devinSourceValidationFingerprint(sourcePath: string, maxDesktopFiles?: number, check?: () => void): ConversationSourceFingerprint {
    return { path: sourcePath, revision: devinSourceValidationRevision(maxDesktopFiles, check) };
}

export function isDevinSourceValidationFingerprint(fingerprint: ConversationSourceFingerprint | null | undefined): boolean {
    return fingerprint?.revision?.startsWith("devin-sqlite/source-v2:") === true;
}
