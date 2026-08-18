import fs from "node:fs";
import { spawn } from "node:child_process";

const DESCENDANT_MODE = "__agy_ignore_term_descendant__";

const args = process.argv.slice(2);
const modelIndex = args.indexOf("--model");
const model = modelIndex >= 0 ? args[modelIndex + 1] : "";
const promptIndex = args.indexOf("-p");
const mode = process.env.FAKE_AGY_MODE || "success";
const delayMs = Math.max(0, Number(process.env.FAKE_AGY_DELAY_MS || 250));
const prompt = promptIndex >= 0 ? args[promptIndex + 1] || "" : "";

function writeLog() {
    if (!process.env.FAKE_AGY_LOG) return;
    fs.appendFileSync(process.env.FAKE_AGY_LOG, `${JSON.stringify({ args, model, prompt, startedAt: Date.now() })}\n`, "utf8");
}

function succeed() {
    process.stdout.write(`ok:${model}:${Buffer.byteLength(prompt, "utf8")}`);
}

function fail(message, code = 1, partial = "") {
    if (partial) process.stdout.write(partial);
    process.stderr.write(message);
    process.exitCode = code;
}

function keepAliveIgnoringTerm() {
    process.on("SIGTERM", () => {});
    setInterval(() => {}, 1000);
}

function main() {
    writeLog();
    if (promptIndex < 0) {
        fail("missing -p prompt", 64);
        return;
    }
    if (mode === "fallback") {
        if (model === "Gemini 3.5 Flash (High)") fail("rate limit", 29, "partial high output");
        else succeed();
        return;
    }
    if (mode === "fail-all") {
        fail(`invalid model ${model}`, 2);
        return;
    }
    if (mode === "partial-failure") {
        fail("rate limit", 17, "partial response");
        return;
    }
    if (mode === "empty") return;
    if (mode === "overflow") {
        process.stdout.write("x".repeat(4096));
        setTimeout(() => process.exit(0), delayMs);
        return;
    }
    if (mode === "dual-overflow") {
        process.stdout.write("o".repeat(40));
        process.stderr.write("e".repeat(40));
        setTimeout(() => process.exit(0), delayMs);
        return;
    }
    if (mode === "ignore-term-tree") {
        process.on("SIGTERM", () => {});
        const descendant = spawn(process.execPath, [process.argv[1], DESCENDANT_MODE], { stdio: "ignore" });
        if (process.env.FAKE_AGY_DESCENDANT_PID && descendant.pid) {
            fs.writeFileSync(process.env.FAKE_AGY_DESCENDANT_PID, String(descendant.pid), "utf8");
        }
        setInterval(() => {}, 1000);
        return;
    }
    if (mode === "delay") {
        setTimeout(succeed, delayMs);
        return;
    }
    succeed();
}

if (process.argv[2] === DESCENDANT_MODE) keepAliveIgnoringTerm();
else main();
