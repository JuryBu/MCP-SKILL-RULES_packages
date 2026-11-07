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
    "source",
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

    if (
        lowerCode === "etimedout" ||
        has("timed out", "timeout", "超时", "deadline exceeded")
    ) {
        return {
            category: "timeout",
            retryable: true,
            hint: "调用超时：先核对本次执行状态与已有结果，再按当前工具支持的范围或等待参数调整后重试。",
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
        hint: "未归类错误：请先核对本次调用状态与已有结果，再结合错误信息排查原因。",
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
        if (key === "source" && (typeof value !== "string" || !["auto", "local", "ls", "cache"].includes(value))) continue;
        out.push([key, formatKeyArgValue(value)]);
    }
    return out;
}

function timeoutHintForTool(action: string, keyArgs: Record<string, unknown> | undefined, fallback: string, err: unknown): string {
    const matched = /^([^()]+)(?:\(([^()]*)\))?$/.exec(action.trim());
    const tool = matched?.[1]?.trim() || action;
    const operation = matched?.[2]?.trim() || (typeof keyArgs?.action === "string" ? keyArgs.action.trim() : "");
    const errorTaskId = err && typeof err === "object" && "taskId" in err ? (err as { taskId?: unknown }).taskId : undefined;
    const originalTaskId = keyArgs?.progressiveTaskId || keyArgs?.taskId || errorTaskId;
    const hasTask = typeof originalTaskId === "string" && originalTaskId.trim().length > 0;
    const taskId = JSON.stringify(hasTask && originalTaskId.trim().length <= KEY_ARG_VALUE_MAX
        ? originalTaskId.trim() : "<原taskId>");
    const receipt = hasTask ? "沿用原 taskId" : "先从原受理回执取回 taskId，核对是否已启动";
    const statusCall = (name: string, nextAction: string): string =>
        `${name}(action="${nextAction}", taskId=${taskId}, waitSeconds=30)`;
    const controlCall = (name: string, nextAction: string): string =>
        `${name}(action="${nextAction}", taskId=${taskId})`;
    const conversationTaskHint = (prefix: "deep_locate" | "prepare" | "search_all"): string =>
        `调用超时：${receipt}，保持原调用者 conversationId 和来源参数，使用 ${statusCall(tool, `${prefix}_status`)} 查询；` +
        `需要停止时用 ${controlCall(tool, `${prefix}_cancel`)}，再查同一任务确认停止。` +
        (prefix === "deep_locate" ? "" : `确认原任务可恢复且需要继续时，用 ${controlCall(tool, `${prefix}_resume`)}，保留原任务与已返回的游标。`);
    const backgroundTaskHint = (): string =>
        `调用超时：${receipt}，使用 background_task_status(taskId=${taskId}, waitSeconds=30) 查询；` +
        `需要停止时用 background_task_cancel(taskId=${taskId})，再查同一任务确认停止。`;

    if (tool === "conversation_read_original") {
        if (operation === "list") {
            return "调用超时：list 为同步定位入口，请缩小 workspaces/query 范围，或调整 deadlineMs 后重新调用 list。";
        }
        if (["deep_locate", "deep_locate_status", "deep_locate_cancel"].includes(operation)) {
            return conversationTaskHint("deep_locate");
        }
        if (["search_all", "search_all_status", "search_all_cancel", "search_all_resume"].includes(operation)) {
            return conversationTaskHint("search_all");
        }
        if (["prepare", "prepare_status", "prepare_cancel", "prepare_resume", "read_ready", "search_ready", "locate_ready", "extract_ready"].includes(operation)
            || (keyArgs?.progressiveTaskId && ["fetch", "read", "search", "read_fast"].includes(operation))) {
            return conversationTaskHint("prepare");
        }
        if (operation === "read_fast") {
            return `调用超时：${receipt}（taskId=${taskId}），核对原响应 next；分段准备任务沿原 taskId 调用 prepare_status/prepare_cancel/prepare_resume，` +
                "cachePreparation.taskId 按原 next 调用 search_all_status/search_all_cancel/search_all_resume；沿用原调用者 conversationId 和来源参数。";
        }
        if (operation === "fetch") {
            if (hasTask && keyArgs?.progressive === false) return backgroundTaskHint();
            const dataChain = keyArgs?.dataChain || keyArgs?.chain;
            const localCodex = dataChain === "codex" && keyArgs?.source !== "ls" && keyArgs?.source !== "cache";
            return `调用超时：${receipt}，按原响应 next 查询；分段任务使用 ${statusCall(tool, "prepare_status")}，` +
                `完整 fetch 后台任务使用 background_task_status(taskId=${taskId}, waitSeconds=30)，沿用原任务身份。` +
                (!hasTask && localCodex ? "确认本次尚未启动后，本地 Codex fetch 可设置 background=true；取得 taskId 后查询原任务。" : "");
        }
        if (operation === "export" && hasTask) return backgroundTaskHint();
    }

    if (tool === "record_manage") {
        const backgroundOperation = ["update", "batch_update", "bulk_update", "guide"].includes(operation);
        if (backgroundOperation || ["task_status", "cancel", "recover"].includes(operation)) {
            return `调用超时：${receipt}，使用 ${statusCall(tool, "task_status")} 查询；` +
                `需要停止时用 ${controlCall(tool, "cancel")}，确认可恢复且需要继续时用 ${controlCall(tool, "recover")}。` +
                (backgroundOperation && !hasTask ? `确认本次尚未启动后，${tool}(action="${operation}") 可设置 background=true，取得 taskId 后查询原任务。` : "");
        }
    }

    if (tool === "stage_guard" && (operation === "check" || (operation === "cancel" && hasTask))) {
        return `调用超时：${receipt}，沿用原 conversationId/stageId，通过 ${statusCall(tool, "check")} 查询；` +
            `需要停止时用 ${controlCall(tool, "cancel")}，再查同一检查任务确认停止。` +
            (!hasTask ? "确认本次尚未启动后，stage_guard(action=\"check\") 可设置 background=true。" : "");
    }

    if (tool === "conversation_golden_extract") {
        return `调用超时：${receipt}，使用 conversation_golden_extract(taskId=${taskId}, waitSeconds=30) 查询原任务；` +
            `需要停止时用 background_task_cancel(taskId=${taskId})。` +
            (!hasTask ? "确认本次尚未启动后，可设置 background=true，取得 taskId 后查询原任务。" : "");
    }

    return fallback;
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
    const hint = classified.category === "timeout" ? timeoutHintForTool(action, keyArgs, classified.hint, err) : classified.hint;
    const lines: string[] = [
        `❌ ${action} 失败`,
        `📋 错误: ${classified.message}`,
        `🏷 分类: ${classified.category}`,
        `🔁 可重试: ${classified.retryable ? "是" : "否"}`,
        `💡 建议: ${hint}`,
    ];
    const safeArgs = sanitizeKeyArgs(keyArgs);
    if (safeArgs.length > 0) {
        lines.push(`🔑 关键入参: ${safeArgs.map(([k, v]) => `${k}=${v}`).join(", ")}`);
    }
    return lines.join("\n");
}
