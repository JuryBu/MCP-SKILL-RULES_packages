import fs from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { discoverLocalPbCandidates, localPbResultToRounds } from "./conversation-source-adapters.js";
import { prepareLocalPbFileCandidates, type LocalPbFileCandidate, type LocalPbReadResult, type PreparedLocalPbCandidates } from "./local-pb-reader.js";
import { readDevinConversation, DEVIN_NORMALIZATION_VERSION, splitDevinSubagentId } from "./devin-conversation.js";
import { resolveDevinConversation, discoverDevinConversations, DevinIdentityCache } from "./devin-sqlite.js";
import { ReadBudget } from "./devin-sqlite-store.js";
import { assertHostFileUnchanged, captureHostFile, type HostFileRevision } from "./conversation-host-files.js";
import { assertHostReadActive, hostCorpusDigest, type HostCorpusSnapshot } from "./conversation-host-projection.js";
import type { HostCorpusReaderOptions } from "./conversation-corpus-reader-hosts.js";
import type { CorpusConversation, CorpusFastReadRequest, CorpusReadControl, CorpusSearchRequest, CorpusSourceStatus, CorpusVerifiedIdentity } from "./conversation-corpus-types.js";
import { listAntigravityLocalConversations, loadAntigravityLocalConversation } from "./antigravity-local-history.js";

const verifiedIdentities = new WeakMap<CorpusConversation, CorpusVerifiedIdentity>();

export function restoreIsolatedCorpusIdentity(conversation: CorpusConversation, identity?: CorpusVerifiedIdentity): void {
    if (!identity) return;
    if (identity.authority !== "devin-sqlite" || identity.source !== conversation.source
        || identity.canonicalId !== conversation.id || conversation.canonicalId !== conversation.id
        || JSON.stringify(identity.aliases) !== JSON.stringify(conversation.aliases)) {
        throw new Error("Isolated source returned conflicting verified identity");
    }
    verifiedIdentities.set(conversation, identity);
}

export function verifiedCorpusIdentity(conversation: CorpusConversation): CorpusVerifiedIdentity | undefined {
    const identity = verifiedIdentities.get(conversation);
    if (!identity || conversation.source !== identity.source || conversation.id !== identity.canonicalId
        || conversation.canonicalId !== identity.canonicalId || JSON.stringify(conversation.aliases) !== JSON.stringify(identity.aliases)) return undefined;
    return { ...identity, aliases: [...identity.aliases] };
}

export function corpusProjectionIdentityMatches(actual: CorpusConversation, expected: CorpusConversation): boolean {
    if (actual.source !== expected.source) return false;
    if (actual.id === expected.id && (actual.canonicalId || actual.id) === (expected.canonicalId || expected.id)) return true;
    const identity = verifiedCorpusIdentity(actual);
    return Boolean(identity && identity.aliases.includes(expected.id) && identity.aliases.includes(expected.canonicalId || expected.id));
}

