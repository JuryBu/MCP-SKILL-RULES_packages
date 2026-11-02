import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { writeProgressiveState } from "../src/conversation-progressive-task.js";

test("state replacement retries transient sharing failures without losing the previous state", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "memory-state-write-test-"));
    const filename = path.join(directory, "state.json");
    const rename = fs.rename;
    await fs.writeFile(filename, JSON.stringify({ value: "previous" }));
    let attempts = 0;
    fs.rename = async (source, target) => {
        attempts++;
        if (attempts <= 2) {
            assert.deepEqual(JSON.parse(await fs.readFile(filename, "utf8")), { value: "previous" });
            throw Object.assign(new Error("temporary sharing violation"), { code: attempts === 1 ? "EPERM" : "EBUSY" });
        }
        return rename(source, target);
    };
    try {
        await writeProgressiveState(filename, { value: "new" });
        assert.equal(attempts, 3);
        assert.deepEqual(JSON.parse(await fs.readFile(filename, "utf8")), { value: "new" });
        assert.deepEqual(await fs.readdir(directory), ["state.json"]);
    } finally {
        fs.rename = rename;
        assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
        assert.ok(path.basename(directory).startsWith("memory-state-write-test-"));
        await fs.rm(directory, { recursive: true, force: true });
    }
});
