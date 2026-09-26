import fs from "node:fs";
import path from "node:path";
import { spawnWindowsJobProcess } from "../../src/windows-job-process.js";

const pidFile = process.argv[2];
const receiptFile = process.argv[3];
const fixture = path.resolve("tests/fixtures/windows-job-fake.mjs");
const job = await spawnWindowsJobProcess(process.execPath, [fixture, "cancel", pidFile], {
    deadlineAt: Date.now() + 10000,
});
for (let attempt = 0; attempt < 200 && !fs.existsSync(pidFile); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 10));
}
if (!fs.existsSync(pidFile)) throw new Error("descendant never started");
fs.writeFileSync(receiptFile, JSON.stringify({ runnerPid: job.runnerPid, parentPid: job.childPid, descendantPid: Number(fs.readFileSync(pidFile, "utf8")) }));
process.exit(0);
