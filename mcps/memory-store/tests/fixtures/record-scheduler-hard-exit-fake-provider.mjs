import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const [dataRootArgument] = process.argv.slice(2);
if (!dataRootArgument) throw new Error("fake provider requires DATA_ROOT");

const dataRoot = path.resolve(dataRootArgument);
const logPath = path.join(dataRoot, "record-scheduler-hard-exit-provider-posts.json");
let logOperation = Promise.resolve();

function emptyLog() {
    return { posts: [], duplicateRequests: [], keyConflicts: [] };
}

function readLog() {
    if (!fs.existsSync(logPath)) return emptyLog();
    return JSON.parse(fs.readFileSync(logPath, "utf8"));
}

function writeLog(log) {
    const temporaryPath = `${logPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    const descriptor = fs.openSync(temporaryPath, "wx");
    try {
        fs.writeFileSync(descriptor, `${JSON.stringify(log, null, 2)}\n`, "utf8");
        fs.fsyncSync(descriptor);
    } finally {
        fs.closeSync(descriptor);
    }
    fs.renameSync(temporaryPath, logPath);
}

async function serializedLog(operation) {
    const current = logOperation.then(operation, operation);
    logOperation = current.then(() => undefined, () => undefined);
    return await current;
}

async function readBody(request) {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString("utf8");
}

function sendJson(response, statusCode, value) {
    const responseText = JSON.stringify(value);
    response.writeHead(statusCode, {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(responseText),
    });
    response.end(responseText);
    return responseText;
}

if (!fs.existsSync(logPath)) writeLog(emptyLog());

const server = http.createServer(async (request, response) => {
    try {
        if (request.method !== "POST" || request.url !== "/record") {
            sendJson(response, 404, { error: "not found" });
            return;
        }
        const rawBody = await readBody(request);
        const body = JSON.parse(rawBody);
        const attemptId = request.headers["x-record-attempt-id"];
        const idempotencyKey = request.headers["idempotency-key"];
        if (typeof attemptId !== "string" || attemptId.length === 0 || typeof idempotencyKey !== "string" || idempotencyKey.length === 0) {
            sendJson(response, 400, { error: "attemptId and Idempotency-Key are required" });
            return;
        }
        if (typeof body.requestIdentity !== "string" || body.requestIdentity.length === 0) {
            sendJson(response, 400, { error: "requestIdentity is required" });
            return;
        }
        await serializedLog(async () => {
            const log = readLog();
            const existingPair = log.posts.find(post => post.attemptId === attemptId && post.idempotencyKey === idempotencyKey);
            if (existingPair) {
                log.duplicateRequests.push({ attemptId, idempotencyKey });
                writeLog(log);
                if (existingPair.outcome === "connection-dropped") request.socket.destroy();
                else response.end(existingPair.responseText);
                return;
            }
            const existingKey = log.posts.find(post => post.idempotencyKey === idempotencyKey);
            if (existingKey) {
                log.keyConflicts.push({ attemptId, idempotencyKey, existingAttemptId: existingKey.attemptId });
                writeLog(log);
                sendJson(response, 409, { error: "idempotency key belongs to a different attempt" });
                return;
            }
            const shouldDrop = body.providerBehavior === "drop-first"
                && !log.posts.some(post => post.requestIdentity === body.requestIdentity);
            const responseBody = shouldDrop ? null : {
                text: `# hard-exit ${body.requestIdentity}\n\nprovider result for ${attemptId}`,
                chainUsed: "grok",
                modelUsed: "fake-hard-exit-http",
            };
            const responseText = responseBody === null ? null : JSON.stringify(responseBody);
            log.posts.push({
                sequence: log.posts.length + 1,
                receivedAt: new Date().toISOString(),
                remoteAddress: request.socket.remoteAddress || null,
                remotePort: request.socket.remotePort || null,
                method: request.method,
                url: request.url,
                attemptId,
                idempotencyKey,
                requestIdentity: body.requestIdentity,
                requestBodyHash: crypto.createHash("sha256").update(rawBody, "utf8").digest("hex"),
                response: responseBody,
                responseText,
                outcome: shouldDrop ? "connection-dropped" : "responded",
            });
            writeLog(log);
            if (shouldDrop) {
                request.socket.destroy();
                return;
            }
            response.writeHead(200, {
                "content-type": "application/json; charset=utf-8",
                "content-length": Buffer.byteLength(responseText),
            });
            response.end(responseText);
        });
    } catch (error) {
        if (!response.headersSent && !response.destroyed) sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
        else response.destroy();
    }
});

server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fake provider did not bind a TCP port");
    process.stdout.write(`${JSON.stringify({ type: "ready", url: `http://127.0.0.1:${address.port}/record` })}\n`);
});

let closing = false;
function close() {
    if (closing) return;
    closing = true;
    server.close(error => process.exit(error ? 1 : 0));
}

process.once("SIGTERM", close);
process.once("SIGINT", close);
