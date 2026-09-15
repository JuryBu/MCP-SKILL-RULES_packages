import path from "node:path";
import type { ConversationSourceFingerprint } from "./conversation-source-cache.js";
import type { DevinConversationSummary, DevinDesktopMessage, DevinRawConversation, DevinReadOptions } from "./devin-types.js";
import { readCliConversations, type CliConversation } from "./devin-sqlite-cli.js";
import { ReadBudget, DevinReadError, asTimestamp, columns, desktopFiles, devinPaths, digest, inSnapshot, isFile, jsonObject } from "./devin-sqlite-store.js";

export { DevinReadError } from "./devin-sqlite-store.js";

interface DesktopConversation {
    summary: DevinConversationSummary;
    messages: DevinDesktopMessage[];
    messageIds: Set<string>;
    revision: string;
    hidden: boolean;
    empty: boolean;
}

interface CatalogEntry {
    summary: DevinConversationSummary;
    cli?: CliConversation;
    desktops: DesktopConversation[];
    excludedFromList: boolean;
}

function subagentCoverage(entry: CatalogEntry): { unresolved: boolean; ambiguous: boolean } {
    const calls = new Map<string, { id?: string; task?: string }>();
    for (const node of entry.cli?.nodes ?? []) {
        for (const [index, call] of (Array.isArray(node.message.tool_calls) ? node.message.tool_calls : []).entries()) {
            if ((call?.function?.name ?? call?.name) !== "run_subagent") continue;
            let argumentsValue = call.function?.arguments ?? call.arguments ?? call.rawInput;
            if (typeof argumentsValue === "string") {
                try { argumentsValue = JSON.parse(argumentsValue); } catch { argumentsValue = undefined; }
            }
            const id = typeof call.id === "string" ? call.id : undefined;
            calls.set(id ?? `${node.nodeId}:${index}`, { id, task: typeof argumentsValue?.task === "string" ? argumentsValue.task : undefined });
        }
    }
    const transcripts = new Map<string, { toolCallId?: string; task?: string }>();
    const messages = [...entry.desktops.flatMap(desktop => desktop.messages), ...(entry.cli?.supplements ?? [])];
    for (const message of messages) {
        const payload = message.payload;
        if (message.kind !== "subagent" || typeof payload.agentId !== "string" || !payload.agentId || payload.partial ||
            !(payload.childMessages?.length > 0 || payload.rawNodes?.length > 0)) continue;
        const explicitCallId = payload.toolCallId ?? payload.parentToolCallId ?? payload.tool_call_id;
        const toolCallId = typeof explicitCallId === "string" ? explicitCallId : undefined;
        const task = typeof payload.task === "string" ? payload.task : undefined;
        transcripts.set(JSON.stringify([payload.agentId, toolCallId, task]), { toolCallId, task });
    }
    let unresolved = false;
    let ambiguous = false;
    for (const call of calls.values()) {
        const strongMatches = [...transcripts.values()].filter(transcript => call.id && transcript.toolCallId === call.id);
        if (strongMatches.length === 1) continue;
        if (strongMatches.length > 1) { unresolved = true; ambiguous = true; continue; }
        const taskMatches = [...transcripts.values()].filter(transcript => !transcript.toolCallId && call.task && transcript.task === call.task);
        const repeatedTask = call.task && [...calls.values()].filter(other => other.task === call.task).length > 1;
        if (taskMatches.length !== 1 || repeatedTask) {
            unresolved = true;
            if (taskMatches.length > 1 || repeatedTask) ambiguous = true;
        }
    }
    return { unresolved, ambiguous };
}

function desktopMessageIds(messages: DevinDesktopMessage[]): Set<string> {
    const result = new Set<string>();
    for (const message of messages) {
        if (message.kind !== "user_message" || !Array.isArray(message.payload.content)) continue;
        for (const block of message.payload.content) {
            const id = block?._meta?.["cognition.ai/clientMessageId"];
            if (typeof id === "string" && id.length > 0) result.add(id);
        }
    }
    return result;
}

