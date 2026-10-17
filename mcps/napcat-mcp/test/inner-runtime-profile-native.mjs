import { WebSocketServer } from "ws";

const server = new WebSocketServer({ host: "127.0.0.1", port: Number(process.argv[2]) });
const turns = new Map();
server.on("connection", socket => {
  socket.on("message", async bytes => {
    const message = JSON.parse(bytes.toString());
    if (message.method === "test/disconnect") {
      socket.terminate();
      return;
    }
    if (message.method === "thread/turns/list") {
      socket.send(JSON.stringify({ id: message.id, result: { data: [...(turns.get(message.params.threadId)?.values() ?? [])].reverse(), nextCursor: null } }));
      return;
    }
    if (message.method === "test/tool") {
      const reply = () => socket.send(JSON.stringify({ id: message.id, result: { value: message.params.value } }));
      if (Number.isSafeInteger(message.params.replyDelayMs) && message.params.replyDelayMs > 0 && message.params.replyDelayMs <= 1000) {
        setTimeout(reply, message.params.replyDelayMs);
      } else reply();
      return;
    }
    if (["test/complete", "test/complete-silent"].includes(message.method)) {
      turns.get(message.params.threadId)?.set(message.params.turnId, { id: message.params.turnId, status: "completed" });
      if (message.method === "test/complete") socket.send(JSON.stringify({ method: "turn/completed", params: {
        threadId: message.params.threadId, turn: { id: message.params.turnId, status: "completed" },
      } }));
      socket.send(JSON.stringify({ id: message.id, result: {} }));
      return;
    }
    if (message.method === "turn/start") {
      const threadId = message.params.threadId;
      if (message.params.fixtureFollowUp) {
        const active = [...(turns.get(threadId)?.values() ?? [])].find(turn => turn.status === "inProgress");
        socket.send(JSON.stringify({ id: message.id, result: { turn: active, followUpAccepted: true } }));
        return;
      }
      const turnId = message.params.fixtureTurnId ?? "temp-native-turn";
      if (!turns.has(threadId)) turns.set(threadId, new Map());
      turns.get(threadId).set(turnId, { id: turnId, status: "inProgress" });
      socket.send(JSON.stringify({ method: "turn/started", params: { threadId, turn: { id: turnId, status: "inProgress" } } }));
      socket.send(JSON.stringify({ id: message.id, result: { turn: { id: turnId, status: "inProgress" } } }));
      if (message.params.fixtureModelRequests) {
        for (let index = 0; index < message.params.fixtureModelRequests; index += 1) {
          const response = await fetch(`${process.env.INNER_PROFILE_TEST_FRONT_ORIGIN}/v1/responses`, { method: "POST",
            headers: { "content-type": "application/json", "x-codex-turn-metadata": JSON.stringify({ thread_id: threadId, turn_id: turnId }) },
            body: JSON.stringify({ model: "owned-fixture", stream: true, input: [{ role: "user", content: [
              { type: "input_text", text: "owned quota state" }] }], tools: [] }) });
          await response.text();
        }
      }
      if (message.params.fixtureHoldTurn) return;
      turns.get(threadId).set(turnId, { id: turnId, status: "completed" });
      setImmediate(() => socket.send(JSON.stringify({ method: "turn/completed", params: {
        threadId, turn: { id: turnId, status: "completed" },
      } })));
      return;
    }
    if (message.id !== undefined) socket.send(JSON.stringify({ id: message.id, result: {
      userAgent: "inner-profile-temp-fixture", platformFamily: "windows", platformOs: "windows",
    } }));
  });
});
