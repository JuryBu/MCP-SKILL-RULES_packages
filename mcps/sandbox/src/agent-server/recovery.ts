import type { RunSnapshot } from './protocol.js';
import { isTerminal, transitionRun } from './state-machine.js';

export function recoverRun<Value extends RunSnapshot>(run: Value): Value {
    if (isTerminal(run) || run.state === 'paused' || run.state === 'outcome_unknown') return run;
    const uncertain = run.state === 'running' || run.state === 'stopping' || run.effectState === 'unknown';
    const recovering = transitionRun(run, 'recovering', { runEpoch: run.runEpoch + 1 } as Partial<Value>);
    return transitionRun(recovering, uncertain ? 'outcome_unknown' : 'paused', {
        phase: null, stopReason: uncertain ? 'RESTART_RECONCILIATION_REQUIRED' : 'RESTART_RESUME_REQUIRED',
        effectState: uncertain ? 'unknown' : run.effectState,
        resultStatus: uncertain ? 'unknown' : run.resultStatus,
        cleanupState: uncertain ? 'unconfirmed' : 'not_needed',
    } as Partial<Value>);
}
