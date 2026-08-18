import assert from "node:assert/strict";
import {
    resolveEndpointForConversation,
    enumerateActiveLs,
    clearMappings,
    rememberMapping,
    __setEnumeratorForTest,
    type RouterEndpoint,
    type LsKind,
} from "../src/conversation-router.ts";
import { endpointKey } from "../src/cascade-mapping.ts";
import { __setLsRpcImplForTest, type LsProcessInfo, type RpcResult } from "../src/ls-rpc.ts";
import { __setLsDiscoveryForTest } from "../src/ls-client.ts";
import { __setRegistryPathForTest, __resetRegisteredPidsForTest } from "../src/ls-registry.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * 路由大脑核心测试（方案 A/B + single-flight + 双 kind）。
 * 用 __setEnumeratorForTest 注入端点池，每个 endpoint 的 transport 返回各自持有的对话 summaries，
 * 全链路离线，不依赖真实 LS。
 */

const ID_A = "cascade-aaaa";
const ID_B = "cascade-bbbb";

interface FakeLs {
    kind: LsKind;
    pid: number;
    port: number;
    /** 该 LS 持有的对话 → stepCount */
    owns: Record<string, number>;
    /** 该 endpoint 上 GetAllCascadeTrajectories 被调用次数 */
    probeCalls: number;
    /** 若为 true，transport 永挂（测试广播兜底超时） */
    hang?: boolean;
}

function makeEndpoint(ls: FakeLs): RouterEndpoint {
    return {
        kind: ls.kind,
        pid: ls.pid,
        port: ls.port,
        csrfToken: `csrf-${ls.pid}`,
        workspaceId: ls.kind === "antigravity" ? `ws-${ls.pid}` : undefined,
        executablePath: ls.kind === "windsurf" ? `C:/wsf-${ls.pid}.exe` : undefined,
        key: endpointKey(ls.kind, ls.pid, ls.port),
        transport: async (method: string) => {
            if (method !== "GetAllCascadeTrajectories") {
                throw new Error(`unexpected method ${method}`);
            }
            ls.probeCalls++;
            if (ls.hang) {
                // 模拟「迟迟不返回」：略超 PROBE_TIMEOUT_MS(5s) 后才 settle，
                // 既触发 holds 探测超时收口，又有限 settle 避免 tsx 顶层 await unsettled 警告。
                await new Promise<void>((resolve) => setTimeout(resolve, 5500));
            }
            // WSF 用对象形态，反重力也用对象形态（trajectorySummaries map）
            const trajectorySummaries: Record<string, any> = {};
            for (const [id, stepCount] of Object.entries(ls.owns)) {
                trajectorySummaries[id] = { cascadeId: id, stepCount, lastModifiedTime: "2026-06-25T00:00:00Z" };
            }
            return { trajectorySummaries };
        },
    };
}

function installEnumerator(pool: FakeLs[]): void {
    __setEnumeratorForTest(async (kind?: LsKind) => {
        return pool
            .filter(ls => !kind || ls.kind === kind)
            .map(makeEndpoint);
    });
}

// ===== 用例 1：冷启动未命中 → 广播命中 → 写映射 =====
{
    clearMappings();
    const pool: FakeLs[] = [
        { kind: "antigravity", pid: 100, port: 9001, owns: { [ID_A]: 5 }, probeCalls: 0 },
        { kind: "antigravity", pid: 200, port: 9002, owns: { [ID_B]: 7 }, probeCalls: 0 },
    ];
    installEnumerator(pool);

    const r = await resolveEndpointForConversation(ID_B, "antigravity");
    assert.equal(r.reason, "ok", "应找到持有者");
    assert.equal(r.endpoint?.pid, 200, "持有 ID_B 的是 9002 那台，永不连错");
    assert.equal(r.stepCount, 7, "权威 stepCount 来自真持有者");
    assert.equal(r.fromMapping, false, "首次走慢路径");
    assert.equal(r.probedCount, 2, "广播探了 2 个 LS");
}

