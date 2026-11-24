const MAX_ROUNDS = 5;
const SHORT_FIELD_UNITS = 160;
const SEPARATOR = "\n\n";
const EMPTY_HISTORY = "暂无可显示的近期消息。";
const ELLIPSIS = "…";
const PARTIAL_NOTICE = "…（内容有省略）";
const ENVELOPE_BYTES = Buffer.byteLength(JSON.stringify({ markdown: "" }), "utf8");
const SEPARATOR_BYTES = markdownBytes(SEPARATOR);

const ROLE_LABELS = new Map([
  ["user", "用户"],
  ["assistant", "助手"],
  ["external", "外部消息"],
  ["activity", "活动"],
]);

const SNAPSHOT_FIELDS = [
  ["title", "标题"],
  ["host", "宿主"],
  ["conversation_id", "对话 ID"],
  ["workspace", "工作区"],
  ["project_id", "项目 ID"],
  ["observed_at", "观测时间"],
  ["status", "状态"],
  ["current_selection", "当前选择"],
  ["current_selection_at", "选型观测时间"],
  ["last_invocation", "最近调用"],
  ["last_invocation_at", "调用记录时间"],
];

function markdownBytes(markdown) {
  return Buffer.byteLength(JSON.stringify({ markdown }), "utf8") - ENVELOPE_BYTES;
}

function remainingAfter(budget, markdown) {
  return markdown ? Math.max(0, budget - markdownBytes(markdown) - SEPARATOR_BYTES) : budget;
}

function normalizeText(text) {
  return text.toWellFormed()
    .replace(/\r\n?|[\u0085\u2028\u2029]/gu, "\n")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, "\uFFFD");
}

