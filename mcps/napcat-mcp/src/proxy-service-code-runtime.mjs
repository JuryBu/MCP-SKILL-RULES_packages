import fs from "node:fs";
import path from "node:path";
import { CodexAppServerProxyError } from "./outer-runtime-contract.mjs";
import { proxyServiceDependencies } from "./codex-app-server-proxy-runner.mjs";

const methods = Object.freeze(["runDiagnosticObserver", "recordDiagnosticStorageFailure", "persist", "log", "requestStop", "installSignals", "markFatal", "pauseForUpstream", "resumeAfterUpstream", "handleProxyEvent", "watchLifecycleStep",
  "initializeService", "runBackendCycle", "handleBackendExit", "handleBackendFailure", "cleanupBackendCycle", "restartBackoff", "finishService"]);
const fail = code => { throw Object.assign(new Error(code), { code }); };
const checked = implementation => {
  if (!implementation || methods.some(method => typeof implementation[method] !== "function")) fail("PROXY_SERVICE_CODE_METHOD_MISSING");
  return Object.freeze(Object.fromEntries(methods.map(method => [method, implementation[method]])));
};

export function createProxyServiceCodeRuntime(state) {
  state.implementation = checked(createProxyServiceImplementation(state));
  state.dispatch = (method, ...args) => state.implementation[method](...args);
  state.bindDispatch = (method, ...bound) => (...args) => state.dispatch(method, ...bound, ...args);
  let generation = 0;
  const snapshots = new WeakSet();
  const candidates = new WeakSet();
  const snapshot = () => {
    const token = Object.freeze({ state, implementation: state.implementation, generation });
    snapshots.add(token);
    return token;
  };
  const participant = Object.freeze({ id: "proxy-service", stateSchema: "proxy-service-state-v1",
    exportName: "createProxyServiceImplementation", snapshot,
    prepare(module) {
      if (typeof module?.createProxyServiceImplementation !== "function") fail("PROXY_SERVICE_CODE_EXPORT_MISSING");
      const protectedNames = ["options", "fsImpl", "now", "pid", "lock", "diagnosticStorageFailures", "dependencies"];
      const retained = protectedNames.map(name => state[name]);
      const candidate = Object.freeze({ state, implementation: checked(module.createProxyServiceImplementation(state)) });
      if (protectedNames.some((name, index) => state[name] !== retained[index])) fail("PROXY_SERVICE_CODE_RESOURCE_DRIFT");
      candidates.add(candidate);
      return candidate;
    },
    activate(candidate) {
      if (!candidates.has(candidate) || candidate.state !== state) fail("PROXY_SERVICE_CODE_CANDIDATE_INVALID");
      const token = snapshot();
      state.implementation = candidate.implementation;
      generation++;
      return token;
    },
    restore(token) {
      if (!snapshots.has(token) || token.state !== state) fail("PROXY_SERVICE_CODE_SNAPSHOT_INVALID");
      state.implementation = token.implementation;
      generation++;
    },
  });
  return { ...Object.fromEntries(methods.map(method => [method, state.bindDispatch(method)])), liveCodeParticipant: () => participant };
}

