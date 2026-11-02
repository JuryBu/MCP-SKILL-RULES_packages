import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { AgentClient } from '../../../dist/agent-client/client.js';
import { readServerDescriptor } from '../../../dist/agent-server/discovery.js';
import { captureCliBuild } from './cli-build.mjs';

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const entry = join(sourceRoot, 'dist/agent-cli/main.js');
const args = process.argv.slice(2);
let evidenceRoot = process.env.SANDBOX_AGENT_CLI_EVIDENCE_ROOT;
for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--evidence-root' && args[index + 1]) evidenceRoot = args[++index];
    else throw new Error('未知配置验收参数：' + args[index]);
}

test('正式CLI保存配置、三格式私有文件导入和持久重开，零模型请求', { timeout: 90_000 }, async () => {
    const id = randomUUID();
    const fixture = await fs.mkdtemp(join(tmpdir(), 'sandbox-agent-cli-profile-'));
    const dataDir = join(fixture, '私有 状态');
    const project = join(fixture, '获准 样例');
    const output = evidenceRoot ? join(resolve(evidenceRoot), 'cli-profiles-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + id) : join(fixture, 'evidence');
    await fs.mkdir(project); await fs.mkdir(output, { recursive: true }); await fs.writeFile(join(fixture, '.owner'), id);
    const environment = Object.fromEntries(['SystemRoot', 'WINDIR', 'PATH', 'TEMP', 'TMP', 'USERPROFILE', 'HOME'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
    const commands = [];
    const checks = [];
    const dummy = 'fixture-value-' + randomUUID();
    const deadlineAt = new Date(Date.now() + 120_000).toISOString();
    const build = () => captureCliBuild(sourceRoot);
    const beforeBuild = await build();
    const check = (name, value) => { checks.push({ name, pass: Boolean(value) }); assert.ok(value, name); };
    const cli = async (argv, expectedCode = 0) => {
        const result = await new Promise((resolveChild, rejectChild) => {
            const child = spawn(process.execPath, [entry, '--data-dir', dataDir, '--deadline-at', deadlineAt, ...argv, '--json'], { cwd: project, env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
            let stdout = '', stderr = '';
            const timer = setTimeout(() => { child.kill(); rejectChild(new Error('本次fixture CLI超时')); }, 20_000);
            child.stdout.setEncoding('utf8').on('data', text => { stdout += text; }); child.stderr.setEncoding('utf8').on('data', text => { stderr += text; });
            child.once('error', error => { clearTimeout(timer); rejectChild(error); });
            child.once('close', code => { clearTimeout(timer); resolveChild({ code, stdout, stderr }); });
        });
        commands.push({ argv, ...result });
        assert.equal(result.code, expectedCode, result.stdout + result.stderr);
        assert.equal(result.stdout.trim().split('\n').length, 1);
        assert.equal(result.stdout.includes(dummy) || result.stderr.includes(dummy), false, '虚拟凭据不得回显');
        const parsed = JSON.parse(result.stdout); assert.equal(parsed.ok, true); return parsed.data;
    };
    const getProfile = async profileId => { const value = await cli(['profile', 'get', profileId]); return value.profile ?? value; };
    const stopServer = async () => {
        const descriptor = await readServerDescriptor(dataDir).catch(() => null);
        if (!descriptor) return;
        assert.equal(resolve(descriptor.dataDir), resolve(dataDir));
        const client = await AgentClient.connect({ dataDir, descriptor, clientId: 'profile-cleanup-' + id });
        try { const claim = await client.claimControl('server', undefined, true); assert.equal(claim.ok, true); const result = await client.request('server.shutdown', { mode: 'cancel', graceMs: 0 }); assert.equal(result.ok, true); }
        finally { await client.close(); }
        for (let attempt = 0; attempt < 60 && await readServerDescriptor(dataDir); attempt += 1) await new Promise(resolveWait => setTimeout(resolveWait, 50));
        assert.equal(await readServerDescriptor(dataDir), null);
    };
    let failure;
    try {
        const info = await cli(['doctor']); check('doctor_no_model_request', info.modelRequestPerformed === false);
        check('executor_disabled_before_control_fixture', info.product.capabilities.executor === false);
        const rootCommandId = 'fixture-exec-' + id;
        const budget = JSON.stringify({ wallMs: 60_000, maxModelCalls: 1, maxOutputTokens: 64, maxCostMicros: 0, currency: 'USD', costMode: 'hard' });
        const execution = ['exec', '--text', '自有样例的零费用排队输入', '--detach', '--command-id', rootCommandId, '--budget', budget];
        const first = await cli(execution);
        const repeated = await cli(execution);
        check('exec_repeated_id_reuses_create_and_run', first.runId === repeated.runId && first.conversationId === repeated.conversationId);
        check('exec_control_fixture_without_model', first.executorAvailable === false && first.state === 'queued');
        const sessions = await cli(['conversation', 'list']); check('exec_did_not_create_duplicate_conversation', sessions.items.length === 1);
        await cli(['exec', '--text', 'JSONL排队样例', '--budget', budget, '--format', 'jsonl'], 4);
        const jsonl = JSON.parse(commands.at(-1).stdout); check('jsonl_has_terminal_result', jsonl.type === 'cli.result' && jsonl.data.waitingForExecutor === true && jsonl.exitCode === 4);
        const created = await cli(['profile', 'add', '--label', 'CLI虚拟配置', '--protocol', 'compatible_chat', '--base-url', 'https://provider.example.invalid/v1', '--model', 'fixture-model']);
        const profile = created.profile ?? created; check('created_profile_identity', typeof profile.profileId === 'string');
        const profileId = profile.profileId;
        const validation = await cli(['profile', 'validate', profileId]); check('validation_without_network', validation.valid && validation.networkPerformed === false);
        for (const format of ['plain', 'env', 'json']) {
            const path = join(project, '虚拟凭据.' + format);
            await fs.writeFile(path, format === 'plain' ? dummy : format === 'env' ? 'FIXTURE_ONLY=' + dummy + '\n' : JSON.stringify({ fixtureOnly: dummy }), 'utf8');
            const current = await getProfile(profileId);
            const result = await cli(['key', 'set', profileId, '--secret-file', path, '--secret-format', format,
                ...(format === 'plain' ? [] : ['--secret-field', format === 'env' ? 'FIXTURE_ONLY' : 'fixtureOnly']), '--revision', String(current.revision)]);
            check('server_import_' + format, result.configured === true && typeof result.credentialRef === 'string');
            await fs.unlink(path);
        }
        const configured = await getProfile(profileId); check('credential_metadata_only', configured.credentialRef && configured.credentialGeneration === 3 && !Object.hasOwn(configured, 'secret'));
        const limitId = 'fixture-limit-' + id;
        await cli(['budget', 'configure-limit', '--quota-limit-id', limitId, '--currency', 'USD', '--max-cost-micros', '0', '--quota-scope-ids', JSON.stringify([configured.quotaScopeId]), '--source-ref', 'owned-zero-cost-fixture']);
        await cli(['profile', 'edit', profileId, '--quota-limit-id', limitId, '--label', 'CLI虚拟配置已更新']);
        const saved = await getProfile(profileId); check('profile_refers_to_total_limit', saved.quotaLimitId === limitId);
        const catalog = await cli(['model', 'list', '--profile', profileId]); check('catalog_is_local_metadata', Array.isArray(catalog.entries ?? catalog.items ?? catalog.models));
        await stopServer();
        const restored = await getProfile(profileId); check('restart_preserved_profile', restored.revision === saved.revision && restored.credentialRef === saved.credentialRef && restored.quotaLimitId === limitId);
        check('no_paid_model_or_refresh_command', commands.every(command => !['runs', 'rpc'].includes(command.argv[0]) && !(command.argv[0] === 'model' && command.argv[1] === 'refresh')
            && (command.argv[0] !== 'exec' || command.argv.includes(budget) && !command.argv.includes('--profile'))));
    } catch (error) { failure = error; }
    finally {
        try { await stopServer(); } catch (error) { failure ??= error; }
        const afterBuild = await build();
        const sameBuild = beforeBuild.fingerprint === afterBuild.fingerprint;
        const serverClosed = await readServerDescriptor(dataDir) === null;
        const report = { schemaVersion: 1, type: 'cli-profiles', checks, commands, actualProviderRequests: 0, beforeBuild, afterBuild,
            sameBuild, serverClosed, allPassed: !failure && checks.every(item => item.pass) && sameBuild && serverClosed, error: failure ? String(failure) : null, scope: 'Only owned synthetic values and fixtures. Queued exec uses an explicitly absent executor and a zero-cost hard budget. No real Key, model invocation, provider connectivity test, catalog refresh, installation or global changes.' };
        const path = join(output, 'report.json'); await fs.writeFile(path, JSON.stringify(report, null, 2) + '\n', 'utf8');
        const sha256 = createHash('sha256').update(await fs.readFile(path)).digest('hex'); await fs.writeFile(join(output, 'report.sha256'), sha256 + '  report.json\n');
        process.stdout.write(JSON.stringify({ reportPath: path, sha256, allPassed: report.allPassed, sameBuild: report.sameBuild, serverClosed: report.serverClosed }) + '\n');
        if (evidenceRoot && report.serverClosed) { assert.equal(await fs.readFile(join(fixture, '.owner'), 'utf8'), id); assert.equal(dirname(resolve(fixture)), resolve(tmpdir())); await fs.rm(fixture, { recursive: true, force: true }); }
        assert.equal(report.sameBuild, true, '实测期间dist变化');
    }
    if (failure) throw failure;
});
