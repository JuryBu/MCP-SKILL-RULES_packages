export type ExecutionCleanupState = 'released' | 'not_needed' | 'unconfirmed';

export async function releaseExecutionResources(
    contextCleanup: () => Promise<{ state: ExecutionCleanupState }>,
    toolCleanup: () => Promise<ExecutionCleanupState>,
): Promise<ExecutionCleanupState> {
    let contextState: ExecutionCleanupState = 'unconfirmed';
    let toolState: ExecutionCleanupState = 'unconfirmed';
    try { contextState = (await contextCleanup()).state; } catch {}
    try { toolState = await toolCleanup(); } catch {}
    if (contextState === 'unconfirmed' || toolState === 'unconfirmed') return 'unconfirmed';
    return contextState === 'released' || toolState === 'released' ? 'released' : 'not_needed';
}
