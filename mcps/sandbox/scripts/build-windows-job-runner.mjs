import { mkdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") process.exit(0);

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(packageRoot, "native", "windows-job-runner.cs");
const output = join(packageRoot, "dist", "native", "windows-job-runner.exe");
const frameworkRoot = process.env.WINDIR || "C:\\Windows";
const compiler = join(frameworkRoot, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");

mkdirSync(dirname(output), { recursive: true });
const result = spawnSync(compiler, [
    "/nologo",
    "/optimize+",
    "/platform:x64",
    "/target:exe",
    `/out:${output}`,
    source,
], { stdio: "inherit", windowsHide: true });

if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
if (statSync(output).size < 4096) throw new Error("windows-job-runner.exe build output is unexpectedly small");
