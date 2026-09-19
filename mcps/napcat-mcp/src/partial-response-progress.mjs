function partialObjectFields(source) {
  const tokens = /"(?:\\[\s\S]|[^"\\])*"?|[{}\[\]:,]|true|false|null|-?\d[\d.eE+-]*/gu;
  const root = new Map();
  const stack = [];
  let consumed = 0;
  for (const match of source.matchAll(tokens)) {
    if (source.slice(consumed, match.index).trim()) return root;
    consumed = match.index + match[0].length;
    const token = match[0];
    const parent = stack.at(-1);
    if (token === "{" || token === "[") {
      const fields = stack.length === 0 ? root : new Map();
      if (parent?.state === "value") {
        if (parent.fields && parent.key) parent.fields.set(parent.key, { fields });
        parent.state = "comma";
      } else if (parent && parent.kind !== "array") return root;
      stack.push({ kind: token === "{" ? "object" : "array", fields, state: "key", key: null });
      continue;
    }
    if (!parent) return root;
    if (token === "}" || token === "]") {
      stack.pop();
      continue;
    }
    if (parent.kind === "array") continue;
    if (token === ",") { parent.state = "key"; parent.key = null; continue; }
    if (token === ":") { if (parent.state !== "colon") return root; parent.state = "value"; continue; }
    if (token.startsWith('"')) {
      let value;
      let backslashes = 0;
      for (let index = token.length - 2; index > 0 && token[index] === "\\"; index--) backslashes++;
      let complete = token.length > 1 && token.endsWith('"') && backslashes % 2 === 0;
      try {
        if (complete && token.length <= 1024) value = JSON.parse(token);
      } catch { complete = false; }
      if (parent.state === "key") {
        if (!complete || typeof value !== "string") return root;
        parent.key = value;
        parent.state = "colon";
      } else if (parent.state === "value") {
        const raw = token.slice(1, complete ? -1 : undefined);
        parent.fields.set(parent.key, { value, bytes: Buffer.byteLength(raw, "utf8") });
        parent.state = "comma";
        if (!complete) return root;
      } else return root;
      continue;
    }
    if (parent.state !== "value") return root;
    parent.state = "comma";
  }
  return root;
}

export function partialResponsesSseProgress(frame, completedReasoningIds) {
  const source = frame.split(/\r?\n/u).filter(line => line.startsWith("data:"))
    .map(line => line.slice(5).trimStart()).join("\n");
  const fields = partialObjectFields(source);
  const type = fields.get("type")?.value;
  if (typeof type !== "string") return null;
  if (type.startsWith("response.") && type.endsWith(".delta")) {
    const bytes = ["delta", "text", "arguments", "input", "code"].reduce((total, key) => total + (fields.get(key)?.bytes ?? 0), 0);
    return bytes ? { key: type, bytes, type, argumentsProgress: type === "response.function_call_arguments.delta" } : null;
  }
  if (type === "response.function_call_arguments.done") {
    const bytes = fields.get("arguments")?.bytes ?? 0;
    return bytes ? { key: type, bytes, type, argumentsProgress: true } : null;
  }
  if (type !== "response.output_item.done") return null;
  const item = fields.get("item")?.fields;
  const itemType = item?.get("type")?.value;
  const id = item?.get("id")?.value;
  if (itemType === "function_call") {
    const bytes = item.get("arguments")?.bytes ?? 0;
    return bytes ? { key: `${type}:${id ?? "function_call"}`, bytes, type, argumentsProgress: true } : null;
  }
  const bytes = item?.get("encrypted_content")?.bytes ?? 0;
  if (itemType !== "reasoning" || !id || completedReasoningIds.has(id) || !bytes) return null;
  return { key: `${type}:${id}`, bytes, type, reasoningId: id };
}
