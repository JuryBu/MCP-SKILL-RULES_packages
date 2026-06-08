import { getAccessToken } from "./auth.js";

export async function createMetadata() {
  const { accessToken } = await getAccessToken();
  return {
    ideName: "windsurf",
    ideVersion: "3.0.28",
    extensionName: "windsurf",
    extensionVersion: "1.0.0",
    apiKey: accessToken,
  };
}

export function createCascadeConfig({ model, mode } = {}) {
  const plannerConfig = {};
  if (model) {
    plannerConfig.requestedModelUid = model;
  }
  if (mode) {
    plannerConfig.conversational = {
      plannerMode: mode,
    };
  }
  return { plannerConfig };
}
