import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

const argumentsMap = new Map();
for (let index = 2; index < process.argv.length; index += 2) argumentsMap.set(process.argv[index], process.argv[index + 1]);
const sourceRoot = argumentsMap.get("--source-root");
const output = argumentsMap.get("--out");
const native = argumentsMap.get("--codex");
const expectation = argumentsMap.get("--expect") ?? "fixed";
const packetBytes = Number(argumentsMap.get("--packet-bytes") ?? 262144);
const floor = Number(argumentsMap.get("--upload-ms-per-mib") ?? 16000);
const wireFloor = Number(argumentsMap.get("--wire-ms-per-mib") ?? 8389);
const profileOnly = argumentsMap.get("--profile-only") === "yes";
if (![sourceRoot, output, native].every(value => value && path.isAbsolute(value)) || !["baseline", "fixed"].includes(expectation)) throw new Error("ABSOLUTE_INPUTS_AND_EXPLICIT_EXPECTATION_REQUIRED");
if (fs.existsSync(output)) throw new Error("OUTPUT_EXISTS_PRESERVE_EVIDENCE");
const parent = path.dirname(output);
fs.mkdirSync(parent, { recursive: true });
const digest = value => crypto.createHash("sha256").update(value).digest("hex");
const originalPath = fileURLToPath(new URL("./inner-managed-official-startup-native.mjs", import.meta.url));
let harness = fs.readFileSync(originalPath, "utf8");
const substitutions = [];
function replace(before, after) {
  if (harness.split(before).length !== 2) throw new Error(`UNIQUE_FIXTURE_ANCHOR_REQUIRED:${before.slice(0, 100)}`);
  harness = harness.replace(before, after);
  substitutions.push({ anchor: before, replacementSha256: digest(after) });
}
replace('import http from "node:http";', 'import http from "node:http";\nimport { zstdCompressSync } from "node:zlib";');
replace('const profilePath = path.join(stateRoot, "inner-managed-profile.json");', `
Object.assign(profile.environment, {
  CODEX_MODEL_STREAM_PROXY_FIRST_PROGRESS_TIMEOUT_MS: "1000",
  CODEX_MODEL_STREAM_PROXY_PROGRESS_IDLE_TIMEOUT_MS: "1000",
  CODEX_MODEL_STREAM_PROXY_ADAPTIVE_WAIT_LIMIT_MS: "1000",
  CODEX_MODEL_STREAM_PROXY_UPSTREAM_IDLE_TIMEOUT_MS: "10000",
  CODEX_MODEL_STREAM_PROXY_UPLOAD_ALLOWANCE_MS_PER_MIB: "${floor}",
  CODEX_MODEL_STREAM_PROXY_MAX_UPLOAD_ALLOWANCE_MS: "600000",
  CODEX_MODEL_STREAM_PROXY_WS_MAX_SESSION_BYTES: "268435456",
  CODEX_MODEL_STREAM_PROXY_WS_MAX_SESSIONS: "4",
  CODEX_MODEL_STREAM_PROXY_INCREMENTAL_IMAGES: "1"
});
const profilePath = path.join(stateRoot, "inner-managed-profile.json");
let relay;
const relaySockets = new Set();
const relayFrames = [];
const relayTimers = new Set();
let relaySawWarm = false;
const parseFrame = frame => {
  let offset = 2, length = frame[1] & 127;
  if (length === 126) { length = frame.readUInt16BE(2); offset = 4; }
  else if (length === 127) { length = Number(frame.readBigUInt64BE(2)); offset = 10; }
  const mask = frame.subarray(offset, offset + 4); offset += 4;
  const payload = Buffer.from(frame.subarray(offset, offset + length));
  for (let index = 0; index < payload.length; index++) payload[index] ^= mask[index % 4];
  try { return { packet: JSON.parse(payload.toString()), wireBytes: payload.length }; } catch { return { packet: null, wireBytes: payload.length }; }
};
`);
replace('profile.environment.CODEX_MODEL_STREAM_PROXY_WS_UPSTREAM_URL = `ws://127.0.0.1:${upstream.address().port}/v1/responses`;', `
relay = net.createServer(incoming => {
  const outgoing = net.connect(upstream.address().port, "127.0.0.1");
  relaySockets.add(incoming); relaySockets.add(outgoing);
  outgoing.pipe(incoming);
  let pending = Buffer.alloc(0), upgraded = false;
  const finish = () => { incoming.destroy(); outgoing.destroy(); relaySockets.delete(incoming); relaySockets.delete(outgoing); };
  incoming.on("close", finish); outgoing.on("close", finish);
  incoming.on("error", () => {}); outgoing.on("error", () => {});
  incoming.on("data", chunk => {
    pending = Buffer.concat([pending, chunk]);
    if (!upgraded) {
      const boundary = pending.indexOf("\\r\\n\\r\\n");
      if (boundary < 0) return;
      outgoing.write(pending.subarray(0, boundary + 4)); pending = pending.subarray(boundary + 4); upgraded = true;
    }
    while (pending.length >= 2) {
      let size = pending[1] & 127, header = 2;
      if (size === 126) { if (pending.length < 4) return; size = pending.readUInt16BE(2); header = 4; }
      else if (size === 127) { if (pending.length < 10) return; size = Number(pending.readBigUInt64BE(2)); header = 10; }
      if (pending[1] & 128) header += 4;
      if (pending.length < header + size) return;
      const frame = Buffer.from(pending.subarray(0, header + size)); pending = pending.subarray(header + size);
      const parsed = parseFrame(frame);
      const delayed = (modelMode === "compressed-first" || (["prewarm-delay", "prewarm-cancel"].includes(modelMode) && relaySawWarm)) && parsed.packet !== null;
      const entry = { index: relayFrames.length, mode: modelMode, receivedAt: Date.now(), wireBytes: parsed.wireBytes,
        frameBytes: frame.length, generate: parsed.packet?.generate !== false, previousResponseId: parsed.packet?.previous_response_id ?? null,
        delayMs: delayed ? Math.ceil(parsed.wireBytes / 1048576 * ${wireFloor}) : 0, forwardedAt: null, cancelledAt: null };
      relayFrames.push(entry); append("relay-frames.jsonl", { event: "received", ...entry });
      if (parsed.packet?.generate === false && ["prewarm-delay", "prewarm-cancel"].includes(modelMode)) relaySawWarm = true;
      const forward = () => {
        if (incoming.destroyed || outgoing.destroyed) entry.cancelledAt = Date.now();
        else { outgoing.write(frame); entry.forwardedAt = Date.now(); }
        append("relay-frames.jsonl", { event: "delivery", ...entry });
      };
      if (entry.delayMs) {
        const timer = setTimeout(() => { relayTimers.delete(timer); forward(); }, entry.delayMs);
        relayTimers.add(timer);
      } else forward();
    }
  });
});
relay.listen(0, "127.0.0.1"); await once(relay, "listening");
profile.environment.CODEX_MODEL_STREAM_PROXY_WS_UPSTREAM_URL = \`ws://127.0.0.1:\${relay.address().port}/v1/responses\`;
result.relayPort = relay.address().port;
`);
replace('generate: packet.generate !== false, requestSha256: digest(bytes), previousResponseId: packet.previous_response_id ?? null,', 'generate: packet.generate !== false, wireBytes: bytes.length, requestSha256: digest(bytes), previousResponseId: packet.previous_response_id ?? null,');
replace('else if (["text", "ws-empty-failed-then-success", "ws-prewarm-failed-once"].includes(modelMode))', 'else if (["text", "compressed-first", "prewarm-delay", "prewarm-cancel", "ws-empty-failed-then-success", "ws-prewarm-failed-once"].includes(modelMode))');
const start = harness.indexOf('  if (contractOnly) {\n    if (selectedCases.includes("baseline"))');
const end = harness.indexOf('  result.statusFromPs =', start);
if (start < 0 || end < 0) throw new Error("MANAGED_SCENARIO_ANCHORS_REQUIRED");
harness = harness.slice(0, start) + (profileOnly ? `
  modelMode = "text";
  await turn(threadId, "FINAL_PROFILE_REAL_NATIVE_SUCCESS", { kind: "success" });
  const visitRuntime = directory => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const location = path.join(directory, entry.name);
    return entry.isDirectory() ? visitRuntime(location) : entry.name === "codex-model-stream-proxy-runtime.json" ? [{ path: location, value: JSON.parse(fs.readFileSync(location, "utf8")) }] : [];
  });
  result.runnerRuntimeSnapshots = visitRuntime(stateRoot);
` : `
  const history = await rpc("thread/start", { cwd: root, model: "gpt-6-luna", modelProvider: "isolated", approvalPolicy: "never", sandbox: "danger-full-access", ephemeral: false });
  modelMode = "text";
  for (let index = 0; index < 4; index++) await turn(history.thread.id, "PREWARM_SEED_" + index, { kind: "success" }, "PREWARM_SEED_" + index + "_" + "x".repeat(Math.floor(wsMaxMessageBytes * 0.4)));
  for (const socket of upstreamWebSocket.clients) socket.close();
  await until(() => upstreamWebSocket.clients.size === 0, "seeded upstream close");
  relaySawWarm = false; modelMode = "prewarm-delay";
  const firstMessage = messages.length, firstFrame = relayFrames.length, firstPacket = websocketPackets.length;
  const begin = await rpc("turn/start", { threadId: history.thread.id, input: [{ type: "text", text: "PREWARM_DELAY_NEXT_PACKET" }] });
  const targetTerminal = () => messages.slice(firstMessage).find(message => message.method === "turn/completed" && message.params?.turn?.id === begin.turn.id);
  const delayedFrame = await until(() => relayFrames.slice(firstFrame).find(frame => frame.delayMs > 1000), "real next packet enters delayed wire");
  result.delayedFrame = delayedFrame;
  const runtimePaths = () => {
    const found = [];
    const visit = directory => { for (const entry of fs.readdirSync(directory, { withFileTypes: true })) { const location = path.join(directory, entry.name); if (entry.isDirectory()) visit(location); else if (entry.name === "codex-model-stream-proxy-runtime.json") found.push(location); } };
    visit(stateRoot); return found;
  };
  result.runnerRuntimeSnapshots = runtimePaths().map(location => ({ path: location, value: JSON.parse(fs.readFileSync(location, "utf8")) }));
  ${expectation === "baseline" ? `
  const recovery = await until(async () => { const actual = await status(); return actual.coordinator.recoveryStates.find(state => state.turnId === begin.turn.id && state.willRetry === false); }, "baseline replay-protected timeout", 15000);
  result.originalFailure = recovery;
  check("old core times out after successful prewarm before business", !targetTerminal() && !websocketPackets.slice(firstPacket).some(packet => packet.generate));
  const interruptedAt = Date.now();
  await rpc("turn/interrupt", { threadId: history.thread.id, turnId: begin.turn.id });
  const terminal = await until(targetTerminal, "baseline cancellation");
  result.delayedTurn = { turnId: begin.turn.id, terminal, interruptedAt, cancellationLatencyMs: Date.now() - interruptedAt };
  check("baseline cancel reaches native interrupted", terminal.params.turn.status === "interrupted");
  ` : `
  const terminal = await until(targetTerminal, "fixed original delayed chain completes", 20000);
  result.delayedTurn = { turnId: begin.turn.id, terminal };
  check("fixed core completes original delayed chain", terminal.params.turn.status === "completed");
  check("one business request and no automatic replay", websocketPackets.slice(firstPacket).filter(packet => packet.generate).length === 1);
  `}
  await sleep(delayedFrame.delayMs + 100);
  result.delayedFrames = relayFrames.slice(firstFrame);
  result.businessPackets = websocketPackets.slice(firstPacket).filter(packet => packet.generate).length;
  result.prewarmPackets = websocketPackets.slice(firstPacket).filter(packet => !packet.generate).length;
  check("delay exceeds post-prewarm first-progress budget", delayedFrame.delayMs > 1000);
  check("prewarm was observed without business progress", result.prewarmPackets >= 1);
  for (const socket of upstreamWebSocket.clients) socket.close();
  await until(() => upstreamWebSocket.clients.size === 0, "post-test upstream close");
  relaySawWarm = false; modelMode = "prewarm-cancel";
  const cancelFrame = relayFrames.length, cancelPacket = websocketPackets.length, cancelMessage = messages.length;
  const cancellable = await rpc("turn/start", { threadId: history.thread.id, input: [{ type: "text", text: "PREWARM_CANCEL_WHILE_NEXT_PACKET_UPLOADING" }] });
  const pendingUpload = await until(() => relayFrames.slice(cancelFrame).find(frame => frame.delayMs > 1000), "cancellable next packet wire");
  const cancellationAt = Date.now();
  await rpc("turn/interrupt", { threadId: history.thread.id, turnId: cancellable.turn.id });
  const interrupted = await until(() => messages.slice(cancelMessage).find(message => message.method === "turn/completed" && message.params?.turn?.id === cancellable.turn.id), "cancelled delayed turn");
  result.cancellation = { turnId: cancellable.turn.id, terminal: interrupted, latencyMs: Date.now() - cancellationAt, frame: pendingUpload };
  await sleep(pendingUpload.delayMs + 200);
  result.cancellation.frames = relayFrames.slice(cancelFrame);
  result.cancellation.businessPackets = websocketPackets.slice(cancelPacket).filter(packet => packet.generate).length;
  check("cancel while uploading interrupts promptly", interrupted.params.turn.status === "interrupted" && result.cancellation.latencyMs < 1500);
  check("cancelled unknown upload is not replayed", result.cancellation.businessPackets === 0 && relayFrames.slice(cancelFrame).filter(frame => frame.delayMs).length === 1 && pendingUpload.forwardedAt === null);
  modelMode = "text";
  await turn(history.thread.id, "AFTER_PREWARM_CANCEL_SUCCESS", { kind: "success" });
`) + `
  const readRunnerEvents = () => {
    const events = [];
    const visit = directory => { for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const location = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(location);
      else if (entry.name === "codex-model-stream-proxy.jsonl") events.push(...fs.readFileSync(location, "utf8").trim().split("\\n").filter(Boolean).map(line => JSON.parse(line)));
    } };
    visit(stateRoot); return events;
  };
  const activeRuntime = result.runnerRuntimeSnapshots[0]?.value;
  check("runner receives managed incremental images and conservative upload policy", activeRuntime?.managedRecovery === true
    && activeRuntime.uploadAllowanceMsPerMiB === ${floor} && activeRuntime.maxUploadAllowanceMs === 600000
    && activeRuntime.incrementalTransport?.maxSessions === 4 && activeRuntime.incrementalTransport?.maxSessionBytes === 268435456
    && activeRuntime.incrementalTransport?.maxMessageBytes === wsMaxMessageBytes && activeRuntime.incrementalTransport?.allowImagePrewarm === true);
  modelMode = "compressed-first"; relaySawWarm = false;
  const compressedFrameIndex = relayFrames.length;
  const clearBody = Buffer.from(JSON.stringify({ model: "gpt-6-luna", stream: true,
    input: [{ role: "user", content: [{ type: "input_text", text: "COMPRESSED_FIRST_" + "z".repeat(230000) }] }] }));
  const encodedBody = zstdCompressSync(clearBody);
  const compressedStart = Date.now();
  let compressedText = "", compressedEnded = false, compressedError = null;
  const endpoint = new URL(activeRuntime.endpoint);
  const compressedRequest = http.request({ hostname: endpoint.hostname, port: endpoint.port, path: "/v1/responses", method: "POST",
    headers: { "content-type": "application/json", "content-encoding": "zstd", "content-length": encodedBody.length,
      authorization: "Bearer local-fixture-only", "chatgpt-account-id": "local-fixture",
      "x-codex-turn-metadata": JSON.stringify({ request_kind: "turn", thread_id: "compressed-runner-fixture", turn_id: "compressed-first" }) } }, response => {
    response.on("data", chunk => { compressedText += chunk.toString(); });
    response.on("end", () => { compressedEnded = true; });
    response.on("error", error => { compressedError = String(error); });
  });
  compressedRequest.on("error", error => { compressedError = String(error); });
  compressedRequest.end(encodedBody);
  const compressedWire = await until(() => relayFrames.slice(compressedFrameIndex).find(frame => frame.delayMs > 1000), "compressed HTTP expanded first WS packet");
  ${expectation === "fixed" ? `
  await until(() => compressedEnded || compressedError, "compressed first packet terminal", 15000);
  check("compressed HTTP expanded first packet completes through real runner", compressedEnded && compressedText.includes('"type":"response.completed"'));
  ` : `
  result.compressedFailure = await until(() => readRunnerEvents().find(event => event.type === "attempt_progress_timeout" && Date.parse(event.at) >= compressedStart), "compressed first packet old-core timeout", 10000);
  check("old core fails before compressed first packet upload finishes", compressedWire.forwardedAt === null && !compressedEnded);
  compressedRequest.destroy();
  `}
  result.compressedFirst = { encodedBytes: encodedBody.length, decodedBytes: clearBody.length, elapsedMs: Date.now() - compressedStart,
    ended: compressedEnded, error: compressedError, text: compressedText, frame: compressedWire };
  await sleep(compressedWire.delayMs + 100);
  result.compressedFirst.frames = relayFrames.slice(compressedFrameIndex);
  check("compressed body is small and actual WS is expanded", encodedBody.length < 1024 && compressedWire.wireBytes > 200000);
  result.runnerEvents = readRunnerEvents();
  result.packetBudgetEvidence = relayFrames.filter(frame => frame.delayMs).map(frame => {
    const event = result.runnerEvents.find(event => event.type === "incremental_packet_upload_started"
      && event.packetWireBytes === frame.wireBytes && Math.abs(Date.parse(event.at) - frame.receivedAt) < 500);
    return { frame, event: event ?? null, expectedAllowanceMs: Math.ceil(frame.wireBytes / 1048576 * ${floor}) };
  });
  ${expectation === "fixed" ? `
  check("actual wire bytes determine every delayed packet callback budget", result.packetBudgetEvidence.every(evidence => evidence.event
    && evidence.event.uploadAllowanceMs === evidence.expectedAllowanceMs && evidence.event.businessProgress === false
    && evidence.event.firstProgressDeadlineAt - Date.parse(evidence.event.at) >= evidence.expectedAllowanceMs + 900
    && evidence.event.waitDeadlineAt - Date.parse(evidence.event.at) >= evidence.expectedAllowanceMs + 900));
  check("prewarm is never reported as business progress", result.runnerEvents.filter(event => event.type === "incremental_prewarm_progress").every(event => event.businessProgress === false));
  ` : ""}
  modelMode = "text";
` + harness.slice(end);
replace('  if (upstreamWebSocket) { for (const socket of upstreamWebSocket.clients)', `
  for (const timer of relayTimers) clearTimeout(timer);
  relayTimers.clear();
  for (const socket of relaySockets) socket.destroy();
  if (relay?.listening) await new Promise(resolve => relay.close(resolve));
  result.relayFrames = relayFrames;
  relaySockets.clear();
  result.relayResources = { openSockets: relaySockets.size, pendingTimers: relayTimers.size };
  if (upstreamWebSocket) { for (const socket of upstreamWebSocket.clients)`);
