import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { __setLsRpcImplForTest, type LsProcessInfo, type RpcResult } from "../src/ls-rpc.ts";
import {
    fetchTrajectory,
    __setParentLsForTest,
    __setConvCacheDirForTest,
} from "../src/ls-client.ts";
import { clearMappings, resolveEndpointForConversation, __setEnumeratorForTest } from "../src/conversation-router.ts";

/**
 * 方案 C（失败路径 ② 闭环）：反重力返旧快照防御。
 *
 * 基线红（旧逻辑）：fetchFromLs 只看 `cachedStepCount === currentStepCount` 短路返缓存，
 * 当被命中的 LS 是滞后 LS（currentStepCount=10 == 缓存=10）时直接返旧快照（10 步），
 * 即使真持有者已有 15 步。本测试通过「真持有者 stepCount=15」断言修复后读到 15。
 *
 * 全链路用 __setLsRpcImplForTest 注入假 rpc + __setParentLsForTest 注入持有者，
 * 不依赖真实 LS。
 */

const ID = "cascade-stale-test";
const PID = 5555;
const PORT = 9555;

// 临时缓存目录
const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "ls-stale-cache-"));
__setConvCacheDirForTest(cacheDir);

function cachePath(): string {
    const safeId = ID.replace(/[^a-zA-Z0-9-]/g, "").slice(0, 40);
    return path.join(cacheDir, `conv_${safeId}.json`);
}

/** 写一份缓存（模拟历史快照） */
function writeCache(stepCount: number, endpoint: string, stepLabels: string[]): void {
    const steps = stepLabels.map((label, i) => ({ type: "STEP", idx: i, label }));
    fs.writeFileSync(cachePath(), JSON.stringify({ stepCount, trajectory: { steps }, endpoint }), "utf-8");
}

/** 构造假 rpc：trueStepCount=真持有者步数；每个 GetCascadeTrajectorySteps 按 offset 返新数据 */
interface FakeServerOpts {
    holderStepCount: number;
    /** GetAllCascadeTrajectories 返回的 summaries（按 cascadeId） */
    summaryStepCount?: number;
    /** 真持有者实际能拉出的 steps（offset→steps） */
    makeSteps: (offset: number) => any[];
    /** tail verify 数据（offset→steps），不传则与 makeSteps 一致 */
    onCall?: (method: string, payload: Record<string, unknown>) => void;
}

function installFakeRpc(opts: FakeServerOpts): void {
    __setLsRpcImplForTest(async (
        _lsInfo: LsProcessInfo,
        _port: number,
        method: string,
        payload: Record<string, unknown>,
    ): Promise<RpcResult> => {
        opts.onCall?.(method, payload);
        if (method === "Heartbeat") return { status: 200, data: {}, rawSize: 2 };
        if (method === "GetAllCascadeTrajectories") {
            const sc = opts.summaryStepCount ?? opts.holderStepCount;
            return {
                status: 200,
                data: { trajectorySummaries: { [ID]: { cascadeId: ID, stepCount: sc, lastModifiedTime: "2026-06-25T00:00:00Z" } } },
                rawSize: 100,
            };
        }
        if (method === "GetCascadeTrajectorySteps") {
            const offset = Number(payload.stepOffset ?? 0);
            const steps = opts.makeSteps(offset);
            return { status: 200, data: { steps }, rawSize: JSON.stringify(steps).length };
        }
        return { status: 404, data: {}, rawSize: 0 };
    });
}

const parentInfo: LsProcessInfo = { pid: PID, csrfToken: "csrf", workspaceId: "ws", ports: [PORT] };

function setHolder(): void {
    __setParentLsForTest({ info: parentInfo, port: PORT });
}

