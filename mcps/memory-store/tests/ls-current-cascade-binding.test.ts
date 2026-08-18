import assert from "node:assert/strict";
import { __setLsRpcImplForTest, type LsProcessInfo, type RpcResult } from "../src/ls-rpc.ts";
import {
    getCurrentCascadeId,
    __setParentLsForTest,
} from "../src/ls-client.ts";
import {
    setCurrentContext,
    __setEnumeratorForTest,
    type RouterEndpoint,
    type LsKind,
} from "../src/conversation-router.ts";
import { endpointKey } from "../src/cascade-mapping.ts";

/**
 * 方案 D（失败路径 ③ 闭环）：当前对话绑定。
 *
 * broker 下 parentLs=null，旧逻辑「连第一个 LS 取全局最新对话」会绑错窗口。
 * 修复后 getCurrentCascadeId 先用 ctx 指纹：
 *   conversationId 锚点 → workspaceId 指纹 → parentLs → workspaceRoot 反查 → 显式告警退化 → .pb 猜测。
 *
 * 用 __setEnumeratorForTest 注入活跃 LS、__setLsRpcImplForTest 注入 rpc，离线。
 */

/** 每个 LS 上的对话：cascadeId → {lastModifiedTime, steps(用于 workspace 反查)} */
interface LsData {
    pid: number;
    port: number;
    workspaceId: string;
    convos: Record<string, { time: string; workspaceUri?: string }>;
}

function makeEndpoint(ls: LsData): RouterEndpoint {
    return {
        kind: "antigravity",
        pid: ls.pid,
        port: ls.port,
        csrfToken: `csrf-${ls.pid}`,
        workspaceId: ls.workspaceId,
        key: endpointKey("antigravity", ls.pid, ls.port),
        transport: () => Promise.reject(new Error("not used in this test")),
    };
}

function installLs(pool: LsData[]): void {
    __setEnumeratorForTest(async (kind?: LsKind) => {
        if (kind && kind !== "antigravity") return [];
        return pool.map(makeEndpoint);
    });
    __setLsRpcImplForTest(async (
        lsInfo: LsProcessInfo,
        port: number,
        method: string,
        payload: Record<string, unknown>,
    ): Promise<RpcResult> => {
        const ls = pool.find(x => x.port === port);
        if (!ls) return { status: 500, data: {}, rawSize: 0 };
        if (method === "Heartbeat") return { status: 200, data: {}, rawSize: 2 };
        if (method === "GetAllCascadeTrajectories") {
            const trajectorySummaries: Record<string, any> = {};
            for (const [id, info] of Object.entries(ls.convos)) {
                trajectorySummaries[id] = { cascadeId: id, lastModifiedTime: info.time, stepCount: 1 };
            }
            return { status: 200, data: { trajectorySummaries }, rawSize: 100 };
        }
        if (method === "GetCascadeTrajectorySteps") {
            const cascadeId = String(payload.cascadeId);
            const info = ls.convos[cascadeId];
            const steps = info?.workspaceUri
                ? [{ userInput: { activeUserState: { openDocuments: [{ workspaceUri: info.workspaceUri }] } } }]
                : [];
            return { status: 200, data: { steps }, rawSize: 100 };
        }
        return { status: 404, data: {}, rawSize: 0 };
    });
}