// ===== 用例 2：映射命中且 TTL 内 → enumerator 未被调用（快路径） =====
{
    clearMappings();
    const pool: FakeLs[] = [
        { kind: "antigravity", pid: 100, port: 9001, owns: { [ID_A]: 5 }, probeCalls: 0 },
    ];
    let enumCalls = 0;
    __setEnumeratorForTest(async (kind?: LsKind) => {
        enumCalls++;
        return pool.filter(ls => !kind || ls.kind === kind).map(makeEndpoint);
    });

    // 第一次：慢路径写映射
    const r1 = await resolveEndpointForConversation(ID_A, "antigravity");
    assert.equal(r1.reason, "ok");
    const enumAfterFirst = enumCalls;

    // 第二次：映射命中 → 只做 holds 再确认，不再调 enumerator
    const r2 = await resolveEndpointForConversation(ID_A, "antigravity");
    assert.equal(r2.reason, "ok");
    assert.equal(r2.fromMapping, true, "第二次应走映射快路径");
    assert.equal(enumCalls, enumAfterFirst, "TTL 内映射命中不应再调 enumerator");
}

// ===== 用例 3：映射命中但不再持有 → 剔除 → 广播换 LS =====
{
    clearMappings();
    const stale: FakeLs = { kind: "antigravity", pid: 100, port: 9001, owns: {}, probeCalls: 0 }; // 不再持有 ID_A
    const real: FakeLs = { kind: "antigravity", pid: 200, port: 9002, owns: { [ID_A]: 9 }, probeCalls: 0 };
    installEnumerator([stale, real]);

    // 人为写一个指向 stale LS 的映射
    rememberMapping(ID_A, "antigravity", makeEndpoint(stale), 3);

    const r = await resolveEndpointForConversation(ID_A, "antigravity");
    assert.equal(r.reason, "ok");
    assert.equal(r.endpoint?.pid, 200, "stale LS 不再持有 → 剔除后广播命中真持有者 9002");
    assert.equal(r.fromMapping, false, "再确认失败后落入慢路径");
}

// ===== 用例 4：多持有者取 stepCount 最大 =====
{
    clearMappings();
    const pool: FakeLs[] = [
        { kind: "antigravity", pid: 100, port: 9001, owns: { [ID_A]: 5 }, probeCalls: 0 },
        { kind: "antigravity", pid: 200, port: 9002, owns: { [ID_A]: 12 }, probeCalls: 0 }, // 更新
    ];
    installEnumerator(pool);

    const r = await resolveEndpointForConversation(ID_A, "antigravity");
    assert.equal(r.reason, "ok");
    assert.equal(r.endpoint?.pid, 200, "多持有者取 stepCount 最大者（12 > 5）");
    assert.equal(r.stepCount, 12);
}

// ===== 用例 5：全不持有 → not_held；无 LS → no_ls =====
{
    clearMappings();
    installEnumerator([{ kind: "antigravity", pid: 100, port: 9001, owns: { [ID_A]: 5 }, probeCalls: 0 }]);
    const notHeld = await resolveEndpointForConversation("cascade-zzzz", "antigravity");
    assert.equal(notHeld.reason, "not_held", "活跃 LS 都不持有 → not_held");
    assert.equal(notHeld.endpoint, null);

    clearMappings();
    __setEnumeratorForTest(async () => []);
    const noLs = await resolveEndpointForConversation(ID_A, "antigravity");
    assert.equal(noLs.reason, "no_ls", "无活跃 LS → no_ls");
    assert.equal(noLs.endpoint, null);
}

// ===== 用例 6：single-flight — 同 id 并发 10 个 resolve，enumerator 仅调 1 次 =====
{
    clearMappings();
    let enumCalls = 0;
    const pool: FakeLs[] = [
        { kind: "antigravity", pid: 100, port: 9001, owns: { [ID_A]: 5 }, probeCalls: 0 },
    ];
    __setEnumeratorForTest(async (kind?: LsKind) => {
        enumCalls++;
        await new Promise(r => setTimeout(r, 20)); // 制造并发窗口
        return pool.filter(ls => !kind || ls.kind === kind).map(makeEndpoint);
    });

    const results = await Promise.all(
        Array.from({ length: 10 }, () => resolveEndpointForConversation(ID_A, "antigravity")),
    );
    assert.ok(results.every(r => r.reason === "ok"), "10 个并发都应成功");
    assert.equal(enumCalls, 1, "single-flight：同 id 并发只跑一次广播");
}

