import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { CodexDeliveryAdapter } from "../src/adapters/codex.mjs";
import { batchRecipientNotice, renderHostMessage } from "../src/adapters/host-message.mjs";
import { projectAntigravityTail } from "../src/antigravity-conversation-content.mjs";
import { CoreError, identityKey } from "../src/contracts.mjs";
import { ConversationAddressBook } from "../src/conversation-address-book.mjs";
import {
  computeBatchPayloadHash,
  DEFAULT_MAX_RECIPIENTS,
  deriveBatchDedupeKeys,
  formatRecipientGroupForHost,
  HUMAN_CHANNEL_HOSTS,
  normalizeRecipientsInput,
  planMultiRecipientDispatch,
  planReplyAllSubMessages,
  projectBatchSendReceipt,
  projectVisibilityForRecipient,
  renderPeerRecipientsForReceiver,
  validateAndDedupeRecipients,
} from "../src/multi-recipient.mjs";
import { projectWindsurfTail } from "../src/windsurf-conversation-content.mjs";

function makeTarget(machine_id, host, conversation_id, surface = "desktop") {
  return {
    machine_id,
    host,
    surface,
    conversation_id,
    binding_id: `bind_${machine_id}_${host}_${conversation_id}`,
    binding_generation: 1,
    adapter_id: `adapter_${host}`,
  };
}

describe("multi-recipient constants and input normalization", () => {
  it("exports DEFAULT_MAX_RECIPIENTS=16 and HUMAN_CHANNEL_HOSTS={qq, wechat}", () => {
    assert.equal(DEFAULT_MAX_RECIPIENTS, 16);
    assert.equal(HUMAN_CHANNEL_HOSTS.has("qq"), true);
    assert.equal(HUMAN_CHANNEL_HOSTS.has("wechat"), true);
    assert.equal(HUMAN_CHANNEL_HOSTS.size, 2);
  });

  it("enforces mutual exclusion between target and targets, forbids origin_receipt_binding on batch, and caps at 16", () => {
    const t1 = makeTarget("dev_box", "antigravity", "conv_1");
    const t2 = makeTarget("dev_box", "codex", "conv_2");

    assert.equal(normalizeRecipientsInput({ target: t1 }).mode, "single");
    const batch = normalizeRecipientsInput({ targets: [t1, t2] });
    assert.equal(batch.mode, "batch");
    assert.equal(batch.isBatch, true);
    assert.equal(batch.count, 2);

    assert.throws(
      () => normalizeRecipientsInput({ target: t1, targets: [t2] }),
      (err) => err instanceof CoreError && err.code === "invalid_input",
    );
    assert.throws(
      () => normalizeRecipientsInput({}),
      (err) => err instanceof CoreError && err.code === "invalid_input",
    );
    assert.throws(
      () => normalizeRecipientsInput({ targets: [] }),
      (err) => err instanceof CoreError && err.code === "invalid_input",
    );
    assert.throws(
      () => normalizeRecipientsInput({
        targets: [t1, t2],
        origin_receipt_binding: { component: "napcat", resource_id: "r1", generation: 1, wake_id: "w1", event_ids: ["1"] },
      }),
      (err) => err instanceof CoreError && err.code === "invalid_input",
    );

    const seventeen = Array.from({ length: 17 }, (_, idx) => makeTarget("dev_box", "codex", `conv_${idx}`));
    assert.throws(
      () => normalizeRecipientsInput({ targets: seventeen }),
      (err) => err instanceof CoreError && err.code === "invalid_input",
    );
  });
});

