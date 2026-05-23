import fs from "fs";
import path from "path";
import zlib from "zlib";
import { JSDOM } from "jsdom";
import TurndownService from "turndown";
import type { PageStructure } from "../inspector/types.js";
import { EbookError, type EbookChapter, type EbookDocument, type EbookLimits, type EbookMetadata, type EbookTocItem } from "./types.js";

interface ZipEntry {
    name: string;
    compressedSize: number;
    uncompressedSize: number;
    compressionMethod: number;
    localHeaderOffset: number;
    flags: number;
}

interface ZipArchive {
    buffer: Buffer;
    entries: Map<string, ZipEntry>;
}

interface ManifestItem {
    id: string;
    href: string;
    fullPath: string;
    mediaType: string;
    properties?: string;
}

interface SpineItem {
    idref: string;
    item: ManifestItem;
}

const DEFAULT_LIMITS: EbookLimits = {
    maxFileSizeBytes: envInt("WEB_FETCHER_EBOOK_MAX_FILE_BYTES", 200 * 1024 * 1024),
    maxEntries: envInt("WEB_FETCHER_EBOOK_MAX_ENTRIES", 2000),
    maxTotalUncompressedBytes: envInt("WEB_FETCHER_EBOOK_MAX_UNCOMPRESSED_BYTES", 100 * 1024 * 1024),
    maxEntryUncompressedBytes: envInt("WEB_FETCHER_EBOOK_MAX_ENTRY_BYTES", 20 * 1024 * 1024),
    maxCompressionRatio: envInt("WEB_FETCHER_EBOOK_MAX_COMPRESSION_RATIO", 20),
    maxChapters: envInt("WEB_FETCHER_EBOOK_MAX_CHAPTERS", 500),
    maxOutputChars: envInt("WEB_FETCHER_EBOOK_MAX_OUTPUT_CHARS", 500_000),
};

const XHTML_MEDIA_TYPES = new Set([
    "application/xhtml+xml",
    "text/html",
    "application/xml",
]);

