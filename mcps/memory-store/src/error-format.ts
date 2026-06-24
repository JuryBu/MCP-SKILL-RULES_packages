/**
 * error-format.ts — 工具错误信息结构化（C3 块A）
 *
 * 目的：各工具顶层 catch 原本只返回一行裸 err.message，丢了 action / 入参 / 分类，
 * 调用方无法判断该「重试 / 改参 / 还是环境问题」。这里把错误统一分类并产出多行
 * 结构化文本，让调用方一眼看出可重试性与下一步该怎么做。
 *
 * ⚠️ 安全红线：keyArgs 回显只走白名单键 + 每值截断，绝不带 content 等大字段
 * （既防泄露也防超长把返回撑爆）。
 */

export type ErrorCategory =
    | "timeout"
    | "not_found"
    | "permission"
    | "invalid_input"
    | "network"
    | "unknown";

export interface ClassifiedError {
    category: ErrorCategory;
    /** 是否值得原样重试（timeout/network 可，invalid_input/not_found/permission 不可） */
    retryable: boolean;
    /** 给调用方的下一步建议 */
    hint: string;
    /** 归一化后的原始错误信息 */
    message: string;
}

/** keyArgs 回显白名单：只允许这些「小且安全」的键被回显。绝不含 content/append/正文类字段。 */
const KEY_ARG_ALLOWLIST = new Set<string>([
    "id",
    "conversationId",
    "taskId",
    "action",
    "workspace",
    "scope",
    "mode",
    "limit",
    "chain",
    "dataChain",
    "modelChain",
    "stageId",
    "background",
    "query",
    "depth",
    "view",
    "searchScope",
    "parallelMode",
    "logicalChain",
]);

/** 单个回显值的最大长度，超出截断（防超长 query 之类把错误文本撑大）。 */
const KEY_ARG_VALUE_MAX = 80;

/** 从任意错误对象上尽力取出 message 字符串，绝不抛。 */
function extractMessage(err: unknown): string {
    if (err instanceof Error) return err.message || err.name || "Error";
    if (typeof err === "string") return err;
    if (err === null || err === undefined) return String(err);
    try {
        return JSON.stringify(err);
    } catch {
        return String(err);
    }
}

/** 从错误对象上尽力取出 code（Node 系统错误常带 err.code，如 ENOENT/EACCES/ETIMEDOUT）。 */
function extractCode(err: unknown): string {
    if (err && typeof err === "object" && "code" in err) {
        const code = (err as { code?: unknown }).code;
        if (typeof code === "string") return code;
        if (typeof code === "number") return String(code);
    }
    return "";
}

/**
 * 分类错误：按 err.code + 关键字判定类别、可重试性、给出 hint。
 * 设计为绝不抛——任何奇怪输入都至少落到 unknown。
 */
