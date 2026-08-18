import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    loadWindsurfConversation,
    __setWindsurfEndpointResolverForTest,
    __setWindsurfTransportFactoryForTest,
    __resetWindsurfEndpointCacheForTest,
    type WindsurfLsEndpoint,
    type WindsurfLsTransport,
} from "../src/windsurf-client.ts";
import { __setWindsurfCascadeDirForTest } from "../src/windsurf-local-store.ts";
import { clearMappings } from "../src/conversation-router.ts";

/**
 * WSF 多窗口端点选择（失败路径 ④⑤⑥-a 闭环）。
 *
 * 基线红（旧逻辑 discoverWindsurfLsEndpoint 取枚举第一个 Heartbeat 通的端点，无持有性校验）：
 * 端点池 [{9001:owns ID_A},{9002:owns ID_B}]，fetch ID_B 时旧逻辑撞 9001 → 读空。
 * 修复后：路由大脑广播 holds，按 cascadeId 命中真持有者 9002。
 *
 * 全链路用 __setWindsurfEndpointResolverForTest + __setWindsurfTransportFactoryForTest 注入，离线。
 */

const ID_A = "wsf-cascade-aaaa";
const ID_B = "wsf-cascade-bbbb";

// 临时本地 .pb 目录（兜底用例）
const pbDir = fs.mkdtempSync(path.join(os.tmpdir(), "wsf-pb-"));
__setWindsurfCascadeDirForTest(pbDir);

interface FakeWsf {
    pid: number;
    port: number;
    /** 持有的 cascadeId → 该对话的 steps（offset 0 一页返完） */
    owns: Record<string, any[]>;
}

function ep(f: FakeWsf): WindsurfLsEndpoint {
    return { pid: f.pid, port: f.port, csrfToken: `csrf-${f.pid}`, executablePath: `C:/wsf-${f.pid}.exe` };
}

let probeCountByPort: Record<number, number> = {};

function installPool(pool: FakeWsf[]): void {
    probeCountByPort = {};
    __resetWindsurfEndpointCacheForTest();
    __setWindsurfEndpointResolverForTest(async () => pool.map(ep));
    __setWindsurfTransportFactoryForTest((endpoint: WindsurfLsEndpoint): WindsurfLsTransport => {
        const f = pool.find(x => x.pid === endpoint.pid && x.port === endpoint.port);
        return async (method: string, payload?: Record<string, unknown>) => {
            probeCountByPort[endpoint.port] = (probeCountByPort[endpoint.port] || 0) + 1;
            if (method === "Heartbeat") return {};
            if (method === "GetAllCascadeTrajectories") {
                const trajectorySummaries: Record<string, any> = {};
                for (const [id, steps] of Object.entries(f?.owns ?? {})) {
                    trajectorySummaries[id] = { cascadeId: id, stepCount: steps.length, lastModifiedTime: "2026-06-25T00:00:00Z" };
                }
                return { trajectorySummaries };
            }
            if (method === "GetCascadeTrajectorySteps") {
                const cascadeId = String(payload?.cascadeId);
                const offset = Number(payload?.stepOffset ?? 0);
                const steps = (f?.owns ?? {})[cascadeId] ?? [];
                return { steps: offset === 0 ? steps : [] };
            }
            return {};
        };
    });
}

const userStep = (text: string) => ({ type: "CORTEX_STEP_TYPE_USER_INPUT", userInput: { userResponse: text } });

