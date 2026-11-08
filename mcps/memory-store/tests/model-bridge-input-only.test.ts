import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-input-only-test-"));
const script = path.join(root, "fixture.cjs");
const launcher = path.join(root, process.platform === "win32" ? "fixture.cmd" : "fixture.sh");
const capture = path.join(root, "arguments.json");
const originalEnvironment = Object.fromEntries(["MEMORY_STORE_DATA_ROOT", "MEMORY_STORE_CODEX_COMMAND", "INPUT_ONLY_ARGUMENTS"].map(name => [name, process.env[name]]));
process.env.MEMORY_STORE_DATA_ROOT = path.join(root, "data");
process.env.MEMORY_STORE_CODEX_COMMAND = launcher;
process.env.INPUT_ONLY_ARGUMENTS = capture;
fs.writeFileSync(script, `const fs = require("node:fs");
const args = process.argv.slice(2);
fs.writeFileSync(process.env.INPUT_ONLY_ARGUMENTS, JSON.stringify({ args, cwd: process.cwd() }));
fs.writeFileSync(args[args.indexOf("-o") + 1], "fixture summary");
console.log(JSON.stringify({ type: "item.completed", item: { id: "fixture", type: "agent_message", text: "fixture summary" } }));
`, "utf8");
fs.writeFileSync(launcher, process.platform === "win32"
    ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`
    : `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { encoding: "utf8", mode: 0o755 });

try {
    const { callCodexExec } = await import("../src/model-bridge.ts");
    const ordinary = await callCodexExec("supplied fixture text", "gpt-6.1-sol", 10_000);
    assert.equal(ordinary.text, "fixture summary");
    const ordinaryCapture = JSON.parse(fs.readFileSync(capture, "utf8"));
    assert.equal(path.resolve(ordinaryCapture.cwd), process.cwd());
    assert.equal(ordinaryCapture.args.includes("shell_tool"), false);

    const limited = await callCodexExec("supplied fixture text", "gpt-6.1-sol", 10_000, undefined, { inputOnly: true });
    assert.equal(limited.text, "fixture summary");
    const limitedCapture = JSON.parse(fs.readFileSync(capture, "utf8"));
    for (const feature of ["shell_tool", "unified_exec", "apps", "view_image", "code_mode_host", "browser_use", "computer_use", "plugins"]) {
        const featureIndex = limitedCapture.args.indexOf(feature);
        assert.ok(featureIndex > 0);
        assert.equal(limitedCapture.args[featureIndex - 1], "--disable");
    }
    for (const setting of ["agents.enabled=false", "web_search=disabled", "mcp_servers={}", "project_doc_max_bytes=0"]) {
        const settingIndex = limitedCapture.args.indexOf(setting);
        assert.ok(settingIndex > 0);
        assert.equal(limitedCapture.args[settingIndex - 1], "-c");
    }
    assert.equal(path.resolve(limitedCapture.cwd), path.resolve(limitedCapture.args[limitedCapture.args.indexOf("-C") + 1]));
    assert.equal(path.dirname(path.resolve(limitedCapture.cwd)), path.resolve(os.tmpdir()));
    assert.match(path.basename(limitedCapture.cwd), /^memory-store-summary-input-/u);
    assert.equal(fs.existsSync(limitedCapture.cwd), false);
    assert.equal(limited.codexDiagnostics?.commandCount, 0);
    assert.equal(limited.codexDiagnostics?.rejectedCommandCount, 0);
    console.log("input-only invocation limits and empty working directory verified; ordinary invocation unchanged");
} finally {
    for (const [name, value] of Object.entries(originalEnvironment)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
}
