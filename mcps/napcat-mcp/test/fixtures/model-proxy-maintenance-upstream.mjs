import http from "node:http";

const heldResponses = new Set();

function complete(response) {
  const item = { id: "maintenance-message", type: "message", role: "assistant", status: "completed",
    content: [{ type: "output_text", text: "MAINTENANCE_FIXTURE_OK", annotations: [] }] };
  const events = [
    { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
    { type: "response.output_text.delta", output_index: 0, item_id: item.id, content_index: 0, delta: "MAINTENANCE_FIXTURE_OK" },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: "maintenance-response", status: "completed", output: [item] } },
  ];
  response.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""));
}

const server = http.createServer((request, response) => {
  if (request.url === "/release") {
    for (const held of heldResponses) complete(held);
    heldResponses.clear();
    response.end("released");
    return;
  }
  const chunks = [];
  request.on("data", chunk => chunks.push(chunk));
  request.once("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
    response.write(`data: ${JSON.stringify({ type: "response.created", response: { id: "maintenance-response", status: "in_progress", output: [] } })}\n\n`);
    if (body.includes("fixture_hold")) {
      heldResponses.add(response);
      response.once("close", () => heldResponses.delete(response));
    } else {
      complete(response);
    }
  });
});
server.listen(0, "127.0.0.1", () => process.stdout.write(`${server.address().port}\n`));
process.stdin.resume();
process.stdin.once("end", () => {
  for (const held of heldResponses) complete(held);
  heldResponses.clear();
  server.close();
});
