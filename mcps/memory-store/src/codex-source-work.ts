interface SourceWorkWaiter {
    isCancelled?: () => boolean;
}

interface SharedSourceWork {
    waiters: Set<SourceWorkWaiter>;
    promise: Promise<unknown>;
}

const activeSourceWork = new Map<string, SharedSourceWork>();

function cancellationError(): Error {
    const error = new Error("Codex source work waiting was cancelled");
    error.name = "AbortError";
    return error;
}

export async function runSharedCodexSourceWork<Result>(
    key: string,
    work: (isCancelled: () => boolean) => Promise<Result>,
    isCancelled?: () => boolean,
): Promise<Result> {
    if (isCancelled?.()) throw cancellationError();
    let shared = activeSourceWork.get(key);
    if (!shared || shared.waiters.size === 0 || [...shared.waiters].every(waiter => waiter.isCancelled?.())) {
        const created: SharedSourceWork = { waiters: new Set(), promise: Promise.resolve() };
        created.promise = Promise.resolve().then(() => work(() => created.waiters.size === 0
            || [...created.waiters].every(waiter => Boolean(waiter.isCancelled?.()))));
        activeSourceWork.set(key, created);
        const remove = (): void => {
            if (activeSourceWork.get(key) === created) activeSourceWork.delete(key);
        };
        void created.promise.then(remove, remove);
        shared = created;
    }
    const waiter: SourceWorkWaiter = { isCancelled };
    shared.waiters.add(waiter);
    let cancellationTimer: NodeJS.Timeout | undefined;
    try {
        return await new Promise<Result>((resolve, reject) => {
            void shared!.promise.then(value => {
                if (isCancelled?.()) reject(cancellationError());
                else resolve(value as Result);
            }, reject);
            if (isCancelled) {
                cancellationTimer = setInterval(() => {
                    if (isCancelled()) reject(cancellationError());
                }, 25);
                cancellationTimer.unref?.();
            }
        });
    } finally {
        if (cancellationTimer) clearInterval(cancellationTimer);
        shared.waiters.delete(waiter);
    }
}
