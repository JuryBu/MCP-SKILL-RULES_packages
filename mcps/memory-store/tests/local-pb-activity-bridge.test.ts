import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import type { LocalPbActivityData } from "../src/conversation-source-adapters.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pb-activity-bridge-"));
const environment = { ...process.env };
process.env.MEMORY_STORE_DATA_ROOT = path.join(root, "data");
process.env.MEMORY_STORE_AUTO_RECORD = "0";
process.env.MEMORY_STORE_LIFECYCLE_ENABLED = "false";
process.env.MEMORY_STORE_DEVIN_CLI_DB_PATH = path.join(root, "absent.db");
process.env.MEMORY_STORE_DEVIN_DESKTOP_ROOT = path.join(root, "absent-desktop");
process.env.MEMORY_STORE_WSF_SUBAGENT_JOBS_PATH = path.join(root, "absent-jobs.json");
const { loadConversationData, conversationSourceIsPartial } = await import("../src/conversation-bridge.ts");
const { loadLocalPbConversation, formatLocalPbActivities } = await import("../src/conversation-source-adapters.ts");
const { registerConversation } = await import("../src/tools/conversation.ts");
const { resetConversationSourceCacheForTests, setConversationSourceCacheDataRootForTests } = await import("../src/conversation-source-cache.ts");
const key = Buffer.from("0123456789abcdef0123456789abcdef");
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

