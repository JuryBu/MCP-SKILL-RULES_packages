import dns from "dns/promises";
import { execFile, spawn } from "child_process";
import { mkdtemp, rm } from "fs/promises";
import os from "os";
import path from "path";
import { promisify } from "util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CouncilToolCall, CouncilToolConfig, CouncilToolResult } from "./types.js";

const DEFAULT_FETCH_TIMEOUT_MS = Number(process.env.SANDBOX_COUNCIL_FETCH_TIMEOUT_MS || 15000);
const DEFAULT_SEARCH_TIMEOUT_MS = Number(process.env.SANDBOX_COUNCIL_SEARCH_TIMEOUT_MS || 6000);
const DEFAULT_EXA_TIMEOUT_MS = Number(process.env.SANDBOX_COUNCIL_EXA_TIMEOUT_MS || 10000);
const DEFAULT_WEB_FETCHER_TIMEOUT_MS = Number(process.env.SANDBOX_COUNCIL_WEB_FETCHER_TIMEOUT_MS || 15000);
const DEFAULT_EXA_MCP_URL = process.env.SANDBOX_COUNCIL_EXA_MCP_URL
    || process.env.EXA_MCP_REMOTE_URL
    || process.env.CODEX_TOOLKIT_EXA_MCP_REMOTE_URL
    || "http://127.0.0.1:14588/exa/mcp";
const DEFAULT_WEB_FETCHER_MCP_URL = process.env.SANDBOX_COUNCIL_WEB_FETCHER_MCP_URL
    || "http://127.0.0.1:14588/web-fetcher/mcp";
const SIMPLE_SCRIPT_MAX_CODE_CHARS = 4000;
const SIMPLE_SCRIPT_MAX_OUTPUT_CHARS = 8000;
const SIMPLE_SCRIPT_MAX_BUFFER_BYTES = 128 * 1024;
const execFileAsync = promisify(execFile);