function envInt(name: string, fallback: number): number {
    const value = Number(process.env[name]);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function ebookError(code: string, stage: string, message: string, suggestion: string): EbookError {
    return new EbookError(code, stage, message, suggestion);
}

function readUtf8(buffer: Buffer): string {
    return buffer.toString("utf8").replace(/^\uFEFF/u, "");
}

function findEndOfCentralDirectory(buffer: Buffer): number {
    const min = Math.max(0, buffer.length - 22 - 65_535);
    for (let offset = buffer.length - 22; offset >= min; offset--) {
        if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
    }
    throw ebookError(
        "ERR_INVALID_EBOOK_FORMAT",
        "zip_eocd",
        "未找到 ZIP central directory，文件不是有效 EPUB。",
        "请确认文件未损坏，且不是把其它格式改名为 .epub。",
    );
}

function normalizeEntryName(name: string): string {
    const cleaned = name.replace(/\\/gu, "/").replace(/^\.\/+/u, "");
    if (!cleaned || cleaned.startsWith("/") || /^[a-zA-Z]:/u.test(cleaned)) {
        throw ebookError("ERR_ARCHIVE_INVALID_PATH", "zip_path", `EPUB 内部路径非法: ${name}`, "请使用可信来源的 EPUB 文件。");
    }
    const normalized = path.posix.normalize(cleaned);
    if (normalized === "." || normalized.startsWith("../") || normalized === ".." || normalized.includes("/../")) {
        throw ebookError("ERR_ARCHIVE_INVALID_PATH", "zip_path", `EPUB 内部路径包含路径穿越: ${name}`, "请使用可信来源的 EPUB 文件。");
    }
    return normalized;
}

function parseZip(filePath: string, limits: EbookLimits): ZipArchive {
    const stat = fs.statSync(filePath);
    if (stat.size > limits.maxFileSizeBytes) {
        throw ebookError(
            "ERR_ARCHIVE_TOO_LARGE",
            "file_size",
            `EPUB 文件过大: ${stat.size} bytes，限制 ${limits.maxFileSizeBytes} bytes。`,
            "请调高 WEB_FETCHER_EBOOK_MAX_FILE_BYTES，或先拆分/压缩输入文件。",
        );
    }

    const buffer = fs.readFileSync(filePath);
    if (buffer.length < 4 || buffer.readUInt32LE(0) !== 0x04034b50) {
        throw ebookError("ERR_INVALID_EBOOK_FORMAT", "zip_magic", "文件头不是 ZIP magic bytes。", "请确认这是未损坏的 EPUB 文件。");
    }

    const eocd = findEndOfCentralDirectory(buffer);
    const totalEntries = buffer.readUInt16LE(eocd + 10);
    const centralDirectorySize = buffer.readUInt32LE(eocd + 12);
    const centralDirectoryOffset = buffer.readUInt32LE(eocd + 16);
    if (totalEntries > limits.maxEntries) {
        throw ebookError("ERR_ARCHIVE_TOO_MANY_ENTRIES", "entry_count", `EPUB entry 数过多: ${totalEntries}`, "请检查文件是否为异常归档。");
    }
    if (
        centralDirectoryOffset === 0xffffffff
        || centralDirectorySize === 0xffffffff
        || centralDirectoryOffset + centralDirectorySize > buffer.length
    ) {
        throw ebookError("ERR_INVALID_EBOOK_FORMAT", "zip64", "暂不支持 ZIP64 或 central directory 越界。", "请使用普通 EPUB 文件。");
    }

    const entries = new Map<string, ZipEntry>();
    let offset = centralDirectoryOffset;
    let totalUncompressed = 0;
    for (let index = 0; index < totalEntries; index++) {
        if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) {
            throw ebookError("ERR_INVALID_EBOOK_FORMAT", "central_directory", "ZIP central directory 结构损坏。", "请确认 EPUB 文件未损坏。");
        }
        const flags = buffer.readUInt16LE(offset + 8);
        const compressionMethod = buffer.readUInt16LE(offset + 10);
        const compressedSize = buffer.readUInt32LE(offset + 20);
        const uncompressedSize = buffer.readUInt32LE(offset + 24);
        const fileNameLength = buffer.readUInt16LE(offset + 28);
        const extraLength = buffer.readUInt16LE(offset + 30);
        const commentLength = buffer.readUInt16LE(offset + 32);
        const localHeaderOffset = buffer.readUInt32LE(offset + 42);
        if ([compressedSize, uncompressedSize, localHeaderOffset].some(value => value === 0xffffffff)) {
            throw ebookError("ERR_INVALID_EBOOK_FORMAT", "zip64_entry", "暂不支持 ZIP64 EPUB entry。", "请使用普通 EPUB 文件。");
        }
        const nameBuffer = buffer.subarray(offset + 46, offset + 46 + fileNameLength);
        const rawName = nameBuffer.toString((flags & 0x0800) ? "utf8" : "utf8");
        const name = normalizeEntryName(rawName);
        if (uncompressedSize > limits.maxEntryUncompressedBytes) {
            throw ebookError("ERR_ARCHIVE_ENTRY_TOO_LARGE", "entry_size", `EPUB entry 过大: ${name}`, "请检查文件是否异常，或调高 WEB_FETCHER_EBOOK_MAX_ENTRY_BYTES。");
        }
        if (compressedSize > 0 && uncompressedSize / compressedSize > limits.maxCompressionRatio) {
            throw ebookError("ERR_ARCHIVE_COMPRESSION_RATIO", "compression_ratio", `EPUB entry 压缩比异常: ${name}`, "请检查文件是否为压缩炸弹。");
        }
        totalUncompressed += uncompressedSize;
        if (totalUncompressed > limits.maxTotalUncompressedBytes) {
            throw ebookError("ERR_ARCHIVE_TOO_LARGE", "total_uncompressed", "EPUB 解压后总大小超过限制。", "请检查文件是否异常，或调高 WEB_FETCHER_EBOOK_MAX_UNCOMPRESSED_BYTES。");
        }
        entries.set(name, { name, compressedSize, uncompressedSize, compressionMethod, localHeaderOffset, flags });
        offset += 46 + fileNameLength + extraLength + commentLength;
    }

    return { buffer, entries };
}

