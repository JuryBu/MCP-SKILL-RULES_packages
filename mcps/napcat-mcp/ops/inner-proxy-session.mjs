import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import { createInnerProxySession } from "../src/inner-proxy-session.mjs";

const argumentsList = process.argv.slice(2);
if (argumentsList.length !== 2 || argumentsList[0] !== "--config" || !path.isAbsolute(argumentsList[1])) {
  throw new Error("Usage: node ops/inner-proxy-session.mjs --config <absolute isolated configuration>");
}
const configurationPath = fs.realpathSync(argumentsList[1]);
const relative = path.relative(fs.realpathSync(os.tmpdir()), configurationPath);
if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
  || fs.statSync(configurationPath).size > 65536) throw new Error("INNER_SESSION_CONFIG_INVALID");
const configuration = JSON.parse(fs.readFileSync(configurationPath, "utf8"));
const output = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const session = createInnerProxySession(configuration, event => output({ event: "trace", value: event }));
const endpoint = await session.start();
output({ event: "ready", pid: process.pid, ...endpoint });
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let dispatch = Promise.resolve();
let stopRequested = false;
let stopTimer = null;

async function stopWhenIdle() {
  if (!stopRequested) return;
  try {
    await dispatch;
    await session.close();
    clearInterval(stopTimer);
    input.close();
    output({ event: "closed", status: session.status() });
  } catch (error) {
    if (error.message !== "INNER_SESSION_BUSY") {
      clearInterval(stopTimer);
      output({ event: "cleanup_failed", code: error.code ?? error.message });
      process.exitCode = 1;
    }
  }
}

input.on("line", line => {
  dispatch = dispatch.then(async () => {
    let request;
    try {
      if (stopRequested || Buffer.byteLength(line) > 65536) throw new Error("INNER_SESSION_INPUT_REJECTED");
      request = JSON.parse(line);
      if (typeof request.id !== "string" || request.id.length > 128 || !request.id) throw new Error("INNER_SESSION_REQUEST_ID_REQUIRED");
      let result;
      if (request.method === "status") result = session.status();
      else if (request.method === "prepareCandidate") result = await session.prepareCandidate(request.specification);
      else if (request.method === "migrate") result = await session.migrate(request.request);
      else if (request.method === "close") { await session.close(); result = session.status(); }
      else throw new Error("INNER_SESSION_METHOD_NOT_ALLOWED");
      output({ id: request.id, ok: true, result });
      if (request.method === "close") input.close();
    } catch (error) { output({ id: request?.id ?? null, ok: false, code: error.code ?? error.message }); }
  });
});

function requestStop() {
  if (stopRequested) return;
  stopRequested = true;
  stopTimer = setInterval(() => { void stopWhenIdle(); }, 250);
  void stopWhenIdle();
}
input.on("close", requestStop);
process.on("SIGINT", requestStop);
process.on("SIGTERM", requestStop);
