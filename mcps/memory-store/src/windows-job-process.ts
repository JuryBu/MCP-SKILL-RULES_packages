import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sourcePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../native/windows-model-runner.cs");
const cacheRoot = path.join(os.tmpdir(), "memory-store-windows-job-runner");

export interface WindowsJobProcessOptions {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    deadlineAt?: number;
}

export interface WindowsJobProcessResult {
    exitCode: number | null;
    cancelled: boolean;
    childPid: number;
}

export class WindowsJobIncompleteError extends Error {
    readonly cleanupVerified = true;
    constructor(public readonly parentExitCode: number, public readonly childPid: number) {
        super("Windows Job parent exited while descendants remained; output is incomplete");
        this.name = "WindowsJobIncompleteError";
    }
}

export class WindowsJobLaunchInterruptedError extends Error {
    readonly launchMayHaveStarted = true;
    constructor(public readonly childPid: number | undefined, cause: unknown) {
        super("Windows Job launch outcome unconfirmed; child may already have started", { cause });
        this.name = "WindowsJobLaunchInterruptedError";
    }
}

export interface WindowsJobProcess {
    readonly stdin: ChildProcessWithoutNullStreams["stdin"];
    readonly stdout: ChildProcessWithoutNullStreams["stdout"];
    readonly stderr: ChildProcessWithoutNullStreams["stderr"];
    readonly childPid: number;
    readonly runnerPid: number;
    readonly completion: Promise<WindowsJobProcessResult>;
    terminate(): Promise<WindowsJobProcessResult>;
}

function assertTime(signal?: AbortSignal, deadlineAt?: number): void {
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Windows Job launch cancelled");
    if (deadlineAt !== undefined && Date.now() >= deadlineAt) throw new Error("Windows Job launch deadline exceeded");
}

function sleep(milliseconds: number, signal?: AbortSignal, deadlineAt?: number): Promise<void> {
    assertTime(signal, deadlineAt);
    const remaining = deadlineAt === undefined ? milliseconds : Math.min(milliseconds, Math.max(1, deadlineAt - Date.now()));
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, remaining);
        const abort = () => { clearTimeout(timer); reject(signal?.reason instanceof Error ? signal.reason : new Error("Windows Job launch cancelled")); };
        signal?.addEventListener("abort", abort, { once: true });
    });
}

async function sha256(filePath: string): Promise<string> {
    return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

async function verifiedRunner(executable: string, stamp: string): Promise<boolean> {
    try {
        const expected = (await readFile(stamp, "utf8")).trim();
        return /^[a-f0-9]{64}$/u.test(expected) && await sha256(executable) === expected;
    } catch { return false; }
}

function findCompiler(): string {
    const windowsRoot = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
    const candidates = ["Framework64", "Framework"].map(folder => path.join(windowsRoot, "Microsoft.NET", folder, "v4.0.30319", "csc.exe"));
    const compiler = candidates.find(candidate => existsSync(candidate));
    if (!compiler) throw new Error("Windows .NET Framework C# compiler unavailable");
    return compiler;
}

async function compileRunner(output: string, source: string, signal?: AbortSignal, deadlineAt?: number): Promise<void> {
    const compiler = findCompiler();
    const temporary = `${output}.${process.pid}.${randomUUID()}.tmp.exe`;
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const deadlineTimer = deadlineAt === undefined ? undefined : setTimeout(abort, Math.max(0, deadlineAt - Date.now()));
    try {
        assertTime(signal, deadlineAt);
        const compilerProcess = spawn(compiler, ["/nologo", "/target:exe", `/out:${temporary}`, source], {
            stdio: ["ignore", "pipe", "pipe"], windowsHide: true, signal: controller.signal,
        });
        let diagnostics = "";
        const collect = (chunk: Buffer) => { diagnostics = (diagnostics + chunk.toString("utf8")).slice(-2048); };
        compilerProcess.stdout?.on("data", collect);
        compilerProcess.stderr?.on("data", collect);
        const exitCode = await new Promise<number>((resolve, reject) => {
            compilerProcess.once("error", reject);
            compilerProcess.once("close", code => resolve(code ?? -1));
        });
        assertTime(signal, deadlineAt);
        if (exitCode !== 0) throw new Error(`Windows Job runner compile failed (${exitCode}): ${diagnostics}`);
        await rm(output, { force: true });
        await rename(temporary, output);
    } finally {
        if (deadlineTimer) clearTimeout(deadlineTimer);
        signal?.removeEventListener("abort", abort);
        await rm(temporary, { force: true });
    }
}

export async function ensureWindowsJobRunner(options: Pick<WindowsJobProcessOptions, "signal" | "deadlineAt"> = {}): Promise<string> {
    if (process.platform !== "win32") throw new Error("Windows Job Object requires Windows");
    const { signal } = options;
    const deadlineAt = options.deadlineAt ?? Date.now() + 30000;
    assertTime(signal, deadlineAt);
    const source = await readFile(sourcePath);
    const version = createHash("sha256").update("memory-store-windows-job-v1\n").update(source).digest("hex");
    const executable = path.join(cacheRoot, `runner-${version}.exe`);
    const stamp = `${executable}.sha256`;
    if (await verifiedRunner(executable, stamp)) return executable;
    await mkdir(cacheRoot, { recursive: true });
    const lockPath = `${executable}.lock`;
    let lock: Awaited<ReturnType<typeof open>> | undefined;
    while (!lock) {
        assertTime(signal, deadlineAt);
        try { lock = await open(lockPath, "wx"); }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            if (await verifiedRunner(executable, stamp)) return executable;
            await sleep(25, signal, deadlineAt);
        }
    }
    try {
        if (!await verifiedRunner(executable, stamp)) {
            await compileRunner(executable, sourcePath, signal, deadlineAt);
            const digest = await sha256(executable);
            const temporaryStamp = `${stamp}.${process.pid}.${randomUUID()}.tmp`;
            try {
                await writeFile(temporaryStamp, digest, { flag: "wx" });
                await rm(stamp, { force: true });
                await rename(temporaryStamp, stamp);
            } finally { await rm(temporaryStamp, { force: true }); }
        }
        return executable;
    } finally {
        await lock.close();
        await rm(lockPath, { force: true });
    }
}