function clip(text: string, maxChars: number): string {
    return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n... (truncated ${text.length - maxChars} chars)`;
}

function htmlDecode(text: string): string {
    return text
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, "\"")
        .replace(/&#39;/g, "'")
        .replace(/&#x27;/g, "'");
}

function stripHtml(html: string): string {
    return html
        .replace(/<script[\s\S]*?<\/script>/giu, " ")
        .replace(/<style[\s\S]*?<\/style>/giu, " ")
        .replace(/<noscript[\s\S]*?<\/noscript>/giu, " ")
        .replace(/<[^>]+>/gu, " ")
        .replace(/\s+/gu, " ")
        .trim();
}

function normalizeSearchQuery(query: string): string {
    return query
        .replace(/^[\s"'“”‘’「」『』]+|[\s"'“”‘’「」『』]+$/gu, "")
        .replace(/[“”「」『』]/gu, "\"")
        .replace(/[，。！？；：、/\\|()[\]{}<>《》【】]+/gu, " ")
        .replace(/\s+/gu, " ")
        .trim();
}

function keywordSearchQuery(query: string): string {
    return normalizeSearchQuery(query)
        .replace(/以下|哪个|哪些|什么|是否|指的是|不属于|属于|导致了?|存在的?|产生|记录|之后的?|与|和|或|及|以及|的是|的是|的|了|中|为|是/gu, " ")
        .replace(/\s+/gu, " ")
        .trim();
}

function buildSearchQueries(query: string): string[] {
    const normalized = normalizeSearchQuery(query);
    const dequoted = query.replace(/["“”「」『』]/gu, " ").replace(/\s+/gu, " ").trim();
    const keyword = keywordSearchQuery(query);
    const domainHint = `${keyword || normalized} 推荐系统`;
    const semanticHints: string[] = [];
    if (normalized.includes("搜索引擎") && normalized.includes("推荐系统")) {
        semanticHints.push("推荐系统 信息过载 搜索引擎 个性化推荐");
    }
    if (normalized.includes("依赖性") && normalized.includes("推荐系统")) {
        semanticHints.push("推荐系统 应用场景 电子商务 音乐 新闻 图库");
    }
    if (normalized.includes("隐式反馈")) {
        semanticHints.push("推荐系统 隐式反馈 用户行为 购买 收藏 浏览 观看");
    }
    const queries = [...semanticHints, normalized, keyword, domainHint, dequoted, query.trim()]
        .map((item) => item.replace(/\s+/gu, " ").trim())
        .filter((item) => item.length > 0);
    return [...new Set(queries)].slice(0, 4);
}

const SEARCH_DOMAIN_TERMS = [
    "推荐系统", "搜索引擎", "隐式反馈", "显式反馈", "协同过滤", "基于内容", "基于网络",
    "用户", "物品", "反馈", "购买", "收藏", "转发", "收看", "收听", "场景", "依赖性", "在线图库",
    "马太效应", "信息过载", "知识图谱",
];

function searchTerms(query: string): string[] {
    const normalized = normalizeSearchQuery(query);
    const terms = new Set<string>();
    for (const term of SEARCH_DOMAIN_TERMS) {
        if (normalized.includes(term)) terms.add(term);
    }
    for (const part of normalized.split(/\s+/u)) {
        if (/^[\p{Script=Han}A-Za-z0-9_-]{2,}$/u.test(part) && part.length <= 16) {
            terms.add(part);
        }
    }
    return [...terms];
}

function scoreSearchRow(queryTerms: string[], text: string): number {
    if (queryTerms.length === 0) return 1;
    const haystack = text.toLowerCase();
    return queryTerms.reduce((score, term) => score + (haystack.includes(term.toLowerCase()) ? 1 : 0), 0);
}

function rankSearchRows(query: string, rows: string[]): { good: string[]; lowConfidence: string[] } {
    const terms = searchTerms(query);
    const criticalTerms = terms.filter((term) => ["推荐系统", "搜索引擎", "隐式反馈", "显式反馈", "信息过载", "应用场景"].includes(term));
    const scored = rows.map((row) => ({ row, score: scoreSearchRow(terms, row) }))
        .sort((a, b) => b.score - a.score);
    const criticalMatched = (row: string) => criticalTerms.filter((term) => row.toLowerCase().includes(term.toLowerCase())).length;
    const requiredCritical = criticalTerms.length >= 2 ? 2 : criticalTerms.length;
    return {
        good: scored.filter((item) => item.score >= 2 && criticalMatched(item.row) >= requiredCritical).map((item) => item.row),
        lowConfidence: scored.filter((item) => item.score > 0 && criticalMatched(item.row) >= 1).map((item) => item.row),
    };
}

function isDuckDuckGoBlocked(err: unknown): boolean {
    const message = err instanceof Error ? err.message : String(err);
    return /HTTP 403|error-lite|duckduckgo\.com/iu.test(message) && /403|error-lite/iu.test(message);
}

function getStringArg(args: Record<string, unknown>, key: string): string | undefined {
    const value = args[key];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function getNumberArg(args: Record<string, unknown>, key: string, fallback: number): number {
    const value = args[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    return fallback;
}

function redactExaSecrets(text: string): string {
    return text.replace(/([?&]exaApiKey=)[^&\s]+/giu, "$1[redacted]");
}

function compactErrorMessage(err: unknown, maxChars = 400): string {
    const text = redactExaSecrets(err instanceof Error ? err.message : String(err));
    return text.length <= maxChars ? text : `${text.slice(0, maxChars)}...`;
}

function buildExaMcpUrl(): URL {
    const url = new URL(DEFAULT_EXA_MCP_URL);
    if (url.hostname === "mcp.exa.ai") {
        if (!url.searchParams.has("tools")) {
            url.searchParams.set("tools", "web_search_exa");
        }
        const exaApiKey = process.env.EXA_API_KEY;
        if (exaApiKey && !url.searchParams.has("exaApiKey")) {
            url.searchParams.set("exaApiKey", exaApiKey);
        }
    }
    return url;
}

function describeExaMcpEndpoint(url: URL): string {
    const safe = new URL(url.toString());
    if (safe.searchParams.has("exaApiKey")) {
        safe.searchParams.set("exaApiKey", "[redacted]");
    }
    return safe.toString();
}

function safeDescribeExaEndpoint(): string {
    try {
        return describeExaMcpEndpoint(buildExaMcpUrl());
    } catch {
        return redactExaSecrets(DEFAULT_EXA_MCP_URL);
    }
}

function buildTimedFetch(timeoutMs: number): typeof fetch {
    return async (input, init: RequestInit = {}) => {
        const controller = new AbortController();
        const upstreamSignal = init.signal;
        const relayAbort = () => controller.abort(upstreamSignal?.reason);
        if (upstreamSignal?.aborted) {
            controller.abort(upstreamSignal.reason);
        } else if (upstreamSignal) {
            upstreamSignal.addEventListener("abort", relayAbort, { once: true });
        }
        const timer = setTimeout(() => controller.abort(new Error(`Exa MCP timeout ${timeoutMs}ms`)), timeoutMs);
        try {
            return await fetch(input, { ...init, signal: controller.signal });
        } finally {
            clearTimeout(timer);
            upstreamSignal?.removeEventListener("abort", relayAbort);
        }
    };
}

async function withExaClient<T>(callback: (client: Client) => Promise<T>, timeoutMs = DEFAULT_EXA_TIMEOUT_MS): Promise<T> {
    const transport = new StreamableHTTPClientTransport(buildExaMcpUrl(), {
        fetch: buildTimedFetch(timeoutMs),
    });
    const client = new Client({
        name: "sandbox-council-websearch",
        version: "1.0.0",
    });
    try {
        await client.connect(transport);
        return await callback(client);
    } finally {
        await (client as unknown as { close?: () => Promise<void> }).close?.().catch?.(() => { });
        await transport.close().catch(() => { });
    }
}

async function withWebFetcherClient<T>(callback: (client: Client) => Promise<T>, timeoutMs = DEFAULT_WEB_FETCHER_TIMEOUT_MS): Promise<T> {
    const transport = new StreamableHTTPClientTransport(new URL(DEFAULT_WEB_FETCHER_MCP_URL), {
        fetch: buildTimedFetch(timeoutMs),
    });
    const client = new Client({
        name: "sandbox-council-webfetchtext",
        version: "1.0.0",
    });
    try {
        await client.connect(transport);
        return await callback(client);
    } finally {
        await (client as unknown as { close?: () => Promise<void> }).close?.().catch?.(() => { });
        await transport.close().catch(() => { });
    }
}

async function withPromiseTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<T>((_, reject) => {
                timer = setTimeout(() => reject(new Error(`${label} timeout ${timeoutMs}ms`)), timeoutMs);
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

async function callExaViaChild(toolName: string, args: Record<string, unknown>, timeoutMs = DEFAULT_EXA_TIMEOUT_MS): Promise<string> {
    const endpoint = buildExaMcpUrl().toString();
    const bridgeScript = `
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const payload = JSON.parse(process.argv[1]);
function extractToolTextContent(result) {
  const blocks = Array.isArray(result?.content) ? result.content : [];
  return blocks.map((block) => {
    if (typeof block === "string") return block;
    if (!block || typeof block !== "object") return "";
    if (block.type === "text" && typeof block.text === "string") return block.text.trim();
    return "";
  }).filter(Boolean).join("\\n\\n").trim();
}

const transport = new StreamableHTTPClientTransport(new URL(payload.endpoint));
const client = new Client({ name: "sandbox-council-exa-child", version: "1.0.0" });
let exitCode = 0;
try {
  await client.connect(transport);
  const result = await client.callTool({ name: payload.toolName, arguments: payload.args });
  const content = extractToolTextContent(result);
  if (result?.isError) {
    exitCode = 1;
    process.stdout.write(JSON.stringify({ ok: false, error: content || payload.toolName + " 返回错误" }));
  } else {
    process.stdout.write(JSON.stringify({ ok: true, content }));
  }
} catch (err) {
  exitCode = 1;
  process.stdout.write(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
} finally {
  try { await client.close?.(); } catch {}
  try { await transport.close(); } catch {}
  process.exit(exitCode);
}
`;
    const result = await execFileAsync(process.execPath, [
        "--input-type=module",
        "--eval",
        bridgeScript,
        JSON.stringify({ endpoint, toolName, args }),
    ], {
        windowsHide: true,
        timeout: timeoutMs + 5000,
        maxBuffer: 1024 * 1024,
        encoding: "utf-8",
    });
    const payload = JSON.parse((result.stdout || "").trim() || "{}") as { ok?: boolean; content?: string; error?: string };
    if (!payload.ok) {
        throw new Error(payload.error || `${toolName} 失败`);
    }
    return payload.content || "";
}

async function callWebFetcherViaChild(toolName: string, args: Record<string, unknown>, timeoutMs = DEFAULT_WEB_FETCHER_TIMEOUT_MS): Promise<string> {
    const bridgeScript = `
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const payload = JSON.parse(process.argv[1]);
function extractToolTextContent(result) {
  const blocks = Array.isArray(result?.content) ? result.content : [];
  return blocks.map((block) => {
    if (typeof block === "string") return block;
    if (!block || typeof block !== "object") return "";
    if (block.type === "text" && typeof block.text === "string") return block.text.trim();
    return "";
  }).filter(Boolean).join("\\n\\n").trim();
}

const transport = new StreamableHTTPClientTransport(new URL(payload.endpoint));
const client = new Client({ name: "sandbox-council-webfetchtext-child", version: "1.0.0" });
let exitCode = 0;
try {
  await client.connect(transport);
  const result = await client.callTool({ name: payload.toolName, arguments: payload.args });
  const content = extractToolTextContent(result);
  if (result?.isError) {
    exitCode = 1;
    process.stdout.write(JSON.stringify({ ok: false, error: content || payload.toolName + " 返回错误" }));
  } else {
    process.stdout.write(JSON.stringify({ ok: true, content }));
  }
} catch (err) {
  exitCode = 1;
  process.stdout.write(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
} finally {
  try { await client.close?.(); } catch {}
  try { await transport.close(); } catch {}
  process.exit(exitCode);
}
`;
    const result = await execFileAsync(process.execPath, [
        "--input-type=module",
        "--eval",
        bridgeScript,
        JSON.stringify({
            endpoint: DEFAULT_WEB_FETCHER_MCP_URL,
            toolName,
            args,
        }),
    ], {
        windowsHide: true,
        timeout: timeoutMs + 5000,
        maxBuffer: 1024 * 1024,
        encoding: "utf-8",
    });
    const payload = JSON.parse((result.stdout || "").trim() || "{}") as { ok?: boolean; content?: string; error?: string };
    if (!payload.ok) {
        throw new Error(payload.error || `${toolName} 失败`);
    }
    return payload.content || "";
}

function extractToolTextContent(result: unknown): string {
    const payload = result && typeof result === "object" ? result as { content?: unknown[] } : {};
    const blocks = Array.isArray(payload.content) ? payload.content : [];
    return blocks.map((block) => {
        if (typeof block === "string") return block;
        if (!block || typeof block !== "object") return "";
        const candidate = block as { type?: unknown; text?: unknown };
        if (candidate.type === "text" && typeof candidate.text === "string") return candidate.text.trim();
        return "";
    }).filter(Boolean).join("\n\n").trim();
}

async function runExaSearch(query: string, maxResults: number): Promise<{ text?: string; notes: string[] }> {
    const triedQueries = buildSearchQueries(query);
    const notes: string[] = [];
    for (const searchQuery of triedQueries) {
        try {
            const text = await callExaViaChild("web_search_exa", {
                query: searchQuery,
                numResults: maxResults,
            }, DEFAULT_EXA_TIMEOUT_MS);
            const queryNote = searchQuery === query ? "" : `\n\nquery fallback: ${searchQuery}`;
            const exaNotes = notes.length > 0 ? `\n\nExa 尝试:\n- ${notes.join("\n- ")}` : "";
            return {
                text: `webSearch "${query}" 返回结果（Exa MCP）:\n${text}${queryNote}${exaNotes}`,
                notes,
            };
        } catch (err) {
            notes.push(`Exa 失败 [${searchQuery}]: ${compactErrorMessage(err)}`);
        }
    }
    return { notes };
}

function describeFetchError(url: string, err: unknown): string {
    if (err instanceof Error) {
        const cause = (err as Error & { cause?: unknown }).cause;
        const causeText = cause instanceof Error ? `; cause=${cause.name}: ${cause.message}` : "";
        return `${url} 请求失败: ${err.name}: ${err.message}${causeText}`;
    }
    return `${url} 请求失败: ${String(err)}`;
}

async function fetchText(url: string, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS): Promise<string> {
    await assertPublicHttpUrl(url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, {
            signal: controller.signal,
            headers: {
                "User-Agent": "Mozilla/5.0 (compatible; sandbox-council/1.0; +text-fetch)",
                "Accept": "text/html,application/xhtml+xml,application/xml,text/plain;q=0.9,*/*;q=0.8",
            },
        });
        const text = await response.text();
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`);
        return text;
    } catch (err) {
        throw new Error(describeFetchError(url, err));
    } finally {
        clearTimeout(timer);
    }
}

