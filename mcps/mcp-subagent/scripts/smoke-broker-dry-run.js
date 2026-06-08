import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { commandEntry, defaults } from "./config-utils.js";

const configPath = defaults.brokerConfig;
const route = defaults.route;

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

const raw = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "{}";
const config = JSON.parse(raw);
const mcpServers = config.mcpServers || config.servers || {};
const hasSubagent = Object.prototype.hasOwnProperty.call(mcpServers, defaults.key) ||
  Object.prototype.hasOwnProperty.call(mcpServers, "windsurf-subagent") ||
  JSON.stringify(config).includes("/subagent/mcp");
const status = await httpStatus(route);

const draft = {
  mcpServers: {
    [defaults.key]: commandEntry(),
  },
};

console.log(`config=${path.normalize(configPath)}`);
console.log(`route=${route} status=${status ?? "unreachable"}`);
console.log(`alreadyConfigured=${hasSubagent}`);
console.log(`dryRunDraft=${JSON.stringify(draft)}`);
if (hasSubagent) {
  console.log("broker dry-run: subagent route already appears in config");
} else {
  console.log("broker dry-run: config needs backup + append + broker reload/restart before live verification");
}
