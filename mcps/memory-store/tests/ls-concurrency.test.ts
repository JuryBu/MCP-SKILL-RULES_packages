import assert from "node:assert/strict";
import {
    __setBroadcastOverallTimeoutForTest,
    __setEnumeratorForTest,
    clearMappings,
    resolveEndpointForConversation,
    type RouterEndpoint,
} from "../src/conversation-router.ts";
import {
    __getWindsurfLsGateStatsForTest,
    __resetWindsurfConversationCacheForTest,
    __resetWindsurfEndpointCacheForTest,
    __resetWindsurfLsGateStatsForTest,
    __setWindsurfEndpointResolverForTest,
    __setWindsurfTransportFactoryForTest,
    createWindsurfLsTransport,
    loadWindsurfConversation,
    makeWindsurfTransport,
    type WindsurfLsEndpoint,
    type WindsurfLsTransport,
    type WindsurfLsTransportDiagnostics,
} from "../src/windsurf-client.ts";
import { FifoConcurrencyGate } from "../src/concurrency-gate.ts";
import { loadConversationData } from "../src/conversation-bridge.ts";

type Deferred<T = void> = {
    promise: Promise<T>;
    resolve: (value: T | PromiseLike<T>) => void;
    reject: (reason?: unknown) => void;
};

type CacheFixture = {
    summaryStepCount: number;
    steps: Array<Record<string, unknown>>;
};

type CacheState = {
    pageSize: number;
    cascades: Record<string, CacheFixture>;
};

type CacheCounters = {
    listCalls: number;
    stepCalls: number;
};