try {
    // ===== 用例 1：基线红→绿 — 端点池 [9001:ID_A, 9002:ID_B]，fetch ID_B 命中 9002 不读空 =====
    {
        clearMappings();
        installPool([
            { pid: 1, port: 9001, owns: { [ID_A]: [userStep("A-内容")] } },
            { pid: 2, port: 9002, owns: { [ID_B]: [userStep("B-内容-EPX")] } },
        ]);
        const result = await loadWindsurfConversation(ID_B);
        assert.ok(result, "应读到 ID_B");
        assert.notEqual(result!.partial, true, "真持有者命中，非 partial 兜底");
        assert.equal(result!.totalSteps, 1, "应读到 9002 持有的 ID_B（1 步），旧逻辑撞 9001 会读空");
        assert.match(result!.rounds[0].userMessage, /B-内容-EPX/u, "正文应是 ID_B 的内容");
    }

    // ===== 用例 2：fetch ID_A 命中 9001（不串台）=====
    {
        clearMappings();
        installPool([
            { pid: 1, port: 9001, owns: { [ID_A]: [userStep("A-内容-EPX")] } },
            { pid: 2, port: 9002, owns: { [ID_B]: [userStep("B-内容")] } },
        ]);
        const result = await loadWindsurfConversation(ID_A);
        assert.ok(result);
        assert.match(result!.rounds[0].userMessage, /A-内容-EPX/u, "ID_A 命中 9001，不串到 9002");
    }

    // ===== 用例 3：ID_A/ID_B 端点隔离 + 交替 fetch 不互相污染 =====
    {
        clearMappings();
        installPool([
            { pid: 1, port: 9001, owns: { [ID_A]: [userStep("A1-EPX")] } },
            { pid: 2, port: 9002, owns: { [ID_B]: [userStep("B1-EPX")] } },
        ]);
        // 交替读，每次都要读到各自正确内容（旧单一 cachedEndpoint 会让第二次粘住第一次的端点）
        const a1 = await loadWindsurfConversation(ID_A);
        const b1 = await loadWindsurfConversation(ID_B);
        const a2 = await loadWindsurfConversation(ID_A);
        assert.match(a1!.rounds[0].userMessage, /A1-EPX/u, "首读 ID_A 正确");
        assert.match(b1!.rounds[0].userMessage, /B1-EPX/u, "紧接读 ID_B 不被 ID_A 端点污染");
        assert.match(a2!.rounds[0].userMessage, /A1-EPX/u, "再读 ID_A 仍正确（端点按 cascadeId 隔离）");
    }

    // ===== 用例 4：全不持有 + 本地有 .pb → partial:true 兜底 =====
    {
        clearMappings();
        const orphanId = "wsf-cascade-orphan";
        fs.writeFileSync(path.join(pbDir, `${orphanId}.pb`), "fake-pb-bytes");
        installPool([
            { pid: 1, port: 9001, owns: { [ID_A]: [userStep("A")] } },
        ]);
        const result = await loadWindsurfConversation(orphanId);
        assert.ok(result, "本地有 .pb → 应返回 partial 空壳而非 null");
        assert.equal(result!.partial, true, "无持有 LS 但本地有 .pb → partial:true 明确提示");
        assert.equal(result!.totalSteps, 0);
        assert.match(result!.thread.summary, /没有持有|窗口/u, "提示信息应说明窗口已关");
    }

    // ===== 用例 5：全不持有 + 本地无 .pb → null（对话确实不存在）=====
    {
        clearMappings();
        installPool([
            { pid: 1, port: 9001, owns: { [ID_A]: [userStep("A")] } },
        ]);
        const result = await loadWindsurfConversation("wsf-cascade-nonexistent");
        assert.equal(result, null, "无持有 LS 且本地无 .pb → null");
    }

    // ===== 用例 6：连错不返空要继续探测 — 3 个 LS 仅第 3 持有 =====
    {
        clearMappings();
        installPool([
            { pid: 1, port: 9001, owns: { "other-x": [userStep("x")] } },
            { pid: 2, port: 9002, owns: { "other-y": [userStep("y")] } },
            { pid: 3, port: 9003, owns: { [ID_B]: [userStep("B-third-EPX")] } },
        ]);
        const result = await loadWindsurfConversation(ID_B);
        assert.ok(result);
        assert.match(result!.rounds[0].userMessage, /B-third-EPX/u, "应继续探测到第 3 个 LS，而非撞第 1 个读空");
    }

    // ===== S1 红用例 ①：desync — 持有者 summary 报 stepCount=5 但 read 返 steps=[] → 触发 invalidate+换 LS 重试 =====
    // bug：enrichThreadSummary 用 summary.stepCount 把 result.totalSteps 抬到 5，旧守卫看 totalSteps===0 永不成立
    //      → 不 invalidate、不重试 → 返回「号称 5 步实则 0 轮」的空壳冒充成功（rounds=[]）。
    // 修复：守卫改看真实正文量 result.steps.length===0 && stepCount>0 → 正确触发 invalidate + 第二次 attempt。
    // 用 attemptPhase 让第二次广播命中真持有者（读到正文），最终断言读到真内容（rounds[0] 含 B-真内容）。
    {
        clearMappings();
        probeCountByPort = {};
        __resetWindsurfEndpointCacheForTest();

        const DESYNC_PORT = 9001;  // 滞后 LS：summary 报 ID_B=5 步，read 返 []
        const HOLDER_PORT = 9002;  // 真持有者：read 返真正文

        // desync LS 的 read 一旦发生，其后第 2 次起的 GetAllCascadeTrajectories 不再含 ID_B。
        // 时序（read 之后）：第 1 次 GetAll = enrich（仍报含，复现「totalSteps 被抬高」bug）；
        //                    第 2 次 GetAll = 第二次 attempt 的 holds 广播（不再含 → winner 让位给真持有者）。
        let desyncReadHappened = false;
        let desyncGetAllAfterRead = 0;

        const pool = [
            { pid: 1, port: DESYNC_PORT },
            { pid: 2, port: HOLDER_PORT },
        ];
        __setWindsurfEndpointResolverForTest(async () => pool.map(p => ({
            pid: p.pid, port: p.port, csrfToken: `csrf-${p.pid}`, executablePath: `C:/wsf-${p.pid}.exe`,
        })));
        __setWindsurfTransportFactoryForTest((endpoint: WindsurfLsEndpoint): WindsurfLsTransport => {
            return async (method: string, payload?: Record<string, unknown>) => {
                probeCountByPort[endpoint.port] = (probeCountByPort[endpoint.port] || 0) + 1;
                if (method === "Heartbeat") return {};
                if (method === "GetAllCascadeTrajectories") {
                    const summaries: Record<string, any> = {};
                    if (endpoint.port === DESYNC_PORT) {
                        let desyncHolds = true;
                        if (desyncReadHappened) {
                            desyncGetAllAfterRead++;
                            // read 后第 2 次起（第二次 attempt 的广播）desync 不再 holds → 让位真持有者
                            if (desyncGetAllAfterRead >= 2) desyncHolds = false;
                        }
                        // desync 声称持有 ID_B 且 stepCount=5（但 read 会返空）
                        if (desyncHolds) summaries[ID_B] = { cascadeId: ID_B, stepCount: 5, lastModifiedTime: "2026-06-25T00:00:00Z" };
                    }
                    if (endpoint.port === HOLDER_PORT) {
                        // 真持有者：summary stepCount=1（< 5，第一轮路由会优先选 desync 的 5）
                        summaries[ID_B] = { cascadeId: ID_B, stepCount: 1, lastModifiedTime: "2026-06-25T00:00:00Z" };
                    }
                    return { trajectorySummaries: summaries };
                }
                if (method === "GetCascadeTrajectorySteps") {
                    const offset = Number(payload?.stepOffset ?? 0);
                    if (endpoint.port === DESYNC_PORT) {
                        // desync：summary 在但正文读不出（滞后/失联）→ read 返空。
                        desyncReadHappened = true;
                        return { steps: [] };
                    }
                    if (endpoint.port === HOLDER_PORT) {
                        return { steps: offset === 0 ? [userStep("B-真内容-EPX")] : [] };
                    }
                    return { steps: [] };
                }
                return {};
            };
        });

        const result = await loadWindsurfConversation(ID_B);
        assert.ok(result, "desync 后换 LS 重试应读到真持有者内容");
        assert.ok(result!.rounds.length > 0, "S1：修复后不应返回 rounds=[] 的空壳（旧守卫被 enrich 抬高的 totalSteps 蒙蔽 → 不重试 → 空壳假成功）");
        assert.match(result!.rounds[0].userMessage, /B-真内容-EPX/u, "S1：desync(summary 报 5 但 read 空) 触发 invalidate+换 LS 重试后读到真持有者 9002 的正文");
    }

    // ===== S1 红用例 ②：护栏 — 合法空对话 stepCount=0 时不进无意义重试、不误判 partial =====
    // 守卫的 `&& stepCount > 0` 半边：合法空对话（summary stepCount=0 且 read 返 []）不应触发重试。
    // 回退守卫成 totalSteps===0：stepCount=0 时 totalSteps 被 enrich 设为 0 → 0===0 成立 → 误触发一次多余重试（红）。
    {
        clearMappings();
        const EMPTY_ID = "wsf-cascade-empty";
        probeCountByPort = {};
        __resetWindsurfEndpointCacheForTest();

        const pool = [{ pid: 1, port: 9001 }];
        __setWindsurfEndpointResolverForTest(async () => pool.map(p => ({
            pid: p.pid, port: p.port, csrfToken: `csrf-${p.pid}`, executablePath: `C:/wsf-${p.pid}.exe`,
        })));
        __setWindsurfTransportFactoryForTest((endpoint: WindsurfLsEndpoint): WindsurfLsTransport => {
            return async (method: string, payload?: Record<string, unknown>) => {
                if (method === "Heartbeat") return {};
                if (method === "GetAllCascadeTrajectories") {
                    // 合法空对话：持有该 id，但 stepCount=0
                    return { trajectorySummaries: { [EMPTY_ID]: { cascadeId: EMPTY_ID, stepCount: 0, lastModifiedTime: "2026-06-25T00:00:00Z" } } };
                }
                if (method === "GetCascadeTrajectorySteps") {
                    probeCountByPort[endpoint.port] = (probeCountByPort[endpoint.port] || 0) + 1;
                    return { steps: [] };
                }
                return {};
            };
        });

        const result = await loadWindsurfConversation(EMPTY_ID);
        assert.ok(result, "合法空对话应正常返回（非 null）");
        assert.equal(result!.totalSteps, 0, "合法空对话 totalSteps=0");
        assert.notEqual(result!.partial, true, "S1 护栏：合法空对话不应误判 partial");
        // 关键：stepCount=0 不触发重试 → GetCascadeTrajectorySteps 只被调一次（一次 attempt）。
        // 回退守卫(totalSteps===0)会多触发一次重试 → 该 port 被调 2 次（红）。
        assert.equal(probeCountByPort[9001], 1, "S1 护栏：stepCount=0 不进无意义重试，read 仅一次 attempt");
    }

    console.log("windsurf-endpoint-select.test.ts PASS");
} finally {
    __setWindsurfEndpointResolverForTest(null);
    __setWindsurfTransportFactoryForTest(null);
    __resetWindsurfEndpointCacheForTest();
    __setWindsurfCascadeDirForTest(null);
    clearMappings();
    try { fs.rmSync(pbDir, { recursive: true, force: true }); } catch { /* ignore */ }
}
