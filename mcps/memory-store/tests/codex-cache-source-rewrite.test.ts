import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const originalHome = os.homedir;
const originalDataRoot = process.env.MEMORY_STORE_DATA_ROOT;
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-source-rewrite-"));
const codexHome = path.join(temporaryRoot, ".codex");
const sessions = path.join(codexHome, "sessions");
fs.mkdirSync(sessions, { recursive: true });
os.homedir = () => temporaryRoot;
process.env.MEMORY_STORE_DATA_ROOT = path.join(temporaryRoot, "data");

const conversationId = "11111111-1111-4111-8111-111111111111";
const rolloutPath = path.join(sessions, `rollout-2026-01-01T00-00-00-${conversationId}.jsonl`);
const databasePath = path.join(codexHome, "state_5.sqlite");
const metadata = { type: "session_meta", payload: { id: conversationId, cwd: temporaryRoot } };
const message = (role: string, text: string) => ({ type: "response_item", payload: { type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }] } });
const serialize = (events: unknown[]) => events.map(event => JSON.stringify(event)).join("\n") + "\n";
let sourceTimestamp = Date.now();
const replaceSource = (text: string): void => {
    fs.writeFileSync(rolloutPath, text, "utf8");
    sourceTimestamp += 1000;
    fs.utimesSync(rolloutPath, sourceTimestamp / 1000, sourceTimestamp / 1000);
};

