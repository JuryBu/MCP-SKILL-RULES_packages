// Record 生成引擎 —— 共享常量与零依赖纯函数。
// 由 record-generator.ts 拆分而来（E2-B2），纯结构搬运、零行为变更。
import { DEFAULT_ANTIGRAVITY_LS_MODEL } from "./ls-model-defaults.js";
import type { RecordParallelMode } from "./record-types.js";

// ============= 常量 =============

/** Flash 模型标识符 */
export const FLASH_MODEL = process.env.MEMORY_STORE_LS_MODEL || DEFAULT_ANTIGRAVITY_LS_MODEL;

/** 总 Prompt 字符数上限（Flash 1M token ≈ 3-4M chars，取 500K 留足余量） */
export const MAX_PROMPT_CHARS = 500_000;

/** Codex CLI 模型桥不适合一次吞超长上下文，按较小批次稳定生成。 */
export const CODEX_RECORD_MAX_PROMPT_CHARS = Number(process.env.MEMORY_STORE_CODEX_RECORD_MAX_PROMPT_CHARS || 60_000);

/** Grok Record 模型上下文较大，但仍保留预算保护，避免把 1M 上下文误当无限制。 */
export const GROK_RECORD_MAX_PROMPT_CHARS = Number(process.env.MEMORY_STORE_GROK_RECORD_MAX_PROMPT_CHARS || 200_000);

/** Codex 更新 Record 时携带的已有 Record 上下文上限，避免后期 Record 变长拖垮单批 prompt。 */
export const CODEX_RECORD_CONTEXT_CHARS = Number(process.env.MEMORY_STORE_CODEX_RECORD_CONTEXT_CHARS || 30_000);

/** Prompt 模板固定开销 */
export const PROMPT_TEMPLATE_OVERHEAD = 2_000;

/** 每批至少取的轮次数 */
export const MIN_BATCH_ROUNDS = 5;

/** 自动触发 Record 更新的新增轮次阈值 */
export const RECORD_AUTO_THRESHOLD = 3;

