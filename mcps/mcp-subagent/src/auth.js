import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const helperPath = path.join(__dirname, "helpers", "win-wsf-auth.py");

function runHelper(action, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("python", [helperPath, action], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`auth helper timed out for action=${action}`));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      let payload;
      try {
        payload = JSON.parse(stdout.trim());
      } catch (error) {
        reject(new Error(`auth helper returned invalid JSON: ${error.message}; stderr=${stderr.trim()}`));
        return;
      }
      if (code !== 0 || !payload.ok) {
        reject(new Error(payload?.error || stderr.trim() || `auth helper exited ${code}`));
        return;
      }
      resolve(payload);
    });
  });
}

export function redactToken(token) {
  if (!token) return null;
  if (token.length <= 12) return `${token.slice(0, 2)}...`;
  return `${token.slice(0, 6)}...${token.slice(-4)} (${token.length} chars)`;
}

export async function getAccessToken(options = {}) {
  const payload = await runHelper("token", options);
  return {
    accessToken: payload.accessToken,
    accountLabel: payload.accountLabel,
    localStatePath: payload.localStatePath,
    stateDbPath: payload.stateDbPath,
  };
}

export async function discoverLanguageServerCandidates(options = {}) {
  const payload = await runHelper("discover", options);
  return payload.candidates || [];
}
