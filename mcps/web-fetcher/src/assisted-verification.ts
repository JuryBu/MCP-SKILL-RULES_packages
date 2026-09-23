import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { humanBrowserManager } from './human-browser/manager.js';
import { startBackgroundTask, listBackgroundTasks, type BackgroundTask } from './background-tasks.js';
import { readPageAccess, samePageTarget, registerAssistedPage, unregisterAssistedPage } from './page-access.js';
import { sessionManager } from './session.js';

export const HUMAN_VERIFICATION_WINDOW_MS = 600_000;
export const HUMAN_VERIFICATION_GENERATION = randomUUID();

export interface HumanVerificationStart {
    url: string;
    ownerId: string;
    waitFor?: string;
    humanSessionId?: string;
    pageId?: string;
    automatic?: boolean;
}

function requireOwner(ownerId: string): void {
    if (!ownerId.trim() || ownerId === 'global') throw new Error('人工验证任务必须提供稳定的非global ownerId');
}

export function startHumanVerification(params: HumanVerificationStart): BackgroundTask {
    requireOwner(params.ownerId);
    const target = new URL(params.url);
    if (!['http:', 'https:'].includes(target.protocol)) throw new Error('人工验证仅支持HTTP/HTTPS目标');
    const requestIdentity = { requestedHumanSessionId: params.humanSessionId ?? null, requestedPageId: params.pageId ?? null, waitFor: params.waitFor ?? null };
    for (const task of listBackgroundTasks('human-verification', params.ownerId)) {
        const active = ['running', 'cancelling'].includes(task.status) || task.cleanupStatus === 'failed';
        const sameTarget = task.metadata?.targetUrl === target.href;
        const sameIdentity = Object.entries(requestIdentity).every(([key, value]) => task.metadata?.[key] === value);
        if (sameTarget && sameIdentity && (active || (params.automatic && Date.now() - Date.parse(task.finishedAt ?? task.updatedAt) < 60_000))) return task;
        const sameBrowser = !params.humanSessionId || task.metadata?.humanSessionId === params.humanSessionId || task.metadata?.requestedHumanSessionId === params.humanSessionId;
        if (active && sameBrowser && (sameTarget || (params.pageId && task.metadata?.pageId === params.pageId))) {
            throw new Error(`已有人工任务的目标、页面或waitFor条件不同；请先查询/清理原任务 ${task.id}，不会错误复用ready状态或重复开窗`);
        }
    }
    let humanSessionId = params.humanSessionId;
    let opening: Promise<unknown> | undefined;
    let sessionId: string | undefined;
    let registeredPage: object | undefined;
    const ownsHumanSession = !params.humanSessionId;
    const cleanup = async () => {
        if (opening) await opening.catch(async error => {
            if (!error?.cleanupFailed) return;
            if (typeof error.retryCleanup !== 'function') throw error;
            await error.retryCleanup();
        });
        if (sessionId) await sessionManager.close(sessionId, params.ownerId);
        if (registeredPage) unregisterAssistedPage(registeredPage);
        if (ownsHumanSession && humanSessionId) await humanBrowserManager.close(humanSessionId, params.ownerId);
    };
    return startBackgroundTask('human-verification', async control => {
      try {
        control.updateMetadata({ phase: 'opening' });
        const info = await (opening = params.humanSessionId
            ? humanBrowserManager.describe(params.humanSessionId, params.ownerId)
            : humanBrowserManager.open({ startUrl: target.href, ownerId: params.ownerId, waitMs: 10_000, restoreState: true, signal: control.signal })
        ).then(value => value as Awaited<ReturnType<typeof humanBrowserManager.open>>);
        humanSessionId = info.humanSessionId;
        control.signal.throwIfAborted();
        const selected = params.pageId ? info.pages.find(page => page.pageId === params.pageId)
            : info.pages.find(page => page.url && samePageTarget(page.url, target.href)) ?? (info.pages.length === 1 ? info.pages[0] : undefined);
        if (!selected) throw new Error('无法唯一选择目标页面；请提供humanSessionId与pageId');
        control.startDeadline(HUMAN_VERIFICATION_WINDOW_MS);
        control.updateMetadata({ phase: 'awaiting_user', humanSessionId, pageId: selected.pageId, windowReadyAt: new Date().toISOString() });
        while (!control.signal.aborted) {
            const page = humanBrowserManager.getPage(humanSessionId, selected.pageId, params.ownerId);
            if (!page) {
                const closed = await humanBrowserManager.describe(humanSessionId, params.ownerId);
                control.updateMetadata({ phase: 'closed_unverified', storageSaved: Boolean(closed.storageSnapshot?.savedAt), contentVerified: false, nextAction: '人工窗口已关闭；存储保存不代表原目标可访问，请重新读取目标确认，不会自动重放原动作。' });
                throw new Error('人工窗口已关闭，无法在原页面续接；未确认目标内容');
            }
            const assessment = sessionId
                ? await sessionManager.withOperation(sessionId, params.ownerId, () => readPageAccess(page, { url: target.href, waitFor: params.waitFor }))
                : await readPageAccess(page, { url: target.href, waitFor: params.waitFor });
            const storage = humanBrowserManager.peekStorage(humanSessionId, params.ownerId);
            const ready = assessment.status === 'content_ready' && assessment.targetMatched && assessment.contentConfirmed;
            if (ready && !sessionId) {
                sessionId = sessionManager.registerPage(page, params.ownerId, { ownership: 'borrowed', closePolicy: 'noop', browserSource: 'cdp-attach-live' });
                registeredPage = page;
                registerAssistedPage(page, target.href);
            }
            control.updateMetadata({
                phase: ready ? 'ready' : 'awaiting_user', access: assessment, sessionId,
                storageSaved: Boolean(storage.savedAt), storageSavedAt: storage.savedAt, storageErrors: storage.errors, contentVerified: ready,
                nextAction: ready
                    ? '保留人工窗口，用同一ownerId和sessionId调用web_fetch_page/web_fetch_rich/web_fetch_screenshot或web_interact继续读取；完成后关闭本任务。'
                    : '请在人工窗口完成验证并打开原目标页面，暂时不要关闭窗口；使用短轮询查询，不重复开窗。',
            });
            await delay(1000, undefined, { signal: control.signal });
        }
        return '人工验证结束';
      } finally {
          await cleanup();
      }
    }, {
        ownerId: params.ownerId, strictOwner: true, maxRunMs: HUMAN_VERIFICATION_WINDOW_MS,
        deferDeadlineUntilReady: true, setupTimeoutMs: 60_000,
        metadata: { phase: 'queued', targetUrl: target.href, ...requestIdentity, ownsHumanSession, generation: HUMAN_VERIFICATION_GENERATION, contentVerified: false, storageSaved: false },
        timeoutMessage: '人工验证窗口600秒租期已到；已开始保存状态并清理自有资源，未自动重放原任务。',
        onCancel: cleanup,
    });
}
