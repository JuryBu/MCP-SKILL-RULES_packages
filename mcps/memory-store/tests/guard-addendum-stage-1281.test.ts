import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveGuardTargetDocument } from "../src/guard-target-scope.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "guard-stage-1281-"));
const filename = path.join(root, "Task.md");
try {
    await fs.writeFile(filename, "# Task\n\n## Stage3：旧交付\n- [x] 已交付\n\n## Stage4：在线默认入口追加补修\n- [ ] 当前修复\n\n### 自然使用\n- [ ] 当前使用\n\n## 待复核/小本本\nStage4：旧备注\n");
    const result = resolveGuardTargetDocument(filename, "task", "Stage4", ["Stage4："]);
    assert.deepEqual(result.gaps, []);
    assert.equal(result.ranges.length, 1);
    assert.equal(result.ranges[0].startLine, 6);
    assert.equal(result.ranges[0].endLine, 11);
    console.log("PASS explicit addendum-named stage selected; unrelated notes excluded");
} finally {
    await fs.unlink(filename);
    await fs.rmdir(root);
}