function escapeInline(text) {
  return text.replace(/[\\`*_\[\]~|]/gu, "\\$&")
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;");
}

function singleLine(text) {
  return escapeInline(normalizeText(text).replace(/[\t\n]+/gu, " ").trim());
}

function quoteText(text) {
  return escapeInline(normalizeText(text)).split("\n").map((line) => (
    `> ${line.replace(/^([ \t]*)([#=+-])/u, "$1\\$2")
      .replace(/^([ \t]*\d{1,9})([.)])/u, "$1\\$2")}`
  )).join("\n");
}

function splitSurrogatePair(text, offset) {
  const before = text.charCodeAt(offset - 1);
  const after = text.charCodeAt(offset);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

function previewText(text, budget) {
  let low = 1;
  let high = Math.min(text.length - 1, budget);
  let best = "";
  while (low <= high) {
    const units = Math.floor((low + high) / 2);
    let headEnd = Math.ceil(units / 2);
    let tailStart = text.length - Math.floor(units / 2);
    if (splitSurrogatePair(text, headEnd)) headEnd -= 1;
    if (splitSurrogatePair(text, tailStart)) tailStart += 1;
    const preview = quoteText(`${text.slice(0, headEnd)}${ELLIPSIS}${text.slice(tailStart)}`);
    if (markdownBytes(preview) > budget) {
      high = units - 1;
    } else {
      if (headEnd || tailStart < text.length) best = preview;
      low = units + 1;
    }
  }
  return best;
}

function renderHeader(snapshot, budget) {
  let markdown = "";
  let partial = false;
  for (const [key, label] of SNAPSHOT_FIELDS) {
    const value = snapshot?.[key];
    if (typeof value !== "string" || !value) continue;
    if (value.length > budget) {
      partial = true;
      continue;
    }
    const display = singleLine(value);
    if (!display) continue;
    const line = `${markdown ? "\n" : ""}- **${label}：** ${display}`;
    const bytes = markdownBytes(line);
    if (bytes > budget) {
      partial = true;
      continue;
    }
    markdown += line;
    budget -= bytes;
  }
  return { markdown, partial };
}

function renderMessage(message, label, text, budget, allowPreview) {
  const role = `**${label}**`;
  const details = [role];
  for (const [value, field] of [[message.at, "时间"], [message.from_host, "来源"]]) {
    if (typeof value !== "string" || value.length > SHORT_FIELD_UNITS) continue;
    const display = singleLine(value);
    if (display) details.push(`**${field}：** ${display}`);
  }
  const heading = details.join(" · ");
  const body = text.length <= budget ? quoteText(text) : "";
  if (body) {
    const markdown = heading + SEPARATOR + body;
    if (markdownBytes(markdown) <= budget) return { markdown, partial: false };
  }
  if (allowPreview) {
    const headings = heading === role ? [role] : [heading, role];
    if (body && heading !== role) {
      const markdown = role + SEPARATOR + body;
      if (markdownBytes(markdown) <= budget) return { markdown, partial: true };
    }
    for (const candidate of headings) {
      const prefix = candidate + SEPARATOR;
      const preview = previewText(text, budget - markdownBytes(prefix));
      if (preview) return { markdown: prefix + preview, partial: true };
    }
  }
  return { markdown: "", partial: true };
}

function renderRound(round, budget, allowPreview) {
  const messages = round?.messages;
  if (!Array.isArray(messages)) return { markdown: "", partial: false };
  const blocks = [];
  let partial = false;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.visibility === "hidden") continue;
    const label = ROLE_LABELS.get(message?.role);
    if (!label || typeof message.text !== "string") continue;
    if (message.role === "activity" && (message.text.length > SHORT_FIELD_UNITS || /[\r\n\u0085\u2028\u2029]/u.test(message.text))) continue;
    const text = message.text.trim();
    if (!text) continue;
    const entry = renderMessage(message, label, text, budget, allowPreview);
    if (entry.partial && !allowPreview) return { markdown: "", partial: true };
    if (entry.markdown) blocks.push(entry.markdown);
    if (entry.partial) {
      partial = true;
      break;
    }
    budget = remainingAfter(budget, entry.markdown);
  }
  return { markdown: blocks.reverse().join(SEPARATOR), partial };
}

function renderWithin(snapshot, rounds, budget) {
  let index = rounds.length - 1;
  let latest;
  for (; index >= 0; index -= 1) {
    const round = renderRound(rounds[index], budget, true);
    if (round.markdown || round.partial) {
      latest = round;
      break;
    }
  }
  const fallback = !latest && markdownBytes(EMPTY_HISTORY) <= budget ? EMPTY_HISTORY : "";
  const history = latest?.markdown ? [latest.markdown] : [];
  const afterLatest = remainingAfter(budget, latest?.markdown || fallback);
  const header = renderHeader(snapshot, afterLatest);
  let remaining = remainingAfter(afterLatest, header.markdown);
  let partial = (latest ? latest.partial : !fallback) || header.partial;
  if (latest && !latest.partial) {
    for (index -= 1; index >= 0; index -= 1) {
      const round = renderRound(rounds[index], remaining, false);
      if (round.partial) {
        partial = true;
        break;
      }
      if (round.markdown) history.push(round.markdown);
      remaining = remainingAfter(remaining, round.markdown);
    }
  }
  return {
    markdown: [header.markdown, ...history.reverse(), fallback].filter(Boolean).join(SEPARATOR),
    returned_rounds: history.length,
    partial,
  };
}

export function renderRecentSnapshot(snapshot, options = {}) {
  const { byteLimit = 6000 } = options ?? {};
  const limit = Number.isFinite(byteLimit) ? Math.floor(byteLimit) : 6000;
  if (limit < ENVELOPE_BYTES) throw new RangeError(`byteLimit must be at least ${ENVELOPE_BYTES}`);
  const budget = limit - ENVELOPE_BYTES;
  const candidates = Array.isArray(snapshot?.rounds) ? snapshot.rounds : [];
  const rounds = candidates.slice(-MAX_ROUNDS);
  const full = renderWithin(snapshot, rounds, budget);
  if (!full.partial && snapshot?.partial !== true && candidates.length === rounds.length) return full;

  const notice = budget >= 64 ? PARTIAL_NOTICE : ELLIPSIS;
  if (markdownBytes(notice) > budget) return { ...full, partial: true };
  const contentBudget = remainingAfter(budget, notice);
  const view = markdownBytes(full.markdown) <= contentBudget ? full : renderWithin(snapshot, rounds, contentBudget);
  return {
    markdown: [view.markdown, notice].filter(Boolean).join(SEPARATOR),
    returned_rounds: view.returned_rounds,
    partial: true,
  };
}