function isPrivateHostname(hostname: string): boolean {
    const host = hostname.toLowerCase();
    return host === "localhost" || host.endsWith(".localhost");
}

function isPrivateIp(address: string, includeBenchmarkRange = true): boolean {
    if (address.startsWith("::ffff:")) return isPrivateIp(address.slice("::ffff:".length), includeBenchmarkRange);
    if (address === "::" || address === "::1" || address.startsWith("fe80:") || address.startsWith("fc") || address.startsWith("fd")) return true;
    const parts = address.split(".").map((part) => Number(part));
    if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) return false;
    const [a, b] = parts;
    return a === 0
        || a === 10
        || a === 127
        || (a === 100 && b >= 64 && b <= 127)
        || (a === 169 && b === 254)
        || (a === 172 && b >= 16 && b <= 31)
        || (includeBenchmarkRange && a === 198 && (b === 18 || b === 19))
        || (a === 192 && b === 168);
}

async function assertPublicHttpUrl(rawUrl: string): Promise<void> {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("仅允许 http/https URL");
    }
    if (isPrivateHostname(parsed.hostname) || isPrivateIp(parsed.hostname)) {
        throw new Error("拒绝访问 localhost / 私有地址");
    }
    try {
        const records = await dns.lookup(parsed.hostname, { all: true });
        if (records.some((record) => isPrivateIp(record.address, false))) {
            throw new Error("拒绝访问解析到私有地址的主机");
        }
    } catch (err) {
        if (err instanceof Error && err.message.includes("私有地址")) throw err;
        // DNS 失败时交给 fetch 返回更具体的网络错误。
    }
}

