import fs from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";

export async function readMemoryQueryBodyPrefix(filePath: string, maxChars: number): Promise<string | null> {
    const headerBudget = 64 * 1024;
    const maxBytes = headerBudget + maxChars * 3 + 4;
    if (!Number.isSafeInteger(maxChars) || maxChars < 1 || !Number.isSafeInteger(maxBytes)) throw new RangeError("Memory body prefix length must be a positive safe integer");
    let handle: Awaited<ReturnType<typeof fs.open>>;
    try { handle = await fs.open(filePath, "r"); } catch (error) {
        if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code || "")) return null;
        throw error;
    }
    try {
        const decoder = new StringDecoder("utf8");
        const buffer = Buffer.allocUnsafe(4096);
        let text = "";
        let total = 0;
        let bodyOffset: number | null = null;
        while (total < maxBytes) {
            const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, maxBytes - total), null);
            total += bytesRead;
            text += bytesRead ? decoder.write(buffer.subarray(0, bytesRead)) : decoder.end();
            if (bodyOffset === null) {
                const header = text.match(bytesRead === 0
                    ? /^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u
                    : /^\uFEFF?---\r?\n[\s\S]*?\r?\n---\r?\n/u);
                if (header) {
                    if (Buffer.byteLength(header[0], "utf8") > headerBudget) return "";
                    bodyOffset = header[0].length;
                } else if (total >= headerBudget || bytesRead === 0) return "";
            }
            if (bodyOffset !== null && (text.length - bodyOffset >= maxChars || bytesRead === 0)) return text.slice(bodyOffset, bodyOffset + maxChars);
        }
        return bodyOffset === null ? "" : text.slice(bodyOffset, bodyOffset + maxChars);
    } finally { await handle.close(); }
}

export async function readMemoryQueryPrefix(filePath: string, maxChars: number): Promise<string | null> {
    const maxBytes = maxChars * 3 + 3;
    if (!Number.isSafeInteger(maxChars) || maxChars < 1 || !Number.isSafeInteger(maxBytes)) {
        throw new RangeError("Memory query prefix length must be a positive safe integer");
    }
    let handle: Awaited<ReturnType<typeof fs.open>>;
    try {
        handle = await fs.open(filePath, "r");
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") return null;
        throw error;
    }
    try {
        const decoder = new StringDecoder("utf8");
        const buffer = Buffer.allocUnsafe(Math.min(4096, maxBytes));
        let prefix = "";
        let bytesReadTotal = 0;
        while (prefix.length < maxChars && bytesReadTotal < maxBytes) {
            const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, maxBytes - bytesReadTotal), null);
            if (bytesRead === 0) {
                prefix += decoder.end();
                break;
            }
            bytesReadTotal += bytesRead;
            prefix += decoder.write(buffer.subarray(0, bytesRead));
        }
        return prefix.slice(0, maxChars);
    } finally {
        await handle.close();
    }
}
