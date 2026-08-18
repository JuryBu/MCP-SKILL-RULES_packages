import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const cache = await import("../src/conversation-source-cache.ts");

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-conversation-source-cache-"));
const key = { source: "codex", conversationId: "conversation-unicode" };
const fingerprintA = { path: "C:/rollouts/conversation.jsonl", size: 17, mtime: "2026-08-03T20:00:00.000Z", revision: "a" };
const fingerprintB = { ...fingerprintA, mtime: "2026-08-03T20:00:01.000Z", revision: "b" };
const fingerprintC = { ...fingerprintB, revision: "c" };
const fingerprintD = { ...fingerprintC, revision: "d" };
const cacheLeaseEnvironmentNames = [
    "MEMORY_STORE_CONVERSATION_CACHE_BUILD_LEASE_TIMEOUT_MS",
    "MEMORY_STORE_CONVERSATION_CACHE_BUILD_LEASE_STALE_MS",
];
const originalCacheLeaseEnvironment = new Map(cacheLeaseEnvironmentNames.map(name => [name, process.env[name]]));

interface Snapshot {
    revision: string;
    title: string;
}

interface Round {
    roundIndex: number;
    text: string;
}

function buildPayload(revision: string) {
    return {
        snapshot: { revision, title: "你好 😀" },
        rounds: [
            { roundIndex: 1, text: "第一轮，Unicode 😀 你好" },
            { roundIndex: 2, text: "second" },
            { roundIndex: 3, text: "第三轮" },
        ],
    };
}

