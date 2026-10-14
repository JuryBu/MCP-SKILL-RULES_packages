import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const [fixturePath, runId, scenario] = process.argv.slice(2);
if (!fixturePath || !/^inner-version-0100-[a-z0-9-]+$/u.test(runId ?? "")
  || !["quota-handoff", "tool-native-gate", "version-refusals"].includes(scenario)) throw new Error("INVALID_NATIVE_VERSION_TEST_ARGUMENTS");
const testRoot = path.join(os.tmpdir(), "napcat-hot-switch-20261010");
const fixtureRoot = path.join(testRoot, `${runId}-fixture`);
if (fs.existsSync(fixtureRoot)) throw new Error("EXISTING_ATTEMPT");
fs.mkdirSync(fixtureRoot);
const sourceRoot = fileURLToPath(new URL("../src/", import.meta.url));
const digest = value => crypto.createHash("sha256").update(value).digest("hex");
let fixture = fs.readFileSync(fixturePath, "utf8");
const originalFixtureSha256 = digest(fixture);
if (originalFixtureSha256 !== "583b022c813ce2c18813b26ab3cffa5220a2b8e6ff89fe712740993a57eeb035") throw new Error("UNREVIEWED_NATIVE_FIXTURE");
function replaceOnce(original, replacement) {
  if (fixture.split(original).length !== 2) throw new Error(`FIXTURE_PATTERN_CHANGED:${original.slice(0, 80)}`);
  fixture = fixture.replace(original, replacement);
}
const sourceDeclaration = fixture.match(/^const sourceRoot = '[^\r\n']+';$/mu)?.[0];
if (!sourceDeclaration) throw new Error("NATIVE_SOURCE_DECLARATION_CHANGED");
replaceOnce(sourceDeclaration, `const sourceRoot = ${JSON.stringify(sourceRoot)};`);
replaceOnce("/^inner-runner-native-[a-z0-9-]+$/", "/^inner-version-0100-[a-z0-9-]+$/");
replaceOnce("'checkpoint-write-failure'].includes(scenario)", "'checkpoint-write-failure', 'version-refusals'].includes(scenario)");
replaceOnce("collectSource('codex-model-stream-proxy-runner.mjs');", `collectSource('codex-model-stream-proxy-runner.mjs');
const targetRoot = path.join(runRoot, 'target-build');
fs.mkdirSync(targetRoot);
const oldDiagnostic = 'Three distinct turns ended without model text or completed tool work. The proxy stopped native retry for this turn.';
const newDiagnostic = oldDiagnostic + ' COMPAT_V2_DIAGNOSIS: the cross-turn recovery budget is exhausted; completed model or tool progress clears the empty-turn count.';
const originalCore = fs.readFileSync(corePath, 'utf8');
if (originalCore.split(oldDiagnostic).length !== 3) throw new Error('CORE_DIAGNOSTIC_PATTERN_CHANGED');
for (const entry of manifest) {
  const destination = path.join(targetRoot, entry.relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const content = entry.relative === 'codex-model-stream-proxy.mjs'
    ? Buffer.from(originalCore.split(oldDiagnostic).join(newDiagnostic))
    : fs.readFileSync(path.join(sourceRoot, entry.relative));
  fs.writeFileSync(destination, content);
}
const targetManifest = manifest.map(entry => {
  const content = fs.readFileSync(path.join(targetRoot, entry.relative));
  return { relative: entry.relative, sha256: digest(content), bytes: content.length };
});
const compatibilityManifest = { schemaVersion: 1, edges: [{
  source: { core: digest(fs.readFileSync(corePath)), helper: digest(fs.readFileSync(path.join(sourceRoot, 'thread-recovery-handoff.mjs'))) },
  target: { core: digest(fs.readFileSync(path.join(targetRoot, 'codex-model-stream-proxy.mjs'))), helper: digest(fs.readFileSync(path.join(targetRoot, 'thread-recovery-handoff.mjs'))) },
  checkpointSchemaVersion: 1, stateSchemaVersion: 1, stateSemantics: 'state-v1'
}] };
const fixedCompatibility = { manifest: compatibilityManifest, sha256: digest(JSON.stringify(compatibilityManifest)) };
const targetHashes = compatibilityManifest.edges[0].target;
const wrongTargetRoot = path.join(runRoot, 'wrong-target-build');
let wrongTargetManifest = [];
let wrongTargetHashes;
if (scenario === 'version-refusals') {
  fs.mkdirSync(wrongTargetRoot);
  for (const entry of targetManifest) {
    const destination = path.join(wrongTargetRoot, entry.relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const original = fs.readFileSync(path.join(targetRoot, entry.relative));
    const content = entry.relative === 'codex-model-stream-proxy.mjs'
      ? Buffer.from(original.toString('utf8').replaceAll('COMPAT_V2_DIAGNOSIS', 'COMPAT_V3_UNREVIEWED_DIAGNOSIS')) : original;
    fs.writeFileSync(destination, content);
    wrongTargetManifest.push({ relative: entry.relative, sha256: digest(content), bytes: content.length });
  }
  wrongTargetHashes = { core: digest(fs.readFileSync(path.join(wrongTargetRoot, 'codex-model-stream-proxy.mjs'))), helper: targetHashes.helper };
}
`);
replaceOnce("sourceManifest: manifest, coreSha256:", `sourceManifest: manifest, targetBuildManifest: targetManifest,
  wrongTargetBuildManifest: wrongTargetManifest, originalFixtureSha256: ${JSON.stringify(originalFixtureSha256)}, compatibility: fixedCompatibility,
  upgradeBehavior: { before: oldDiagnostic, after: newDiagnostic, changedSites: 2, recoveryPolicyChanged: false }, coreSha256:`);
