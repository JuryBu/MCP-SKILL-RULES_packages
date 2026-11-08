import { serialize } from "node:v8";
import type { IsolatedSourceOperation, SourcePatch } from "./conversation-isolated-source.js";

const send = (message: unknown): Promise<void> => new Promise((resolve, reject) => {
    if (!process.send || !process.connected) return reject(new Error("Source worker parent disconnected"));
    process.send(message, error => error ? reject(error) : resolve());
});

async function publish(value: any, location: (string | number)[] = [], channel: "patch" | "checkpoint-patch" = "patch"): Promise<void> {
    const patch = (type: SourcePatch["type"], value: unknown, path = location) => send({ type: channel, patch: { type, path, value } });
    if (typeof value === "string" && value.length > 65536) {
        await patch("set", "");
        for (let offset = 0; offset < value.length; offset += 65536) await patch("text", value.slice(offset, offset + 65536));
    } else if (Array.isArray(value)) {
        await patch("set", []);
        let batch: any[] = [];
        let bytes = 0;
        for (const [index, item] of value.entries()) {
            const size = serialize(item).byteLength;
            if (batch.length && (bytes + size > 512 * 1024 || batch.length >= 64)) {
                await patch("append", batch); batch = []; bytes = 0;
            }
            if (size > 512 * 1024) {
                await publish(item, [...location, index], channel);
            } else { batch.push(item); bytes += size; }
        }
        if (batch.length) await patch("append", batch);
    } else if (value && typeof value === "object") {
        await patch("set", {});
        for (const [key, item] of Object.entries(value)) await publish(item, [...location, key], channel);
    } else await patch("set", value);
}

async function execute(operation: IsolatedSourceOperation, payload: any, deadlineAt: number): Promise<unknown> {
    const isCancelled = () => !process.connected;
    if (operation === "corpus-action") {
        const params = payload?.params;
        if (params?.action !== "read_hit" && params?.action !== "read_fast") throw new Error("Isolated corpus-action only supports read_hit/read_fast");
        const { runCorpusAction } = await import("./tools/conversation-corpus-tool.js");
        return runCorpusAction(params, undefined, true);
    }
    if (operation === "conversation-export") {
        const { executeConversationSourceExport } = await import("./conversation-scoped-export.js");
        return executeConversationSourceExport(payload, { deadlineAt, isCancelled,
            onProgress: progress => { void send({ type: "progress", progress }).catch(() => undefined); } });
    }
    if (operation === "guard-record") {
        const { getConversationExecutionRecord } = await import("./guard-engine.js");
        return getConversationExecutionRecord(payload.conversationId, payload.startRound, payload.charBudget, payload.dataChain, { deadlineAt, isCancelled, allowUnavailable: payload.allowUnavailable });
    }
    if (operation === "candidates") {
        const { listConversationCandidates } = await import("./conversation-filter.js");
        let pending = Promise.resolve();
        return listConversationCandidates({ ...payload, deadlineAt, isCancelled,
            onCheckpoint: (value: unknown) => {
                const snapshot = structuredClone(value);
                pending = pending.then(async () => {
                    await publish(snapshot, [], "checkpoint-patch");
                    await send({ type: "checkpoint-complete" });
                });
                return pending;
            },
        });
    }
    if (operation.startsWith("devin-")) {
        const options = { ...payload.options, deadlineMs: deadlineAt, isCancelled };
        const sqlite = await import("./devin-sqlite.js");
        if (operation === "devin-discover") return sqlite.discoverDevinConversations(options);
        if (operation === "devin-list") return sqlite.listDevinConversations(options);
        if (operation === "devin-identities") return sqlite.listDevinConversationIdentities(options);
        if (operation === "devin-resolve") return sqlite.resolveDevinConversation(payload.id, options);
        if (operation === "devin-raw") return sqlite.readDevinRawConversation(payload.id, options);
        if (operation === "devin-fingerprint") return sqlite.fingerprintDevinConversation(payload.id, options);
        const { readDevinConversation } = await import("./devin-conversation.js");
        return readDevinConversation(payload.id, options);
    }
    const { createHostCorpusProvider } = await import("./conversation-corpus-reader-hosts.js");
    const provider = createHostCorpusProvider(payload.source, payload.options);
    const control = { deadlineAt, isCancelled, messageRoles: payload.messageRoles, forceRefresh: payload.forceRefresh,
        onProgress: (progress: unknown) => { void send({ type: "progress", progress }).catch(() => undefined); } };
    if (operation === "host-list") return { candidates: await provider.list(payload.request, control), statuses: provider.sourceStatuses?.() };
    const projection = operation === "host-cached" ? await provider.readCached?.(payload.conversation, control) ?? null
        : payload.request ? await provider.readFast(payload.conversation, payload.request, control)
        : await provider.read(payload.conversation, control);
    const { verifiedCorpusIdentity } = await import("./conversation-host-binary.js");
    return { projection, identity: projection ? verifiedCorpusIdentity(projection.conversation) : undefined };
}

let running = false;
process.on("message", async (message: any) => {
    if (running || message?.type !== "run") return;
    running = true;
    try {
        if (message.identityHints?.length) {
            const { seedVerifiedDevinAliasHints } = await import("./devin-sqlite.js");
            seedVerifiedDevinAliasHints(message.identityHints);
        }
        const result = await execute(message.operation, message.payload, message.deadlineAt);
        await publish(result);
        const { verifiedDevinAliasHints } = await import("./devin-sqlite.js");
        await send({ type: "identity-hints", summaries: verifiedDevinAliasHints() });
        await send({ type: "complete" });
    } catch (error) {
        const detail = error as Error & { code?: string };
        await send({ type: "error", name: detail.name, code: detail.code, message: detail.message || String(error) }).catch(() => undefined);
        process.exitCode = 1;
    } finally { if (process.connected) process.disconnect(); }
});
process.on("disconnect", () => { process.exit(running ? process.exitCode || 0 : 1); });