try {
    for (const name of cacheLeaseEnvironmentNames) {
        for (const value of ["not-a-number", "Infinity", "-1", "0", "1.5"]) {
            process.env[name] = value;
            const resolved = cache.readFiniteIntegerEnv(name, 180_000);
            assert.equal(resolved, 180_000, `${name}=${value} must use its stable fallback`);
            assert.ok(Number.isFinite(resolved), `${name}=${value} must not produce NaN or Infinity`);
        }
        process.env[name] = "1";
        assert.equal(cache.readFiniteIntegerEnv(name, 180_000), 1, `${name}=1 remains a valid positive integer before its local minimum clamp`);
    }
    for (const name of cacheLeaseEnvironmentNames) {
        const original = originalCacheLeaseEnvironment.get(name);
        if (original === undefined) delete process.env[name];
        else process.env[name] = original;
    }
    cache.resetConversationSourceCacheForTests();
    cache.setConversationSourceCacheDataRootForTests(dataRoot);

    assert.equal(cache.CONVERSATION_SOURCE_CACHE_FORMAT, "conversation-source-cache/v3");
    const legacyFormatKey = { source: "codex", conversationId: "legacy-format" };
    const legacyFormatInitial = await cache.readOrBuild({
        key: legacyFormatKey,
        fingerprint: fingerprintA,
        build: () => buildPayload("legacy-v2-initial"),
        getRoundNumber: (round) => round.roundIndex,
    });
    const legacyFormatDirectory = cache.getConversationSourceCacheEntryDirectory(legacyFormatKey);
    const legacyManifestPath = path.join(legacyFormatDirectory, "manifest.json");
    const legacyManifest = JSON.parse(fs.readFileSync(legacyManifestPath, "utf8"));
    legacyManifest.format = "conversation-source-cache/v1";
    fs.writeFileSync(legacyManifestPath, JSON.stringify(legacyManifest), "utf8");
    let legacyRebuildCount = 0;
    const migratedLegacyFormat = await cache.readOrBuild({
        key: legacyFormatKey,
        fingerprint: fingerprintA,
        build: () => {
            legacyRebuildCount += 1;
            return buildPayload("legacy-v1-rebuilt");
        },
        getRoundNumber: (round) => round.roundIndex,
    });
    assert.equal(legacyRebuildCount, 1, "v1 manifest 必须失效并触发一次规范化重建");
    assert.equal(migratedLegacyFormat.cacheState, "built");
    assert.notEqual(migratedLegacyFormat.generation, legacyFormatInitial.generation);
    assert.equal(migratedLegacyFormat.snapshot.revision, "legacy-v1-rebuilt");

    let buildCount = 0;
    const concurrent = await Promise.all(Array.from({ length: 12 }, () => cache.readOrBuild({
        key,
        fingerprint: fingerprintA,
        build: async () => {
            buildCount += 1;
            await new Promise((resolve) => setTimeout(resolve, 20));
            return buildPayload("a");
        },
        getRoundNumber: (round) => round.roundIndex,
    })));
    assert.equal(buildCount, 1, "同键并发必须只在 builder 之前登记一个 single-flight");
    assert.ok(concurrent.every((entry) => entry.snapshot.revision === "a" && entry.cacheState === "built"));
    const initialGeneration = concurrent[0].generation;
    await cache.pinConversationSourceCacheGeneration({
        key,
        generation: initialGeneration,
        fingerprint: fingerprintA,
        ownerId: "record-task-pins-initial-generation",
    });

    const hit = await cache.readOrBuild<Snapshot, Round>({
        key,
        fingerprint: fingerprintA,
        build: () => {
            throw new Error("cache hit must not build");
        },
    });
    assert.equal(hit.cacheState, "hit");
    assert.equal(hit.snapshot.revision, "a");

    const refreshed = await cache.readOrBuild({
        key,
        fingerprint: fingerprintA,
        refresh: true,
        build: () => buildPayload("a-refresh"),
        getRoundNumber: (round) => round.roundIndex,
    });
    assert.equal(refreshed.cacheState, "built", "显式 refresh 必须重建同指纹缓存");
    assert.equal(refreshed.snapshot.revision, "a-refresh");

    const rebuilt = await cache.readOrBuild({
        key,
        fingerprint: fingerprintB,
        build: () => buildPayload("b"),
        getRoundNumber: (round) => round.roundIndex,
    });
    assert.equal(rebuilt.cacheState, "built", "mtime/revision 变化必须重建");
    assert.equal(rebuilt.snapshot.revision, "b");

    const secondRebuild = await cache.readOrBuild({
        key,
        fingerprint: fingerprintC,
        build: () => buildPayload("c"),
        getRoundNumber: (round) => round.roundIndex,
    });
    assert.equal(secondRebuild.snapshot.revision, "c");
    const entryDirectory = cache.getConversationSourceCacheEntryDirectory(key);
    assert.equal(fs.readdirSync(entryDirectory).filter((file) => file.startsWith("snapshot.") && file.endsWith(".json")).length, 3, "除当前/上一代外，被任务 pin 的 generation 必须保留");
    const pinnedInitial = cache.readCacheOnly<Snapshot>({ key, generation: initialGeneration, expectedFingerprint: fingerprintA });
    assert.equal(pinnedInitial?.snapshot.revision, "a", "按 generation 精读必须在后续多次发布后仍命中被 pin 的版本");
    await cache.releaseConversationSourceCacheGenerationPin({ key, ownerId: "record-task-pins-initial-generation" });
    assert.equal(fs.readdirSync(entryDirectory).filter((file) => file.startsWith("snapshot.") && file.endsWith(".json")).length, 2, "释放 pin 后应恢复当前/上一代保留策略");

    let releaseSlowBuild!: () => void;
    const slowBuildGate = new Promise<void>((resolve) => {
        releaseSlowBuild = resolve;
    });
    let concurrentBuilds = 0;
    let maxConcurrentBuilds = 0;
    const slowOldFingerprint = cache.readOrBuild({
        key,
        fingerprint: fingerprintC,
        refresh: true,
        build: async () => {
            concurrentBuilds += 1;
            maxConcurrentBuilds = Math.max(maxConcurrentBuilds, concurrentBuilds);
            await slowBuildGate;
            concurrentBuilds -= 1;
            return buildPayload("c-refresh");
        },
        getRoundNumber: (round) => round.roundIndex,
    });
    const newerFingerprintWaiter = cache.readOrBuild({
        key,
        fingerprint: fingerprintD,
        build: async () => {
            concurrentBuilds += 1;
            maxConcurrentBuilds = Math.max(maxConcurrentBuilds, concurrentBuilds);
            concurrentBuilds -= 1;
            return buildPayload("d");
        },
        getRoundNumber: (round) => round.roundIndex,
    });
    releaseSlowBuild();
    assert.equal((await slowOldFingerprint).snapshot.revision, "c-refresh");
    assert.equal((await newerFingerprintWaiter).snapshot.revision, "d", "等待同键旧构建的调用必须按自己的新指纹串行续建");
    assert.equal(maxConcurrentBuilds, 1, "同一对话即使指纹变化也不能并发解析源文件");

    const stale = await cache.readOrBuild<Snapshot, Round>({
        key,
        fingerprint: { ...fingerprintD, revision: "e" },
        build: () => {
            throw new Error("source unavailable");
        },
    });
    assert.equal(stale.cacheState, "stale", "新构建失败要继续返回上一份完整快照");
    assert.equal(stale.snapshot.revision, "d");
    assert.equal(stale.buildFailure?.message, "source unavailable");

    const cacheOnly = cache.readCacheOnly<Snapshot>({ key, expectedFingerprint: fingerprintD });
    assert.equal(cacheOnly?.snapshot.revision, "d", "cache-only 不得调用 builder");

    const firstRound = cache.readCachedRounds<{ roundIndex: number; text: string }>({ key, expectedFingerprint: fingerprintD, startRound: 1, endRound: 1 });
    assert.deepEqual(firstRound?.rounds, [{ roundIndex: 1, text: "第一轮，Unicode 😀 你好" }], "范围读取必须按 UTF-8 byte offset 保留 Unicode");
    const secondRound = cache.readCachedRounds<{ roundIndex: number; text: string }>({ key, startRound: 2, endRound: 2 });
    assert.deepEqual(secondRound?.rounds, [{ roundIndex: 2, text: "second" }]);

    const spoolKey = { source: "codex", conversationId: "conversation-streamed-spool" };
    const spool = cache.createConversationSourceCacheRoundSpool<Round>({
        key: spoolKey,
        getRoundNumber: (round) => round.roundIndex,
        projectRecordRound: (round) => ({ roundIndex: round.roundIndex, text: round.text }),
    });
    spool.append({ roundIndex: 1, text: "spooled 😀" });
    spool.append({ roundIndex: 2, text: "second spooled round" });
    const spooled = await cache.readOrBuild<Snapshot, Round>({
        key: spoolKey,
        fingerprint: fingerprintA,
        build: () => ({
            snapshot: { revision: "spooled", title: "streamed cache" },
            preparedRounds: spool.finish(),
        }),
        projectRecordRound: (round) => ({ roundIndex: round.roundIndex, text: round.text }),
    });
    assert.equal(spooled.roundCount, 2);
    assert.deepEqual(
        cache.readCachedRounds<Round>({ key: spoolKey, startRound: 1, endRound: 1 })?.rounds,
        [{ roundIndex: 1, text: "spooled 😀" }],
        "流式 spool 发布后仍须支持 Unicode byte offset 范围读取",
    );
    const spoolDirectory = cache.getConversationSourceCacheEntryDirectory(spoolKey);
    const spoolManifest = JSON.parse(fs.readFileSync(path.join(spoolDirectory, "manifest.json"), "utf8"));
    assert.deepEqual(
        cache.readConversationSourceCacheRecordProjection<{ roundIndex: number; text: string }>({ key: spoolKey })?.projections,
        [
            { roundIndex: 1, text: "spooled 😀" },
            { roundIndex: 2, text: "second spooled round" },
        ],
        "同一次 fetch 构建必须发布可独立校验的紧凑 Record 投影",
    );
    assert.equal(cache.readConversationSourceCacheRecordProjection({ key }), null, "旧 generation 没有投影时必须保持可读并明确返回 null");
    const projectionPath = path.join(spoolDirectory, spoolManifest.files.recordProjection.file);
    const originalProjection = fs.readFileSync(projectionPath);
    const sameSizeCorruption = Buffer.from(originalProjection);
    sameSizeCorruption[Math.max(0, sameSizeCorruption.length - 2)] ^= 1;
    fs.writeFileSync(projectionPath, sameSizeCorruption);
    await cache.pinConversationSourceCacheGeneration({
        key: spoolKey,
        generation: spooled.generation,
        fingerprint: fingerprintA,
        ownerId: "pin-validates-publication-without-rehashing-large-files",
    });
    assert.equal(cache.readConversationSourceCacheRecordProjection({ key: spoolKey }), null, "实际读取仍必须发现同尺寸内容损坏");
    await cache.releaseConversationSourceCacheGenerationPin({
        key: spoolKey,
        ownerId: "pin-validates-publication-without-rehashing-large-files",
    });
    fs.writeFileSync(projectionPath, originalProjection);
    fs.writeFileSync(path.join(spoolDirectory, spoolManifest.files.recordProjection.file), "tampered\n", "utf8");
    assert.equal(cache.readConversationSourceCacheRecordProjection({ key: spoolKey }), null, "Record 投影损坏必须被 SHA256 校验拒绝");
    await assert.rejects(() => cache.pinConversationSourceCacheGeneration({
        key: spoolKey,
        generation: spooled.generation,
        fingerprint: fingerprintA,
        ownerId: "must-not-pin-corrupt-projection",
    }), /incomplete or corrupted/u, "声明了 Record 投影的 generation 必须把投影纳入 pin 完整性校验");
    fs.rmSync(path.join(spoolDirectory, spoolManifest.files.rounds.file));
    assert.equal(cache.readCachedRounds({ key: spoolKey, startRound: 1, endRound: 1 }), null, "rounds 文件缺失必须返回 null 并进入损坏诊断");

    const manifest = JSON.parse(fs.readFileSync(path.join(entryDirectory, "manifest.json"), "utf8"));
    fs.writeFileSync(path.join(entryDirectory, manifest.files.rounds.file), "tampered\n", "utf8");
    assert.equal(cache.readCachedRounds({ key, startRound: 1, endRound: 1 }), null, "范围读取必须发现单行 SHA256 损坏");

    fs.writeFileSync(path.join(entryDirectory, manifest.files.snapshot.file), "{}", "utf8");
    assert.equal(cache.readCached({ key }), null, "完整快照读取必须发现 manifest SHA256 损坏");

    const postLinkFailureKey = { source: "codex", conversationId: "post-link-open-failure" };
    const originalOpen = fs.promises.open;
    Object.defineProperty(fs.promises, "open", {
        configurable: true,
        value: async (filePath: fs.PathLike, flags: string | number, ...rest: unknown[]) => {
            if (String(filePath).endsWith("build.lock") && flags === "r+") throw new Error("injected post-link open failure");
            return await (originalOpen as (...args: unknown[]) => Promise<unknown>)(filePath, flags, ...rest);
        },
    });
    try {
        await assert.rejects(() => cache.readOrBuild<Snapshot, Round>({
            key: postLinkFailureKey,
            fingerprint: fingerprintA,
            getRoundNumber: round => round.roundIndex,
            build: async () => buildPayload("post-link-failure"),
        }), /injected post-link open failure/u);
    } finally {
        Object.defineProperty(fs.promises, "open", { configurable: true, value: originalOpen });
    }
    assert.equal(
        fs.existsSync(path.join(cache.getConversationSourceCacheEntryDirectory(postLinkFailureKey), "build.lock")),
        false,
        "post-link 初始化失败不得遗留由当前 token 创建的正式 build.lock",
    );

    const closeFailureKey = { source: "codex", conversationId: "post-link-close-failure" };
    Object.defineProperty(fs.promises, "open", {
        configurable: true,
        value: async (filePath: fs.PathLike, flags: string | number, ...rest: unknown[]) => {
            const handle = await (originalOpen as (...args: unknown[]) => Promise<Awaited<ReturnType<typeof fs.promises.open>>>)(filePath, flags, ...rest);
            if (String(filePath).endsWith("build.lock") && flags === "r+") {
                const originalClose = handle.close.bind(handle);
                Object.defineProperty(handle, "close", {
                    configurable: true,
                    value: async () => {
                        await originalClose();
                        throw new Error("injected post-link close failure");
                    },
                });
            }
            return handle;
        },
    });
    try {
        await assert.rejects(() => cache.readOrBuild<Snapshot, Round>({
            key: closeFailureKey,
            fingerprint: fingerprintA,
            getRoundNumber: round => round.roundIndex,
            build: async () => buildPayload("post-link-close-failure"),
        }), /injected post-link close failure/u);
    } finally {
        Object.defineProperty(fs.promises, "open", { configurable: true, value: originalOpen });
    }
    assert.equal(
        fs.existsSync(path.join(cache.getConversationSourceCacheEntryDirectory(closeFailureKey), "build.lock")),
        false,
        "post-link close 失败也必须按 token 回收正式 build.lock",
    );

    const preLinkCloseFailureKey = { source: "codex", conversationId: "pre-link-close-failure" };
    Object.defineProperty(fs.promises, "open", {
        configurable: true,
        value: async (filePath: fs.PathLike, flags: string | number, ...rest: unknown[]) => {
            const handle = await (originalOpen as (...args: unknown[]) => Promise<Awaited<ReturnType<typeof fs.promises.open>>>)(filePath, flags, ...rest);
            if (String(filePath).includes(`.build-lock-${process.pid}-`) && String(filePath).endsWith(".tmp") && flags === "wx") {
                const originalClose = handle.close.bind(handle);
                Object.defineProperty(handle, "close", {
                    configurable: true,
                    value: async () => {
                        await originalClose();
                        throw new Error("injected pre-link close failure");
                    },
                });
            }
            return handle;
        },
    });
    try {
        await assert.rejects(() => cache.readOrBuild<Snapshot, Round>({
            key: preLinkCloseFailureKey,
            fingerprint: fingerprintA,
            getRoundNumber: round => round.roundIndex,
            build: async () => buildPayload("pre-link-close-failure"),
        }), /injected pre-link close failure/u);
    } finally {
        Object.defineProperty(fs.promises, "open", { configurable: true, value: originalOpen });
    }
    const preLinkDirectory = cache.getConversationSourceCacheEntryDirectory(preLinkCloseFailureKey);
    assert.equal(fs.existsSync(path.join(preLinkDirectory, "build.lock")), false, "pre-link close 失败不得形成正式 build.lock");
    assert.deepEqual(
        fs.existsSync(preLinkDirectory) ? fs.readdirSync(preLinkDirectory).filter(name => name.startsWith(`.build-lock-${process.pid}-`)) : [],
        [],
        "pre-link close 失败不得遗留当前进程的临时 lease 文件",
    );

    const releaseRmFailureKey = { source: "codex", conversationId: "release-rm-retry" };
    const originalRm = fs.promises.rm;
    let releaseRmFailureInjected = false;
    Object.defineProperty(fs.promises, "rm", {
        configurable: true,
        value: async (filePath: fs.PathLike, options?: fs.RmOptions) => {
            if (!releaseRmFailureInjected && String(filePath).endsWith("build.lock")) {
                releaseRmFailureInjected = true;
                const error = new Error("injected build lease rm failure") as NodeJS.ErrnoException;
                error.code = "EPERM";
                throw error;
            }
            return await originalRm(filePath, options);
        },
    });
    try {
        const rmRetried = await cache.readOrBuild<Snapshot, Round>({
            key: releaseRmFailureKey,
            fingerprint: fingerprintA,
            getRoundNumber: round => round.roundIndex,
            build: async () => buildPayload("release-rm-retry"),
        });
        assert.equal(rmRetried.cacheState, "built");
    } finally {
        Object.defineProperty(fs.promises, "rm", { configurable: true, value: originalRm });
    }
    assert.equal(releaseRmFailureInjected, true, "release 测试必须命中一次 build.lock 删除失败");
    assert.equal(
        fs.existsSync(path.join(cache.getConversationSourceCacheEntryDirectory(releaseRmFailureKey), "build.lock")),
        false,
        "短暂 rm 失败后必须重试并释放正式 build.lock",
    );

    const persistentRmFailureKey = { source: "codex", conversationId: "release-rm-quarantine" };
    let persistentRmFailures = 0;
    Object.defineProperty(fs.promises, "rm", {
        configurable: true,
        value: async (filePath: fs.PathLike, options?: fs.RmOptions) => {
            if (String(filePath).endsWith("build.lock")) {
                persistentRmFailures += 1;
                const error = new Error("injected persistent build lease rm failure") as NodeJS.ErrnoException;
                error.code = "EPERM";
                throw error;
            }
            return await originalRm(filePath, options);
        },
    });
    try {
        const quarantinedRelease = await cache.readOrBuild<Snapshot, Round>({
            key: persistentRmFailureKey,
            fingerprint: fingerprintA,
            getRoundNumber: round => round.roundIndex,
            build: async () => buildPayload("release-rm-quarantine"),
        });
        assert.equal(quarantinedRelease.cacheState, "built");
    } finally {
        Object.defineProperty(fs.promises, "rm", { configurable: true, value: originalRm });
    }
    const persistentRmDirectory = cache.getConversationSourceCacheEntryDirectory(persistentRmFailureKey);
    assert.equal(persistentRmFailures, 3, "持续 rm 失败必须先完成三次有限重试");
    assert.equal(fs.existsSync(path.join(persistentRmDirectory, "build.lock")), false, "持续 rm 失败后必须原子隔离正式 build.lock，不能阻塞后续构建");
    assert.deepEqual(fs.readdirSync(persistentRmDirectory).filter(name => name.startsWith("build.lock.released-")), [], "可删除的 release 隔离文件应立即清理");

    const diagnostics = cache.getConversationSourceCacheDiagnostics();
    assert.ok(diagnostics.corruptions >= 2, "损坏检测必须进入诊断统计");
    assert.equal(diagnostics.buildsStarted, 12, "缓存初建、v1 格式迁移重建、显式刷新、三次版本构建、竞态串行续建、失败回退、流式 spool 与两种 release 恢复都应可诊断");
    assert.equal(diagnostics.pinsCreated, 2);
    assert.equal(diagnostics.pinsReleased, 2);

    console.log("✅ conversation-source-cache 通过：single-flight、投影发布/校验、旧快照回退、范围 offset、Unicode、两代保留和 cache-only");
} finally {
    for (const name of cacheLeaseEnvironmentNames) {
        const original = originalCacheLeaseEnvironment.get(name);
        if (original === undefined) delete process.env[name];
        else process.env[name] = original;
    }
    cache.resetConversationSourceCacheForTests();
    fs.rmSync(dataRoot, { recursive: true, force: true });
}