function varint(value: number): Buffer {
    const output: number[] = [];
    let remaining = value;
    do { output.push((remaining & 127) | (remaining > 127 ? 128 : 0)); remaining = Math.floor(remaining / 128); } while (remaining);
    return Buffer.from(output);
}
function bytes(number: number, value: Buffer | string): Buffer {
    const payload = Buffer.from(value);
    return Buffer.concat([varint(number * 8 + 2), varint(payload.length), payload]);
}
function scalar(number: number, value: number): Buffer { return Buffer.concat([varint(number * 8), varint(value)]); }
function fixture(host: "windsurf" | "antigravity"): Buffer {
    const uri = "file:///fixture/example.txt";
    const lines = bytes(3, Buffer.concat([bytes(1, "fixture 原文"), scalar(2, 1)]));
    const resource = Buffer.concat([bytes(2, bytes(3, lines)), bytes(8, uri), ...(host === "windsurf" ? [bytes(10, "fixture 完整文件\r\n")] : [scalar(11, 1)])]);
    const input = host === "windsurf" ? bytes(1, bytes(7, bytes(1, uri))) : bytes(2, bytes(2, bytes(5, uri)));
    const file = Buffer.concat([scalar(1, 5), scalar(4, 3), bytes(10, Buffer.concat([bytes(1, input), bytes(2, bytes(1, resource))]))]);
    const terminal = Buffer.concat([scalar(1, 28), scalar(4, 3), bytes(37, Buffer.concat([bytes(1, "fixture-terminal"), scalar(2, 2), bytes(9, "<truncated 12 lines>\nfixture output")]))]);
    const plain = bytes(1, Buffer.concat([bytes(1, "fixture-payload-id"), bytes(2, file), ...(host === "windsurf" ? [bytes(2, terminal)] : [])]));
    const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, nonce);
    return Buffer.concat([nonce, cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
}

try {
    for (const host of ["antigravity", "windsurf"] as const) {
        const realFile = host === "antigravity" ? process.env.PB_REAL_AGY_FILE : process.env.PB_REAL_WSF_FILE;
        const implicitRoot = realFile ? path.dirname(realFile) : path.join(root, host, "implicit");
        const activeRoot = path.join(root, host, "empty-active");
        fs.mkdirSync(activeRoot, { recursive: true });
        const id = realFile ? path.basename(realFile, ".pb") : "fixture-session";
        const filename = realFile || path.join(implicitRoot, `${id}.pb`);
        if (!realFile) { fs.mkdirSync(implicitRoot, { recursive: true }); fs.writeFileSync(filename, fixture(host)); }
        if (realFile) delete process.env.MEMORY_STORE_LOCAL_PB_KEY;
        else process.env.MEMORY_STORE_LOCAL_PB_KEY = key.toString("base64");
        const prefix = host === "windsurf" ? "MEMORY_STORE_WINDSURF_PB" : "MEMORY_STORE_ANTIGRAVITY_PB";
        process.env[`${prefix}_ACTIVE_ROOT`] = activeRoot;
        process.env[`${prefix}_IMPLICIT_ROOT`] = implicitRoot;
        const before = fs.statSync(filename), sourceSha = digest(fs.readFileSync(filename));
        const local = loadLocalPbConversation(host, id)!;
        assert.equal(local.rounds.length, 0);
        assert.equal(local.localPbActivities.formalRoundCount, 0);
        assert.ok(local.localPbActivities.activityCount > 0);
        assert.equal(local.partial, host === "windsurf");
        const cacheRoot = path.join(root, host, "cache");
        resetConversationSourceCacheForTests();
        setConversationSourceCacheDataRootForTests(cacheRoot);
        const built = await loadConversationData(host, id, { source: "local", refresh: true });
        assert.ok(built);
        resetConversationSourceCacheForTests();
        setConversationSourceCacheDataRootForTests(cacheRoot);
        const cached = await loadConversationData(host, id, { source: "cache" });
        assert.ok(cached);
        const data = (cached as typeof cached & { localPbActivities: LocalPbActivityData }).localPbActivities;
        assert.deepEqual(data, local.localPbActivities);
        assert.equal(cached.cacheGeneration, built.cacheGeneration);
        assert.equal(cached.roundCount, 0);
        assert.equal(cached.rounds.length, 0);
        assert.equal(cached.aiResponseCount, 0);
        assert.equal(cached.toolCallCount, 0);
        assert.equal(conversationSourceIsPartial(cached), local.partial);
        const full = formatLocalPbActivities(data, "full");
        const brief = formatLocalPbActivities(data, "brief");
        assert.match(full, /0个主人轮次/u);
        assert.match(full, /fieldPath=10\.2\.1\.2\.3\.3/u);
        assert.doesNotMatch(full, /## 轮次|### 用户|### AI/u);
        assert.ok(full.length > brief.length);
        let readTool: any;
        registerConversation({ tool: (_name: string, _description: string, _schema: unknown, callback: unknown) => { readTool = callback; } } as any,
            { loadConversation: async () => cached });
        const delivered = await readTool({ action: "read", conversationId: id, dataChain: host, source: "cache", depth: "full" });
        const deliveredText = delivered.content[0].text;
        assert.match(deliveredText, /本地 PB 活动/u);
        assert.match(deliveredText, /0个主人轮次/u);
        assert.doesNotMatch(deliveredText, /先调用 fetch 强制 refresh|超出轮号范围|无法从 fetch 缓存读取/u);
        let pageText = deliveredText;
        let pages = 1;
        const seenCursors = new Set<string>();
        while (true) {
            const next = /➡️ 下一段参数\n(\{[^\n]+\})/u.exec(pageText);
            if (!next) break;
            const parameters = JSON.parse(next[1]);
            assert.equal(typeof parameters.continuationCursor, "string");
            assert.equal(seenCursors.has(parameters.continuationCursor), false);
            seenCursors.add(parameters.continuationCursor);
            assert.ok(pages++ < 10);
            pageText = (await readTool(parameters)).content[0].text;
        }
        assert.ok(pageText.includes(full.slice(-100)));
        if (full.length > 100000) assert.ok(pages > 1);
        const bounded = await readTool({ action: "read", conversationId: id, dataChain: host, source: "cache", depth: "full", maxBytes: 4096 });
        assert.ok(Buffer.byteLength(bounded.content[0].text, "utf8") < 4352);
        if (host === "windsurf") assert.match(full, /truncated/u);
        if (realFile && host === "windsurf") assert.equal(data.diagnostics.filter(item => item.kind === "partial").length, 2);
        assert.equal(fs.statSync(filename).mtimeMs, before.mtimeMs);
        assert.equal(fs.statSync(filename).size, before.size);
        assert.equal(digest(fs.readFileSync(filename)), sourceSha);
        console.log(JSON.stringify({ host, real: Boolean(realFile), sourceSha, activityCount: data.activityCount, rounds: cached.roundCount,
            partial: conversationSourceIsPartial(cached), diagnostics: data.diagnostics.length, fullChars: full.length,
            fullSha: digest(full), activitySha: digest(JSON.stringify(data)), cacheReload: "same generation and identical activities", sourceUnchanged: true }));
    }
    console.log("PASS PB activity adapter -> bridge -> isolated persistent cache reload -> full activity formatting; zero fabricated human/model rounds");
} finally {
    resetConversationSourceCacheForTests();
    setConversationSourceCacheDataRootForTests(null);
    for (const name of Object.keys(process.env)) if (!(name in environment)) delete process.env[name];
    Object.assign(process.env, environment);
    fs.rmSync(root, { recursive: true, force: true });
}
