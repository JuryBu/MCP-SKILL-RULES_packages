/**
 * 路由大脑（conversation-router.ts）— EP-X 多窗口 LS fetch 路由修复的中枢
 *
 * 见蓝图 §1.2 / §7-A：唯一统一路由模块（双 kind + single-flight）。
 * 吃 (cascadeId, kind)，吐一个「已验证持有该对话」的 RouterEndpoint，
 * 永不连错、永不返滞后快照来源。
 *
 * 三条铁律：
 *   1. 持有性是连接的前提：endpoint 被用于拉数据前，必须先探测「该 LS 确实持有此 cascadeId」
 *      （反重力 / WSF 同走 GetAllCascadeTrajectories 的 trajectorySummaries[cascadeId] 存在）。
 *   2. 映射只加速、不是真相：命中后仍做一次轻量 holds 再确认，连失败/不再持有立即剔除重探。
 *   3. 统一 endpoint 抽象：反重力 {pid,port,csrf,workspaceId} 与 WSF {pid,port,csrf,executablePath}
 *      收敛成 RouterEndpoint，对上层只暴露 transport。
 *
 * 机制吸收（见蓝图 §1.2）：
 *   - 方案 A：映射 + 持有性校验 + 短 TTL → resolveEndpointForConversation 快路径。
 *   - 方案 B：未命中并发广播探测，取真正持有者，多持有者取 stepCount 最大 → 慢路径。
 *   - 方案 C：currentStepCount 永远来自真持有者（数据层叠 endpoint 指纹复核）。
 *   - 方案 D：enumerateActiveLs 底座 + setCurrentContext 接口（getCurrentCascadeId 接入）。
 *   - single-flight 惊群收敛：per-mapKey in-flight 去重（1 反重力 + 2 WSF 并发打同后端是真实场景）。
 */

import {
    readRegistry, registerLsEntry,
    markHeartbeatSuccess, markHeartbeatFailure,
    type RegistryEntry,
} from "./ls-registry.js";
import {
    type LsProcessInfo,
    rpcCall,
    findHttpPort,
    LIGHT_TIMEOUT,
} from "./ls-rpc.js";
import {
    discoverLsProcesses,
} from "./ls-client.js";
import {
    discoverAllWindsurfLsEndpoints,
    windsurfListContainsId,
    makeWindsurfTransport,
    type WindsurfLsEndpoint,
} from "./windsurf-client.js";
import {
    MappingStore,
    mapKey,
    endpointKey,
    type LsKind,
} from "./cascade-mapping.js";

export type { LsKind } from "./cascade-mapping.js";

// ===== 接口（见蓝图 §3.1） =====

export interface RouterEndpoint {
    kind: LsKind;
    pid: number;
    port: number;
    csrfToken: string;
    /** 反重力有 */
    workspaceId?: string;
    /** WSF 有 */
    executablePath?: string;
    /** 统一调用入口（只读白名单内）。反重力→rpcCall；WSF→createWindsurfLsTransport。
     *  约定：非 2xx/连接失败一律 reject，便于广播 Promise 隔离。 */
    transport: (method: string, payload?: Record<string, unknown>, timeoutMs?: number) => Promise<any>;
    /** 端点稳定身份键 `${kind}:${pid}:${port}`，映射/去重/日志用。 */
    key: string;
}

export interface ResolveResult {
    endpoint: RouterEndpoint | null;
    /** ok=找到持有者; not_held=活跃 LS 都不持有; no_ls=无活跃 LS */
    reason: "ok" | "not_held" | "no_ls";
    /** 持有者的权威 stepCount（reason=ok 时有效，供数据层 knownStepCount 复用）。 */
    stepCount: number;
    probedCount: number;
    /** true=映射命中再确认通过（快路径） */
    fromMapping: boolean;
}

/** 当前窗口上下文指纹（方案 D 注入用） */
export interface CurrentContext {
    /** 最准锚点（上层已知 id 时） */
    conversationId?: string;
    /** 反重力 LS --workspace_id */
    workspaceId?: string;
    /** workspace 根路径，次强 */
    workspaceRoot?: string;
}

// ===== 常量 =====

/** 持有性探测单 LS 超时（广播内每个 Promise 各自带超时，避免单 LS 永挂拖累整组） */
const PROBE_TIMEOUT_MS = 5_000;
/** 广播整体兜底超时（墙钟，unref 不阻止进程退出） */
const BROADCAST_OVERALL_TIMEOUT_MS = 15_000;

