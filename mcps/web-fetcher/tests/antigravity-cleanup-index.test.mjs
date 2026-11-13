import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

test('server cleanup attempts every owner even if the CLI throws, and repeated calls share the same completion', async () => {
  const source = fs.readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  const start = source.indexOf('let cleanupPromise:');
  const end = source.indexOf('process.on("SIGINT"', start);
  assert.ok(start > 0 && end > start);
  const code = ts.transpileModule(source.slice(start, end) + '\nexports.run = cleanup;', {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const attempts = [];
  const failures = [];
  const exports = {};
  const context = vm.createContext({
    exports,
    Promise,
    heartbeatTimer: {},
    clearInterval: () => attempts.push('heartbeat'),
    console: { error: value => failures.push(value) },
    require: () => ({ stopAllServers: () => attempts.push('local-server') }),
    sessionManager: { closeAll: async () => { attempts.push('sessions'); throw new Error('session fixture'); } },
    desktopManager: { closeAll: async () => { attempts.push('desktop'); } },
    humanBrowserManager: { closeAll: async () => { attempts.push('human-browser'); } },
    disposeAntigravityCli: async () => { attempts.push('antigravity-cli'); throw new Error('CLI fixture'); },
    browserManager: { shutdown: async () => { attempts.push('browser'); } },
  });
  new vm.Script(code).runInContext(context);
  const first = exports.run();
  const second = exports.run();
  assert.equal(first, second);
  await first;
  assert.deepEqual(attempts.filter(name => name !== 'local-server'), ['heartbeat', 'sessions', 'desktop', 'human-browser', 'antigravity-cli', 'browser']);
  assert.ok(failures.some(message => /sessions.*session fixture/u.test(message)));
  assert.ok(failures.some(message => /antigravity-cli.*CLI fixture/u.test(message)));
});