async function status(statusPath: string): Promise<string | undefined> {
    try { return (await readFile(statusPath, "utf8")).trim(); }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
    }
}

export async function spawnWindowsJobProcess(command: string, args: string[], options: WindowsJobProcessOptions = {}): Promise<WindowsJobProcess> {
    const { signal, deadlineAt } = options;
    const launchDeadline = deadlineAt ?? Date.now() + 30000;
    assertTime(signal, launchDeadline);
    const runner = await ensureWindowsJobRunner({ signal, deadlineAt: launchDeadline });
    assertTime(signal, launchDeadline);
    const cwd = path.resolve(options.cwd ?? process.cwd());
    if (!(await stat(cwd)).isDirectory()) throw new Error("Windows Job working directory is not a directory");
    const runRoot = path.join(cacheRoot, `run-${process.pid}-${randomUUID()}`);
    await mkdir(runRoot);
    const statusPath = path.join(runRoot, "status");
    const cancelPath = path.join(runRoot, "cancel");
    const child = spawn(runner, [statusPath, cancelPath, cwd, String(process.pid), command, ...args], {
        cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: false,
    });
    let completed = false;
    let launchFinished = false;
    let completionRead = false;
    let childPid = 0;
    let spawnError: Error | undefined;
    let runnerSpawned = false;
    child.once("spawn", () => { runnerSpawned = true; });
    let streamDrainTimedOut = false;
    let drainTimer: NodeJS.Timeout | undefined;
    const completion = new Promise<WindowsJobProcessResult>((resolve, reject) => {
        child.once("error", error => { spawnError = error; });
        child.once("exit", () => {
            drainTimer = setTimeout(() => {
                streamDrainTimedOut = true;
                child.stdin.destroy();
                child.stdout.destroy();
                child.stderr.destroy();
            }, 2000);
        });
        child.once("close", async () => {
            completed = true;
            if (drainTimer) clearTimeout(drainTimer);
            try {
                const final = await status(statusPath);
                completionRead = true;
                if (launchFinished) await rm(runRoot, { recursive: true, force: true });
                if (spawnError) reject(spawnError);
                else if (streamDrainTimedOut) reject(new Error("Windows Job stdio did not drain after runner exit"));
                else if (/^exited:\d+$/u.test(final ?? "")) resolve({ exitCode: Number(final!.slice(7)), cancelled: false, childPid });
                else if (/^incomplete:\d+$/u.test(final ?? "")) reject(new WindowsJobIncompleteError(Number(final!.slice(11)), childPid));
                else if (/^cancelled:\d+$/u.test(final ?? "")) {
                    childPid = Number(final!.slice(10));
                    resolve({ exitCode: null, cancelled: true, childPid });
                }
                else reject(new Error(`Windows Job cleanup unverified: ${final?.startsWith("error:") ? final : "runner closed without final status"}`));
            } catch (error) { reject(error); }
        });
    });
    completion.catch(() => {});
    const terminate = async (): Promise<WindowsJobProcessResult> => {
        if (!completed) {
            try { await writeFile(cancelPath, "1"); }
            catch (error) { if (!completed || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        }
        return completion;
    };
    const abort = () => { void terminate().catch(() => {}); };
    signal?.addEventListener("abort", abort, { once: true });
    const deadlineTimer = deadlineAt === undefined ? undefined : setTimeout(abort, Math.max(0, deadlineAt - Date.now()));
    void completion.finally(() => {
        signal?.removeEventListener("abort", abort);
        if (deadlineTimer) clearTimeout(deadlineTimer);
    }).catch(() => {});
    try {
        while (true) {
            assertTime(signal, launchDeadline);
            const started = await status(statusPath + ".started");
            if (started?.startsWith("started:")) {
                childPid = Number(started.slice(8));
                break;
            }
            const current = await status(statusPath);
            if (current?.startsWith("error:") || current?.startsWith("cancelled:") || completed) throw new Error(`Windows Job launch failed: ${current ?? "runner closed"}`);
            await sleep(10, signal, launchDeadline);
        }
        assertTime(signal, launchDeadline);
        return { stdin: child.stdin, stdout: child.stdout, stderr: child.stderr, childPid, runnerPid: child.pid!, completion, terminate };
    } catch (error) {
        let cleanupError: unknown;
        const result = await terminate().catch(failure => { cleanupError = failure; return undefined; });
        const final = await status(statusPath).catch(() => undefined);
        if (runnerSpawned && !final?.startsWith("error:not-started:")) {
            throw new WindowsJobLaunchInterruptedError(result?.childPid || childPid || undefined, cleanupError ?? error);
        }
        throw error;
    } finally {
        launchFinished = true;
        if (completed && completionRead) await rm(runRoot, { recursive: true, force: true });
    }
}