function readEntry(archive: ZipArchive, entryName: string): Buffer {
    const entry = archive.entries.get(normalizeEntryName(entryName));
    if (!entry) {
        throw ebookError("ERR_INVALID_EBOOK_FORMAT", "zip_entry", `EPUB 缺少必要文件: ${entryName}`, "请确认 EPUB 文件结构完整。");
    }
    const buffer = archive.buffer;
    const offset = entry.localHeaderOffset;
    if (offset + 30 > buffer.length || buffer.readUInt32LE(offset) !== 0x04034b50) {
        throw ebookError("ERR_INVALID_EBOOK_FORMAT", "local_header", `ZIP local header 损坏: ${entryName}`, "请确认 EPUB 文件未损坏。");
    }
    const fileNameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const dataStart = offset + 30 + fileNameLength + extraLength;
    const dataEnd = dataStart + entry.compressedSize;
    if (dataEnd > buffer.length) {
        throw ebookError("ERR_INVALID_EBOOK_FORMAT", "entry_bounds", `ZIP entry 越界: ${entryName}`, "请确认 EPUB 文件未损坏。");
    }
    const compressed = buffer.subarray(dataStart, dataEnd);
    if (entry.compressionMethod === 0) return Buffer.from(compressed);
    if (entry.compressionMethod === 8) return zlib.inflateRawSync(compressed);
    throw ebookError("ERR_INVALID_EBOOK_FORMAT", "compression_method", `不支持的 ZIP 压缩方法: ${entry.compressionMethod}`, "请使用标准 deflate/store EPUB。");
}

function readOptionalEntry(archive: ZipArchive, entryName: string): Buffer | null {
    const normalized = normalizeEntryName(entryName);
    if (!archive.entries.has(normalized)) return null;
    return readEntry(archive, normalized);
}

function assertSafeXml(xml: string, stage: string): void {
    if (/<!DOCTYPE|<!ENTITY/iu.test(xml)) {
        throw ebookError("ERR_XML_UNSAFE_DOCTYPE", stage, "EPUB XML 包含 DOCTYPE 或 ENTITY，已拒绝解析。", "请使用不含外部实体定义的安全 EPUB。");
    }
}

function sanitizeSafeXhtml(xhtml: string): string {
    if (/<!ENTITY/iu.test(xhtml)) {
        throw ebookError("ERR_XML_UNSAFE_DOCTYPE", "xhtml", "EPUB XHTML 包含 ENTITY，已拒绝解析。", "请使用不含实体定义的安全 EPUB。");
    }
    const doctypeMatch = xhtml.match(/<!DOCTYPE\s+([^>]+)>/iu);
    if (!doctypeMatch) return xhtml;
    const declaration = doctypeMatch[1].trim();
    if (declaration.includes("[") || declaration.includes("]")) {
        throw ebookError("ERR_XML_UNSAFE_DOCTYPE", "xhtml", "EPUB XHTML DOCTYPE 包含内部子集，已拒绝解析。", "请使用不含外部实体或内部实体定义的安全 EPUB。");
    }
    if (!/^(html|xhtml|xhtml:html)\b/iu.test(declaration)) {
        throw ebookError("ERR_XML_UNSAFE_DOCTYPE", "xhtml", `EPUB XHTML DOCTYPE 不在允许范围: ${declaration.slice(0, 120)}`, "请使用标准 html/xhtml DOCTYPE 的 EPUB。");
    }
    if (/\b(?:file|data|javascript):/iu.test(declaration)) {
        throw ebookError("ERR_XML_UNSAFE_DOCTYPE", "xhtml", "EPUB XHTML DOCTYPE 引用了不安全 URI scheme，已拒绝解析。", "请使用不含 file/data/javascript 引用的安全 EPUB。");
    }
    return xhtml.replace(doctypeMatch[0], "");
}

function parseXml(xml: string, stage: string): Document {
    assertSafeXml(xml, stage);
    const dom = new JSDOM(xml, { contentType: "text/xml" });
    const parserError = dom.window.document.querySelector("parsererror");
    if (parserError) {
        throw ebookError("ERR_INVALID_EBOOK_FORMAT", stage, `XML 解析失败: ${parserError.textContent?.slice(0, 160)}`, "请确认 EPUB 元数据 XML 未损坏。");
    }
    return dom.window.document;
}

function attr(element: Element, name: string): string {
    return element.getAttribute(name) || element.getAttribute(`opf:${name}`) || "";
}

function childTextByLocalName(element: Element | Document, localName: string): string {
    const all = Array.from(element.getElementsByTagName("*"));
    const found = all.find(node => node.localName.toLowerCase() === localName.toLowerCase());
    return found?.textContent?.trim() || "";
}

function childrenByLocalName(element: Element | Document, localName: string): Element[] {
    return Array.from(element.getElementsByTagName("*")).filter(node => node.localName.toLowerCase() === localName.toLowerCase());
}

