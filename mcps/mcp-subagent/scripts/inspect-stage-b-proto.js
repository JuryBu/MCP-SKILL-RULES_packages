import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
const defaultBundle = path.join(localAppData, "Programs", "Devin", "resources", "app", "extensions", "windsurf", "dist", "extension.js");
const bundlePath = process.env.WSF_EXTENSION_JS || defaultBundle;
const text = fs.readFileSync(bundlePath, "utf8");

function extractType(typeName) {
  const marker = `typeName="${typeName}"`;
  const index = text.indexOf(marker);
  if (index < 0) return null;
  const start = Math.max(0, text.lastIndexOf("class ", index));
  const end = text.indexOf("}}e.", index);
  return text.slice(start, Math.min(end > 0 ? end + 2 : index + 2600, index + 3000));
}

function requireType(typeName) {
  const source = extractType(typeName);
  if (!source) throw new Error(`missing proto type ${typeName}`);
  return source;
}

const checks = {
  modeEnum: /CONVERSATIONAL_PLANNER_MODE_PLANNING/.test(text) &&
    /CONVERSATIONAL_PLANNER_MODE_READ_ONLY/.test(text) &&
    /CONVERSATIONAL_PLANNER_MODE_NO_TOOL/.test(text),
  sendImages: /typeName="exa.language_server_pb.SendUserCascadeMessageRequest"[\s\S]*name:"images"[\s\S]*T:n\.ImageData/.test(text),
  imageFields: /typeName="exa.codeium_common_pb.ImageData"[\s\S]*name:"base64_data"[\s\S]*name:"mime_type"[\s\S]*name:"caption"/.test(text),
  removeQueue: /typeName="exa.language_server_pb.RemoveFromQueueRequest"[\s\S]*name:"cascade_id"[\s\S]*name:"queue_id"/.test(text),
  rename: /typeName="exa.language_server_pb.RenameCascadeTrajectoryRequest"[\s\S]*name:"cascade_id"[\s\S]*name:"name"/.test(text),
  mcpConfig: /typeName="exa.cortex_pb.McpToolConfig"[\s\S]*name:"force_disable"[\s\S]*name:"max_output_bytes"/.test(text),
  taskSubagentConfig: /typeName="exa.cortex_pb.TaskSubagentToolConfig"/.test(text),
};

for (const [name, ok] of Object.entries(checks)) {
  if (!ok) throw new Error(`proto check failed: ${name}`);
}

console.log(`bundle=${bundlePath}`);
console.log("mode enum: DEFAULT=1 READ_ONLY=2 NO_TOOL=3 EXPLORE=4 PLANNING=5 AUTO=6");
console.log("ImageData: base64Data, mimeType, caption");
console.log("Send/Queue images: repeated ImageData");
console.log("RemoveFromQueue: cascadeId + queueId; response removed");
console.log("RenameCascadeTrajectory: cascadeId + name");
console.log("McpToolConfig: forceDisable + maxOutputBytes; no per-server allowlist here");
console.log("TaskSubagentToolConfig exists separately from McpToolConfig");
console.log(requireType("exa.language_server_pb.RemoveFromQueueRequest").slice(0, 500));
