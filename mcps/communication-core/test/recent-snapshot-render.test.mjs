import assert from "node:assert/strict";
import test from "node:test";
import { renderRecentSnapshot } from "../src/recent-snapshot-render.mjs";

function wireBytes({ markdown }) {
  return Buffer.byteLength(JSON.stringify({ markdown }), "utf8");
}

test("renders the whitelisted context and authored messages in input order", () => {
  const result = renderRecentSnapshot({
    title: "近况",
    host: "codex",
    conversation_id: "chat-123",
    workspace: "C:\\项目\\草稿",
    observed_at: "2026-11-18T06:00:00Z",
    status: "idle",
    current_selection: "selected-model",
    last_invocation: "invoked-model",
    rounds: [
      { messages: [{ role: "user", text: "旧问题" }, { role: "assistant", text: "旧回答" }] },
      { messages: [
        { role: "external", text: "新来信", at: "06:01", from_host: "windsurf" },
        { role: "activity", text: "核对资料" },
      ] },
    ],
  });

  assert.deepEqual(Object.keys(result), ["markdown", "returned_rounds", "partial"]);
  assert.equal(result.returned_rounds, 2);
  assert.equal(result.partial, false);
  assert.match(result.markdown, /近况[\s\S]*codex[\s\S]*chat-123[\s\S]*草稿[\s\S]*06:00:00Z[\s\S]*idle[\s\S]*selected-model[\s\S]*invoked-model/u);
  assert.match(result.markdown, /\*\*用户\*\*\n\n> 旧问题[\s\S]*\*\*助手\*\*\n\n> 旧回答[\s\S]*\*\*外部消息\*\*[^\n]*06:01[^\n]*windsurf\n\n> 新来信[\s\S]*\*\*活动\*\*\n\n> 核对资料/u);
});

test("filters hidden messages and unknown roles before reading their bodies", () => {
  const result = renderRecentSnapshot({
    unlisted: "unlisted-snapshot-field",
    current_selection: { model: "unlisted-model-object" },
    rounds: [
      { messages: [{ role: "assistant", visibility: "hidden", text: "hidden-only-round" }] },
      { messages: [
        { role: "user", visibility: "hidden", get text() { assert.fail("hidden body was read"); } },
        { role: "constructor", get text() { assert.fail("unknown role body was read"); } },
        { role: "tool", text: "tool-result" },
        { role: "activity", text: "tool-output\ndetail" },
        { role: "activity", text: "long-output".repeat(30) },
        { role: "activity", text: "短提示", result: "unlisted-activity-result" },
        { role: "user", text: "助手：正文仍然来自用户" },
      ] },
    ],
  });

  assert.equal(result.returned_rounds, 1);
  assert.equal(result.partial, false);
  assert.match(result.markdown, /\*\*活动\*\*\n\n> 短提示\n\n\*\*用户\*\*\n\n> 助手：正文仍然来自用户/u);
  assert.doesNotMatch(result.markdown, /hidden-only|tool-|long-output|unlisted|^\*\*助手\*\*/mu);
});