export async function listBinaryHostConversations(source: "windsurf" | "antigravity", request: CorpusSearchRequest, control: CorpusReadControl, options: HostCorpusReaderOptions): Promise<{ conversations: CorpusConversation[]; statuses: CorpusSourceStatus[] }> {
    if (source === "antigravity") {
        const warnings: string[] = [];
        const local = await listAntigravityLocalConversations({ conversationIds: request.conversationIds, limit: options.listLimit || 10_000,
            isCancelled: control.isCancelled, onDiagnostic: diagnostic => warnings.push(`${diagnostic.code}: ${diagnostic.message}`) });
        const conversations: CorpusConversation[] = local.map(candidate => ({ source, id: candidate.id, canonicalId: candidate.id,
            title: candidate.title, workspace: candidate.workspace, updatedAt: candidate.updatedAt, rolloutPath: candidate.sourcePath,
            sourceKind: candidate.sourceKind, sourceWarnings: [], parentConversationId: candidate.parentConversationId,
            isChildThread: candidate.isChildThread, agentRole: candidate.isChildThread ? "subagent" : undefined }));
        assertHostReadActive(control);
        return { conversations, statuses: [{ source, status: warnings.length ? "partial" : "ok", candidateCount: conversations.length, warnings }] };
    }
    const { listLocalPbConversationCandidates } = await import("./conversation-local-list.js");
    const warnings: string[] = [];
    const conversations: CorpusConversation[] = [];
    let partial = false;
    if (source === "windsurf") {
        const childTargets = request.conversationIds?.filter(id => Boolean(splitDevinSubagentId(id)));
        const parentTargets = request.conversationIds?.map(id => splitDevinSubagentId(id)?.parentId || id)
            ?? (request.threadMode === "children" && request.parentConversationId ? [request.parentConversationId] : undefined);
        const discovered = await discoverDevinConversations({ ...options.devinOptions,
            conversationIds: parentTargets,
            limit: options.listLimit || 10_000, verifyAliases: false, isCancelled: control.isCancelled,
            deadlineMs: control.deadlineAt ?? options.devinOptions?.deadlineMs });
        partial ||= discovered.partial;
        warnings.push(...discovered.diagnostics.map(item => `${item.code}: ${item.message}`));
        conversations.push(...discovered.conversations.map(summary => ({ source, id: summary.canonicalId, canonicalId: summary.canonicalId,
            aliases: summary.aliases, title: summary.title, workspace: summary.cwd || "", updatedAt: summary.updatedAt,
            rolloutPath: summary.sourcePath, sourceKind: summary.sourceKind, sourceWarnings: summary.warnings,
            parentConversationId: summary.parentConversationId, isChildThread: summary.isChildThread,
        })));
        if (childTargets?.length || request.threadMode === "children") {
            const { discoverDevinChildCandidates } = await import("./devin-child-discovery.js");
            const { readDevinRawConversation } = await import("./devin-sqlite.js");
            const children = await discoverDevinChildCandidates(discovered.conversations.map(summary => ({
                id: summary.canonicalId, dataChain: "windsurf" as const, title: summary.title, workspace: summary.cwd || "",
                updatedAt: summary.updatedAt || "", aliases: summary.aliases, sourceKind: summary.sourceKind,
                sourcePath: summary.sourcePath, sessionId: summary.sessionId, uuid: summary.uuid, detail: "explicit child lookup",
            })), { conversationIds: childTargets, parentConversationId: request.parentConversationId,
                deadlineAt: control.deadlineAt, isCancelled: control.isCancelled,
                maxBytes: options.devinOptions?.maxBytes, candidateLimit: options.listLimit,
                readRaw: (id, readOptions) => {
                    const parent = discovered.conversations.find(summary => summary.canonicalId === id || summary.aliases.includes(id));
                    return readDevinRawConversation(id, { ...readOptions,
                        ...(parent ? { identityMode: "physical", physicalSourceKind: parent.sourceKind } as const : {}) });
                } });
            warnings.push(...children.warnings);
            partial ||= children.warnings.length > 0;
            conversations.push(...children.candidates.map(candidate => ({ source, id: candidate.id, canonicalId: candidate.id,
                aliases: candidate.aliases, title: candidate.title, workspace: candidate.workspace, updatedAt: candidate.updatedAt,
                rolloutPath: candidate.sourcePath, sourceKind: candidate.sourceKind, sourceWarnings: candidate.discoveryWarnings,
                parentConversationId: candidate.parentConversationId || undefined, isChildThread: true, agentRole: candidate.agentRole || undefined,
            })));
        }
    }
    const local = listLocalPbConversationCandidates(source, { conversationIds: request.conversationIds, limit: options.listLimit || 10_000,
        isCancelled: control.isCancelled, onDiagnostic: diagnostic => { partial = true; warnings.push(`${diagnostic.code}: ${diagnostic.message}`); } });
    conversations.push(...local.filter(candidate => !conversations.some(item => item.id === candidate.id)).map(candidate => ({
        source, id: candidate.id, canonicalId: candidate.id, title: candidate.id, workspace: "", updatedAt: candidate.updatedAt,
        sourceKind: `local-pb-${candidate.kinds.join("+")}`, sourceWarnings: [] as string[],
    })));
    if (request.workspaces?.length && conversations.some(conversation => !conversation.workspace)) {
        partial = true;
        warnings.push("pb_workspace_metadata_unavailable: select conversationIds or inspect the source workspace metadata before narrowing by workspace");
    }
    assertHostReadActive(control);
    return { conversations, statuses: [{ source, status: partial ? "partial" : "ok", candidateCount: conversations.length, warnings }] };
}

interface PreparedState {
    key: string;
    paths: HostFileRevision[];
    prepared: PreparedLocalPbCandidates;
    full?: HostCorpusSnapshot;
}