// ===== 模块级状态 =====

const mappingStore = new MappingStore();

/** single-flight：per-mapKey in-flight resolve 去重 */
const inflight = new Map<string, Promise<ResolveResult>>();

/** 当前窗口上下文指纹 */
let currentContext: CurrentContext = {};

/** 测试注入的枚举器（覆盖 enumerateActiveLs 的真实实现） */
let enumeratorOverride: ((kind?: LsKind) => Promise<RouterEndpoint[]>) | null = null;

// ===== 上下文 API（方案 D） =====

/** 合并设置当前上下文（只覆盖传入字段，其余保留） */
export function setCurrentContext(ctx: CurrentContext): void {
    currentContext = { ...currentContext, ...ctx };
}

export function getCurrentContext(): CurrentContext {
    return currentContext;
}

// ===== 映射 API =====

export function invalidateMapping(cascadeId: string, kind: LsKind): void {
    mappingStore.invalidate(cascadeId, kind);
}

export function rememberMapping(cascadeId: string, kind: LsKind, ep: RouterEndpoint, stepCount: number): void {
    mappingStore.set(cascadeId, kind, {
        fp: { key: ep.key, pid: ep.pid, port: ep.port },
        csrfToken: ep.csrfToken,
        workspaceId: ep.workspaceId,
        executablePath: ep.executablePath,
        endpoint: ep,
        stepCount,
    });
}

export function clearMappings(): void {
    mappingStore.clear();
}

// ===== 测试注入 =====

export function __setEnumeratorForTest(fn: ((kind?: LsKind) => Promise<RouterEndpoint[]>) | null): void {
    enumeratorOverride = fn;
}

// ===== RouterEndpoint 构造 =====

/** 反重力 RegistryEntry / LsProcessInfo → RouterEndpoint */
function antigravityEndpoint(info: LsProcessInfo, port: number): RouterEndpoint {
    return {
        kind: "antigravity",
        pid: info.pid,
        port,
        csrfToken: info.csrfToken,
        workspaceId: info.workspaceId,
        key: endpointKey("antigravity", info.pid, port),
        transport: (method, payload = {}, timeoutMs = LIGHT_TIMEOUT) =>
            rpcCall(info, port, method, payload, timeoutMs).then(r => {
                // 约定：非 2xx 一律 reject，便于广播 Promise 隔离。
                if (r.status < 200 || r.status >= 300) {
                    throw new Error(`antigravity rpc ${method} status ${r.status}`);
                }
                return r.data;
            }),
    };
}

/** WSF WindsurfLsEndpoint → RouterEndpoint */
function windsurfEndpoint(ep: WindsurfLsEndpoint): RouterEndpoint {
    const transportFn = makeWindsurfTransport(ep);
    return {
        kind: "windsurf",
        pid: ep.pid,
        port: ep.port,
        csrfToken: ep.csrfToken,
        executablePath: ep.executablePath,
        key: endpointKey("windsurf", ep.pid, ep.port),
        transport: (method, payload = {}) => transportFn(method, payload),
    };
}

// ===== 活跃 LS 枚举（enumerateActiveLs 底座，方案 D） =====

/** 反重力：从注册表 + PowerShell 兜底枚举全部活跃 LS（Heartbeat 通） */
async function enumerateAntigravity(): Promise<RouterEndpoint[]> {
    const endpoints: RouterEndpoint[] = [];
    const seen = new Set<string>();

    const registry = readRegistry();
    for (const [pidStr, entry] of Object.entries(registry.processes)) {
        const pid = parseInt(pidStr, 10);
        if (isNaN(pid)) continue;
        // 进程存活快速检测
        try { process.kill(pid, 0); } catch {
            markHeartbeatFailure(pidStr);
            continue;
        }
        const info: LsProcessInfo = {
            pid: (entry as RegistryEntry).pid,
            csrfToken: (entry as RegistryEntry).csrfToken,
            workspaceId: (entry as RegistryEntry).workspaceId,
            ports: [(entry as RegistryEntry).port],
        };
        const port = (entry as RegistryEntry).port;
        try {
            const hb = await rpcCall(info, port, "Heartbeat", {}, PROBE_TIMEOUT_MS);
            if (hb.status !== 200) {
                markHeartbeatFailure(pidStr);
                continue;
            }
            markHeartbeatSuccess(pidStr);
        } catch {
            markHeartbeatFailure(pidStr);
            continue;
        }
        const key = endpointKey("antigravity", pid, port);
        if (seen.has(key)) continue;
        seen.add(key);
        endpoints.push(antigravityEndpoint(info, port));
    }

    // PowerShell 全量兜底：无条件补扫注册表未覆盖的活跃 LS（顺便回填注册表）。
    // M1 修复：不能用 endpoints.length===0 短路——注册表条目数=活跃后端数≠活跃窗口数，
    // 只要注册表里有任一存活但不持有目标的 LS，就会屏蔽 PowerShell 发现真持有者（未注册窗口）→ 误判 not_held。
    // 靠 seen 去重，已在注册表枚举到的端点不会重复。慢路径有 45s 映射缓存兜底，不会每次都扫。
    for (const ls of discoverLsProcesses()) {
        const port = await findHttpPort(ls);
        if (!port) continue;
        const key = endpointKey("antigravity", ls.pid, port);
        if (seen.has(key)) continue;
        seen.add(key);
        registerLsEntry({
            pid: ls.pid,
            port,
            csrfToken: ls.csrfToken,
            workspaceId: ls.workspaceId,
            registeredAt: new Date().toISOString(),
        });
        endpoints.push(antigravityEndpoint(ls, port));
    }

    return endpoints;
}

