import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { extractAntigravityToolImages } from "../src/conversation-attachments.js";

// E3：反重力工具图提取（从 mcpTool.resultString 文本里的本地路径提取，文件存在才提取）
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ep-e3-"));
const img = path.join(tmpDir, "screenshot.png");
fs.writeFileSync(img, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

// 1. 存在的工具截图路径 → 提取，带 stepIndex
const mt1 = {
    toolCall: { name: "web_fetch_screenshot" },
    resultString: `截图完成 (56.0 KB) — 第1页/共251页 质量: clear | 文件: ${img}  使用 view_file 工具查看此图片`,
};
const r1 = extractAntigravityToolImages(mt1, 35);
assert.equal(r1.length, 1, "存在的工具截图应被提取");
assert.equal(r1[0].source, "antigravity-uri");
assert.equal(r1[0].kind, "image");
assert.equal(r1[0].stepIndex, 35, "提取的图应带原始 step 号");
assert.equal(path.normalize(r1[0].originalPath || ""), path.normalize(img));
assert.equal(r1[0].exists, true);

// 2. 已清理（不存在）的路径 → 降级不提取
const mt2 = { resultString: `截图完成 | 文件: ${path.join(tmpDir, "gone.jpg")}  使用 view_file` };
assert.equal(extractAntigravityToolImages(mt2, 36).length, 0, "已清理的临时文件不提取（降级）");

// 3. 无 resultString / 无路径 → 空
assert.equal(extractAntigravityToolImages({}, 1).length, 0);
assert.equal(extractAntigravityToolImages({ resultString: "纯文本无任何路径" }, 1).length, 0);

// 4. 多路径提取 + 去重 + 中文路径
const img2 = path.join(tmpDir, "课件图p83.jpg");
fs.writeFileSync(img2, Buffer.from([0xff, 0xd8, 0xff]));
const mt4 = { resultString: `文件: ${img}\n又一张: ${img2}\n重复同一张: ${img}` };
const r4 = extractAntigravityToolImages(mt4, 40);
assert.equal(r4.length, 2, "多路径提取且去重（重复路径只算一次，中文路径可提取）");
assert.ok(r4.every(a => a.stepIndex === 40));

// 5. 非图片扩展名不误提取
const mt5 = { resultString: `输出文件: ${path.join(tmpDir, "data.txt")}` };
assert.equal(extractAntigravityToolImages(mt5, 5).length, 0, "非图片扩展名不提取");

fs.rmSync(tmpDir, { recursive: true, force: true });
console.log("✅ antigravity-tool-image (E3) 通过：存在提取/不存在降级/空/多路径去重/中文路径/非图片不取/stepIndex");