async function sqliteSources(paths: string[], control: CorpusReadControl): Promise<HostFileRevision[]> {
    const revisions: HostFileRevision[] = [];
    for (const filename of [...new Set(paths)].sort()) {
        for (const suffix of ["", "-wal"]) {
            try { revisions.push(await captureHostFile(`${filename}${suffix}`, { isCancelled: control.isCancelled })); }
            catch (error) { if (suffix !== "-wal" || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        }
    }
    return revisions;
}

function physicalKey(revisions: HostFileRevision[]): string {
    return hostCorpusDigest(revisions.map(item => [item.path, item.sha256]));
}

function comparePbCandidates(results: LocalPbReadResult[]): LocalPbReadResult {
    const sorted = [...results].sort((left, right) => right.trajectory.steps.length - left.trajectory.steps.length);
    const longest = sorted[0];
    const canonical = (result: LocalPbReadResult) => result.trajectory.steps.map(step => JSON.stringify({ timestamp: step.timestamp, contextTokens: step.contextTokens, user: step.user, planner: step.planner, system: step.system, activities: step.activities, toolVariants: step.toolVariants, diagnostics: step.diagnostics }));
    const expected = canonical(longest);
    for (const other of sorted.slice(1)) {
        if (longest.trajectory.id && other.trajectory.id && longest.trajectory.id !== other.trajectory.id) throw new Error("PB candidate trajectory identities conflict");
        if (!canonical(other).every((step, index) => step === expected[index])) throw new Error("PB candidates have incomparable contents");
    }
    return longest;
}

export function createBinaryHostReader(source: "windsurf" | "antigravity", options: HostCorpusReaderOptions) {
    let preparedState: PreparedState | undefined;
    let antigravityFull: HostCorpusSnapshot | undefined;
    const readPb = async (conversation: CorpusConversation, request: CorpusFastReadRequest | undefined, control: CorpusReadControl): Promise<HostCorpusSnapshot> => {
        const started = performance.now();
        const id = conversation.canonicalId || conversation.id;
        const candidates: LocalPbFileCandidate[] = options.pbCandidates ? options.pbCandidates(source, id) : discoverLocalPbCandidates(source, id);
        if (!candidates.length) throw new Error(`No ${source} local PB source for ${id}`);
        const maximum = options.maxSourceBytes ?? 128 * 1024 * 1024;
        let candidateBytes = 0;
        for (const candidate of candidates) {
            assertHostReadActive(control);
            const stat = await fs.stat(candidate.filePath);
            if (!stat.isFile()) throw new Error("PB candidate is not a regular file");
            candidateBytes += stat.size;
            if (candidateBytes > maximum) throw new Error("PB candidate set exceeds maxSourceBytes; increase the explicit reader budget");
        }
        const revisions: HostFileRevision[] = [];
        for (const candidate of candidates) revisions.push(await captureHostFile(candidate.filePath, { isCancelled: control.isCancelled }));
        if (revisions.reduce((sum, value) => sum + value.size, 0) > maximum) throw new Error("PB candidate set exceeds maxSourceBytes; increase the explicit reader budget");
        const key = physicalKey(revisions);
        let reused = false;
        if (!control.forceRefresh && preparedState?.key === key) reused = true;
        else preparedState = { key, paths: revisions, prepared: prepareLocalPbFileCandidates(candidates, { ...options.pbReaderOptions, sourceFlavor: source, isCancelled: control.isCancelled }) };
        const state = preparedState!;
        const preparationMs = performance.now() - started;
        const available = state.prepared.candidates.filter(item => item.reader);
        const failures = state.prepared.candidates.filter(item => item.error).map(item => `pb_${item.candidate}_${item.error!.code}: ${item.error!.message}`);
        if (!available.length) throw new Error(`PB candidate authentication failed: ${failures.join("; ")}`);
        const origin = { ...conversation, rolloutPath: candidates[0].filePath, canonicalId: id };
        const revision = hostCorpusDigest(["host-pb/v1", source, id, key, state.prepared.sourceRevision]);
        let snapshot: HostCorpusSnapshot;
        if (state.full) snapshot = { ...state.full, timings: { ...state.full.timings, totalMs: performance.now() - started, preparationMs, preparedReused: 1, decodedSteps: 0 } };
        else if (!request || available.length > 1 || (request.startRound || 1) > 1) {
            const selected = comparePbCandidates(available.map(item => item.reader!.read(undefined, { isCancelled: control.isCancelled })));
            const warnings = [...failures, ...selected.diagnostics.map(item => `pb_${item.kind}: ${item.message}`)];
            const rounds = localPbResultToRounds(selected);
            snapshot = { conversation: origin, revision, rounds, roundNumbering: "absolute", totalRounds: rounds.length,
                sourceComplete: true, partial: Boolean(failures.length || selected.partial), warnings,
                sourceBytes: revisions.reduce((sum, value) => sum + value.size, 0),
                timings: { totalMs: performance.now() - started, preparationMs, preparedReused: Number(reused), decodedSteps: selected.metrics?.decodedSteps || 0, reusedSteps: selected.metrics?.reusedSteps || 0 } };
            state.full = snapshot;
        } else {
            const reader = available[0].reader!;
            const wanted = request.lastRounds || request.endRound || 10;
            let width = Math.min(reader.totalSteps, Math.max(64, wanted * 8));
            let selected: LocalPbReadResult;
            let rounds: ReturnType<typeof localPbResultToRounds>;
            for (;;) {
                assertHostReadActive(control);
                selected = reader.read(request.lastRounds ? { tailSteps: Math.max(1, width) } : { startStep: 0, endStepExclusive: width }, { isCancelled: control.isCancelled });
                rounds = localPbResultToRounds(selected);
                if (selected.coverage?.complete || rounds.length > wanted || width === reader.totalSteps) break;
                width = Math.min(reader.totalSteps, Math.max(width + 1, width * 2));
                await new Promise<void>(resolve => setImmediate(resolve));
            }
            const full = selected!.coverage?.complete === true;
            const tailRelative = Boolean(request.lastRounds && !full);
            const chosen = request.lastRounds ? rounds!.slice(-wanted) : rounds!.slice(0, wanted);
            const normalized = tailRelative ? chosen.map((round, index) => ({ ...round, roundIndex: index + 1 })) : chosen;
            const actualDiagnostics = selected!.diagnostics.filter(item => item.kind !== "partial" || !item.message.startsWith("PB step range ["));
            const warnings = [...failures, ...actualDiagnostics.map(item => `pb_${item.kind}: ${item.message}`), ...(!full ? ["pb_step_window_only"] : [])];
            const partial = failures.length > 0 || actualDiagnostics.some(item => item.kind === "unknown_variant" || item.kind === "partial");
            snapshot = { conversation: origin, revision, rounds: normalized, roundNumbering: tailRelative ? "relative" : "absolute",
                totalRounds: full ? rounds!.length : undefined, sourceComplete: full, partial, warnings,
                rangeComplete: !partial && (full || rounds!.length > wanted), sourceBytes: revisions.reduce((sum, value) => sum + value.size, 0),
                timings: { totalMs: performance.now() - started, preparationMs, preparedReused: Number(reused), decodedSteps: selected!.metrics?.decodedSteps || 0, reusedSteps: selected!.metrics?.reusedSteps || 0, totalSteps: reader.totalSteps } };
            if (full) state.full = { ...snapshot, rounds: rounds!, rangeComplete: !partial };
        }
        for (const item of revisions) await assertHostFileUnchanged(item, control.isCancelled);
        const currentCandidates = options.pbCandidates ? options.pbCandidates(source, id) : discoverLocalPbCandidates(source, id);
        if (JSON.stringify(currentCandidates.map(item => [item.kind, item.filePath])) !== JSON.stringify(candidates.map(item => [item.kind, item.filePath]))) throw new Error("PB candidate set changed during projection");
        assertHostReadActive(control);
        return snapshot;
    };
    const read = async (conversation: CorpusConversation, request: CorpusFastReadRequest | undefined, control: CorpusReadControl): Promise<HostCorpusSnapshot> => {
        const started = performance.now();
        assertHostReadActive(control);
        if (options.pbCandidates) return readPb(conversation, request, control);
        if (source === "antigravity") {
            const id = conversation.canonicalId || conversation.id;
            const origin = (await listAntigravityLocalConversations({ conversationIds: [id], limit: 1, isCancelled: control.isCancelled }))[0];
            if (origin?.root.kind === "gui" && origin.files.length && origin.files.every(file => file.kind === "pb")) return readPb(conversation, request, control);
            if (!control.forceRefresh && antigravityFull?.conversation?.id === conversation.id) {
                const { fingerprintAntigravityLocalConversation } = await import("./antigravity-local-history.js");
                const fingerprint = await fingerprintAntigravityLocalConversation(id, { maxBytes: options.maxSourceBytes, isCancelled: control.isCancelled });
                if (fingerprint?.revision === antigravityFull.revision) return { ...antigravityFull,
                    timings: { ...antigravityFull.timings, totalMs: performance.now() - started, preparedReused: 1 } };
            }
            const local = await loadAntigravityLocalConversation(conversation.canonicalId || conversation.id, {
                maxBytes: options.maxSourceBytes, pbReaderOptions: options.pbReaderOptions, isCancelled: control.isCancelled,
            });
            if (!local) throw new Error(`No Antigravity local history source for ${conversation.id}`);
            const snapshot: HostCorpusSnapshot = { conversation: { ...conversation, canonicalId: local.metadata.id, sourceKind: local.sourceKind, rolloutPath: local.metadata.sourcePath,
                title: local.metadata.title, workspace: local.metadata.workspace, parentConversationId: local.metadata.parentConversationId,
                isChildThread: local.metadata.isChildThread }, revision: local.fingerprint.revision!, rounds: local.rounds, roundNumbering: "absolute",
                totalRounds: local.rounds.length, sourceComplete: local.sourceComplete, rangeComplete: !local.partial,
                partial: local.partial, warnings: local.sourceDiagnostics.map(diagnostic => `${diagnostic.code}: ${diagnostic.message}`),
                sourceBytes: local.timings.sourceBytes, timings: { ...local.timings, totalMs: performance.now() - started } };
            antigravityFull = snapshot;
            return snapshot;
        }
        const ownedIdentityCache = options.devinOptions?.identityCache ? undefined : new DevinIdentityCache();
        const physicalWindow = Boolean(request?.lastRounds && conversation.sourceKind === "devin-desktop"
            && /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu.test(conversation.canonicalId || conversation.id));
        const child = splitDevinSubagentId(conversation.canonicalId || conversation.id);
        const physicalCliWindow = Boolean(conversation.sourceKind === "devin-cli");
        const devinOptions = { ...options.devinOptions, identityCache: options.devinOptions?.identityCache || ownedIdentityCache,
            deadlineMs: options.devinOptions?.deadlineMs ?? Date.now() + (request ? 30000 : 120000),
            ...(physicalWindow || physicalCliWindow ? { identityMode: "physical" as const,
                physicalSourceKind: physicalWindow ? "devin-desktop" as const : "devin-cli" as const } : {}),
            isCancelled: control.isCancelled };
        try {
        const summary = await resolveDevinConversation(child?.parentId || conversation.canonicalId || conversation.id, devinOptions);
        if (!summary) return readPb(conversation, request, control);
        const identityResolvedAt = performance.now();
        const paths = [summary.sourcePath, ...summary.desktopPaths];
        const before = physicalCliWindow ? [] : await sqliteSources(paths, control);
        const sourceVerifiedAt = performance.now();
        let devin;
        try {
            devin = await readDevinConversation(conversation.canonicalId || conversation.id, {
                ...devinOptions, link: "reference", materializeAttachments: true,
                ...(child ? { childDiscoveryOnly: true } : {}),
                ...(!child ? { messageRoles: request?.messageRoles ?? control.messageRoles ?? ["user", "assistant"] } : {}),
                roundRange: request && !child && !physicalWindow ? request.lastRounds ? { tailRounds: request.lastRounds } : { startRound: request.startRound || 1, endRound: request.endRound } : undefined,
            });
        } catch (error) {
            if (!request || (error as { code?: string }).code !== "DEVIN_RANGE_UNAVAILABLE") throw error;
            devin = await readDevinConversation(conversation.canonicalId || conversation.id, { ...devinOptions, link: "reference", materializeAttachments: true });
        }
        if (!devin) throw new Error("Devin source changed during range lookup");
        for (const item of before) await assertHostFileUnchanged(item, control.isCancelled);
        for (const filename of physicalCliWindow ? [] : paths) {
            const walPath = await fs.realpath(`${filename}-wal`).catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; });
            if (Boolean(walPath) !== before.some(item => item.path === walPath)) throw new Error("Devin WAL source set changed during projection");
        }
        const raw = devin.raw;
        if (physicalCliWindow && await devinOptions.identityCache!.version(paths, new ReadBudget(devinOptions)) !== raw.sourceEvidence?.validationRevision) {
            throw new Error("Devin SQLite source changed during window projection");
        }
        const expectedPaths = [...new Set(await Promise.all(paths.map(filename => fs.realpath(filename))))].sort();
        const actualPaths = [...new Set(await Promise.all([raw.summary.sourcePath, ...raw.summary.desktopPaths].map(filename => fs.realpath(filename))))].sort();
        if ((child ? raw.summary.parentConversationId : raw.summary.canonicalId) !== summary.canonicalId
            || JSON.stringify(expectedPaths) !== JSON.stringify(actualPaths)) {
            throw new Error("Devin identity source set changed during projection");
        }
        const coverage = child ? undefined : raw.coverage;
        const nonBodyWarnings = new Set(["DEVIN_RANGE_MAIN_CHAIN_ONLY", ...(physicalCliWindow ? ["DEVIN_ALIAS_VERIFICATION_PENDING"] : [])]);
        const partial = raw.partial && raw.warnings.some(warning => !nonBodyWarnings.has(warning));
        const origin: CorpusConversation = { ...conversation, id: raw.summary.canonicalId, canonicalId: raw.summary.canonicalId, aliases: raw.summary.aliases,
            title: raw.summary.title, workspace: raw.summary.cwd || conversation.workspace, sourceKind: raw.summary.sourceKind, sourceWarnings: raw.summary.warnings, rolloutPath: raw.summary.sourcePath,
            parentConversationId: raw.summary.parentConversationId, isChildThread: raw.summary.isChildThread };
        const revision = physicalCliWindow
            ? hostCorpusDigest(["host-devin-window/v1", DEVIN_NORMALIZATION_VERSION, raw.summary.canonicalId,
                raw.sourceEvidence?.sources?.map(item => [item.sourcePath, item.identity]), raw.nodes, raw.compactions])
            : hostCorpusDigest(["host-devin/v1", DEVIN_NORMALIZATION_VERSION, raw.summary.canonicalId, physicalKey(before)]);
        if (!child && raw.summary.sourceKind === "devin-cli" && raw.summary.sessionId === raw.summary.canonicalId
            && raw.summary.identityStatus !== "pending" && raw.summary.desktopPaths.length
            && ((raw.summary.identityEvidence === "client-message-id" && raw.summary.matchedMessageIds > 0)
                || (raw.summary.identityEvidence === "tool-call-id" && (raw.summary.matchedToolCallIds || 0) >= 2))) {
            verifiedIdentities.set(origin, { authority: "devin-sqlite", source: "windsurf", canonicalId: origin.id,
                aliases: [...raw.summary.aliases], sourceRevision: revision,
                evidence: hostCorpusDigest([raw.summary.identityEvidence, raw.summary.matchedMessageIds, raw.summary.matchedToolCallIds,
                    [...raw.summary.aliases].sort(), physicalKey(before)]) });
        }
        const relativeWindow = physicalWindow || Boolean(raw.relativeCoverage);
        const totalRounds = relativeWindow ? undefined : coverage?.totalRounds ?? devin.rounds.at(-1)?.roundIndex ?? 0;
        return { conversation: origin, revision,
            rounds: devin.rounds, roundNumbering: relativeWindow ? "relative" : "absolute", totalRounds, sourceComplete: !relativeWindow && (!coverage || coverage.complete),
            rangeComplete: raw.relativeCoverage?.requestedRangeComplete ?? (!physicalWindow && !partial && (!coverage || (coverage.startRound === (request?.lastRounds ? Math.max(1, totalRounds! - request.lastRounds + 1) : request?.startRound || 1) && coverage.endRound >= Math.min(request?.endRound || totalRounds!, totalRounds!)))),
            partial, warnings: raw.warnings, sourceBytes: physicalCliWindow ? raw.readMetrics?.bytesRead ?? 0 : before.reduce((sum, item) => sum + item.size, 0),
            timings: { ...(raw.readMetrics || {}), identityCacheHit: Number(raw.readMetrics?.identityCacheHit),
                bodyTotalMs: raw.readMetrics?.totalMs || 0, identityResolutionMs: identityResolvedAt - started,
                sourceVerificationMs: sourceVerifiedAt - identityResolvedAt, sourceVerificationBytes: before.reduce((sum, item) => sum + item.size, 0),
                totalMs: performance.now() - started } };
        } finally { ownedIdentityCache?.close(); }
    };
    return { read };
}
