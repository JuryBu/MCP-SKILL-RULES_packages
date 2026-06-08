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

const brokerConfig = await readJsonFile(defaults.brokerConfig);
const windsurfConfig = await readJsonFile(defaults.windsurfConfig);
const brokerEntry = brokerConfig.mcpServers?.[defaults.key] || null;
const windsurfEntry = windsurfConfig.mcpServers?.[defaults.key] || null;
const status = await httpStatus(defaults.route);

console.log(`brokerEntry=${brokerEntry ? "yes" : "no"}`);
console.log(`windsurfEntry=${windsurfEntry ? "yes" : "no"}`);
console.log(`route=${defaults.route} status=${status ?? "unreachable"}`);

if (!brokerEntry) throw new Error(`broker config missing mcpServers.${defaults.key}`);
if (!windsurfEntry) throw new Error(`Windsurf config missing mcpServers.${defaults.key}`);
if (status === 404 || status === null) {
  throw new Error("subagent broker route is not loaded; restart/reload broker host and rerun");
}

console.log("broker load smoke ok");
