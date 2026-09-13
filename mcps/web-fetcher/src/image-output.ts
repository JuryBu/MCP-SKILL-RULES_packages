import sharp from "sharp";
import type { ImageContent, TextContent } from "@modelcontextprotocol/sdk/types.js";

export const INLINE_IMAGE_LIMIT = 10;
export const INLINE_IMAGE_BASE64_LIMIT = 12 * 1024 * 1024;
const INLINE_IMAGE_DIMENSION = 7800;
const BUDGET_HINT = "请缩小截图范围或页码范围，或显式设置 saveMode=\"file\" 返回文件地址；不会静默省略图片。";

export function assertInlineImageBudget(content: Array<{ type: string; data?: string }>): void {
    const images = content.filter(item => item.type === "image");
    const encodedLength = images.reduce((total, item) => total + (item.data?.length ?? 0), 0);
    if (images.length > INLINE_IMAGE_LIMIT || encodedLength > INLINE_IMAGE_BASE64_LIMIT) {
        throw new Error(`ERR_INLINE_IMAGE_BUDGET: 单次响应最多 ${INLINE_IMAGE_LIMIT} 张图片、base64 总长最多 ${INLINE_IMAGE_BASE64_LIMIT} 字符，当前 ${images.length} 张、${encodedLength} 字符。${BUDGET_HINT}`);
    }
}

function imageMime(format: string | undefined, compression?: string): string {
    const mimeTypes: Record<string, string> = {
        jpeg: "image/jpeg",
        png: "image/png",
        webp: "image/webp",
        gif: "image/gif",
        tiff: "image/tiff",
        avif: "image/avif",
        heif: compression === "av1" ? "image/avif" : "image/heif",
        jp2: "image/jp2",
        jxl: "image/jxl",
    };
    const mime = format ? mimeTypes[format] : undefined;
    if (!mime) throw new Error(`ERR_INLINE_IMAGE_FORMAT: 无法直接返回图片格式 ${format ?? "unknown"}`);
    return mime;
}

export async function inlineImageContent(buffer: Buffer, label: string, autoSplit = true): Promise<Array<TextContent | ImageContent>> {
    const metadata = await sharp(buffer).metadata();
    const width = metadata.width;
    const height = metadata.height;
    if (!width || !height) throw new Error("ERR_INLINE_IMAGE_DIMENSIONS: 无法读取图片尺寸");
    const mimeType = imageMime(metadata.format, metadata.compression);
    if (!autoSplit || (width <= INLINE_IMAGE_DIMENSION && height <= INLINE_IMAGE_DIMENSION)) {
        if (Math.ceil(buffer.length / 3) * 4 > INLINE_IMAGE_BASE64_LIMIT) {
            throw new Error(`ERR_INLINE_IMAGE_BUDGET: 图片 base64 超过 ${INLINE_IMAGE_BASE64_LIMIT} 字符。${BUDGET_HINT}`);
        }
        const content: Array<TextContent | ImageContent> = [
            { type: "text", text: label },
            { type: "image", data: buffer.toString("base64"), mimeType },
        ];
        assertInlineImageBudget(content);
        return content;
    }

    const columns = Math.ceil(width / INLINE_IMAGE_DIMENSION);
    const rows = Math.ceil(height / INLINE_IMAGE_DIMENSION);
    const tileCount = columns * rows;
    if (tileCount > INLINE_IMAGE_LIMIT) {
        throw new Error(`ERR_INLINE_IMAGE_BUDGET: 图片需要 ${tileCount} 个分片，超过 ${INLINE_IMAGE_LIMIT} 张上限。${BUDGET_HINT}`);
    }
    const content: Array<TextContent | ImageContent> = [];
    let encodedLength = 0;
    for (let row = 0; row < rows; row++) {
        for (let column = 0; column < columns; column++) {
            const left = column * INLINE_IMAGE_DIMENSION;
            const top = row * INLINE_IMAGE_DIMENSION;
            const tile = await sharp(buffer).extract({
                left,
                top,
                width: Math.min(INLINE_IMAGE_DIMENSION, width - left),
                height: Math.min(INLINE_IMAGE_DIMENSION, height - top),
            }).toBuffer();
            encodedLength += Math.ceil(tile.length / 3) * 4;
            if (encodedLength > INLINE_IMAGE_BASE64_LIMIT) {
                throw new Error(`ERR_INLINE_IMAGE_BUDGET: 分片 base64 总长超过 ${INLINE_IMAGE_BASE64_LIMIT} 字符。${BUDGET_HINT}`);
            }
            const tileMetadata = await sharp(tile).metadata();
            content.push(
                { type: "text", text: `${label} — 分片 ${row * columns + column + 1}/${tileCount}（行 ${row + 1}/${rows}，列 ${column + 1}/${columns}，x=${left}，y=${top}）` },
                { type: "image", data: tile.toString("base64"), mimeType: imageMime(tileMetadata.format, tileMetadata.compression) },
            );
            assertInlineImageBudget(content);
        }
    }
    return content;
}
