import crypto from "node:crypto";
import { TextDecoder } from "node:util";

const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const fail = code => { throw new Error(code); };

function tableParts(value) {
  const parts = [];
  let remaining = value.trim();
  while (remaining) {
    const match = remaining.match(/^(?:([a-zA-Z0-9_-]+)|("(?:[^"\\]|\\.)*")|('[^']*'))\s*/u);
    if (!match) fail("NETWORK_CONFIG_TABLE_FORMAT_UNSUPPORTED");
    let part;
    try { part = match[1] ?? (match[2] ? JSON.parse(match[2]) : match[3].slice(1, -1)); }
    catch { fail("NETWORK_CONFIG_TABLE_FORMAT_UNSUPPORTED"); }
    parts.push(part);
    remaining = remaining.slice(match[0].length);
    if (!remaining) break;
    if (!remaining.startsWith(".")) fail("NETWORK_CONFIG_TABLE_FORMAT_UNSUPPORTED");
    remaining = remaining.slice(1).trimStart();
    if (!remaining) fail("NETWORK_CONFIG_TABLE_FORMAT_UNSUPPORTED");
  }
  if (!parts.length) fail("NETWORK_CONFIG_TABLE_FORMAT_UNSUPPORTED");
  return parts;
}

function assignmentKey(content) {
  const match = content.match(/^\s*((?:[a-zA-Z0-9_-]+|"(?:[^"\\]|\\.)*"|'[^']*')(?:\s*\.\s*(?:[a-zA-Z0-9_-]+|"(?:[^"\\]|\\.)*"|'[^']*'))*)\s*=/u);
  return match ? { rawKey: match[1].trim(), keyParts: tableParts(match[1]) } : { rawKey: null, keyParts: [] };
}

export function buildNetworkConfigRoute(original, route, profile, websocketUrl) {
  if (!route || typeof route !== "object" || Array.isArray(route)
    || Object.keys(route).some(key => !["provider", "baseUrl"].includes(key))
    || !/^[a-zA-Z0-9_-]{1,64}$/u.test(route.provider ?? "")
    || !Number.isSafeInteger(profile.innerPort) || profile.innerPort < 1 || profile.innerPort > 65535) fail("NETWORK_CONFIG_ROUTE_REQUIRED");
  const responsePath = websocketUrl ? new URL(websocketUrl).pathname.replace(/\/responses$/u, "") : "/backend-api/codex";
  const baseUrl = `http://127.0.0.1:${profile.innerPort}${responsePath}`;
  if (route.baseUrl !== baseUrl) fail("NETWORK_CONFIG_INNER_ENDPOINT_MISMATCH");
  const hasBom = original.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]));
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(original.subarray(hasBom ? 3 : 0)); }
  catch { fail("NETWORK_CONFIG_UTF8_REQUIRED"); }
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = [...text.matchAll(/[^\r\n]*(?:\r\n|\n|\r|$)/gu)].filter(match => match[0].length);
  const root = [];
  const sections = new Map();
  let section = null;
  let firstTable = text.length;
  for (const match of lines) {
    const content = match[0].replace(/[\r\n]+$/u, "");
    if (/^\s*#/u.test(content) || !content.trim()) continue;
    if (content.includes('"""') || content.includes("'''")) fail("NETWORK_CONFIG_MULTILINE_UNSUPPORTED");
    if (/^\s*\[/u.test(content)) {
      const header = content.match(/^\s*(\[\[|\[)(.*?)(\]\]|\])\s*(?:#.*)?$/u);
      if (!header || (header[1].length !== header[3].length)) fail("NETWORK_CONFIG_TABLE_FORMAT_UNSUPPORTED");
      const parts = tableParts(header[2]);
      firstTable = Math.min(firstTable, match.index);
      section = JSON.stringify(parts);
      if (parts[0] === "model_providers" && (header[1].length !== 1 || parts.length !== 2
        || !/^[a-zA-Z0-9_-]+$/u.test(parts[1]))) fail("NETWORK_CONFIG_PROVIDER_TABLE_UNSUPPORTED");
      if (sections.has(section) && parts[0] === "model_providers") fail("NETWORK_CONFIG_DUPLICATE_TABLE");
      sections.set(section, { lines: [], insertion: match.index + match[0].length });
      continue;
    }
    const key = assignmentKey(content);
    if (section === null) {
      if (key.keyParts[0] === "model_providers") fail("NETWORK_CONFIG_DOTTED_PROVIDER_UNSUPPORTED");
      if (key.keyParts[0] === "profiles") fail("NETWORK_CONFIG_PROFILE_PROVIDER_OVERRIDE_UNSUPPORTED");
      root.push({ content, start: match.index, ...key });
    } else {
      sections.get(section).lines.push({ content, start: match.index, ...key });
    }
  }
  const edits = [];
  for (const [sectionName, value] of sections) {
    const parts = JSON.parse(sectionName);
    if (parts[0] === "profiles" && (parts.length === 1 && value.lines.length > 0
      || value.lines.some(entry => entry.keyParts[0] === "model_provider"))) {
      fail("NETWORK_CONFIG_PROFILE_PROVIDER_OVERRIDE_UNSUPPORTED");
    }
  }
  const stringValue = /^(?:"(?:[^"\\]|\\.)*"|'[^']*')$/u;
  function setting(entries, key, replacement, insertion, label) {
    const matches = entries.filter(entry => entry.keyParts[0] === key);
    if (matches.some(entry => entry.rawKey !== key || entry.keyParts.length !== 1)) fail("NETWORK_CONFIG_QUOTED_ROUTE_KEY_UNSUPPORTED");
    if (matches.length > 1) fail("NETWORK_CONFIG_DUPLICATE_ROUTE_KEY");
    if (!matches.length) {
      const separator = insertion && !/[\r\n]$/u.test(text.slice(0, insertion)) ? newline : "";
      edits.push({ start: insertion, end: insertion, replacement: `${separator}${key} = ${replacement}${newline}`, key: label });
      return null;
    }
    const entry = matches[0];
    const assignment = entry.content.match(new RegExp(`^(\\s*${key}\\s*=\\s*)(.*?)([ \\t]*(?:#.*)?)$`, "u"));
    if (!assignment) fail("NETWORK_CONFIG_ROUTE_VALUE_UNSUPPORTED");
    const current = assignment[2];
    if (key === "supports_websockets" ? !/^(true|false)$/u.test(current) : !stringValue.test(current)) fail("NETWORK_CONFIG_ROUTE_VALUE_UNSUPPORTED");
    if (current !== replacement) edits.push({ start: entry.start + assignment[1].length,
      end: entry.start + assignment[1].length + current.length, replacement, key: label });
    return current;
  }
  const previousProvider = setting(root, "model_provider", JSON.stringify(route.provider), firstTable, "model_provider");
  const providerSection = sections.get(JSON.stringify(["model_providers", route.provider]));
  if (providerSection) {
    setting(providerSection.lines, "base_url", JSON.stringify(baseUrl), providerSection.insertion, "provider.base_url");
    setting(providerSection.lines, "wire_api", '"responses"', providerSection.insertion, "provider.wire_api");
    setting(providerSection.lines, "supports_websockets", "false", providerSection.insertion, "provider.supports_websockets");
  } else {
    const separator = text.length && !/[\r\n]$/u.test(text) ? newline : "";
    edits.push({ start: text.length, end: text.length, key: "new_provider", replacement: separator + [
      `[model_providers.${route.provider}]`, `name = "${route.provider}"`,
      `base_url = "${baseUrl}"`, 'wire_api = "responses"', "requires_openai_auth = true",
      "supports_websockets = false", ""
    ].join(newline) });
  }
  let candidateText = text;
  for (const edit of [...edits].map((entry, index) => ({ ...entry, index })).sort((left, right) => right.start - left.start || right.end - left.end || right.index - left.index)) {
    candidateText = candidateText.slice(0, edit.start) + edit.replacement + candidateText.slice(edit.end);
  }
  const candidate = Buffer.concat([hasBom ? Buffer.from([0xef, 0xbb, 0xbf]) : Buffer.alloc(0), Buffer.from(candidateText, "utf8")]);
  return { bytes: candidate, evidence: { provider: route.provider, baseUrl, wireApi: "responses",
    supportsWebsockets: false, previousProvider, changed: !candidate.equals(original),
    originalSha256: digest(original), candidateSha256: digest(candidate),
    edits: edits.map(edit => ({ key: edit.key, start: edit.start, end: edit.end, replacement: edit.replacement })) } };
}
