import http from "node:http";
import { defaults, readJsonFile } from "./config-utils.js";

function httpStatus(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on("error", () => resolve(null));
    req.setTimeout(3000, () => {
      req.destroy();
      resolve(null);
    });
  });
}

function classifyBrokerExposure(brokerEntry) {
  if (!brokerEntry) return "not_configured";
  if (brokerEntry.disabled === true) return "configured_disabled";
  return "configured_enabled";
}

function classifyWindsurfExposure(windsurfEntry) {
  if (!windsurfEntry) return "not_configured";
  if (windsurfEntry.serverUrl === defaults.route) return "broker_route";
  if (windsurfEntry.command || Array.isArray(windsurfEntry.args)) return "stdio_fallback";
  return "configured_unknown";
}

const brokerConfig = await readJsonFile(defaults.brokerConfig);
const windsurfConfig = await readJsonFile(defaults.windsurfConfig);
const brokerEntry = brokerConfig.mcpServers?.[defaults.key] || null;
const windsurfEntry = windsurfConfig.mcpServers?.[defaults.key] || null;
const routeStatus = await httpStatus(defaults.route);

const report = {
  ok: true,
  checked_at: new Date().toISOString(),
  broker_config: defaults.brokerConfig,
  windsurf_config: defaults.windsurfConfig,
  key: defaults.key,
  broker_exposure: classifyBrokerExposure(brokerEntry),
  windsurf_exposure: classifyWindsurfExposure(windsurfEntry),
  route: defaults.route,
  route_status: routeStatus ?? "unreachable",
  notes: [],
};

if (report.broker_exposure === "configured_enabled") {
  report.notes.push("Antigravity/broker config contains enabled subagent command entry; AG tool panel may show subagent depending on host UI filtering.");
}
if (report.windsurf_exposure === "broker_route") {
  report.notes.push("Windsurf config references broker route; route should become non-404 after broker reload/restart.");
}
if (report.windsurf_exposure === "stdio_fallback") {
  report.notes.push("Windsurf config uses stdio fallback; processGuard singleton/parent checks apply.");
}
if (routeStatus === 404 || routeStatus === null) {
  report.ok = false;
  report.notes.push("subagent broker route is not currently loaded; this is expected before live apply/reload.");
}

console.log(JSON.stringify(report, null, 2));
