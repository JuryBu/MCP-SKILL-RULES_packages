import fs from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";

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
