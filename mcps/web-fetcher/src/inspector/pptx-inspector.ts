import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import type { InspectResult, PageStructure, Rect } from "./types.js";

type PptxAction = "extract_structure" | "detect_issues" | "search_text_region";

export interface PptxInspectorRequest {
    action: PptxAction;
    pptxPath: string;
    page?: number | "all" | null;
    checks?: string[];
    target?: string;
    thresholds?: PptxInspectorThresholds;
}

export interface PptxInspectorThresholds {
    smallFontPt?: number;
    titleTopVarianceEmu?: number;
    sizeVarianceRatio?: number;
    gapVarianceRatio?: number;
}

export interface PptxTextRegionResult {
    found: boolean;
    target: string;
    page: number | null;
    rect: Rect | null;
    matches: number;
    elements: string[];
    dimensions: {
        width: number;
        height: number;
        unit: "EMU";
    };
}

const PYTHON_TIMEOUT_MS = 30_000;

function scriptPath(): string {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const candidates = [
        path.join(here, "pptx_inspector.py"),
        path.join(here, "..", "..", "src", "inspector", "pptx_inspector.py"),
        path.join(process.cwd(), "src", "inspector", "pptx_inspector.py"),
    ];

    const found = candidates.find(candidate => fs.existsSync(candidate));
    if (!found) {
        throw new Error(`未找到 PPTX inspector 脚本: ${candidates.join(", ")}`);
    }
    return found;
}

function pythonCommand(): string {
    return process.env.WEB_FETCHER_PYTHON || "python";
}

export function localPptxPathFromUrl(url: string): string {
    if (url.startsWith("file://")) {
        return fileURLToPath(url);
    }
    throw new Error(`PPTX 路线目前需要 file:// 本地文件 URL，收到: ${url}`);
}

export async function callPptxInspector<T>(request: PptxInspectorRequest, timeoutMs = PYTHON_TIMEOUT_MS): Promise<T> {
    const child = spawn(pythonCommand(), [scriptPath()], {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
        child.kill();
    }, timeoutMs);
    timer.unref();

    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", chunk => {
        stdout += chunk;
    });
    child.stderr.on("data", chunk => {
        stderr += chunk;
    });

    const exit = new Promise<number | null>((resolve, reject) => {
        child.on("error", reject);
        child.on("close", code => resolve(code));
    });

    child.stdin.write(JSON.stringify(request), "utf-8");
    child.stdin.end();

    const code = await exit;
    clearTimeout(timer);

    if (code !== 0) {
        throw new Error(`PPTX inspector 退出码 ${code}: ${stderr || stdout}`);
    }

    try {
        const parsed = JSON.parse(stdout);
        if (parsed && parsed.ok === false) {
            throw new Error(parsed.error?.message || parsed.error || "PPTX inspector 返回失败");
        }
        return (parsed.result ?? parsed) as T;
    } catch (error) {
        if (error instanceof SyntaxError) {
            throw new Error(`PPTX inspector 输出不是合法 JSON: ${stdout.slice(0, 500)} ${stderr ? `stderr=${stderr}` : ""}`);
        }
        throw error;
    }
}

export async function searchPptxTextRegion(
    pptxPath: string,
    target: string,
    page: number | null,
): Promise<PptxTextRegionResult> {
    return await callPptxInspector<PptxTextRegionResult>({
        action: "search_text_region",
        pptxPath,
        page,
        target,
    });
}

export async function extractPptxStructure(pptxPath: string, page: number | "all" | null): Promise<PageStructure[]> {
    return await callPptxInspector<PageStructure[]>({
        action: "extract_structure",
        pptxPath,
        page: page === "all" ? null : page,
    });
}

export async function detectPptxIssues(
    pptxPath: string,
    page: number | "all" | null,
    checks: string[],
    thresholds?: PptxInspectorThresholds,
): Promise<InspectResult> {
    return await callPptxInspector<InspectResult>({
        action: "detect_issues",
        pptxPath,
        page: page === "all" ? null : page,
        checks,
        thresholds,
    });
}
