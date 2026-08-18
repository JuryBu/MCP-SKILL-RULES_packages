import assert from "node:assert/strict";
import {
    __setEnumeratorForTest,
    clearMappings,
    type RouterEndpoint,
} from "../src/conversation-router.ts";
import {
    __resetWindsurfConversationCacheForTest,
    __resetWindsurfEndpointCacheForTest,
    __setWindsurfEndpointResolverForTest,
    __setWindsurfTransportFactoryForTest,
    loadWindsurfConversation,
    type WindsurfLsEndpoint,
    type WindsurfLsTransport,
} from "../src/windsurf-client.ts";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

type CascadeFixture = {
    summaryStepCount: number;
    steps: Array<Record<string, unknown>>;
};

type FixtureState = {
    cascades: Record<string, CascadeFixture>;
    pageSize: number;
    throwOnRead?: boolean;
};

type TransportCounters = {
    listCalls: number;
    stepCalls: number;
    stepOffsets: number[];
};

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

function installHarness(state: FixtureState): TransportCounters {
    const counters: TransportCounters = {
        listCalls: 0,
        stepCalls: 0,
        stepOffsets: [],
    };

    const transport: WindsurfLsTransport = async (method, payload = {}) => {
        if (method === "GetAllCascadeTrajectories") {
            counters.listCalls += 1;
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
            const offset = Number(payload.stepOffset || 0);
            counters.stepOffsets.push(offset);
            if (state.throwOnRead) {
                throw new Error("simulated WSF LS failure");
            }
            const fixture = state.cascades[cascadeId];
            assert.ok(fixture, `missing fixture for ${cascadeId}`);
            return {
                steps: fixture.steps.slice(offset, offset + state.pageSize),
            };
        }
        if (method === "Heartbeat") {
            return { ok: true };
        }
        throw new Error(`unexpected method ${method}`);
    };

    const fakeEndpoint: WindsurfLsEndpoint = {
        pid: 501,
        port: 14501,
        csrfToken: "test-token",
        executablePath: "C:\\Program Files\\Windsurf\\language_server_windows_x64.exe",
    };

    const routerEndpoint: RouterEndpoint = {
        kind: "windsurf",
        pid: fakeEndpoint.pid,
        port: fakeEndpoint.port,
        csrfToken: fakeEndpoint.csrfToken,
        executablePath: fakeEndpoint.executablePath,
        key: `windsurf:${fakeEndpoint.pid}:${fakeEndpoint.port}`,
        transport: (method, payload = {}) => transport(method, payload),
    };

    __setWindsurfEndpointResolverForTest(async () => [fakeEndpoint]);
    __setWindsurfTransportFactoryForTest(() => transport);
    __setEnumeratorForTest(async kind => kind === "windsurf" ? [routerEndpoint] : []);
    __resetWindsurfEndpointCacheForTest();
    __resetWindsurfConversationCacheForTest();
    clearMappings();
    return counters;
}

function resetCaches(): void {
    __resetWindsurfEndpointCacheForTest();
    __resetWindsurfConversationCacheForTest();
    clearMappings();
}

const originalEnv = {
    ttl: process.env.MEMORY_STORE_WINDSURF_CACHE_TTL_MS,
    maxEntries: process.env.MEMORY_STORE_WINDSURF_CACHE_MAX_ENTRIES,
    revalidate: process.env.MEMORY_STORE_WINDSURF_CACHE_REVALIDATE_MS,
    debug: process.env.MEMORY_STORE_WINDSURF_READ_TIMING_DEBUG,
};