/** WSF：全部活跃 WSF LS（Heartbeat 通），不再只取第一个（核心修复 ④） */
async function enumerateWindsurf(): Promise<RouterEndpoint[]> {
    const eps = await discoverAllWindsurfLsEndpoints();
    const seen = new Set<string>();
    const result: RouterEndpoint[] = [];
    for (const ep of eps) {
        const key = endpointKey("windsurf", ep.pid, ep.port);
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(windsurfEndpoint(ep));
    }
    return result;
}

/**
 * 枚举全部活跃 LS（按 kind，或两者）。供路由广播 + 方案 D 旁路复用。
 */
export async function enumerateActiveLs(kind?: LsKind): Promise<RouterEndpoint[]> {
    if (enumeratorOverride) return enumeratorOverride(kind);
    if (kind === "antigravity") return enumerateAntigravity();
    if (kind === "windsurf") return enumerateWindsurf();
    const [ag, wsf] = await Promise.all([enumerateAntigravity(), enumerateWindsurf()]);
    return [...ag, ...wsf];
}

// ===== 持有性探测（holds） =====

/** 给一个 Promise 套上确定性超时兜底，到点以 fallback 收口（不抛、不挂） */
function withProbeTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
    return new Promise<T>((resolve) => {
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            resolve(fallback);
        }, timeoutMs);
        if (typeof timer.unref === "function") timer.unref();
        promise.then(
            (value) => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } },
            () => { if (!settled) { settled = true; clearTimeout(timer); resolve(fallback); } },
        );
    });
}

interface HoldsResult {
    endpoint: RouterEndpoint;
    held: boolean;
    stepCount: number;
}

/**
 * 探测某 endpoint 是否持有 cascadeId（统一走 GetAllCascadeTrajectories，只读白名单内）。
 * 反重力 summaries 是对象（{cascadeId: info}）；WSF summaries 数组/对象两形态均判对。
 */
async function holdsConversation(endpoint: RouterEndpoint, cascadeId: string): Promise<HoldsResult> {
    const probe = (async (): Promise<HoldsResult> => {
        const data = await endpoint.transport("GetAllCascadeTrajectories", {}, LIGHT_TIMEOUT);
        if (endpoint.kind === "windsurf") {
            const held = windsurfListContainsId(data, cascadeId);
            const stepCount = held ? extractStepCount(data, cascadeId) : -1;
            return { endpoint, held, stepCount };
        }
        // 反重力：summaries 是对象 map
        const summaries = (data as any)?.trajectorySummaries;
        if (!summaries || typeof summaries !== "object") {
            return { endpoint, held: false, stepCount: -1 };
        }
        const info = (summaries as Record<string, any>)[cascadeId];
        if (!info) return { endpoint, held: false, stepCount: -1 };
        return { endpoint, held: true, stepCount: typeof info.stepCount === "number" ? info.stepCount : (Number(info.stepCount) || 0) };
    })();
    return withProbeTimeout(probe, PROBE_TIMEOUT_MS, { endpoint, held: false, stepCount: -1 });
}

