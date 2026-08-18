import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * C2：antigravity 超时透传回归测试
 *
 * 验证三件事（全部通过真实 model-bridge → ls-client 栈，只注入「父 LS 连接」这一最小桩）：
 *  1. antigravity LS「真超时」→ callModelResponse 返回 timedOut=true，
 *     且底层只发生一次超时等待（GetModelResponse 只被调用 1 次，无第二次重试）。
 *  2. antigravity LS「普通失败（非超时）」→ timedOut 不为 true（可重试 / 换候选）。
 *  3. 旧版 callGetModelResponse（返回 string|null）行为不变：超时与失败都返回 null。
 *
 * 用一个 fake LS HTTP server + __setParentLsForTest 直接注入父 LS 连接，
 * 使模型调用确定性命中本测试 server，不依赖 ls-registry / PowerShell 发现，
 * 也不受本机真实运行的 Antigravity LS 干扰（hermetic）。
 */

type GmrMode = "hang" | "fail500" | "empty" | "success";
let gmrMode: GmrMode = "hang";
let getModelResponseCalls = 0;
let lastGetModelResponsePayload: any = null;
const hangingResponses: http.ServerResponse[] = [];

const server = http.createServer((req, res) => {
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
            getModelResponseCalls++;
            try {
                lastGetModelResponsePayload = body ? JSON.parse(body) : null;
            } catch {
                lastGetModelResponsePayload = null;
            }
            if (gmrMode === "hang") {
                // 永不响应：模拟模型迟迟不返回 → 触发 wall-clock 真超时。
                hangingResponses.push(res);
                return;
            }
            if (gmrMode === "success") {
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ response: "ok" }));
                return;
            }
            if (gmrMode === "fail500") {
                // 普通失败：非超时，上层应可重试。
                res.writeHead(500, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "internal" }));
                return;
            }
            // empty：200 但 response 为空 → 普通失败（非超时）。
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ response: "" }));
            return;
        }
        res.writeHead(404);
        res.end();
    });
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as AddressInfo).port;

process.env.MEMORY_STORE_GROK_PROXY_URL = "http://127.0.0.1:9";
const { callGetModelResponse, callGetModelResponseDetailed, __setParentLsForTest } = await import("../src/ls-client.ts");
const { callModelResponse } = await import("../src/model-bridge.ts");
const { resetGrokBridgeAvailabilityForTest } = await import("../src/grok-client.ts");
const { configureProviderTransportAdapterForTest, resetProviderTransportAdapterForTest } = await import("../src/provider-transport-adapter.ts");
await configureProviderTransportAdapterForTest({ mode: "shadow" });

// 直接注入父 LS 连接：模型调用全部走本 fake server，不触发注册表 / PowerShell 发现。
__setParentLsForTest({
    info: { pid: process.pid, csrfToken: "fake-csrf", workspaceId: "fake-ws", ports: [port] },
    port,
});

function releaseHanging(): void {
    for (const res of hangingResponses.splice(0)) {
        try { res.destroy(); } catch { /* ignore */ }
    }
}

try {
    // ===== 0. auto 路由：Grok 不可用时 fallback 到 Antigravity =====
    resetGrokBridgeAvailabilityForTest();
    gmrMode = "success";
    lastGetModelResponsePayload = null;
    const autoAntigravity = await callModelResponse("flash", "hello", "auto", 5000);
    assert.equal(autoAntigravity.text, "ok");
    assert.equal(autoAntigravity.chainUsed, "antigravity");
    assert.equal(lastGetModelResponsePayload?.model, "flash", "Grok 不可用时 auto 应回退到 Antigravity LS");

    // ===== 1. 真超时：只一次等待、无重试，timedOut=true =====
    gmrMode = "hang";
    getModelResponseCalls = 0;
    const t0 = Date.now();
    const timeoutResult = await callModelResponse("flash", "hello", "antigravity", 400);
    const elapsed = Date.now() - t0;
    assert.equal(timeoutResult.text, null, "真超时 text 应为 null");
    assert.equal(timeoutResult.timedOut, true, "真超时应透传 timedOut=true");
    assert.equal(timeoutResult.chainUsed, null, "超时时 chainUsed 应为 null");
    assert.match(timeoutResult.error || "", /超时/u, "错误信息应标明超时");
    assert.equal(getModelResponseCalls, 1, "真超时只应发生一次 GetModelResponse 调用，绝不重试");
    assert.ok(elapsed < 3000, `wall-clock 超时应及时收口（远小于翻倍），实际耗时 ${elapsed}ms`);
    releaseHanging();

    // ===== 2. 普通失败（500）：timedOut 不为 true，仍可重试 =====
    gmrMode = "fail500";
    getModelResponseCalls = 0;
    const failResult = await callModelResponse("flash", "hello", "antigravity", 5000);
    assert.equal(failResult.text, null, "普通失败 text 应为 null");
    assert.notEqual(failResult.timedOut, true, "普通失败不应被误判为超时（timedOut!==true）");
    assert.ok(getModelResponseCalls >= 1, "普通失败应至少调用一次");

    // ===== 2b. 普通失败（空响应）：timedOut 不为 true =====
    gmrMode = "empty";
    const detailedEmpty = await callGetModelResponseDetailed("flash", "hello", 5000);
    assert.equal(detailedEmpty.text, null, "空响应 text 应为 null");
    assert.notEqual(detailedEmpty.timedOut, true, "空响应属普通失败，timedOut!==true");

    // ===== 2c. Record fallback 可覆盖 Antigravity 模型名 =====
    gmrMode = "success";
    lastGetModelResponsePayload = null;
    const overrideResult = await callModelResponse("flash", "hello", "antigravity", 5000, { antigravityModelOverride: "MODEL_PLACEHOLDER_M20" });
    assert.equal(overrideResult.text, "ok");
    assert.equal(overrideResult.chainUsed, "antigravity");
    assert.equal(lastGetModelResponsePayload?.model, "MODEL_PLACEHOLDER_M20", "antigravityModelOverride 应覆盖传给 LS 的模型名");

    // ===== 3. 旧版 string|null 调用方行为不变（回归） =====
    gmrMode = "hang";
    getModelResponseCalls = 0;
    const legacyTimeout = await callGetModelResponse("flash", "hello", 400);
    assert.equal(legacyTimeout, null, "旧版超时仍返回 null");
    assert.equal(getModelResponseCalls, 1, "旧版超时也只调用一次");
    releaseHanging();

    gmrMode = "empty";
    const legacyEmpty = await callGetModelResponse("flash", "hello", 5000);
    assert.equal(legacyEmpty, null, "旧版空响应仍返回 null");

    console.log("ls-timeout-passthrough.test.ts PASS");
} finally {
    __setParentLsForTest(null);
    await resetProviderTransportAdapterForTest();
    delete process.env.MEMORY_STORE_GROK_PROXY_URL;
    releaseHanging();
    await new Promise<void>((resolve) => server.close(() => resolve()));
}
