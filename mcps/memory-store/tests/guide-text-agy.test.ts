import assert from "node:assert/strict";
import { GUIDE_TEXT } from "../src/guide-text.ts";

assert.match(GUIDE_TEXT, /modelChain="auto\|antigravity\|codex\|claude-code\|cc\|grok\|agy"/u);
assert.match(GUIDE_TEXT, /dataChain 不支持 grok 或 agy/u);
assert.match(GUIDE_TEXT, /MEMORY_STORE_AGY_AUTO_ENABLED=1/u);
assert.match(GUIDE_TEXT, /Grok →（仅 MEMORY_STORE_AGY_AUTO_ENABLED=1 时）agy → Antigravity → Codex/u);
assert.match(GUIDE_TEXT, /agy 内部仅按「Gemini 3\.5 Flash \(High\) → Flash \(Medium\) → Gemini 3\.1 Pro \(Low\)」fallback/u);
assert.match(GUIDE_TEXT, /agy 不能填入 dataChain/u);

console.log("guide text agy tests passed");
