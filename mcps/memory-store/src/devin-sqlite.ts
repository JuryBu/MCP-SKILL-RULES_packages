import path from "node:path";
import fs from "node:fs";
import type { ConversationSourceFingerprint } from "./conversation-source-cache.js";
import type { DevinConversationSummary, DevinDesktopMessage, DevinRawConversation, DevinReadOptions, DevinDiscoveryOptions, DevinDiscoveryResult, DevinDiscoveryDiagnostic } from "./devin-types.js";
import { readCliConversations, type CliConversation } from "./devin-sqlite-cli.js";
import { ReadBudget, DevinReadError, asTimestamp, columns, desktopFiles, devinPaths, digest, inSnapshot, isFile, jsonObject } from "./devin-sqlite-store.js";

export { DevinReadError } from "./devin-sqlite-store.js";

interface DesktopConversation {
    summary: DevinConversationSummary;
    messages: DevinDesktopMessage[];
    messageIds: Set<string>;
    toolCallIds: Set<string>;
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

function desktopToolCallIds(messages: DevinDesktopMessage[]): Set<string> {
    const result = new Set<string>();
    for (const message of messages) {
        if (message.kind !== "tool_call") continue;
        const payload = message.payload;
        const id = payload.content?.toolCallId ?? payload.toolCallId ?? payload.id;
        if (typeof id === "string" && id) result.add(id.replace(/^tool:/u, ""));
    }
    return result;
}

async function readDesktop(filename: string, budget: ReadBudget, identityOnly = false): Promise<DesktopConversation> {
    return inSnapshot(filename, budget, async (database, identity, schema) => {
        if (!["position", "kind", "payload"].every(column => columns(database, "messages").has(column)) ||
            !["key", "value"].every(column => columns(database, "meta").has(column))) {
            throw new DevinReadError("DEVIN_SCHEMA_UNSUPPORTED", "The Devin Desktop database does not have the supported meta/messages schema.");
        }
        const metadata: Record<string, string> = {};
        const metadataValue = identityOnly ? `CASE WHEN key='info' AND json_valid(value) THEN json_object('title', json_extract(value,'$.title'), 'cwd',json_extract(value,'$.cwd'), 'workingDirectory',json_extract(value,'$.workingDirectory'), 'workspaceUris',json_extract(value,'$.workspaceUris'), 'hidden',json_extract(value,'$.hidden'), 'truncated',json_extract(value,'$.truncated')) ELSE value END` : "value";
        for (const row of database.prepare(`SELECT key, ${metadataValue} AS value FROM meta ${identityOnly ? "WHERE key IN ('info','message_count','hidden','truncated')" : ""} ORDER BY key`).iterate()) {
            await budget.take(Buffer.byteLength(String(row.value)));
            metadata[String(row.key)] = String(row.value);
        }
        const info = jsonObject(metadata.info);
        const messages: DevinDesktopMessage[] = [];
        const payloadExpression = identityOnly
            ? `CASE WHEN json_valid(payload) THEN CASE WHEN json_type(payload)='object' THEN json_object('id',json_extract(payload,'$.id'),'toolCallId',coalesce(json_extract(payload,'$.content.toolCallId'),json_extract(payload,'$.toolCallId')),'content', json((SELECT json_group_array(json_object('_meta', json_object('cognition.ai/clientMessageId', json_extract(block.value, '$._meta."cognition.ai/clientMessageId"'), 'cognition.ai/timestamp', json_extract(block.value, '$._meta."cognition.ai/timestamp"'))))
                FROM json_each(messages.payload, '$.content') AS block WHERE block.type='object'))) ELSE payload END ELSE payload END`
            : "payload";
        const statement = database.prepare(`WITH selected AS (SELECT position, kind, ${payloadExpression} AS payload FROM messages)
            SELECT position, kind, length(CAST(payload AS BLOB)) AS bytes,
            CASE WHEN length(CAST(payload AS BLOB)) <= ? THEN payload END AS payload FROM selected ORDER BY position`);
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
            messages, messageIds: desktopMessageIds(messages), toolCallIds: desktopToolCallIds(messages), revision: digest([identity, schema, metadata, messages]),
            hidden: info.hidden === true || info.hidden === 1 || metadata.hidden === "1" || metadata.hidden === "true",
            empty: messages.length === 0,
        };
    });
}

