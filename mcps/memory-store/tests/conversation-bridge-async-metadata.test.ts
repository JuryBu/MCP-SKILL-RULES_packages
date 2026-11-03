import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const source = fs.readFileSync(new URL("../src/conversation-bridge.ts", import.meta.url), "utf8");
const tree = ts.createSourceFile("conversation-bridge.ts", source, ts.ScriptTarget.Latest, true);

function loadFunction(name: string, dependencies: Record<string, unknown>): (...args: any[]) => any {
    const declaration = tree.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === name);
    assert.ok(declaration, name);
    const compiled = ts.transpileModule(declaration.getText(tree), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText;
    return new Function(...Object.keys(dependencies), `${compiled}; return ${name};`)(...Object.values(dependencies));
}

const delay = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));

test("bridge has no synchronous Codex metadata import/call and awaits all three sites", () => {
    let awaited = 0;
    const visit = (node: ts.Node): void => {
        if (ts.isIdentifier(node)) assert.notEqual(node.text, "getCodexThread");
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "getCodexThreadAsync") {
            assert.ok(ts.isAwaitExpression(node.parent), `metadata call at ${tree.getLineAndCharacterOfPosition(node.pos).line + 1}`);
            awaited++;
        }
        ts.forEachChild(node, visit);
    };
    visit(tree);
    assert.equal(awaited, 3);
});

test("cache preflight waits for both metadata lookups without blocking timers", async () => {
    const stop = new Error("fixture cache boundary");
    const version = { sourcePath: "synthetic.jsonl", sourceSize: 12, sourceMtimeMs: 34 };
    const events: string[] = [];
    const load = loadFunction("loadFromResolvedChain", {
        throwIfConversationLoadCancelled: () => {},
        conversationSourceCacheKey: () => ({ source: "codex", conversationId: "synthetic" }),
        getCodexThreadAsync: async (id: string) => {
            assert.equal(id, "synthetic");
            events.push("metadata");
            await delay(30);
            return { rolloutPath: "synthetic.jsonl" };
        },
        captureCodexSourceVersionAsync: async (rollout: string) => {
            assert.equal(rollout, "synthetic.jsonl");
            events.push("capture");
            return version;
        },
        assertCodexSourceVersion: async (rollout: string, expected: unknown, stage: string) => {
            assert.equal(rollout, "synthetic.jsonl");
            assert.equal(expected, version);
            assert.equal(stage, "before cache lookup");
            events.push("assert");
        },
        readCachedConversationSourceCache: () => { events.push("cache"); throw stop; },
    });
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 5);
    try {
        await assert.rejects(() => load("codex", "synthetic", { source: "local" }), error => error === stop);
    } finally { clearInterval(timer); }
    assert.ok(ticks >= 3, `heartbeat ticks=${ticks}`);
    assert.deepEqual(events, ["metadata", "capture", "metadata", "assert", "cache"]);
});

test("pinned cache preflight retains the missing-thread source-change boundary", async () => {
    let assertions = 0;
    const load = loadFunction("loadFromResolvedChain", {
        throwIfConversationLoadCancelled: () => {}, conversationSourceCacheKey: () => ({}),
        getCodexThreadAsync: async () => { await delay(5); return null; },
        assertCodexSourceVersion: () => { assertions++; },
        readCachedConversationSourceCache: () => assert.fail("must reject before cache lookup"),
    });
    await assert.rejects(() => load("codex", "synthetic", { source: "local", expectedCodexSource: {} }), /Codex source changed before cache lookup/u);
    assert.equal(assertions, 0);
});

test("local Codex fingerprint awaits metadata/version and preserves revision/null results", async () => {
    let present = true;
    const fingerprint = loadFunction("localConversationSourceFingerprint", {
        getCodexThreadAsync: async () => { await delay(10); return present ? { rolloutPath: "synthetic.jsonl" } : null; },
        captureCodexSourceVersionAsync: async (rollout: string) => {
            assert.equal(rollout, "synthetic.jsonl");
            await delay(10);
            return { sourcePath: rollout, sourceSize: 12, sourceMtimeMs: 34, historySource: { revision: "fixture-revision" } };
        },
    });
    assert.deepEqual(await fingerprint("codex", "synthetic", "local"), {
        path: "synthetic.jsonl", size: 12, mtime: 34, revision: "fixture-revision",
    });
    present = false;
    assert.equal(await fingerprint("codex", "synthetic", "local"), null);
});

test("all freshness callers await local fingerprints rather than storing Promise values", async () => {
    const local = { revision: "synthetic-local" };
    const live = { revision: "synthetic-ls" };
    const freshness = loadFunction("prepareConversationCacheFreshness", {
        localConversationSourceFingerprint: async () => { await delay(5); return local; },
        lsConversationSourceFingerprint: async () => live,
        autoLsFingerprint: (actualLive: unknown, actualLocal: unknown) => {
            assert.equal(actualLive, live);
            assert.equal(actualLocal, local);
            return { revision: "synthetic-combined" };
        },
    });
    assert.deepEqual(await freshness("codex", "synthetic", "local", undefined), { fingerprint: local, buildSource: "local" });
    assert.deepEqual(await freshness("antigravity", "synthetic", "local", undefined), { fingerprint: local, buildSource: "local" });
    assert.deepEqual(await freshness("antigravity", "synthetic", "auto", undefined), {
        fingerprint: { revision: "synthetic-combined" }, buildSource: "auto",
    });
});