export function createProxyServiceImplementation(state) {
  const { options, fsImpl, now, pid, lock, diagnosticStorageFailures, controlToken, createdChildPids, excludedUpstreamPorts, startupDeadlineAt, bundleRefreshState } = state;
  const dependencies = new Proxy(Object.create(null), {
    get: (_target, name) => state.dependencies?.[name] ?? proxyServiceDependencies[name],
  });
  const { createWakeJournal, createCodexAppServerProxy, createOperationGuard, codexCandidates, executableRevision,
    verifyCodexRuntimeBundle, prepareCodexRuntimeBundle, runExecutableProbe, spawnAppServer, waitWithAbort,
    waitForWebSocketReady, verifyManagedListenerOwner, updateMaintenance, resolveProxyFailureArtifacts,
    waitForExit, terminateManagedAppServer, processAlive, selectRecoveryUpstreamPort, publicError, wait } = dependencies;
  const { startTimeoutMs: DEFAULT_START_TIMEOUT_MS, bundleDeepCheckIntervalMs: DEFAULT_BUNDLE_DEEP_CHECK_INTERVAL_MS,
    executableRefreshIntervalMs: DEFAULT_EXECUTABLE_REFRESH_INTERVAL_MS, livenessIntervalMs: DEFAULT_LIVENESS_INTERVAL_MS,
    restartBackoffMs: DEFAULT_RESTART_BACKOFF_MS } = dependencies.defaults;
  const shouldStop = () => state.stopRequested || fsImpl.existsSync(options.stopFilePath);
  const ownsLock = () => lock.isOwner();
  function runDiagnosticObserver(observer, value) {
    try { const pending = observer?.(value); pending?.catch?.(() => {}); } catch {}
  }
  function recordDiagnosticStorageFailure(error, target) {
    const failure = { code: error.code, target, at: now().toISOString() };
    diagnosticStorageFailures.add(target);
    state.status = { ...state.status, diagnosticStorageDegraded: true, lastDiagnosticStorageError: failure };
    state.dispatch("runDiagnosticObserver", options.onDiagnosticStorageFailure, failure);
    if (Date.now() - state.diagnosticStorageWarningAt >= 60_000) {
      state.diagnosticStorageWarningAt = Date.now();
      state.dispatch("runDiagnosticObserver", options.writeDiagnosticWarning ?? (message => fs.writeSync(process.stderr.fd, message)),
        `Codex proxy diagnostic storage unavailable: ${error.code}\n`);
    }
  }
  function persist(patch = {}, { allowStorageDegradation = false } = {}) {
    if (!ownsLock()) throw new CodexAppServerProxyError("INSTANCE_LOCK_LOST", "Codex App Server proxy instance no longer owns the lifecycle lock");
    const persistedAt = now().toISOString();
    state.status = { ...state.status, ...patch, livenessAt: persistedAt, updatedAt: persistedAt,
      diagnosticStorageDegraded: diagnosticStorageFailures.has("diagnostic_log") };
    try { dependencies.atomicWriteJson(options.runtimeStatePath, state.status, fsImpl); diagnosticStorageFailures.delete("runtime_state"); }
    catch (error) {
      const liveBackend = state.status.state === "running" && state.appServer?.exitCode === null && state.appServer?.signalCode === null;
      if (error?.code !== "ENOSPC" || (!allowStorageDegradation && !liveBackend)) throw error;
      state.dispatch("recordDiagnosticStorageFailure", error, "runtime_state");
    }
    return state.status;
  }
  function log(type, details = {}) {
    try {
      dependencies.appendJsonLine(options.logPath, { at: now().toISOString(), type, pid, ...details }, fsImpl);
      diagnosticStorageFailures.delete("diagnostic_log");
      state.status = { ...state.status, diagnosticStorageDegraded: diagnosticStorageFailures.size > 0 };
    } catch (error) {
      if (error?.code !== "ENOSPC") throw error;
      state.dispatch("recordDiagnosticStorageFailure", error, "diagnostic_log");
    }
  }
  function requestStop(reason) {
    state.stopRequested = true;
    if (!state.stopReason) state.stopReason = reason;
  }
  function installSignals() {
    const handlers = new Map();
    for (const signal of ["SIGINT", "SIGTERM"]) {
      const handler = state.bindDispatch("requestStop", `signal:${signal}`);
      process.on(signal, handler);
      handlers.set(signal, handler);
    }
    return () => { for (const [signal, handler] of handlers) process.removeListener(signal, handler); };
  }
  function markFatal(error) {
    if (!ownsLock()) return false;
    const errorValue = dependencies.publicError(error, "CODEX_PROXY_INCOMPATIBLE");
    const at = now().toISOString();
    dependencies.updateMaintenance(options.maintenanceFilePath, "codexAppServerProxy", { at, code: errorValue.code, message: errorValue.message }, fsImpl);
    dependencies.atomicWriteJson(options.alertFilePath, { schemaVersion: 1, pending: true, status: "pending", createdAt: at,
      source: "codex-app-server-proxy", incidentKey: `codex-app-server-proxy:${errorValue.code}`, code: errorValue.code,
      message: errorValue.message, text: `[Codex 自动唤醒已暂停]\n原因：${errorValue.code}\n详情：${errorValue.message}\n普通 Codex 启动将回退到原生 App Server，请检查本机状态。` }, fsImpl);
    dependencies.atomicWriteJson(options.fallbackFilePath, { schemaVersion: 1, pending: true, createdAt: at,
      expectedProxyUrl: state.status.downstreamUrl, code: errorValue.code, message: errorValue.message }, fsImpl);
    state.dispatch("persist", { state: "degraded", compatible: false, automationEnabled: false, fallbackRequired: true, lastError: errorValue });
    state.dispatch("log", "proxy_fatal", { error: errorValue });
    return true;
  }
  function pauseForUpstream(code, message) {
    return ownsLock() && dependencies.updateMaintenance(options.maintenanceFilePath, "codexAppServerProxyUpstream",
      { at: now().toISOString(), code, message }, fsImpl);
  }
  function resumeAfterUpstream() {
    return ownsLock() && dependencies.updateMaintenance(options.maintenanceFilePath, "codexAppServerProxyUpstream", null, fsImpl);
  }
  function handleProxyEvent(event) {
    if (event.type === "client_closed") state.sawDesktopClient = true;
    if (event.type === "upstream_reconnect_scheduled") {
      state.dispatch("pauseForUpstream", "APP_SERVER_RECONNECTING", "Codex App Server 上游暂时不可用，自动唤醒已暂停并等待恢复");
    } else if (event.type === "upstream_connected") state.dispatch("resumeAfterUpstream");
    if (["proxy_error", "upstream_session_lost", "upstream_connected", "display_policy_activated", "display_policy_restored", "display_policy_fallback"].includes(event.type)) {
      state.dispatch("persist", { proxy: state.proxy?.status() ?? null, ...(event.type === "proxy_error" ? { lastError: event.error } : {}) });
    }
    state.dispatch("log", event.type, event);
  }
  function canStopEmptyDesktop(snapshot) {
    return Number(snapshot?.clientCount) === 0
      && ["activeOperationCount", "trackedRequestCount", "pendingToolCount"]
        .every(name => Number(snapshot?.outerRuntime?.[name] ?? 0) === 0);
  }
  async function watchLifecycleStep(cycle) {
    await dependencies.wait(options.lifecyclePollIntervalMs ?? 250);
    if (!cycle.active) return { code: null, signal: "watch_stopped" };
    const shouldStop = () => state.stopRequested || fsImpl.existsSync(options.stopFilePath);
    if (shouldStop()) return { code: null, signal: "stop_requested" };
    const proxySnapshot = state.proxy.status();
    if (Number(proxySnapshot?.clientCount) > 0) state.sawDesktopClient = true;
    const emptyDesktop = dependencies.observeEmptyDesktopRestart({ ...cycle.emptyDesktopRestartState,
      sawDesktopClient: state.sawDesktopClient || cycle.emptyDesktopRestartState?.sawDesktopClient }, {
      clientCount: proxySnapshot?.clientCount, nowMs: Date.now(),
      restartMs: options.emptyClientRestartMs ?? dependencies.defaults.emptyClientRestartMs });
    cycle.emptyDesktopRestartState = emptyDesktop.state;
    if (emptyDesktop.shouldRestart && canStopEmptyDesktop(proxySnapshot)) {
      return { code: null, signal: "desktop_empty_restart", emptyForMs: emptyDesktop.emptyForMs };
    }
    if (Date.now() >= cycle.nextLivenessAt) {
      cycle.nextLivenessAt = Date.now() + (options.livenessIntervalMs ?? dependencies.defaults.livenessIntervalMs);
      state.dispatch("persist", { proxy: proxySnapshot });
    }
    if (Date.now() < cycle.nextRefreshAt) return null;
    cycle.nextRefreshAt = Date.now() + (options.executableRefreshIntervalMs ?? dependencies.defaults.executableRefreshIntervalMs);
    const refreshGuard = dependencies.createOperationGuard(options.refreshBudgetMs ?? dependencies.defaults.refreshBudgetMs, shouldStop);
    let revision;
    try {
      revision = await dependencies.findExecutableRefresh(state.currentExecutableRevision, {
        ...options, fsImpl, bundleRefreshState: state.bundleRefreshState, proxyStatus: () => state.proxy.status(),
        signal: refreshGuard.signal, shouldStop, checkActive: refreshGuard.check });
      refreshGuard.check();
    } catch (error) {
      if (error?.code === "APP_SERVER_START_CANCELLED" || shouldStop()) return { code: null, signal: "stop_requested" };
      state.bundleRefreshState.nextAttemptAt = Date.now() + 5000;
      state.dispatch("log", "candidate_refresh_probe_failed", { error: dependencies.publicError(error) });
      revision = null;
    } finally { refreshGuard.close(); }
    if (!cycle.active) return { code: null, signal: "watch_stopped" };
    return revision ? { code: null, signal: "executable_refresh", revision } : null;
  }
  async function initializeService() {
    state.signalCleanup = installSignals();
    persist();
    const journal = options.journal ?? createWakeJournal({ filePath: options.journalPath, fsImpl, now });
    state.proxy = (options.createProxy ?? createCodexAppServerProxy)({
      upstreamPaused: true,
      downstreamPort: options.downstreamPort,
      controlPort: options.controlPort,
      upstreamUrl: state.status.upstreamUrl,
      controlToken,
      instanceToken: lock.metadata.token,
      displayPolicyRoot: options.displayPolicyRoot,
      outerRuntimeRoot: options.outerRuntimeRoot,
      requestTimeoutMs: options.requestTimeoutMs,
      resumeRequestTimeoutMs: options.resumeRequestTimeoutMs,
      requestMetadata: options.requestMetadata,
      journal,
      maintenanceFilePath: options.maintenanceFilePath,
      onEvent: state.bindDispatch("handleProxyEvent"),
    });
    await state.proxy.start();
    persist({ proxy: state.proxy.status() });
    state.startupGuard = createOperationGuard(Math.max(1, startupDeadlineAt - Date.now()), shouldStop);
    const candidates = codexCandidates({
      fsImpl,
      executablePath: options.executablePath,
      localAppData: options.localAppData,
    });
    const orderedCandidates = [...new Set([
      ...candidates,
      state.status.lastKnownGoodExecutablePath,
    ].filter(Boolean))];
    let lastProbeError = null;
    const bundleRoot = options.bundleRoot ?? path.join(path.dirname(options.runtimeStatePath), "codex-runtime-bundles");
    for (const candidate of orderedCandidates) {
      try {
        state.startupGuard.check();
        const preparationOptions = {
          bundleRoot,
          validateBundleSignature: options.validateBundleSignature,
          signal: state.startupGuard.signal,
          shouldStop,
        };
        const candidateBundleRoot = path.dirname(path.dirname(path.resolve(candidate)));
        const isCachedBundle = process.platform === "win32"
          ? candidateBundleRoot.toLowerCase() === path.resolve(bundleRoot).toLowerCase()
          : candidateBundleRoot === path.resolve(bundleRoot);
        const revision = options.executablePath
          ? executableRevision(candidate, fsImpl)
          : isCachedBundle
            ? await verifyCodexRuntimeBundle(candidate, preparationOptions)
            : await prepareCodexRuntimeBundle(candidate, preparationOptions);
        state.startupGuard.check();
        const probed = await runExecutableProbe(revision.executablePath, state.upstreamPort, {
          ...options,
          signal: state.startupGuard.signal,
          timeoutMs: Math.min(options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS, Math.max(1, startupDeadlineAt - Date.now())),
          keepAliveAfterProbe: true,
        });
        state.preparedLaunch = probed?.launched ?? null;
        state.appServer = state.preparedLaunch?.child ?? null;
        if (state.appServer?.pid) createdChildPids.add(state.appServer.pid);
        state.startupGuard.check();
        state.currentExecutable = revision.executablePath;
        state.currentExecutableRevision = revision;
        bundleRefreshState.nextDeepCheckAt = Date.now() + (options.bundleDeepCheckIntervalMs ?? DEFAULT_BUNDLE_DEEP_CHECK_INTERVAL_MS);
        break;
      } catch (error) {
        if (error?.code === "APP_SERVER_START_CANCELLED") throw error;
        if (state.startupGuard.signal.aborted) throw state.startupGuard.signal.reason;
        lastProbeError = error;
        log("candidate_probe_failed", { executablePath: candidate, error: publicError(error) });
      }
    }
    if (!state.currentExecutable) {
      throw lastProbeError ?? new CodexAppServerProxyError("CODEX_APP_SERVER_NOT_FOUND", "没有可用的 Codex App Server 可执行文件");
    }
    persist({
      executablePath: state.currentExecutable,
      lastKnownGoodExecutablePath: state.currentExecutable,
      compatible: true,
      fallbackRequired: false,
      lastError: null,
    });

  }
  async function runBackendCycle() {
      if (state.waitingForDesktop) {
        let nextLivenessAt = 0;
        while (!shouldStop()) {
          const proxySnapshot = state.proxy.status();
          if (Number(proxySnapshot?.clientCount) > 0) {
            state.waitingForDesktop = false;
            state.sawDesktopClient = true;
            log("app_server_desktop_returned", { clientCount: proxySnapshot.clientCount });
            break;
          }
          if (Date.now() >= nextLivenessAt) {
            nextLivenessAt = Date.now() + (options.livenessIntervalMs ?? DEFAULT_LIVENESS_INTERVAL_MS);
            persist({ proxy: proxySnapshot });
          }
          await dependencies.wait(options.lifecyclePollIntervalMs ?? 250);
        }
        if (shouldStop()) return { stop: true };
      }
      const launchGuard = state.startupGuard ?? createOperationGuard(options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS, shouldStop);
      launchGuard.check();
      const launched = state.preparedLaunch ?? (options.spawnAppServer ?? spawnAppServer)(state.currentExecutable, state.upstreamPort, options);
      state.preparedLaunch = null;
      state.appServer = launched.child;
      if (state.appServer?.pid) createdChildPids.add(state.appServer.pid);
      persist({
        appServerPid: state.appServer.pid ?? null,
        appServerStartedAt: now().toISOString(),
      });
      try {
        await waitWithAbort((options.waitForWebSocketReady ?? waitForWebSocketReady)(state.status.upstreamUrl, {
          ...options,
          signal: launchGuard.signal,
          timeoutMs: options.startTimeoutMs,
        }), launchGuard.signal);
        launchGuard.check();
        if (state.appServer.exitCode !== null || state.appServer.signalCode !== null) {
          throw new CodexAppServerProxyError("APP_SERVER_START_EXITED", "受管 App Server 在启动验证期间退出，不能将其它监听者视为启动成功");
        }
        const listenerOwned = await (options.verifyListenerOwner ?? verifyManagedListenerOwner)(state.appServer, state.upstreamPort, { signal: launchGuard.signal });
        launchGuard.check();
        if (!listenerOwned) {
          throw new CodexAppServerProxyError("APP_SERVER_LISTENER_OWNER_MISMATCH", "启动探针对应的监听端口不属于受管子进程，尚未放行桌面消息");
        }
        launchGuard.close();
        if (launchGuard === state.startupGuard) state.startupGuard = null;
        state.proxy.resumeUpstream?.();
        resumeAfterUpstream();
        state.restartFailureCount = 0;
        persist({
          state: "running",
          waitingForDesktop: false,
          compatible: true,
          automationEnabled: true,
          fallbackRequired: false,
          executablePath: state.currentExecutable,
          lastKnownGoodExecutablePath: state.currentExecutable,
          appServerPid: state.appServer.pid ?? null,
          proxy: state.proxy.status(),
          restartFailureCount: state.restartFailureCount,
          lastError: null,
        });
        if (ownsLock()) {
          updateMaintenance(options.maintenanceFilePath, "codexAppServerProxy", null, fsImpl);
          resolveProxyFailureArtifacts(options, state.status, fsImpl, now);
        }
        log("app_server_started", { executablePath: state.currentExecutable, appServerPid: state.appServer.pid ?? null });
        const appServerExit = waitForExit(state.appServer);
        let exit;
        let emptyDesktopRestartState = {
          sawDesktopClient: state.sawDesktopClient || Number(state.proxy.status()?.clientCount ?? 0) > 0,
          emptySinceMs: null,
        };
        while (true) {
          const lifecycleCycle = { active: true, emptyDesktopRestartState,
            nextRefreshAt: Date.now() + (options.executableRefreshIntervalMs ?? DEFAULT_EXECUTABLE_REFRESH_INTERVAL_MS),
            nextLivenessAt: Date.now() + (options.livenessIntervalMs ?? DEFAULT_LIVENESS_INTERVAL_MS) };
          const lifecycleWatch = (async () => {
            while (lifecycleCycle.active) {
              const result = await state.dispatch("watchLifecycleStep", lifecycleCycle);
              if (result) return result;
            }
            return { code: null, signal: "watch_stopped" };
          })();
          exit = await Promise.race([appServerExit, lifecycleWatch]);
          lifecycleCycle.active = false;
          emptyDesktopRestartState = lifecycleCycle.emptyDesktopRestartState;
          if (exit.signal === "desktop_empty_restart" && !canStopEmptyDesktop(state.proxy.status())) {
            log("app_server_desktop_empty_restart_deferred", {
              clientCount: Number(state.proxy.status()?.clientCount ?? 0),
            });
            emptyDesktopRestartState = {};
            continue;
          }
          if (exit.signal !== "executable_refresh" || Number(state.proxy.status()?.clientCount ?? 0) === 0) break;
          log("app_server_executable_refresh_deferred", {
            nextExecutable: exit.revision,
            clientCount: Number(state.proxy.status()?.clientCount ?? 0),
          });
        }
        return state.dispatch("handleBackendExit", exit, launched);
      } catch (error) {
        return state.dispatch("handleBackendFailure", error);
      } finally {
        await state.dispatch("cleanupBackendCycle", launchGuard);
      }

  }
  function handleBackendExit(exit, launched) {
        if (shouldStop()) return { stop: true };
        if (exit.signal === "executable_refresh") {
          const previousExecutable = state.currentExecutableRevision;
          state.currentExecutableRevision = exit.revision;
          state.currentExecutable = exit.revision.executablePath;
          pauseForUpstream("APP_SERVER_REFRESHING", "检测到 Codex 更新，正在安全切换受管 App Server");
          persist({
            state: "refreshing",
            automationEnabled: false,
            executablePath: state.currentExecutable,
            lastKnownGoodExecutablePath: state.currentExecutable,
            lastError: null,
          });
          log("app_server_executable_refresh", { previousExecutable, nextExecutable: exit.revision });
          return { skipBackoff: true };
        }
        if (exit.signal === "desktop_empty_restart") {
          state.restartFailureCount = 0;
          state.waitingForDesktop = true;
          pauseForUpstream("APP_SERVER_WAITING_FOR_DESKTOP", "Desktop 已全部断开，受管 App Server 停止后等待新的 Desktop 连接");
          persist({
            state: "waiting_for_desktop",
            waitingForDesktop: true,
            automationEnabled: false,
            proxy: state.proxy.status(),
            restartFailureCount: state.restartFailureCount,
            lastError: null,
          });
          log("app_server_desktop_empty_restart", {
            emptyForMs: exit.emptyForMs ?? null,
            appServerPid: state.appServer.pid ?? null,
          });
          return { skipBackoff: true };
        }
        state.restartFailureCount += 1;
        pauseForUpstream("APP_SERVER_EXITED", "Codex App Server 意外退出，自动唤醒已暂停并等待透明中转恢复");
        persist({
          state: "restarting",
          automationEnabled: false,
          appServerPid: null,
          proxy: state.proxy.status(),
          restartFailureCount: state.restartFailureCount,
          lastError: {
            code: "APP_SERVER_EXITED",
            message: `App Server 意外退出：code=${exit.code ?? "null"}, signal=${exit.signal ?? "null"}`,
            stderr: launched.stderr(),
          },
        });
        log("app_server_exited", { ...exit, stderr: launched.stderr(), restartFailureCount: state.restartFailureCount });

    return { skipBackoff: false };
  }
  function handleBackendFailure(error) {
        if (error?.code === "APP_SERVER_START_CANCELLED") throw error;
        state.restartFailureCount += 1;
        pauseForUpstream("APP_SERVER_START_FAILED", "Codex App Server 启动失败，自动唤醒已暂停并等待重试");
        persist({
          state: "restarting",
          automationEnabled: false,
          appServerPid: null,
          restartFailureCount: state.restartFailureCount,
          lastError: publicError(error),
        });
        log("app_server_start_failed", { error: publicError(error), restartFailureCount: state.restartFailureCount });

    return { skipBackoff: false };
  }
  async function cleanupBackendCycle(launchGuard) {
        if (launchGuard !== state.startupGuard) launchGuard.close();
        state.proxy.pauseUpstream?.();
        try {
          await terminateManagedAppServer(state.appServer, state.upstreamPort, options);
          state.appServer = null;
          persist({ appServerPid: null }, { allowStorageDegradation: shouldStop() });
        } catch (error) {
          if (error.code !== "APP_SERVER_PORT_STILL_OCCUPIED"
            || (state.appServer.exitCode === null && state.appServer.signalCode === null && processAlive(Number(state.appServer.pid)))) throw error;
          const previousPort = state.upstreamPort;
          excludedUpstreamPorts.add(previousPort);
          state.appServer = null;
          persist({ appServerPid: null });
          if (shouldStop()) {
            log("app_server_retained_port_on_stop", { port: previousPort });
          } else {
            state.upstreamPort = await selectRecoveryUpstreamPort(options.upstreamPort, excludedUpstreamPorts, {
              ...options,
              shouldStop,
            });
            if (shouldStop()) return { stop: true };
            const upstreamUrl = `ws://127.0.0.1:${state.upstreamPort}`;
            state.proxy.setUpstreamUrl(upstreamUrl);
            persist({ upstreamUrl, proxy: state.proxy.status() });
            log("app_server_upstream_port_rotated", { previousPort, upstreamPort: state.upstreamPort });
          }
        }

  }
  async function restartBackoff() {
      if (state.restartFailureCount >= DEFAULT_RESTART_BACKOFF_MS.length) {
        markFatal(new CodexAppServerProxyError(
          "APP_SERVER_RESTART_EXHAUSTED",
          "Codex App Server 连续恢复失败，已暂停 NapCat 自动唤醒并请求下次启动回到原生模式",
          { details: { restartFailureCount: state.restartFailureCount } },
        ));
        requestStop("fallback_required");
        return true;
      }
      const backoff = DEFAULT_RESTART_BACKOFF_MS[Math.min(state.restartFailureCount - 1, DEFAULT_RESTART_BACKOFF_MS.length - 1)];
      await wait(backoff, state.startupGuard?.signal);
      return false;

  }
  async function finishService() {
    try {
      state.startupGuard?.close();
      state.signalCleanup();
      await state.proxy?.close().catch(() => {});
      try {
        await terminateManagedAppServer(state.appServer, state.upstreamPort, options);
        state.appServer = null;
      } catch (error) {
        state.shutdownError = error;
        markFatal(error);
        log("app_server_termination_failed", {
          appServerPid: state.appServer?.pid ?? state.status.appServerPid ?? null,
          error: publicError(error),
        });
      }
      if (ownsLock() && !state.shutdownError && state.status.state !== "degraded") {
        persist({
          state: "stopped",
          waitingForDesktop: false,
          automationEnabled: false,
          appServerPid: null,
          proxy: state.proxy?.status() ?? null,
          stopReason: state.stopReason ?? "completed",
        }, { allowStorageDegradation: true });
      }
      if (options.instanceToken && ownsLock() && !state.shutdownError) {
        persist({ startupTerminalClean: true, startupChildPids: [...createdChildPids], appServerPid: null }, { allowStorageDegradation: true });
      }
      log(ownsLock() ? (state.shutdownError ? "proxy_service_degraded" : "proxy_service_stopped") : "proxy_service_lock_lost", {
        stopReason: state.stopReason ?? "completed",
        appServerPid: state.shutdownError ? (state.appServer?.pid ?? state.status.appServerPid ?? null) : null,
        error: state.shutdownError ? publicError(state.shutdownError) : null,
      });
    } finally {
      lock.release();
    }

  }
  return { runDiagnosticObserver, recordDiagnosticStorageFailure, persist, log, requestStop, installSignals, markFatal,
    pauseForUpstream, resumeAfterUpstream, handleProxyEvent, watchLifecycleStep, initializeService, runBackendCycle,
    handleBackendExit, handleBackendFailure, cleanupBackendCycle, restartBackoff, finishService };
}
