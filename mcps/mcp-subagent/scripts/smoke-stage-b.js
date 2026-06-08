import {
  cancelCascade,
  deleteCascade,
  getSteps,
  getSummary,
  getTrajectory,
  queueMessage,
  removeFromQueue,
  renameCascade,
  sendMessage,
  startCascade,
  waitForStatus,
} from "../src/cascadeOps.js";

const mainId = process.argv[2];
const model = process.env.WSF_STAGE_B_MODEL || "claude-opus-4-8-xhigh";
const onePixelPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

if (!mainId) {
  console.error("usage: node scripts/smoke-stage-b.js <main_id>");
  process.exit(2);
}

const created = [];

async function cleanup() {
  for (const cascadeId of created.reverse()) {
    try {
      await cancelCascade(mainId, cascadeId);
    } catch {}
    try {
      await deleteCascade(mainId, cascadeId);
      console.log(`cleanup deleted ${cascadeId}`);
    } catch (error) {
      console.log(`cleanup failed ${cascadeId}: ${error.message}`);
    }
  }
}

async function newCascade(label) {
  const started = await startCascade(mainId);
  created.push(started.cascadeId);
  await renameCascade(mainId, started.cascadeId, `[subagent-smoke] ${label}`);
  return started;
}

async function testModeAndTitle() {
  const label = `stage-b-mode-${Date.now()}`;
  const expectedTitle = `[subagent-smoke] ${label}`;
  const { cascadeId, metadata } = await newCascade(label);
  await sendMessage(mainId, cascadeId, metadata, "请只回复 STAGE_B_MODE_OK，不要调用工具。", {
    model,
    mode: "CONVERSATIONAL_PLANNER_MODE_PLANNING",
  });
  await waitForStatus(
    mainId,
    cascadeId,
    (item) => String(item?.status || "").includes("IDLE"),
    { timeoutMs: 90000, intervalMs: 2000 },
  );
  await renameCascade(mainId, cascadeId, expectedTitle);
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const summary = await waitForStatus(mainId, cascadeId, Boolean, { timeoutMs: 12000 });
  const trajectory = await getTrajectory(mainId, cascadeId);
  const trajectoryTitle = trajectory?.trajectory?.renamedTitle || trajectory?.trajectory?.name || "";
  const summaryTitle = summary?.renamedTitle || summary?.name || "";
  console.log(`mode/title cid=${cascadeId}`);
  console.log(`renamedTitle=${summaryTitle || trajectoryTitle}`);
  console.log(`summaryKeys=${Object.keys(summary || {}).slice(0, 20).join(",")}`);
  console.log(`summaryConversationalMode=${summary?.conversationalMode || ""}`);
  console.log(`trajectoryConversationalMode=${trajectory?.trajectory?.conversationalMode || ""}`);
  console.log(`titleSet=${summaryTitle.includes("[subagent-smoke]") || trajectoryTitle.includes("[subagent-smoke]")}`);
  return cascadeId;
}

async function testImages() {
  const { cascadeId, metadata } = await newCascade(`stage-b-image-${Date.now()}`);
  await sendMessage(mainId, cascadeId, metadata, "请看这张 1x1 PNG，只回复 STAGE_B_IMAGE_OK。", {
    model,
    images: [{
      base64Data: onePixelPng,
      mimeType: "image/png",
      caption: "stage-b-1x1-smoke",
    }],
  });
  await waitForStatus(mainId, cascadeId, Boolean, { timeoutMs: 12000 });
  const steps = await getSteps(mainId, cascadeId, 0);
  const serialized = JSON.stringify(steps);
  console.log(`image cid=${cascadeId} accepted=true mentionsCaption=${serialized.includes("stage-b-1x1-smoke")}`);
  return cascadeId;
}

async function testQueueRemove() {
  const { cascadeId, metadata } = await newCascade(`stage-b-queue-${Date.now()}`);
  await sendMessage(mainId, cascadeId, metadata, [
    "请慢慢写一篇关于木桶理论的长文，至少 8 小节，每小节 160 字以上。",
    "不要调用工具，只写正文。",
  ].join("\n"), { model });
  const running = await waitForStatus(
    mainId,
    cascadeId,
    (summary) => String(summary?.status || "").includes("RUNNING"),
    { timeoutMs: 30000, intervalMs: 1000 },
  );
  if (!String(running?.status || "").includes("RUNNING")) {
    throw new Error(`cascade did not enter RUNNING, status=${running?.status || "missing"}`);
  }
  const queued = await queueMessage(mainId, cascadeId, metadata, "STAGE_B_QUEUE_REMOVE_MARKER：这条消息应该被 RemoveFromQueue 删除。", { model });
  const queueId = queued.queueId;
  if (!queueId) throw new Error(`QueueCascadeMessage did not return queueId: ${JSON.stringify(queued)}`);
  const removed = await removeFromQueue(mainId, cascadeId, metadata, queueId);
  console.log(`queue-remove cid=${cascadeId} queueId=${queueId} removed=${removed.removed}`);
  if (removed.removed !== true) throw new Error(`RemoveFromQueue returned ${JSON.stringify(removed)}`);
  return cascadeId;
}

try {
  console.log(`stage-b smoke main_id=${mainId} model=${model}`);
  await testModeAndTitle();
  await testImages();
  await testQueueRemove();
  console.log("stage-b smoke ok");
} finally {
  await cleanup();
}