try {
    // ===== 用例 1：命中滞后场景 → 缓存 stepCount=10，真持有者 stepCount=15 → 必须读到 15，不短路返旧 =====
    {
        clearMappings();
        setHolder();
        // 缓存：10 步，endpoint 同源
        writeCache(10, `${PID}:${PORT}`, Array.from({ length: 10 }, (_, i) => `old-${i}`));
        installFakeRpc({
            holderStepCount: 15,
            makeSteps: (offset) => {
                // 真持有者有 15 步全量
                if (offset === 0) return Array.from({ length: 15 }, (_, i) => ({ type: "STEP", idx: i, label: `new-${i}` }));
                return [];
            },
        });
        const result = await fetchTrajectory(ID);
        assert.ok(result, "应返回结果");
        assert.equal(result!.trajectory.steps.length, 15, "修复后必须读到真持有者的 15 步，而非缓存的 10 步");
        assert.equal(result!.fromCache, false, "stepCount 增长 → 不应原样返缓存");
    }

    // ===== 用例 2：合法缓存命中（防过度修复）→ 真持有者 stepCount===缓存 且同 endpoint → 走缓存 fromCache=true =====
    {
        clearMappings();
        setHolder();
        writeCache(12, `${PID}:${PORT}`, Array.from({ length: 12 }, (_, i) => `c-${i}`));
        installFakeRpc({
            holderStepCount: 12,
            makeSteps: () => { throw new Error("不应触发全量拉取"); },
        });
        const result = await fetchTrajectory(ID);
        assert.ok(result);
        assert.equal(result!.fromCache, true, "stepCount 一致且同 endpoint → 直接走缓存（防过度修复）");
        assert.equal(result!.trajectory.steps.length, 12);
    }

    // ===== 用例 3：跨 endpoint 命中（stepCount 相等但 endpoint 不一致）→ verifyTail 确认后返并刷指纹 =====
    {
        clearMappings();
        setHolder();
        // 缓存来自「别的 endpoint」（9999:8888），步数相等=8
        writeCache(8, "9999:8888", Array.from({ length: 8 }, (_, i) => `x-${i}`));
        let tailVerified = false;
        installFakeRpc({
            holderStepCount: 8,
            onCall: (method, payload) => {
                // verifyTail 会请求 stepOffset = 8 - 30 → clamp 0
                if (method === "GetCascadeTrajectorySteps") tailVerified = true;
            },
            makeSteps: (offset) => {
                // 返回与缓存一致的尾部（type=STEP），让 verifyTail 通过
                return Array.from({ length: 8 - offset }, (_, i) => ({ type: "STEP", idx: offset + i }));
            },
        });
        const result = await fetchTrajectory(ID);
        assert.ok(result);
        assert.equal(tailVerified, true, "跨 endpoint 命中应触发 verifyTail 二次确认");
        assert.equal(result!.fromCache, true, "verifyTail 通过 → 返缓存");
        // 刷指纹：缓存文件 endpoint 应被改写为当前 endpoint
        const reloaded = JSON.parse(fs.readFileSync(cachePath(), "utf-8"));
        assert.equal(reloaded.endpoint, `${PID}:${PORT}`, "确认后应刷新 endpoint 指纹");
    }

    // ===== 用例 4：currentStepCount < cachedStepCount → 强制全量（新增分支）=====
    {
        clearMappings();
        setHolder();
        writeCache(20, `${PID}:${PORT}`, Array.from({ length: 20 }, (_, i) => `big-${i}`));
        installFakeRpc({
            holderStepCount: 5, // 真持有者只有 5 步（缓存比它还长 → 回溯/串台）
            makeSteps: (offset) => {
                if (offset === 0) return Array.from({ length: 5 }, (_, i) => ({ type: "STEP", idx: i, label: `real-${i}` }));
                return [];
            },
        });
        const result = await fetchTrajectory(ID);
        assert.ok(result);
        assert.equal(result!.trajectory.steps.length, 5, "current<cached → 强制全量，返真持有者的 5 步");
        assert.equal(result!.fromCache, false);
    }

    // ===== 用例 5：forceRefresh → 全量，不看缓存 =====
    {
        clearMappings();
        setHolder();
        writeCache(7, `${PID}:${PORT}`, Array.from({ length: 7 }, (_, i) => `f-${i}`));
        let fullPulled = false;
        installFakeRpc({
            holderStepCount: 7,
            makeSteps: (offset) => {
                fullPulled = true;
                if (offset === 0) return Array.from({ length: 7 }, (_, i) => ({ type: "STEP", idx: i }));
                return [];
            },
        });
        const result = await fetchTrajectory(ID, true);
        assert.ok(result);
        assert.equal(fullPulled, true, "forceRefresh 应跳过缓存直接全量");
        assert.equal(result!.fromCache, false);
    }

    // ===== 用例 6：knownStepCount 复用 → 不重复 getStepCountLight（Phase 0 已拿到）=====
    {
        clearMappings();
        setHolder();
        if (fs.existsSync(cachePath())) fs.unlinkSync(cachePath());
        let getAllCalls = 0;
        installFakeRpc({
            holderStepCount: 6,
            onCall: (method) => { if (method === "GetAllCascadeTrajectories") getAllCalls++; },
            makeSteps: (offset) => {
                if (offset === 0) return Array.from({ length: 6 }, (_, i) => ({ type: "STEP", idx: i }));
                return [];
            },
        });
        const result = await fetchTrajectory(ID);
        assert.ok(result);
        assert.equal(result!.trajectory.steps.length, 6);
        // Phase 0 探一次持有性(getStepCountLight=GetAllCascadeTrajectories)，fetchFromLs 复用 knownStepCount 不再探。
        // 故 GetAllCascadeTrajectories 仅 Phase 0 探一次（rememberMapping 不发 rpc）。
        assert.equal(getAllCalls, 1, "knownStepCount 应复用，fetchFromLs 不再重复 getStepCountLight");
    }

    // ===== L1 红用例：Phase 0 映射写入用真 transport → 下次快路径 fromMapping=true 真命中 =====
    // L1 修复：fetchTrajectory Phase 0 命中后 rememberMapping 的 transport 用真 rpcCall（而非 placeholder reject）。
    // 旧 placeholder reject：快路径再确认 holds 必失败 → invalidate → 落慢路径 → fromMapping=false（死映射）。
    // 隔离：注入空 enumerator，使慢路径不真跑 PowerShell；回退时 holds 失败落慢路径→no_ls→fromMapping=false（红）。
    {
        clearMappings();
        setHolder();
        if (fs.existsSync(cachePath())) fs.unlinkSync(cachePath());
        // 慢路径兜底：返回空池（回退分支落这里 → no_ls；修复分支走快路径不触发）
        __setEnumeratorForTest(async () => []);
        installFakeRpc({
            holderStepCount: 11,
            makeSteps: (offset) => {
                if (offset === 0) return Array.from({ length: 11 }, (_, i) => ({ type: "STEP", idx: i }));
                return [];
            },
        });
        try {
            // 第一次 fetch 走 Phase 0（parentLs 持有）→ 命中后 rememberMapping 写真 transport
            const first = await fetchTrajectory(ID);
            assert.ok(first, "Phase 0 应读到数据");
            // 直接问路由大脑：映射应能命中并通过 holds 再确认（快路径）
            const resolved = await resolveEndpointForConversation(ID, "antigravity");
            assert.equal(resolved.reason, "ok", "L1：Phase 0 写入的映射应可命中");
            assert.equal(resolved.fromMapping, true, "L1：映射 transport 用真 rpcCall → holds 再确认通过 → 快路径命中（旧 placeholder reject 会失效落慢路径 fromMapping=false）");
            assert.equal(resolved.endpoint?.pid, PID, "L1：命中的是 Phase 0 持有者");
        } finally {
            __setEnumeratorForTest(null);
        }
    }

    // ===== verifyTail 红用例：跨 endpoint + verifyTail 失败 → 强制全量；断言区分 offset 序列 =====
    // 缓存 35 步、currentStepCount=35、endpoint 不一致 → 进 verifyTail（startOffset=35-30=5）。
    // 令 offset=5 那次返回的尾部 step type 与缓存(STEP)不符 → verifyTail 返 false → fallthrough 全量(offset 0 起)。
    // review 缺口：旧测试两种情况都断言 true；这里断言 offset 序列区分 —— verifyTail 拉 startOffset=5，全量拉 0。
    {
        clearMappings();
        setHolder();
        // 缓存来自别的 endpoint（9999:8888），35 步，type=STEP
        writeCache(35, "9999:8888", Array.from({ length: 35 }, (_, i) => `c-${i}`));
        // 重新精确写一份带 type 的缓存（writeCache 的 steps 是 {type:"STEP",...}）
        const offsetSeq: number[] = [];
        installFakeRpc({
            holderStepCount: 35,
            onCall: (method, payload) => {
                if (method === "GetCascadeTrajectorySteps") offsetSeq.push(Number(payload.stepOffset ?? 0));
            },
            makeSteps: (offset) => {
                if (offset === 5) {
                    // verifyTail 拉尾部（从 startOffset=5）→ 故意返回 type 不一致的数据，使 verifyTail 失败
                    return Array.from({ length: 30 }, (_, i) => ({ type: "DIFFERENT", idx: 5 + i }));
                }
                if (offset === 0) {
                    // 全量首页：返回真全量 35 步
                    return Array.from({ length: 35 }, (_, i) => ({ type: "STEP", idx: i, label: `full-${i}` }));
                }
                return [];
            },
        });
        const result = await fetchTrajectory(ID);
        assert.ok(result);
        assert.equal(result!.fromCache, false, "verifyTail 失败 → 不返缓存，走全量");
        assert.equal(result!.trajectory.steps.length, 35, "全量拉到 35 步");
        // 关键：offset 序列必须区分 —— 先 verifyTail 拉 startOffset=5，失败后全量从 offset=0 起。
        assert.ok(offsetSeq.includes(5), "verifyTail 应拉 startOffset=5（cachedLen 35 - TAIL_VERIFY_STEPS 30）");
        assert.ok(offsetSeq.includes(0), "verifyTail 失败后全量应从 offset=0 重新拉");
        const idx5 = offsetSeq.indexOf(5);
        const idx0 = offsetSeq.indexOf(0);
        assert.ok(idx5 >= 0 && idx0 > idx5, "offset 序列顺序：先 verifyTail(5) 后全量(0)，证明确实走了『verifyTail 失败→全量』分支而非直接返缓存");
    }

    console.log("ls-fetch-stale-cache.test.ts PASS");
} finally {
    __setEnumeratorForTest(null);
    __setLsRpcImplForTest(null);
    __setParentLsForTest(null);
    __setConvCacheDirForTest(null);
    clearMappings();
    try { fs.rmSync(cacheDir, { recursive: true, force: true }); } catch { /* ignore */ }
}
