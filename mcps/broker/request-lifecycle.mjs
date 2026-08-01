export function shouldTrackBackendWork(method) {
  return String(method ?? "").toUpperCase() !== "GET";
}