/** Codex 宿主工具调用有隐性超时，同步 Record 模型桥必须快失败。 */
export const CODEX_RECORD_TIMEOUT_MS = Number(process.env.MEMORY_STORE_CODEX_RECORD_TIMEOUT || 45_000);
/** 后台 Record 更新不占用宿主同步调用窗口，可以给 Codex 更长生成时间。 */
export const CODEX_RECORD_BACKGROUND_TIMEOUT_MS = Number(process.env.MEMORY_STORE_CODEX_RECORD_BACKGROUND_TIMEOUT || 8 * 60_000);
/** Antigravity/LS Record 模型调用超时，独立于其它轻量模型调用。 */
export const RECORD_MODEL_TIMEOUT_MS = Number(process.env.MEMORY_STORE_RECORD_MODEL_TIMEOUT || 180_000);
/** Grok Record 模型调用超时，独立于默认 Grok 轻量调用。 */
export const GROK_RECORD_TIMEOUT_MS = Number(process.env.MEMORY_STORE_GROK_RECORD_TIMEOUT || 120_000);
/** 长模型调用阶段的后台进度心跳间隔。 */
export const RECORD_PROGRESS_HEARTBEAT_MS = Number(process.env.MEMORY_STORE_RECORD_PROGRESS_HEARTBEAT_MS || 30_000);
/** Codex 模型桥只对快失败轻量重试，完整超时不重试。 */
export const CODEX_RECORD_RETRY_DELAY_MS = Number(process.env.MEMORY_STORE_CODEX_RECORD_RETRY_DELAY || 1_000);
/** Claude Code CLI 也是本地模型桥，默认沿用 Codex 级别的保守 Record 预算。 */
export const CC_RECORD_MAX_PROMPT_CHARS = Number(process.env.MEMORY_STORE_CC_RECORD_MAX_PROMPT_CHARS || CODEX_RECORD_MAX_PROMPT_CHARS);
export const CC_RECORD_CONTEXT_CHARS = Number(process.env.MEMORY_STORE_CC_RECORD_CONTEXT_CHARS || CODEX_RECORD_CONTEXT_CHARS);
export const CC_RECORD_TIMEOUT_MS = Number(process.env.MEMORY_STORE_CC_RECORD_TIMEOUT_MS || 3 * 60_000);
export const CC_RECORD_BACKGROUND_TIMEOUT_MS = Number(process.env.MEMORY_STORE_CC_RECORD_BACKGROUND_TIMEOUT_MS || 8 * 60_000);
export const RECORD_PARALLEL_MODE = (process.env.MEMORY_STORE_RECORD_PARALLEL_MODE || "off") as RecordParallelMode;
export const RECORD_PARALLEL_CONCURRENCY = Number(process.env.MEMORY_STORE_RECORD_PARALLEL_CONCURRENCY || 2);
export const RECORD_PARALLEL_RETRIES = Number(process.env.MEMORY_STORE_RECORD_PARALLEL_RETRIES || 1);
export const RECORD_PARALLEL_CHUNK_CHARS = Number(process.env.MEMORY_STORE_RECORD_PARALLEL_CHUNK_CHARS || 60_000);
export const RECORD_PARALLEL_DENSE_TOOL_THRESHOLD = Number(process.env.MEMORY_STORE_RECORD_PARALLEL_DENSE_TOOL_THRESHOLD || 120);
export const RECORD_PARALLEL_DENSE_TOOL_CHUNK_CHARS = Number(process.env.MEMORY_STORE_RECORD_PARALLEL_DENSE_TOOL_CHUNK_CHARS || 45_000);
export const RECORD_REDUCE_DIRECT_PATCH_LIMIT = Number(process.env.MEMORY_STORE_RECORD_REDUCE_DIRECT_PATCH_LIMIT || 4);
export const RECORD_REDUCE_GROUP_SIZE = Number(process.env.MEMORY_STORE_RECORD_REDUCE_GROUP_SIZE || 3);
export const RECORD_REDUCE_GROUP_CHARS = Number(process.env.MEMORY_STORE_RECORD_REDUCE_GROUP_CHARS || 70_000);
export const RECORD_REDUCE_MAX_LEVELS = Number(process.env.MEMORY_STORE_RECORD_REDUCE_MAX_LEVELS || 4);
/** local-compose 默认启用。动态读 env（而非模块级 const）便于测试按用例切换；生产中 env 固定，行为与原 const 完全一致。 */
export function isLocalComposeEnabled(): boolean {
    return process.env.MEMORY_STORE_RECORD_LOCAL_COMPOSE !== "0";
}
export const RECORD_FORCE_FULL_REBUILD = process.env.MEMORY_STORE_RECORD_FORCE_FULL_REBUILD === "1";
export const RECORD_COMPOSE_ROLLBACK_PHASES = Number(process.env.MEMORY_STORE_RECORD_COMPOSE_ROLLBACK_PHASES || 1);
export const RECORD_COMPOSE_MAX_ROLLBACK_PHASES = Number(process.env.MEMORY_STORE_RECORD_COMPOSE_MAX_ROLLBACK_PHASES || 2);
export const RECORD_COMPOSE_MIN_SIZE_RATIO = Number(process.env.MEMORY_STORE_RECORD_COMPOSE_MIN_SIZE_RATIO || 0.65);
export const RECORD_PARALLEL_SINGLE_CHUNK_RECORD_CHARS = Number(process.env.MEMORY_STORE_RECORD_PARALLEL_SINGLE_CHUNK_RECORD_CHARS || 30_000);
export const RECORD_ADJACENT_CONTEXT_ROUNDS = Number(process.env.MEMORY_STORE_RECORD_ADJACENT_CONTEXT_ROUNDS || 1);
export const RECORD_ADJACENT_CONTEXT_CHARS = Number(process.env.MEMORY_STORE_RECORD_ADJACENT_CONTEXT_CHARS || 6_000);
export const RECORD_PATCH_CHECKPOINT_ENABLED = process.env.MEMORY_STORE_RECORD_PATCH_CHECKPOINT !== "0";
export const RECORD_PATCH_CHECKPOINT_VERSION = 3;
/** 本地合成重写区估算字数超过此阈值时，改走串行累积管线避免单次长输出超时。
 *  1M 上下文模型输入不是瓶颈，瓶颈是「单次输出」长度，故从宽默认 ~40K。 */