export function classifyError(err: unknown): ClassifiedError {
    const message = extractMessage(err);
    const code = extractCode(err);
    const lowerCode = code.toLowerCase();
    const lower = message.toLowerCase();

    const has = (...needles: string[]): boolean =>
        needles.some(n => lower.includes(n) || lowerCode.includes(n));

    // timeout：可重试，建议调大超时或转后台
    if (
        lowerCode === "etimedout" ||
        has("timed out", "timeout", "超时", "deadline exceeded")
    ) {
        return {
            category: "timeout",
            retryable: true,
            hint: "调用超时：可重试，或调大超时阈值 / 把任务转后台（background=true 后用 task_status 查询）。",
            message,
        };
    }

    // permission：不可重试（重试也一样），需改权限/路径
    if (
        lowerCode === "eacces" ||
        lowerCode === "eperm" ||
        has("permission denied", "eacces", "eperm", "operation not permitted", "权限", "拒绝访问")
    ) {
        return {
            category: "permission",
            retryable: false,
            hint: "权限/文件占用问题：检查文件或目录的读写权限、是否被其它进程锁定（Windows 上常见 EPERM 临时占用，可稍后再试）。",
            message,
        };
    }

    // not_found：不可重试，需核对入参指向
    if (
        lowerCode === "enoent" ||
        has("enoent", "not found", "no such file", "不存在", "未找到", "找不到")
    ) {
        return {
            category: "not_found",
            retryable: false,
            hint: "目标不存在：核对 id / conversationId / 文件路径是否正确，或目标是否已被删除。",
            message,
        };
    }

    // network：可重试（瞬时网络抖动）
    if (
        lowerCode === "econnrefused" ||
        lowerCode === "econnreset" ||
        lowerCode === "enotfound" ||
        lowerCode === "enetunreach" ||
        has("econnrefused", "econnreset", "enotfound", "socket hang up", "network", "fetch failed", "网络", "连接被拒")
    ) {
        return {
            category: "network",
            retryable: true,
            hint: "网络/连接问题：通常是瞬时抖动，可重试；若持续失败请检查依赖服务（模型链路 / 后端）是否在线。",
            message,
        };
    }

    // invalid_input：不可重试，需改参数
    if (
        has(
            "invalid",
            "validation",
            "missing",
            "required",
            "缺少",
            "无效",
            "参数",
            "expected",
            "must be",
            "unexpected",
            "parse",
            "json",
            "zod",
        )
    ) {
        return {
            category: "invalid_input",
            retryable: false,
            hint: "入参有问题：原样重试不会变好，请检查并修正参数后再调用。",
            message,
        };
    }

    return {
        category: "unknown",
        retryable: false,
        hint: "未归类错误：原样重试未必有效，建议结合错误信息排查；若怀疑是瞬时问题可谨慎重试一次。",
        message,
    };
}

/** 把单个回显值规整为短字符串（截断 + 去换行），绝不抛。 */
function formatKeyArgValue(value: unknown): string {
    let text: string;
    if (value === null || value === undefined) {
        text = String(value);
    } else if (typeof value === "string") {
        text = value;
    } else if (typeof value === "number" || typeof value === "boolean") {
        text = String(value);
    } else if (Array.isArray(value)) {
        text = `[${value.length} 项]`;
    } else {
        text = "[object]";
    }
    text = text.replace(/\s+/g, " ").trim();
    if (text.length > KEY_ARG_VALUE_MAX) {
        text = `${text.slice(0, KEY_ARG_VALUE_MAX)}…(已截断)`;
    }
    return text;
}

/**
 * 过滤 keyArgs：只保留白名单键、剔除 undefined、对每个值截断。
 * 这是「绝不带 content」红线的实现点——content 等不在白名单，天然被丢弃。
 */
function sanitizeKeyArgs(keyArgs?: Record<string, unknown>): Array<[string, string]> {
    if (!keyArgs) return [];
    const out: Array<[string, string]> = [];
    for (const key of Object.keys(keyArgs)) {
        if (!KEY_ARG_ALLOWLIST.has(key)) continue;
        const value = keyArgs[key];
        if (value === undefined) continue;
        out.push([key, formatKeyArgValue(value)]);
    }
    return out;
}

/**
 * 产出多行结构化错误文本。
 * @param action 出错的工具/动作名（如 "memory_write" 或 "record_manage(update)"）
 * @param err    捕获到的错误
 * @param keyArgs 关键入参（会经白名单过滤 + 截断，绝不回显 content）
 */
export function formatToolError(
    action: string,
    err: unknown,
    keyArgs?: Record<string, unknown>,
): string {
    const classified = classifyError(err);
    const lines: string[] = [
        `❌ ${action} 失败`,
        `📋 错误: ${classified.message}`,
        `🏷 分类: ${classified.category}`,
        `🔁 可重试: ${classified.retryable ? "是" : "否"}`,
        `💡 建议: ${classified.hint}`,
    ];
    const safeArgs = sanitizeKeyArgs(keyArgs);
    if (safeArgs.length > 0) {
        lines.push(`🔑 关键入参: ${safeArgs.map(([k, v]) => `${k}=${v}`).join(", ")}`);
    }
    return lines.join("\n");
}
