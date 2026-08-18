import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    registerLsEntry,
    readRegistry,
    cleanupRegistryOnExit,
    markHeartbeatFailure,
    listLiveEntries,
    __setRegistryPathForTest,
    __resetRegisteredPidsForTest,
    type RegistryEntry,
} from "../src/ls-registry.ts";

/**
 * 注销 key 错位 bug 修复（失败路径 ⑥-b 闭环）。
 *
 * 基线红（旧逻辑）：cleanupRegistryOnExit 删写死的 String(process.ppid)。
 * broker 环境下 ppid = broker pid ≠ 真实注册的 LS pid，导致删不掉真实条目、泄漏死条目。
 * 修复后：按 registeredPids（本进程实际注册过的真实 LS pid 集合）删除。
 *
 * 用 __setRegistryPathForTest 隔离到临时文件，不污染真实注册表。
 */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ls-registry-cleanup-"));
const regPath = path.join(tmpDir, "ls-registry.json");
__setRegistryPathForTest(regPath);
__resetRegisteredPidsForTest();

function entry(pid: number, port: number): RegistryEntry {
    return { pid, port, csrfToken: `csrf-${pid}`, workspaceId: `ws-${pid}`, registeredAt: new Date().toISOString() };
}

try {
    // ===== 用例 1：注册 → 注销读回验证删除成功（broker 场景，注册 pid ≠ ppid）=====
    {
        __resetRegisteredPidsForTest();
        // 真实 LS pid 故意不等于 process.ppid（模拟 broker：ppid 是 broker，注册的是真实 LS）
        const realLsPid = 424242;
        assert.notEqual(String(realLsPid), String(process.ppid), "测试前提：真实 LS pid ≠ ppid（broker 场景）");

        const ok = registerLsEntry(entry(realLsPid, 9001));
        assert.equal(ok, true, "注册应成功");
        assert.ok(readRegistry().processes[String(realLsPid)], "注册后表中应有真实 LS 条目");

        cleanupRegistryOnExit();
        const after = readRegistry();
        assert.ok(!after.processes[String(realLsPid)], "注销应按 registeredPids 删除真实 LS 条目（旧逻辑删 ppid 会泄漏）");
    }

    // ===== 用例 2：多条注册 → 注销只删本进程注册过的，不误删他人条目 =====
    {
        __resetRegisteredPidsForTest();
        // 预置一条「别的进程」注册的条目（直接写文件，不经 registerLsEntry → 不入 registeredPids）
        const foreignPid = 555001;
        fs.writeFileSync(regPath, JSON.stringify({ processes: { [String(foreignPid)]: entry(foreignPid, 9100) } }, null, 2), "utf-8");

        // 本进程注册两条
        registerLsEntry(entry(600001, 9201));
        registerLsEntry(entry(600002, 9202));

        cleanupRegistryOnExit();
        const after = readRegistry();
        assert.ok(after.processes[String(foreignPid)], "他人条目不应被误删");
        assert.ok(!after.processes["600001"], "本进程注册的条目应被注销");
        assert.ok(!after.processes["600002"], "本进程注册的条目应被注销");
    }

    // ===== 用例 3：删空 → 整个文件被删 =====
    {
        __resetRegisteredPidsForTest();
        if (fs.existsSync(regPath)) fs.unlinkSync(regPath);
        registerLsEntry(entry(700001, 9301));
        assert.ok(fs.existsSync(regPath), "注册后文件应存在");
        cleanupRegistryOnExit();
        assert.ok(!fs.existsSync(regPath), "删空后整个注册表文件应被删除");
    }

    // ===== 用例 4：本进程未注册任何 LS → 注销不动他人条目 =====
    {
        __resetRegisteredPidsForTest();
        const foreignPid = 800001;
        fs.writeFileSync(regPath, JSON.stringify({ processes: { [String(foreignPid)]: entry(foreignPid, 9400) } }, null, 2), "utf-8");
        cleanupRegistryOnExit();
        const after = readRegistry();
        assert.ok(after.processes[String(foreignPid)], "本进程没注册过 → 注销应 no-op，不动他人条目");
    }

    // ===== 用例 5：listLiveEntries 死条目过滤触发 markHeartbeatFailure =====
    {
        __resetRegisteredPidsForTest();
        const deadPid = 999999; // 几乎不可能存在的 pid → process.kill(pid,0) 抛 → 视为死
        fs.writeFileSync(regPath, JSON.stringify({ processes: { [String(deadPid)]: entry(deadPid, 9500) } }, null, 2), "utf-8");
        const live = listLiveEntries();
        assert.equal(live.length, 0, "死 pid 不应出现在存活列表");
        // markHeartbeatFailure 被触发（间接验证：再失败两次会移除，这里仅验证不抛 + 过滤生效）
        assert.equal(typeof markHeartbeatFailure(String(deadPid)), "boolean", "markHeartbeatFailure 应可正常调用");
    }

    console.log("ls-registry-cleanup.test.ts PASS");
} finally {
    __setRegistryPathForTest(null);
    __resetRegisteredPidsForTest();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
}