replaceOnce("checkpointRoot: runRoot }) };", "checkpointRoot: runRoot, ...(label === 'new-strict' ? {} : { compatibility: fixedCompatibility }) }) };");
replaceOnce("let runnerPath = path.join(sourceRoot, 'codex-model-stream-proxy-runner.mjs');",
  "let runnerPath = path.join(label === 'old' ? sourceRoot : label === 'wrong-target' ? wrongTargetRoot : targetRoot, 'codex-model-stream-proxy-runner.mjs');");
replaceOnce("check(`${label}_same_core`, entry.ready.sourceHashes.core === result.coreSha256\n    && entry.ready.sourceHashes.helper === result.helperSha256 && entry.ready.sourceHashes.runner === result.runnerSha256,",
  "check(`${label}_actual_core`, entry.ready.sourceHashes.core === (label === 'old' ? result.coreSha256 : label === 'wrong-target' ? wrongTargetHashes.core : targetHashes.core)\n    && entry.ready.sourceHashes.helper === result.helperSha256 && entry.ready.sourceHashes.runner === result.runnerSha256,");
replaceOnce("const accepted = await ipc(candidate, 'acceptFile', { filePath: saved.filePath });\n    result.accepted = accepted;", `const strictCandidate = await runner('new-strict');
    let strictRefusal;
    try { await control(strictCandidate, 'accept', { threadId, fileName: path.basename(saved.filePath),
      sha256: saved.sha256, sourceInstanceToken: old.ready.instanceToken, compatibility: fixedCompatibility }); }
    catch (error) { strictRefusal = error.code; }
    check('different_bytes_default_strict_request_allowlist_rejected', strictRefusal === 'CHECKPOINT_IDENTITY_MISMATCH', { strictRefusal });
    await ipc(strictCandidate, 'shutdown');
    await waitUntil(() => strictCandidate.child.exitCode !== null, 10000, 'strict_candidate_exit');
    const accepted = await ipc(candidate, 'acceptFile', { filePath: saved.filePath });
    check('approved_exact_directed_version_edge', accepted.versionAcceptance.mode === 'compatible-version'
      && accepted.versionAcceptance.manifestSha256 === fixedCompatibility.sha256
      && candidate.ready.sourceHashes.core !== old.ready.sourceHashes.core, { accepted });
    result.accepted = accepted;`);
