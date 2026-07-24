import fs from "fs";
import path from "path";
import { TEMP_DIR } from "../temp-store.js";

function configuredRuntimeTempRoot(): string | undefined {
    return process.env.SANDBOX_COUNCIL_ANTIGRAVITY_CLI_TEMP_DIR?.trim()
        || process.env.SANDBOX_COUNCIL_GEMINI_CLI_TEMP_DIR?.trim()
        || undefined;
}

const RUNTIME_TEMP_ROOT = path.resolve(configuredRuntimeTempRoot() || TEMP_DIR);

function isContainedPath(root: string, candidate: string): boolean {
    const relative = path.relative(root, candidate);
    return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function nearestExistingPath(target: string): string {
    let candidate = target;
    while (!fs.existsSync(candidate)) {
        const parent = path.dirname(candidate);
        if (parent === candidate) throw new Error(`无法解析 council 托管路径的现有父目录: ${target}`);
        candidate = parent;
    }
    return candidate;
}

function councilRootRealPath(): string {
    fs.mkdirSync(RUNTIME_TEMP_ROOT, { recursive: true });
    return fs.realpathSync(RUNTIME_TEMP_ROOT);
}

export function councilRuntimeTempRoot(): string {
    councilRootRealPath();
    return RUNTIME_TEMP_ROOT;
}

export function assertCouncilManagedPath(targetPath: string): string {
    const root = councilRootRealPath();
    const target = path.resolve(targetPath);
    if (!isContainedPath(root, target)) {
        throw new Error(`council 托管路径越出稳定根: ${target}`);
    }
    const ancestor = fs.realpathSync(nearestExistingPath(target));
    if (!isContainedPath(root, ancestor)) {
        throw new Error(`council 托管路径经 realpath 越出稳定根: ${target}`);
    }
    return target;
}

export function ensureCouncilManagedDirectory(targetPath: string): string {
    const target = assertCouncilManagedPath(targetPath);
    fs.mkdirSync(target, { recursive: true });
    const root = councilRootRealPath();
    const realTarget = fs.realpathSync(target);
    if (!isContainedPath(root, realTarget)) {
        throw new Error(`council 托管目录经 realpath 越出稳定根: ${target}`);
    }
    return target;
}

export function councilRuntimeDirectory(name: string): string {
    return ensureCouncilManagedDirectory(path.join(councilRuntimeTempRoot(), name));
}

export function relativeCouncilManagedPath(targetPath: string): string {
    const target = assertCouncilManagedPath(targetPath);
    return path.relative(councilRuntimeTempRoot(), target).split(path.sep).join("/");
}
