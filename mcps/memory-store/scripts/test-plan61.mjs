import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const group = process.argv.find(argument => argument.startsWith("--group="))?.slice(8) || "all";
if (!["all", "summary", "conversation"].includes(group)) throw new Error("Use --group=all|summary|conversation");
let tests = [
    "auto-summary-validation", "auto-summary-model-bridge", "auto-summary-stale-write",
    "auto-summary-repair", "auto-summary-locks", "auto-summary-tools", "auto-summary-root-fixes", "auto-summary-lock-publication", "auto-summary-independent-review",
    "conversation-corpus-multi-provider", "conversation-corpus-multi-source", "conversation-corpus-verified-alias", "conversation-corpus-tool",
    "conversation-corpus-search", "conversation-corpus-task", "conversation-corpus-task-store",
    "conversation-corpus-preparation", "conversation-corpus-prefetch", "conversation-corpus-batch-publish",
    "conversation-corpus-task-performance", "conversation-corpus-replica-inventory",
    "conversation-progressive-cache", "conversation-progressive-projection", "conversation-progressive-task",
    "conversation-progressive-sdk", "conversation-progressive-hosts", "conversation-progressive-hosts-adversarial",
    "conversation-progressive-state-write", "conversation-host-range-input", "conversation-host-adapter",
    "conversation-host-cache", "conversation-host-cold-window", "conversation-host-full-cache", "conversation-host-progressive-cold",
    "claude-code-corpus", "claude-code-client-tail-read", "dsh-incremental-reader", "dsh-session-reader", "dsh-client",
    "conversation-host-binary", "conversation-host-devin", "devin-sqlite", "devin-identity-scan", "devin-fast-range",
    "devin-conversation", "devin-bridge", "devin-consumers", "devin-identity-cache-bridge", "devin-legacy-isolation",
    "devin-discovery-offline", "conversation-source-fingerprint", "local-pb-prepared", "local-pb-reader",
    "local-pb-activity-bridge", "windsurf-read-timing", "windsurf-read-partial-empty", "conversation-context-locate",
].filter(name => group === "all" || (group === "summary") === name.startsWith("auto-summary-")).map(name => `tests/${name}.test.ts`);
const startFrom = process.argv.find(argument => argument.startsWith("--start-from="))?.slice(13);
if (startFrom) {
    const offset = tests.indexOf(`tests/${startFrom}.test.ts`);
    if (offset < 0) throw new Error("Unknown test in the selected group: " + startFrom);
    tests = tests.slice(offset);
}
for (const test of tests) if (!fs.existsSync(path.join(root, test))) throw new Error(`Missing regression input: ${test}`);
const started = performance.now();
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-plan61-regression-"));
let completed = 0;
try {
for (const test of tests) {
    const began = performance.now();
    console.log(`PLAN61_START ${test}`);
    const result = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ["--import", "tsx", test], { cwd: root,
            env: { ...process.env, MEMORY_STORE_DATA_ROOT: path.join(temporary, path.basename(test)), MEMORY_STORE_AUTO_RECORD: "0" },
            stdio: "inherit", windowsHide: true });
        child.once("error", reject);
        child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    console.log(JSON.stringify({ test, elapsedMs: Math.round(performance.now() - began), ...result }));
    if (result.code !== 0) { process.exitCode = 1; break; }
    completed++;
}
console.log(JSON.stringify({ totalFiles: tests.length, completedFiles: completed, elapsedMs: Math.round(performance.now() - started), success: completed === tests.length }));
} finally { fs.rmSync(temporary, { recursive: true, force: true }); }