describe("matrix 5: human channel guard, dedupe, atomic permission, dedupe_conflict, reply-all, and disclosure", () => {
  it("blocks mixing human channels (qq/wechat) with model conversations and blocks multi-human fan-out", () => {
    const qq1 = makeTarget("dev_box", "qq", "room_01", "group");
    const qq2 = makeTarget("dev_box", "qq", "room_02", "group");
    const wechat1 = makeTarget("dev_box", "wechat", "chat_01", "dm");
    const codex1 = makeTarget("dev_box", "codex", "conv_01");
    const agy1 = makeTarget("dev_box", "antigravity", "conv_02");

    assert.throws(
      () => validateAndDedupeRecipients([qq1, codex1]),
      (err) => err instanceof CoreError && err.code === "mixed_channel_recipients_not_allowed",
    );
    assert.throws(
      () => validateAndDedupeRecipients([wechat1, agy1]),
      (err) => err instanceof CoreError && err.code === "mixed_channel_recipients_not_allowed",
    );
    assert.throws(
      () => validateAndDedupeRecipients([qq1, qq2]),
      (err) => err instanceof CoreError && err.code === "mixed_channel_recipients_not_allowed",
    );
    assert.throws(
      () => validateAndDedupeRecipients([qq1, wechat1]),
      (err) => err instanceof CoreError && err.code === "mixed_channel_recipients_not_allowed",
    );

    const singleHuman = validateAndDedupeRecipients([qq1]);
    assert.equal(singleHuman.targets.length, 1);
    assert.equal(singleHuman.deduplicatedCount, 0);
  });

  it("deduplicates by identityKey preserving order and atomically rejects the whole batch if any recipient lacks permission", () => {
    const t1 = makeTarget("dev_box", "antigravity", "conv_1");
    const t2 = makeTarget("dev_box", "codex", "conv_2");
    const t3 = makeTarget("dev_box", "windsurf", "conv_3");

    const deduped = validateAndDedupeRecipients([t1, t2, { ...t1 }, t3, { ...t2 }]);
    assert.equal(deduped.deduplicatedCount, 2);
    assert.deepEqual(
      deduped.targets.map((t) => t.conversation_id),
      ["conv_1", "conv_2", "conv_3"],
    );

    const principal = {
      allowed_targets: [t1.binding_id, t2.binding_id],
      allowed_target_scopes: [],
    };
    assert.throws(
      () => validateAndDedupeRecipients([t1, t2, t3], { principal }),
      (err) => err instanceof CoreError && err.code === "forbidden",
    );

    const checked = [];
    assert.throws(
      () => validateAndDedupeRecipients([t1, t2, t3], {
        checkPermission: (target) => {
          checked.push(target.conversation_id);
          return target.conversation_id !== "conv_2";
        },
      }),
      (err) => err instanceof CoreError && err.code === "forbidden",
    );
    assert.deepEqual(checked, ["conv_1", "conv_2"]);
  });

  it("derives deterministic subDedupeKeys and detects batchPayloadHash conflict when recipients change under same dedupe_key", () => {
    const sender = makeTarget("dev_box", "antigravity", "conv_sender");
    const t1 = makeTarget("dev_box", "codex", "conv_1");
    const t2 = makeTarget("dev_box", "windsurf", "conv_2");
    const t3 = makeTarget("train_box", "codex", "conv_3");

    const hashAB = computeBatchPayloadHash({ canonicalTargets: [t1, t2], text: "同步进度" });
    const hashBA = computeBatchPayloadHash({ canonicalTargets: [t2, t1], text: "同步进度" });
    const hashAC = computeBatchPayloadHash({ canonicalTargets: [t1, t3], text: "同步进度" });
    const hashABC = computeBatchPayloadHash({ canonicalTargets: [t1, t2, t3], text: "同步进度" });

    assert.equal(hashAB, hashBA);
    assert.notEqual(hashAB, hashAC);
    assert.notEqual(hashAB, hashABC);

    const batch1 = deriveBatchDedupeKeys({
      parentDedupeKey: "req_batch_same_key",
      sourceKey: sender,
      canonicalTargets: [t1, t2],
      text: "同步进度",
    });
    const batch1Retry = deriveBatchDedupeKeys({
      parentDedupeKey: "req_batch_same_key",
      sourceKey: sender,
      canonicalTargets: [t1, t2],
      text: "同步进度",
    });
    const batchTamperedList = deriveBatchDedupeKeys({
      parentDedupeKey: "req_batch_same_key",
      sourceKey: sender,
      canonicalTargets: [t1, t3],
      text: "同步进度",
    });

    assert.equal(batch1.batchId, batch1Retry.batchId);
    assert.equal(batch1.batchPayloadHash, batch1Retry.batchPayloadHash);
    assert.deepEqual(batch1.entries, batch1Retry.entries);
    assert.notEqual(batch1.batchPayloadHash, batchTamperedList.batchPayloadHash);

    for (const entry of batch1.entries) {
      const expectedSubKey = `batch:${createHash("sha256")
        .update(`req_batch_same_key\0${entry.targetKey}`, "utf8")
        .digest("hex")
        .slice(0, 28)}`;
      assert.equal(entry.subDedupeKey, expectedSubKey);
      assert.equal(Buffer.byteLength(entry.subDedupeKey, "utf8"), 34);
    }

    const autoA = deriveBatchDedupeKeys({
      sourceKey: sender,
      canonicalTargets: [t1, t2],
      text: "省略 dedupe_key",
      minuteBucket: 123456,
    });
    const autoB = deriveBatchDedupeKeys({
      sourceKey: sender,
      canonicalTargets: [t2, t1],
      text: "省略 dedupe_key",
      minuteBucket: 123456,
    });
    const autoNextMin = deriveBatchDedupeKeys({
      sourceKey: sender,
      canonicalTargets: [t1, t2],
      text: "省略 dedupe_key",
      minuteBucket: 123457,
    });
    assert.equal(autoA.parentDedupeKey, autoB.parentDedupeKey);
    assert.notEqual(autoA.parentDedupeKey, autoNextMin.parentDedupeKey);
  });

  it("plans reply-all so only original sender receives envelope.in_reply_to while peers are cc-only", () => {
    const sender = makeTarget("dev_box", "antigravity", "conv_sender");
    const r1 = makeTarget("dev_box", "codex", "conv_r1");
    const r2 = makeTarget("dev_box", "windsurf", "conv_r2");
    const r3 = makeTarget("train_box", "codex", "conv_r3");
    const outsider = makeTarget("dev_box", "codex", "conv_outsider");

    const originalMessage = {
      message_id: "00000000-0000-4000-8000-000000000101",
      source_key: identityKey(sender),
      target_key: identityKey(r1),
      batch_meta: {
        batch_id: "batch_origin_01",
        recipient_group: {
          recipients: [r1, r2, r3],
        },
      },
    };

    const plan = planReplyAllSubMessages({
      originalMessage,
      callerIdentity: r1,
      targets: [sender, r2, r3],
    });

    assert.equal(plan.replyToOriginalTargetKey, identityKey(sender));
    assert.deepEqual(plan.ccTargetKeys, [identityKey(r2), identityKey(r3)]);
    assert.equal(plan.replyToBatchId, "batch_origin_01");
    assert.equal(plan.replyToMessageId, originalMessage.message_id);
    assert.deepEqual(plan.subMessages, [
      {
        targetKey: identityKey(sender),
        envelopeInReplyTo: originalMessage.message_id,
        replyToBatchId: "batch_origin_01",
        replyToMessageId: originalMessage.message_id,
      },
      {
        targetKey: identityKey(r2),
        envelopeInReplyTo: null,
        replyToBatchId: "batch_origin_01",
        replyToMessageId: originalMessage.message_id,
      },
      {
        targetKey: identityKey(r3),
        envelopeInReplyTo: null,
        replyToBatchId: "batch_origin_01",
        replyToMessageId: originalMessage.message_id,
      },
    ]);

    assert.throws(
      () => planReplyAllSubMessages({ originalMessage, callerIdentity: r2, targets: [sender] }),
      (err) => err instanceof CoreError && err.code === "invalid_reply",
    );
    assert.throws(
      () => planReplyAllSubMessages({ originalMessage, callerIdentity: r1, targets: [sender, outsider] }),
      (err) => err instanceof CoreError && err.code === "invalid_reply",
    );
    assert.throws(
      () => planReplyAllSubMessages({
        originalMessage: { message_id: "msg_single", source_key: identityKey(sender), target_key: identityKey(r1) },
        callerIdentity: r1,
        targets: [sender],
      }),
      (err) => err instanceof CoreError && err.code === "invalid_reply",
    );
  });

  it("projects message_visibility exclusively for codex and aggregates same remote machine into 1 frame with disclosure check", () => {
    const sender = makeTarget("dev_box", "antigravity", "conv_sender");
    const localA = makeTarget("dev_box", "codex", "conv_local_1");
    const localB = makeTarget("dev_box", "antigravity", "conv_local_2");
    const remoteA = makeTarget("train_box", "codex", "conv_remote_1");
    const remoteB = makeTarget("train_box", "antigravity", "conv_remote_2");

    assert.equal(projectVisibilityForRecipient("visible", localA), "visible");
    assert.equal(projectVisibilityForRecipient(undefined, localA), "hidden");
    assert.equal(projectVisibilityForRecipient("visible", localB), undefined);
    assert.throws(
      () => projectVisibilityForRecipient("secret", localA),
      (err) => err instanceof CoreError && err.code === "invalid_input",
    );

    assert.throws(
      () => planMultiRecipientDispatch({
        batchId: "batch_01",
        localMachineId: "dev_box",
        sender,
        targets: [localA, remoteA],
        allowDiscloseByMachine: () => false,
      }),
      (err) => err instanceof CoreError && err.code === "relay_recipient_disclosure_blocked",
    );

    const singleRemote = planMultiRecipientDispatch({
      batchId: "batch_single_remote",
      localMachineId: "dev_box",
      sender,
      targets: [remoteA],
      allowDiscloseByMachine: () => false,
    });
    assert.equal(singleRemote.localTargets.length, 0);
    assert.equal(singleRemote.remoteGroups.length, 1);

    const plan = planMultiRecipientDispatch({
      batchId: "batch_mixed_02",
      localMachineId: "dev_box",
      sender,
      targets: [localA, remoteA, localB, remoteB],
      allowDiscloseByMachine: (machine) => machine === "train_box",
    });

    assert.deepEqual(plan.localTargets.map((t) => t.conversation_id), ["conv_local_1", "conv_local_2"]);
    assert.equal(plan.remoteGroups.length, 1);
    assert.equal(plan.remoteGroups[0].target_machine, "train_box");
    assert.deepEqual(
      plan.remoteGroups[0].recipients.map((t) => t.conversation_id),
      ["conv_remote_1", "conv_remote_2"],
    );
    assert.equal(plan.remoteGroups[0].all_recipients.length, 4);
  });
});

