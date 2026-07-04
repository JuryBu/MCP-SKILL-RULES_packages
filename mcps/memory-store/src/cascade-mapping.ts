/**
 * cascadeId → endpoint 映射底座（路由大脑内部数据结构，泛型纯逻辑叶子）
 *
 * 见蓝图 §7-A 裁决：WSF 设计的泛型 CascadeRouteMap 思想保留，但收敛成路由大脑
 * 内部使用的单一映射结构（不再让反重力 / WSF 两侧各持实例，避免状态分裂与重复 holds 逻辑）。
 * 单独成文件只为可单测。
 *
 * 三条铁律之二：映射只加速、不是真相。
 *   - 纯内存、进程级、短 TTL（45s，见 §7-B），不落盘。
 *   - 命中后仍由路由大脑做一次轻量「再确认」（holds），连失败/不再持有立即剔除重探。
 */

export type LsKind = "antigravity" | "windsurf";

export interface RouteFingerprint {
    key: string;
    pid: number;
    port: number;
}

export interface MappingEntry {
    fp: RouteFingerprint;
    csrfToken: string;
    workspaceId?: string;
    executablePath?: string;
    /** 上次确认持有时的 stepCount（诊断/调试用，不作真相） */
    stepCount: number;
    /** 上次命中的 endpoint（纯进程内引用，含 transport；本叶子模块不依赖其类型，存 unknown）。
     *  路由大脑快路径用它做轻量 holds 再确认，省一次全量枚举。 */
    endpoint?: unknown;
    /** 上次确认持有的时刻 ms */
    probedAt: number;
    ttlMs: number;
}

/** 映射表内部存储类型 */
export type MappingTable = Map<string, MappingEntry>;

/** DEFAULT_TTL_MS = 45_000（落 30–60s 区间，见蓝图 §7-B 裁决） */
export const DEFAULT_TTL_MS = 45_000;

/** 映射键：`${kind}::${cascadeId}` */
export function mapKey(cascadeId: string, kind: LsKind): string {
    return `${kind}::${cascadeId}`;
}

/** 端点稳定身份键：`${kind}:${pid}:${port}` */
export function endpointKey(kind: LsKind, pid: number, port: number): string {
    return `${kind}:${pid}:${port}`;
}

export class MappingStore {
    private table: MappingTable = new Map();
    private readonly ttlMs: number;

    constructor(ttlMs: number = DEFAULT_TTL_MS) {
        this.ttlMs = ttlMs;
    }

    /** 读取映射（过期自动删除返回 undefined） */
    get(cascadeId: string, kind: LsKind): MappingEntry | undefined {
        const key = mapKey(cascadeId, kind);
        const entry = this.table.get(key);
        if (!entry) return undefined;
        if (Date.now() - entry.probedAt >= entry.ttlMs) {
            this.table.delete(key);
            return undefined;
        }
        return entry;
    }

    /** 写入/刷新映射（probedAt/ttlMs 由本方法填充为「现在 + 默认 TTL」） */
    set(
        cascadeId: string,
        kind: LsKind,
        entry: Omit<MappingEntry, "probedAt" | "ttlMs">,
    ): void {
        this.table.set(mapKey(cascadeId, kind), {
            ...entry,
            probedAt: Date.now(),
            ttlMs: this.ttlMs,
        });
    }

    /** 失效单个对话的映射 */
    invalidate(cascadeId: string, kind: LsKind): void {
        this.table.delete(mapKey(cascadeId, kind));
    }

    /** LS 死时清掉所有指向它的对话映射（按 endpointKey 反查） */
    invalidateEndpoint(key: string): void {
        for (const [mapK, entry] of this.table) {
            if (entry.fp.key === key) {
                this.table.delete(mapK);
            }
        }
    }

    /** 清空全部映射 */
    clear(): void {
        this.table.clear();
    }
}
