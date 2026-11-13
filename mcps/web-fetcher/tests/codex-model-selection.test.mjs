import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveCodexModelSelection } from '../src/model-bridge.ts';

test('Codex default comes from a fresh local visible model catalog, not a retired constant', context => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'web-fetcher-codex-catalog-'));
  const priorHome = process.env.CODEX_HOME;
  const priorModel = process.env.WEB_FETCHER_CODEX_MODEL;
  delete process.env.WEB_FETCHER_CODEX_MODEL;
  process.env.CODEX_HOME = directory;
  context.after(() => {
    if (priorHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = priorHome;
    if (priorModel === undefined) delete process.env.WEB_FETCHER_CODEX_MODEL;
    else process.env.WEB_FETCHER_CODEX_MODEL = priorModel;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const filename = path.join(directory, 'models_cache.json');
  const models = [
    { slug: 'hidden-old', visibility: 'hide', priority: 0 },
    { slug: 'not-exec', visibility: 'list', supported_in_api: false, priority: 0 },
    { slug: 'current-second', visibility: 'list', priority: 2 },
    { slug: 'current-preferred', visibility: 'list', priority: 1, supported_reasoning_levels: [{ effort: 'max' }] },
  ];
  fs.writeFileSync(filename, JSON.stringify({ fetched_at: new Date().toISOString(), models }));
  assert.deepEqual(resolveCodexModelSelection(), { model: 'current-preferred', source: 'catalog', efforts: ['max'] });
  assert.deepEqual(resolveCodexModelSelection('explicit-model'), { model: 'explicit-model', source: 'request' });
  process.env.WEB_FETCHER_CODEX_MODEL = 'configured-model';
  assert.deepEqual(resolveCodexModelSelection(), { model: 'configured-model', source: 'environment' });
  delete process.env.WEB_FETCHER_CODEX_MODEL;
  for (const contents of [
    '{invalid',
    JSON.stringify({ fetched_at: new Date(Date.now() - 48 * 60 * 60_000).toISOString(), models }),
    JSON.stringify({ fetched_at: new Date().toISOString(), models: [] }),
  ]) {
    fs.writeFileSync(filename, contents);
    assert.deepEqual(resolveCodexModelSelection(), { model: null, source: 'cli-default' });
  }
});
