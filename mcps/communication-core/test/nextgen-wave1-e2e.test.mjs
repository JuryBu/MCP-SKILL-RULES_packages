import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CommunicationCore } from "../src/core.mjs";
import { CoreError, digest, identityKey, normalizeIdentity } from "../src/contracts.mjs";
import { MessageStore } from "../src/store.mjs";
import { MockAdapter } from "../src/adapters/mock.mjs";
import { HostConversationContent } from "../src/host-conversation-content.mjs";
import { HostStatusProvider } from "../src/host-status.mjs";
import { RelayOutboxStore } from "../src/remote-core-dispatcher.mjs";
import { batchRecipientNotice, renderHostMessage } from "../src/adapters/host-message.mjs";
import * as relayEnvelope from "../src/relay-envelope.mjs";
import {
  deriveBatchDedupeKeys,
  formatRecipientGroupForHost,
  planMultiRecipientDispatch,
  projectBatchSendReceipt,
  renderPeerRecipientsForReceiver,
  validateAndDedupeRecipients,
} from "../src/multi-recipient.mjs";
import {
  InMemoryRelayBus,
  NapcatRelayTransport,
  RelayError,
  projectRelayRoutesForAddressBook,
} from "../src/transports/napcat-relay.mjs";
import {
  RemoteCoreDispatcher,
  createRemoteMachineProviders,
} from "../src/remote-core-dispatcher.mjs";

const DEV_MACHINE = "development";
const TRAIN_MACHINE = "training";
const THIRD_MACHINE = "machine_c";

const DEV_AGY = { machine_id: DEV_MACHINE, host: "antigravity", surface: "desktop", conversation_id: "conv-dev-agy-1" };
const DEV_LOCAL_PEER = { machine_id: DEV_MACHINE, host: "codex", surface: "desktop", conversation_id: "conv-dev-codex-2" };
const TRAIN_CODEX = { machine_id: TRAIN_MACHINE, host: "codex", surface: "desktop", conversation_id: "conv-train-codex-1" };
const TRAIN_AGY = { machine_id: TRAIN_MACHINE, host: "antigravity", surface: "desktop", conversation_id: "conv-train-agy-2" };
const THIRD_CODEX = { machine_id: THIRD_MACHINE, host: "codex", surface: "desktop", conversation_id: "conv-third-codex-1" };

/**
 * 复刻现役 mcps/napcat-mcp/src/core.mjs:L613-673 的旧版结构化扫描逻辑，
 * 验证新 [COMM_RELAY_V1] 帧与旧解析器零碰撞。
 */
function legacyStructuredTaskMetadata(text) {
  const metadata = {
    taskId: "",
    sourceMachine: "",
    targetMachine: "",
    deliveryId: "",
    messageType: "business",
    requestId: "",
    sourceConversationId: "",
    targetConversationId: "",
    receiptStage: "",
    deliveryMessageSeq: "",
    proposedTaskId: "",
    previousTaskId: "",
    routeKey: "",
    replyRequired: false,
    expectedReply: "",
    replyDeadlineAt: "",
    nextCheckAt: "",
  };
  const normalized = String(text).replace(/\r\n|\r/g, "\n");
  const firstLine = normalized.split("\n").find(line => line.trim())?.trim() ?? "";
  if (firstLine === "[Codex][CONNECTION_REQUEST]") metadata.messageType = "connection_request";
  else if (firstLine === "[Codex][DELIVERY_RECEIPT]") metadata.messageType = "delivery_receipt";
  else if (firstLine === "[Codex][OWNER_REPLY]") metadata.messageType = "owner_reply";
  for (const line of normalized.split("\n")) {
    let m;
    if ((m = line.match(/^(?:任务|task_id)\s*[：:]\s*(.+)$/i))) metadata.taskId = m[1].trim();
    if ((m = line.match(/^(?:来源机器|source_machine)\s*[：:]\s*(.+)$/i))) metadata.sourceMachine = m[1].trim();
    if ((m = line.match(/^(?:目标机器|target_machine)\s*[：:]\s*(.+)$/i))) metadata.targetMachine = m[1].trim();
    if ((m = line.match(/^delivery_id\s*[：:]\s*(.+)$/i))) metadata.deliveryId = m[1].trim();
    if ((m = line.match(/^request_id\s*[：:]\s*(.+)$/i))) metadata.requestId = m[1].trim();
    if ((m = line.match(/^source_conversation_id\s*[：:]\s*(.+)$/i))) metadata.sourceConversationId = m[1].trim();
    if ((m = line.match(/^target_conversation_id\s*[：:]\s*(.+)$/i))) metadata.targetConversationId = m[1].trim();
    if ((m = line.match(/^receipt_stage\s*[：:]\s*(.+)$/i))) metadata.receiptStage = m[1].trim();
    if ((m = line.match(/^delivery_message_seq\s*[：:]\s*(.+)$/i))) metadata.deliveryMessageSeq = m[1].trim();
    if ((m = line.match(/^proposed_task_id\s*[：:]\s*(.+)$/i))) metadata.proposedTaskId = m[1].trim();
    if ((m = line.match(/^previous_task_id\s*[：:]\s*(.+)$/i))) metadata.previousTaskId = m[1].trim();
    if ((m = line.match(/^(?:route_key|路由)\s*[：:]\s*(.+)$/i))) metadata.routeKey = m[1].trim();
    if ((m = line.match(/^reply_required\s*[：:]\s*(true|false)$/i))) metadata.replyRequired = m[1].toLowerCase() === "true";
    if ((m = line.match(/^expected_reply\s*[：:]\s*(.+)$/i))) metadata.expectedReply = m[1].trim();
    if ((m = line.match(/^reply_deadline_at\s*[：:]\s*(.+)$/i))) metadata.replyDeadlineAt = m[1].trim();
    if ((m = line.match(/^next_check_at\s*[：:]\s*(.+)$/i))) metadata.nextCheckAt = m[1].trim();
  }
  return metadata;
}

function makeTarget(identity, bindingId) {
  return {
    ...identity,
    binding_id: bindingId,
    binding_generation: 1,
    adapter_id: "mock",
    capabilities: { next_model_boundary: true, when_idle: true },
  };
}

