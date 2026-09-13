import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-description-contract-"));
process.env.SANDBOX_DATA_ROOT = temporaryRoot;
const registrations = new Map();
const server = { tool(name, description, shape) { registrations.set(name, { description, shape }); } };
for (const [moduleName, exportName] of [["exec", "registerExec"], ["batch", "registerBatch"], ["session", "registerSession"], ["launch", "registerLaunch"], ["codex", "registerCodex"], ["status", "registerStatus"]]) {
    const module = await import(`../mcps/sandbox/dist/tools/${moduleName}.js`);
    module[exportName](server);
}
const { inferMemoryRequestMB } = await import("../mcps/sandbox/dist/memory-limits.js");

for (const name of ["sandbox_exec", "sandbox_session", "sandbox_launch", "sandbox_codex"]) {
    test(`${name} distinguishes explicit small requests from default estimates`, () => {
        const field = registrations.get(name).shape.memoryRequestMB;
        assert.equal(field.safeParse(16).success, true);
        assert.equal(field.safeParse(24).success, true);
        assert.equal(field.safeParse(15).success, false);
        assert.match(field.description, /16.*maxMemoryMB/);
        assert.match(field.description, /显式24MB/);
        assert.match(field.description, /默认|省略/);
    });
}

test("batch nested schema and local budget describe separate restrictions", () => {
    const registration = registrations.get("sandbox_batch");
    const field = registration.shape.tasks.element.shape.memoryRequestMB;
    assert.equal(field.safeParse(24).success, true);
    assert.match(field.description, /显式24MB按24MB/);
    assert.match(registration.shape.maxTotalMemoryMB.description, /局部.*预算/);
    assert.match(registration.description, /admissionDecision.blockedBy/);
});

test("default estimate lower bound never overrides a lower hard limit", () => {
    assert.equal(inferMemoryRequestMB(16), 16);
    assert.equal(inferMemoryRequestMB(24), 24);
    assert.equal(inferMemoryRequestMB(128), 64);
    assert.equal(inferMemoryRequestMB(256), 64);
    assert.equal(inferMemoryRequestMB(257), 65);
});

for (const name of ["sandbox_exec", "sandbox_batch", "sandbox_codex"]) {
    test(`${name} admission budget is not an execution timeout or proof of low memory`, () => {
        const description = registrations.get(name).shape.admissionBudgetMs.description;
        assert.match(description, /启动前/);
        assert.match(description, /admissionDecision.blockedBy/);
        assert.match(description, /不.*缺内存/);
    });
}

test("session local limits and status diagnostic entry remain explicit", () => {
    assert.match(registrations.get("sandbox_session").description, /局部限制/);
    assert.match(registrations.get("sandbox_session").description, /没有移除/);
    assert.match(registrations.get("sandbox_status").description, /admissionDecision.blockedBy/);
});

test("persistent tool examples use short polling without claiming schema enforcement", () => {
    const codex = registrations.get("sandbox_codex");
    assert.match(codex.shape.waitSeconds.description, /30～45/);
    assert.equal(codex.shape.waitSeconds.safeParse(120).success, true);
    assert.match(codex.description, /waitSeconds=45/);
    assert.doesNotMatch(codex.description, /建议 90-120s/);
    assert.match(registrations.get("sandbox_launch").description, /waitSeconds=45/);
});

test("guide, README and four public Rules explain the current boundaries", () => {
    const root = new URL("../", import.meta.url);
    const guide = fs.readFileSync(new URL("mcps/sandbox/src/index.ts", root), "utf8");
    const readme = fs.readFileSync(new URL("mcps/sandbox/README.md", root), "utf8");
    assert.match(guide, /v1\.18\.1 使用指南/);
    assert.match(readme, /^# MCP Sandbox v1\.18\.1/);
    for (const relative of ["rules/codex/components/core.template.md", "rules/antigravity/GEMINI.template.md", "rules/claude-code/CLAUDE.template.md", "rules/windsurf/system_rules/tools.template.md"]) {
        const rules = fs.readFileSync(new URL(relative, root), "utf8");
        assert.match(rules, /不要为了等待而盲目低报/);
        assert.match(rules, /默认推导的64MB下限不适用于显式24MB/);
        assert.match(rules, /Session会话数\/合计额度和batch局部并发预算/);
        assert.match(rules, /tools\/list/);
    }
});

after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
