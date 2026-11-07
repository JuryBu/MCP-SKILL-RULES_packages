import assert from "node:assert/strict";

// C3 块A：error-format 单测——classifyError 分类/可重试性 + formatToolError 结构化与安全红线。
const { classifyError, formatToolError } = await import("../src/error-format.ts");

let failed = false;
function check(name: string, fn: () => void): void {
    try {
        fn();
        console.log(`  ✅ ${name}`);
    } catch (err) {
        failed = true;
        console.error(`  ❌ ${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
}

// 构造带 code 的 Node 风格错误
function errWithCode(message: string, code: string): Error & { code: string } {
    const e = new Error(message) as Error & { code: string };
    e.code = code;
    return e;
}

console.log("error-format 测试：");

// ── classifyError：各类输入不抛、分类正确、retryable 合理 ──
check("timeout 关键字 → timeout + retryable", () => {
    const r = classifyError(new Error("request timed out after 60s"));
    assert.equal(r.category, "timeout");
    assert.equal(r.retryable, true);
    assert.ok(r.hint.length > 0, "应有 hint");
});

check("ETIMEDOUT code → timeout + retryable", () => {
    const r = classifyError(errWithCode("connect failed", "ETIMEDOUT"));
    assert.equal(r.category, "timeout");
    assert.equal(r.retryable, true);
});

check("ENOENT / not found → not_found + 不可重试", () => {
    const r = classifyError(errWithCode("no such file", "ENOENT"));
    assert.equal(r.category, "not_found");
    assert.equal(r.retryable, false);
    const r2 = classifyError(new Error("记忆不存在: abc"));
    assert.equal(r2.category, "not_found");
});

check("EACCES / permission → permission + 不可重试", () => {
    const r = classifyError(errWithCode("permission denied", "EACCES"));
    assert.equal(r.category, "permission");
    assert.equal(r.retryable, false);
    const r2 = classifyError(errWithCode("operation not permitted", "EPERM"));
    assert.equal(r2.category, "permission");
});

check("invalid_input → invalid_input + 不可重试", () => {
    const r = classifyError(new Error("缺少必须参数 id"));
    assert.equal(r.category, "invalid_input");
    assert.equal(r.retryable, false);
    const r2 = classifyError(new Error("invalid_type: expected string, received undefined"));
    assert.equal(r2.category, "invalid_input");
});

check("明确来源参数错误 code → invalid_input + 不可重试", () => {
    const classified = classifyError(errWithCode("Unsupported corpus source", "CORPUS_SOURCE_INVALID"));
    assert.equal(classified.category, "invalid_input");
    assert.equal(classified.retryable, false);
    assert.doesNotMatch(classified.hint, /谨慎重试|重试一次/u);
});

check("network → network + retryable", () => {
    const r = classifyError(errWithCode("connect ECONNREFUSED", "ECONNREFUSED"));
    assert.equal(r.category, "network");
    assert.equal(r.retryable, true);
    const r2 = classifyError(new Error("fetch failed"));
    assert.equal(r2.category, "network");
});

check("普通 Error → unknown + 不可重试", () => {
    const r = classifyError(new Error("something weird happened"));
    assert.equal(r.category, "unknown");
    assert.equal(r.retryable, false);
    assert.equal(r.message, "something weird happened");
    assert.match(r.hint, /核对本次调用状态与已有结果/u);
    assert.doesNotMatch(r.hint, /重试/u);
});

check("字符串错误不抛、可归类", () => {
    const r = classifyError("plain string error");
    assert.equal(r.category, "unknown");
    assert.equal(r.message, "plain string error");
});

check("null / undefined / 数字 / 对象 不抛", () => {
    for (const v of [null, undefined, 42, { a: 1 }, []]) {
        const r = classifyError(v);
        assert.ok(typeof r.category === "string", `category 应为字符串 (输入=${String(v)})`);
        assert.ok(typeof r.retryable === "boolean");
        assert.ok(typeof r.message === "string");
    }
});

// ── formatToolError：含 action + 分类，且 keyArgs 安全 ──
check("含 action + 分类 + retryable + hint", () => {
    const text = formatToolError("memory_write", new Error("缺少 id"), { id: "x1" });
    assert.ok(text.includes("memory_write"), "应含 action");
    assert.ok(text.includes("分类"), "应含分类行");
    assert.ok(text.includes("invalid_input"), "应含具体分类");
    assert.ok(text.includes("可重试"), "应含 retryable 行");
    assert.ok(text.includes("建议"), "应含 hint 行");
});

check("keyArgs 绝不含 content（白名单过滤）", () => {
    const text = formatToolError("memory_write", new Error("boom"), {
        id: "k1",
        content: "这是一段绝对不能被回显的超长机密正文".repeat(50),
        append: "也不能回显的追加正文",
        workspace: "/proj",
    });
    assert.ok(!text.includes("机密正文"), "content 内容绝不能出现在错误文本里");
    assert.ok(!text.includes("追加正文"), "append 内容绝不能出现");
    assert.ok(text.includes("id=k1"), "白名单键 id 应回显");
    assert.ok(text.includes("workspace=/proj"), "白名单键 workspace 应回显");
});

check("keyArgs 超长值被截断到 ~80 字", () => {
    const longQuery = "q".repeat(500);
    const text = formatToolError("memory_query", new Error("boom"), { query: longQuery });
    // 回显里不应出现完整 500 字，应有截断标记
    assert.ok(!text.includes("q".repeat(200)), "超长值不应整段回显");
    assert.ok(text.includes("已截断"), "应有截断标记");
});

check("undefined 入参不回显", () => {
    const text = formatToolError("memory_query", new Error("boom"), { query: undefined, mode: "auto" });
    assert.ok(!text.includes("query="), "undefined 的键不应出现");
    assert.ok(text.includes("mode=auto"), "有值的白名单键应出现");
});

check("source 只回显安全来源枚举", () => {
    for (const source of ["auto", "local", "ls", "cache"]) {
        const text = formatToolError("conversation_read_original", new Error("boom"), { source });
        assert.ok(text.includes(`source=${source}`));
    }
    for (const source of ["private-source", "cache\nprivate-source", null, { token: "private-source" }, ["cache"]]) {
        const text = formatToolError("conversation_read_original", new Error("boom"), { source });
        assert.doesNotMatch(text, /source=|private-source/u);
    }
});

check("unknown 的不可重试标记与建议一致", () => {
    const text = formatToolError("conversation_read_original", new Error("boom"));
    assert.match(text, /分类: unknown/u);
    assert.match(text, /可重试: 否/u);
    assert.doesNotMatch(text, /谨慎重试|重试一次/u);
});

check("formatToolError 对非 Error 不抛", () => {
    const text = formatToolError("x", "string err", { id: "1" });
    assert.ok(text.includes("string err"));
});

if (failed) {
    console.error("❌ error-format 测试存在失败项");
    process.exit(1);
}
console.log("✅ error-format 全部通过");
