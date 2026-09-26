import fs from "node:fs";

const args = process.argv.slice(2);
const help = args.includes("--help");
const modelIndex = args.indexOf("--model");
const model = modelIndex < 0 ? "" : args[modelIndex + 1];
if (process.env.FAKE_AGY_LOG) {
    fs.appendFileSync(process.env.FAKE_AGY_LOG, `${JSON.stringify({ help, model, pid: process.pid })}\n`, "utf8");
}
if (help) {
    setTimeout(() => console.log("fake agy help"), Number(process.env.FAKE_AGY_HELP_DELAY_MS || 0));
} else if (process.env.FAKE_AGY_MODE === "fallback" && model === "Gemini 3.8 Flash (High)") {
    console.error("rate limit");
    process.exitCode = 29;
} else {
    setTimeout(() => console.log("fake answer"), Number(process.env.FAKE_AGY_CALL_DELAY_MS || 0));
}