/** 从 summaries（数组/对象两形态）抽指定 cascadeId 的 stepCount */
function extractStepCount(data: unknown, cascadeId: string): number {
    const root = (data && typeof data === "object") ? data as Record<string, any> : {};
    const summaries = root.trajectorySummaries;
    if (Array.isArray(summaries)) {
        for (const item of summaries) {
            const rec = (item && typeof item === "object") ? item as Record<string, any> : {};
            const id = rec.cascadeId || rec.id || rec.trajectoryId;
            if (id === cascadeId) {
                return typeof rec.stepCount === "number" ? rec.stepCount : (Number(rec.stepCount) || 0);
            }
        }
        return 0;
    }
    if (summaries && typeof summaries === "object") {
        const rec = (summaries as Record<string, any>)[cascadeId];
        if (rec) return typeof rec.stepCount === "number" ? rec.stepCount : (Number(rec.stepCount) || 0);
    }
    return 0;
}

// ===== 核心：resolveEndpointForConversation =====

/**
 * 解析「已验证持有该对话」的 endpoint。
 * 快路径：映射命中 → 轻量 holds 再确认 → 通过即返（fromMapping=true）。
 * 慢路径：枚举活跃 LS → 并发广播 holds → 取持有者（多持有者取 stepCount 最大）。
 * single-flight：per-mapKey 去重，同 id 并发只跑一次广播。
 */
export async function resolveEndpointForConversation(cascadeId: string, kind: LsKind): Promise<ResolveResult> {
    const key = mapKey(cascadeId, kind);
    const existing = inflight.get(key);
    if (existing) return existing;

    const task = doResolve(cascadeId, kind).finally(() => {
        inflight.delete(key);
    });
    inflight.set(key, task);
    return task;
}

async function doResolve(cascadeId: string, kind: LsKind): Promise<ResolveResult> {
    // ===== 快路径：映射命中 → 仅对该 endpoint 做轻量 holds 再确认（不调全量枚举）=====
    // 映射中缓存了上次命中的 RouterEndpoint（纯进程内引用，transport 在 LS 存活期间有效）。
    // 再确认只发一次 GetAllCascadeTrajectories；连失败/不再持有立即剔除重探，杜绝静默返旧。
    const mapped = mappingStore.get(cascadeId, kind);
    if (mapped && mapped.endpoint) {
        const mappedEndpoint = mapped.endpoint as RouterEndpoint;
        const holds = await holdsConversation(mappedEndpoint, cascadeId);
        if (holds.held) {
            rememberMapping(cascadeId, kind, mappedEndpoint, holds.stepCount);
            return { endpoint: mappedEndpoint, reason: "ok", stepCount: holds.stepCount, probedCount: 1, fromMapping: true };
        }
        // 不再持有 / 端点已死 → 剔除映射，落入慢路径重探
        mappingStore.invalidate(cascadeId, kind);
        mappingStore.invalidateEndpoint(mapped.fp.key);
    }

    // ===== 慢路径：枚举 + 并发广播 holds =====
    const endpoints = await enumerateActiveLs(kind);
    if (endpoints.length === 0) {
        return { endpoint: null, reason: "no_ls", stepCount: -1, probedCount: 0, fromMapping: false };
    }

    const broadcast = Promise.all(endpoints.map(ep => holdsConversation(ep, cascadeId)));
    const results = await withProbeTimeout(
        broadcast,
        BROADCAST_OVERALL_TIMEOUT_MS,
        endpoints.map(ep => ({ endpoint: ep, held: false, stepCount: -1 })),
    );

    const holders = results.filter(r => r.held);
    if (holders.length === 0) {
        return { endpoint: null, reason: "not_held", stepCount: -1, probedCount: endpoints.length, fromMapping: false };
    }

    // 多持有者取 stepCount 最大（最新者，见方案 B）。
    // L5 注释（取舍点）：holds 探测超时（>PROBE_TIMEOUT_MS）的持有者会被 withProbeTimeout 收口成
    // held=false 而被排除，极端情况下「真正最新但当时卡住」的持有者会被跳过、选到 stepCount 较小的健康持有者。
    // 这是「超时不拖累整组」与「绝对选最新」之间的有意取舍——下次该对话再 resolve（映射失效后）会重探纠正。
    holders.sort((a, b) => b.stepCount - a.stepCount);
    const winner = holders[0];
    rememberMapping(cascadeId, kind, winner.endpoint, winner.stepCount);
    return {
        endpoint: winner.endpoint,
        reason: "ok",
        stepCount: winner.stepCount,
        probedCount: endpoints.length,
        fromMapping: false,
    };
}