async function runWebSearch(args: Record<string, unknown>): Promise<string> {
    const query = getStringArg(args, "query");
    if (!query) throw new Error("webSearch 需要 query");
    const maxResults = Math.max(1, Math.min(getNumberArg(args, "maxResults", 5), 10));
    const fallbackNotes: string[] = [];
    const exaResult = await runExaSearch(query, maxResults);
    if (exaResult.text) return exaResult.text;
    fallbackNotes.push(...exaResult.notes);
    fallbackNotes.push(`Exa 未返回可用结果，已降级到 HTML fallback（endpoint=${safeDescribeExaEndpoint()}）`);
    const triedQueries = buildSearchQueries(query);
    const secondaryQueries = triedQueries.slice(0, 2);
    const useDuckDuckGo = args.duckDuckGo === true || args.engine === "duckduckgo";
    const lowConfidenceCandidates: string[] = [];
    for (const searchQuery of secondaryQueries) {
        const url = `https://www.so.com/s?q=${encodeURIComponent(searchQuery)}`;
        try {
            const html = await fetchText(url, DEFAULT_SEARCH_TIMEOUT_MS);
            const matches = [...html.matchAll(/<h3[^>]*>[\s\S]*?<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h3>/giu)];
            const rows = matches.slice(0, maxResults).map((match, index) => {
                return `${index + 1}. ${htmlDecode(stripHtml(match[2]))}\n   ${htmlDecode(match[1])}`;
            });
            const ranked = rankSearchRows(query, rows);
            if (ranked.good.length > 0) {
                const note = searchQuery === query ? "" : `\n\nquery fallback: ${searchQuery}`;
                return `webSearch "${query}" 返回 ${ranked.good.length} 条结果（360 Search fallback）:\n${ranked.good.join("\n")}${note}`;
            }
            if (ranked.lowConfidence.length > 0) {
                lowConfidenceCandidates.push(...ranked.lowConfidence);
                fallbackNotes.push(`360 Search 仅返回低相关结果: ${searchQuery}`);
            } else {
                fallbackNotes.push(`360 Search 未解析到高相关结果: ${searchQuery}`);
            }
        } catch (err) {
            fallbackNotes.push(err instanceof Error ? err.message : String(err));
        }
    }

    if (useDuckDuckGo) {
        for (const searchQuery of secondaryQueries) {
            const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(searchQuery)}`;
            try {
                const html = await fetchText(url, DEFAULT_SEARCH_TIMEOUT_MS);
                const anchors = [...html.matchAll(/<a\b[^>]*class="[^"]*result__a[^"]*"[^>]*>[\s\S]*?<\/a>/giu)];
                const rows = anchors.slice(0, maxResults).map((match, index) => {
                    const anchor = match[0];
                    const rawUrl = htmlDecode(anchor.match(/\bhref="([^"]+)"/iu)?.[1] || "");
                    let cleanUrl = rawUrl;
                    try {
                        const parsed = new URL(rawUrl);
                        const uddg = parsed.searchParams.get("uddg");
                        if (uddg) cleanUrl = uddg;
                    } catch {
                        // Keep raw URL.
                    }
                    const title = htmlDecode(stripHtml(anchor));
                    return `${index + 1}. ${title}\n   ${cleanUrl}`;
                });
                const ranked = rankSearchRows(query, rows);
                if (ranked.good.length > 0) {
                    const note = searchQuery === query ? "" : `\n\nquery fallback: ${searchQuery}`;
                    return `webSearch "${query}" 返回 ${ranked.good.length} 条结果（DuckDuckGo HTML）:\n${ranked.good.join("\n")}${note}`;
                }
                fallbackNotes.push(`DuckDuckGo HTML 未解析到高相关结果: ${searchQuery}`);
            } catch (err) {
                fallbackNotes.push(err instanceof Error ? err.message : String(err));
                if (isDuckDuckGoBlocked(err)) break;
            }
        }

        for (const searchQuery of secondaryQueries) {
            try {
                const apiUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(searchQuery)}&format=json&no_redirect=1&no_html=1`;
                const raw = await fetchText(apiUrl, DEFAULT_SEARCH_TIMEOUT_MS);
                const data = JSON.parse(raw);
                const fallbackRows: string[] = [];
                if (data.AbstractText) {
                    fallbackRows.push(`1. ${data.Heading || searchQuery}\n   ${data.AbstractURL || ""}\n   ${data.AbstractText}`);
                }
                for (const topic of data.RelatedTopics || []) {
                    if (fallbackRows.length >= maxResults) break;
                    if (topic.Text) {
                        fallbackRows.push(`${fallbackRows.length + 1}. ${topic.Text}\n   ${topic.FirstURL || ""}`);
                    }
                }
                const ranked = rankSearchRows(query, fallbackRows);
                if (ranked.good.length > 0) {
                    const note = fallbackNotes.length > 0 ? `\n\nfallback 说明:\n- ${fallbackNotes.join("\n- ")}` : "";
                    return `webSearch "${query}" 返回 ${ranked.good.length} 条结果（DuckDuckGo instant answer）:\n${ranked.good.join("\n")}${note}`;
                }
                fallbackNotes.push(`DuckDuckGo instant answer 未返回高相关摘要结果: ${searchQuery}`);
            } catch (err) {
                fallbackNotes.push(err instanceof Error ? err.message : String(err));
                if (isDuckDuckGoBlocked(err)) break;
            }
        }
    } else {
        fallbackNotes.push("DuckDuckGo 默认跳过；当前环境常见 403/timeout，可传 duckDuckGo=true 强制尝试");
    }

    for (const searchQuery of triedQueries) {
        const url = `https://www.bing.com/search?q=${encodeURIComponent(searchQuery)}`;
        try {
            const html = await fetchText(url, DEFAULT_SEARCH_TIMEOUT_MS);
            const matches = [...html.matchAll(/<li\b[^>]*class="[^"]*\bb_algo\b[^"]*"[^>]*>[\s\S]*?<h2[^>]*>[\s\S]*?<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h2>([\s\S]*?)(?=<li\b[^>]*class="[^"]*\bb_algo\b|<\/ol>|$)/giu)];
            const rows = matches.slice(0, maxResults).map((match, index) => {
                const snippet = stripHtml(match[3].match(/<p[^>]*>([\s\S]*?)<\/p>/iu)?.[1] || "");
                return `${index + 1}. ${htmlDecode(stripHtml(match[2]))}\n   ${htmlDecode(match[1])}${snippet ? `\n   ${htmlDecode(snippet)}` : ""}`;
            });
            const ranked = rankSearchRows(query, rows);
            if (ranked.good.length > 0) {
                const note = fallbackNotes.length > 0 ? `\n\nfallback 说明:\n- ${fallbackNotes.join("\n- ")}` : "";
                const queryNote = searchQuery === query ? "" : `\n\nquery fallback: ${searchQuery}`;
                return `webSearch "${query}" 返回 ${ranked.good.length} 条结果（Bing HTML fallback）:\n${ranked.good.join("\n")}${queryNote}${note}`;
            }
            if (ranked.lowConfidence.length > 0) {
                lowConfidenceCandidates.push(...ranked.lowConfidence);
                fallbackNotes.push(`Bing HTML 仅返回低相关结果: ${searchQuery}`);
                continue;
            }
            fallbackNotes.push(`Bing HTML 未解析到高相关结果: ${searchQuery}`);
        } catch (err) {
            fallbackNotes.push(err instanceof Error ? err.message : String(err));
        }
    }

    if (lowConfidenceCandidates.length > 0) {
        const uniqueRows = [...new Set(lowConfidenceCandidates)].slice(0, maxResults);
        return `webSearch "${query}" 返回 ${uniqueRows.length} 条低相关结果（low-confidence，未找到高相关命中）:\n${uniqueRows.join("\n")}\n\nfallback 说明:\n- ${fallbackNotes.join("\n- ")}`;
    }

    return `webSearch "${query}" 未解析到结果\nfallback 说明:\n- ${fallbackNotes.join("\n- ")}`;
}