replaceOnce("check('third_routes_only_new_process', third.routes.every(entry => entry.pid === candidate.child.pid));",
  `check('third_routes_only_new_process', third.routes.every(entry => entry.pid === candidate.child.pid));
    check('upgraded_core_behavior_native_visible', JSON.stringify(third.completion).includes('COMPAT_V2_DIAGNOSIS')
      && JSON.stringify(third.errors).includes('COMPAT_V2_DIAGNOSIS'), { completion: third.completion, errors: third.errors });`);
replaceOnce("&& accepted.readPath === saved.filePath && accepted.pid !== old.child.pid && accepted.importedEntries >= 1,",
  "&& accepted.readPath === saved.filePath && candidate.child.pid !== old.child.pid && accepted.importedEntries >= 1,");
replaceOnce("const accepted = await ipc(candidate, 'acceptFile', { filePath: saved.filePath });\n    await activate(candidate, threadId, accepted);",
  `const accepted = await ipc(candidate, 'acceptFile', { filePath: saved.filePath });
    result.accepted = accepted;
    check('tool_completed_real_version_edge', accepted.versionAcceptance.mode === 'compatible-version'
      && candidate.ready.sourceHashes.core !== old.ready.sourceHashes.core, { accepted });
    await activate(candidate, threadId, accepted);`);