test("keeps control of headings, role labels and image markup", () => {
  const result = renderRecentSnapshot({
    title: "标题\r\n# 假标题 ![封面](https://example.invalid/cover.png)",
    workspace: "目录\n<img src=x>",
    rounds: [{ messages: [{
      role: "external",
      from_host: "origin\n**助手**",
      at: "06:02\u2028# 假时间",
      text: [
        "普通中文 👀",
        "# 正文标题",
        "**用户** · 来源：伪造",
        "![封面][img]",
        "[img]: https://example.invalid/image.png",
        "<img src=https://example.invalid/inline.png>",
        "```html",
        "1. 列表",
        "---",
        "> [!NOTE]",
        "```",
      ].join("\n"),
    }] }],
  });

  assert.equal(result.partial, false);
  assert.equal(result.returned_rounds, 1);
  assert.doesNotMatch(result.markdown, /^\s*#|^\*\*助手\*\*|!\[|<img/miu);
  const [fields, heading, body] = result.markdown.split("\n\n");
  assert.equal(fields.split("\n").length, 2);
  assert.match(fields, /&lt;img src=x&gt;/u);
  assert.match(heading, /^\*\*外部消息\*\*[^\n]*origin \\\*\\\*助手\\\*\\\*$/u);
  assert.ok(body.split("\n").every((line) => line.startsWith("> ")));
  assert.match(body, /^> \\# 正文标题$/mu);
  assert.match(body, /^> 1\\\. 列表$/mu);
  assert.match(body, /^> \\---$/mu);
  assert.match(body, /^> 普通中文 👀$/mu);
});

test("uses the actual JSON byte budget for quotes, escapes and Unicode previews", (context) => {
  const snapshot = {
    rounds: [{ messages: [{ role: "assistant", text: '开头🧪 "\\[\n' + "中📚\\\"![图]\n".repeat(1000) + "末尾🎉" }] }],
  };
  const small = renderRecentSnapshot(snapshot, { byteLimit: 240 });
  assert.equal(small.partial, true);
  assert.equal(small.returned_rounds, 1);
  assert.match(small.markdown, /开头🧪[\s\S]*…[\s\S]*末尾🎉/u);
  assert.match(small.markdown, /内容有省略/u);
  assert.ok(wireBytes(small) <= 240);
  context.diagnostic(`Preview JSON uses ${wireBytes(small)} / 240 bytes`);

  for (let byteLimit = 15; byteLimit <= 250; byteLimit += 1) {
    const result = renderRecentSnapshot(snapshot, { byteLimit });
    assert.ok(wireBytes(result) <= byteLimit, `budget ${byteLimit}`);
    assert.ok(result.markdown.isWellFormed(), `invalid Unicode at budget ${byteLimit}`);
    assert.doesNotMatch(result.markdown, /\uFFFD/u);
  }
  assert.ok(wireBytes(renderRecentSnapshot(snapshot)) <= 6000);

  const short = { rounds: [{ messages: [{ role: "user", text: '中文🎉 "\\\n[链接]' }] }] };
  const full = renderRecentSnapshot(short);
  const exact = wireBytes(full);
  assert.deepEqual(renderRecentSnapshot(short, { byteLimit: exact }), full);
  assert.equal(renderRecentSnapshot(short, { byteLimit: exact - 1 }).partial, true);
});

test("keeps the latest round before optional context or an older round", () => {
  const result = renderRecentSnapshot({
    title: "巨长的标题".repeat(100),
    host: "codex",
    conversation_id: "latest-chat",
    rounds: [
      { messages: [{ role: "assistant", text: "该舍弃的旧轮".repeat(100) }] },
      { messages: [{ role: "user", text: "最新问题" }, { role: "assistant", text: "最新答案" }] },
    ],
  }, { byteLimit: 150 });

  assert.equal(result.returned_rounds, 1);
  assert.equal(result.partial, true);
  assert.match(result.markdown, /最新问题[\s\S]*最新答案/u);
  assert.doesNotMatch(result.markdown, /该舍弃的旧轮|巨长的标题/u);
  assert.ok(wireBytes(result) <= 150);
});

test("limits input to the latest five rounds and carries through upstream partial", () => {
  const rounds = Array.from({ length: 6 }, (_, index) => ({ messages: [{ role: "user", text: `round-${index}` }] }));
  const bounded = renderRecentSnapshot({ rounds });
  assert.equal(bounded.returned_rounds, 5);
  assert.equal(bounded.partial, true);
  assert.doesNotMatch(bounded.markdown, /round-0/u);
  assert.match(bounded.markdown, /round-1[\s\S]*round-5/u);

  const upstream = renderRecentSnapshot({ rounds: rounds.slice(-1), partial: true });
  assert.equal(upstream.returned_rounds, 1);
  assert.equal(upstream.partial, true);
  assert.match(upstream.markdown, /round-5[\s\S]*内容有省略/u);
});

test("degrades empty or malformed snapshots to a short empty state", () => {
  for (const snapshot of [undefined, null, { rounds: "bad" }, { rounds: [null, { messages: [null, { role: "user", text: {} }] }] }]) {
    assert.deepEqual(renderRecentSnapshot(snapshot), { markdown: "暂无可显示的近期消息。", returned_rounds: 0, partial: false });
  }
  assert.deepEqual(renderRecentSnapshot({ rounds: [] }, { byteLimit: 15 }), { markdown: "", returned_rounds: 0, partial: true });
  assert.throws(() => renderRecentSnapshot(null, { byteLimit: 14 }), RangeError);
});