async function runWebFetchText(args: Record<string, unknown>): Promise<string> {
    const url = getStringArg(args, "url");
    if (!url) throw new Error("webFetchText 需要 url");
    if (!/^https?:\/\//iu.test(url)) throw new Error("webFetchText 仅允许 http/https URL");
    const maxChars = Math.max(500, Math.min(getNumberArg(args, "maxChars", 8000), 20000));
    const extract = getStringArg(args, "extract") || getStringArg(args, "mode") || "text";
    const backend = getStringArg(args, "backend") || "auto";
    const notes: string[] = [];
    await assertPublicHttpUrl(url);

    if (extract === "text" && (backend === "auto" || backend === "exa")) {
        try {
            const text = await callExaViaChild("web_fetch_exa", {
                urls: [url],
                maxCharacters: maxChars,
            }, DEFAULT_EXA_TIMEOUT_MS);
            return `webFetchText ${url} extract=text backend=exa\n${text}`;
        } catch (err) {
            notes.push(`Exa fetch 失败: ${compactErrorMessage(err)}`);
            if (backend === "exa") {
                return `webFetchText ${url} extract=text backend=exa 失败\n- ${notes.join("\n- ")}`;
            }
        }
    }

    if (backend === "auto" || backend === "webFetcher") {
        try {
            const text = await withPromiseTimeout((async () => {
                if (extract === "html") {
                    return await callWebFetcherViaChild("web_fetch_html", { url }, DEFAULT_WEB_FETCHER_TIMEOUT_MS);
                }
                if (extract === "links") {
                    return await callWebFetcherViaChild("web_extract_links", { url }, DEFAULT_WEB_FETCHER_TIMEOUT_MS);
                }
                if (extract === "tables") {
                    return await callWebFetcherViaChild("web_extract_tables", { url, format: "markdown" }, DEFAULT_WEB_FETCHER_TIMEOUT_MS);
                }
                return await callWebFetcherViaChild("web_fetch_page", { url, outputMode: "full" }, DEFAULT_WEB_FETCHER_TIMEOUT_MS);
            })(), DEFAULT_WEB_FETCHER_TIMEOUT_MS + 5000, "web-fetcher");
            const suffix = notes.length > 0 ? `\n\nfallback 说明:\n- ${notes.join("\n- ")}` : "";
            return `webFetchText ${url} extract=${extract} backend=web-fetcher\n${clip(text, maxChars)}${suffix}`;
        } catch (err) {
            notes.push(`web-fetcher 失败: ${compactErrorMessage(err)}`);
            if (backend === "webFetcher") {
                return `webFetchText ${url} extract=${extract} backend=web-fetcher 失败\n- ${notes.join("\n- ")}`;
            }
        }
    }

    const html = await fetchText(url);
    const title = htmlDecode(html.match(/<title[^>]*>([\s\S]*?)<\/title>/iu)?.[1]?.trim() || "");
    const links = [...html.matchAll(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/giu)]
        .slice(0, 20)
        .map((match) => {
            const href = htmlDecode(match[1]);
            const text = htmlDecode(stripHtml(match[2])).slice(0, 120);
            return text ? `- ${text}: ${href}` : `- ${href}`;
        });
    const tables = [...html.matchAll(/<table\b[\s\S]*?<\/table>/giu)]
        .slice(0, 5)
        .map((match, tableIndex) => {
            const rows = [...match[0].matchAll(/<tr\b[\s\S]*?<\/tr>/giu)]
                .slice(0, 20)
                .map((row) => {
                    const cells = [...row[0].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/giu)]
                        .map((cell) => htmlDecode(stripHtml(cell[1])).replace(/\|/gu, "\\|"));
                    return cells;
                })
                .filter((row) => row.length > 0);
            if (rows.length === 0) return "";
            const width = Math.max(...rows.map((row) => row.length));
            const normalized = rows.map((row) => [...row, ...Array(Math.max(0, width - row.length)).fill("")]);
            const header = normalized[0];
            const separator = Array(width).fill("---");
            const body = normalized.slice(1);
            return [`### table ${tableIndex + 1}`, `| ${header.join(" | ")} |`, `| ${separator.join(" | ")} |`, ...body.map((row) => `| ${row.join(" | ")} |`)].join("\n");
        })
        .filter(Boolean);
    const text = htmlDecode(stripHtml(html)).slice(0, maxChars);
    if (extract === "html") {
        return [
            `webFetchText ${url} extract=html backend=direct`,
            title ? `标题: ${title}` : "",
            "",
            html.slice(0, maxChars),
            notes.length > 0 ? `\nfallback 说明:\n- ${notes.join("\n- ")}` : "",
        ].filter(Boolean).join("\n");
    }
    if (extract === "links") {
        return [
            `webFetchText ${url} extract=links backend=direct`,
            title ? `标题: ${title}` : "",
            links.length > 0 ? links.join("\n") : "未提取到链接",
            notes.length > 0 ? `\nfallback 说明:\n- ${notes.join("\n- ")}` : "",
        ].filter(Boolean).join("\n");
    }
    if (extract === "tables") {
        return [
            `webFetchText ${url} extract=tables backend=direct`,
            title ? `标题: ${title}` : "",
            tables.length > 0 ? tables.join("\n\n") : "未提取到 HTML table",
            notes.length > 0 ? `\nfallback 说明:\n- ${notes.join("\n- ")}` : "",
        ].filter(Boolean).join("\n");
    }
    return [
        `webFetchText ${url} extract=text backend=direct`,
        title ? `标题: ${title}` : "",
        "",
        "正文摘录:",
        text,
        links.length > 0 ? "\n链接摘录:\n" + links.join("\n") : "",
        notes.length > 0 ? `\nfallback 说明:\n- ${notes.join("\n- ")}` : "",
    ].filter(Boolean).join("\n");
}