export const RECORD_COMPOSE_SERIAL_THRESHOLD_CHARS = Number(process.env.MEMORY_STORE_RECORD_COMPOSE_SERIAL_THRESHOLD_CHARS || 40_000);
/** 串行累积每个子窗口最多吃多少字 patch（决定每步模型输出小段的规模）。 */
export const RECORD_COMPOSE_SERIAL_WINDOW_CHARS = Number(process.env.MEMORY_STORE_RECORD_COMPOSE_SERIAL_WINDOW_CHARS || 12_000);
/** 串行累积每个子窗口最多几个 patch。 */
export const RECORD_COMPOSE_SERIAL_WINDOW_PATCHES = Number(process.env.MEMORY_STORE_RECORD_COMPOSE_SERIAL_WINDOW_PATCHES || 3);
/** 串行累积每个子窗口最多覆盖多少【轮】。关键：单步模型【输出】规模主要由轮数决定；patch 可能很粗
 *  （一个 patch 覆盖几十轮），仅靠 patch 数/字数限不住输出长度，超过此轮数就切窗，防单窗轮数过多导致
 *  模型结构化输出超 token 上限被截断（d554f2b4 的 1-118 轮巨窗输出被截断成残缺 JSON 即此因）。 */
export const RECORD_COMPOSE_SERIAL_WINDOW_ROUNDS = Number(process.env.MEMORY_STORE_RECORD_COMPOSE_SERIAL_WINDOW_ROUNDS || 45);
/** 重写区轮数跨度超过此值时改走串行累积（输出长度主要由轮数决定，比压缩后字数更可靠）。 */
export const RECORD_COMPOSE_SERIAL_THRESHOLD_ROUNDS = Number(process.env.MEMORY_STORE_RECORD_COMPOSE_SERIAL_THRESHOLD_ROUNDS || 25);
/** B5/M3 治标：串行续写「未收尾开放 Phase」时，喂给下一窗模型的开放 Phase 上下文字符上限。
 *  契约要求模型把延续后的【完整】markdown（含历史已写部分）放进 phases[0]，所以必须喂全文；
 *  旧实现只喂末 1500 字 → 模型看不到头部 → 重产时丢头。代码本就持有完整累积 markdown，
 *  1M 上下文模型输入不是瓶颈，故上限定得很高（默认 50K）：正常开放 Phase 远不及、即喂全文；
 *  仅当病态超长（>此上限）时才头尾保留截断兜底，防极端情况撑爆。 */
export const RECORD_SERIAL_OPEN_PHASE_CONTEXT_CHARS = Number(process.env.MEMORY_STORE_RECORD_SERIAL_OPEN_PHASE_CONTEXT_CHARS || 50_000);
/** 单轮 formatted 文本硬上限：超过则对该轮做头尾保留+中段省略截断，防病态巨轮把整批 prompt 撑爆。
 *  默认 60K（对齐并行单批预算）：正常轮（实测约 20K）绝不触发，只截真·异常巨轮。 */
export const RECORD_MAX_SINGLE_ROUND_CHARS = Number(process.env.MEMORY_STORE_RECORD_MAX_SINGLE_ROUND_CHARS || 60_000);
/** 方案1（轮内 step 切分）：超大轮按 step 边界切成多个 part 逐段压缩时，单个 part 的目标字数上限。
 *  默认 28K：小于 RECORD_MAX_SINGLE_ROUND_CHARS，保证每段都能稳定喂模型压缩而不撑爆。 */
export const RECORD_ROUND_SPLIT_PART_CHARS = Number(process.env.MEMORY_STORE_RECORD_ROUND_SPLIT_PART_CHARS || 28_000);

// ============= 内容提取 =============

/**
 * 计算文本字符数
 */
export function charCount(text: string): number {
    return text.length;
}

/** 统一轮次范围文案：纯文本「轮次 s-e」（无括号），用于进度 detail / 错误消息 / 标题等。 */
export function roundRangeLabel(start: number | string, end: number | string): string {
    return `轮次 ${start}-${end}`;
}

/** 统一带全角括号的轮次标签「（轮次 s-e）」，用于 Phase 标题尾部标注。 */
export function patchRangeLabel(start: number | string, end: number | string): string {
    return `（轮次 ${start}-${end}）`;
}
