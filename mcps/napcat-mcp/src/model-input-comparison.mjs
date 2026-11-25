export function normalizeInputItemMetadataForComparison(item, { version = 2 } = {}) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return item;
  const comparable = { ...item };
  for (const field of ["metadata", "internal_chat_message_metadata_passthrough"]) {
    const original = item[field];
    if (!original || typeof original !== "object" || Array.isArray(original)) continue;
    const metadata = { ...original };
    delete metadata.turn_id;
    if (field === "internal_chat_message_metadata_passthrough") {
      delete metadata.content_item_kinds;
      if (Number.isFinite(metadata.create_time) || metadata.create_time === null) delete metadata.create_time;
      if (version >= 2 && Number.isSafeInteger(metadata.content_token_count) && metadata.content_token_count >= 0) {
        delete metadata.content_token_count;
      }
    }
    if (Object.keys(metadata).length) comparable[field] = metadata;
    else delete comparable[field];
  }
  if (comparable.type === "reasoning" && (version >= 2 && comparable.content === null
    || Array.isArray(comparable.content) && comparable.content.length === 0)) delete comparable.content;
  return comparable;
}
