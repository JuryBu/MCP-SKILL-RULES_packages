export const MAX_PARALLEL_TOOL_READS = 4;

export async function settleIndependentReads<Value>(operations: readonly (() => Promise<Value>)[]): Promise<Value[]> {
    if (operations.length < 1 || operations.length > MAX_PARALLEL_TOOL_READS) throw new RangeError('只读工具批次须为1至4项');
    const settled = await Promise.allSettled(operations.map(operation => Promise.resolve().then(operation)));
    const failed = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failed) throw failed.reason;
    return settled.map(result => (result as PromiseFulfilledResult<Value>).value);
}
