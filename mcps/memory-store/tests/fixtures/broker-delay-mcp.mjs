import { setTimeout as sleep } from "node:timers/promises";

const toolName = process.env.BROKER_DELAY_TOOL_NAME || "delay_echo";
let buffer = "";

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendResult(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message) {
  send({
    jsonrpc: "2.0",
    id,
    error: { code, message },
  });
}

async function handleMessage(message) {
  const id = Object.prototype.hasOwnProperty.call(message, "id") ? message.id : undefined;
  const method = message?.method;

  if (method === "initialize") {
    const protocolVersion =
      typeof message?.params?.protocolVersion === "string"
        ? message.params.protocolVersion
        : "2025-03-26";
    sendResult(id, {
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: "broker-delay-fixture", version: "0.0.1" },
    });
    return;
  }

  if (method === "notifications/initialized") {
    return;
  }

  if (method === "tools/list") {
    sendResult(id, {
      tools: [
        {
          name: toolName,
          description: "Sleep for delayMs and echo the timing payload back to the caller.",
          inputSchema: {
            type: "object",
            properties: {
              delayMs: { type: "number", minimum: 0 },
              label: { type: "string" },
              waitSeconds: { type: "number" },
              timeout: { type: "number" },
            },
            required: ["delayMs"],
            additionalProperties: true,
          },
        },
      ],
    });
    return;
  }

  if (method === "tools/call") {
    const name = message?.params?.name;
    if (name !== toolName) {
      sendResult(id, {
        isError: true,
        content: [{ type: "text", text: `unknown tool: ${name || "<empty>"}` }],
      });
      return;
    }
    const args = message?.params?.arguments || {};
    const delayMs = Math.max(0, Number(args.delayMs || 0));
    const startedAt = Date.now();
    await sleep(delayMs);
    const elapsedMs = Date.now() - startedAt;
    sendResult(id, {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: true,
            toolName: name,
            delayMs,
            elapsedMs,
            label: typeof args.label === "string" ? args.label : null,
            waitSeconds: typeof args.waitSeconds === "number" ? args.waitSeconds : null,
            timeout: typeof args.timeout === "number" ? args.timeout : null,
          }),
        },
      ],
    });
    return;
  }

  if (method === "ping") {
    sendResult(id, {});
    return;
  }

  if (id !== undefined) {
    sendError(id, -32601, `Method not found: ${method || "<empty>"}`);
  }
}

function drainBuffer() {
  while (true) {
    const lineEnd = buffer.indexOf("\n");
    if (lineEnd === -1) return;
    const payload = buffer.slice(0, lineEnd).replace(/\r$/, "");
    buffer = buffer.slice(lineEnd + 1);
    if (!payload.trim()) continue;

    let message;
    try {
      message = JSON.parse(payload);
    } catch {
      continue;
    }
    void handleMessage(message);
  }
}

process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  drainBuffer();
});

process.stdin.resume();