function resolveArchivePath(baseDir: string, href: string): string {
    const decoded = decodeURIComponent(href.split("#")[0] || href);
    const joined = baseDir ? `${baseDir}/${decoded}` : decoded;
    return normalizeEntryName(joined);
}

function metadataFromOpf(doc: Document): EbookMetadata {
    const metadataElements = childrenByLocalName(doc, "metadata");
    const metadataRoot = metadataElements[0] ?? doc.documentElement;
    const values = (name: string) => childrenByLocalName(metadataRoot, name).map(element => element.textContent?.trim() || "").filter(Boolean);
    return {
        title: values("title")[0],
        creators: values("creator"),
        language: values("language")[0],
        identifiers: values("identifier"),
        publisher: values("publisher")[0],
        date: values("date")[0],
    };
}

function manifestFromOpf(doc: Document, opfDir: string): Map<string, ManifestItem> {
    const manifest = new Map<string, ManifestItem>();
    for (const item of childrenByLocalName(doc, "item")) {
        const id = item.getAttribute("id") || "";
        const href = item.getAttribute("href") || "";
        if (!id || !href) continue;
        manifest.set(id, {
            id,
            href,
            fullPath: resolveArchivePath(opfDir, href),
            mediaType: item.getAttribute("media-type") || "",
            properties: item.getAttribute("properties") || undefined,
        });
    }
    return manifest;
}

function spineFromOpf(doc: Document, manifest: Map<string, ManifestItem>, limits: EbookLimits): SpineItem[] {
    const itemrefs = childrenByLocalName(doc, "itemref");
    const spine: SpineItem[] = [];
    for (const itemref of itemrefs) {
        const idref = itemref.getAttribute("idref") || "";
        const item = manifest.get(idref);
        if (item && XHTML_MEDIA_TYPES.has(item.mediaType)) {
            spine.push({ idref, item });
        }
        if (spine.length >= limits.maxChapters) break;
    }
    if (spine.length === 0) {
        throw ebookError("ERR_EBOOK_SPINE_MISSING", "opf_spine", "EPUB OPF 中没有有效 spine 章节。", "请确认 EPUB 文件结构完整。");
    }
    return spine;
}

function countAssets(manifest: Map<string, ManifestItem>): EbookDocument["assets"] {
    const assets = { images: 0, stylesheets: 0, fonts: 0, other: 0 };
    for (const item of manifest.values()) {
        if (item.mediaType.startsWith("image/")) assets.images += 1;
        else if (item.mediaType === "text/css") assets.stylesheets += 1;
        else if (item.mediaType.includes("font")) assets.fonts += 1;
        else if (!XHTML_MEDIA_TYPES.has(item.mediaType)) assets.other += 1;
    }
    return assets;
}

function tocFromNavXhtml(xhtml: string): EbookTocItem[] {
    const safeXhtml = sanitizeSafeXhtml(xhtml);
    const dom = new JSDOM(safeXhtml, { contentType: "text/html" });
    const doc = dom.window.document;
    const nav = Array.from(doc.querySelectorAll("nav")).find(element =>
        /\btoc\b/iu.test(element.getAttribute("epub:type") || "")
        || /\btoc\b/iu.test(element.getAttribute("role") || "")
    ) ?? doc.querySelector("nav") ?? doc.body;
    const items: EbookTocItem[] = [];
    const links = Array.from(nav.querySelectorAll("a[href]"));
    for (const link of links) {
        const title = link.textContent?.replace(/\s+/gu, " ").trim() || "";
        if (!title) continue;
        let level = 1;
        let parent = link.parentElement;
        while (parent && parent !== nav) {
            if (parent.tagName.toLowerCase() === "ol" || parent.tagName.toLowerCase() === "ul") level += 1;
            parent = parent.parentElement;
        }
        items.push({ title, href: link.getAttribute("href") || undefined, level: Math.max(1, level - 1) });
    }
    return items.slice(0, 500);
}

function tocFromNcx(xml: string): EbookTocItem[] {
    const doc = parseXml(xml, "ncx");
    const items: EbookTocItem[] = [];
    for (const point of childrenByLocalName(doc, "navPoint")) {
        const title = childTextByLocalName(point, "text");
        const content = childrenByLocalName(point, "content")[0];
        let level = 1;
        let parent = point.parentElement;
        while (parent) {
            if (parent.localName.toLowerCase() === "navpoint") level += 1;
            parent = parent.parentElement;
        }
        if (title) items.push({ title, href: content?.getAttribute("src") || undefined, level });
    }
    return items.slice(0, 500);
}

