import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type { ConversationRound } from "../src/trajectory.js";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-record-generator-test-"));
// 隔离数据根：防止 generateRecord("general", …) 写进真实 general 库。必须在导入 record-store 前设置。
process.env.MEMORY_STORE_DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-record-generator-data-"));
const fakeCodexJs = path.join(tempDir, "fake-codex.js");
const fakeCodexCmd = path.join(tempDir, "fake-codex.cmd");
const execCountFile = path.join(tempDir, "exec-count.txt");
let lastGetModelResponsePayload: any = null;

const lsServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
        const url = req.url || "";
        if (url.endsWith("/Heartbeat")) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end("{}");
            return;
        }
        if (url.endsWith("/GetModelResponse")) {
            lastGetModelResponsePayload = body ? JSON.parse(body) : null;
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ response: "not a valid record" }));
            return;
        }
        res.writeHead(404);
        res.end();
    });
});
await new Promise<void>((resolve) => lsServer.listen(0, "127.0.0.1", resolve));
const lsPort = (lsServer.address() as AddressInfo).port;

fs.writeFileSync(fakeCodexJs, `
const fs = require("node:fs");

if (process.argv.includes("--version")) {
  console.log("fake-codex 0.0.0");
  process.exit(0);
}

if (process.argv.includes("exec")) {
  const countFile = process.env.FAKE_CODEX_EXEC_COUNT_FILE;
  const current = countFile && fs.existsSync(countFile)
    ? Number(fs.readFileSync(countFile, "utf-8"))
    : 0;
  if (countFile) fs.writeFileSync(countFile, String(current + 1), "utf-8");
  if (process.env.FAKE_CODEX_MODE === "sleep") {
    setInterval(() => {}, 1000);
    return;
  }
  process.exit(0);
}

process.exit(1);
`, "utf-8");

fs.writeFileSync(fakeCodexCmd, `@echo off\r\n"${process.execPath}" "%~dp0fake-codex.js" %*\r\n`, "utf-8");

process.env.MEMORY_STORE_CODEX_COMMAND = fakeCodexCmd;
process.env.MEMORY_STORE_CODEX_RECORD_TIMEOUT = "2000";
process.env.MEMORY_STORE_CODEX_RECORD_RETRY_DELAY = "10";
process.env.FAKE_CODEX_EXEC_COUNT_FILE = execCountFile;
process.env.MEMORY_STORE_GROK_PROXY_URL = "http://127.0.0.1:9";
process.env.MEMORY_STORE_GROK_STATUS_TIMEOUT_MS = "50";

const { __setParentLsForTest } = await import("../src/ls-client.ts");
__setParentLsForTest({
    info: { pid: process.pid, csrfToken: "fake-csrf", workspaceId: "fake-ws", ports: [lsPort] },
    port: lsPort,
});
const { generateRecord } = await import("../src/record-generator.ts");

const rounds: ConversationRound[] = [
    {
        roundIndex: 1,
        startStep: 1,
        endStep: 2,
        userMessage: "请记录这个测试对话",
        mediaAttachments: [],
        aiResponses: [{ stepIndex: 2, response: "测试回复", thinking: "", toolCalls: [] }],
        toolCalls: [],
        taskBoundaries: [],
        codeActions: [],
        subagentSummaries: [],
    },
];

try {
    process.env.FAKE_CODEX_MODE = "empty";
    fs.rmSync(execCountFile, { force: true });
    const emptyResult = await generateRecord("general", `record-generator-codex-empty-${Date.now()}`, "test", rounds, 2, "codex");
    assert.equal(emptyResult.success, false);
    assert.match(emptyResult.error || "", /Codex Record 模型桥/u);
    assert.match(emptyResult.error || "", /modelChain=antigravity/u);
    assert.equal(Number(fs.readFileSync(execCountFile, "utf-8")), 2, "codex Record generation should retry one fast failure");

    process.env.FAKE_CODEX_MODE = "sleep";
    fs.rmSync(execCountFile, { force: true });
    const timeoutResult = await generateRecord("general", `record-generator-codex-timeout-${Date.now()}`, "test", rounds, 2, "codex");
    assert.equal(timeoutResult.success, false);
    assert.match(timeoutResult.error || "", /Codex Record 模型桥/u);
    assert.match(timeoutResult.error || "", /完整超时不会自动重试/u);
    assert.match(timeoutResult.error || "", /modelChain=antigravity/u);
    assert.equal(Number(fs.readFileSync(execCountFile, "utf-8")), 1, "codex Record generation should not retry full timeouts");

    lastGetModelResponsePayload = null;
    const autoFallbackResult = await generateRecord("general", `record-generator-grok-fallback-${Date.now()}`, "test", rounds, 2, "auto");
    assert.equal(lastGetModelResponsePayload?.model, "MODEL_PLACEHOLDER_M20", "Record auto fallback to Antigravity should use M20");
    assert.deepEqual(autoFallbackResult.modelChainsUsed, ["antigravity"]);
    assert.deepEqual(autoFallbackResult.modelModelsUsed, ["MODEL_PLACEHOLDER_M20"]);
} finally {
    __setParentLsForTest(null);
    fs.rmSync(tempDir, { recursive: true, force: true });
    await new Promise<void>(resolve => lsServer.close(() => resolve()));
}