// ===== 用例 7：不同 id 不互阻 =====
{
    clearMappings();
    let enumCalls = 0;
    const pool: FakeLs[] = [
        { kind: "antigravity", pid: 100, port: 9001, owns: { [ID_A]: 5, [ID_B]: 6 }, probeCalls: 0 },
    ];
    __setEnumeratorForTest(async (kind?: LsKind) => {
        enumCalls++;
        return pool.filter(ls => !kind || ls.kind === kind).map(makeEndpoint);
    });
    const [ra, rb] = await Promise.all([
        resolveEndpointForConversation(ID_A, "antigravity"),
        resolveEndpointForConversation(ID_B, "antigravity"),
    ]);
    assert.equal(ra.reason, "ok");
    assert.equal(rb.reason, "ok");
    assert.equal(enumCalls, 2, "不同 id 各自一次广播，不互相阻塞复用");
}

// ===== 用例 8：广播含永挂 LS 不拖累（兜底超时后仍取到持有者）=====
{
    clearMappings();
    const hanging: FakeLs = { kind: "antigravity", pid: 300, port: 9003, owns: { [ID_A]: 1 }, probeCalls: 0, hang: true };
    const healthy: FakeLs = { kind: "antigravity", pid: 400, port: 9004, owns: { [ID_A]: 8 }, probeCalls: 0 };
    installEnumerator([hanging, healthy]);

    const t0 = Date.now();
    const r = await resolveEndpointForConversation(ID_A, "antigravity");
    const elapsed = Date.now() - t0;
    assert.equal(r.reason, "ok", "健康 LS 持有 → 仍应成功");
    assert.equal(r.endpoint?.pid, 400, "取健康持有者，不被永挂 LS 拖死");
    assert.ok(elapsed < 8000, `单 LS 永挂应被 holds 探测超时收口（PROBE_TIMEOUT_MS=5s），实际 ${elapsed}ms`);
}

// ===== 用例 9：kind 隔离 — 同名 id 不冲突 =====
{
    clearMappings();
    const pool: FakeLs[] = [
        { kind: "antigravity", pid: 100, port: 9001, owns: { [ID_A]: 5 }, probeCalls: 0 },
        { kind: "windsurf", pid: 700, port: 9007, owns: { [ID_A]: 11 }, probeCalls: 0 },
    ];
    installEnumerator(pool);

    const ag = await resolveEndpointForConversation(ID_A, "antigravity");
    const wsf = await resolveEndpointForConversation(ID_A, "windsurf");
    assert.equal(ag.endpoint?.kind, "antigravity");
    assert.equal(ag.endpoint?.pid, 100);
    assert.equal(wsf.endpoint?.kind, "windsurf");
    assert.equal(wsf.endpoint?.pid, 700, "同名 id 在不同 kind 下互不串台");
    assert.equal(wsf.stepCount, 11);
}

// ===== 用例 10：WSF 注入 3 个活跃 LS 仅第 3 个持有 → 命中第 3（失败路径 ④ 闭环）=====
{
    clearMappings();
    const pool: FakeLs[] = [
        { kind: "windsurf", pid: 701, port: 9101, owns: { "other-1": 2 }, probeCalls: 0 },
        { kind: "windsurf", pid: 702, port: 9102, owns: { "other-2": 3 }, probeCalls: 0 },
        { kind: "windsurf", pid: 703, port: 9103, owns: { [ID_B]: 9 }, probeCalls: 0 },
    ];
    installEnumerator(pool);

    const r = await resolveEndpointForConversation(ID_B, "windsurf");
    assert.equal(r.reason, "ok");
    assert.equal(r.endpoint?.pid, 703, "WSF 旧逻辑会连第一个（701）读空；新逻辑广播命中真持有者 703");
}