function assertSimpleScriptSafe(language: "node" | "python", code: string): void {
    if (code.length > SIMPLE_SCRIPT_MAX_CODE_CHARS) throw new Error(`simpleScript 代码过长，最多 ${SIMPLE_SCRIPT_MAX_CODE_CHARS} 字符`);
    const lower = code.toLowerCase();
    const deniedByLanguage: Record<typeof language, string[]> = {
        node: [
            "child_process", "subprocess", "socket", "requests", "urllib", "http.client",
            "https", "http", "net", "dgram", "fs", "writefile", "unlink", "rmdir",
            "remove(", "rename(", "spawn", "exec(", "eval", "function", "constructor",
            "__proto__", "prototype", "process", "require", "import", "module", "global",
            "fetch", "xmlhttprequest", "websocket",
        ],
        python: [
            "subprocess", "socket", "requests", "urllib", "http.client", "http.server",
            "asyncio", "multiprocessing", "threading", "pathlib", "shutil", "tempfile",
            "ctypes", "pickle", "marshal", "importlib", "builtins", "__builtins__",
            "__import__", "open(", ".write(", ".writelines(", "eval(", "exec(",
            "compile(", "globals(", "locals(", "vars(", "getattr(", "setattr(",
            "delattr(", "breakpoint(", "help(", "input(", "__", "os.", "sys.",
        ],
    };
    const hit = deniedByLanguage[language].find((needle) => lower.includes(needle));
    if (hit) throw new Error(`simpleScript 拒绝疑似副作用或网络能力: ${hit}`);
}

function getSimpleScriptTimeout(args: Record<string, unknown>): number {
    const requested = getNumberArg(args, "timeout", 1000);
    return Math.max(1, Math.min(Math.trunc(requested), 1000));
}

async function withTempDir<T>(callback: (tmpDir: string) => Promise<T>): Promise<T> {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "sandbox-council-simple-"));
    try {
        return await callback(tmpDir);
    } finally {
        await rm(tmpDir, { recursive: true, force: true });
    }
}

function minimalWindowsEnv(): Record<string, string> {
    if (process.platform !== "win32") return {};
    const env: Record<string, string> = {};
    for (const key of ["SystemRoot", "WINDIR"]) {
        const value = process.env[key];
        if (value) env[key] = value;
    }
    return env;
}