replace('...Object.values(profile.ports), ...(profile.upstreamOrigin', '...Object.values(profile.ports), ...(result.relayPort ? [result.relayPort] : []), ...(profile.upstreamOrigin');
const harnessPath = path.join(parent, path.basename(output) + "-managed-fixture.mjs");
const manifestPath = argumentsMap.get("--source-manifest");
if (!manifestPath) throw new Error("FROZEN_SOURCE_MANIFEST_REQUIRED");
fs.writeFileSync(harnessPath, harness, { flag: "wx" });
fs.writeFileSync(path.join(parent, path.basename(output) + "-adaptation.json"), JSON.stringify({
  command: [process.execPath, ...process.argv.slice(1)], originalPath, originalSha256: digest(fs.readFileSync(originalPath)),
  entryPath: fileURLToPath(import.meta.url), entrySha256: digest(fs.readFileSync(fileURLToPath(import.meta.url))),
  harnessPath, harnessSha256: digest(harness), substitutions, expectation, packetBytes, floor, wireFloor, profileOnly,
  sourceRoot, sourceManifestPath: manifestPath, sourceManifestSha256: digest(fs.readFileSync(manifestPath)),
  isolatedFixture: true, productionTouched: false, paidModelCalls: false
}, null, 2));
const child = spawn(process.execPath, [harnessPath, native, "--contract-only", "--out", output,
  "--source-root", sourceRoot, "--source-manifest", manifestPath, "--transport", "incremental-ws",
  "--native-idle-ms", "10000", "--recovery-wait-ms", "15000", "--ws-max-message-bytes", String(packetBytes), "--cases", "baseline"],
{ stdio: "inherit", windowsHide: true });
const [code] = await once(child, "exit");
process.exitCode = code ?? 1;
