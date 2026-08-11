export function resolveTrackedDelivery(result = {}) {
  const deliveryId = result.deliveryId ?? result.existing?.deliveryId;
  const messageSeq = Number(result.messageId ?? result.existing?.messageId);
  if (typeof deliveryId !== "string" || deliveryId.trim() === "") return null;
  if (!Number.isSafeInteger(messageSeq) || messageSeq < 0) return null;
  return { deliveryId: deliveryId.trim(), messageSeq };
}

function publicTrackingError(error) {
  return {
    code: error?.code || "DELIVERY_TRACKING_FAILED",
    message: error?.message || String(error),
    outcomeUnknown: Boolean(error?.outcomeUnknown),
    details: error?.details ?? null,
  };
}

export function withOutgoingDeliveryTracking(result, input, trackOutgoingDelivery) {
  const tracked = resolveTrackedDelivery(result);
  if (!tracked) return result;
  try {
    trackOutgoingDelivery({
      deliveryId: tracked.deliveryId,
      taskId: input.task_id,
      sourceMachine: input.source_machine,
      targetMachine: input.target_machine,
      messageSeq: tracked.messageSeq,
    });
    return {
      ...result,
      deliveryTracked: true,
      deliveryTrackingError: null,
    };
  } catch (error) {
    return {
      ...result,
      deliveryTracked: false,
      deliveryTrackingError: publicTrackingError(error),
      retryRecommended: false,
    };
  }
}
