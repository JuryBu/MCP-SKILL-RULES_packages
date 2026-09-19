export function createReasoningProgressTracker() {
  const completedIds = new Set();
  return event => {
    const item = event?.item;
    if (event?.type !== 'response.output_item.done' || item?.type !== 'reasoning'
      || typeof item.id !== 'string' || !item.id || completedIds.has(item.id)
      || typeof item.encrypted_content !== 'string' || !item.encrypted_content.trim()) return false;
    completedIds.add(item.id);
    return true;
  };
}