function chapterTitle(markdown: string, fallback: string): string {
    const heading = markdown.match(/^#{1,6}\s+(.+)$/mu)?.[1]?.trim();
    if (heading) return heading.slice(0, 120);
    const firstLine = markdown.split(/\r?\n/u).map(line => line.trim()).find(Boolean);
    return (firstLine || fallback).slice(0, 120);
}

function xhtmlToMarkdown(xhtml: string): string {
    const safeXhtml = sanitizeSafeXhtml(xhtml);
    let dom: JSDOM;
    try {
        dom = new JSDOM(safeXhtml, { contentType: "application/xhtml+xml" });
    } catch {
        dom = new JSDOM(safeXhtml, { contentType: "text/html" });
    }
    const doc = dom.window.document;
    doc.querySelectorAll("script, style").forEach(element => element.remove());
    const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
    td.remove(["script", "style", "noscript"]);
    return td.turndown(doc.body?.innerHTML || doc.documentElement.innerHTML || "").replace(/\n{3,}/gu, "\n\n").trim();
}

function findContainerRootfile(container: string): string {
    const doc = parseXml(container, "container");
    const rootfile = childrenByLocalName(doc, "rootfile").find(element =>
        (element.getAttribute("media-type") || "").includes("oebps-package+xml")
    ) ?? childrenByLocalName(doc, "rootfile")[0];
    const fullPath = rootfile?.getAttribute("full-path");
    if (!fullPath) {
        throw ebookError("ERR_INVALID_EBOOK_FORMAT", "container", "container.xml 中缺少 rootfile full-path。", "请确认 EPUB 文件结构完整。");
    }
    return normalizeEntryName(fullPath);
}

function extractToc(archive: ZipArchive, manifest: Map<string, ManifestItem>): EbookTocItem[] {
    const navItem = Array.from(manifest.values()).find(item =>
        /\bnav\b/iu.test(item.properties || "") && XHTML_MEDIA_TYPES.has(item.mediaType)
    );
    if (navItem) {
        const nav = readOptionalEntry(archive, navItem.fullPath);
        if (nav) return tocFromNavXhtml(readUtf8(nav));
    }
    const ncxItem = Array.from(manifest.values()).find(item => item.mediaType === "application/x-dtbncx+xml");
    if (ncxItem) {
        const ncx = readOptionalEntry(archive, ncxItem.fullPath);
        if (ncx) return tocFromNcx(readUtf8(ncx));
    }
    return [];
}

export function extractEpubDocument(filePath: string, limits: EbookLimits = DEFAULT_LIMITS): EbookDocument {
    const archive = parseZip(filePath, limits);
    const mimetype = readOptionalEntry(archive, "mimetype");
    if (!mimetype || readUtf8(mimetype).trim() !== "application/epub+zip") {
        throw ebookError("ERR_INVALID_EBOOK_FORMAT", "mimetype", "EPUB 缺少根目录 mimetype=application/epub+zip。", "请确认文件是真正的 EPUB，而不是其它 ZIP 或改名文件。");
    }
    if (archive.entries.has("META-INF/encryption.xml")) {
        throw ebookError("ERR_DRM_PROTECTED", "encryption", "EPUB 包含 META-INF/encryption.xml，可能受 DRM 或加密保护。", "当前工具不绕过 DRM；请使用未加密的 EPUB 文件。");
    }

    const container = readUtf8(readEntry(archive, "META-INF/container.xml"));
    const opfPath = findContainerRootfile(container);
    const opfDir = path.posix.dirname(opfPath) === "." ? "" : path.posix.dirname(opfPath);
    const opf = readUtf8(readEntry(archive, opfPath));
    const opfDoc = parseXml(opf, "opf");
    const metadata = metadataFromOpf(opfDoc);
    const manifest = manifestFromOpf(opfDoc, opfDir);
    const spine = spineFromOpf(opfDoc, manifest, limits);
    const toc = extractToc(archive, manifest);
    const warnings: string[] = [];
    let totalOutputChars = 0;
    let truncated = false;
    const chapters: EbookChapter[] = [];

    for (const [index, spineItem] of spine.entries()) {
        const raw = readUtf8(readEntry(archive, spineItem.item.fullPath));
        let markdown = xhtmlToMarkdown(raw);
        totalOutputChars += markdown.length;
        if (totalOutputChars > limits.maxOutputChars) {
            const allowed = Math.max(0, markdown.length - (totalOutputChars - limits.maxOutputChars));
            markdown = `${markdown.slice(0, allowed).trim()}\n\n[内容已因 WEB_FETCHER_EBOOK_MAX_OUTPUT_CHARS 截断]`.trim();
            truncated = true;
        }
        const fallbackTitle = `Chapter ${index + 1}`;
        chapters.push({
            index: index + 1,
            id: spineItem.idref,
            title: chapterTitle(markdown, fallbackTitle),
            href: spineItem.item.fullPath,
            mediaType: spineItem.item.mediaType,
            markdown,
            textLength: markdown.length,
        });
        if (truncated) break;
    }

    if (spine.length >= limits.maxChapters) {
        warnings.push(`章节数达到限制 ${limits.maxChapters}，后续章节未读取。`);
    }
    if (truncated) {
        warnings.push(`输出达到限制 ${limits.maxOutputChars} 字符，内容已截断。`);
    }

    return {
        route: "ebook",
        format: "epub",
        sourcePath: filePath,
        metadata,
        toc,
        chapters,
        assets: countAssets(manifest),
        warnings,
        limits,
        truncated,
    };
}

function metadataLines(document: EbookDocument): string[] {
    const lines = [
        `> Source: ${document.sourcePath}`,
        `> Format: EPUB`,
        document.metadata.creators.length ? `> Author: ${document.metadata.creators.join(", ")}` : "",
        document.metadata.language ? `> Language: ${document.metadata.language}` : "",
        document.metadata.publisher ? `> Publisher: ${document.metadata.publisher}` : "",
        document.metadata.date ? `> Date: ${document.metadata.date}` : "",
        `> Chapters: ${document.chapters.length}`,
    ].filter(Boolean);
    if (document.warnings.length) {
        lines.push(`> Warnings: ${document.warnings.join("; ")}`);
    }
    return lines;
}

export function formatEpubAsMarkdown(document: EbookDocument): string {
    const title = document.metadata.title || path.basename(document.sourcePath);
    const parts = [`# ${title}`, "", ...metadataLines(document), ""];
    if (document.toc.length) {
        parts.push("## Table of Contents", "");
        for (const item of document.toc) {
            const indent = "  ".repeat(Math.max(0, item.level - 1));
            parts.push(`${indent}- ${item.title}`);
        }
        parts.push("");
    }
    for (const chapter of document.chapters) {
        parts.push(`## ${chapter.title}`, "", chapter.markdown || "(空章节)", "");
    }
    return parts.join("\n").replace(/\n{4,}/gu, "\n\n\n").trim();
}

export function extractEpubStructure(filePath: string): PageStructure[] {
    const document = extractEpubDocument(filePath);
    const elements = [
        {
            type: "text" as const,
            name: "metadata",
            text: [
                document.metadata.title,
                document.metadata.creators.join(", "),
                document.metadata.language,
            ].filter(Boolean).join(" | "),
            bounds: { x0: 0, y0: 0, x1: 1000, y1: 80 },
            zOrder: 0,
            source: "ebook" as const,
            metadata: {
                format: document.format,
                title: document.metadata.title ?? null,
                creators: document.metadata.creators,
                language: document.metadata.language ?? null,
                identifiers: document.metadata.identifiers,
                publisher: document.metadata.publisher ?? null,
                date: document.metadata.date ?? null,
                toc: document.toc.map(item => ({ title: item.title, href: item.href ?? null, level: item.level })),
                assets: document.assets,
                warnings: document.warnings,
                truncated: document.truncated,
            },
        },
        ...document.chapters.map(chapter => ({
            type: "container" as const,
            name: chapter.title,
            text: chapter.markdown.slice(0, 500),
            bounds: { x0: 0, y0: 100 + chapter.index * 40, x1: 1000, y1: 130 + chapter.index * 40 },
            zOrder: chapter.index,
            source: "ebook" as const,
            page: chapter.index,
            metadata: {
                id: chapter.id,
                href: chapter.href,
                mediaType: chapter.mediaType ?? null,
                textLength: chapter.textLength,
            },
        })),
    ];
    return [{
        page: 1,
        dimensions: { width: 1000, height: Math.max(200, 140 + document.chapters.length * 40), unit: "logical" },
        elements,
        source: "ebook",
        metadata: {
            format: "epub",
            chapterCount: document.chapters.length,
            tocCount: document.toc.length,
            warnings: document.warnings,
            truncated: document.truncated,
        },
    }];
}
