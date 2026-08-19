import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const brokerRoot = path.resolve(__dirname, "..");
const mcpRoot = path.resolve(brokerRoot, "..");
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-broker-smoke-"));
const memoryStoreRoot = path.join(dataRoot, "missing-memory-store");

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function readHealth(port) {
  return new Promise((resolve, reject) => {
    const request = http.get(`http://127.0.0.1:${port}/health`, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        if (response.statusCode !== 200) {
          reject(new Error(`health returned HTTP ${response.statusCode}`));
          return;
        }
        resolve(Buffer.concat(chunks).toString("utf8"));
      });
    });
    request.setTimeout(500, () => request.destroy(new Error("health request timed out")));
    request.once("error", reject);
  });
}

function postJson(port, pathname, body, token) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const request = http.request({
      host: "127.0.0.1",
      port,
      path: pathname,
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": payload.length,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        statusCode: response.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"),
      }));
    });
    request.setTimeout(2000, () => request.destroy(new Error("control request timed out")));
    request.once("error", reject);
    request.end(payload);
  });
}

const port = await reservePort();
const controlToken = "startup-smoke-control-token";
const child = spawn(process.execPath, [path.join(brokerRoot, "broker.mjs")], {
  cwd: brokerRoot,
  env: {
    ...process.env,
    CODEX_MCP_BROKER_PORT: String(port),
    CODEX_TOOLKIT_MCP_ROOT: mcpRoot,
    CODEX_TOOLKIT_DATA_ROOT: dataRoot,
    CODEX_TOOLKIT_BROKER_ROOT: brokerRoot,
    CODEX_TOOLKIT_ENABLE_NAPCAT_MCP: "1",
    CODEX_TOOLKIT_ENABLE_WECHAT_DOCS_MCP: "1",
    WECHAT_DOCS_MCP_ROOT: brokerRoot,
    WECHAT_DOCS_MCP_PYTHON: process.execPath,
    CODEX_MCP_BROKER_CONTROL_TOKEN: controlToken,
    MEMORY_STORE_MCP_ROOT: memoryStoreRoot,
    PATH: "",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let stderr = "";
child.stderr.on("data", (chunk) => {
  stderr += chunk.toString("utf8");
});

try {
  const deadline = Date.now() + 8000;
  let healthBody = "";
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`broker exited with ${child.exitCode}: ${stderr}`);
    }
    try {
      healthBody = await readHealth(port);
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  if (!healthBody) {
    throw new Error(`broker health did not become ready: ${stderr}`);
  }
  const health = JSON.parse(healthBody);
  if (!Array.isArray(health?.endpoints) || !health.endpoints.includes("napcat")) {
    throw new Error("NapCat endpoint was not enabled during startup smoke test");
  }
  if (!health.endpoints.includes("wechat-docs")) {
    throw new Error("WeChat Docs endpoint was not enabled during startup smoke test");
  }
  const unauthorized = await postJson(port, "/__control/reload-backend", { endpoint: "napcat" }, "wrong-token");
  if (unauthorized.statusCode !== 401) {
    throw new Error(`Broker control endpoint did not reject the wrong token: ${unauthorized.statusCode}`);
  }
  const reload = await postJson(port, "/__control/reload-backend", { endpoint: "napcat", timeoutMs: 5000 }, controlToken);
  if (reload.statusCode !== 200 || reload.body?.ok !== true || reload.body?.endpoint !== "napcat") {
    throw new Error(`Scoped NapCat backend reload failed: ${JSON.stringify(reload)}`);
  }
  if (reload.body?.brokerPid !== child.pid) {
    throw new Error("Scoped backend reload changed or misreported the broker PID");
  }
  const wechatReload = await postJson(
    port,
    "/__control/reload-backend",
    { endpoint: "wechat-docs", timeoutMs: 5000 },
    controlToken,
  );
  if (wechatReload.statusCode !== 200 || wechatReload.body?.ok !== true || wechatReload.body?.endpoint !== "wechat-docs") {
    throw new Error(`Scoped WeChat Docs backend reload failed: ${JSON.stringify(wechatReload)}`);
  }
  if (wechatReload.body?.brokerPid !== child.pid) {
    throw new Error("Scoped WeChat Docs reload changed or misreported the broker PID");
  }
  console.log("Broker startup smoke passed with NapCat and WeChat Docs enabled.");
} finally {
  if (child.exitCode === null) {
    child.kill();
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ]);
  }
  fs.rmSync(dataRoot, { recursive: true, force: true });
}
