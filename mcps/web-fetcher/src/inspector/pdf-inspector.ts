import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { convertToPDF } from "../converter.js";
import type { InspectResult, PageStructure, Rect } from "./types.js";

type PdfAction = "extract_structure" | "detect_issues" | "region_screenshot" | "search_text_region";

export interface PdfInspectorRequest {
    action: PdfAction;
    pdfPath: string;
    page?: number | "all" | null;
    checks?: string[];
    autoScreenshot?: boolean;
    scale?: number;
    rect?: Rect;
    target?: string;
    outputPath?: string;
    thresholds?: PdfInspectorThresholds;
}

export interface PdfInspectorThresholds {
    smallFontPt?: number;
}

export interface PdfRegionScreenshotResult {
    outputPath?: string;
    path?: string;
    page: number;
    rect: Rect;
    scale: number;
    width?: number;
    height?: number;
}

export interface PdfTextRegionResult {
    found: boolean;
    target: string;
    page: number | null;
    rect: Rect | null;
    matches: number;
}

const PYTHON_TIMEOUT_MS = 30_000;

function scriptPath(): string {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const candidates = [
        path.join(here, "pdf_inspector.py"),
        path.join(here, "..", "..", "src", "inspector", "pdf_inspector.py"),
        path.join(process.cwd(), "src", "inspector", "pdf_inspector.py"),
    ];

    const found = candidates.find(candidate => fs.existsSync(candidate));
    if (!found) {
        throw new Error(`未找到 PDF inspector 脚本: ${candidates.join(", ")}`);
    }
    return found;
}

function pythonCommand(): string {
    return process.env.WEB_FETCHER_PYTHON || "python";
}

export function localPathFromUrl(url: string): string {
    if (url.startsWith("file://")) {
        return fileURLToPath(url);
    }
    throw new Error(`PDF 路线目前需要 file:// 本地文件 URL，收到: ${url}`);
}

export async function resolvePdfPathFromUrl(url: string): Promise<string> {
    const localPath = localPathFromUrl(url);
    if (!fs.existsSync(localPath)) {
        throw new Error(`文件不存在: ${localPath}`);
    }

    if (path.extname(localPath).toLowerCase() === ".pdf") {
        return localPath;
    }

    return await convertToPDF(localPath);
}

export async function callPdfInspector<T>(request: PdfInspectorRequest, timeoutMs = PYTHON_TIMEOUT_MS): Promise<T> {
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
        throw new Error(`PDF inspector 退出码 ${code}: ${stderr || stdout}`);
    }

    try {
        const parsed = JSON.parse(stdout);
        if (parsed && parsed.ok === false) {
            throw new Error(parsed.error || "PDF inspector 返回失败");
        }
        return (parsed.result ?? parsed) as T;
    } catch (error) {
        if (error instanceof SyntaxError) {
            throw new Error(`PDF inspector 输出不是合法 JSON: ${stdout.slice(0, 500)} ${stderr ? `stderr=${stderr}` : ""}`);
        }
        throw error;
    }
}

export async function extractPdfStructure(pdfPath: string, page: number | "all" | null): Promise<PageStructure[]> {
    return await callPdfInspector<PageStructure[]>({
        action: "extract_structure",
        pdfPath,
        page: page === "all" ? null : page,
    });
}

export async function detectPdfIssues(
    pdfPath: string,
    page: number | "all" | null,
    checks: string[],
    autoScreenshot: boolean,
    scale: number,
    thresholds?: PdfInspectorThresholds,
): Promise<InspectResult> {
    return await callPdfInspector<InspectResult>({
        action: "detect_issues",
        pdfPath,
        page: page === "all" ? null : page,
        checks,
        autoScreenshot,
        scale,
        thresholds,
    });
}

export async function renderPdfRegion(
    pdfPath: string,
    page: number,
    rect: Rect,
    scale: number,
    outputPath: string,
): Promise<PdfRegionScreenshotResult> {
    return await callPdfInspector<PdfRegionScreenshotResult>({
        action: "region_screenshot",
        pdfPath,
        page,
        rect,
        scale,
        outputPath,
    });
}

export async function searchPdfTextRegion(
    pdfPath: string,
    target: string,
    page: number | "all" | null,
): Promise<PdfTextRegionResult> {
    return await callPdfInspector<PdfTextRegionResult>({
        action: "search_text_region",
        pdfPath,
        page: page === "all" ? null : page,
        target,
    });
}
