import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 必须在导入 store 之前设隔离数据根（store 加载时按 env 算路径）
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-concurrent-lock-"));
process.env.MEMORY_STORE_DATA_ROOT = dataRoot;

const { mutateWorkspaceIndex, readWorkspaceIndex, ensureWorkspace } = await import("../src/store.ts");

function fakeEntry(id: string) {
    return {
        id, title: `t-${id}`, searchSummary: "", tags: [], category: "general",
        createdAt: "2026-01-01", updatedAt: "2026-01-01", lastAccessed: "2026-01-01",
        sizeBytes: 0, lineCount: 0,
    } as any;
}

try {
    const { hash } = ensureWorkspace("C:/test/concurrent-lock-ws");

    // ① 并发 50 次写同一工作区 → 全部落地、不丢不重（裸奔 read-modify-write 会丢，加锁后不丢）
    await Promise.all(Array.from({ length: 50 }, (_, i) =>
        mutateWorkspaceIndex(hash, (idx) => { idx.entries.push(fakeEntry(`m${i}`)); })));
    let idx = readWorkspaceIndex(hash);
    assert.equal(idx.entries.length, 50, `并发 50 写应全部落地不丢，实际 ${idx.entries.length}`);
    assert.equal(new Set(idx.entries.map(e => e.id)).size, 50, "条目 id 应无重复无丢失");

    // ② 混合并发 update + delete → 索引一致
    await Promise.all([
        ...Array.from({ length: 10 }, (_, i) => mutateWorkspaceIndex(hash, (x) => {
            const e = x.entries.find(e => e.id === `m${i}`); if (e) e.title = `up-${i}`;
        })),
        ...Array.from({ length: 10 }, (_, i) => mutateWorkspaceIndex(hash, (x) => {
            x.entries = x.entries.filter(e => e.id !== `m${40 + i}`);
        })),
    ]);
    idx = readWorkspaceIndex(hash);
    assert.equal(idx.entries.length, 40, `删 10 条后应剩 40，实际 ${idx.entries.length}`);
    assert.equal(idx.entries.find(e => e.id === "m0")?.title, "up-0", "并发 update 应生效");
    // 落盘与缓存一致：直接读文件
    const onDisk = JSON.parse(fs.readFileSync(path.join(dataRoot, "workspaces", hash, "_index.json"), "utf-8"));
    assert.equal(onDisk.entries.length, 40, "落盘文件应与内存索引一致（40 条）");

    // ③ 死锁回归：mutate 与只读并发 200 次，应在 5s 内完成（per-hash 锁不与任何锁嵌套）
    const start = Date.now();
    await Promise.all(Array.from({ length: 200 }, (_, i) =>
        i % 2 === 0
            ? mutateWorkspaceIndex(hash, (x) => { x.entries.push(fakeEntry(`d${i}`)); })
            : Promise.resolve(readWorkspaceIndex(hash))));
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 5000, `并发 mutate+read 200 次应 <5s（无死锁），实际 ${elapsed}ms`);

    // ④ general 热点路径（hash="general"，独立走 readGeneralIndex/GENERAL_DIR）也走同一把锁、不丢
    fs.mkdirSync(path.join(dataRoot, "general"), { recursive: true });
    await Promise.all(Array.from({ length: 30 }, (_, i) =>
        mutateWorkspaceIndex("general", (x) => { x.entries.push(fakeEntry(`g${i}`)); })));
    assert.equal(readWorkspaceIndex("general").entries.length, 30, "general 并发 30 写应全部落地");

    console.log("✅ concurrent-index-lock 全部通过：并发写不丢条目、混合 update+delete 一致、落盘一致、无死锁、general 热点正常");
} finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
}
