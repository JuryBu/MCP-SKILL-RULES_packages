import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { after, test } from "node:test";

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-python-encoding-"));
process.env.SANDBOX_DATA_ROOT = dataRoot;
const { saveTempScript, removeTempFile } = await import("../mcps/sandbox/dist/temp-store.js");
const bom = Buffer.from([0xef, 0xbb, 0xbf]);
const cases = [
    { name: "plain Unicode", code: "message = '中文'\nprint(message)", addBom: true },
    { name: "ASCII source", code: "print('ok')", addBom: true },
    { name: "shebang", code: "#!/usr/bin/env python3\nprint('中文')", addBom: true },
    { name: "existing BOM", code: "\uFEFFprint('中文')", addBom: false },
    { name: "first-line UTF-8 cookie", code: "# coding: utf-8\nprint('中文')", addBom: false },
    { name: "second-line UTF-8 cookie", code: "#!/usr/bin/env python3\n# coding=utf-8\nprint('中文')", addBom: false },
    { name: "blank first line", code: "\n# coding: utf-8\nprint('中文')", addBom: false },
    { name: "explicit Latin-1 cookie", code: "# coding: latin-1\nprint('ok')", addBom: false },
    { name: "CRLF cookie", code: "# header\r\n# coding: utf-8\r\nprint('中文')", addBom: false },
    { name: "Unicode line separator in encoding comment", code: "# note\u2028 coding: latin-1\nprint('ok')", addBom: false },
    { name: "Unicode paragraph separator in encoding comment", code: "# note\u2029 coding: latin-1\nprint('ok')", addBom: false },
    { name: "cookie after executable line is inactive", code: "print('中文')\n# coding: latin-1", addBom: true },
    { name: "cookie-like string is inactive", code: "value = '# coding: latin-1'\nprint('中文')", addBom: true },
    { name: "third-line cookie is inactive", code: "# first\n# second\n# coding: latin-1\nprint('中文')", addBom: true },
];

for (const scenario of cases) {
    test(`Python source bytes: ${scenario.name}`, () => {
        const filePath = saveTempScript("python", scenario.code);
        try {
            const expected = scenario.addBom
                ? Buffer.concat([bom, Buffer.from(scenario.code, "utf8")])
                : Buffer.from(scenario.code, "utf8");
            assert.deepEqual(fs.readFileSync(filePath), expected);
        } finally {
            removeTempFile(filePath);
        }
    });
}

test("other language bytes retain their existing encoding", () => {
    for (const language of ["node", "cmd", "bash", "powershell"]) {
        const code = "中文 text";
        const filePath = saveTempScript(language, code);
        try {
            const expected = language === "powershell"
                ? Buffer.concat([bom, Buffer.from(code, "utf8")])
                : Buffer.from(code, "utf8");
            assert.deepEqual(fs.readFileSync(filePath), expected);
        } finally {
            removeTempFile(filePath);
        }
    }
});

function executePython(code) {
    const filePath = saveTempScript("python", code);
    try {
        const result = spawnSync(process.env.SANDBOX_TEST_PYTHON || "python", ["-u", filePath], {
            encoding: "utf8",
            env: { ...process.env, PYTHONIOENCODING: "utf-8" },
            timeout: 10000,
            windowsHide: true,
        });
        assert.equal(result.error, undefined);
        return result;
    } finally {
        removeTempFile(filePath);
    }
}

test("actual Python executes a long Chinese line without caller encoding changes", () => {
    const expected = "中文提示词".repeat(256);
    const result = executePython(`expected = ${JSON.stringify(expected)}\nprint(expected)`);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trimEnd(), expected);
});

test("actual Python preserves future imports and source line numbers", () => {
    const success = executePython("#!/usr/bin/env python3\nfrom __future__ import annotations\nprint('中文')");
    assert.equal(success.status, 0, success.stderr);
    assert.equal(success.stdout.trimEnd(), "中文");
    const failure = executePython("value = '中文'\nvalue += '测试'\nraise RuntimeError('encoding-line-marker')");
    assert.equal(failure.status, 1);
    assert.match(failure.stderr, /line 3/);
    assert.match(failure.stderr, /RuntimeError: encoding-line-marker/);
});

after(() => {
    fs.rmSync(dataRoot, { recursive: true, force: true });
});
