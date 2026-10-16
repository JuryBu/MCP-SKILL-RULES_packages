import fs from 'node:fs';
import path from 'node:path';
import { runtimeStateDirectory, readRuntimeState, isProcessAlive } from '../dist/runtime-status.js';

const explicit = process.env.WEB_FETCHER_RUNTIME_STATE_FILE;
const directory = runtimeStateDirectory();
let files = [];
try {
    files = explicit ? [explicit] : fs.readdirSync(directory)
        .filter(name => /^\d+\.json$/.test(name))
        .map(name => path.join(directory, name))
        .sort((first, second) => fs.statSync(second).mtimeMs - fs.statSync(first).mtimeMs)
        .slice(0, 32);
} catch { }
const snapshots = files.map(file => {
    const saved = readRuntimeState(file);
    if (!saved) return { stateFile: file, state: 'unknown', reason: 'missing-or-invalid' };
    const alive = isProcessAlive(saved.pid);
    const unobserved = !alive && ['starting', 'ready'].includes(saved.state);
    return { ...saved, state: unobserved ? 'unknown' : saved.state, reason: unobserved ? 'unobserved-exit' : saved.reason, processAliveObserved: alive, stateFile: file };
});
console.log(JSON.stringify({ readOnly: true, startsBackend: false, snapshots }, null, 2));
