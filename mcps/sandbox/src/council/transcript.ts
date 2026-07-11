import fs from "fs";
import path from "path";
import {
    councilArtifactPath,
    readCouncilArtifactManifest,
    registerCouncilArtifact,
    registerCouncilExternalReference,
} from "./artifact-store.js";
import type { CouncilTranscript } from "./types.js";

function safeName(input: string): string {
    return input.replace(/[^\w.-]+/gu, "_").slice(0, 80) || "council";
}

function nowStamp(): string {
    const now = new Date();
    return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}`;
}

function markdownEscape(text: string): string {
    return text.replace(/\r\n/gu, "\n").trim();
}

function getRoundToolResults(round: CouncilTranscript["rounds"][number]) {
    if (round.toolResults && round.toolResults.length > 0) {
        return round.toolResults;
    }
    return round.toolResult ? [round.toolResult] : [];
}

function getModeratorSteps(round: CouncilTranscript["rounds"][number]) {
    if (round.moderatorSteps && round.moderatorSteps.length > 0) {
        return round.moderatorSteps;
    }
    return [round.moderator];
}

function formatMetadata(metadata?: Record<string, unknown>): string {
    if (!metadata || Object.keys(metadata).length === 0) return "";
    return Object.entries(metadata)
        .filter(([, value]) => value !== undefined && value !== null && value !== "")
        .map(([key, value]) => `${key}=${String(value)}`)
        .join(" | ");
}

export function formatCouncilMarkdown(transcript: CouncilTranscript): string {
    const lines: string[] = [];
    lines.push(`# sandbox_council transcript`);
    lines.push("");
    lines.push(`- id: ${transcript.id}`);
    lines.push(`- createdAt: ${transcript.createdAt}`);
    lines.push(`- mode: ${transcript.mode}`);
    lines.push(`- terminationReason: ${transcript.terminationReason}`);
    lines.push("");
    lines.push("## Input");
    lines.push("");
    lines.push(markdownEscape(transcript.input));
    lines.push("");
    if (transcript.largeInputs && transcript.largeInputs.length > 0) {
        lines.push("## Large Input Artifacts");
        lines.push("");
        for (const item of transcript.largeInputs) {
            lines.push(`- ${item.label ? `${item.label}: ` : ""}${item.id} [${item.sourceKind}]`);
            if (item.sourcePath) {
                lines.push(`  - source: ${item.sourcePath}`);
            }
            lines.push(`  - chars: ${item.sourceCharCount}`);
            lines.push(`  - chunks: ${item.chunkCount} (chunkSize=${item.chunkSize}, overlap=${item.overlap})`);
            lines.push(`  - sha256: ${item.sourceSha256}`);
            lines.push(`  - sourceText: ${item.sourceTextPath || "-"}`);
            lines.push(`  - checkpoint: ${item.checkpointPath}`);
            lines.push(`  - index: ${item.indexPath}`);
            if (item.warnings && item.warnings.length > 0) {
                for (const warning of item.warnings) {
                    lines.push(`  - warning: ${warning}`);
                }
            }
        }
        lines.push("");
    }
    if (transcript.files.length > 0) {
        lines.push("## Files");
        for (const file of transcript.files) {
            lines.push(`- ${file.ok ? "OK" : "ERROR"} ${file.label ? `${file.label}: ` : ""}${file.path}${file.range ? ` (${file.range})` : ""}`);
            if (file.kind || file.ingestMode || file.parser) {
                lines.push(`  - meta: kind=${file.kind || "-"} | ingest=${file.ingestMode || "-"} | parser=${file.parser || "-"}`);
            }
            if (file.artifactPath) {
                lines.push(`  - artifact: ${file.artifactPath}`);
            }
            if (file.warnings && file.warnings.length > 0) {
                for (const warning of file.warnings) {
                    lines.push(`  - warning: ${warning}`);
                }
            }
        }
        lines.push("");
    }
    if (transcript.imageObservations) {
        lines.push("## Image Observations");
        lines.push("");
        lines.push(markdownEscape(transcript.imageObservations));
        lines.push("");
    }
    if (transcript.textProjection) {
        lines.push("## Only-text Projection");
        lines.push("");
        lines.push(markdownEscape(transcript.textProjection));
        lines.push("");
    }
    lines.push("## Participants");
    for (const p of transcript.participants) {
        lines.push(`- ${p.id} | ${p.role} | ${p.provider} | ${p.model || "(default)"}${p.supportsVision ? " | vision" : ""}`);
    }
    lines.push(`- moderator: ${transcript.moderator.id} | ${transcript.moderator.provider} | ${transcript.moderator.model || "(default)"}`);
    lines.push("");
    lines.push("## Rounds");
    for (const round of transcript.rounds) {
        lines.push(`### Round ${round.round}`);
        for (const message of round.messages) {
            lines.push(`#### ${message.participantId} (${message.role}, ${message.provider}${message.model ? `:${message.model}` : ""})`);
            lines.push("");
            const metadata = formatMetadata(message.metadata);
            if (metadata) {
                lines.push(`metadata: ${metadata}`);
                lines.push("");
            }
            lines.push(message.error ? `ERROR: ${message.error}` : markdownEscape(message.text));
            lines.push("");
        }
        for (const [stepIndex, step] of getModeratorSteps(round).entries()) {
            lines.push(`#### Moderator Step ${stepIndex + 1}`);
            lines.push("");
            lines.push(`action: ${step.action}`);
            lines.push("");
            const metadata = formatMetadata(step.metadata);
            if (metadata) {
                lines.push(`metadata: ${metadata}`);
                lines.push("");
            }
            lines.push(markdownEscape(step.summary || step.rawText));
            lines.push("");
            if (step.afterToolInstruction) {
                lines.push("#### After Tool Instruction");
                lines.push("");
                lines.push(markdownEscape(step.afterToolInstruction));
                lines.push("");
            }
            const toolResults = step.toolResults || [];
            for (const [toolIndex, toolResult] of toolResults.entries()) {
                lines.push(`#### Tool ${stepIndex + 1}.${toolIndex + 1}: ${toolResult.tool} (${toolResult.ok ? "ok" : "error"})`);
                lines.push("");
                if (toolResult.reason) {
                    lines.push(`reason: ${markdownEscape(toolResult.reason)}`);
                    lines.push("");
                }
                lines.push(markdownEscape(toolResult.text));
                lines.push("");
            }
        }
    }
    lines.push("## Final Answer");
    lines.push("");
    lines.push(markdownEscape(transcript.finalAnswer));
    lines.push("");
    return lines.join("\n");
}