describe("matrix 4: receiver-side alias rendering and 3-host snapshot compatibility", () => {
  it("resolves peer aliases via ConversationAddressBook.resolveDisplayName with zero DB write side effects and aligns recipient_labels", () => {
    const db = new DatabaseSync(":memory:");
    try {
      const receiver = { machine_id: "dev_box", host: "antigravity", surface: "desktop", conversation_id: "conv_recv" };
      const peerPersonal = { machine_id: "dev_box", host: "codex", surface: "desktop", conversation_id: "conv_peer_1" };
      const peerShared = { machine_id: "dev_box", host: "windsurf", surface: "desktop", conversation_id: "conv_peer_2" };
      const peerUnknown = { machine_id: "train_box", host: "codex", surface: "desktop", conversation_id: "conv_peer_3" };

      const book = new ConversationAddressBook({
        database: db,
        machineId: "dev_box",
        sharedContacts: [
          { id: "shared_wsf", alias: "共有开发对话", target: peerShared, note: "" },
        ],
      });

      const principal = {
        identity: receiver,
        address_book_identity_bound: true,
        caller_scope: null,
      };
      book.saveAddress(principal, { alias: "alias_b_次选", target: peerPersonal, note: "私人备注" });
      book.saveAddress(principal, { alias: "alias_a_优先", target: peerPersonal, note: "按alias_key ASC排前" });

      const rendered = renderPeerRecipientsForReceiver({
        receiver,
        allRecipients: [receiver, peerPersonal, peerShared, peerUnknown],
        resolveDisplayName: (recv, peer) => book.resolveDisplayName(recv, peer),
      });

      assert.deepEqual(rendered.recipient_labels, [
        "alias_a_优先",
        "共有开发对话",
        "train_box/codex/desktop/conv_peer_3",
      ]);
      assert.equal(
        rendered.summaryLine,
        "同批收件人：alias_a_优先、共有开发对话、train_box/codex/desktop/conv_peer_3",
      );
      assert.equal(rendered.peers[0].resolvedFromAlias, true);
      assert.equal(rendered.peers[1].resolvedFromAlias, true);
      assert.equal(rendered.peers[2].resolvedFromAlias, false);

      // Verify zero DB write side effects for an unopened receiver
      const unopenedReceiver = { machine_id: "dev_box", host: "codex", surface: "desktop", conversation_id: "conv_unopened" };
      const booksBefore = db.prepare("SELECT count(*) AS total FROM caller_books").get().total;
      const renderedUnopened = renderPeerRecipientsForReceiver({
        receiver: unopenedReceiver,
        allRecipients: [unopenedReceiver, peerShared],
        resolveDisplayName: (recv, peer) => book.resolveDisplayName(recv, peer),
      });
      const booksAfter = db.prepare("SELECT count(*) AS total FROM caller_books").get().total;
      assert.equal(booksBefore, booksAfter);
      assert.deepEqual(renderedUnopened.recipient_labels, ["共有开发对话"]);

      // Verify strict prefix length budget under 15 long peer labels
      const manyPeers = Array.from({ length: 15 }, (_, idx) => ({
        machine_id: "dev_box",
        host: "codex",
        surface: "desktop",
        conversation_id: `conv_long_${idx}_${"x".repeat(80)}`,
      }));
      const bounded = renderPeerRecipientsForReceiver({
        receiver,
        allRecipients: [receiver, ...manyPeers],
        maxSummaryChars: 512,
      });
      assert.equal(bounded.recipient_labels.length, 15);
      assert.ok([...bounded.summaryLine].length <= 512);
      assert.ok(bounded.recipient_labels.every((label) => Buffer.byteLength(label, "utf8") <= 512));
    } finally {
      db.close();
    }
  });

  it("renders recipient group safely for Antigravity, Windsurf, and Codex and passes real snapshot verifiers", () => {
    const msgId = "11111111-1111-4111-8111-111111111111";
    const delivId = "22222222-2222-4222-8222-222222222222";
    const sender = { machine_id: "dev_box", host: "codex", surface: "desktop", conversation_id: "conv_sender_main" };
    const agyTarget = makeTarget("dev_box", "antigravity", "33333333-3333-4333-8333-333333333333");
    const wsfTarget = makeTarget("dev_box", "windsurf", "wsf-session-demo-1");
    const codexTarget = makeTarget("dev_box", "codex", "codex_thread_demo_1");
    const envelopeText = "正文第一行\n正文第二行，含精确尾缀校验。";

    const renderedPeers = renderPeerRecipientsForReceiver({
      receiver: agyTarget,
      allRecipients: [agyTarget, wsfTarget, codexTarget],
      resolveDisplayName: (_recv, peer) => (peer.host === "windsurf" ? "开发端WSF" : "开发端Codex"),
    });

    const baseMessageNoBatch = {
      message_id: msgId,
      target_key: identityKey(agyTarget),
      envelope: {
        caller: sender,
        origin: { kind: "agent_message", channel: "agent_mcp", source_ref: "src_ref_1" },
        target: agyTarget,
        text: envelopeText,
        attachment_refs: [],
        delivery_policy: "next_model_boundary",
      },
    };

    const baseHostText = renderHostMessage({
      message: baseMessageNoBatch,
      delivery: { delivery_id: delivId },
    });
    const markerLine = `[COMMUNICATION_CORE message_id=${msgId} delivery_id=${delivId}]`;

    // 1. Antigravity host formatting + real projectAntigravityTail verifier
    const agyFormatted = formatRecipientGroupForHost({
      host: "antigravity",
      baseRenderedText: baseHostText,
      markerLine,
      summaryLine: renderedPeers.summaryLine,
      recipient_labels: renderedPeers.recipient_labels,
      envelopeText,
    });
    assert.equal(agyFormatted.inserted, true);
    assert.deepEqual(agyFormatted.recipient_labels, ["开发端WSF", "开发端Codex"]);
    assert.equal(agyFormatted.text.endsWith(`\n\n${envelopeText}`), true);
    assert.ok(agyFormatted.text.indexOf(renderedPeers.summaryLine) > 0);
    assert.ok(agyFormatted.text.indexOf(renderedPeers.summaryLine) < agyFormatted.text.indexOf(markerLine));

    const agyProjection = projectAntigravityTail(
      {
        description: { cascade_id: agyTarget.conversation_id },
        steps: [
          {
            type: "user_input",
            execution_id: "exec_1",
            timestamp: "2026-11-27T07:00:00.000Z",
            user_input: { client_message_id: delivId, text: agyFormatted.text },
          },
        ],
      },
      agyTarget,
      5,
      (id) => (id === delivId ? baseMessageNoBatch : null),
    );
    assert.equal(agyProjection.partial, false);
    assert.equal(agyProjection.rounds.length, 1);
    assert.equal(agyProjection.rounds[0].messages[0].role, "external");
    assert.equal(agyProjection.rounds[0].messages[0].text, envelopeText);

    // 2. Windsurf host formatting + real projectWindsurfTail verifier
    const wsfMessage = {
      ...baseMessageNoBatch,
      target_key: identityKey(wsfTarget),
      envelope: { ...baseMessageNoBatch.envelope, target: wsfTarget },
    };
    const wsfFormatted = formatRecipientGroupForHost({
      host: "windsurf",
      baseRenderedText: baseHostText,
      markerLine,
      summaryLine: renderedPeers.summaryLine,
      recipient_labels: renderedPeers.recipient_labels,
      envelopeText,
    });
    assert.equal(wsfFormatted.text.endsWith(`\n\n${envelopeText}`), true);
    assert.ok(wsfFormatted.text.indexOf(renderedPeers.summaryLine) < wsfFormatted.text.indexOf(markerLine));

    const wsfProjection = projectWindsurfTail(
      {
        session: { id: wsfTarget.conversation_id },
        nodes: [
          {
            message_id: "node_1",
            role: "user",
            created_at: 1795647600,
            content_excerpt: wsfFormatted.text,
            content_bytes: Buffer.byteLength(wsfFormatted.text, "utf8"),
          },
          {
            message_id: "node_2",
            role: "assistant",
            created_at: 1795647605,
            content_excerpt: "已收到并确认。",
            content_bytes: Buffer.byteLength("已收到并确认。", "utf8"),
            finish_reason: "stop",
          },
        ],
      },
      wsfTarget,
      5,
      (id) => (id === delivId ? wsfMessage : null),
    );
    assert.equal(wsfProjection.partial, false);
    assert.equal(wsfProjection.rounds.length, 1);
    assert.equal(wsfProjection.rounds[0].messages[0].role, "external");
    assert.equal(wsfProjection.rounds[0].messages[0].text, envelopeText);

    // 3. Codex host formatting matches real CodexDeliveryAdapter + batchRecipientNotice without altering envelope.text
    const codexMessage = {
      message_id: msgId,
      target_key: identityKey(codexTarget),
      envelope: {
        caller: sender,
        origin: { kind: "agent_message", channel: "agent_mcp", source_ref: "src_ref_1" },
        target: codexTarget,
        text: envelopeText,
        attachment_refs: [],
        delivery_policy: "next_model_boundary",
        message_visibility: "hidden",
      },
      batch_meta: {
        batch_id: "batch_demo_01",
        recipient_group: { recipients: [agyTarget, wsfTarget, codexTarget] },
        recipient_labels: renderedPeers.recipient_labels,
      },
    };
    assert.equal(batchRecipientNotice(codexMessage), renderedPeers.summaryLine);

    const codexFormatted = formatRecipientGroupForHost({
      host: "codex",
      baseRenderedText: envelopeText,
      recipient_labels: renderedPeers.recipient_labels,
    });
    const codexAdapter = new CodexDeliveryAdapter({
      transport: { submit: async () => ({}), query: async () => ({}) },
    });
    const adapterReq = codexAdapter.request({
      message: codexMessage,
      delivery: { delivery_id: delivId },
      target: codexTarget,
    });
    assert.equal(codexFormatted.text, adapterReq.body.text);
    assert.equal(codexMessage.envelope.text, envelopeText);
    assert.deepEqual(codexFormatted.recipient_labels, renderedPeers.recipient_labels);

    // Reject oversized Codex body after prepending notice
    assert.throws(
      () => formatRecipientGroupForHost({
        host: "codex",
        baseRenderedText: "a".repeat(262140),
        recipient_labels: renderedPeers.recipient_labels,
      }),
      (err) => err instanceof CoreError && err.code === "invalid_input",
    );
  });
});