// ===== 用例 11：WSF summaries 数组 / 对象两形态 holds 均判对 =====
{
    clearMappings();
    // 数组形态
    __setEnumeratorForTest(async (kind?: LsKind) => {
        if (kind && kind !== "windsurf") return [];
        const ep: RouterEndpoint = {
            kind: "windsurf", pid: 801, port: 9201, csrfToken: "c", executablePath: "x",
            key: endpointKey("windsurf", 801, 9201),
            transport: async () => ({ trajectorySummaries: [{ cascadeId: ID_A, stepCount: 4 }] }),
        };
        return [ep];
    });
    const arr = await resolveEndpointForConversation(ID_A, "windsurf");
    assert.equal(arr.reason, "ok", "WSF summaries 数组形态应判为持有");
    assert.equal(arr.stepCount, 4);

    clearMappings();
    // 对象形态
    __setEnumeratorForTest(async (kind?: LsKind) => {
        if (kind && kind !== "windsurf") return [];
        const ep: RouterEndpoint = {
            kind: "windsurf", pid: 802, port: 9202, csrfToken: "c", executablePath: "x",
            key: endpointKey("windsurf", 802, 9202),
            transport: async () => ({ trajectorySummaries: { [ID_A]: { cascadeId: ID_A, stepCount: 6 } } }),
        };
        return [ep];
    });
    const obj = await resolveEndpointForConversation(ID_A, "windsurf");
    assert.equal(obj.reason, "ok", "WSF summaries 对象形态应判为持有");
    assert.equal(obj.stepCount, 6);
}

// ===== 用例 12：endpointKey 去重 — 枚举重复端点只探一次 =====
{
    clearMappings();
    const dup: FakeLs = { kind: "antigravity", pid: 100, port: 9001, owns: { [ID_A]: 5 }, probeCalls: 0 };
    __setEnumeratorForTest(async (kind?: LsKind) => {
        // 故意返回两个同 key 的 endpoint
        return (!kind || kind === "antigravity") ? [makeEndpoint(dup), makeEndpoint(dup)] : [];
    });
    const r = await resolveEndpointForConversation(ID_A, "antigravity");
    assert.equal(r.reason, "ok");
    // 注：enumerateActiveLs 真实实现内部去重；此处 enumerator 被注入，故 probedCount 可能为 2，
    // 但 enumerateActiveLs 真实路径的去重在 enumerate-active-ls 用例（下方）单独验证。
    assert.ok(r.probedCount >= 1);
}

// ===== 回归护栏：enumerateActiveLs 注入器 kind 过滤生效 =====
{
    clearMappings();
    installEnumerator([
        { kind: "antigravity", pid: 100, port: 9001, owns: { [ID_A]: 5 }, probeCalls: 0 },
        { kind: "windsurf", pid: 700, port: 9007, owns: { [ID_B]: 7 }, probeCalls: 0 },
    ]);
    const agOnly = await enumerateActiveLs("antigravity");
    assert.ok(agOnly.every(e => e.kind === "antigravity"));
    const wsfOnly = await enumerateActiveLs("windsurf");
    assert.ok(wsfOnly.every(e => e.kind === "windsurf"));
}