async function readDesktop(filename: string, budget: ReadBudget): Promise<DesktopConversation> {
    return inSnapshot(filename, budget, async (database, identity, schema) => {
        if (!["position", "kind", "payload"].every(column => columns(database, "messages").has(column)) ||
            !["key", "value"].every(column => columns(database, "meta").has(column))) {
            throw new DevinReadError("DEVIN_SCHEMA_UNSUPPORTED", "The Devin Desktop database does not have the supported meta/messages schema.");
        }
        const metadata: Record<string, string> = {};
        for (const row of database.prepare("SELECT key, value FROM meta ORDER BY key").iterate()) {
            await budget.take(Buffer.byteLength(String(row.value)));
            metadata[String(row.key)] = String(row.value);
        }
        const info = jsonObject(metadata.info);
        const messages: DevinDesktopMessage[] = [];
        const statement = database.prepare(`SELECT position, kind, length(CAST(payload AS BLOB)) AS bytes,
            CASE WHEN length(CAST(payload AS BLOB)) <= ? THEN payload END AS payload FROM messages ORDER BY position`);
        for (const row of statement.iterate(budget.remainingBytes)) {
            await budget.take(Number(row.bytes));
            messages.push({ position: Number(row.position), kind: String(row.kind), payload: jsonObject(row.payload, true), sourcePath: filename });
        }
        const uuid = path.parse(filename).name.toLowerCase();
        const timestamps = messages.flatMap(message => Array.isArray(message.payload.content)
            ? message.payload.content.map(block => asTimestamp(block?._meta?.["cognition.ai/timestamp"])).filter((item): item is string => !!item) : []);
        const warnings = ["DEVIN_DESKTOP_ONLY_PARTIAL"];
        if (!messages.length) warnings.push("DEVIN_EMPTY_CONVERSATION");
        if (metadata.truncated === "1" || info.truncated === true) warnings.push("DEVIN_DESKTOP_TRUNCATED");
        if (metadata.message_count !== undefined && Number(metadata.message_count) !== messages.length) warnings.push("DEVIN_DESKTOP_COUNT_MISMATCH");
        const directories = [info.cwd, info.workingDirectory, ...(Array.isArray(info.workspaceUris) ? info.workspaceUris : [])].filter((value): value is string => typeof value === "string" && !!value);
        return {
            summary: {
                id: uuid, canonicalId: uuid, uuid, aliases: [uuid],
                title: typeof info.title === "string" ? info.title : uuid,
                cwd: directories[0], workspaceUris: [...new Set(directories)],
                createdAt: timestamps[0], updatedAt: timestamps.at(-1), sourcePath: filename,
                desktopPaths: [filename], sourceKind: "devin-desktop", matchedMessageIds: 0, partial: true, warnings,
            },
            messages, messageIds: desktopMessageIds(messages), revision: digest([identity, schema, metadata, messages]),
            hidden: info.hidden === true || info.hidden === 1 || metadata.hidden === "1" || metadata.hidden === "true",
            empty: messages.length === 0,
        };
    });
}

async function readCatalog(budget: ReadBudget): Promise<CatalogEntry[]> {
    const paths = devinPaths();
    const filenames = desktopFiles(paths.desktop, budget.maxDesktopFiles, () => budget.check());
    const cli = isFile(paths.cli) ? await readCliConversations(paths.cli, budget) : [];
    const results: CatalogEntry[] = cli.map(item => ({ summary: item.summary, cli: item, desktops: [], excludedFromList: item.hidden || item.empty }));
    const entryById = new Map(results.map(entry => [entry.summary.canonicalId, entry]));
    const incompleteIdentityScan = cli.some(conversation => !conversation.empty && conversation.summary.partial && conversation.nodes.length === 0);
    const cliByMessageId = new Map<string, Set<CliConversation>>();
    for (const conversation of cli) {
        for (const id of conversation.messageIds) {
            const matches = cliByMessageId.get(id) ?? new Set<CliConversation>();
            matches.add(conversation);
            cliByMessageId.set(id, matches);
        }
    }
    for (const filename of filenames) {
        budget.check();
        const desktop = await readDesktop(filename, budget);
        if (desktop.hidden || desktop.empty) {
            results.push({ summary: desktop.summary, desktops: [desktop], excludedFromList: true });
            continue;
        }
        const matches = new Map<CliConversation, number>();
        for (const messageId of desktop.messageIds) {
            for (const candidate of cliByMessageId.get(messageId) ?? []) {
                matches.set(candidate, (matches.get(candidate) ?? 0) + 1);
            }
        }
        if (matches.size === 1 && !incompleteIdentityScan) {
            const [candidate] = matches.entries().next().value!;
            const entry = entryById.get(candidate.summary.canonicalId)!;
            entry.desktops.push(desktop);
            entry.summary = {
                ...entry.summary,
                uuid: entry.summary.uuid ?? desktop.summary.uuid,
                aliases: [...new Set([...entry.summary.aliases, desktop.summary.canonicalId])],
                desktopPaths: [...entry.summary.desktopPaths, filename],
                matchedMessageIds: new Set(entry.desktops.flatMap(item => [...item.messageIds].filter(id => candidate.messageIds.has(id)))).size,
                partial: entry.summary.partial || [...desktop.messageIds].some(id => !candidate.messageIds.has(id)),
                warnings: [...new Set([...entry.summary.warnings, ...desktop.summary.warnings.filter(warning => warning !== "DEVIN_DESKTOP_ONLY_PARTIAL")])],
            };
            if ([...desktop.messageIds].some(id => !candidate.messageIds.has(id))) entry.summary.warnings.push("DEVIN_DESKTOP_USER_HISTORY_NOT_IN_CLI");
        } else {
            if (matches.size > 1) desktop.summary.warnings.push("DEVIN_ALIAS_AMBIGUOUS");
            if (incompleteIdentityScan) desktop.summary.warnings.push("DEVIN_ALIAS_SCAN_INCOMPLETE");
            results.push({ summary: desktop.summary, desktops: [desktop], excludedFromList: false });
        }
    }
    for (const entry of results) {
        if (!entry.cli) continue;
        const coverage = subagentCoverage(entry);
        if (coverage.unresolved) {
            entry.summary = { ...entry.summary, partial: true,
                warnings: [...new Set([...entry.summary.warnings, "DEVIN_SUBAGENT_TRANSCRIPT_UNRESOLVED",
                    ...(coverage.ambiguous ? ["DEVIN_SUBAGENT_TRANSCRIPT_AMBIGUOUS"] : [])])] };
        }
    }
    budget.check();
    return results;
}