export function formatCouncilArtifactSummary(runId: string): string {
    const artifactRun = readCouncilArtifactManifest(runId);
    return [
        "## 产物路径",
        `- runId: ${artifactRun.runId}`,
        `- manifest: ${artifactRun.artifactManifestPath}`,
        `- 主要产物数: ${artifactRun.manifest.artifactPaths.length}`,
        `- expiresAt: ${artifactRun.manifest.expiresAt}`,
    ].join("\n");
}

export function saveCouncilTranscript(transcript: CouncilTranscript, transcriptPath?: string, outputDir?: string): CouncilTranscript {
    const externalOutput = Boolean(transcriptPath || outputDir);
    const baseDir = outputDir ? path.resolve(outputDir) : undefined;
    if (baseDir) fs.mkdirSync(baseDir, { recursive: true });

    const defaultMdPath = councilArtifactPath(transcript.runId, "transcript", "council.md");

    const mdPath = transcriptPath
        ? path.resolve(transcriptPath)
        : baseDir
            ? path.join(baseDir, `${safeName(`council_${transcript.id}_${transcript.mode}`)}.md`)
            : defaultMdPath;
    const jsonPath = mdPath.toLowerCase().endsWith(".md")
        ? mdPath.slice(0, -3) + ".json"
        : `${mdPath}.json`;

    fs.mkdirSync(path.dirname(mdPath), { recursive: true });
    const withPaths = { ...transcript, markdownPath: mdPath, jsonPath };
    fs.writeFileSync(mdPath, formatCouncilMarkdown(withPaths), "utf-8");
    fs.writeFileSync(jsonPath, JSON.stringify(withPaths, null, 2), "utf-8");
    if (externalOutput) {
        registerCouncilExternalReference(transcript.runId, mdPath);
        registerCouncilExternalReference(transcript.runId, jsonPath);
    } else {
        registerCouncilArtifact(transcript.runId, mdPath);
        registerCouncilArtifact(transcript.runId, jsonPath);
    }
    return withPaths;
}