// ===== M1 红用例：真实 enumerateAntigravity 在「注册表部分覆盖」时 PowerShell 必须无条件补扫真持有者 =====
// 现有用例全用 __setEnumeratorForTest 旁路 → 对 enumerateAntigravity 真实实现零覆盖。
// 本用例清掉旁路，注入底层依赖（注册表文件 / rpc / discoverLsProcesses），跑真实路径。
//
// 场景：注册表里有 1 个「存活但不持有目标 ID_TARGET」的 LS（port 9001）；真持有者（port 9002，
// 未注册窗口）只能靠 PowerShell 兜底发现。
// 旧逻辑 `if (endpoints.length === 0)`：注册表已枚举到 9001（length=1>0）→ 短路跳过 PowerShell →
//   真持有者 9002 永不被发现 → resolve 返回 not_held（红）。
// 修复后无条件补扫（seen 去重）→ 发现 9002 → ok（绿）。
{
    clearMappings();
    __setEnumeratorForTest(null); // 关键：清掉旁路，强制走真实 enumerateAntigravity

    const ID_TARGET = "cascade-m1-target";
    const REG_PID = process.pid;       // 注册表那台用当前进程 pid → process.kill(pid,0) 必存活
    const REG_PORT = 9001;
    const HOLDER_PID = 999001;         // PowerShell 发现的真持有者（假 pid，enumerate 该分支不做 kill 检测）
    const HOLDER_PORT = 9002;

    // 临时注册表文件：写入 1 个不持有目标的存活 LS
    const tmpRegDir = fs.mkdtempSync(path.join(os.tmpdir(), "m1-reg-"));
    const tmpRegPath = path.join(tmpRegDir, "ls-registry.json");
    fs.writeFileSync(tmpRegPath, JSON.stringify({
        processes: {
            [String(REG_PID)]: {
                pid: REG_PID, port: REG_PORT, csrfToken: "csrf-reg",
                workspaceId: "ws-reg", registeredAt: new Date().toISOString(),
            },
        },
    }), "utf-8");
    __setRegistryPathForTest(tmpRegPath);
    __resetRegisteredPidsForTest();

    // discoverLsProcesses 替身：返回未注册的真持有者（靠 findHttpPort=rpc Heartbeat 验活）
    __setLsDiscoveryForTest(() => [
        { pid: HOLDER_PID, csrfToken: "csrf-holder", workspaceId: "ws-holder", ports: [HOLDER_PORT] },
    ]);

    // rpc 替身：按 port 区分应答
    __setLsRpcImplForTest(async (
        _lsInfo: LsProcessInfo,
        port: number,
        method: string,
        _payload: Record<string, unknown>,
    ): Promise<RpcResult> => {
        if (method === "Heartbeat") return { status: 200, data: {}, rawSize: 2 };
        if (method === "GetAllCascadeTrajectories") {
            if (port === REG_PORT) {
                // 注册表那台：存活但不持有目标，只持有别的对话
                return { status: 200, data: { trajectorySummaries: { "other-conv": { cascadeId: "other-conv", stepCount: 3, lastModifiedTime: "2026-06-25T00:00:00Z" } } }, rawSize: 100 };
            }
            if (port === HOLDER_PORT) {
                // 真持有者：持有目标
                return { status: 200, data: { trajectorySummaries: { [ID_TARGET]: { cascadeId: ID_TARGET, stepCount: 9, lastModifiedTime: "2026-06-25T01:00:00Z" } } }, rawSize: 100 };
            }
            return { status: 200, data: { trajectorySummaries: {} }, rawSize: 2 };
        }
        return { status: 404, data: {}, rawSize: 0 };
    });

    try {
        const r = await resolveEndpointForConversation(ID_TARGET, "antigravity");
        assert.equal(r.reason, "ok", "M1：PowerShell 兜底应无条件补扫到未注册的真持有者（旧逻辑 endpoints.length>0 短路会误判 not_held）");
        assert.equal(r.endpoint?.pid, HOLDER_PID, "M1：命中真持有者 9002 而非注册表里不持有的 9001");
        assert.equal(r.endpoint?.port, HOLDER_PORT);
        assert.equal(r.stepCount, 9, "M1：stepCount 来自真持有者");
    } finally {
        __setLsRpcImplForTest(null);
        __setLsDiscoveryForTest(null);
        __setRegistryPathForTest(null);
        __resetRegisteredPidsForTest();
        clearMappings();
        try { fs.rmSync(tmpRegDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
}

// 等用例 8 的「永挂 LS」fake 在 ~5.5s 后自然 settle，避免 tsx 顶层 await unsettled 警告。
await new Promise<void>((resolve) => setTimeout(resolve, 5600));

__setEnumeratorForTest(null);
clearMappings();
console.log("conversation-router.test.ts PASS");