function getProcessText(err: any, timeout: number, language: string): string {
    const timedOut = Boolean(err?.killed || err?.signal === "SIGTERM" || err?.code === "ETIMEDOUT");
    const pieces = [
        timedOut ? `simpleScript ${language} 超时或被终止 (${timeout}ms)` : `simpleScript ${language} 执行失败`,
        typeof err?.stderr === "string" ? err.stderr.trim() : "",
        typeof err?.stdout === "string" ? err.stdout.trim() : "",
        err instanceof Error ? err.message : "",
    ].filter(Boolean);
    return pieces.join("\n").slice(0, SIMPLE_SCRIPT_MAX_OUTPUT_CHARS);
}

function truncateSimpleScriptOutput(text: string): string {
    if (text.length <= SIMPLE_SCRIPT_MAX_OUTPUT_CHARS) return text;
    return `${text.slice(0, SIMPLE_SCRIPT_MAX_OUTPUT_CHARS)}\n[truncated to ${SIMPLE_SCRIPT_MAX_OUTPUT_CHARS} chars]`;
}

async function runRestrictedNode(code: string, input: unknown, timeout: number, cwd: string): Promise<string> {
    const wrapper = `
const input = JSON.parse(process.env.SANDBOX_COUNCIL_INPUT || "null");
for (const name of ["process", "fetch", "WebSocket", "EventSource", "require", "module", "global"]) {
  try { Object.defineProperty(globalThis, name, { value: undefined, writable: false, configurable: false }); } catch {}
}
Object.freeze(console);
Object.freeze(JSON);
Object.freeze(Math);
const result = await (async () => {
  "use strict";
${code}
})();
if (result !== undefined) console.log(typeof result === "string" ? result : JSON.stringify(result));
`;
    try {
        const result = await execFileAsync(process.execPath, [
            "--permission",
            "--disable-proto=throw",
            "--disallow-code-generation-from-strings",
            "--no-addons",
            "--no-global-search-paths",
            "--jitless",
            "--input-type=module",
            "--eval",
            wrapper,
        ], {
            timeout,
            cwd,
            windowsHide: true,
            maxBuffer: SIMPLE_SCRIPT_MAX_BUFFER_BYTES,
            env: {
                ...minimalWindowsEnv(),
                SANDBOX_COUNCIL_INPUT: JSON.stringify(input),
                NODE_DISABLE_COLORS: "1",
            },
        });
        return [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
    } catch (err: any) {
        throw new Error(getProcessText(err, timeout, "node"));
    }
}

function getPythonCommand(): string {
    return process.env.SANDBOX_COUNCIL_PYTHON || process.env.PYTHON || "python";
}

function pythonWrapper(): string {
    return String.raw`
import ast
import bisect
import collections
import csv
import datetime
import decimal
import fractions
import functools
import heapq
import itertools
import json
import math
import operator
import re
import statistics
import sys

payload = json.loads(sys.stdin.read() or "{}")
code = payload.get("code", "")
input_value = payload.get("input", None)

safe_modules = {
    "bisect": bisect,
    "collections": collections,
    "csv": csv,
    "datetime": datetime,
    "decimal": decimal,
    "fractions": fractions,
    "functools": functools,
    "heapq": heapq,
    "itertools": itertools,
    "json": json,
    "math": math,
    "operator": operator,
    "re": re,
    "statistics": statistics,
}
denied_import_roots = {
    "asyncio", "builtins", "ctypes", "dbm", "fcntl", "glob", "http", "importlib", "io",
    "marshal", "multiprocessing", "os", "pathlib", "pickle", "platform", "pty", "requests",
    "resource", "select", "shelve", "shlex", "shutil", "signal", "socket", "sqlite3",
    "ssl", "subprocess", "sys", "tempfile", "threading", "urllib", "venv", "winreg",
}
denied_call_names = {
    "__import__", "breakpoint", "compile", "delattr", "dir", "eval", "exec", "getattr",
    "globals", "help", "locals", "open", "setattr", "vars",
}
denied_attr_names = {
    "connect", "exec", "mkdir", "makedirs", "open", "popen", "remove", "rename",
    "replace", "request", "rmdir", "run", "spawn", "system", "unlink", "urlopen",
    "write", "writelines",
}

class Guard(ast.NodeVisitor):
    def reject(self, node, message):
        raise ValueError(f"simpleScript python denied: {message} (line {getattr(node, 'lineno', '?')})")

    def visit_Import(self, node):
        for alias in node.names:
            root = alias.name.split(".", 1)[0]
            if root in denied_import_roots or root not in safe_modules:
                self.reject(node, f"dangerous or unsupported import {alias.name}")
        self.generic_visit(node)

    def visit_ImportFrom(self, node):
        if node.module is None or any(alias.name == "*" for alias in node.names):
            self.reject(node, "star import is not allowed")
        root = node.module.split(".", 1)[0]
        if root in denied_import_roots or root not in safe_modules:
            self.reject(node, f"dangerous or unsupported import {node.module}")
        self.generic_visit(node)

    def visit_Name(self, node):
        if node.id in denied_call_names:
            self.reject(node, f"dangerous name {node.id}")

    def visit_Attribute(self, node):
        if node.attr.startswith("__") or node.attr in denied_attr_names:
            self.reject(node, f"dangerous attribute {node.attr}")
        self.generic_visit(node)

    def visit_Call(self, node):
        fn = node.func
        if isinstance(fn, ast.Name) and fn.id in denied_call_names:
            self.reject(node, f"dangerous call {fn.id}")
        if isinstance(fn, ast.Attribute) and (fn.attr.startswith("__") or fn.attr in denied_attr_names):
            self.reject(node, f"dangerous call {fn.attr}")
        self.generic_visit(node)

def safe_import(name, globals=None, locals=None, fromlist=(), level=0):
    root = name.split(".", 1)[0]
    if level != 0 or root not in safe_modules:
        raise ImportError(f"simpleScript python denied import {name}")
    return safe_modules[root]

safe_builtins = {
    "ArithmeticError": ArithmeticError,
    "AssertionError": AssertionError,
    "Exception": Exception,
    "False": False,
    "None": None,
    "True": True,
    "ValueError": ValueError,
    "__import__": safe_import,
    "abs": abs,
    "all": all,
    "any": any,
    "bool": bool,
    "dict": dict,
    "enumerate": enumerate,
    "filter": filter,
    "float": float,
    "int": int,
    "isinstance": isinstance,
    "len": len,
    "list": list,
    "map": map,
    "max": max,
    "min": min,
    "pow": pow,
    "print": print,
    "range": range,
    "repr": repr,
    "reversed": reversed,
    "round": round,
    "set": set,
    "slice": slice,
    "sorted": sorted,
    "str": str,
    "sum": sum,
    "tuple": tuple,
    "zip": zip,
}

try:
    tree = ast.parse(code, mode="exec")
    Guard().visit(tree)
    if tree.body and isinstance(tree.body[-1], ast.Expr):
        tree.body[-1] = ast.Assign(targets=[ast.Name(id="__result", ctx=ast.Store())], value=tree.body[-1].value)
        ast.fix_missing_locations(tree)

    namespace = {"__builtins__": safe_builtins, "input": input_value, **safe_modules}
    exec(compile(tree, "<simpleScript>", "exec"), namespace, namespace)
    result = namespace.get("__result", None)
    if result is not None:
        print(result if isinstance(result, str) else json.dumps(result, ensure_ascii=False, default=str))
except Exception as exc:
    print(str(exc), file=sys.stderr)
    raise SystemExit(1)
`;
}

async function spawnWithInput(command: string, args: string[], stdin: string, timeout: number, cwd: string, env: Record<string, string>): Promise<{ stdout: string; stderr: string }> {
    return await new Promise((resolve, reject) => {
        const child = spawn(command, args, { cwd, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        let settled = false;
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill();
        }, timeout);
        const finish = (err?: Error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (err) reject(err);
            else resolve({ stdout, stderr });
        };
        child.stdout.on("data", (chunk: Buffer) => {
            stdout += chunk.toString("utf8");
            if (Buffer.byteLength(stdout + stderr, "utf8") > SIMPLE_SCRIPT_MAX_BUFFER_BYTES) {
                child.kill();
                finish(new Error("simpleScript 输出超过 128KB 限制"));
            }
        });
        child.stderr.on("data", (chunk: Buffer) => {
            stderr += chunk.toString("utf8");
            if (Buffer.byteLength(stdout + stderr, "utf8") > SIMPLE_SCRIPT_MAX_BUFFER_BYTES) {
                child.kill();
                finish(new Error("simpleScript 输出超过 128KB 限制"));
            }
        });
        child.on("error", finish);
        child.on("close", (code, signal) => {
            if (settled) return;
            if (timedOut) {
                finish(new Error(`simpleScript python 超时或被终止 (${timeout}ms)`));
                return;
            }
            if (code !== 0) {
                finish(new Error([
                    `simpleScript python 执行失败 exit=${code}${signal ? ` signal=${signal}` : ""}`,
                    stderr.trim(),
                    stdout.trim(),
                ].filter(Boolean).join("\n")));
                return;
            }
            finish();
        });
        child.stdin.end(stdin, "utf8");
    });
}

async function runRestrictedPython(code: string, input: unknown, timeout: number, cwd: string): Promise<string> {
    const payload = JSON.stringify({ code, input });
    try {
        const result = await spawnWithInput(getPythonCommand(), [
            "-I",
            "-S",
            "-c",
            pythonWrapper(),
        ], payload, timeout, cwd, {
            ...minimalWindowsEnv(),
            PYTHONIOENCODING: "utf-8",
            PYTHONNOUSERSITE: "1",
            PYTHONUTF8: "1",
        });
        return [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
    } catch (err: any) {
        throw new Error(getProcessText(err, timeout, "python"));
    }
}

async function runSimpleScript(args: Record<string, unknown>): Promise<string> {
    const language = ((getStringArg(args, "language") || "node").toLowerCase()) as "node" | "python";
    if (language !== "python" && language !== "node") {
        throw new Error("simpleScript 仅支持 python 或 node");
    }
    const code = getStringArg(args, "code");
    if (!code) throw new Error("simpleScript 需要 code");
    assertSimpleScriptSafe(language, code);
    const timeout = getSimpleScriptTimeout(args);
    const input = args.input ?? null;
    const resultText = await withTempDir((tmpDir) => language === "node"
        ? runRestrictedNode(code, input, timeout, tmpDir)
        : runRestrictedPython(code, input, timeout, tmpDir));
    return [
        `simpleScript ${language} restricted-subprocess ok timeout=${timeout}ms`,
        resultText ? `stdout:\n${truncateSimpleScriptOutput(resultText)}` : "",
    ].filter(Boolean).join("\n");
}

export async function runCouncilTool(call: CouncilToolCall, config: CouncilToolConfig = {}): Promise<CouncilToolResult> {
    const enabled = {
        webSearch: config.webSearch !== false,
        webFetchText: config.webFetchText !== false,
        simpleScript: config.simpleScript !== false,
    };
    try {
        if (!enabled[call.tool]) throw new Error(`${call.tool} 未启用`);
        let text: string;
        if (call.tool === "webSearch") {
            text = await runWebSearch(call.args);
        } else if (call.tool === "webFetchText") {
            text = await runWebFetchText(call.args);
        } else {
            text = await runSimpleScript(call.args);
        }
        return { tool: call.tool, args: call.args, reason: call.reason, ok: true, text };
    } catch (err) {
        return {
            tool: call.tool,
            args: call.args,
            reason: call.reason,
            ok: false,
            text: err instanceof Error ? err.message : String(err),
        };
    }
}