function createTempDir(prefix = "comm-core-wave1-e2e-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

function createThreeNodeBus({ clockRef } = {}) {
  const bus = new InMemoryRelayBus({
    frameCodec: relayEnvelope,
    now: () => (clockRef ? clockRef.now : Date.now()),
  });
  bus.registerMachine({ machine_id: DEV_MACHINE, qq_id: "acct-dev" });
  bus.registerMachine({ machine_id: TRAIN_MACHINE, qq_id: "acct-train" });
  bus.registerMachine({ machine_id: THIRD_MACHINE, qq_id: "acct-third" });

  bus.registerRoute({
    relay_key: "rel-dev-train",
    group_id: "grp-dev-train-v1",
    expected_group_name: "研发与训练中继群",
    members: [DEV_MACHINE, TRAIN_MACHINE],
    allow_recipient_list_disclosure: true,
    allow_file_bundle_write: true,
    legacy_training_coexistence: false,
  });
  bus.registerRoute({
    relay_key: "rel-dev-third",
    group_id: "grp-dev-third-v1",
    expected_group_name: "研发与第三节点中继群",
    members: [DEV_MACHINE, THIRD_MACHINE],
    allow_recipient_list_disclosure: false,
    allow_file_bundle_write: true,
    legacy_training_coexistence: false,
  });
  bus.registerRoute({
    relay_key: "rel-legacy-coexist",
    group_id: "grp-legacy-coexist-v1",
    expected_group_name: "旧任务共存过渡群",
    members: [TRAIN_MACHINE, THIRD_MACHINE],
    allow_recipient_list_disclosure: true,
    allow_file_bundle_write: true,
    legacy_training_coexistence: true,
  });
  return bus;
}

function snapshotResourceCounts() {
  const counts = new Map();
  for (const kind of process.getActiveResourcesInfo()) {
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return counts;
}

function diffResourceCounts(before, after) {
  const leaks = [];
  for (const [kind, count] of after.entries()) {
    const prev = before.get(kind) ?? 0;
    if (count > prev) leaks.push(`${kind}:+${count - prev}`);
  }
  return leaks;
}

test("E2E-1: 3-node cross-machine send, shared RelayAckStore transaction, out-of-order & forged ACK guards, and saveSender", async context => {
  const baselineResources = snapshotResourceCounts();
  const dir = createTempDir();
  const clock = { now: Date.parse("2026-11-27T08:00:00.000Z") };
  const bus = createThreeNodeBus({ clockRef: clock });

  // 训练机侧挂载真实的 CommunicationCore + MessageStore + ConversationAddressBook + RelayAckStore
  const trainStore = new MessageStore({ filePath: join(dir, "train-core.sqlite") });
  const trainAdapter = new MockAdapter();
  const trainTargets = [
    makeTarget(TRAIN_CODEX, "train-codex-binding"),
    makeTarget(TRAIN_AGY, "train-agy-binding"),
  ];
  const trainPrincipals = [
    {
      id: "p-train-codex",
      token: "tok-train-codex",
      identity: TRAIN_CODEX,
      allowed_targets: ["train-agy-binding"],
      origin_kinds: ["agent_message"],
      address_book_identity_bound: true,
    },
    {
      id: "p-train-agy",
      token: "tok-train-agy",
      identity: TRAIN_AGY,
      allowed_targets: ["train-codex-binding"],
      origin_kinds: ["agent_message"],
      address_book_identity_bound: true,
    },
    {
      id: "p-remote-relay",
      token: "tok-remote-relay",
      identity: { machine_id: DEV_MACHINE, host: "antigravity", surface: "desktop", conversation_id: "*" },
      caller_scope: { machine_id: DEV_MACHINE, host: "antigravity", surface: "desktop" },
      allowed_targets: ["train-codex-binding", "train-agy-binding"],
      origin_kinds: ["agent_message"],
    },
  ];
  const trainCore = new CommunicationCore({
    store: trainStore,
    targets: trainTargets,
    principals: trainPrincipals,
    adapters: { mock: trainAdapter },
    now: () => clock.now,
  });

  const devTransport = bus.createTransportFor(DEV_MACHINE);
  const trainTransport = bus.createTransportFor(TRAIN_MACHINE);
  const thirdTransport = bus.createTransportFor(THIRD_MACHINE);

  // 将 NapCat status 返回的机器路由脱敏投影直接接入训练机真实 ConversationAddressBook
  const trainStatusResp = await trainTransport.status();
  const projectedRoutes = projectRelayRoutesForAddressBook(trainStatusResp);
  assert.ok(projectedRoutes.length >= 1);
  trainCore.attachAddressBook({
    machineId: TRAIN_MACHINE,
    sharedContacts: [
      { id: "shared-train-codex", alias: "训练机共有Codex", target: TRAIN_CODEX, note: "共有条目" },
    ],
    machineRoutes: projectedRoutes,
  });

  // 给 trainCore 附挂共享 RelayAckStore（同库同步事务），并在 onReady 时自动唤醒 trainDispatcher
  let trainDispatcher;
  const ackStore = trainCore.attachRelayAcknowledgements({
    onReady: () => trainDispatcher?.triggerFlush(),
  });
  await trainCore.start();

  // 记录跨机入站消息的 source_identity_verified 供 saveSender 联动测试
  const inboundSourceVerification = new Map();
  const receivedDeliveries = [];

  trainDispatcher = new RemoteCoreDispatcher({
    localMachineId: TRAIN_MACHINE,
    transport: trainTransport,
    ackStore,
    frameCodec: relayEnvelope,
    now: () => clock.now,
    localHandlers: {
      async deliverInboundMessage(inbound) {
        const deliveries = [];
        for (const ep of inbound.recipients) {
          const parsed = relayEnvelope.parseEndpoint(ep);
          const recipient = { machine_id: TRAIN_MACHINE, ...parsed };
          const targetObj = trainTargets.find(t => identityKey(t) === identityKey(recipient));
          assert.ok(targetObj, `未找到本地目标 ${ep}`);
          const srcParsed = relayEnvelope.parseEndpoint(inbound.source);
          const caller = { machine_id: inbound.from_machine, ...srcParsed };
          const sent = await trainCore.sendMessage(
            { principal_id: "p-remote-relay" },
            {
              caller,
              target: {
                machine_id: targetObj.machine_id,
                host: targetObj.host,
                surface: targetObj.surface,
                conversation_id: targetObj.conversation_id,
                binding_id: targetObj.binding_id,
                binding_generation: targetObj.binding_generation,
              },
              origin: { kind: "agent_message", channel: "remote_relay", source_ref: inbound.frame.relay_id },
              dedupe_key: `in:${inbound.frame.relay_id}:${targetObj.conversation_id}`.slice(0, 120),
              text: inbound.body,
              expires_at: new Date(clock.now + 3600_000).toISOString(),
            },
          );
          const localMessageId = sent.message.message_id;
          inboundSourceVerification.set(localMessageId, {
            verified: inbound.source_identity_verified,
            sender: caller,
            recipient,
          });
          // 必须同步在本地登记原路由映射（使用 RelayAckStore.bindInbound）
          receivedDeliveries.push({ localMessageId, recipient, body: inbound.body, verified: inbound.source_identity_verified });
          deliveries.push({
            local_message_id: localMessageId,
            target_key: identityKey(recipient),
            origin_message_id: inbound.meta?.origin_message_id ?? inbound.meta?.request_id ?? inbound.frame.relay_id,
            delivery_status: "accepted",
          });
        }
        return { deliveries };
      },
    },
  });

  const devAckEvents = [];
  const devDispatcher = new RemoteCoreDispatcher({
    localMachineId: DEV_MACHINE,
    transport: devTransport,
    frameCodec: relayEnvelope,
    now: () => clock.now,
    localHandlers: {
      applyRemoteDeliveryAck(info) {
        devAckEvents.push({ type: "delivery_ack", ...info });
      },
      applyRemoteProcessingAck(info) {
        devAckEvents.push({ type: "processing_ack", ...info });
      },
    },
  });

  const thirdDispatcher = new RemoteCoreDispatcher({
    localMachineId: THIRD_MACHINE,
    transport: thirdTransport,
    frameCodec: relayEnvelope,
    now: () => clock.now,
  });

  let resourcesClosed = false;
  const closeAll = async () => {
    if (resourcesClosed) return;
    resourcesClosed = true;
    await devDispatcher.close();
    await trainDispatcher.close();
    await thirdDispatcher.close();
    await devTransport.close();
    await trainTransport.close();
    await thirdTransport.close();
    await trainCore.close();
    trainStore.close();
  };
  context.after(async () => {
    await closeAll();
    rmSync(dir, { recursive: true, force: true });
  });

  // 1) 开发机 -> 训练机发信（独立验证源身份 sourceIdentityVerified=true）
  const dispatchRes = await devDispatcher.dispatchMessage({
    dedupeKey: "e2e-msg-1",
    targetMachine: TRAIN_MACHINE,
    source: DEV_AGY,
    recipients: [TRAIN_CODEX],
    body: "第一波三节点端到端实测消息",
    meta: { origin_message_id: "orig-msg-1" },
    sourceIdentityVerified: true,
  });
  assert.equal(dispatchRes.transport_mode, "text_relay");
  assert.equal(dispatchRes.stages.relay_accepted.ok, true);

  // 训练机轮询入站 -> 入库 -> bindInbound -> 自动回发 delivery_ack
  const trainPoll = await trainDispatcher.pollOnce();
  assert.equal(trainPoll.processed, 1);
  assert.equal(receivedDeliveries.length, 1);
  assert.equal(receivedDeliveries[0].verified, true);
  const trainLocalMsgId = receivedDeliveries[0].localMessageId;

  // 开发机轮询收到 delivery_ack，推进 4 层状态至 remote_core_persisted + target_delivered
  await devDispatcher.pollOnce();
  const afterDelivery = devDispatcher.getOutboundStatus(dispatchRes.relay_id);
  assert.equal(afterDelivery.stages.remote_core_persisted.ok, true);
  assert.equal(afterDelivery.stages.target_delivered.status, "accepted");

  // 2) 训练机对话真实调用 trainCore.ackProcessing("processing") 与 "done"
  //    验证同事务自动写入 RelayAckStore 并由 onReady 触发跨机 processing_ack 刷盘！
  const trainRec = trainCore.result(trainLocalMsgId);
  trainCore.ackProcessing(
    { principal_id: "p-train-codex" },
    {
      caller: TRAIN_CODEX,
      message_id: trainLocalMsgId,
      delivery_id: trainRec.delivery.delivery_id,
      binding_generation: 1,
      processing: "processing",
    },
  );
  await new Promise(resolve => setImmediate(resolve));
  await trainDispatcher.flushOutbox();
  await devDispatcher.pollOnce();
  assert.equal(devDispatcher.getOutboundStatus(dispatchRes.relay_id).stages.target_processing.status, "processing");

  trainCore.ackProcessing(
    { principal_id: "p-train-codex" },
    {
      caller: TRAIN_CODEX,
      message_id: trainLocalMsgId,
      delivery_id: trainRec.delivery.delivery_id,
      binding_generation: 1,
      processing: "done",
    },
  );
  await new Promise(resolve => setImmediate(resolve));
  await trainDispatcher.flushOutbox();
  await devDispatcher.pollOnce();
  const afterDone = devDispatcher.getOutboundStatus(dispatchRes.relay_id);
  assert.equal(afterDone.stages.target_processing.status, "done");
  assert.equal(afterDone.stages.target_processing.ack_seq, 2);

  // 3) 乱序旧 processing_ack 不能回退 done；第三节点伪造 processing_ack 被 ack_pairing_mismatch 拦下
  const staleRes = await devDispatcher.handleInboundEvent({
    event_id: "evt-stale-ack",
    relay_key: dispatchRes.stages.relay_accepted.relay_key,
    group_id: dispatchRes.stages.relay_accepted.group_id,
    route_generation: dispatchRes.stages.relay_accepted.route_generation,
    source_machine: TRAIN_MACHINE,
    sender_verified: true,
    frame: {
      relay_id: "rly-stale-ack",
      op: "processing_ack",
      from_machine: TRAIN_MACHINE,
      to_machine: DEV_MACHINE,
      source: "codex/desktop/conv-train-codex-1",
      recipients: ["antigravity/desktop/conv-dev-agy-1"],
      in_reply_to: dispatchRes.relay_id,
      body: "",
      meta: {
        hop_count: 1,
        origin_relay_id: dispatchRes.relay_id,
        origin_message_id: "orig-msg-1",
        ack_seq: 1,
        processing: "processing",
      },
    },
  });
  assert.equal(staleRes.code, "stale_processing_ack");
  assert.equal(devDispatcher.getOutboundStatus(dispatchRes.relay_id).stages.target_processing.status, "done");

  const forgedRes = await devDispatcher.handleInboundEvent({
    event_id: "evt-forged-ack",
    relay_key: "rel-dev-third",
    group_id: "grp-dev-third-v1",
    route_generation: 1,
    source_machine: THIRD_MACHINE,
    sender_verified: true,
    frame: {
      relay_id: "rly-forged-ack",
      op: "processing_ack",
      from_machine: THIRD_MACHINE,
      to_machine: DEV_MACHINE,
      source: "codex/desktop/conv-third-codex-1",
      recipients: ["antigravity/desktop/conv-dev-agy-1"],
      in_reply_to: dispatchRes.relay_id,
      body: "",
      meta: {
        hop_count: 1,
        origin_relay_id: dispatchRes.relay_id,
        origin_message_id: "orig-msg-other",
        ack_seq: 99,
        processing: "failed",
      },
    },
  });
  assert.equal(forgedRes.code, "ack_pairing_mismatch");

  // 4) 双层 source_identity_verified 联动真实 ConversationAddressBook.saveSender
  const dispatchUnverified = await devDispatcher.dispatchMessage({
    dedupeKey: "e2e-msg-unverified",
    targetMachine: TRAIN_MACHINE,
    source: DEV_AGY,
    recipients: [TRAIN_CODEX],
    body: "来自通配入口的普通跨机消息",
    sourceIdentityVerified: false,
  });
  await trainDispatcher.pollOnce();
  assert.equal(receivedDeliveries.length, 2);
  assert.equal(receivedDeliveries[1].verified, false);
  const unverifiedLocalId = receivedDeliveries[1].localMessageId;

  // 在独立 AddressBook 上模拟 readInbound 依赖 source_identity_verified 双层证明
  const { ConversationAddressBook } = await import("../src/conversation-address-book.mjs");
  const { DatabaseSync } = await import("node:sqlite");
  const bookDb = new DatabaseSync(":memory:");
  let bookDbClosed = false;
  context.after(() => {
    if (!bookDbClosed) {
      bookDbClosed = true;
      bookDb.close();
    }
  });
  const book = new ConversationAddressBook({
    database: bookDb,
    machineId: TRAIN_MACHINE,
    readInbound: (actor, msgId) => {
      const rec = inboundSourceVerification.get(msgId);
      if (!rec || identityKey(rec.recipient) !== identityKey(actor)) return null;
      return { message_id: msgId, sender: rec.sender, recipient: rec.recipient, source_verified: rec.verified === true };
    },
  });
  // 通配来源不可一键收录
  assert.throws(
    () => book.saveSender(trainPrincipals[0], { message_id: unverifiedLocalId, alias: "不可信来源" }),
    err => err instanceof CoreError && err.code === "message_not_recipient",
  );
  // 独立背书来源可一键收录
  const savedContact = book.saveSender(trainPrincipals[0], { message_id: trainLocalMsgId, alias: "开发机主反重力" });
  assert.equal(savedContact.target.machine_id, DEV_MACHINE);
  assert.equal(savedContact.target.conversation_id, DEV_AGY.conversation_id);

  // 验证关闭后零活跃资源残留（在当前用例内部显式核验）
  await closeAll();
  if (!bookDbClosed) {
    bookDbClosed = true;
    bookDb.close();
  }

  const remaining = diffResourceCounts(baselineResources, snapshotResourceCounts());
  assert.deepEqual(remaining, []);
});

test("E2E-2: multi-recipient single-frame cross-machine fan-out, per-receiver AddressBook alias rendering, human-channel guard, and < 9 KiB 16-target receipt", async context => {
  const dir = createTempDir();
  const bus = createThreeNodeBus();
  const devTransport = bus.createTransportFor(DEV_MACHINE);
  const trainTransport = bus.createTransportFor(TRAIN_MACHINE);
  const trainStore = new MessageStore({ filePath: join(dir, "train-multi.sqlite") });
  const trainCore = new CommunicationCore({
    store: trainStore,
    targets: [makeTarget(TRAIN_CODEX, "b-tc"), makeTarget(TRAIN_AGY, "b-ta")],
    principals: [
      { id: "p-tc", token: "t-tc", identity: TRAIN_CODEX, allowed_targets: ["b-ta"], origin_kinds: ["agent_message"], address_book_identity_bound: true },
      { id: "p-ta", token: "t-ta", identity: TRAIN_AGY, allowed_targets: ["b-tc"], origin_kinds: ["agent_message"], address_book_identity_bound: true },
    ],
    adapters: { mock: new MockAdapter() },
  });
  trainCore.attachAddressBook({
    machineId: TRAIN_MACHINE,
    sharedContacts: [
      { id: "sh-tc", alias: "训练共有Codex", target: TRAIN_CODEX, note: "" },
      { id: "sh-dev", alias: "开发机本机搭档", target: DEV_LOCAL_PEER, note: "" },
    ],
  });
  // TRAIN_CODEX 给 TRAIN_AGY 起个人别名，验证按各自通讯录独立译名
  trainCore.contacts(
    { principal_id: "p-tc" },
    { caller: TRAIN_CODEX, action: "save", alias: "我的训练反重力", target: TRAIN_AGY, note: "个人别名" },
  );

  let sendFrameCount = 0;
  const origSendFrame = devTransport.sendFrame.bind(devTransport);
  devTransport.sendFrame = async (...args) => {
    sendFrameCount += 1;
    return origSendFrame(...args);
  };

  const renderedOnTrain = new Map();
  const trainDispatcher = new RemoteCoreDispatcher({
    localMachineId: TRAIN_MACHINE,
    transport: trainTransport,
    frameCodec: relayEnvelope,
    localHandlers: {
      async deliverInboundMessage(inbound) {
        const allIdentities = inbound.all_recipients.map(str => {
          const [machine_id, host, surface, conversation_id] = str.split("/");
          return normalizeIdentity({ machine_id, host, surface, conversation_id });
        });
        const deliveries = [];
        for (const ep of inbound.recipients) {
          const parsed = relayEnvelope.parseEndpoint(ep);
          const receiver = { machine_id: TRAIN_MACHINE, ...parsed };
          const { recipient_labels, summaryLine } = renderPeerRecipientsForReceiver({
            receiver,
            allRecipients: allIdentities,
            resolveDisplayName: (r, p) => trainCore.resolveDisplayName(r, p),
          });
          const msgObj = {
            message_id: `msg-${receiver.conversation_id}`,
            batch_meta: {
              batch_id: inbound.meta.batch_id,
              recipient_group: { batch_id: inbound.meta.batch_id, recipients: allIdentities },
              recipient_labels,
            },
            envelope: {
              caller: { machine_id: inbound.from_machine, ...relayEnvelope.parseEndpoint(inbound.source) },
              target: { ...receiver, binding_id: "b", binding_generation: 1 },
              origin: { kind: "agent_message", channel: "remote_relay", source_ref: inbound.frame.relay_id },
              text: inbound.body,
            },
          };
          const baseRendered = renderHostMessage({
            message: { ...msgObj, batch_meta: undefined },
            delivery: { delivery_id: `del-${receiver.conversation_id}` },
          });
          const formatted = formatRecipientGroupForHost({
            host: receiver.host,
            baseRenderedText: receiver.host === "codex" ? inbound.body : baseRendered,
            summaryLine,
            envelopeText: inbound.body,
          });
          // 同时核验搭档 host-message.mjs 的 batchRecipientNotice 完全一致
          assert.equal(batchRecipientNotice(msgObj), summaryLine);
          if (receiver.host === "antigravity") {
            assert.ok(formatted.text.endsWith(`\n\n${inbound.body}`));
          }
          renderedOnTrain.set(receiver.conversation_id, { recipient_labels, summaryLine, text: formatted.text });
          deliveries.push({ local_message_id: msgObj.message_id, target_key: identityKey(receiver), delivery_status: "accepted" });
        }
        return { deliveries };
      },
    },
  });
  const devDispatcher = new RemoteCoreDispatcher({
    localMachineId: DEV_MACHINE,
    transport: devTransport,
    frameCodec: relayEnvelope,
  });

  context.after(async () => {
    await devDispatcher.close();
    await trainDispatcher.close();
    await devTransport.close();
    await trainTransport.close();
    await trainCore.close();
    trainStore.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // 人类渠道 QQ 与模型对话混发必须拦截
  assert.throws(
    () => validateAndDedupeRecipients([
      { machine_id: DEV_MACHINE, host: "qq", surface: "group", conversation_id: "qq-grp-1" },
      TRAIN_CODEX,
    ]),
    err => err instanceof CoreError && err.code === "mixed_channel_recipients_not_allowed",
  );

  // 未开启 allow_recipient_list_disclosure 的机器（THIRD_MACHINE）在 1本机+1远端 群发时必须原子拦截
  assert.throws(
    () => planMultiRecipientDispatch({
      batchId: "batch-blocked",
      localMachineId: DEV_MACHINE,
      sender: DEV_AGY,
      targets: [DEV_LOCAL_PEER, THIRD_CODEX],
      allowDiscloseByMachine: { [TRAIN_MACHINE]: true, [THIRD_MACHINE]: false },
    }),
    err => err instanceof CoreError && err.code === "relay_recipient_disclosure_blocked",
  );

  // 1 本机 + 2 训练机 群发 -> 跨机聚合仅发 1 条帧
  const { targets } = validateAndDedupeRecipients([DEV_LOCAL_PEER, TRAIN_CODEX, TRAIN_AGY, TRAIN_CODEX]);
  assert.equal(targets.length, 3);
  const { batchId, entries } = deriveBatchDedupeKeys({
    sourceKey: DEV_AGY,
    canonicalTargets: targets,
    text: "全员同步第一波验收进展",
  });
  assert.equal(entries.length, 3);
  const plan = planMultiRecipientDispatch({
    batchId,
    localMachineId: DEV_MACHINE,
    sender: DEV_AGY,
    targets,
    allowDiscloseByMachine: { [TRAIN_MACHINE]: true },
  });
  assert.equal(plan.localTargets.length, 1);
  assert.equal(plan.remoteGroups.length, 1);
  assert.equal(plan.remoteGroups[0].recipients.length, 2);

  await devDispatcher.dispatchMessage({
    dedupeKey: `batch:${batchId}:train`,
    targetMachine: TRAIN_MACHINE,
    source: DEV_AGY,
    recipients: plan.remoteGroups[0].recipients,
    allRecipients: plan.remoteGroups[0].all_recipients,
    body: "全员同步第一波验收进展",
    meta: { batch_id: batchId },
    allowDiscloseRecipients: true,
  });
  // 验证发往训练机严格只有 1 条中继帧
  assert.equal(sendFrameCount, 1);

  await trainDispatcher.pollOnce();
  const codexView = renderedOnTrain.get(TRAIN_CODEX.conversation_id);
  const agyView = renderedOnTrain.get(TRAIN_AGY.conversation_id);
  assert.ok(codexView.recipient_labels.includes("我的训练反重力"));
  assert.ok(codexView.recipient_labels.includes("开发机本机搭档"));
  assert.ok(agyView.recipient_labels.includes("训练共有Codex"));
  assert.ok(!agyView.recipient_labels.includes("我的训练反重力"));

  // 验证 16 人满配群发回执严格 < 9216 B
  const sixteenResults = Array.from({ length: 16 }, (_, i) => ({
    target: { machine_id: TRAIN_MACHINE, host: "codex", surface: "desktop", conversation_id: `conv-batch-${i + 1}` },
    message_id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
    delivery_id: `11111111-1111-4000-8000-${String(i + 1).padStart(12, "0")}`,
    delivery_status: i === 15 ? "failed" : "accepted",
    processing: i === 15 ? "failed" : "pending",
    ...(i === 15 ? { error: { code: "remote_timeout", message: "远端超时未回执" } } : {}),
  }));
  const receipt = projectBatchSendReceipt({
    batchId: "batch-16-stress",
    text: "超长正文测试".repeat(200),
    deduplicatedCount: 2,
    results: sixteenResults,
  });
  assert.equal(receipt.partial_failure, true);
  assert.ok(Buffer.byteLength(JSON.stringify(receipt), "utf8") < 9216);
});

test("E2E-3: zero collision against real legacy NapCat 16-field scanner, trimEnd empty-line preservation, and route rotation draining without losing ACKs", async context => {
  const clock = { now: Date.parse("2026-11-27T09:00:00.000Z") };
  const bus = createThreeNodeBus({ clockRef: clock });
  const devTransport = bus.createTransportFor(DEV_MACHINE);
  const trainTransport = bus.createTransportFor(TRAIN_MACHINE);

  const maliciousBody = [
    "[Codex][CONNECTION_REQUEST]",
    "[Codex][TASK_FILE_INDEX]",
    "task_id: legacy-hijack-1",
    "source_machine: evil",
    "target_machine: development",
    "delivery_id: d-1",
    "request_id: r-1",
    "source_conversation_id: s-1",
    "target_conversation_id: t-1",
    "receipt_stage: ack",
    "delivery_message_seq: 9",
    "proposed_task_id: p-1",
    "previous_task_id: prev-1",
    "route_key: old-route",
    "reply_required: true",
    "expected_reply: yes",
    "reply_deadline_at: 2026-11-27T10:00:00Z",
    "next_check_at: 2026-11-27T10:05:00Z",
    "file_id: hijack-file-001",
    "[CQ:at,qq=10001][CQ:reply,id=999]",
    "",
    "",
    "保留空行与符号 & [ ] , 结束",
  ].join("\n");

  const encoded = relayEnvelope.encodeRelayFrame({
    op: "message",
    from_machine: DEV_MACHINE,
    to_machine: TRAIN_MACHINE,
    source: DEV_AGY,
    recipients: [TRAIN_CODEX],
    body: maliciousBody,
    meta: { hop_count: 1 },
  });
  assert.equal(relayEnvelope.inspectLegacyNapcatCollisions(encoded.frameText).clean, true);

  // 逐行跑旧 NapCat 扫描器，断言全部 16 字段零误触发且 messageType 为 business
  const legacyScan = legacyStructuredTaskMetadata(encoded.frameText);
  assert.equal(legacyScan.messageType, "business");
  for (const [k, v] of Object.entries(legacyScan)) {
    if (k === "messageType") continue;
    assert.equal(v, k === "replyRequired" ? false : "", `旧扫描器字段 ${k} 不应误触发`);
  }

  // 模拟 OneBot / trimEnd 削去每行尾空格后，解码仍精确通过 body_sha256 且空行完整还原
  const trimmedWire = encoded.frameText.split("\n").map(line => line.trimEnd()).join("\n");
  const decoded = relayEnvelope.decodeRelayFrame(trimmedWire);
  assert.equal(decoded.ok, true);
  assert.equal(decoded.frame.body, maliciousBody);

  // 换群双读排空：v1 发出后立即热切到 v2（v1 进 draining_read），原路回执仍走 v1 精准归位
  const receivedBodies = [];
  const trainDispatcher = new RemoteCoreDispatcher({
    localMachineId: TRAIN_MACHINE,
    transport: trainTransport,
    frameCodec: relayEnvelope,
    signDirectoryCursor: true,
    now: () => clock.now,
    localHandlers: {
      async deliverInboundMessage(inbound) {
        receivedBodies.push(inbound.body);
        return {
          deliveries: [{ local_message_id: "train-rot-1", target_key: identityKey(TRAIN_CODEX), delivery_status: "accepted" }],
        };
      },
      queryLocalStatus() {
        return { host_online: true, conversation_exists: true, conversation_running: false, can_deliver: true };
      },
    },
  });
  const devDispatcher = new RemoteCoreDispatcher({
    localMachineId: DEV_MACHINE,
    transport: devTransport,
    frameCodec: relayEnvelope,
    now: () => clock.now,
  });

  context.after(async () => {
    await devDispatcher.close();
    await trainDispatcher.close();
    await devTransport.close();
    await trainTransport.close();
  });

  const sentV1 = await devDispatcher.dispatchMessage({
    dedupeKey: "rot-v1-msg",
    targetMachine: TRAIN_MACHINE,
    source: DEV_AGY,
    recipients: [TRAIN_CODEX],
    body: maliciousBody,
    meta: { origin_message_id: "orig-rot-1" },
  });
  assert.equal(sentV1.stages.relay_accepted.group_id, "grp-dev-train-v1");
  assert.equal(sentV1.stages.relay_accepted.route_generation, 1);

  // 在训练机读到消息前立刻热切新群 grp-dev-train-v2（generation=2）
  bus.rotateRoute({
    from_relay_key: "rel-dev-train",
    new_relay_key: "rel-dev-train-v2",
    new_group_id: "grp-dev-train-v2",
    drain_until: new Date(clock.now + 3600_000).toISOString(),
  });

  // 训练机双读排空收到旧群 v1 的消息，并原路回发 delivery_ack + processing_ack
  await trainDispatcher.pollOnce();
  assert.equal(receivedBodies[0], maliciousBody);
  trainDispatcher.enqueueProcessingAck({ local_message_id: "train-rot-1", processing: "done" });
  const flushRes = await trainDispatcher.flushOutbox();
  assert.equal(flushRes.flushed, 1);

  // 开发机双读排空准确收齐旧群 v1 回执
  await devDispatcher.pollOnce();
  const statusV1 = devDispatcher.getOutboundStatus(sentV1.relay_id);
  assert.equal(statusV1.stages.remote_core_persisted.ok, true);
  assert.equal(statusV1.stages.target_processing.status, "done");

  // 新发起的状态查询自动走新群 v2（generation=2）
  const statusPromise = devDispatcher.queryStatus({
    targetMachine: TRAIN_MACHINE,
    target: TRAIN_CODEX,
    timeoutMs: 3000,
  });
  await new Promise(resolve => setImmediate(resolve));
  await trainDispatcher.pollOnce();
  await devDispatcher.pollOnce();
  const queried = await statusPromise;
  assert.equal(queried.host_online, true);
  assert.equal(queried.source, "remote_core_relay");
});

test("E2E-4: CQ-budget escalation to file bundle with spool ACK release, symmetric queries, timeout unknown, and RelayAckStore unknown never-blind-resend", async context => {
  const dir = createTempDir();
  const clock = { now: Date.parse("2026-11-27T10:00:00.000Z") };
  const bus = createThreeNodeBus({ clockRef: clock });
  const devTransport = bus.createTransportFor(DEV_MACHINE);
  const trainTransport = bus.createTransportFor(TRAIN_MACHINE);
  const thirdTransport = bus.createTransportFor(THIRD_MACHINE);

  // 验证 legacy_training_coexistence: true 强制关闭文件包写入
  const trainStatus = await trainTransport.status();
  const coexistRoute = trainStatus.routes.find(r => r.relay_key === "rel-legacy-coexist");
  assert.equal(coexistRoute.allow_file_bundle_write, false);

  const bundleBodies = [];
  const trainDispatcher = new RemoteCoreDispatcher({
    localMachineId: TRAIN_MACHINE,
    transport: trainTransport,
    frameCodec: relayEnvelope,
    signDirectoryCursor: true,
    now: () => clock.now,
    localHandlers: {
      async deliverInboundMessage(inbound) {
        bundleBodies.push({ body: inbound.body, staged_files: inbound.staged_files });
        return {
          deliveries: [{ local_message_id: "train-bnd-1", target_key: identityKey(TRAIN_CODEX), delivery_status: "accepted" }],
        };
      },
      queryLocalDirectory({ cursor }) {
        return {
          items: [{ conversation_id: cursor ? "conv-page-2" : "conv-page-1", host: "codex" }],
          next_cursor: cursor ? null : "page-2-token",
        };
      },
      queryLocalSnapshot() {
        return { text: "这是一段非常长的快照记录。".repeat(300) };
      },
    },
  });
  const devDispatcher = new RemoteCoreDispatcher({
    localMachineId: DEV_MACHINE,
    transport: devTransport,
    frameCodec: relayEnvelope,
    now: () => clock.now,
  });
  const thirdDispatcher = new RemoteCoreDispatcher({
    localMachineId: THIRD_MACHINE,
    transport: thirdTransport,
    frameCodec: relayEnvelope,
    now: () => clock.now,
  });

  context.after(async () => {
    await devDispatcher.close();
    await trainDispatcher.close();
    await thirdDispatcher.close();
    await devTransport.close();
    await trainTransport.close();
    await thirdTransport.close();
  });

  // 1) CQ 膨胀超 1800（400 个 '[' 字符编码后膨胀 +1600）自动升格纯数据文件包通道
  const cqHeavyBody = "[".repeat(400) + "CQ膨胀测试";
  const escRes = await devDispatcher.dispatchMessage({
    dedupeKey: "e2e-cq-bundle",
    targetMachine: TRAIN_MACHINE,
    source: DEV_AGY,
    recipients: [TRAIN_CODEX],
    body: cqHeavyBody,
  });
  assert.equal(escRes.transport_mode, "file_bundle");

  const trainBundlePoll = await trainDispatcher.pollOnce();
  assert.equal(trainBundlePoll.processed, 1);
  assert.equal(trainBundlePoll.bundle_acked, 1);
  assert.equal(bundleBodies[0].body, cqHeavyBody);
  // 收端接管后立即 ackBundleEvents 释放 spool
  assert.equal(bus.getSpoolStats(TRAIN_MACHINE).incomingCount, 0);

  // 2) 对称能力：createRemoteMachineProviders 查目录翻页 + 跨机游标防盗用 + 超长快照裁剪 + 失联机器 remote_timeout
  const providers = createRemoteMachineProviders(devDispatcher, [TRAIN_MACHINE, THIRD_MACHINE], ["codex"], { timeoutMs: 250 });
  const trainCodexProvider = providers.get(TRAIN_MACHINE).get("codex");
  const thirdCodexProvider = providers.get(THIRD_MACHINE).get("codex");

  const page1Promise = trainCodexProvider.list({ host: "codex" }, { limit: 10 });
  await new Promise(resolve => setImmediate(resolve));
  await trainDispatcher.pollOnce();
  await devDispatcher.pollOnce();
  const page1 = await page1Promise;
  assert.equal(page1.conversations[0].conversation_id, "conv-page-1");
  assert.ok(page1.next_cursor);

  // 模拟 THIRD_MACHINE 盗用 DEVELOPMENT 的签名游标，必须被 trainDispatcher 拒绝
  const hijacked = await trainDispatcher.handleInboundEvent({
    event_id: "evt-hijack-cursor",
    relay_key: "rel-legacy-coexist",
    group_id: "grp-legacy-coexist-v1",
    route_generation: 1,
    source_machine: THIRD_MACHINE,
    sender_verified: true,
    frame: {
      relay_id: "rly-hijack-cursor",
      op: "list_query",
      from_machine: THIRD_MACHINE,
      to_machine: TRAIN_MACHINE,
      source: "core/system/dispatcher",
      recipients: ["core/system/dispatcher"],
      body: "",
      meta: { request_id: "req-hijack-1", hop_count: 1, host: "codex", cursor: page1.next_cursor },
    },
  });
  assert.equal(hijacked.code, "relay_cursor_scope_mismatch");

  // 超长快照显式传 maxChars 时裁剪并标记 partial=true
  const snapPromise = trainCodexProvider.readRecent(TRAIN_CODEX, { lastRounds: 2, maxChars: 120 });
  await new Promise(resolve => setImmediate(resolve));
  await trainDispatcher.pollOnce();
  await devDispatcher.pollOnce();
  const snap = await snapPromise;
  assert.equal(snap.partial, true);
  assert.ok(snap.rounds[0].messages[0].text.length <= 120);

  // THIRD_MACHINE 离线不轮询 -> queryStatus 返回 host_online="unknown" & code="remote_timeout"，绝不假装在线
  const offlineStatus = await thirdCodexProvider.getHostStatus(THIRD_CODEX);
  assert.equal(offlineStatus.host_online, "unknown");
  assert.equal(offlineStatus.code, "remote_timeout");

  // 3) 真实 RelayAckStore 下 outcome_unknown 绝不盲重发
  const unknownStore = new MessageStore({ filePath: join(dir, "unknown-ack.sqlite") });
  const unknownCore = new CommunicationCore({
    store: unknownStore,
    targets: [makeTarget(TRAIN_CODEX, "b-u")],
    principals: [
      { id: "p-u", token: "tok-u", identity: DEV_AGY, allowed_targets: ["b-u"], origin_kinds: ["agent_message"] },
    ],
    adapters: { mock: new MockAdapter() },
    now: () => clock.now,
  });
  const sharedAck = unknownCore.attachRelayAcknowledgements();
  await unknownCore.start();
  context.after(async () => {
    await unknownCore.close();
    unknownStore.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // 写入一条满足外键的入站消息
  const msgSent = await unknownCore.sendMessage(
    { principal_id: "p-u" },
    {
      caller: DEV_AGY,
      target: { ...TRAIN_CODEX, binding_id: "b-u", binding_generation: 1 },
      origin: { kind: "agent_message", channel: "remote_relay", source_ref: "rly-u" },
      dedupe_key: "u-msg-1",
      text: "验证 unknown 语义",
      expires_at: new Date(clock.now + 3600_000).toISOString(),
    },
  );
  const localId = msgSent.message.message_id;

  let attempts = 0;
  const flakyTransport = {
    async sendFrame() {
      attempts += 1;
      throw new RelayError("relay_transport_unconfirmed", "发送中超时结果未知", { request_sent: true }, { outcomeUnknown: true });
    },
  };
  const flakyDispatcher = new RemoteCoreDispatcher({
    localMachineId: TRAIN_MACHINE,
    transport: flakyTransport,
    ackStore: sharedAck,
    now: () => clock.now,
  });
  context.after(() => flakyDispatcher.close());

  flakyDispatcher.recordInboundMessageMapping({
    local_message_id: localId,
    origin_relay_id: "rly-u",
    origin_message_id: "orig-u",
    from_machine: DEV_MACHINE,
    reply_relay_key: "rel-dev-train",
    reply_group_id: "grp-dev-train-v1",
    reply_route_generation: 1,
    target_key: identityKey(TRAIN_CODEX),
  });
  const staged = flakyDispatcher.enqueueProcessingAck({ local_message_id: localId, processing: "done" });
  const r1 = await flakyDispatcher.flushOutbox();
  assert.equal(r1.unknown, 1);
  assert.equal(attempts, 1);
  assert.equal(sharedAck.read(staged.event_id).state, "unknown");

  // 再次刷盘绝不盲重发（attempts 保持 1）
  const r2 = await flakyDispatcher.flushOutbox();
  assert.equal(r2.flushed, 0);
  assert.equal(r2.unknown, 0);
  assert.equal(attempts, 1);
});

test("E2E-5: R2 adversarial regression (15-bundle zero-starvation, too_large/pending_capacity, fail-closed ackStore, forged ACK no-poison, text abort cursor guard, real 512B HostConversationContent cursor, HostStatus unknown, typed denial non-blocking, same-SQLite zero table collision)", async context => {
  const dir = createTempDir("comm-core-r2-reg-");
  const clock = { now: Date.parse("2026-11-27T11:00:00.000Z") };
  const bus = createThreeNodeBus({ clockRef: clock });
  const devTransport = bus.createTransportFor(DEV_MACHINE);
  const trainTransport = bus.createTransportFor(TRAIN_MACHINE);

  // 1) 15 笔文件包分批发送（bundleReadLimit=2 强触发多页翻页）-> 15/15 全收，0 饥饿，spool 全释放
  const receivedBundles = [];
  const receivedSenders = [];
  const trainBndDisp = new RemoteCoreDispatcher({
    localMachineId: TRAIN_MACHINE,
    transport: trainTransport,
    frameCodec: relayEnvelope,
    limits: { bundleReadLimit: 2 },
    now: () => clock.now,
    localHandlers: {
      async deliverInboundMessage(inbound) {
        receivedBundles.push(inbound.body);
        receivedSenders.push({
          sender_id: inbound.sender_id,
          principal_sender_id: inbound.remotePrincipal?.sender_id ?? null,
        });
        return { deliveries: [] };
      },
    },
  });
  const devBndDisp = new RemoteCoreDispatcher({
    localMachineId: DEV_MACHINE,
    transport: devTransport,
    frameCodec: relayEnvelope,
    now: () => clock.now,
  });
  context.after(async () => {
    await devBndDisp.close();
    await trainBndDisp.close();
    await devTransport.close();
    await trainTransport.close();
  });

  const heavyPrefix = "[".repeat(400);
  // 阶段 A：前 5 条先一次拉入接收端 spool，验证单轮 pollOnce 在 bundleReadLimit=2 下跨多页扫完随机 64-hex 游标无遗漏
  for (let i = 1; i <= 5; i += 1) {
    await devBndDisp.dispatchMessage({
      dedupeKey: `r2-bnd-${i}`,
      targetMachine: TRAIN_MACHINE,
      source: DEV_AGY,
      recipients: [TRAIN_CODEX],
      body: `${heavyPrefix}batch1-${i}`,
    });
  }
  await trainTransport.pollBundles({ limit: 10 });
  await trainBndDisp.pollOnce();
  assert.equal(receivedBundles.length, 5);
  assert.equal(new Set(receivedBundles).size, 5);

  // 阶段 B：再发 10 条，验证 pollOnce 按 bundleReadLimit=2 阶段拉取上限在有界轮次内（恰好 5 轮）全部清空且每条只处理一次
  for (let i = 6; i <= 15; i += 1) {
    await devBndDisp.dispatchMessage({
      dedupeKey: `r2-bnd-${i}`,
      targetMachine: TRAIN_MACHINE,
      source: DEV_AGY,
      recipients: [TRAIN_CODEX],
      body: `${heavyPrefix}batch2-${i}`,
    });
  }
  let stageBRounds = 0;
  const maxBoundedRounds = 8;
  while (receivedBundles.length < 15 && stageBRounds < maxBoundedRounds) {
    await trainBndDisp.pollOnce();
    stageBRounds += 1;
  }
  assert.equal(stageBRounds, 5);
  assert.equal(receivedBundles.length, 15);
  assert.equal(new Set(receivedBundles).size, 15);
  assert.equal(bus.getSpoolStats(TRAIN_MACHINE).incomingCount, 0);
  for (const s of receivedSenders) {
    assert.equal(s.sender_id, "acct-dev");
    assert.equal(s.principal_sender_id, "acct-dev");
  }

  // 阶段 C：缺有效顶层 sender_id 的入站文件包按 relay_file_sender_unverified 拒收且保留不调 ackBundleEvents
  const ackedUnverifiedIds = [];
  const unverifiedDisp = new RemoteCoreDispatcher({
    localMachineId: TRAIN_MACHINE,
    transport: {
      async readBundleEvents() {
        return {
          events: [
            {
              event_id: "evt_unverified_sender_1",
              source_machine: DEV_MACHINE,
              relay_key: "rly_dev_train_1",
              group_id: "900001",
              route_generation: 1,
              sender_id: "",
              payload_json: {
                relay_id: "rly_unverified_1",
                op: "message",
                from_machine: DEV_MACHINE,
                to_machine: TRAIN_MACHINE,
                source: DEV_AGY,
                recipients: [TRAIN_CODEX],
                body: "unverified sender",
                meta: { source_identity_verified: true, sender_id: "100010001" },
              },
            },
          ],
          next_cursor: null,
          errors: [{ event_id: "evt_old_missing_sender", code: "RELAY_FILE_SENDER_UNVERIFIED" }],
        };
      },
      async ackBundleEvents(input) {
        ackedUnverifiedIds.push(...(input.event_ids ?? []));
        return { ok: true };
      },
    },
    frameCodec: relayEnvelope,
    now: () => clock.now,
    localHandlers: {
      async deliverInboundMessage() {
        throw new Error("should_not_deliver_unverified_bundle");
      },
    },
    onError() {},
  });
  context.after(async () => {
    await unverifiedDisp.close();
  });
  const unverifiedSummary = await unverifiedDisp.pollOnce();
  assert.equal(unverifiedSummary.processed, 0);
  assert.equal(unverifiedSummary.bundle_acked, 0);
  assert.equal(ackedUnverifiedIds.length, 0);
  assert.equal(unverifiedSummary.rejected.length, 1);
  assert.equal(unverifiedSummary.rejected[0].code, "relay_file_sender_unverified");
  assert.equal(unverifiedSummary.bundle_errors.length, 1);
  assert.equal(unverifiedSummary.bundle_errors[0].code, "RELAY_FILE_SENDER_UNVERIFIED");

  // 阶段 D：文件包发端与收端统一使用可信顶层 bundle_id（发端凭 bundle_id 收齐 delivery_ack + processing_ack；正文自报 relay_id 与顶层 bundle_id 冲突必须拒绝）
  const bundleSent = await devBndDisp.dispatchMessage({
    dedupeKey: "r2-bnd-shared-id-roundtrip",
    targetMachine: TRAIN_MACHINE,
    source: DEV_AGY,
    recipients: [TRAIN_CODEX],
    body: `${heavyPrefix}shared-bundle-id-body`,
  });
  assert.equal(bundleSent.transport_mode, "file_bundle");
  assert.ok(bundleSent.relay_id && !bundleSent.relay_id.startsWith("bnd_"));
  await trainBndDisp.pollOnce();
  await devBndDisp.pollOnce();
  const afterDeliveryAck = devBndDisp.getOutboundStatus(bundleSent.relay_id);
  assert.equal(afterDeliveryAck?.relay_id, bundleSent.relay_id);
  assert.equal(afterDeliveryAck?.stages?.remote_core_persisted?.ok, true);

  const mismatchOutcome = await unverifiedDisp.handleInboundEvent({
    event_id: "evt_bundle_id_tamper_1",
    bundle_id: "trusted-bundle-id-999",
    sender_id: "acct-dev",
    source_machine: DEV_MACHINE,
    relay_key: "rly_dev_train_1",
    group_id: "900001",
    route_generation: 1,
    payload_json: {
      relay_id: "forged-payload-relay-id",
      op: "message",
      from_machine: DEV_MACHINE,
      to_machine: TRAIN_MACHINE,
      source: DEV_AGY,
      recipients: [TRAIN_CODEX],
      body: "tampered relay_id",
    },
  }, { isBundle: true });
  assert.equal(mismatchOutcome.handled, false);
  assert.equal(mismatchOutcome.status, "rejected");
  assert.equal(mismatchOutcome.code, "bundle_id_mismatch");

  // 2) too_large 必须抛 relay_bundle_too_large；pending_capacity 必须 ok=false 且 stage="pending_capacity"
  const tooLargeDisp = new RemoteCoreDispatcher({
    localMachineId: DEV_MACHINE,
    transport: {
      async sendBundle() {
        return { ok: true, status: "too_large", outcome_unknown: false };
      },
    },
    frameCodec: relayEnvelope,
  });
  const pendingCapDisp = new RemoteCoreDispatcher({
    localMachineId: DEV_MACHINE,
    transport: {
      async sendBundle() {
        return { ok: true, status: "pending_capacity", reason: "local_lane_full", outcome_unknown: false };
      },
    },
    frameCodec: relayEnvelope,
  });
  context.after(async () => {
    await tooLargeDisp.close();
    await pendingCapDisp.close();
  });
  await assert.rejects(
    () => tooLargeDisp.dispatchMessage({
      dedupeKey: "r2-too-large",
      targetMachine: TRAIN_MACHINE,
      source: DEV_AGY,
      recipients: [TRAIN_CODEX],
      body: `${heavyPrefix}too-large`,
    }),
    err => err instanceof CoreError && err.code === "relay_bundle_too_large",
  );
  const capRes = await pendingCapDisp.dispatchMessage({
    dedupeKey: "r2-pending-cap",
    targetMachine: TRAIN_MACHINE,
    source: DEV_AGY,
    recipients: [TRAIN_CODEX],
    body: `${heavyPrefix}cap`,
  });
  assert.equal(capRes.ok, false);
  assert.equal(capRes.stage, "pending_capacity");
  assert.equal(capRes.stages.relay_accepted.ok, false);

  // 3) RelayAckStore 与 RelayOutboxStore 共享同一 SQLite 零撞表 + 普通网络异常 fail-closed 标 unknown + 并发 flushOutbox 单飞仅发 1 次
  const sharedStore = new MessageStore({ filePath: join(dir, "shared-zero-collision.sqlite") });
  const sharedCore = new CommunicationCore({
    store: sharedStore,
    targets: [makeTarget(TRAIN_CODEX, "b-s")],
    principals: [{ id: "p-s", token: "tok-s", identity: DEV_AGY, allowed_targets: ["b-s"], origin_kinds: ["agent_message"] }],
    adapters: { mock: new MockAdapter() },
    now: () => clock.now,
  });
  const sharedAck = sharedCore.attachRelayAcknowledgements();
  // 在同一个 SQLite 数据库上额外实例化 RelayOutboxStore，验证绝不撞表！
  const { DatabaseSync } = await import("node:sqlite");
  const coDb = new DatabaseSync(join(dir, "shared-zero-collision.sqlite"));
  const indepOutbox = new RelayOutboxStore({ database: coDb, now: () => clock.now });
  assert.equal(indepOutbox.stats().total_outbox, 0);
  await sharedCore.start();
  context.after(async () => {
    await sharedCore.close();
    coDb.close();
    sharedStore.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const sentMsg = await sharedCore.sendMessage(
    { principal_id: "p-s" },
    {
      caller: DEV_AGY,
      target: { ...TRAIN_CODEX, binding_id: "b-s", binding_generation: 1 },
      origin: { kind: "agent_message", channel: "remote_relay", source_ref: "rly-s" },
      dedupe_key: "s-msg-1",
      text: "fail-closed 测试",
      expires_at: new Date(clock.now + 3600_000).toISOString(),
    },
  );
  let netCalls = 0;
  const failClosedDisp = new RemoteCoreDispatcher({
    localMachineId: TRAIN_MACHINE,
    transport: {
      async sendFrame(_args, { onRequestStarted } = {}) {
        netCalls += 1;
        onRequestStarted?.();
        throw new Error("ECONNRESET");
      },
    },
    ackStore: sharedAck,
    now: () => clock.now,
  });
  context.after(() => failClosedDisp.close());
  failClosedDisp.recordInboundMessageMapping({
    local_message_id: sentMsg.message.message_id,
    origin_relay_id: "rly-s",
    origin_message_id: "orig-s",
    from_machine: DEV_MACHINE,
    reply_relay_key: "rel-dev-train",
    reply_group_id: "grp-dev-train-v1",
    reply_route_generation: 1,
    target_key: identityKey(TRAIN_CODEX),
  });
  const staged = failClosedDisp.enqueueProcessingAck({ local_message_id: sentMsg.message.message_id, processing: "done" });
  const [f1, f2] = await Promise.all([failClosedDisp.flushOutbox(), failClosedDisp.flushOutbox()]);
  assert.equal(netCalls, 1);
  assert.equal(f1.unknown, 1);
  assert.equal(f2.unknown, 1);
  assert.equal(sharedAck.read(staged.event_id).state, "unknown");

  // 4) 伪造 processing_ack(failed, ack_seq:99) 被拒后绝不毒化 #remoteProcessingState，合法 done(ack_seq:1) 仍成功推进
  const sentForPoison = await devBndDisp.dispatchMessage({
    dedupeKey: "r2-poison-check",
    targetMachine: TRAIN_MACHINE,
    source: DEV_AGY,
    recipients: [TRAIN_CODEX],
    body: "验证伪造不毒化",
    meta: { origin_message_id: "orig-poison-1" },
  });
  const poisonRes = await devBndDisp.handleInboundEvent({
    event_id: "evt-poison-1",
    relay_key: "rel-dev-third",
    group_id: "grp-dev-third-v1",
    route_generation: 1,
    source_machine: THIRD_MACHINE,
    sender_verified: true,
    frame: {
      relay_id: "rly-poison-1",
      op: "processing_ack",
      from_machine: THIRD_MACHINE,
      to_machine: DEV_MACHINE,
      source: "codex/desktop/conv-third-codex-1",
      recipients: ["antigravity/desktop/conv-dev-agy-1"],
      in_reply_to: sentForPoison.relay_id,
      body: "",
      meta: { hop_count: 1, origin_relay_id: sentForPoison.relay_id, origin_message_id: "orig-poison-1", ack_seq: 99, processing: "failed" },
    },
  });
  assert.equal(poisonRes.code, "ack_pairing_mismatch");
  const legitRes = await devBndDisp.handleInboundEvent({
    event_id: "evt-legit-done",
    relay_key: sentForPoison.stages.relay_accepted.relay_key,
    group_id: sentForPoison.stages.relay_accepted.group_id,
    route_generation: sentForPoison.stages.relay_accepted.route_generation,
    source_machine: TRAIN_MACHINE,
    sender_verified: true,
    frame: {
      relay_id: "rly-legit-done",
      op: "processing_ack",
      from_machine: TRAIN_MACHINE,
      to_machine: DEV_MACHINE,
      source: "codex/desktop/conv-train-codex-1",
      recipients: ["antigravity/desktop/conv-dev-agy-1"],
      in_reply_to: sentForPoison.relay_id,
      body: "",
      meta: { hop_count: 1, origin_relay_id: sentForPoison.relay_id, origin_message_id: "orig-poison-1", ack_seq: 1, processing: "done" },
    },
  });
  assert.equal(legitRes.handled, true);
  assert.equal(devBndDisp.getOutboundStatus(sentForPoison.relay_id).stages.target_processing.status, "done");

  // 5) 真实双端 HostConversationContent (512B 原生游标) + 真实 HostStatusProvider (无证据保 unknown) + typed denial 不打断同页消费
  const bus2 = createThreeNodeBus({ clockRef: clock });
  const devT2 = bus2.createTransportFor(DEV_MACHINE);
  const trainT2 = bus2.createTransportFor(TRAIN_MACHINE);
  const longNativeCursor = "c".repeat(512);
  const trainContent = new HostConversationContent({
    localMachineId: TRAIN_MACHINE,
    providers: {
      codex: {
        async list(_scope, { cursor }) {
          return cursor === null
            ? { conversations: [{ conversation_id: "conv-t-1", status: "idle" }], next_cursor: longNativeCursor }
            : { conversations: [{ conversation_id: "conv-t-2", status: "idle" }], next_cursor: null };
        },
      },
    },
  });
  const trainPrincipalForDir = {
    id: "p-dir",
    identity: { machine_id: TRAIN_MACHINE, host: "codex", surface: "desktop", conversation_id: "conv-dir-reader" },
    allowed_host_lists: [{ machine_id: TRAIN_MACHINE, host: "codex", surface: "desktop" }],
  };
  let acceptedAfterDenied = 0;
  const trainD2 = new RemoteCoreDispatcher({
    localMachineId: TRAIN_MACHINE,
    transport: trainT2,
    frameCodec: relayEnvelope,
    // 默认 signDirectoryCursor === false 透传目标核心已签发游标，不突破 727B！
    localHandlers: {
      async deliverInboundMessage(inbound) {
        if (inbound.body === "DENY_ME") throw new CoreError("forbidden", "目标会话未获授权");
        acceptedAfterDenied += 1;
        return { deliveries: [] };
      },
      async queryLocalStatus() {
        // 仅返回 host_online，故意不返回 control_enabled/control_ready/transport_ready
        return { host_online: true, conversation_exists: true, conversation_running: false };
      },
      async queryLocalDirectory({ host, surface, limit, cursor }) {
        if (host === "windsurf") return { ok: false, error: { code: "forbidden", message: "禁止查 windsurf" } };
        return trainContent.list(trainPrincipalForDir, {
          caller: trainPrincipalForDir.identity,
          machine_id: TRAIN_MACHINE,
          host,
          surface,
          limit,
          cursor,
          scope: "host",
        });
      },
    },
  });
  const devD2 = new RemoteCoreDispatcher({
    localMachineId: DEV_MACHINE,
    transport: devT2,
    frameCodec: relayEnvelope,
  });
  context.after(async () => {
    await devD2.close();
    await trainD2.close();
    await devT2.close();
    await trainT2.close();
  });

  const remoteProviders = createRemoteMachineProviders(devD2, [TRAIN_MACHINE], ["codex", "windsurf"], {
    timeoutMs: 3000,
    getCursorGeneration: () => 1,
  });
  const devContent = new HostConversationContent({
    localMachineId: DEV_MACHINE,
    machineProviders: remoteProviders,
  });
  const devPrincipal = {
    id: "p-dev-caller",
    identity: DEV_AGY,
    allowed_host_lists: [
      { machine_id: TRAIN_MACHINE, host: "codex", surface: "desktop" },
      { machine_id: TRAIN_MACHINE, host: "windsurf", surface: "desktop" },
    ],
  };

  // 双端真实 HostConversationContent 512B 游标翻两页不破 727B！
  const p1 = devContent.list(devPrincipal, { caller: DEV_AGY, machine_id: TRAIN_MACHINE, host: "codex", surface: "desktop", limit: 10, scope: "host" });
  await new Promise(r => setImmediate(r));
  await trainD2.pollOnce();
  await devD2.pollOnce();
  const page1 = await p1;
  assert.equal(page1.conversations[0].conversation_id, "conv-t-1");
  assert.ok(page1.next_cursor);

  const p2 = devContent.list(devPrincipal, { caller: DEV_AGY, machine_id: TRAIN_MACHINE, host: "codex", surface: "desktop", limit: 10, cursor: page1.next_cursor, scope: "host" });
  await new Promise(r => setImmediate(r));
  await trainD2.pollOnce();
  await devD2.pollOnce();
  const page2 = await p2;
  assert.equal(page2.conversations[0].conversation_id, "conv-t-2");
  assert.equal(page2.next_cursor, null);

  // 真实 HostStatusProvider：远端未返回 control_enabled/control_ready 时严守 "unknown"，绝不虚构 true
  const statusProvider = new HostStatusProvider({ localMachineId: DEV_MACHINE, machineProviders: remoteProviders });
  const pSt = statusProvider.getStatus(TRAIN_CODEX);
  await new Promise(r => setImmediate(r));
  await trainD2.pollOnce();
  await devD2.pollOnce();
  const stRes = await pSt;
  assert.equal(stRes.host_online, true);
  assert.equal(stRes.control_enabled, "unknown");
  assert.equal(stRes.control_ready, "unknown");
  assert.equal(stRes.can_deliver, "unknown");

  // 本地拒绝发 typed denial（delivery_ack ok:false & list_reply ok:false），且绝不打断同页后续合法消息消费！
  const deniedMsg = await devD2.dispatchMessage({
    dedupeKey: "r2-deny-1",
    targetMachine: TRAIN_MACHINE,
    source: DEV_AGY,
    recipients: [TRAIN_CODEX],
    body: "DENY_ME",
  });
  await devD2.dispatchMessage({
    dedupeKey: "r2-allow-2",
    targetMachine: TRAIN_MACHINE,
    source: DEV_AGY,
    recipients: [TRAIN_CODEX],
    body: "ALLOW_AFTER_DENY",
  });
  const pollDeniedAndAllowed = await trainD2.pollOnce();
  assert.equal(pollDeniedAndAllowed.rejected.length, 1);
  assert.equal(pollDeniedAndAllowed.rejected[0].code, "forbidden");
  assert.equal(acceptedAfterDenied, 1);
  await devD2.pollOnce();
  assert.equal(devD2.getOutboundStatus(deniedMsg.relay_id).stages.remote_core_persisted.ok, false);
  assert.equal(devD2.getOutboundStatus(deniedMsg.relay_id).stages.remote_core_persisted.error.code, "forbidden");

  // 6) pollOnce 文本事件循环中途被取消时绝不推进 #textCursor，后续重轮询不丢剩余事件
  const ac = new AbortController();
  const seenAbortIds = [];
  const abortEvents = [
    { event_id: "e-a1", relay_key: "r1", group_id: "g1", route_generation: 1, source_machine: DEV_MACHINE, sender_verified: true, frame: { relay_id: "r-a1", op: "message", from_machine: DEV_MACHINE, to_machine: TRAIN_MACHINE, source: "antigravity/desktop/conv-dev-1", recipients: ["codex/desktop/conv-train-1"], body: "m1", meta: { hop_count: 1 } } },
    { event_id: "e-a2", relay_key: "r1", group_id: "g1", route_generation: 1, source_machine: DEV_MACHINE, sender_verified: true, frame: { relay_id: "r-a2", op: "message", from_machine: DEV_MACHINE, to_machine: TRAIN_MACHINE, source: "antigravity/desktop/conv-dev-1", recipients: ["codex/desktop/conv-train-1"], body: "m2", meta: { hop_count: 1 } } },
  ];
  const cursorCalls = [];
  const abortDisp = new RemoteCoreDispatcher({
    localMachineId: TRAIN_MACHINE,
    transport: {
      async readEvents({ cursor }) {
        cursorCalls.push(cursor ?? null);
        return { events: cursor ? [] : abortEvents, next_cursor: "cur-after-2" };
      },
      async sendFrame() {
        return { ok: true, status: "sent_verified", relay_id: "rly-ack-a" };
      },
    },
    localHandlers: {
      async deliverInboundMessage(inbound) {
        seenAbortIds.push(inbound.body);
        if (inbound.body === "m1") ac.abort();
        return { deliveries: [] };
      },
    },
  });
  context.after(() => abortDisp.close());
  await abortDisp.pollOnce({ signal: ac.signal });
  assert.deepEqual(seenAbortIds, ["m1"]);
  await abortDisp.pollOnce();
  assert.deepEqual(cursorCalls, [null, null]);
  assert.deepEqual(seenAbortIds, ["m1", "m2"]);
});

test("E2E-6: RevB P0/P1/P2 fixes (snapshot 3-way fallback & HostConversationContent render, errors-only bundle pagination, dispatching claimOutbox + recoverInterrupted, trailing flushOutbox) and owned-caller querySnapshot strict 4-tuple pairing", async context => {
  const clock = { now: Date.parse("2026-11-27T08:08:00.000Z") };
  const dir = mkdtempSync(join(tmpdir(), "comm-e2e-6-"));
  const { DatabaseSync } = await import("node:sqlite");
  const outboxDb = new DatabaseSync(join(dir, "outbox-dispatching.sqlite"));
  context.after(() => {
    outboxDb.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // 1) RevB P0-1 (3 scenarios) + P1-1 (真实 HostConversationContent.snapshot 不丢弃截断正文):
  // 场景 1A: bundleEnabled=false + 超长快照；场景 1B: 路由拒写文件包(allow_file_bundle_write=false)；场景 1C: 无 max_chars 直接二分截断含 observed_at 绝不破 1800 CQ 上限
  const makeSnapshotPair = (busOpts, { allowFileBundleWrite = true, bundleEnabled = true, policyBundle = true } = {}) => {
    const bus = new InMemoryRelayBus({ frameCodec: relayEnvelope, now: () => clock.now, ...busOpts });
    bus.registerMachine({ machine_id: DEV_MACHINE, qq_id: "acct-dev", bundle_enabled: bundleEnabled });
    bus.registerMachine({ machine_id: TRAIN_MACHINE, qq_id: "acct-train", bundle_enabled: bundleEnabled });
    bus.registerRoute({
      relay_key: "rly_snap_1",
      group_id: "900101",
      generation: 1,
      members: [DEV_MACHINE, TRAIN_MACHINE],
      allow_file_bundle_write: allowFileBundleWrite,
      legacy_training_coexistence: false,
    });
    const devT = bus.createTransportFor(DEV_MACHINE, { bundleEnabled });
    const trainT = bus.createTransportFor(TRAIN_MACHINE, { bundleEnabled });
    const hugeBody = `IMPORTANTPREVIEWPAYLOAD12345 ${"[x]&".repeat(600)} ENDMARKER`;
    const devD = new RemoteCoreDispatcher({ localMachineId: DEV_MACHINE, transport: devT, frameCodec: relayEnvelope, now: () => clock.now });
    const trainD = new RemoteCoreDispatcher({
      localMachineId: TRAIN_MACHINE,
      transport: trainT,
      frameCodec: relayEnvelope,
      now: () => clock.now,
      policy: { defaults: { allow_file_bundle: policyBundle, allow_snapshot: true } },
      localHandlers: {
        queryLocalSnapshot: () => ({
          conversation_id: "conv-train-snap",
          status: "idle",
          observed_at: new Date(clock.now).toISOString(),
          text: hugeBody,
        }),
      },
    });
    context.after(async () => {
      await devD.close();
      await trainD.close();
      await devT.close();
      await trainT.close();
    });
    return { bus, devD, trainD };
  };

  for (const cfg of [
    { name: "1A_bundle_disabled", bundleEnabled: false, allowFileBundleWrite: true, policyBundle: true },
    { name: "1B_route_denied", bundleEnabled: true, allowFileBundleWrite: false, policyBundle: true },
    { name: "1C_direct_truncate_with_observed_at", bundleEnabled: true, allowFileBundleWrite: true, policyBundle: false },
  ]) {
    const { devD, trainD } = makeSnapshotPair({}, cfg);
    const providers = createRemoteMachineProviders(devD, [TRAIN_MACHINE], ["codex"], { timeoutMs: 3_000 });
    const hcc = new HostConversationContent({
      localMachineId: DEV_MACHINE,
      machineProviders: providers,
    });
    const devSnapPrincipal = {
      id: "p-snap-dev",
      identity: DEV_AGY,
      allowed_host_snapshots: [{ machine_id: TRAIN_MACHINE, host: "codex", surface: "desktop", all_conversations: true }],
    };
    const snapPromise = hcc.snapshot(
      devSnapPrincipal,
      { caller: DEV_AGY, target: { machine_id: TRAIN_MACHINE, host: "codex", surface: "desktop", conversation_id: "conv-train-snap" }, last_rounds: 2 },
    );
    await Promise.resolve();
    await new Promise(r => setTimeout(r, 10));
    await trainD.pollOnce();
    await devD.pollOnce();
    const rendered = await snapPromise;
    assert.ok(!rendered.markdown.includes("暂无可显示的近期消息"), `${cfg.name} should not drop preview body`);
    assert.ok(rendered.markdown.includes("IMPORTANTPREVIEWPAYLOAD12345"), `${cfg.name} should preserve preview in HostConversationContent.snapshot()`);
    assert.equal(rendered.partial, true, `${cfg.name} should mark partial=true`);
  }

  // 2) RevB P0-2: 整页仅含 errors[] (events: [], next_cursor !== null) 绝不提前 break，必须翻页消费后续合法文件包
  const pageCalls = [];
  const deliveredAfterErrorPage = [];
  const errPageDisp = new RemoteCoreDispatcher({
    localMachineId: TRAIN_MACHINE,
    transport: {
      async readBundleEvents({ cursor }) {
        pageCalls.push(cursor ?? null);
        if (!cursor) {
          return {
            events: [],
            errors: [{ event_id: "0000aaaa", code: "RELAY_FILE_SENDER_UNVERIFIED" }],
            next_cursor: "0000aaaa",
          };
        }
        if (cursor === "0000aaaa") {
          return {
            events: [
              {
                event_id: "ffffbbbb",
                bundle_id: "bnd-after-err-page-1",
                sender_id: "acct-dev",
                source_machine: DEV_MACHINE,
                relay_key: "rly_snap_1",
                group_id: "900101",
                route_generation: 1,
                payload_json: {
                  op: "message",
                  from_machine: DEV_MACHINE,
                  to_machine: TRAIN_MACHINE,
                  source: "antigravity/desktop/conv-dev-1",
                  recipients: ["codex/desktop/conv-train-1"],
                  body: "SURVIVED_AFTER_ERROR_PAGE",
                  meta: { hop_count: 1, source_identity_verified: true },
                },
              },
            ],
            errors: [],
            next_cursor: null,
          };
        }
        return { events: [], errors: [], next_cursor: null };
      },
      async ackBundleEvents() {
        return { ok: true };
      },
      async sendFrame() {
        return { ok: true, status: "sent_verified", relay_id: "rly-ack-errpage" };
      },
    },
    frameCodec: relayEnvelope,
    now: () => clock.now,
    localHandlers: {
      async deliverInboundMessage(inbound) {
        deliveredAfterErrorPage.push(inbound.body);
        return { deliveries: [] };
      },
    },
    onError() {},
  });
  context.after(() => errPageDisp.close());
  const errPageRes = await errPageDisp.pollOnce();
  assert.deepEqual(pageCalls, [null, "0000aaaa"]);
  assert.deepEqual(deliveredAfterErrorPage, ["SURVIVED_AFTER_ERROR_PAGE"]);
  assert.equal(errPageRes.processed, 1);
  assert.equal(errPageRes.bundle_acked, 1);
  assert.equal(errPageRes.bundle_errors.length, 1);

  // 3) RevB P1-2 + P2-1: 独立 RelayOutboxStore 必须原子 claimOutbox 落盘 dispatching (使 recoverInterrupted 生效)，且 flushOutbox 在途新入队自动尾随补刷
  const outboxStore = new RelayOutboxStore({ database: outboxDb, now: () => clock.now });
  let statusDuringFirstSend = null;
  let recoveredCountDuringSend = 0;
  const sentAckSeqs = [];
  let releaseFirstSend;
  const firstSendStarted = new Promise(resolve => { releaseFirstSend = resolve; });
  let unblockFirstSend;
  const firstSendGate = new Promise(resolve => { unblockFirstSend = resolve; });

  const outboxDisp = new RemoteCoreDispatcher({
    localMachineId: TRAIN_MACHINE,
    outboxStore,
    transport: {
      async sendFrame(req) {
        const seq = req.meta?.ack_seq;
        sentAckSeqs.push(seq);
        if (seq === 1) {
          const liveRows = outboxStore.listOutbox({ localMessageId: "local-msg-disp-1" });
          statusDuringFirstSend = liveRows[0]?.status ?? null;
          releaseFirstSend();
          await firstSendGate;
        }
        return { ok: true, status: "sent_verified", relay_id: `rly-out-${seq}` };
      },
    },
    now: () => clock.now,
  });
  context.after(() => outboxDisp.close());

  outboxDisp.recordInboundMessageMapping({
    local_message_id: "local-msg-disp-1",
    origin_relay_id: "rly-orig-disp-1",
    origin_message_id: "msg-orig-disp-1",
    from_machine: DEV_MACHINE,
    reply_relay_key: "rly_snap_1",
    reply_group_id: "900101",
    reply_route_generation: 1,
    target_key: identityKey(TRAIN_CODEX),
  });
  outboxDisp.enqueueProcessingAck({ local_message_id: "local-msg-disp-1", processing: "processing" });
  const flushP1 = outboxDisp.flushOutbox();
  await firstSendStarted;
  assert.equal(statusDuringFirstSend, "dispatching");

  // 另一笔待发项在途模拟崩溃恢复：单独测 claimOutbox + recoverInterrupted -> unknown
  outboxDisp.recordInboundMessageMapping({
    local_message_id: "local-msg-crash-2",
    origin_relay_id: "rly-orig-crash-2",
    origin_message_id: "msg-orig-crash-2",
    from_machine: DEV_MACHINE,
    reply_relay_key: "rly_snap_1",
    reply_group_id: "900101",
    reply_route_generation: 1,
    target_key: identityKey(TRAIN_CODEX),
  });
  const crashEntry = outboxDisp.enqueueProcessingAck({ local_message_id: "local-msg-crash-2", processing: "processing" });
  const claimedCrash = outboxStore.claimOutbox(crashEntry.id, clock.now);
  assert.equal(claimedCrash?.status, "dispatching");
  // 先把第一个在途发完再入队 done 测试尾随补刷
  outboxDisp.enqueueProcessingAck({ local_message_id: "local-msg-disp-1", processing: "done" });
  const flushP2 = outboxDisp.flushOutbox();
  unblockFirstSend();
  await Promise.all([flushP1, flushP2]);
  assert.deepEqual(sentAckSeqs, [1, 2]);
  // 现在对仍在 dispatching 的 crashEntry 调 recoverInterrupted 必须恢复为 unknown
  recoveredCountDuringSend = outboxStore.recoverInterrupted(clock.now);
  assert.equal(recoveredCountDuringSend, 1);
  assert.equal(outboxStore.getOutboxEntry(crashEntry.id)?.status, "unknown");

  // 4) 跨机快照精确鉴源(source/sourceIdentityVerified/signal) + 严格 4 元配对拒伪造不消费原等待 + 文件包回传保留 in_reply_to
  const ownedBus = new InMemoryRelayBus({ frameCodec: relayEnvelope, now: () => clock.now });
  ownedBus.registerMachine({ machine_id: DEV_MACHINE, qq_id: "acct-dev", bundle_enabled: true });
  ownedBus.registerMachine({ machine_id: TRAIN_MACHINE, qq_id: "acct-train", bundle_enabled: true });
  ownedBus.registerRoute({
    relay_key: "rly_owned_snap",
    group_id: "900202",
    generation: 2,
    members: [DEV_MACHINE, TRAIN_MACHINE],
    allow_file_bundle_write: true,
    legacy_training_coexistence: false,
  });
  const ownedDevT = ownedBus.createTransportFor(DEV_MACHINE, { bundleEnabled: true });
  const ownedTrainT = ownedBus.createTransportFor(TRAIN_MACHINE, { bundleEnabled: true });
  const capturedSnapCalls = [];
  let capturedOwnedRequestId = null;
  let capturedOwnedOriginRelayId = null;
  const origOwnedSendFrame = ownedDevT.sendFrame.bind(ownedDevT);
  ownedDevT.sendFrame = async (req, opts) => {
    if (req.op === "snapshot_query") capturedOwnedRequestId = req.meta?.request_id ?? null;
    const res = await origOwnedSendFrame(req, opts);
    if (req.op === "snapshot_query") capturedOwnedOriginRelayId = res?.relay_id ?? null;
    return res;
  };
  const ownedDevD = new RemoteCoreDispatcher({ localMachineId: DEV_MACHINE, transport: ownedDevT, frameCodec: relayEnvelope, now: () => clock.now });
  const ownedTrainD = new RemoteCoreDispatcher({
    localMachineId: TRAIN_MACHINE,
    transport: ownedTrainT,
    frameCodec: relayEnvelope,
    now: () => clock.now,
    policy: { defaults: { allow_snapshot: true, allow_file_bundle: true } },
    localHandlers: {
      queryLocalSnapshot: req => {
        capturedSnapCalls.push({
          source_endpoint: req.source_endpoint,
          source_identity_verified: req.source_identity_verified,
          principal_source_endpoint: req.remotePrincipal?.source_endpoint,
          principal_source_verified: req.remotePrincipal?.source_identity_verified,
          has_signal: Boolean(req.signal && typeof req.signal.aborted === "boolean"),
        });
        return {
          conversation_id: "conv-train-owned",
          status: "idle",
          rounds: [{ messages: [{ role: "assistant", text: `LONG_OWNED_SNAP_${"Z".repeat(2200)}` }] }],
        };
      },
    },
  });
  context.after(async () => {
    await ownedDevD.close();
    await ownedTrainD.close();
    await ownedDevT.close();
    await ownedTrainT.close();
  });

  // sourceIdentityVerified=true 无具名 source 必拒
  await assert.rejects(
    () => ownedDevD.querySnapshot({
      targetMachine: TRAIN_MACHINE,
      target: { host: "codex", surface: "desktop", conversation_id: "conv-train-owned" },
      sourceIdentityVerified: true,
    }),
    err => err instanceof CoreError && err.code === "invalid_input",
  );

  // 具名调用者发起超长快照查询（走文件包回传）
  const ownedSnapP = ownedDevD.querySnapshot({
    targetMachine: TRAIN_MACHINE,
    target: { host: "codex", surface: "desktop", conversation_id: "conv-train-owned" },
    source: DEV_AGY,
    sourceIdentityVerified: true,
    timeoutMs: 3_000,
  });
  await new Promise(r => setTimeout(r, 15));
  await ownedTrainD.pollOnce();
  assert.equal(capturedSnapCalls.length, 1);
  assert.equal(capturedSnapCalls[0].source_endpoint, "antigravity/desktop/conv-dev-agy-1");
  assert.equal(capturedSnapCalls[0].source_identity_verified, true);
  assert.equal(capturedSnapCalls[0].principal_source_endpoint, "antigravity/desktop/conv-dev-agy-1");
  assert.equal(capturedSnapCalls[0].principal_source_verified, true);
  assert.equal(capturedSnapCalls[0].has_signal, true);

  // 持真实 request_id 连续注入错 in_reply_to、错 route_generation、错 group_id 的伪造 snapshot_reply：
  // 必须全部精准拒收 request_pairing_mismatch 且绝不消费原等待！
  assert.ok(capturedOwnedRequestId && capturedOwnedOriginRelayId);
  for (const tamper of [
    { id: "evt_forged_1", group_id: "900202", route_generation: 2, in_reply_to: "rly_wrong_origin" },
    { id: "evt_forged_2", group_id: "900202", route_generation: 99, in_reply_to: capturedOwnedOriginRelayId },
    { id: "evt_forged_3", group_id: "999999", route_generation: 2, in_reply_to: capturedOwnedOriginRelayId },
  ]) {
    const forgedReply = await ownedDevD.handleInboundEvent({
      event_id: tamper.id,
      source_machine: TRAIN_MACHINE,
      sender_id: "acct-train",
      relay_key: "rly_owned_snap",
      group_id: tamper.group_id,
      route_generation: tamper.route_generation,
      frame: {
        relay_id: `rly_${tamper.id}`,
        op: "snapshot_reply",
        from_machine: TRAIN_MACHINE,
        to_machine: DEV_MACHINE,
        source: "core/system/dispatcher",
        recipients: ["antigravity/desktop/conv-dev-agy-1"],
        in_reply_to: tamper.in_reply_to,
        body: "FORGED",
        meta: { hop_count: 1, in_reply_to_request_id: capturedOwnedRequestId, ok: true },
      },
    });
    assert.equal(forgedReply.handled, false);
    assert.equal(forgedReply.status, "rejected");
    assert.equal(forgedReply.code, "request_pairing_mismatch");
  }

  // 随后正常消费合法文件包回传（保留 in_reply_to、同群同代次）：原等待完整成功！
  const devOwnedPoll = await ownedDevD.pollOnce();
  const ownedSnapRes = await ownedSnapP;
  assert.equal(devOwnedPoll.bundle_acked, 1);
  assert.equal(ownedSnapRes.ok, true);
  assert.ok(ownedSnapRes.snapshot.rounds[0].messages[0].text.startsWith("LONG_OWNED_SNAP_"));
});