try {
    const bridge = await import("../src/conversation-bridge.ts");
    const cache = await import("../src/conversation-source-cache.ts");
    const codex = await import("../src/codex-client.ts");
    const history = await import("../src/codex-history-source.ts");
    cache.setConversationSourceCacheDataRootForTests(path.join(temporaryRoot, "data"));
    execFileSync("python", ["-c", "import sqlite3,sys\nconn=sqlite3.connect(sys.argv[1])\nconn.execute('create table threads(id text primary key,rollout_path text,cwd text,title text,source text,model text,reasoning_effort text,agent_nickname text,agent_role text,updated_at_ms integer,updated_at integer,archived integer)')\nconn.execute('create table thread_spawn_edges(parent_thread_id text,child_thread_id text,status text)')\nconn.execute('insert into threads values(?,?,?,?,?,?,?,?,?,?,?,?)',(sys.argv[2],sys.argv[3],sys.argv[4],'test','vscode',None,None,None,None,1,1,0))\nconn.commit()\nconn.close()", databasePath, conversationId, rolloutPath, temporaryRoot]);
    const options = { source: "local", link: "reference" } as const;
    const originalText = serialize([metadata, message("user", "OLD_USER"), message("assistant", "OLD_ANSWER")]);
    replaceSource(originalText);
    const original = await bridge.loadConversationData("codex", conversationId, options);
    assert.equal(original?.cacheState, "built");

    const longerUser = "NEW_USER_" + "x".repeat(1024);
    replaceSource(serialize([metadata, message("user", longerUser), message("assistant", "NEW_ANSWER")]));
    assert.notEqual(fs.readFileSync(rolloutPath)[Buffer.byteLength(originalText) - 1], 0x0a);
    assert.throws(() => history.assertCodexHistorySource(original!.codexData!.historySource!), /complete JSONL line/);
    const originalOpen = fs.promises.open;
    let injectedReadFailure = false;
    Object.defineProperty(fs.promises, "open", {
        configurable: true,
        value: async (...args: Parameters<typeof fs.promises.open>) => {
            const handle = await originalOpen(...args);
            const originalRead = handle.read.bind(handle);
            handle.read = ((buffer: NodeJS.ArrayBufferView, offset: number, length: number, position: number | null) => {
                if (!injectedReadFailure && length === 1 && position === Buffer.byteLength(originalText) - 1) {
                    injectedReadFailure = true;
                    throw Object.assign(new Error("injected old-boundary read failure"), { code: "EIO" });
                }
                return originalRead(buffer, offset, length, position);
            }) as typeof handle.read;
            return handle;
        },
    });
    try {
        const readFailure = await bridge.loadConversationData("codex", conversationId, options);
        assert.equal(injectedReadFailure, true);
        assert.equal(readFailure?.cacheState, "stale");
        assert.match(readFailure.cacheBuildFailure?.message || "", /injected old-boundary read failure/);
        assert.equal(readFailure.cacheGeneration, original!.cacheGeneration);
    } finally {
        Object.defineProperty(fs.promises, "open", { configurable: true, value: originalOpen });
    }
    const rewritten = await bridge.loadConversationData("codex", conversationId, options);
    assert.equal(rewritten?.cacheState, "built", "obsolete cache boundary must fall back to a full read");
    assert.notEqual(rewritten.cacheGeneration, original!.cacheGeneration);
    assert.deepEqual(rewritten.rounds.map(round => round.userMessage), [longerUser]);
    assert.ok(!rewritten.sourceDiagnostics?.some(item => item.includes("仅重放")));

    replaceSource(serialize([metadata, message("user", longerUser.replace("NEW_USER_", "NOW_USER_")), message("assistant", "NOW_ANSWER")]));
    assert.equal(fs.readFileSync(rolloutPath)[rewritten.codexData!.historySource!.segments[0]!.endByte - 1], 0x0a);
    assert.throws(() => history.assertCodexHistorySource(rewritten.codexData!.historySource!), /boundary changed/);
    const sameSize = await bridge.loadConversationData("codex", conversationId, options);
    assert.equal(sameSize?.cacheState, "built", "changed anchor at a valid old boundary must rebuild");
    assert.deepEqual(sameSize.rounds.map(round => round.userMessage), [longerUser.replace("NEW_USER_", "NOW_USER_")]);

    replaceSource(serialize([metadata, message("user", "SHORT"), message("assistant", "ANSWER")]));
    const shorter = await bridge.loadConversationData("codex", conversationId, options);
    assert.equal(shorter?.cacheState, "built", "shorter current source must not remain trapped behind old cache");
    assert.deepEqual(shorter.rounds.map(round => round.userMessage), ["SHORT"]);
    const stable = await bridge.loadConversationData("codex", conversationId, options);
    assert.equal(stable?.cacheState, "hit");
    assert.equal(stable.cacheGeneration, shorter.cacheGeneration);

    fs.appendFileSync(rolloutPath, serialize([message("user", "APPENDED"), message("assistant", "APPENDED_ANSWER")]));
    const appended = await bridge.loadConversationData("codex", conversationId, options);
    assert.equal(appended?.cacheState, "built");
    assert.deepEqual(appended.rounds.map(round => round.userMessage), ["SHORT", "APPENDED"]);
    assert.ok(appended.sourceDiagnostics?.some(item => item.includes("仅重放")), "valid append must retain incremental reading");
    const validText = fs.readFileSync(rolloutPath, "utf8");
    const frozen = codex.captureCodexSourceVersion(rolloutPath);

    replaceSource(serialize([metadata]) + "{broken-json}\n" + serialize([message("user", "BAD_SOURCE_MUST_NOT_PUBLISH")]));
    const invalid = await bridge.loadConversationData("codex", conversationId, options);
    assert.equal(invalid?.cacheState, "stale");
    assert.match(invalid.cacheBuildFailure?.message || "", /invalid JSON/);
    assert.equal(invalid.cacheGeneration, appended.cacheGeneration);
    const retained = await bridge.loadConversationData("codex", conversationId, { ...options, source: "cache" });
    assert.deepEqual(retained?.rounds.map(round => round.userMessage), ["SHORT", "APPENDED"]);
    await assert.rejects(() => bridge.loadConversationData("codex", conversationId, { ...options, expectedCodexSource: frozen }), /source|boundary/i);

    const interruptedText = serialize([metadata, message("user", longerUser), message("assistant", "ANSWER_ONE"), message("user", "ROUND_TWO"), message("assistant", "ANSWER_TWO"), message("user", "ROUND_THREE")]);
    replaceSource(interruptedText);
    const cacheDirectory = cache.getConversationSourceCacheEntryDirectory({ source: "codex:link=reference", conversationId });
    let sawStreamedRound = false;
    const cancelled = await bridge.loadConversationData("codex", conversationId, {
        ...options,
        isCancelled: () => {
            sawStreamedRound ||= fs.readdirSync(cacheDirectory).some(name => name.startsWith(".rounds-build-") && fs.statSync(path.join(cacheDirectory, name)).size > 0);
            return sawStreamedRound;
        },
    });
    assert.equal(sawStreamedRound, true, "cancellation must occur after raw fallback has streamed a round");
    assert.equal(cancelled?.cacheState, "stale");
    assert.match(cancelled.cacheBuildFailure?.message || "", /cancel/i);
    assert.equal(cancelled.cacheGeneration, appended.cacheGeneration);
    assert.ok(!fs.readdirSync(cacheDirectory).some(name => name.endsWith(".tmp")), "cancelled spool must be removed");

    const originalRename = fs.promises.rename;
    let changedAfterPublication = false;
    Object.defineProperty(fs.promises, "rename", {
        configurable: true,
        value: async (source: fs.PathLike, target: fs.PathLike) => {
            await originalRename(source, target);
            if (!changedAfterPublication && String(target) === path.join(cacheDirectory, "manifest.json")) {
                changedAfterPublication = true;
                replaceSource(interruptedText.replace("ANSWER_ONE", "ANSWER_BAD"));
            }
        },
    });
    try {
        const publicationFailure = await bridge.loadConversationData("codex", conversationId, options);
        assert.equal(changedAfterPublication, true, "mutation must follow raw fallback and the public manifest rename");
        assert.equal(publicationFailure?.cacheState, "stale");
        assert.match(publicationFailure.cacheBuildFailure?.message || "", /source|boundary/i);
        assert.equal(publicationFailure.cacheGeneration, appended.cacheGeneration);
        const afterRollback = await bridge.loadConversationData("codex", conversationId, { ...options, source: "cache" });
        assert.equal(afterRollback?.cacheGeneration, appended.cacheGeneration);
        assert.deepEqual(afterRollback.rounds.map(round => round.userMessage), ["SHORT", "APPENDED"]);
    } finally {
        Object.defineProperty(fs.promises, "rename", { configurable: true, value: originalRename });
    }

    replaceSource(validText);
    await assert.rejects(() => bridge.loadConversationData("codex", conversationId, { ...options, isCancelled: () => true }), /cancel/i);
    fs.renameSync(rolloutPath, rolloutPath + ".held");
    await assert.rejects(() => bridge.loadConversationData("codex", conversationId, options), /ENOENT|source|rollout/i);
    console.log("Codex source rewrite: boundary/anchor/truncation/unchanged/append/invalid-current/frozen-source/IO/cancellation/midstream-cancel/publication-rollback/missing-source passed");
    cache.setConversationSourceCacheDataRootForTests(undefined);
} finally {
    os.homedir = originalHome;
    if (originalDataRoot === undefined) delete process.env.MEMORY_STORE_DATA_ROOT;
    else process.env.MEMORY_STORE_DATA_ROOT = originalDataRoot;
    assert.equal(path.dirname(path.resolve(temporaryRoot)), path.resolve(os.tmpdir()));
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