async function readCatalog(budget: ReadBudget, identityOnly = false, selectedDesktopFiles?: string[]): Promise<CatalogEntry[]> {
    const paths = devinPaths();
    const filenames = selectedDesktopFiles ?? desktopFiles(paths.desktop, budget.maxDesktopFiles, () => budget.check());
    const cli = isFile(paths.cli) ? await readCliConversations(paths.cli, budget, { identityOnly }) : [];
    const results: CatalogEntry[] = cli.map(item => ({ summary: item.summary, cli: item, desktops: [], excludedFromList: item.hidden || item.empty }));
    const entryById = new Map(results.map(entry => [entry.summary.canonicalId, entry]));
    const incompleteIdentityScan = cli.some(conversation => !conversation.empty && conversation.summary.partial);
    const cliByMessageId = new Map<string, Set<CliConversation>>();
    const cliByToolCallId = new Map<string, Set<CliConversation>>();
    for (const conversation of cli) {
        for (const id of conversation.messageIds) {
            const matches = cliByMessageId.get(id) ?? new Set<CliConversation>();
            matches.add(conversation);
            cliByMessageId.set(id, matches);
        }
        for (const id of conversation.toolCallIds) {
            const matches = cliByToolCallId.get(id) ?? new Set<CliConversation>();
            matches.add(conversation);
            cliByToolCallId.set(id, matches);
        }
    }
    for (const filename of filenames) {
        budget.check();
        const desktop = await readDesktop(filename, budget, identityOnly);
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
        const hasUnidentifiedUsers = desktop.messages.some(message => message.kind === "user_message" && desktopMessageIds([message]).size === 0);
        const toolIdentity = desktop.messageIds.size === 0 && !hasUnidentifiedUsers && desktop.toolCallIds.size >= 2;
        if (toolIdentity) {
            for (const toolId of desktop.toolCallIds) {
                for (const candidate of cliByToolCallId.get(toolId) ?? []) matches.set(candidate, (matches.get(candidate) ?? 0) + 1);
            }
        }
        if (matches.size === 1 && !incompleteIdentityScan) {
            const [candidate, count] = matches.entries().next().value!;
            if (toolIdentity && (count < 2 || [...desktop.toolCallIds].some(id => !candidate.toolCallIds.has(id)))) {
                desktop.summary.warnings.push("DEVIN_TOOL_IDENTITY_INCOMPLETE");
                results.push({ summary: desktop.summary, desktops: [desktop], excludedFromList: false });
                continue;
            }
            const entry = entryById.get(candidate.summary.canonicalId)!;
            entry.desktops.push(desktop);
            entry.summary = {
                ...entry.summary,
                uuid: entry.summary.uuid ?? desktop.summary.uuid,
                aliases: [...new Set([...entry.summary.aliases, desktop.summary.canonicalId])],
                desktopPaths: [...entry.summary.desktopPaths, filename],
                matchedMessageIds: new Set(entry.desktops.flatMap(item => [...item.messageIds].filter(id => candidate.messageIds.has(id)))).size,
                matchedToolCallIds: new Set(entry.desktops.flatMap(item => [...item.toolCallIds].filter(id => candidate.toolCallIds.has(id)))).size,
                identityEvidence: entry.summary.identityEvidence === "client-message-id" || !toolIdentity ? "client-message-id" : "tool-call-id",
                partial: entry.summary.partial || hasUnidentifiedUsers || desktop.summary.warnings.includes("DEVIN_DESKTOP_TRUNCATED") || [...desktop.messageIds].some(id => !candidate.messageIds.has(id)),
                warnings: [...new Set([...entry.summary.warnings, ...desktop.summary.warnings.filter(warning => warning !== "DEVIN_DESKTOP_ONLY_PARTIAL")])],
            };
            if (hasUnidentifiedUsers) entry.summary.warnings.push("DEVIN_DESKTOP_USER_ID_MISSING");
            if ([...desktop.messageIds].some(id => !candidate.messageIds.has(id))) entry.summary.warnings.push("DEVIN_DESKTOP_USER_HISTORY_NOT_IN_CLI");
        } else {
            if (matches.size > 1) desktop.summary.warnings.push("DEVIN_ALIAS_AMBIGUOUS");
            if (incompleteIdentityScan) desktop.summary.warnings.push("DEVIN_ALIAS_SCAN_INCOMPLETE");
            results.push({ summary: desktop.summary, desktops: [desktop], excludedFromList: false });
        }
    }
    for (const entry of results) {
        if (!entry.cli || identityOnly) continue;
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

function discoveryPath(value: string): string {
    let normalized = value.replace(/^file:\/\/\//iu, "");
    try { normalized = decodeURIComponent(normalized); } catch {}
    return normalized.replace(/\\/gu, "/").replace(/\/+$/u, "").toLowerCase();
}

function discoveryMatches(summary: DevinConversationSummary, options: DevinDiscoveryOptions, allowUnresolvedAlias = false): boolean {
    if (options.conversationIds?.length && !options.conversationIds.some(id => summary.aliases.some(alias => alias.toLowerCase() === id.toLowerCase())) && !allowUnresolvedAlias) return false;
    const normalize = (value: string) => value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
    if (options.query?.trim()) {
        const haystack = normalize([summary.title, summary.id, ...summary.aliases, ...summary.workspaceUris].join(" "));
        const terms = options.query.split(/\s+/u).map(normalize).filter(Boolean);
        if (terms.length && !terms.some(term => haystack.includes(term))) return false;
    }
    if (options.workspaces?.length) {
        const known = (options.workspaceScope === "primary" ? [summary.cwd || ""] : summary.workspaceUris).map(discoveryPath).filter(Boolean);
        if (known.length) {
            const matches = options.workspaces.map(discoveryPath).filter(Boolean).map(requested => known.some(candidate => options.workspaceMode === "exact" ? candidate === requested
                : options.workspaceMode === "under" ? candidate === requested || candidate.startsWith(`${requested}/`) : candidate.includes(requested)));
            if (options.workspaceMode === "all" ? matches.some(match => !match) : !matches.some(Boolean)) return false;
        }
    }
    return true;
}

async function readDesktopMetadata(filename: string, budget: ReadBudget): Promise<{ summary: DevinConversationSummary; hidden: boolean; empty: boolean }> {
    return inSnapshot(filename, budget, async database => {
        if (!["key", "value"].every(column => columns(database, "meta").has(column)) || !columns(database, "messages").has("position")) {
            throw new DevinReadError("DEVIN_SCHEMA_UNSUPPORTED", "The Devin Desktop metadata schema is unsupported.");
        }
        const metadata: Record<string, string> = {};
        for (const row of database.prepare(`SELECT key, CASE WHEN key='info' AND json_valid(value) THEN json_object('title',json_extract(value,'$.title'),'cwd',json_extract(value,'$.cwd'),'workingDirectory',json_extract(value,'$.workingDirectory'),'workspaceUris',json_extract(value,'$.workspaceUris'),'hidden',json_extract(value,'$.hidden'),'truncated',json_extract(value,'$.truncated')) ELSE value END AS value FROM meta WHERE key IN ('info','hidden','truncated')`).iterate()) {
            await budget.take(Buffer.byteLength(String(row.value)));
            metadata[String(row.key)] = String(row.value);
        }
        const info = jsonObject(metadata.info);
        const uuid = path.parse(filename).name.toLowerCase();
        const directories = [info.cwd, info.workingDirectory, ...(Array.isArray(info.workspaceUris) ? info.workspaceUris : [])].filter((value): value is string => typeof value === "string" && !!value);
        const empty = !database.prepare("SELECT 1 FROM messages LIMIT 1").get();
        return {
            summary: { id: uuid, canonicalId: uuid, uuid, aliases: [uuid], title: typeof info.title === "string" ? info.title : uuid,
                cwd: directories[0], workspaceUris: [...new Set(directories)], updatedAt: fs.statSync(filename).mtime.toISOString(),
                sourcePath: filename, desktopPaths: [filename], sourceKind: "devin-desktop", matchedMessageIds: 0, partial: true,
                warnings: ["DEVIN_DESKTOP_ONLY_PARTIAL", ...(metadata.truncated === "1" || info.truncated === true ? ["DEVIN_DESKTOP_TRUNCATED"] : [])] },
            hidden: info.hidden === true || info.hidden === 1 || metadata.hidden === "1" || metadata.hidden === "true", empty,
        };
    });
}

export async function discoverDevinConversations(options: DevinDiscoveryOptions = {}): Promise<DevinDiscoveryResult> {
    const budget = new ReadBudget(options);
    const paths = devinPaths();
    const result: DevinDiscoveryResult = { conversations: [], partial: false, diagnostics: [], scannedSessions: 0, scannedDesktopFiles: 0 };
    const diagnose = (error: unknown, sourceKind: DevinDiscoveryDiagnostic["sourceKind"], sourcePath: string, conversationId?: string) => {
        if (error instanceof DevinReadError && error.code === "DEVIN_ABORTED") throw error;
        result.partial = true;
        result.diagnostics.push({ code: error instanceof DevinReadError ? error.code : "DEVIN_DISCOVERY_READ", message: error instanceof Error ? error.message : String(error), sourceKind, sourcePath, conversationId });
    };
    const idsAreCliOnly = options.conversationIds?.length && options.conversationIds.every(id => !/^[\da-f]{8}-[\da-f-]{27,}$/iu.test(id));
    try {
        if (isFile(paths.cli)) {
            await readCliConversations(paths.cli, budget, { metadataOnly: true,
                conversationIds: idsAreCliOnly ? options.conversationIds : undefined,
                acceptSummary: summary => discoveryMatches(summary, options, true), onSession: () => { result.scannedSessions++; },
                onConversation: item => { if (!item.hidden && !item.empty) result.conversations.push(item.summary); },
                onSessionError: (id, error) => diagnose(error, "devin-cli", paths.cli!, id) });
        }
    } catch (error) { diagnose(error, "devin-cli", paths.cli || ""); }
    const selectedDesktopFiles: string[] = [];
    try {
        const filenames = idsAreCliOnly && options.verifyAliases === false ? [] : desktopFiles(paths.desktop, budget.maxDesktopFiles, () => budget.check(), error => diagnose(error, "devin-desktop", paths.desktop || ""));
        for (const filename of filenames) {
            try {
                budget.check();
                result.scannedDesktopFiles++;
                const desktop = await readDesktopMetadata(filename, budget);
                if (desktop.hidden || desktop.empty) continue;
                selectedDesktopFiles.push(filename);
                result.conversations.push(desktop.summary);
            } catch (error) {
                diagnose(error, "devin-desktop", filename, path.parse(filename).name);
                if (error instanceof DevinReadError && /BUDGET|DEADLINE/u.test(error.code)) break;
            }
        }
    } catch (error) { diagnose(error, "devin-desktop", paths.desktop || ""); }
    if (selectedDesktopFiles.length && options.verifyAliases !== false && !result.partial) {
        try {
            const aliasBudget = new ReadBudget({ ...options, maxNodes: Math.min(budget.maxNodes - budget.nodes, 4096), maxBytes: Math.min(budget.remainingBytes, 16 * 1024 * 1024), deadlineMs: Math.min(budget.deadline, Date.now() + 1500) });
            const entries = await readCatalog(aliasBudget, true, selectedDesktopFiles);
            const selected = new Set(result.conversations.map(summary => summary.id));
            for (const entry of entries) {
                if (entry.excludedFromList || !entry.summary.aliases.some(id => selected.has(id))) continue;
                result.conversations = result.conversations.filter(summary => !entry.summary.aliases.includes(summary.id));
                result.conversations.push(entry.summary);
            }
        } catch (error) { diagnose(error, "devin-cli", paths.cli || "", "alias-verification"); }
    }
    result.conversations = result.conversations.filter(summary => discoveryMatches(summary, options));
    for (const summary of result.conversations) {
        for (const code of summary.warnings) {
            if (code === "DEVIN_DESKTOP_ONLY_PARTIAL") continue;
            result.diagnostics.push({ code, message: `Devin source reported ${code}.`, sourceKind: summary.sourceKind, sourcePath: summary.sourcePath, conversationId: summary.id });
        }
    }
    result.conversations.sort((left, right) => (Date.parse(right.updatedAt || "") || 0) - (Date.parse(left.updatedAt || "") || 0) || left.id.localeCompare(right.id));
    if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 0)) throw new DevinReadError("DEVIN_INVALID_BUDGET", "Devin discovery limit must be a non-negative safe integer.");
    const limit = Math.min(options.limit ?? 20_000, 20_000);
    if (result.conversations.length > limit) {
        result.partial = true;
        result.diagnostics.push({ code: "DEVIN_CANDIDATE_LIMIT", message: "Devin metadata candidates exceeded the requested limit.", sourceKind: "devin-cli", sourcePath: paths.cli || "" });
    }
    result.conversations = result.conversations.slice(0, limit);
    result.partial ||= result.diagnostics.length > 0 || result.conversations.some(summary => summary.partial);
    return result;
}

export async function listDevinConversations(options: DevinReadOptions = {}): Promise<DevinConversationSummary[]> {
    return (await readCatalog(new ReadBudget(options))).filter(entry => !entry.excludedFromList).map(entry => entry.summary);
}

export async function listDevinConversationIdentities(options: DevinReadOptions = {}): Promise<DevinConversationSummary[]> {
    return (await readCatalog(new ReadBudget(options), true)).filter(entry => !entry.excludedFromList).map(entry => entry.summary);
}

export async function resolveDevinConversation(id: string, options: DevinReadOptions = {}): Promise<DevinConversationSummary | null> {
    if (!id.trim()) throw new DevinReadError("DEVIN_INVALID_ID", "A non-empty Devin conversation ID is required.");
    const budget = new ReadBudget(options);
    const entry = findEntry(await readCatalog(budget, true), id);
    return entry?.summary ?? null;
}

export async function readDevinRawConversation(id: string, options: DevinReadOptions = {}): Promise<DevinRawConversation | null> {
    if (!id.trim()) throw new DevinReadError("DEVIN_INVALID_ID", "A non-empty Devin conversation ID is required.");
    const budget = new ReadBudget(options);
    const entry = findEntry(await readCatalog(budget, true), id);
    if (entry) {
        const sameIds = (left: Set<string>, right: Set<string>) => left.size === right.size && [...left].every(value => right.has(value));
        if (entry.cli) {
            const loaded = (await readCliConversations(entry.cli.summary.sourcePath, budget, { sessionId: entry.cli.summary.canonicalId }))[0];
            if (!loaded || !sameIds(entry.cli.messageIds, loaded.messageIds) || !sameIds(entry.cli.toolCallIds, loaded.toolCallIds)) {
                throw new DevinReadError("DEVIN_IDENTITY_CHANGED", "Devin identity changed during source reading; retry with a fresh snapshot.");
            }
            entry.cli = loaded;
            entry.summary.partial ||= loaded.summary.partial;
            entry.summary.warnings = [...new Set([...entry.summary.warnings, ...loaded.summary.warnings])];
        }
        for (const [index, desktop] of entry.desktops.entries()) {
            const loaded = await readDesktop(desktop.summary.sourcePath, budget);
            if (!sameIds(desktop.messageIds, loaded.messageIds) || !sameIds(desktop.toolCallIds, loaded.toolCallIds)) {
                throw new DevinReadError("DEVIN_IDENTITY_CHANGED", "Devin Desktop identity changed during source reading; retry with a fresh snapshot.");
            }
            entry.desktops[index] = loaded;
            entry.summary.partial ||= loaded.summary.warnings.some(warning => warning !== "DEVIN_DESKTOP_ONLY_PARTIAL");
            entry.summary.warnings = [...new Set([...entry.summary.warnings, ...loaded.summary.warnings.filter(warning => warning !== "DEVIN_DESKTOP_ONLY_PARTIAL")])];
        }
        const coverage = subagentCoverage(entry);
        if (coverage.unresolved) {
            entry.summary.partial = true;
            entry.summary.warnings = [...new Set([...entry.summary.warnings, "DEVIN_SUBAGENT_TRANSCRIPT_UNRESOLVED",
                ...(coverage.ambiguous ? ["DEVIN_SUBAGENT_TRANSCRIPT_AMBIGUOUS"] : [])])];
        }
    }
    const result = entry ? toRaw(entry) : null;
    budget.check();
    return result;
}

export async function fingerprintDevinConversation(id: string, options: DevinReadOptions = {}): Promise<ConversationSourceFingerprint | null> {
    return (await readDevinRawConversation(id, options))?.fingerprint ?? null;
}
