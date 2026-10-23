import assert from "node:assert/strict";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assertCodexHistorySourceAsync, resolveCodexHistorySourceAsync } from "../src/codex-history-source.ts";

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "codex-pinned-append-"));
const thread = "11111111-1111-4111-8111-111111111111";
const rollout = "22222222-2222-4222-8222-222222222222";
const parent = path.join(temporary, `rollout-2026-01-01T00-00-00-${thread}.jsonl`);
const leaf = path.join(temporary, `rollout-2026-01-02T00-00-00-${thread}_${rollout}.jsonl`);
const encode = (events: unknown[]) => events.map(event => JSON.stringify(event)).join("\n") + "\n";
const body = (text: string) => ({ type: "event_msg", payload: { type: "user_message", message: text } });
const parentText = encode([{ type: "session_meta", payload: { id: thread } }, body("parent prefix")]);
const leafText = encode([{ type: "session_meta", payload: { id: thread, history_base: { thread_id: thread, end_ordinal_exclusive: 2, end_byte_offset: Buffer.byteLength(parentText) } } }, body("leaf prefix")]);
const originalStat = fsPromises.stat;

async function duringValidation(mutate: () => void, expected?: RegExp): Promise<void> {
    fs.writeFileSync(parent, parentText);
    fs.writeFileSync(leaf, leafText);
    const source = structuredClone(await resolveCodexHistorySourceAsync(leaf, { roots: [temporary] }));
    let leafStats = 0;
    let mutated = false;
    fsPromises.stat = (async (...parameters: Parameters<typeof fsPromises.stat>) => {
        if (path.resolve(String(parameters[0])) === leaf && parameters[1] === undefined && ++leafStats === 2) {
            mutate();
            mutated = true;
        }
        return originalStat.apply(fsPromises, parameters);
    }) as typeof fsPromises.stat;
    try {
        if (expected) await assert.rejects(() => assertCodexHistorySourceAsync(source), expected);
        else await assertCodexHistorySourceAsync(source);
        assert.equal(mutated, true, "the physical source changed inside the validation window");
    } finally {
        fsPromises.stat = originalStat;
    }
}

try {
    await duringValidation(() => fs.appendFileSync(leaf, encode([body("new unadopted append")])));
    await duringValidation(() => {
        fs.writeFileSync(leaf, leafText.replace("leaf prefix", "evil prefix") + encode([body("append alongside rewrite")]));
    }, /content changed|boundary changed/u);
    await duringValidation(() => fs.appendFileSync(parent, encode([body("ancestor changed during validation")])), /changed during source validation/u);
    console.log("codex pinned append: PASS fresh prefix revalidation, rewrite refusal, ancestor identity refusal");
} finally {
    fsPromises.stat = originalStat;
    fs.rmSync(temporary, { recursive: true });
}