function findEntry(entries: CatalogEntry[], id: string): CatalogEntry | undefined {
    const exact = entries.find(entry => entry.summary.canonicalId === id);
    if (exact) return exact;
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const matches = entries.filter(entry => entry.summary.aliases.some(alias => alias === id ||
        (uuidPattern.test(id) && uuidPattern.test(alias) && alias.toLowerCase() === id.toLowerCase())));
    if (matches.length > 1) throw new DevinReadError("DEVIN_ALIAS_AMBIGUOUS", "The Devin conversation alias does not identify a unique source.");
    return matches[0];
}

function toRaw(entry: CatalogEntry): DevinRawConversation {
    const desktopMessages = entry.desktops.flatMap(desktop => desktop.messages);
    const supplements = entry.cli?.supplements ?? [];
    const cliAgents = new Map(supplements.filter(message => message.kind === "subagent" && Array.isArray(message.payload.rawNodes) && message.payload.rawNodes.length > 0).map(message => [message.payload.agentId, message]));
    const enrichedDesktop = desktopMessages.map(message => {
        const cli = message.kind === "subagent" ? cliAgents.get(message.payload.agentId) : undefined;
        return cli ? { ...message, payload: { ...message.payload, rawNodes: cli.payload.rawNodes, compactions: cli.payload.compactions, partial: cli.payload.partial, source: "devin-cli-with-desktop" } } : message;
    });
    const representedAgents = new Set(enrichedDesktop.filter(message => message.kind === "subagent").map(message => message.payload.agentId));
    const fingerprint: ConversationSourceFingerprint = {
        path: entry.summary.sourcePath,
        revision: `devin-sqlite/v1:${digest([entry.summary, entry.cli?.revision, entry.desktops.map(desktop => desktop.revision)])}`,
    };
    return {
        summary: entry.summary, nodes: entry.cli?.nodes ?? [],
        desktopMessages: [...enrichedDesktop, ...supplements.filter(message => message.kind !== "subagent" || !representedAgents.has(message.payload.agentId))], compactions: entry.cli?.compactions ?? [],
        fingerprint, partial: entry.summary.partial, warnings: [...entry.summary.warnings],
    };
}

export function isDevinStoreAvailable(): boolean {
    const paths = devinPaths();
    if (isFile(paths.cli)) return true;
    try { return desktopFiles(paths.desktop, 1).length > 0; } catch (error) {
        if (error instanceof DevinReadError && error.code === "DEVIN_DESKTOP_BUDGET") return true;
        return false;
    }
}

export async function listDevinConversations(options: DevinReadOptions = {}): Promise<DevinConversationSummary[]> {
    return (await readCatalog(new ReadBudget(options))).filter(entry => !entry.excludedFromList).map(entry => entry.summary);
}

export async function resolveDevinConversation(id: string, options: DevinReadOptions = {}): Promise<DevinConversationSummary | null> {
    if (!id.trim()) throw new DevinReadError("DEVIN_INVALID_ID", "A non-empty Devin conversation ID is required.");
    return findEntry(await readCatalog(new ReadBudget(options)), id)?.summary ?? null;
}

export async function readDevinRawConversation(id: string, options: DevinReadOptions = {}): Promise<DevinRawConversation | null> {
    if (!id.trim()) throw new DevinReadError("DEVIN_INVALID_ID", "A non-empty Devin conversation ID is required.");
    const budget = new ReadBudget(options);
    const entry = findEntry(await readCatalog(budget), id);
    const result = entry ? toRaw(entry) : null;
    budget.check();
    return result;
}

export async function fingerprintDevinConversation(id: string, options: DevinReadOptions = {}): Promise<ConversationSourceFingerprint | null> {
    return (await readDevinRawConversation(id, options))?.fingerprint ?? null;
}