try {
    // ===== 用例 1：conversationId 锚点优先（最准）=====
    {
        setCurrentContext({ conversationId: "anchored-id", workspaceId: undefined, workspaceRoot: undefined });
        __setParentLsForTest(null);
        installLs([{ pid: 1, port: 9001, workspaceId: "wsA", convos: { "global-latest": { time: "2026-06-25T10:00:00Z" } } }]);
        const id = await getCurrentCascadeId();
        assert.equal(id, "anchored-id", "有 conversationId 锚点应直接用，不看 LS 全局最新");
    }

    // ===== 用例 2：broker parentLs=null + workspaceId 指纹 → 命中目标 LS 内取最新（不取全局最新）=====
    {
        setCurrentContext({ conversationId: undefined, workspaceId: "wsTarget", workspaceRoot: undefined });
        __setParentLsForTest(null);
        installLs([
            // 全局最新对话在 wsOther 这台（时间更晚），但当前窗口是 wsTarget
            { pid: 1, port: 9001, workspaceId: "wsOther", convos: { "other-newest": { time: "2026-06-25T23:00:00Z" } } },
            { pid: 2, port: 9002, workspaceId: "wsTarget", convos: {
                "target-old": { time: "2026-06-25T08:00:00Z" },
                "target-new": { time: "2026-06-25T09:00:00Z" },
            } },
        ]);
        const id = await getCurrentCascadeId();
        assert.equal(id, "target-new", "应在 wsTarget LS 内取最新（target-new），而非全局最新 other-newest");
    }

    // ===== M2 红用例：lastModifiedTime 带/不带小数秒混用 → 必须按数值时间选最新，而非字典序 =====
    // 真最新 target-new = ...09.300Z（带小数秒，时间 09:00:09.300）
    // 真更旧 target-old = ...09Z     （整秒，时间 09:00:09.000）
    // 字典序：公共前缀 "...T09:00:09" 后，'.'(0x2E) < 'Z'(0x5A) → 字符串比认为 target-old "更大"=更新（错）。
    // 修复后 latestCascadeOn 用 Date.parse → 选 target-new；回退成字符串比 → 选 target-old（红）。
    {
        setCurrentContext({ conversationId: undefined, workspaceId: "wsFrac", workspaceRoot: undefined });
        __setParentLsForTest(null);
        installLs([
            { pid: 1, port: 9001, workspaceId: "wsFrac", convos: {
                "target-old": { time: "2026-06-25T09:00:09Z" },
                "target-new": { time: "2026-06-25T09:00:09.300Z" },
            } },
        ]);
        const id = await getCurrentCascadeId();
        assert.equal(id, "target-new", "M2：带小数秒的 target-new 才是真最新；字典序会误选整秒的 target-old");
    }

    // ===== 用例 3：parentLs 直连（非 broker 单窗口）取该 LS 最新 =====
    {
        setCurrentContext({ conversationId: undefined, workspaceId: undefined, workspaceRoot: undefined });
        __setParentLsForTest({ info: { pid: 3, csrfToken: "c", workspaceId: "wsP", ports: [9003] }, port: 9003 });
        installLs([
            { pid: 3, port: 9003, workspaceId: "wsP", convos: {
                "p-old": { time: "2026-06-25T01:00:00Z" },
                "p-new": { time: "2026-06-25T05:00:00Z" },
            } },
        ]);
        const id = await getCurrentCascadeId();
        assert.equal(id, "p-new", "parentLs 直连应取其热列表最新");
    }

    // ===== 用例 4：workspaceRoot 反查命中（matchByWorkspaceRoot 落地实现）=====
    {
        setCurrentContext({ conversationId: undefined, workspaceId: undefined, workspaceRoot: "C:/Users/Stardust/Desktop/proj" });
        __setParentLsForTest(null);
        installLs([
            { pid: 1, port: 9001, workspaceId: "ws1", convos: {
                "conv-elsewhere": { time: "2026-06-25T10:00:00Z", workspaceUri: "file:///C:/other/place" },
                "conv-match": { time: "2026-06-25T09:00:00Z", workspaceUri: "file:///C:/Users/Stardust/Desktop/proj" },
            } },
        ]);
        const id = await getCurrentCascadeId();
        assert.equal(id, "conv-match", "workspaceRoot 反查应比对 step workspaceUri 命中 conv-match");
    }

    // ===== 用例 5：指纹全缺 → 显式 ambiguous 告警 + 退化取全局最新（不静默猜，但确有退化）=====
    {
        setCurrentContext({ conversationId: undefined, workspaceId: undefined, workspaceRoot: undefined });
        __setParentLsForTest(null);
        const warnings: string[] = [];
        const origErr = console.error;
        console.error = (...args: any[]) => { warnings.push(args.join(" ")); };
        try {
            installLs([
                { pid: 1, port: 9001, workspaceId: "ws1", convos: { "g1": { time: "2026-06-25T02:00:00Z" } } },
                { pid: 2, port: 9002, workspaceId: "ws2", convos: { "g2": { time: "2026-06-25T20:00:00Z" } } },
            ]);
            const id = await getCurrentCascadeId();
            assert.equal(id, "g2", "退化取全局最新（g2 时间最晚）");
            assert.ok(
                warnings.some(w => /无.*指纹|无法精确绑定|退化/u.test(w)),
                "指纹全缺应显式告警 ambiguous，不静默猜",
            );
        } finally {
            console.error = origErr;
        }
    }

    // ===== 用例 6：无 LS → guessFromPb 兜底（这里无 .pb 真实目录，返回 null 即可，验证不抛）=====
    {
        setCurrentContext({ conversationId: undefined, workspaceId: undefined, workspaceRoot: undefined });
        __setParentLsForTest(null);
        __setEnumeratorForTest(async () => []);
        // 保持 rpc 注入但枚举为空 → 走 guessFromPb（真实反重力 conversations 目录，可能有/无）
        const id = await getCurrentCascadeId();
        assert.ok(id === null || typeof id === "string", "无活跃 LS 时应安全兜底（null 或 .pb 猜测），不抛异常");
    }

    console.log("ls-current-cascade-binding.test.ts PASS");
} finally {
    __setLsRpcImplForTest(null);
    __setParentLsForTest(null);
    __setEnumeratorForTest(null);
    setCurrentContext({ conversationId: undefined, workspaceId: undefined, workspaceRoot: undefined });
}
