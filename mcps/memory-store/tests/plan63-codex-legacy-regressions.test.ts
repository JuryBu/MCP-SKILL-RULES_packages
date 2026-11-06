import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "p63cr-")));
const repository = fileURLToPath(new URL("..", import.meta.url));
const files = ["codex-deep-locate.test.ts", "codex-client.test.ts", "codex-compressed-path-client.test.ts", "codex-history-source.test.ts", "codex-history-integrity.test.ts"];

for (const [index, file] of files.entries()) {
    test(`isolated existing regression: ${file}`, () => {
        const home = path.join(root, String(index));
        fs.mkdirSync(home, { recursive: true });
        const temporary = path.join(home, "temp");
        fs.mkdirSync(temporary);
        const env = { ...process.env, HOME: home, USERPROFILE: home, TEMP: temporary, TMP: temporary,
            MEMORY_STORE_DATA_ROOT: path.join(home, "data") };
        const identity = spawnSync(process.execPath, ["--input-type=module", "-e", "import os from 'node:os'; process.stdout.write(os.homedir());"], {
            cwd: repository, env, encoding: "utf8", timeout: 10000,
        });
        assert.equal(identity.status, 0, identity.stderr);
        assert.equal(path.resolve(identity.stdout), home);
        const started = performance.now();
        const result = spawnSync(process.execPath, ["--import", "tsx", path.join("tests", file)], {
            cwd: repository, env, encoding: "utf8", timeout: 60000, maxBuffer: 1024 * 1024,
        });
        console.log(`PLAN63_EXISTING ${file} durationMs=${performance.now() - started} status=${result.status}`);
        if (result.stdout) console.log(result.stdout.trim());
        if (result.stderr) console.log(result.stderr.trim());
        assert.ifError(result.error);
        assert.equal(result.status, 0, result.stderr || result.stdout);
    });
}

after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    console.log("CLEANED_PLAN63_CODEX_REGRESSION_HOMES");
});
