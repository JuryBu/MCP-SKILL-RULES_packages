import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { writeHostCache, readHostCache } from "../src/conversation-host-files.ts";

const root = await mkdtemp(path.join(os.tmpdir(), "plan61-cold-window-cache-"));
const filename = path.join(root, "cache.json");
const digest = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
const nativeStringify = JSON.stringify;
const nativeEnvelope = (value: unknown) => {
    const payload = nativeStringify(value);
    return nativeStringify({ format: "host-file-cache/v1", sha256: digest(payload), payload: value });
};
let cases = 0;
const compare = async (value: unknown) => {
    const expected = nativeEnvelope(value);
    assert.equal(await writeHostCache(filename, value, Buffer.byteLength(expected)), true);
    const actual = await readFile(filename);
    assert.deepEqual(actual, Buffer.from(expected));
    assert.equal(digest(actual), digest(expected));
    const envelope = JSON.parse(expected);
    const payload = envelope.payload;
    assert.deepEqual(await readHostCache(filename, actual.length), digest(nativeStringify(payload)) === envelope.sha256 ? payload : null);
    assert.equal(await writeHostCache(filename, value, actual.length - 1), false);
    assert.deepEqual(await readFile(filename), actual);
    assert.equal(await readHostCache(filename, actual.length - 1), null);
    cases++;
};

