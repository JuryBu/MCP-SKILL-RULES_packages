export function resolveTrackedDelivery(result = {}) {
  const deliveryId = result.deliveryId ?? result.existing?.deliveryId;
  const messageSeq = Number(result.messageId ?? result.existing?.messageId);
  if (typeof deliveryId !== "string" || deliveryId.trim() === "") return null;
  if (!Number.isSafeInteger(messageSeq) || messageSeq < 0) return null;
  return { deliveryId: deliveryId.trim(), messageSeq };
}
