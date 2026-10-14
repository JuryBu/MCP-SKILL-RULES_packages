import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { createCodexAppServerProxy } from "./codex-app-server-proxy.mjs";
import { createInnerProxyCoordinator } from "./inner-proxy-coordinator.mjs";
import { createInnerNativeTurnSource } from "./inner-native-turn-source.mjs";

const validPort = value => Number.isInteger(value) && value > 0 && value <= 65535;

export function createInnerProxySession(configuration, onEvent = () => {}) {
  if (configuration.mode !== "isolated") throw new Error("INNER_SESSION_ISOLATED_ONLY");
  const root = fs.realpathSync(configuration.checkpointRoot);
  const relative = path.relative(fs.realpathSync(os.tmpdir()), root);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("INNER_SESSION_TEMP_REQUIRED");
  const upstream = new URL(configuration.appServerUrl);
  if (upstream.protocol !== "ws:" || upstream.hostname !== "127.0.0.1" || upstream.username || upstream.password
    || upstream.pathname !== "/" || upstream.search || upstream.hash || !validPort(Number(upstream.port))) throw new Error("INNER_SESSION_LOOPBACK_REQUIRED");
  if (!validPort(configuration.downstreamPort) || !validPort(configuration.controlPort)
    || configuration.downstreamPort === configuration.controlPort) throw new Error("INNER_SESSION_PORTS_REQUIRED");
  const coordinator = createInnerProxyCoordinator({ ownerId: configuration.ownerId, nativeSourceId: configuration.nativeSourceId,
    checkpointRoot: root, upstreamOrigin: configuration.upstreamOrigin, port: configuration.innerPort ?? 0,
    nodeExecutable: configuration.nodeExecutable, environment: configuration.environment, onEvent });
  const nativeSource = createInnerNativeTurnSource({ sourceId: configuration.nativeSourceId, coordinator });
  const proxy = createCodexAppServerProxy({ upstreamUrl: configuration.appServerUrl,
    downstreamPort: configuration.downstreamPort, controlPort: configuration.controlPort,
    controlToken: crypto.randomBytes(32).toString("hex"), onNativeTurn: message => nativeSource.observe(message),
    onEvent: event => {
      if (event.type === "upstream_session_lost") nativeSource.invalidate("APP_SERVER_EVENT_CONNECTION_LOST");
      onEvent(event);
    } });
  let started = false;
  let closed = false;
  let innerEndpoint = null;
  function requireReady() {
    if (!started || closed || !nativeSource.status().healthy) throw new Error("INNER_SESSION_NOT_READY");
  }
  return {
    async start() {
      if (started || closed) throw new Error("INNER_SESSION_ALREADY_STARTED");
      started = true;
      try {
        innerEndpoint = await coordinator.start(configuration.initial);
        await proxy.start();
        return { innerEndpoint, downstreamUrl: proxy.status().downstreamUrl, mode: "isolated" };
      } catch (error) {
        closed = true;
        await proxy.close();
        await coordinator.close();
        throw error;
      }
    },
    async prepareCandidate(specification) { requireReady(); return coordinator.prepareCandidate(specification); },
    async migrate(request) { requireReady(); return coordinator.migrate(request); },
    status() { return { started, closed, mode: "isolated", innerEndpoint, nativeSource: nativeSource.status(),
      coordinator: coordinator.status(), outer: proxy.status() }; },
    async close() {
      if (closed) return;
      const status = coordinator.status();
      if (status.transactionActive || status.threads.some(thread => thread.phase === "active" || thread.activeHttp > 0)) {
        throw new Error("INNER_SESSION_BUSY");
      }
      closed = true;
      await proxy.close();
      await coordinator.close();
    },
  };
}