try {
    const withFunctionJson = Object.assign(() => undefined, { toJSON: (key: string) => `function:${key}` });
    const inherited = Object.assign(Object.create({ inherited: 1 }), { visible: 2 });
    Object.defineProperty(inherited, "hidden", { value: 3 });
    const shared = { content: "shared" };
    const objects = [
        null, true, false, 0, -0, NaN, Infinity, -Infinity, "", "引号\"反斜杠\\\b\f\n\r\t\u0000🚀\ud800\udfff",
        { b: 1, "10": 10, "2": 2, a: undefined, fn: () => 1, symbol: Symbol("omit"), null: null },
        [undefined, , () => 1, Symbol("null"), NaN, -0], inherited, { first: shared, second: shared },
        new Number(2), new String("wrapped🚀"), new Boolean(false), Object(Symbol("empty")),
        { date: new Date("2026-11-02T00:00:00Z"), invalid: new Date(NaN), value: { toJSON: (key: string) => ({ key, nested: true }) }, fn: withFunctionJson },
        [withFunctionJson, { toJSON: (key: string) => key }], withFunctionJson,
        vm.runInNewContext('({ number: new Number(9), string: new String("realm"), boolean: new Boolean(true) })'),
    ];
    for (const value of objects) await compare(value);
    for (let index = 0; index < 64; index++) await compare({ index, content: "x".repeat(index * 997) + "🚀" + "\ud800\u0000\n".repeat(index), list: [index, undefined, { [`key-${index}`]: -index / 3 }] });

    const long = "x".repeat(16 * 1024 - 1) + "🚀" + ("文🚀\ud800\udfff\"\\\n".repeat(512 * 1024));
    const expected = nativeEnvelope({ long });
    let maxString = 0;
    let wholeObjects = 0;
    JSON.stringify = ((value: unknown, ...args: unknown[]) => {
        if (typeof value === "string") maxString = Math.max(maxString, value.length);
        else if (value && typeof value === "object") wholeObjects++;
        return Reflect.apply(nativeStringify, JSON, [value, ...args]);
    }) as typeof JSON.stringify;
    try {
        assert.equal(await writeHostCache(filename, { long }, 64 * 1024 * 1024), true);
        assert.equal(await readHostCache<{ long: string }>(filename, 64 * 1024 * 1024).then(value => value?.long), long);
    } finally { JSON.stringify = nativeStringify; }
    assert.ok(maxString <= 16 * 1024);
    assert.equal(wholeObjects, 0);
    assert.deepEqual(await readFile(filename), Buffer.from(expected));

    const extensions = JSON as typeof JSON & { rawJSON?: (text: string) => unknown };
    let rawCases = 0;
    if (extensions.rawJSON) {
        for (const offset of [0, 1, 2, 3, 17, 97]) {
            const rawText = nativeStringify("x".repeat(16 * 1024 - 2 + offset) + "🚀" + "y".repeat(64 * 1024) + "🌸");
            await compare({ padding: "p".repeat(offset), raw: extensions.rawJSON(rawText) });
            rawCases++;
        }
    }
    const old = nativeEnvelope({ preserved: "old-value" });
    await writeFile(filename, old);
    assert.deepEqual(await readHostCache(filename, 1024), { preserved: "old-value" });
    let checks = 0;
    await assert.rejects(writeHostCache(filename, { long }, 64 * 1024 * 1024, () => ++checks > 25), error => (error as Error).name === "AbortError");
    assert.equal(await readFile(filename, "utf8"), old);
    let serializationPass = 0;
    let writeChecks = 0;
    const cancelDuringWrite = { toJSON: () => { serializationPass++; return { long }; } };
    await assert.rejects(writeHostCache(filename, cancelDuringWrite, 64 * 1024 * 1024,
        () => serializationPass >= 2 && ++writeChecks > 35), error => (error as Error).name === "AbortError");
    assert.equal(serializationPass, 2);
    assert.ok(writeChecks > 35);
    assert.equal(await readFile(filename, "utf8"), old);
    await assert.rejects(writeHostCache(filename, { toJSON: (key: string) => {
        if (key === "payload") throw new Error("second-pass failure");
        return { body: "valid-first-pass" };
    } }, 1024), /second-pass failure/u);
    assert.equal(await readFile(filename, "utf8"), old);
    const budgetValue = { huge: long, get unreached() { throw new Error("budget must stop before later getter"); } };
    assert.equal(await writeHostCache(filename, budgetValue, 1024), false);
    assert.equal(await readFile(filename, "utf8"), old);
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    for (const value of [1n, Object(2n), cycle, undefined, Symbol("root"), () => 1]) {
        await assert.rejects(writeHostCache(filename, value, 1024 * 1024), TypeError);
        assert.equal(await readFile(filename, "utf8"), old);
    }
    const throwing = { get value(): unknown { throw new Error("getter failure"); } };
    await assert.rejects(writeHostCache(filename, throwing, 1024), /getter failure/u);
    assert.equal(await readFile(filename, "utf8"), old);
    const bigPrototype = BigInt.prototype as BigInt & { toJSON?: (key: string) => string };
    const originalToJSON = bigPrototype.toJSON;
    try {
        bigPrototype.toJSON = function (key: string) { return `${String(this)}:${key}`; };
        await compare({ integer: 123n });
    } finally {
        if (originalToJSON) bigPrototype.toJSON = originalToJSON;
        else delete bigPrototype.toJSON;
    }
    await writeFile(filename, old.replace("old-value", "bad-value"));
    assert.equal(await readHostCache(filename, 1024), null);
    await writeFile(filename, "{");
    assert.equal(await readHostCache(filename, 1024), null);
    await assert.rejects(readHostCache(root, 1024 * 1024));
    assert.deepEqual((await readdir(root)).filter(name => name.endsWith(".tmp")), []);
    console.log(JSON.stringify({ test: "host-cache-bounded-json", cases, rawCases, longChars: long.length, maxNativeStringifyChars: maxString, wholeObjectStringifyCalls: wholeObjects,
        checks: "native-bytes+sha/old-format/budget/exact-limit/cancel/old-value/undefined/array/toJSON/boxed/cycle/BigInt/surrogate/raw-surrogate/corruption/io-errors", peakRssBytes: process.resourceUsage().maxRSS * 1024 }));
} finally {
    JSON.stringify = nativeStringify;
    await rm(root, { recursive: true, force: true });
}