replaceOnce("} else await rollbackScenario(threadId, old);", `} else if (scenario === 'version-refusals') {
    const candidate = await runner('new');
    const snapshot = await prepare(threadId);
    const saved = checkpoint(snapshot);
    const originalEnvelope = JSON.parse(fs.readFileSync(saved.filePath, 'utf8'));
    result.refusals = [];
    const wrongTarget = await runner('wrong-target');
    let wrongTargetRefusal;
    try { await ipc(wrongTarget, 'acceptFile', { filePath: saved.filePath }); }
    catch (error) { wrongTargetRefusal = error.code; }
    result.wrongTargetRefusal = { observed: wrongTargetRefusal, sourceHashes: wrongTarget.ready.sourceHashes, pid: wrongTarget.child.pid };
    check('actual_unreviewed_target_core_rejected', wrongTargetRefusal === 'CHECKPOINT_VERSION_EDGE_NOT_ALLOWED'
      && wrongTarget.ready.sourceHashes.core !== targetHashes.core && selected === old, result.wrongTargetRefusal);
    const wrongTargetState = await peek(wrongTarget, threadId);
    check('actual_wrong_target_state_atomic', Object.values(wrongTargetState.state).every(entries => entries.length === 0));
    async function refuse(name, mutate, expected) {
      const envelope = structuredClone(originalEnvelope);
      mutate(envelope.payload);
      envelope.payload.snapshotSha256 = digest(JSON.stringify(envelope.payload.snapshot));
      envelope.signature = crypto.createHmac('sha256', Buffer.from(capability, 'hex')).update(JSON.stringify(envelope.payload)).digest('hex');
      const bytes = Buffer.from(JSON.stringify(envelope));
      const fileName = 'inner-runner-' + name + '.json';
      fs.writeFileSync(path.join(runRoot, fileName), bytes);
      let observed;
      try { await control(candidate, 'accept', { threadId, fileName, sha256: digest(bytes), sourceInstanceToken: old.ready.instanceToken }); }
      catch (error) { observed = error.code; }
      result.refusals.push({ name, expected, observed, fileName, fileSha256: digest(bytes) });
      check(name + '_rejected', observed === expected, { expected, observed });
      const untouched = await peek(candidate, threadId);
      check(name + '_target_state_atomic_old_selected', Object.values(untouched.state).every(entries => entries.length === 0) && selected === old);
    }
    await refuse('bad-manifest', payload => { payload.compatibilityManifestSha256 = '0'.repeat(64); }, 'CHECKPOINT_COMPATIBILITY_MANIFEST_MISMATCH');
    await refuse('unknown-source-core', payload => { payload.source.sourceHashes.core = '1'.repeat(64); }, 'CHECKPOINT_VERSION_EDGE_NOT_ALLOWED');
    await refuse('unknown-source-helper', payload => { payload.source.sourceHashes.helper = '2'.repeat(64); }, 'CHECKPOINT_VERSION_EDGE_NOT_ALLOWED');
    await refuse('checkpoint-v2', payload => { payload.schemaVersion = 2; }, 'CHECKPOINT_INCOMPATIBLE_STATE_FORMAT');
    await refuse('state-v2', payload => { payload.snapshot.schemaVersion = 2; }, 'CHECKPOINT_INCOMPATIBLE_STATE_FORMAT');
    await refuse('unknown-state-channel', payload => { payload.snapshot.state.unknown = []; }, 'CHECKPOINT_INCOMPATIBLE_STATE_FORMAT');
    await refuse('policy-mismatch', payload => { payload.snapshot.policyKey += '-incompatible'; }, 'RECOVERY_HANDOFF_INVALID_SNAPSHOT');
    const candidateCorePath = path.join(targetRoot, 'codex-model-stream-proxy.mjs');
    const candidateCoreBytes = fs.readFileSync(candidateCorePath);
    try {
      fs.writeFileSync(candidateCorePath, originalCore);
      await refuse('wrong-current-target-bytes', () => {}, 'CHECKPOINT_TARGET_BYTES_CHANGED');
    } finally { fs.writeFileSync(candidateCorePath, candidateCoreBytes); }
    await ipc(old, 'cancel', { threadId, token: snapshot.token });
    const retained = await peek(old, threadId);
    check('every_refusal_retains_old_budget_two', retained.state.emptyIdleTurns[0]?.[1]?.count === 2);
    const third = await runTurn(threadId, 'OLD_CONTINUES_AFTER_VERSION_REFUSALS');
    check('old_continues_original_behavior_budget_three', third.completion.params.turn.status === 'failed'
      && third.modelRequests === 1 && third.routes.every(entry => entry.pid === old.child.pid)
      && JSON.stringify(third.completion).includes('Three distinct turns')
      && !JSON.stringify(third.completion).includes('COMPAT_V2_DIAGNOSIS'), { third });
    const finalOld = await peek(old, threadId);
    check('old_counter_not_reset_by_refusals', finalOld.state.emptyIdleTurns[0]?.[1]?.count === 3);
  } else await rollbackScenario(threadId, old);`);
replaceOnce("result.sourceUnchangedAtEnd = manifest.every(entry => digest(fs.readFileSync(path.join(sourceRoot, entry.relative))) === entry.sha256);",
  "result.sourceUnchangedAtEnd = manifest.every(entry => digest(fs.readFileSync(path.join(sourceRoot, entry.relative))) === entry.sha256)\n    && targetManifest.every(entry => digest(fs.readFileSync(path.join(targetRoot, entry.relative))) === entry.sha256)\n    && wrongTargetManifest.every(entry => digest(fs.readFileSync(path.join(wrongTargetRoot, entry.relative))) === entry.sha256);");
const generatedPath = path.join(fixtureRoot, "inner-version-0100-native-fixture.mjs");
fs.writeFileSync(generatedPath, fixture);
fs.writeFileSync(path.join(fixtureRoot, "fixture-provenance.json"), JSON.stringify({ fixturePath, originalFixtureSha256,
  driverPath: fileURLToPath(import.meta.url), driverSha256: digest(fs.readFileSync(fileURLToPath(import.meta.url))),
  generatedPath, generatedSha256: digest(fixture), sourceRoot, runId, scenario }, null, 2));
process.argv = [process.execPath, generatedPath, runId, scenario];
await import(pathToFileURL(generatedPath).href);
