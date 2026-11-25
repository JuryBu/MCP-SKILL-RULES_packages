import { StringDecoder } from "node:string_decoder";

const DEFAULT_MAX_BUFFERED_RESPONSE_BYTES = 64 * 1024 * 1024;

export function frameData(frame) {
  return frame
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
}

export function parseSseFrame(frame) {
  const data = frameData(frame);
  if (!data) return { event: null, type: null, doneMarker: false };
  if (data.trim() === "[DONE]") return { event: null, type: "[DONE]", doneMarker: true };
  try {
    const event = JSON.parse(data);
    return { event, type: typeof event?.type === "string" ? event.type : null, doneMarker: false };
  } catch {
    return { event: null, type: null, doneMarker: false };
  }
}

export function createSseFrameParser(onFrame, options = {}) {
  const decoder = new StringDecoder("utf8");
  const maximumPendingBytes = options.maximumPendingBytes ?? DEFAULT_MAX_BUFFERED_RESPONSE_BYTES;
  const onError = typeof options.onError === "function" ? options.onError : () => {};
  const classifyPartialProgress = typeof options.classifyPartialProgress === "function" ? options.classifyPartialProgress : () => null;
  const onPartialProgress = typeof options.onPartialProgress === "function" ? options.onPartialProgress : () => {};
  const shouldPause = typeof options.shouldPause === "function" ? options.shouldPause : () => false;
  let pending = "";
  let pendingPartialProgress = null;
  let failed = false;
  let ending = false;
  const fail = (error) => {
    if (failed) return;
    failed = true;
    pending = "";
    try {
      onError(error);
    } catch {
    }
  };
  const deliver = (wire, frame) => {
    if (failed) return;
    if (Buffer.byteLength(wire, "utf8") > maximumPendingBytes) {
      fail(Object.assign(new Error("SSE frame exceeded proxy buffer limit"), { code: "SSE_FRAME_LIMIT" }));
      return;
    }
    try {
      onFrame(wire, frame);
    } catch (error) {
      fail(Object.assign(error instanceof Error ? error : new Error("SSE callback failed"), {
        code: error?.code ?? "SSE_CALLBACK_ERROR",
      }));
    }
  };
  const drain = (ending = false) => {
    if (failed) return;
    while (true) {
      if (shouldPause()) return;
      const match = /\r?\n\r?\n/u.exec(pending);
      if (!match) break;
      const frame = pending.slice(0, match.index);
      const wire = `${frame}${match[0]}`;
      pending = pending.slice(match.index + match[0].length);
      pendingPartialProgress = null;
      deliver(wire, frame);
      if (failed || shouldPause()) return;
    }
    if (ending && pending) {
      const frame = pending;
      pending = "";
      deliver(frame, frame);
    }
  };
  const observePartialProgress = () => {
    if (failed || !pending) {
      pendingPartialProgress = null;
      return;
    }
    let progress;
    try {
      progress = classifyPartialProgress(pending);
    } catch (error) {
      fail(Object.assign(error instanceof Error ? error : new Error("SSE partial-progress callback failed"), {
        code: error?.code ?? "SSE_PARTIAL_PROGRESS_ERROR",
      }));
      return;
    }
    if (!progress || typeof progress.key !== "string" || !Number.isFinite(progress.bytes)) {
      pendingPartialProgress = null;
      return;
    }
    const previous = pendingPartialProgress;
    pendingPartialProgress = progress;
    if (previous?.key === progress.key && previous.bytes >= progress.bytes) return;
    try {
      onPartialProgress(progress);
    } catch (error) {
      fail(Object.assign(error instanceof Error ? error : new Error("SSE partial-progress callback failed"), {
        code: error?.code ?? "SSE_PARTIAL_PROGRESS_ERROR",
      }));
    }
  };
  return {
    push(chunk) {
      if (failed) return;
      pending += decoder.write(chunk);
      drain(false);
      if (shouldPause()) return;
      if (Buffer.byteLength(pending, "utf8") > maximumPendingBytes) {
        fail(Object.assign(new Error("SSE frame exceeded proxy buffer limit"), { code: "SSE_FRAME_LIMIT" }));
        return;
      }
      observePartialProgress();
    },
    end() {
      if (failed) return;
      if (!ending) pending += decoder.end();
      ending = true;
      drain(true);
    },
    resume() {
      if (failed) return;
      drain(ending);
      if (shouldPause()) return;
      if (Buffer.byteLength(pending, "utf8") > maximumPendingBytes) {
        fail(Object.assign(new Error("SSE frame exceeded proxy buffer limit"), { code: "SSE_FRAME_LIMIT" }));
        return;
      }
      observePartialProgress();
    },
    dispose() {
      failed = true;
      pending = "";
      pendingPartialProgress = null;
    },
  };
}