function deferred<T = void>(): Deferred<T> {
    let resolve!: Deferred<T>["resolve"];
    let reject!: Deferred<T>["reject"];
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_500, intervalMs = 10): Promise<void> {
    const startedAt = Date.now();
    while (!predicate()) {
        if (Date.now() - startedAt > timeoutMs) {
            throw new Error(`waitFor timeout after ${timeoutMs}ms`);
        }
        await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
}

function endpoint(pid: number, port: number): WindsurfLsEndpoint {
    return {
        pid,
        port,
        csrfToken: `csrf-${pid}`,
        executablePath: `C:\\Program Files\\Windsurf\\language_server_windows_x64-${pid}.exe`,
    };
}

function createSteps(prefix: string, rounds: number): Array<Record<string, unknown>> {
    const steps: Array<Record<string, unknown>> = [];
    for (let index = 0; index < rounds; index++) {
        steps.push({
            type: "CORTEX_STEP_TYPE_USER_INPUT",
            userInput: { userResponse: `${prefix}-user-${index + 1}` },
        });
        steps.push({
            type: "CORTEX_STEP_TYPE_PLANNER_RESPONSE",
            plannerResponse: { response: `${prefix}-assistant-${index + 1}` },
        });
    }
    return steps;
}

function resetAll(): void {
    __setBroadcastOverallTimeoutForTest(null);
    __setEnumeratorForTest(null);
    __setWindsurfEndpointResolverForTest(null);
    __setWindsurfTransportFactoryForTest(null);
    __resetWindsurfConversationCacheForTest();
    __resetWindsurfEndpointCacheForTest();
    __resetWindsurfLsGateStatsForTest();
    clearMappings();
}

function installCacheHarness(
    state: CacheState,
    fakeEndpoint = endpoint(701, 14701),
    requestClasses?: Map<string, Array<string | undefined>>,
): CacheCounters {
    const counters: CacheCounters = { listCalls: 0, stepCalls: 0 };
    const transport: WindsurfLsTransport = async (method, payload = {}, options = {}) => {
        if (method === "GetAllCascadeTrajectories") {
            counters.listCalls += 1;
            if (requestClasses) {
                const observed = requestClasses.get("__list__") || [];
                observed.push(options.requestClass);
                requestClasses.set("__list__", observed);
            }
            return {
                trajectorySummaries: Object.fromEntries(
                    Object.entries(state.cascades).map(([cascadeId, fixture]) => [
                        cascadeId,
                        {
                            summary: `${cascadeId} summary`,
                            renamedTitle: `${cascadeId} title`,
                            stepCount: fixture.summaryStepCount,
                            lastModifiedTime: "2026-07-10T00:00:00Z",
                        },
                    ]),
                ),
            };
        }
        if (method === "GetCascadeTrajectorySteps") {
            counters.stepCalls += 1;
            const cascadeId = String(payload.cascadeId || "");
            if (requestClasses) {
                const observed = requestClasses.get(cascadeId) || [];
                observed.push(options.requestClass);
                requestClasses.set(cascadeId, observed);
            }
            const offset = Number(payload.stepOffset || 0);
            const fixture = state.cascades[cascadeId];
            assert.ok(fixture, `missing fixture for ${cascadeId}`);
            return {
                steps: fixture.steps.slice(offset, offset + state.pageSize),
            };
        }
        if (method === "Heartbeat") return { ok: true };
        throw new Error(`unexpected method ${method}`);
    };

    __setWindsurfTransportFactoryForTest(() => transport);
    const gatedTransport = makeWindsurfTransport(fakeEndpoint);
    const routerEndpoint: RouterEndpoint = {
        kind: "windsurf",
        pid: fakeEndpoint.pid,
        port: fakeEndpoint.port,
        csrfToken: fakeEndpoint.csrfToken,
        executablePath: fakeEndpoint.executablePath,
        key: `windsurf:${fakeEndpoint.pid}:${fakeEndpoint.port}`,
        transport: (method, payload = {}, timeoutMsOrOptions) => gatedTransport(
            method,
            payload,
            typeof timeoutMsOrOptions === "number" ? { timeoutMs: timeoutMsOrOptions } : timeoutMsOrOptions,
        ),
    };

    __setWindsurfEndpointResolverForTest(async () => [fakeEndpoint]);
    __setEnumeratorForTest(async kind => kind === "windsurf" ? [routerEndpoint] : []);
    __resetWindsurfConversationCacheForTest();
    __resetWindsurfEndpointCacheForTest();
    __resetWindsurfLsGateStatsForTest();
    clearMappings();
    return counters;
}

const originalEnv = {
    concurrency: process.env.MEMORY_STORE_WINDSURF_LS_CONCURRENCY,
    reservedSlots: process.env.MEMORY_STORE_WINDSURF_LS_RESERVED_SLOTS,
    cacheTtl: process.env.MEMORY_STORE_WINDSURF_CACHE_TTL_MS,
    cacheRevalidate: process.env.MEMORY_STORE_WINDSURF_CACHE_REVALIDATE_MS,
    probeTimeout: process.env.MEMORY_STORE_ROUTER_PROBE_TIMEOUT_MS,
};

try {
    {
        delete process.env.MEMORY_STORE_WINDSURF_LS_CONCURRENCY;
        delete process.env.MEMORY_STORE_WINDSURF_LS_RESERVED_SLOTS;
        resetAll();
        const stats = __getWindsurfLsGateStatsForTest();
        assert.equal(stats.current, 1, "WSF LS AIMD 应从保守并发 1 起步");
        assert.equal(stats.max, 6, "未配置时 WSF LS AIMD 上限应为 6");
        assert.equal(stats.min, 1);
        assert.equal(stats.configuredReserved, 2, "未配置时应保留 2 个前台槽位");
        assert.equal(stats.effectiveReserved, 0, "AIMD 初始窗口为 1 时保留槽必须动态钳制为 0");
    }

    {
        const cases = [
            { value: "NaN", expectedMax: 6, description: "NaN 应回退默认上限" },
            { value: "Infinity", expectedMax: 6, description: "Infinity 应回退默认上限" },
            { value: "0", expectedMax: 6, description: "0 应回退默认上限" },
            { value: "-3", expectedMax: 6, description: "负数应回退默认上限" },
            { value: "2.9", expectedMax: 2, description: "小数上限应归一化为整数窗口" },
            { value: "0.9", expectedMax: 6, description: "小数上限低于初始窗口时应回退安全默认值" },
        ];
        for (const testCase of cases) {
            process.env.MEMORY_STORE_WINDSURF_LS_CONCURRENCY = testCase.value;
            resetAll();
            const stats = __getWindsurfLsGateStatsForTest();
            assert.equal(stats.max, testCase.expectedMax, testCase.description);
            assert.equal(stats.current, 1, `${testCase.description}：初始窗口应保持 1`);
            assert.equal(stats.min, 1, `${testCase.description}：最小窗口应保持 1`);
        }
    }

    {
        const requestClasses = new Map<string, Array<string | undefined>>();
        const state: CacheState = {
            pageSize: 8,
            cascades: {
                "bridge-background": { summaryStepCount: 2, steps: createSteps("bridge-background", 1) },
                "bridge-foreground": { summaryStepCount: 2, steps: createSteps("bridge-foreground", 1) },
            },
        };
        installCacheHarness(state, endpoint(709, 14709), requestClasses);
        const background = await loadConversationData("windsurf", "bridge-background", {
            link: "summary",
            requestClass: "background",
        });
        assert.ok(background, "bridge should load background Windsurf work through the real LS transport");
        assert.ok(
            requestClasses.get("bridge-background")?.every(requestClass => requestClass === "background"),
            "bridge requestClass must reach every background LS step request",
        );
        assert.ok(
            requestClasses.get("__list__")?.every(requestClass => requestClass === "background"),
            `bridge requestClass must also reach endpoint ownership probes: ${JSON.stringify(requestClasses.get("__list__"))}`,
        );

        const foreground = await loadConversationData("windsurf", "bridge-foreground", { link: "summary" });
        assert.ok(foreground, "ordinary Windsurf reads should load through the same bridge");
        assert.ok(
            requestClasses.get("bridge-foreground")?.every(requestClass => requestClass === "foreground"),
            "ordinary bridge reads must retain the foreground default at the LS gate",
        );
    }

    {
        const cases = [
            { value: "NaN", expected: 2, description: "NaN 应回退默认保留槽" },
            { value: "Infinity", expected: 2, description: "Infinity 应回退默认保留槽" },
            { value: "-1", expected: 2, description: "负数应回退默认保留槽" },
            { value: "0", expected: 0, description: "0 应允许关闭保留槽" },
            { value: "2.9", expected: 2, description: "小数保留槽应归一化为整数" },
        ];
        for (const testCase of cases) {
            process.env.MEMORY_STORE_WINDSURF_LS_RESERVED_SLOTS = testCase.value;
            resetAll();
            const stats = __getWindsurfLsGateStatsForTest();
            assert.equal(stats.configuredReserved, testCase.expected, testCase.description);
            assert.equal(stats.effectiveReserved, 0, `${testCase.description}：窗口为 1 时不得留下不可用保留槽`);
        }
    }

    {
        const gate = new FifoConcurrencyGate(() => 1);
        const blocker = await gate.acquire();
        const rejected = await Promise.all(Array.from({ length: 25 }, () => (
            gate.acquire({ timeoutMs: 30, timeoutMessage: "test waiter timeout" }).then(
                () => false,
                error => /test waiter timeout/u.test(String(error)),
            )
        )));
        assert.ok(rejected.every(Boolean));
        assert.equal(gate.stats().pending, 0);
        assert.equal(
            (gate as unknown as { queue: unknown[] }).queue.length,
            0,
            "已拒绝 waiter 必须从内部 FIFO 队列移除，不能积累隐藏 tombstone",
        );
        blocker.release();
        assert.equal(gate.stats().active, 0);

        const cancellationGate = new FifoConcurrencyGate(() => 1);
        const cancellationBlocker = await cancellationGate.acquire();
        let cancelled = false;
        const cancelledWaiters = Array.from({ length: 10_000 }, () => (
            cancellationGate.acquire({
                shouldCancel: () => cancelled,
                cancelMessage: "bulk cancellation",
            }).then(
                () => false,
                error => /bulk cancellation/u.test(String(error)),
            )
        ));
        cancelled = true;
        cancellationBlocker.release();
        assert.ok((await Promise.all(cancelledWaiters)).every(Boolean));
        assert.equal(cancellationGate.stats().active, 0);
        assert.equal(cancellationGate.stats().pending, 0);
        assert.equal(
            (cancellationGate as unknown as { queue: unknown[] }).queue.length,
            0,
            "批量同步取消应由单次 pump 循环排空，不能递归栈溢出",
        );
    }

    {
        let currentLimit = 6;
        const gate = new FifoConcurrencyGate(() => currentLimit, { reservedSlots: 2 });
        const heldBackground = await Promise.all(Array.from({ length: 6 }, () => gate.acquire({ requestClass: "background" })));
        assert.equal(gate.stats().activeBackground, 6);
        assert.equal(gate.stats().effectiveReserved, 2);
        assert.equal(gate.stats().borrowing, true, "前台无等待时后台应能借满 6 个槽位");

        const started: string[] = [];
        const queuedBackground = ["background-7", "background-8"].map(label => (
            gate.acquire({ requestClass: "background" }).then(permit => {
                started.push(label);
                return permit;
            })
        ));
        const queuedForeground = ["foreground-1", "foreground-2"].map(label => (
            gate.acquire({ requestClass: "foreground" }).then(permit => {
                started.push(label);
                return permit;
            })
        ));
        await waitFor(() => gate.stats().pendingForeground === 2 && gate.stats().pendingBackground === 2);

        heldBackground[0].release();
        await waitFor(() => started.length === 1);
        assert.equal(started[0], "foreground-1", "后台借用时，下一次释放必须先放行最早前台");
        const foregroundOne = await queuedForeground[0];

        heldBackground[1].release();
        await waitFor(() => started.length === 2);
        assert.equal(started[1], "foreground-2", "前台内部必须保持 FIFO");
        const foregroundTwo = await queuedForeground[1];

        foregroundOne.release();
        await waitFor(() => started.length === 3);
        assert.equal(started[2], "background-7", "前台排空后后台应恢复同类 FIFO");
        const backgroundSeven = await queuedBackground[0];

        foregroundTwo.release();
        await waitFor(() => started.length === 4);
        assert.equal(started[3], "background-8", "后台内部不得被较晚请求越过");
        const backgroundEight = await queuedBackground[1];

        backgroundSeven.release();
        backgroundEight.release();
        for (const permit of heldBackground.slice(2)) permit.release();
        await waitFor(() => gate.stats().active === 0 && gate.stats().pending === 0);

        const dynamicGate = new FifoConcurrencyGate(() => currentLimit, { reservedSlots: 2 });
        const dynamicBackground = await dynamicGate.acquire({ requestClass: "background" });
        currentLimit = 3;
        dynamicGate.notifyCapacityIncrease();
        assert.equal(dynamicGate.stats().effectiveReserved, 2, "6→3 后有效保留槽应保持在合法范围");
        currentLimit = 1;
        dynamicGate.notifyCapacityIncrease();
        assert.equal(dynamicGate.stats().effectiveReserved, 0, "缩到 1 时有效保留槽必须钳制为 0");
        const waitingForeground = dynamicGate.acquire({ requestClass: "foreground" });
        dynamicBackground.release();
        const dynamicForeground = await waitingForeground;
        assert.equal(dynamicGate.stats().activeForeground, 1, "缩限后前台仍必须可被放行，不能死锁");
        dynamicForeground.release();

        const cancellationGate = new FifoConcurrencyGate(() => 1, { reservedSlots: 1 });
        const cancellationBlocker = await cancellationGate.acquire({ requestClass: "background" });
        let cancelled = false;
        const cancelledWaiters = ["foreground", "background"].map(requestClass => (
            cancellationGate.acquire({
                requestClass: requestClass as "foreground" | "background",
                shouldCancel: () => cancelled,
                cancelMessage: `${requestClass} cancellation`,
            }).then(
                () => false,
                error => new RegExp(`${requestClass} cancellation`, "u").test(String(error)),
            )
        ));
        cancelled = true;
        cancellationBlocker.release();
        assert.ok((await Promise.all(cancelledWaiters)).every(Boolean));
        assert.equal(cancellationGate.stats().pendingForeground, 0);
        assert.equal(cancellationGate.stats().pendingBackground, 0);
        assert.equal((cancellationGate as unknown as { queue: unknown[] }).queue.length, 0, "分类取消后不得留下幽灵队列项");

        for (const limit of [2, 1]) {
            const priorityGate = new FifoConcurrencyGate(() => limit, { reservedSlots: 1 });
            const activeForeground = await Promise.all(
                Array.from({ length: limit }, () => priorityGate.acquire({ requestClass: "foreground" })),
            );
            const started: string[] = [];
            const earlierBackground = priorityGate.acquire({ requestClass: "background" }).then(permit => {
                started.push("background");
                return permit;
            });
            const laterForeground = priorityGate.acquire({ requestClass: "foreground" }).then(permit => {
                started.push("foreground");
                return permit;
            });
            await waitFor(() => priorityGate.stats().pendingForeground === 1 && priorityGate.stats().pendingBackground === 1);

            activeForeground[0].release();
            await waitFor(() => started.length === 1);
            assert.equal(
                started[0],
                "foreground",
                `reservedSlots=1, limit=${limit} must give the next released slot to later foreground work even when an earlier background waiter exists`,
            );

            const foregroundPermit = await laterForeground;
            foregroundPermit.release();
            await waitFor(() => started.length === 2);
            assert.equal(started[1], "background", `background work must resume after foreground drains at limit=${limit}`);
            const backgroundPermit = await earlierBackground;
            backgroundPermit.release();
            for (const permit of activeForeground.slice(1)) permit.release();
            await waitFor(() => priorityGate.stats().active === 0 && priorityGate.stats().pending === 0);
        }
    }

    {
        process.env.MEMORY_STORE_WINDSURF_LS_CONCURRENCY = "3";
        resetAll();

        const started: number[] = [];
        const diagnostics = new Map<number, WindsurfLsTransportDiagnostics>();
        const blockers = new Map<number, Deferred<void>>();
        let active = 0;
        let peakActive = 0;

        __setWindsurfTransportFactoryForTest((): WindsurfLsTransport => async (method, payload = {}) => {
            assert.equal(method, "GetCascadeTrajectorySteps");
            const offset = Number(payload.stepOffset ?? -1);
            started.push(offset);
            active += 1;
            peakActive = Math.max(peakActive, active);
            if (offset > 0) {
                const blocker = deferred<void>();
                blockers.set(offset, blocker);
                await blocker.promise;
            }
            active -= 1;
            return { steps: [] };
        });

        const transport = makeWindsurfTransport(endpoint(610, 14610));
        await transport(
            "GetCascadeTrajectorySteps",
            { cascadeId: "aimd-growth", stepOffset: 0 },
            { onConcurrencyEvent: item => diagnostics.set(0, item) },
        );
        const grownCalls = [1, 2].map(offset => transport(
            "GetCascadeTrajectorySteps",
            { cascadeId: "aimd-growth", stepOffset: offset },
            { onConcurrencyEvent: item => diagnostics.set(offset, item) },
        ));
        await waitFor(() => started.length === 3);
        assert.equal(peakActive, 2, "AIMD 以初始并发 1 起步，首次成功后才扩到 2");
        blockers.get(1)?.resolve();
        blockers.get(2)?.resolve();
        await Promise.all(grownCalls);

        const stats = __getWindsurfLsGateStatsForTest();
        assert.deepEqual(started.sort((left, right) => left - right), [0, 1, 2]);
        assert.equal(diagnostics.get(0)?.current, 1);
        assert.equal(diagnostics.get(0)?.max, 3);
        assert.equal(diagnostics.get(0)?.min, 1);
        assert.equal(diagnostics.get(1)?.current, 2);
        assert.equal(diagnostics.get(2)?.current, 2);
        assert.equal(stats.current, 3, "旧环境变量数值应作为 AIMD 上限兼容使用");
        assert.equal(stats.max, 3);
        assert.equal(stats.min, 1);
        assert.equal(stats.successes, 3);
        assert.equal(stats.failures, 0);
        assert.ok(stats.peakActive <= 2);
        assert.equal(stats.active, 0);
        assert.equal(stats.pending, 0);
        assert.equal(stats.acquireCount, 3);
    }

    {
        process.env.MEMORY_STORE_WINDSURF_LS_CONCURRENCY = "4";
        resetAll();

        type FetchMode = "success" | "rate-limit" | "server-error" | "client-error" | "parse-error" | "network" | "partial-network" | "timeout" | "cancel";
        let fetchMode: FetchMode = "success";
        const originalFetch = globalThis.fetch;
        globalThis.fetch = async (_input, init) => {
            if (fetchMode === "success") return new Response(JSON.stringify({ steps: [] }), { status: 200 });
            if (fetchMode === "rate-limit") return new Response("slow down", { status: 429 });
            if (fetchMode === "server-error") return new Response("unavailable", { status: 503 });
            if (fetchMode === "client-error") return new Response("invalid request", { status: 400 });
            if (fetchMode === "parse-error") return new Response("{invalid-json", { status: 200 });
            if (fetchMode === "network") throw new Error("socket disconnected before response");
            if (fetchMode === "partial-network") {
                const encoder = new TextEncoder();
                const body = new ReadableStream<Uint8Array>({
                    start(controller) {
                        controller.enqueue(encoder.encode("{\"steps\":"));
                        controller.error(new Error("socket disconnected during response"));
                    },
                });
                return new Response(body, { status: 200 });
            }
            return await new Promise<Response>((_resolve, reject) => {
                init?.signal?.addEventListener("abort", () => {
                    const error = new Error(fetchMode === "cancel" ? "cancelled" : "aborted");
                    error.name = "AbortError";
                    reject(error);
                }, { once: true });
            });
        };

        try {
            const transport = createWindsurfLsTransport(endpoint(613, 14613));
            let successDiagnostics: WindsurfLsTransportDiagnostics | undefined;
            await transport("GetCascadeTrajectorySteps", { cascadeId: "aimd-outcomes", stepOffset: 0 }, {
                onConcurrencyEvent: diagnostics => { successDiagnostics = diagnostics; },
            });
            let stats = __getWindsurfLsGateStatsForTest();
            assert.equal(successDiagnostics?.limit, successDiagnostics?.current, "limit 应继续表示当前 AIMD 窗口");
            assert.equal(successDiagnostics?.successes, 0, "反馈必须在真实 raw transport 成功后发生");
            assert.equal(successDiagnostics?.failures, 0);
            assert.equal(stats.current, 2, "真实 raw transport 成功应增长 AIMD 窗口");
            assert.equal(stats.successes, 1);

            fetchMode = "rate-limit";
            let rateLimitDiagnostics: WindsurfLsTransportDiagnostics | undefined;
            await assert.rejects(
                transport("GetCascadeTrajectorySteps", { cascadeId: "aimd-outcomes", stepOffset: 429 }, {
                    onConcurrencyEvent: diagnostics => { rateLimitDiagnostics = diagnostics; },
                }),
                /HTTP 429/u,
            );
            stats = __getWindsurfLsGateStatsForTest();
            assert.equal(rateLimitDiagnostics?.failures, 0, "失败反馈不得在请求发出前记入诊断");
            assert.equal(stats.current, 1, "HTTP 429 应回退 AIMD 窗口");
            assert.equal(stats.failures, 1);

            fetchMode = "server-error";
            await assert.rejects(transport("GetCascadeTrajectorySteps", { cascadeId: "aimd-outcomes", stepOffset: 503 }), /HTTP 503/u);
            stats = __getWindsurfLsGateStatsForTest();
            assert.equal(stats.failures, 2, "HTTP 500-599 应记为 server_error");

            fetchMode = "client-error";
            await assert.rejects(transport("GetCascadeTrajectorySteps", { cascadeId: "aimd-outcomes", stepOffset: 400 }), /HTTP 400/u);
            stats = __getWindsurfLsGateStatsForTest();
            assert.equal(stats.failures, 2, "HTTP 4xx 不得回退 AIMD 窗口");

            fetchMode = "parse-error";
            await assert.rejects(transport("GetCascadeTrajectorySteps", { cascadeId: "aimd-outcomes", stepOffset: 401 }), /JSON/u);
            stats = __getWindsurfLsGateStatsForTest();
            assert.equal(stats.failures, 2, "解析错误不得回退 AIMD 窗口");

            fetchMode = "network";
            await assert.rejects(transport("GetCascadeTrajectorySteps", { cascadeId: "aimd-outcomes", stepOffset: 402 }), /socket disconnected before response/u);
            stats = __getWindsurfLsGateStatsForTest();
            assert.equal(stats.failures, 3, "拿到响应前的网络错误应回退 AIMD 窗口");

            fetchMode = "partial-network";
            await assert.rejects(transport("GetCascadeTrajectorySteps", { cascadeId: "aimd-outcomes", stepOffset: 403 }), /socket disconnected during response/u);
            stats = __getWindsurfLsGateStatsForTest();
            assert.equal(stats.failures, 4, "部分响应数据后断连应记为网络错误");

            const keepAlive = setInterval(() => {}, 1_000);
            try {
                fetchMode = "timeout";
                await assert.rejects(
                    transport("GetCascadeTrajectorySteps", { cascadeId: "aimd-outcomes", stepOffset: 404 }, { timeoutMs: 30 }),
                    /timed out after/u,
                );
                stats = __getWindsurfLsGateStatsForTest();
                assert.equal(stats.failures, 5, "真实请求超时应回退 AIMD 窗口");

                fetchMode = "cancel";
                let cancelled = false;
                setTimeout(() => { cancelled = true; }, 5);
                await assert.rejects(
                    transport("GetCascadeTrajectorySteps", { cascadeId: "aimd-outcomes", stepOffset: 405 }, {
                        timeoutMs: 200,
                        shouldCancel: () => cancelled,
                        cancelMessage: "raw request cancelled",
                    }),
                    /raw request cancelled/u,
                );
                stats = __getWindsurfLsGateStatsForTest();
                assert.equal(stats.failures, 5, "已开始的取消请求不得回退 AIMD 窗口");
            } finally {
                clearInterval(keepAlive);
            }
        } finally {
            globalThis.fetch = originalFetch;
        }

        __setWindsurfTransportFactoryForTest((): WindsurfLsTransport => async () => {
            throw new Error("opaque raw transport error");
        });
        await assert.rejects(
            makeWindsurfTransport(endpoint(614, 14614))("GetCascadeTrajectorySteps", { cascadeId: "aimd-outcomes", stepOffset: 406 }),
            /opaque raw transport error/u,
        );
        const stats = __getWindsurfLsGateStatsForTest();
        assert.equal(stats.failures, 5, "unknown outcome 不得回退 AIMD 窗口");
    }

    {
        process.env.MEMORY_STORE_WINDSURF_LS_CONCURRENCY = "1";
        resetAll();

        const started: number[] = [];
        const blocker = deferred<void>();

        __setWindsurfTransportFactoryForTest((): WindsurfLsTransport => async (method, payload = {}) => {
            assert.equal(method, "GetCascadeTrajectorySteps");
            const offset = Number(payload.stepOffset ?? -1);
            started.push(offset);
            if (offset === 500) {
                throw new Error("boom");
            }
            if (offset === 0) {
                await blocker.promise;
            }
            return { steps: [] };
        });

        const transport = makeWindsurfTransport(endpoint(611, 14611));
        const firstCall = transport("GetCascadeTrajectorySteps", { cascadeId: "timeout-case", stepOffset: 0 });
        await waitFor(() => started.includes(0));

        const keepAlive = setInterval(() => {}, 1000);
        try {
            await assert.rejects(
                transport("GetCascadeTrajectorySteps", { cascadeId: "timeout-case", stepOffset: 1 }, { timeoutMs: 60 }),
                /timed out while waiting for concurrency gate/u,
                "排队超时应直接在 gate 层失败",
            );
            await assert.rejects(
                transport("GetCascadeTrajectorySteps", { cascadeId: "timeout-case", stepOffset: 4 }, {
                    deadlineAt: Date.now() - 1,
                }),
                /timed out while waiting for concurrency gate/u,
                "调用前预算耗尽应直接在 gate 层失败",
            );

            let cancelled = false;
            setTimeout(() => { cancelled = true; }, 30);
            await assert.rejects(
                transport("GetCascadeTrajectorySteps", { cascadeId: "timeout-case", stepOffset: 2 }, {
                    timeoutMs: 500,
                    shouldCancel: () => cancelled,
                    cancelMessage: "manual cancel",
                }),
                /manual cancel/u,
                "排队中的请求应感知取消",
            );
            await assert.rejects(
                transport("GetCascadeTrajectorySteps", { cascadeId: "timeout-case", stepOffset: 3 }, {
                    timeoutMs: 500,
                    shouldCancel: () => { throw new Error("cancel callback failed"); },
                    cancelMessage: "cancel callback treated as cancellation",
                }),
                /cancel callback treated as cancellation/u,
                "取消回调抛异常时应安全拒绝，不得从 timer 外泄",
            );
        } finally {
            clearInterval(keepAlive);
        }

        let stats = __getWindsurfLsGateStatsForTest();
        assert.equal(stats.active, 1, "首个请求未释放前 gate 活跃数应保持 1");
        assert.equal(stats.pending, 0, "超时/取消后不应残留排队项");
        assert.equal(stats.successes, 0, "排队超时和取消不得作为 transport 成功反馈");
        assert.equal(stats.failures, 0, "排队超时和取消不得作为 LS 拥塞反馈");

        blocker.resolve();
        await firstCall;

        await assert.rejects(
            transport("GetCascadeTrajectorySteps", { cascadeId: "timeout-case", stepOffset: 500 }),
            /boom/u,
            "底层异常应向上传递",
        );
        await assert.rejects(
            transport("GetCascadeTrajectorySteps", { cascadeId: "timeout-case", stepOffset: 501 }, {
                onConcurrencyEvent: () => { throw new Error("diagnostic callback failed"); },
            }),
            /diagnostic callback failed/u,
            "诊断回调异常应向上传递，但不能泄漏已取得的许可",
        );
        await transport("GetCascadeTrajectorySteps", { cascadeId: "timeout-case", stepOffset: 9 });

        stats = __getWindsurfLsGateStatsForTest();
        assert.equal(stats.active, 0, "异常/成功路径后许可都应释放");
        assert.equal(stats.pending, 0, "异常/成功路径后队列应排空");
        assert.equal(stats.failures, 0, "非拥塞异常与调用前诊断异常不得回退 AIMD 窗口");
    }

    {
        process.env.MEMORY_STORE_WINDSURF_LS_CONCURRENCY = "1";
        resetAll();

        const originalDateNow = Date.now;
        let now = 10_000;
        let deadlineAt = 0;
        const firstRawStarted = deferred<void>();
        const releaseFirstRaw = deferred<void>();
        const rawStarted: number[] = [];
        Date.now = () => now;

        try {
            __setWindsurfTransportFactoryForTest((): WindsurfLsTransport => (_method, payload = {}) => {
                const offset = Number(payload.stepOffset ?? -1);
                rawStarted.push(offset);
                if (offset !== 0) return Promise.resolve({ steps: [] });
                firstRawStarted.resolve();
                return new Promise((_resolve, reject) => {
                    releaseFirstRaw.promise.then(() => {
                        reject(new Error("held raw transport released"));
                        queueMicrotask(() => { now = deadlineAt; });
                    });
                });
            });

            const transport = makeWindsurfTransport(endpoint(615, 14615));
            const firstCall = transport("GetCascadeTrajectorySteps", { cascadeId: "permit-deadline", stepOffset: 0 });
            const firstSettled = firstCall.then(
                () => assert.fail("held raw transport 应拒绝以释放 permit"),
                error => { assert.match(String(error), /held raw transport released/u); },
            );
            await firstRawStarted.promise;

            deadlineAt = now + 1;
            const queuedCall = transport("GetCascadeTrajectorySteps", { cascadeId: "permit-deadline", stepOffset: 1 }, { deadlineAt });
            assert.equal(__getWindsurfLsGateStatsForTest().pending, 1, "第二个请求应先进入 LS FIFO 队列");
            const beforeRelease = __getWindsurfLsGateStatsForTest();

            releaseFirstRaw.resolve();
            await assert.rejects(
                queuedCall,
                /timed out before request started/u,
                "已获得 permit 但 deadline 恰好耗尽时不得启动 raw transport",
            );
            await firstSettled;

            const afterDeadline = __getWindsurfLsGateStatsForTest();
            assert.deepEqual(rawStarted, [0], "deadline 耗尽的排队请求不得进入 raw transport");
            assert.equal(afterDeadline.active, 0, "deadline 边界失败后 permit 必须释放");
            assert.equal(afterDeadline.pending, 0, "deadline 边界失败后队列必须排空");
            assert.equal(afterDeadline.current, beforeRelease.current, "未启动 raw transport 不得改变 AIMD 窗口");
            assert.equal(afterDeadline.successes, beforeRelease.successes, "未启动 raw transport 不得记为 AIMD 成功");
            assert.equal(afterDeadline.failures, beforeRelease.failures, "未启动 raw transport 不得记为 AIMD 失败");
        } finally {
            Date.now = originalDateNow;
        }
    }

    {
        process.env.MEMORY_STORE_WINDSURF_LS_CONCURRENCY = "1";
        process.env.MEMORY_STORE_ROUTER_PROBE_TIMEOUT_MS = "200";
        resetAll();
        __setBroadcastOverallTimeoutForTest(80);
        let rawStarted = 0;
        let rawSettled = 0;
        const fakeEndpoint = endpoint(612, 14612);
        __setWindsurfTransportFactoryForTest((): WindsurfLsTransport => async (_method, _payload, options = {}) => {
            rawStarted += 1;
            return new Promise((resolve, reject) => {
                const slowTimer = setTimeout(() => {
                    rawSettled += 1;
                    resolve({ trajectorySummaries: {} });
                }, 500);
                const remainingMs = Math.max(1, Number(options.deadlineAt || (Date.now() + Number(options.timeoutMs || 500))) - Date.now());
                setTimeout(() => {
                    clearTimeout(slowTimer);
                    rawSettled += 1;
                    reject(new Error("simulated probe deadline"));
                }, remainingMs);
            });
        });
        const gatedTransport = makeWindsurfTransport(fakeEndpoint);
        const routerEndpoint: RouterEndpoint = {
            kind: "windsurf",
            pid: fakeEndpoint.pid,
            port: fakeEndpoint.port,
            csrfToken: fakeEndpoint.csrfToken,
            executablePath: fakeEndpoint.executablePath,
            key: `windsurf:${fakeEndpoint.pid}:${fakeEndpoint.port}`,
            transport: (method, payload = {}, options) => gatedTransport(
                method,
                payload,
                typeof options === "number" ? { timeoutMs: options } : options,
            ),
        };
        __setEnumeratorForTest(async kind => kind === "windsurf" ? [routerEndpoint] : []);

        const startedAt = Date.now();
        const resolved = await resolveEndpointForConversation("probe-ghost", "windsurf");
        const elapsedMs = Date.now() - startedAt;
        assert.equal(resolved.reason, "not_held");
        assert.ok(elapsedMs < 400, `probe 应按真实 deadline 收口，实际 ${elapsedMs}ms`);
        assert.equal(rawStarted, 1);
        assert.equal(rawSettled, 1);
        assert.equal(__getWindsurfLsGateStatsForTest().active, 0, "probe 返回时不得留下幽灵 LS 占位");
        assert.equal(__getWindsurfLsGateStatsForTest().pending, 0);
    }

    {
        process.env.MEMORY_STORE_WINDSURF_CACHE_TTL_MS = "1800000";
        process.env.MEMORY_STORE_WINDSURF_CACHE_REVALIDATE_MS = "5000";
        const state: CacheState = {
            pageSize: 2,
            cascades: {
                "cache-fresh": { summaryStepCount: 2, steps: createSteps("cache-fresh-v1", 1) },
            },
        };
        const counters = installCacheHarness(state);
        const first = await loadWindsurfConversation("cache-fresh");
        assert.ok(first);
        const afterFirst = { ...counters };
        const second = await loadWindsurfConversation("cache-fresh");
        assert.ok(second);
        assert.equal(second.metadata?.cache?.status, "hit");
        assert.equal(second.metadata?.cache?.reason, "fresh-cache-within-revalidate-window");
        assert.equal(counters.listCalls, afterFirst.listCalls, "fresh cache hit 不应再访问 summary");
        assert.equal(counters.stepCalls, afterFirst.stepCalls, "fresh cache hit 不应再访问 steps");
        assert.equal(second.metadata?.lsConcurrency?.calls, 0, "fresh cache hit 不应占用 LS 并发位");
    }

    {
        process.env.MEMORY_STORE_WINDSURF_CACHE_TTL_MS = "1800000";
        process.env.MEMORY_STORE_WINDSURF_CACHE_REVALIDATE_MS = "0";
        const state: CacheState = {
            pageSize: 2,
            cascades: {
                "cache-revalidate": { summaryStepCount: 2, steps: createSteps("cache-revalidate-v1", 1) },
            },
        };
        const counters = installCacheHarness(state);
        const warm = await loadWindsurfConversation("cache-revalidate");
        assert.ok(warm);
        const unchanged = await loadWindsurfConversation("cache-revalidate");
        assert.ok(unchanged);
        assert.equal(unchanged.metadata?.cache?.status, "hit");
        assert.ok((unchanged.metadata?.lsConcurrency?.calls || 0) > 0, "过窗 revalidate 的 summary probe 必须计入 LS 诊断");
        const afterWarm = { ...counters };

        state.cascades["cache-revalidate"] = {
            summaryStepCount: 4,
            steps: createSteps("cache-revalidate-v2", 2),
        };

        const refreshed = await loadWindsurfConversation("cache-revalidate");
        assert.ok(refreshed);
        assert.equal(refreshed.metadata?.cache?.status, "miss", "stepCount 变化后应失效并重新读取");
        assert.equal(refreshed.totalSteps, 4);
        assert.equal(refreshed.rounds.length, 2);
        assert.equal(refreshed.rounds[0].userMessage, "cache-revalidate-v2-user-1");
        assert.ok(counters.listCalls > afterWarm.listCalls, "revalidate=0 应先做轻量 summary 验证");
        assert.ok(counters.stepCalls > afterWarm.stepCalls, "stepCount 变化后应重新读 steps");
        assert.ok((refreshed.metadata?.lsConcurrency?.calls || 0) > 0, "重新读取应记录 LS 门控诊断");
    }

    console.log("ls-concurrency.test.ts PASS");
} finally {
    if (originalEnv.concurrency === undefined) delete process.env.MEMORY_STORE_WINDSURF_LS_CONCURRENCY;
    else process.env.MEMORY_STORE_WINDSURF_LS_CONCURRENCY = originalEnv.concurrency;

    if (originalEnv.reservedSlots === undefined) delete process.env.MEMORY_STORE_WINDSURF_LS_RESERVED_SLOTS;
    else process.env.MEMORY_STORE_WINDSURF_LS_RESERVED_SLOTS = originalEnv.reservedSlots;

    if (originalEnv.cacheTtl === undefined) delete process.env.MEMORY_STORE_WINDSURF_CACHE_TTL_MS;
    else process.env.MEMORY_STORE_WINDSURF_CACHE_TTL_MS = originalEnv.cacheTtl;

    if (originalEnv.cacheRevalidate === undefined) delete process.env.MEMORY_STORE_WINDSURF_CACHE_REVALIDATE_MS;
    else process.env.MEMORY_STORE_WINDSURF_CACHE_REVALIDATE_MS = originalEnv.cacheRevalidate;

    if (originalEnv.probeTimeout === undefined) delete process.env.MEMORY_STORE_ROUTER_PROBE_TIMEOUT_MS;
    else process.env.MEMORY_STORE_ROUTER_PROBE_TIMEOUT_MS = originalEnv.probeTimeout;

    resetAll();
}