try {
    {
        process.env.MEMORY_STORE_WINDSURF_CACHE_TTL_MS = "1800000";
        process.env.MEMORY_STORE_WINDSURF_CACHE_MAX_ENTRIES = "10";
        process.env.MEMORY_STORE_WINDSURF_READ_TIMING_DEBUG = "1";
        const state: FixtureState = {
            pageSize: 2,
            cascades: {
                "cascade-cache": { summaryStepCount: 2, steps: createSteps("cache-v1", 1) },
            },
        };
        const counters = installHarness(state);
        const first = await loadWindsurfConversation("cascade-cache");
        const second = await loadWindsurfConversation("cascade-cache");
        assert.ok(first);
        assert.ok(second);
        assert.equal(first.metadata?.cache?.status, "miss");
        assert.equal(second.metadata?.cache?.status, "hit");
        assert.equal(counters.stepCalls, 2);
        assert.equal(second.rounds[0].userMessage, "cache-v1-user-1");
        assert.equal(first.metadata?.timings?.stepPages?.length, 2);
    }

    {
        process.env.MEMORY_STORE_WINDSURF_CACHE_TTL_MS = "1800000";
        process.env.MEMORY_STORE_WINDSURF_CACHE_MAX_ENTRIES = "10";
        process.env.MEMORY_STORE_WINDSURF_READ_TIMING_DEBUG = "0";
        const state: FixtureState = {
            pageSize: 2,
            cascades: {
                "cascade-refresh": { summaryStepCount: 2, steps: createSteps("refresh-v1", 1) },
            },
        };
        const counters = installHarness(state);
        const first = await loadWindsurfConversation("cascade-refresh");
        assert.ok(first);
        state.cascades["cascade-refresh"] = { summaryStepCount: 2, steps: createSteps("refresh-v2", 1) };
        const refreshed = await loadWindsurfConversation("cascade-refresh", true);
        assert.ok(refreshed);
        assert.equal(refreshed.metadata?.cache?.status, "refresh");
        assert.equal(refreshed.rounds[0].userMessage, "refresh-v2-user-1");
        assert.equal(counters.stepCalls, 4);
    }

    {
        process.env.MEMORY_STORE_WINDSURF_CACHE_TTL_MS = "1800000";
        process.env.MEMORY_STORE_WINDSURF_CACHE_MAX_ENTRIES = "10";
        const state: FixtureState = {
            pageSize: 2,
            cascades: {
                "cascade-refresh-offline": { summaryStepCount: 2, steps: createSteps("refresh-offline", 1) },
            },
        };
        installHarness(state);
        const warm = await loadWindsurfConversation("cascade-refresh-offline");
        assert.ok(warm);
        __setWindsurfEndpointResolverForTest(async () => []);
        __setEnumeratorForTest(async () => []);
        clearMappings();
        const fallback = await loadWindsurfConversation("cascade-refresh-offline", true);
        assert.ok(fallback);
        assert.equal(fallback.metadata?.cache?.status, "stale-fallback");
        assert.equal(fallback.metadata?.cache?.reason, "source-unavailable-during-refresh");
        assert.equal(fallback.rounds[0].userMessage, "refresh-offline-user-1");
        assert.match(fallback.warnings?.join("\n") || "", /强制刷新期间.*last-good/u);
    }

    {
        process.env.MEMORY_STORE_WINDSURF_CACHE_TTL_MS = "1800000";
        process.env.MEMORY_STORE_WINDSURF_CACHE_MAX_ENTRIES = "10";
        process.env.MEMORY_STORE_WINDSURF_CACHE_REVALIDATE_MS = "0";
        const state: FixtureState = {
            pageSize: 2,
            cascades: {
                "cascade-invalidate": { summaryStepCount: 2, steps: createSteps("invalidate-v1", 1) },
            },
        };
        const counters = installHarness(state);
        const first = await loadWindsurfConversation("cascade-invalidate");
        assert.ok(first);
        state.cascades["cascade-invalidate"] = { summaryStepCount: 4, steps: createSteps("invalidate-v2", 2) };
        const next = await loadWindsurfConversation("cascade-invalidate");
        assert.ok(next);
        assert.equal(next.metadata?.cache?.status, "miss");
        assert.ok((next.metadata?.cache?.cachedStepCount || 0) >= 2);
        assert.equal(next.metadata?.cache?.authoritativeStepCount, 4);
        assert.equal(next.totalSteps, 4);
        assert.equal(next.rounds.length, 2);
        assert.ok(counters.stepCalls >= 5);
        if (originalEnv.revalidate === undefined) delete process.env.MEMORY_STORE_WINDSURF_CACHE_REVALIDATE_MS;
        else process.env.MEMORY_STORE_WINDSURF_CACHE_REVALIDATE_MS = originalEnv.revalidate;
    }

    {
        process.env.MEMORY_STORE_WINDSURF_CACHE_TTL_MS = "50";
        process.env.MEMORY_STORE_WINDSURF_CACHE_MAX_ENTRIES = "2";
        const state: FixtureState = {
            pageSize: 2,
            cascades: {
                "cascade-a": { summaryStepCount: 2, steps: createSteps("lru-a", 1) },
                "cascade-b": { summaryStepCount: 2, steps: createSteps("lru-b", 1) },
                "cascade-c": { summaryStepCount: 2, steps: createSteps("lru-c", 1) },
            },
        };
        const counters = installHarness(state);
        await loadWindsurfConversation("cascade-a");
        await loadWindsurfConversation("cascade-b");
        const afterAB = counters.stepCalls;
        await loadWindsurfConversation("cascade-a");
        assert.equal(counters.stepCalls, afterAB);
        await loadWindsurfConversation("cascade-c");
        const afterC = counters.stepCalls;
        assert.ok(afterC > afterAB);
        await loadWindsurfConversation("cascade-b");
        const afterReloadB = counters.stepCalls;
        assert.ok(afterReloadB > afterC);
        await sleep(80);
        await loadWindsurfConversation("cascade-a");
        assert.ok(counters.stepCalls > afterReloadB);
    }

    {
        process.env.MEMORY_STORE_WINDSURF_CACHE_TTL_MS = "1800000";
        process.env.MEMORY_STORE_WINDSURF_CACHE_MAX_ENTRIES = "10";
        const state: FixtureState = {
            pageSize: 2,
            cascades: {
                "cascade-bad-refresh": { summaryStepCount: 2, steps: createSteps("good-cache", 1) },
            },
        };
        const counters = installHarness(state);
        const good = await loadWindsurfConversation("cascade-bad-refresh");
        assert.ok(good);
        state.cascades["cascade-bad-refresh"] = { summaryStepCount: 3, steps: [] };
        const fallback = await loadWindsurfConversation("cascade-bad-refresh", true);
        assert.ok(fallback);
        assert.equal(fallback.metadata?.cache?.status, "stale-fallback");
        assert.equal(fallback.rounds[0].userMessage, "good-cache-user-1");
        assert.match((fallback.warnings || []).join("\n"), /last-good|rounds=0/u);
        assert.ok(counters.stepCalls >= 4);
    }
} finally {
    if (originalEnv.ttl === undefined) delete process.env.MEMORY_STORE_WINDSURF_CACHE_TTL_MS;
    else process.env.MEMORY_STORE_WINDSURF_CACHE_TTL_MS = originalEnv.ttl;
    if (originalEnv.maxEntries === undefined) delete process.env.MEMORY_STORE_WINDSURF_CACHE_MAX_ENTRIES;
    else process.env.MEMORY_STORE_WINDSURF_CACHE_MAX_ENTRIES = originalEnv.maxEntries;
    if (originalEnv.revalidate === undefined) delete process.env.MEMORY_STORE_WINDSURF_CACHE_REVALIDATE_MS;
    else process.env.MEMORY_STORE_WINDSURF_CACHE_REVALIDATE_MS = originalEnv.revalidate;
    if (originalEnv.debug === undefined) delete process.env.MEMORY_STORE_WINDSURF_READ_TIMING_DEBUG;
    else process.env.MEMORY_STORE_WINDSURF_READ_TIMING_DEBUG = originalEnv.debug;
    __setEnumeratorForTest(null);
    __setWindsurfEndpointResolverForTest(null);
    __setWindsurfTransportFactoryForTest(null);
    resetCaches();
}