describe("matrix 5E: 16-recipient receipt stays strictly under 9 KiB and isolates partial failures", () => {
  it("projects 16 full recipients with 200-char single text_preview strictly under 9216 bytes", () => {
    const longBody = "这是一段用于验证群发精简回执的较长正文内容。".repeat(30);
    const results = Array.from({ length: 16 }, (_, idx) => {
      const hex = idx.toString(16).padStart(2, "0");
      const failed = idx === 4 || idx === 11;
      const done = idx === 0 || idx === 1;
      return {
        target: makeTarget(
          idx < 8 ? "development" : "training_node",
          idx % 2 === 0 ? "antigravity" : "codex",
          `00000000-0000-4000-8000-0000000000${hex}`,
        ),
        message_id: failed ? null : `10000000-0000-4000-8000-0000000000${hex}`,
        delivery_id: failed ? null : `20000000-0000-4000-8000-0000000000${hex}`,
        delivery_status: failed ? "failed" : "delivered",
        processing: failed ? "failed" : done ? "done" : "pending",
        ...(failed ? { error: { code: "host_offline", message: "远端宿主当前不在线，仅影响该收件人，其余收件人照常投递与独立确认。" } } : {}),
      };
    });

    const receipt = projectBatchSendReceipt({
      batchId: "batch_full_16_demo_0001",
      text: longBody,
      deduplicatedCount: 2,
      results,
    });

    assert.equal(receipt.recipient_count, 16);
    assert.equal(receipt.deduplicated_count, 2);
    assert.equal(receipt.succeeded_count, 14);
    assert.equal(receipt.failed_count, 2);
    assert.equal(receipt.partial_failure, true);
    assert.equal(receipt.text_truncated, true);
    assert.ok([...receipt.text_preview].length <= 200);
    assert.equal(receipt.results[0].processing, "done");
    assert.equal(receipt.results[2].processing, "pending");
    assert.equal(receipt.results[4].delivery_status, "failed");
    assert.equal(receipt.results[4].error.code, "host_offline");

    const serializedBytes = Buffer.byteLength(JSON.stringify(receipt), "utf8");
    assert.ok(serializedBytes < 9216, `expected receipt < 9216 bytes, got ${serializedBytes}`);
  });

  it("enforces < 9216 byte hard cap even under 16 recipients with max-length error messages", () => {
    const results = Array.from({ length: 16 }, (_, idx) => ({
      target: makeTarget(
        "development_machine_long",
        "antigravity",
        `conversation_identifier_${idx}_${"a".repeat(48)}`,
      ),
      message_id: `10000000-0000-4000-8000-0000000000${idx.toString(16).padStart(2, "0")}`,
      delivery_id: `20000000-0000-4000-8000-0000000000${idx.toString(16).padStart(2, "0")}`,
      delivery_status: "failed",
      processing: "failed",
      error: {
        code: "relay_recipient_disclosure_blocked",
        message: "超长中文错误详情测试字符串".repeat(20),
      },
    }));

    const receipt = projectBatchSendReceipt({
      batchId: "batch_stress_16",
      text: "超长正文测试".repeat(100),
      results,
    });
    const serializedBytes = Buffer.byteLength(JSON.stringify(receipt), "utf8");
    assert.ok(serializedBytes < 9216, `stress receipt exceeded 9 KiB: ${serializedBytes}`);
  });
});

