import http from "http";

/**
 * 反重力 Language Server connect-rpc 连接原语（叶子模块，零业务依赖）
 *
 * 从 ls-client.ts 抽出，由 ls-client.ts 与 conversation-router.ts 共同 import。
 * 目的（见蓝图 §7-C 裁决）：
 *   - 打破 conversation-router ↔ ls-client 的循环依赖
 *   - 给路由大脑反重力适配层提供值依赖（rpcCall / getStepCountLight / findHttpPort）
 *   - 天然可注入测试（__setLsRpcImplForTest）
 *
 * 对外行为与原 ls-client 内部实现保持一致。
 */

// ===== 类型 =====

export interface LsProcessInfo {
    pid: number;
    csrfToken: string;
    workspaceId: string;
    ports: number[];
}

export interface RpcResult {
    status: number;
    data: any;
    rawSize: number;
}

// ===== 超时常量（数据层和路由层共用） =====

/** 重量级操作超时 */
export const HEAVY_TIMEOUT = 120000;
/** 轻量级操作超时 */
export const LIGHT_TIMEOUT = 30000;

// ===== 底层 HTTP =====

/**
 * 底层 HTTP POST 请求（仍私有给本模块）
 */
function httpPost(
    host: string,
    port: number,
    urlPath: string,
    body: string,
    headers: Record<string, string>,
    timeoutMs = 15000
): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
        const req = http.request(
            {
                hostname: host,
                port,
                path: urlPath,
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Content-Length": Buffer.byteLength(body),
                    ...headers,
                },
                timeout: timeoutMs,
            },
            (res) => {
                const chunks: Buffer[] = [];
                res.on("data", (chunk: Buffer) => chunks.push(chunk));
                res.on("end", () => {
                    const responseBody = Buffer.concat(chunks).toString("utf-8");
                    resolve({ status: res.statusCode || 0, body: responseBody });
                });
            }
        );
        req.on("error", reject);
        req.on("timeout", () => {
            req.destroy();
            reject(new Error("Request timeout"));
        });
        req.write(body);
        req.end();
    });
}

// ===== connect-rpc 调用 =====

/** 真实 rpcCall 实现（可被测试替身覆盖） */
async function realRpcCall(
    lsInfo: LsProcessInfo,
    port: number,
    method: string,
    payload: Record<string, unknown> = {},
    timeoutMs = 15000
): Promise<RpcResult> {
    const rpcPath = `/exa.language_server_pb.LanguageServerService/${method}`;
    const body = JSON.stringify(payload);
    const headers = {
        "x-codeium-csrf-token": lsInfo.csrfToken,
        "Connect-Protocol-Version": "1",
    };

    const resp = await httpPost("127.0.0.1", port, rpcPath, body, headers, timeoutMs);

    let data: any;
    try {
        data = resp.body ? JSON.parse(resp.body) : {};
    } catch {
        data = resp.body;
    }

    return { status: resp.status, data, rawSize: resp.body?.length ?? 0 };
}

/** 测试注入的 rpcCall 替身（null=用真实实现） */
type RpcImpl = (
    lsInfo: LsProcessInfo,
    port: number,
    method: string,
    payload: Record<string, unknown>,
    timeoutMs: number
) => Promise<RpcResult>;

let rpcOverride: RpcImpl | null = null;

/**
 * 测试专用：注入替身 rpcCall，让路由层 / 数据层全链路可离线跑（不依赖真实 LS）。
 * 传 null 还原真实实现。生产代码不调用。
 */
export function __setLsRpcImplForTest(fn: RpcImpl | null): void {
    rpcOverride = fn;
}

/**
 * 调用 LS 的 connect-rpc 方法
 * @param timeoutMs 自定义超时（默认 15s，大数据操作建议 60-120s）
 */
export async function rpcCall(
    lsInfo: LsProcessInfo,
    port: number,
    method: string,
    payload: Record<string, unknown> = {},
    timeoutMs = 15000
): Promise<RpcResult> {
    const impl = rpcOverride ?? realRpcCall;
    return impl(lsInfo, port, method, payload, timeoutMs);
}

/**
 * 找到 LS 的有效 HTTP 端口（通过 Heartbeat 验证）
 */
export async function findHttpPort(lsInfo: LsProcessInfo): Promise<number | null> {
    for (const port of lsInfo.ports) {
        try {
            const result = await rpcCall(lsInfo, port, "Heartbeat", {}, 5000);
            if (result.status === 200) return port;
        } catch { /* try next */ }
    }
    return null;
}

/**
 * 轻量级获取指定对话的 stepCount
 * 用 GetAllCascadeTrajectories（~46KB/1s）替代 GetCascadeTrajectory（~7MB/14s）
 * @returns stepCount，若该 LS 没有此对话则返回 -1
 */
export async function getStepCountLight(
    lsInfo: LsProcessInfo,
    port: number,
    cascadeId: string
): Promise<{ stepCount: number; lastModifiedTime?: string }> {
    const result = await rpcCall(lsInfo, port, "GetAllCascadeTrajectories", {}, LIGHT_TIMEOUT);
    if (result.status !== 200) return { stepCount: -1 };
    const summaries = result.data?.trajectorySummaries;
    if (!summaries || typeof summaries !== "object") return { stepCount: -1 };
    const info = summaries[cascadeId];
    if (!info) return { stepCount: -1 };
    return {
        stepCount: info.stepCount ?? 0,
        lastModifiedTime: info.lastModifiedTime,
    };
}