describe("P1-5: proxy/prototype hardening, canonical fallback flag, ideographic comma aliases, Codex idempotency, 9 KiB hard guard, and snake_case error codes", () => {
  it("rejects Proxy and custom-prototype objects in normalizeRecipientsInput", () => {
    const valid = makeTarget("dev_box", "codex", "conv_1");
    assert.throws(
      () => normalizeRecipientsInput({ target: new Proxy(valid, {}) }),
      (err) => err instanceof CoreError && err.code === "invalid_input",
    );
    assert.throws(
      () => normalizeRecipientsInput({ targets: [Object.create(valid)] }),
      (err) => err instanceof CoreError && err.code === "invalid_input",
    );
    assert.throws(
      () => normalizeRecipientsInput({ targets: [new Date()] }),
      (err) => err instanceof CoreError && err.code === "invalid_input",
    );
  });

  it("marks 3-segment (core.mjs fallback) and 4-segment canonical resolver outputs as resolvedFromAlias=false and enforces maxSummaryChars strictly", () => {
    const receiver = { machine_id: "dev_box", host: "antigravity", surface: "desktop", conversation_id: "conv_recv" };
    const peerA = { machine_id: "dev_box", host: "codex", surface: "desktop", conversation_id: "conv_peer_a" };
    const peerB = { machine_id: "train_box", host: "antigravity", surface: "desktop", conversation_id: "conv_peer_b" };
    const peerC = { machine_id: "train_box", host: "windsurf", surface: "desktop", conversation_id: "conv_peer_c" };

    const rendered = renderPeerRecipientsForReceiver({
      receiver,
      allRecipients: [receiver, peerA, peerB, peerC],
      resolveDisplayName: (_recv, peer) => {
        if (peer.conversation_id === "conv_peer_a") {
          // 3-segment fallback like core.mjs:L369
          return `${peer.machine_id}/${peer.host}/${peer.conversation_id}`;
        }
        if (peer.conversation_id === "conv_peer_b") {
          // 4-segment canonical fallback
          return `${peer.machine_id}/${peer.host}/${peer.surface}/${peer.conversation_id}`;
        }
        return "真正通讯录别名";
      },
    });

    assert.equal(rendered.peers[0].resolvedFromAlias, false);
    assert.equal(rendered.peers[0].displayName, "dev_box/codex/conv_peer_a");
    assert.equal(rendered.peers[1].resolvedFromAlias, false);
    assert.equal(rendered.peers[1].displayName, "train_box/antigravity/desktop/conv_peer_b");
    assert.equal(rendered.peers[2].resolvedFromAlias, true);
    assert.equal(rendered.peers[2].displayName, "真正通讯录别名");

    // Strict maxSummaryChars even under tight budget (32 and 80) with 15 long peers
    const fifteenPeers = Array.from({ length: 15 }, (_, idx) => ({
      machine_id: "dev_box",
      host: "codex",
      surface: "desktop",
      conversation_id: `peer_${idx}_${"z".repeat(40)}`,
    }));
    for (const limit of [32, 64, 80, 120]) {
      const tight = renderPeerRecipientsForReceiver({
        receiver,
        allRecipients: [receiver, ...fifteenPeers],
        maxSummaryChars: limit,
      });
      assert.ok(
        [...tight.summaryLine].length <= limit,
        `summaryLine length ${[...tight.summaryLine].length} exceeded maxSummaryChars=${limit}`,
      );
    }
  });

  it("does not split aliases containing ideographic commas in formatRecipientGroupForHost and keeps Codex formatting idempotent", () => {
    const aliasesWithCommas = Array.from({ length: 12 }, (_, idx) => `组${idx}、前端、后端`);
    const summaryLine = `同批收件人：${aliasesWithCommas.join("、")}`;
    // Splitting by '、' would produce 36 fragments (>15) and previously threw invalid_input!
    const codexOnlySummary = formatRecipientGroupForHost({
      host: "codex",
      baseRenderedText: "正文内容",
      summaryLine,
    });
    assert.equal(codexOnlySummary.inserted, true);
    assert.deepEqual(codexOnlySummary.recipient_labels, []);
    assert.equal(codexOnlySummary.text, `${summaryLine}\n\n正文内容`);

    // Codex idempotency: calling formatRecipientGroupForHost a second time does not prepend noticeLine twice
    const codexSecondPass = formatRecipientGroupForHost({
      host: "codex",
      baseRenderedText: codexOnlySummary.text,
      summaryLine,
    });
    assert.equal(codexSecondPass.inserted, true);
    assert.equal(codexSecondPass.text, codexOnlySummary.text);

    // Same idempotency when passing recipient_labels directly
    const withLabelsOnce = formatRecipientGroupForHost({
      host: "codex",
      baseRenderedText: "主体任务说明",
      recipient_labels: ["甲、乙", "丙、丁"],
    });
    const withLabelsTwice = formatRecipientGroupForHost({
      host: "codex",
      baseRenderedText: withLabelsOnce.text,
      recipient_labels: ["甲、乙", "丙、丁"],
    });
    assert.equal(withLabelsTwice.text, withLabelsOnce.text);
    assert.equal(withLabelsTwice.inserted, true);
  });

  it("never emits >= 9216 B receipts in non-verbose mode even for 16 max-length valid IDs and normalizes error codes to snake_case", () => {
    // 1. Borderline case: clearing text_preview alone still >= 9216 B, compressing error.message keeps receipt strictly < 9216 B
    const borderlineResults = Array.from({ length: 16 }, (_, idx) => ({
      target: makeTarget(
        "m".repeat(80),
        "antigravity",
        `conv_${idx}_${"c".repeat(120)}`,
      ),
      message_id: `10000000-0000-4000-8000-0000000000${idx.toString(16).padStart(2, "0")}`,
      delivery_id: `20000000-0000-4000-8000-0000000000${idx.toString(16).padStart(2, "0")}`,
      delivery_status: "failed",
      processing: "failed",
      error: {
        code: "RELAY_FRAME_TOO_LARGE",
        message: "这条超长中文错误详情会在清空正文预览之后继续触发错误消息压缩确保严格低于九千二百一十六字节预算上限。".repeat(2),
      },
    }));
    const borderlineReceipt = projectBatchSendReceipt({
      batchId: "batch_borderline_16",
      text: "正文".repeat(100),
      results: borderlineResults,
    });
    assert.ok(Buffer.byteLength(JSON.stringify(borderlineReceipt), "utf8") < 9216);
    assert.equal(borderlineReceipt.receipt_compacted, true);
    assert.equal(borderlineReceipt.text_preview, "");
    assert.equal(borderlineReceipt.results[0].error.code, "relay_frame_too_large");

    // 2. Extreme case: 16 max-length legal IDs (128 + 64 + 64 + 256 per target) exceed 9216 B even after compaction -> throws invalid_input
    const extremeResults = Array.from({ length: 16 }, (_, idx) => ({
      target: {
        machine_id: `m_${idx}_${"a".repeat(120)}`,
        host: `h_${"b".repeat(60)}`,
        surface: `s_${"c".repeat(60)}`,
        conversation_id: `cid_${idx}_${"d".repeat(240)}`,
      },
      message_id: `10000000-0000-4000-8000-0000000000${idx.toString(16).padStart(2, "0")}`,
      delivery_id: `20000000-0000-4000-8000-0000000000${idx.toString(16).padStart(2, "0")}`,
      delivery_status: "failed",
      processing: "failed",
      error: { code: "RELAY_RATE_LIMITED", message: "rate limited" },
    }));
    assert.throws(
      () => projectBatchSendReceipt({
        batchId: "batch_extreme_16",
        text: "short",
        results: extremeResults,
      }),
      (err) => err instanceof CoreError
        && err.code === "invalid_input"
        && err.details.budget === 9216
        && err.details.receipt_bytes >= 9216,
    );

    // 3. compactError lowercase snake_case normalization across diverse inputs
    const codeReceipt = projectBatchSendReceipt({
      batchId: "batch_code_norm",
      text: "hi",
      results: [
        { target: makeTarget("dev", "codex", "c1"), error: { code: "host_offline", message: "m1" } },
        { target: makeTarget("dev", "codex", "c2"), error: { code: "RELAY_ROUTE_CHANGED", message: "m2" } },
        { target: makeTarget("dev", "codex", "c3"), error: { code: "TargetOfflineError", message: "m3" } },
        { target: makeTarget("dev", "codex", "c4"), error: { code: "HTTP-503 Error!", message: "m4" } },
        { target: makeTarget("dev", "codex", "c5"), error: { code: "123_INVALID", message: "m5" } },
        { target: makeTarget("dev", "codex", "c6"), error: { code: "中文错误码", message: "m6" } },
        { target: makeTarget("dev", "codex", "c7"), error: new CoreError("RELAY_DEDUPE_CONFLICT", "m7") },
      ],
    });
    assert.deepEqual(
      codeReceipt.results.map((r) => r.error.code),
      [
        "host_offline",
        "relay_route_changed",
        "target_offline_error",
        "http_503_error",
        "delivery_failed",
        "delivery_failed",
        "relay_dedupe_conflict",
      ],
    );
  });
});
