import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CoreError } from "../src/contracts.mjs";
import {
  ALLOWED_RELAY_OPS,
  computeBodySha256,
  cqEncodedLength,
  decodeRelayFrame,
  DEFAULT_MAX_FRAME_CHARS,
  encodeRelayFrame,
  formatEndpoint,
  inspectLegacyNapcatCollisions,
  LEGACY_NAPCAT_FIELD_REGEXES,
  MAX_CONFIGURABLE_FRAME_CHARS,
  parseEndpoint,
  RELAY_FRAME_END,
  RELAY_FRAME_START,
} from "../src/relay-envelope.mjs";

function encodeCqValue(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/\[/g, "&#91;")
    .replace(/\]/g, "&#93;")
    .replace(/,/g, "&#44;");
}

function decodeCqValue(value) {
  return String(value ?? "")
    .replace(/&#91;/g, "[")
    .replace(/&#93;/g, "]")
    .replace(/&#44;/g, ",")
    .replace(/&amp;/g, "&");
}

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
  const normalizedText = String(text ?? "").replace(/\r\n/g, "\n").trim();
  const firstLine = normalizedText.split("\n").find((line) => line.trim())?.trim() ?? "";
  if (firstLine === "[Codex][CONNECTION_REQUEST]") metadata.messageType = "connection_request";
  else if (firstLine === "[Codex][DELIVERY_RECEIPT]") metadata.messageType = "delivery_receipt";
  else if (firstLine === "[Codex][OWNER_REPLY]") metadata.messageType = "owner_reply";
  for (const line of normalizedText.split("\n")) {
    const taskMatch = line.match(LEGACY_NAPCAT_FIELD_REGEXES[0]);
    if (taskMatch) metadata.taskId = taskMatch[1].trim().slice(0, 128);
    const sourceMatch = line.match(LEGACY_NAPCAT_FIELD_REGEXES[1]);
    if (sourceMatch) metadata.sourceMachine = sourceMatch[1].trim().slice(0, 64);
    const targetMatch = line.match(LEGACY_NAPCAT_FIELD_REGEXES[2]);
    if (targetMatch) metadata.targetMachine = targetMatch[1].trim().slice(0, 64);
    const deliveryMatch = line.match(LEGACY_NAPCAT_FIELD_REGEXES[3]);
    if (deliveryMatch) metadata.deliveryId = deliveryMatch[1].trim().slice(0, 128);
    const requestMatch = line.match(LEGACY_NAPCAT_FIELD_REGEXES[4]);
    if (requestMatch) metadata.requestId = requestMatch[1].trim().slice(0, 128);
    const sourceConvMatch = line.match(LEGACY_NAPCAT_FIELD_REGEXES[5]);
    if (sourceConvMatch) metadata.sourceConversationId = sourceConvMatch[1].trim().slice(0, 256);
    const targetConvMatch = line.match(LEGACY_NAPCAT_FIELD_REGEXES[6]);
    if (targetConvMatch) metadata.targetConversationId = targetConvMatch[1].trim().slice(0, 256);
    const receiptMatch = line.match(LEGACY_NAPCAT_FIELD_REGEXES[7]);
    if (receiptMatch) metadata.receiptStage = receiptMatch[1].trim().slice(0, 64);
    const seqMatch = line.match(LEGACY_NAPCAT_FIELD_REGEXES[8]);
    if (seqMatch) metadata.deliveryMessageSeq = seqMatch[1].trim().slice(0, 64);
    const proposedMatch = line.match(LEGACY_NAPCAT_FIELD_REGEXES[9]);
    if (proposedMatch) metadata.proposedTaskId = proposedMatch[1].trim().slice(0, 128);
    const previousMatch = line.match(LEGACY_NAPCAT_FIELD_REGEXES[10]);
    if (previousMatch) metadata.previousTaskId = previousMatch[1].trim().slice(0, 128);
    const routeMatch = line.match(LEGACY_NAPCAT_FIELD_REGEXES[11]);
    if (routeMatch) metadata.routeKey = routeMatch[1].trim().slice(0, 256);
    const replyReqMatch = line.match(LEGACY_NAPCAT_FIELD_REGEXES[12]);
    if (replyReqMatch) metadata.replyRequired = replyReqMatch[1].toLowerCase() === "true";
    const expectedMatch = line.match(LEGACY_NAPCAT_FIELD_REGEXES[13]);
    if (expectedMatch) metadata.expectedReply = expectedMatch[1].trim().slice(0, 240);
    const deadlineMatch = line.match(LEGACY_NAPCAT_FIELD_REGEXES[14]);
    if (deadlineMatch) metadata.replyDeadlineAt = deadlineMatch[1].trim().slice(0, 64);
    const nextCheckMatch = line.match(LEGACY_NAPCAT_FIELD_REGEXES[15]);
    if (nextCheckMatch) metadata.nextCheckAt = nextCheckMatch[1].trim().slice(0, 64);
  }
  return metadata;
}

function legacyTaskFileIndexMetadata(text) {
  const normalizedText = String(text ?? "").replace(/\r\n/g, "\n").trim();
  if (!normalizedText.includes("[Codex][TASK_FILE_INDEX]")) return null;
  const metadata = { fileId: "" };
  for (const line of normalizedText.split("\n")) {
    const fileIdMatch = line.match(/^file_id\s*[：:]\s*(.+)$/i);
    if (fileIdMatch) metadata.fileId = fileIdMatch[1].trim();
  }
  return metadata.fileId ? metadata : null;
}

function legacyOneBotControlSegments(message) {
  const mentionedUserIds = [];
  let replyMessageId = "";
  if (Array.isArray(message?.message)) {
    for (const segment of message.message) {
      if (segment?.type === "at") {
        const userId = String(segment?.data?.qq ?? segment?.data?.user_id ?? "");
        if (userId) mentionedUserIds.push(userId);
      }
      if (segment?.type === "reply" && !replyMessageId) {
        replyMessageId = String(segment?.data?.id ?? segment?.data?.message_id ?? "");
      }
    }
  }
  const rawMessage = typeof message?.raw_message === "string" ? message.raw_message : "";
  for (const match of rawMessage.matchAll(/\[CQ:(at|reply)(?:,([^\]]*))?\]/g)) {
    const attributes = {};
    for (const part of String(match[2] ?? "").split(",")) {
      const sep = part.indexOf("=");
      if (sep <= 0) continue;
      attributes[part.slice(0, sep)] = decodeCqValue(part.slice(sep + 1));
    }
    if (match[1] === "at") {
      const userId = String(attributes.qq ?? attributes.user_id ?? "");
      if (userId) mentionedUserIds.push(userId);
    }
    if (match[1] === "reply" && !replyMessageId) {
      replyMessageId = String(attributes.id ?? attributes.message_id ?? "");
    }
  }
  return {
    mentionedUserIds: [...new Set(mentionedUserIds)],
    replyMessageId,
  };
}

function makeBaseFrameInput(overrides = {}) {
  return {
    relay_id: "rly_00000000-0000-4000-8000-000000000001",
    op: "message",
    from_machine: "machine_alpha",
    to_machine: "machine_beta",
    source: { host: "antigravity", surface: "desktop", conversation_id: "conv_src_01" },
    recipients: [
      { host: "codex", surface: "desktop", conversation_id: "conv_dst_01" },
      { host: "antigravity", surface: "desktop", conversation_id: "conv_dst_02" },
    ],
    meta: { request_id: "req_001", hop_count: 1 },
    body: "测试正文内容",
    ...overrides,
  };
}

describe("relay-envelope constants and op whitelist", () => {
  it("exports exact frame delimiters, limits, 15 ops, and 16 legacy regexes", () => {
    assert.equal(RELAY_FRAME_START, "[COMM_RELAY_V1]");
    assert.equal(RELAY_FRAME_END, "[END_COMM_RELAY_V1]");
    assert.equal(DEFAULT_MAX_FRAME_CHARS, 1800);
    assert.equal(MAX_CONFIGURABLE_FRAME_CHARS, 1900);
    assert.equal(ALLOWED_RELAY_OPS.size, 15);
    assert.equal(LEGACY_NAPCAT_FIELD_REGEXES.length, 16);
    assert.ok(Object.isFrozen(LEGACY_NAPCAT_FIELD_REGEXES));
    assert.ok(LEGACY_NAPCAT_FIELD_REGEXES.every((re) => re instanceof RegExp));

    const expectedOps = [
      "message",
      "delivery_ack",
      "processing_ack",
      "status_query",
      "status_reply",
      "list_query",
      "list_reply",
      "snapshot_query",
      "snapshot_reply",
      "board_delta",
      "board_dissolved",
      "board_state_sync",
      "board_ack",
      "file_notice",
      "file_ack",
    ];
    for (const op of expectedOps) {
      assert.equal(ALLOWED_RELAY_OPS.has(op), true, `missing op: ${op}`);
      const encoded = encodeRelayFrame(makeBaseFrameInput({ op }));
      const decoded = decodeRelayFrame(encoded.frameText);
      assert.equal(decoded.ok, true);
      assert.equal(decoded.frame.op, op);
    }
  });

  it("rejects unsupported op on both encode and decode", () => {
    assert.throws(
      () => encodeRelayFrame(makeBaseFrameInput({ op: "arbitrary_exec" })),
      (err) => err instanceof CoreError && err.code === "unsupported_op",
    );

    const valid = encodeRelayFrame(makeBaseFrameInput());
    const tampered = valid.frameText.replace("op: message", "op: arbitrary_exec");
    const decoded = decodeRelayFrame(tampered);
    assert.deepEqual(decoded, { ok: false, reason: "unsupported_op" });
  });
});

describe("endpoint formatting and injection defenses", () => {
  it("formats and parses 3-segment endpoints and restricts 2-segment fallback to desktop agent hosts", () => {
    assert.equal(
      formatEndpoint({ host: "antigravity", surface: "desktop", conversation_id: "conv_1" }),
      "antigravity/desktop/conv_1",
    );
    assert.equal(
      formatEndpoint({ host: "codex", conversation_id: "conv_2" }),
      "codex/desktop/conv_2",
    );
    assert.equal(
      formatEndpoint({ host: "windsurf", conversation_id: "conv_3" }),
      "windsurf/desktop/conv_3",
    );

    assert.deepEqual(parseEndpoint("antigravity/conv_1"), {
      host: "antigravity",
      surface: "desktop",
      conversation_id: "conv_1",
    });
    assert.deepEqual(parseEndpoint("codex/conv_2"), {
      host: "codex",
      surface: "desktop",
      conversation_id: "conv_2",
    });
    assert.deepEqual(parseEndpoint("windsurf/conv_3"), {
      host: "windsurf",
      surface: "desktop",
      conversation_id: "conv_3",
    });
    assert.deepEqual(parseEndpoint("qq/group/room_demo_1"), {
      host: "qq",
      surface: "group",
      conversation_id: "room_demo_1",
    });

    for (const forbiddenHost of ["qq", "wechat", "custom_bot"]) {
      assert.throws(
        () => parseEndpoint(`${forbiddenHost}/id_1`),
        (err) => err instanceof CoreError && err.code === "invalid_input",
      );
      assert.throws(
        () => formatEndpoint({ host: forbiddenHost, conversation_id: "id_1" }),
        (err) => err instanceof CoreError && err.code === "invalid_input",
      );
    }
  });

  it("blocks separators, commas, whitespace, wildcards, and control characters in endpoint segments", () => {
    const badSegments = [
      "bad/id",
      "bad,id",
      "bad id",
      "bad\tid",
      "bad\nid",
      "bad*id",
      "*",
      "bad\u0000id",
      "bad\u007fid",
    ];
    for (const seg of badSegments) {
      assert.throws(
        () => formatEndpoint({ host: "codex", surface: "desktop", conversation_id: seg }),
        (err) => err instanceof CoreError && err.code === "invalid_input",
      );
      assert.throws(
        () => parseEndpoint(`codex/desktop/${seg}`),
        (err) => err instanceof CoreError && err.code === "invalid_input",
      );
    }
    assert.throws(
      () => parseEndpoint("single_segment"),
      (err) => err instanceof CoreError && err.code === "invalid_input",
    );
    assert.throws(
      () => parseEndpoint("a/b/c/d"),
      (err) => err instanceof CoreError && err.code === "invalid_input",
    );
  });
});

describe("matrix 1: CQ encoding expansion and frame length budget", () => {
  it("computes cqEncodedLength identically to OneBot CQ escaping (& [ ] , each +4)", () => {
    const samples = [
      "",
      "plain ascii & 中文",
      "[CQ:at,qq=123]&[a,b]",
      "&&&&[[[[]]]],,,,",
    ];
    for (const sample of samples) {
      assert.equal(cqEncodedLength(sample), encodeCqValue(sample).length);
    }
  });

  it("throws lowercase relay_frame_too_large when raw length <= 1800 but high-density CQ chars push cqLength > 1800", () => {
    const densePayload = "[,&]".repeat(120); // 480 raw chars -> 480 * 5 = 2400 CQ chars
    let caught = null;
    try {
      encodeRelayFrame(makeBaseFrameInput({ body: densePayload }));
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof CoreError);
    assert.equal(caught.code, "relay_frame_too_large");
    assert.ok(caught.details.frame_length <= DEFAULT_MAX_FRAME_CHARS);
    assert.ok(caught.details.cq_encoded_length > DEFAULT_MAX_FRAME_CHARS);
    assert.equal(caught.details.max_frame_chars, DEFAULT_MAX_FRAME_CHARS);
    assert.equal(caught.details.suggest_file_bundle, true);
  });

  it("allows lossless round-trip right up to cqEncodedLength <= 1800 and enforces MAX_CONFIGURABLE_FRAME_CHARS <= 1900", () => {
    const probe = encodeRelayFrame(makeBaseFrameInput({ body: "x" }));
    const overheadCq = probe.cqLength - 1;
    const maxSafeChars = DEFAULT_MAX_FRAME_CHARS - overheadCq;
    const boundaryBody = "a".repeat(maxSafeChars);

    const encoded = encodeRelayFrame(makeBaseFrameInput({ body: boundaryBody }));
    assert.equal(encoded.cqLength, DEFAULT_MAX_FRAME_CHARS);
    assert.ok(encoded.charLength <= DEFAULT_MAX_FRAME_CHARS);

    const decoded = decodeRelayFrame(encoded.frameText);
    assert.equal(decoded.ok, true);
    assert.equal(decoded.frame.body, boundaryBody);

    assert.throws(
      () => encodeRelayFrame(makeBaseFrameInput({ body: `${boundaryBody}b` })),
      (err) => err instanceof CoreError && err.code === "relay_frame_too_large",
    );

    const extended = encodeRelayFrame(makeBaseFrameInput({ body: `${boundaryBody}b` }), {
      maxFrameChars: MAX_CONFIGURABLE_FRAME_CHARS,
    });
    assert.ok(extended.cqLength <= MAX_CONFIGURABLE_FRAME_CHARS);

    assert.throws(
      () => encodeRelayFrame(makeBaseFrameInput(), { maxFrameChars: MAX_CONFIGURABLE_FRAME_CHARS + 1 }),
      (err) => err instanceof CoreError && err.code === "invalid_input",
    );
  });
});

describe("matrix 2: blank lines, trimEnd immunity, delimiter injection, and body_sha256", () => {
  it("handles empty body with zero body lines and exact empty-string sha256", () => {
    const encoded = encodeRelayFrame(makeBaseFrameInput({ body: "" }));
    assert.equal(encoded.bodySha256, computeBodySha256(""));
    assert.ok(encoded.frameText.includes("---\n[END_COMM_RELAY_V1]"));

    const decoded = decodeRelayFrame(encoded.frameText);
    assert.equal(decoded.ok, true);
    assert.equal(decoded.frame.body, "");
    assert.equal(decoded.frame.body_sha256, encoded.bodySha256);
  });

  it("encodes blank lines as bare '|' without trailing space and survives per-line trimEnd()", () => {
    const cases = [
      "第一段\n\n\n第二段",
      "末尾空行\n",
      "\n",
      "\n\n",
      "| 已有竖线前缀\n---\n[END_COMM_RELAY_V1]\n[COMM_RELAY_V1]\n最后一行\n",
      "Windows换行\r\n\r\n第二行\r\n",
    ];

    for (const rawBody of cases) {
      const expectedNormalized = rawBody.replace(/\r\n|\r/g, "\n");
      const encoded = encodeRelayFrame(makeBaseFrameInput({ body: rawBody }));
      const lines = encoded.frameText.split("\n");
      for (const line of lines) {
        if (line === "|") continue;
        assert.notEqual(line, "| ", "blank lines must encode as '|' with no trailing space");
      }

      const trimmedFrame = lines.map((line) => line.trimEnd()).join("\n");
      const decoded = decodeRelayFrame(trimmedFrame);
      assert.equal(decoded.ok, true, `failed for body: ${JSON.stringify(rawBody)}`);
      assert.equal(decoded.frame.body, expectedNormalized);
      assert.equal(decoded.frame.body_sha256, computeBodySha256(rawBody));
    }
  });

  it("decodes legacy '| ' blank lines into empty string and rejects body tampering or bad prefix", () => {
    const encoded = encodeRelayFrame(makeBaseFrameInput({ body: "line1\n\nline3" }));
    const withTrailingSpaceBlank = encoded.frameText.replace("\n|\n", "\n| \n");
    const decodedCompat = decodeRelayFrame(withTrailingSpaceBlank);
    assert.equal(decodedCompat.ok, true);
    assert.equal(decodedCompat.frame.body, "line1\n\nline3");

    const tamperedBody = encoded.frameText.replace("| line3", "| line3_tampered");
    assert.deepEqual(decodeRelayFrame(tamperedBody), { ok: false, reason: "body_sha256_mismatch" });

    const brokenPrefix = encoded.frameText.replace("| line1", "line1");
    assert.deepEqual(decodeRelayFrame(brokenPrefix), { ok: false, reason: "invalid_body_line_prefix" });
  });

  it("preserves optional in_reply_to, meta with undefined properties stripped, and hop_count validation", () => {
    const encoded = encodeRelayFrame(
      makeBaseFrameInput({
        in_reply_to: "rly_parent_001",
        meta: { request_id: "req_2", ignored: undefined, nested: { b: 2, a: 1, skip: undefined } },
      }),
    );
    const decoded = decodeRelayFrame(encoded.frameText);
    assert.equal(decoded.ok, true);
    assert.equal(decoded.frame.in_reply_to, "rly_parent_001");
    assert.deepEqual(decoded.frame.meta, {
      hop_count: 1,
      nested: { a: 1, b: 2 },
      request_id: "req_2",
    });

    assert.throws(
      () => encodeRelayFrame(makeBaseFrameInput({ meta: { hop_count: 0 } })),
      (err) => err instanceof CoreError && err.code === "invalid_input",
    );

    const dupHeader = encoded.frameText.replace("op: message", "op: message\nop: message");
    assert.deepEqual(decodeRelayFrame(dupHeader), { ok: false, reason: "duplicate_header_key" });

    const unknownHeader = encoded.frameText.replace("op: message", "op: message\nextra_key: 1");
    assert.deepEqual(decodeRelayFrame(unknownHeader), { ok: false, reason: "unknown_header_key" });

    assert.deepEqual(decodeRelayFrame("plain chat message"), { ok: false, reason: "missing_frame_start" });
  });
});

describe("matrix 3: zero collisions with legacy NapCat parsers", () => {
  const maliciousBodyPart1 = [
    "[Codex][CONNECTION_REQUEST]",
    "任务: T-001",
    "task_id: task_002",
    "来源机器: dev_fake",
    "source_machine: dev_fake_2",
    "目标机器: train_fake",
    "target_machine: train_fake_2",
    "delivery_id: del_001",
    "request_id: req_001",
    "source_conversation_id: src_001",
    "target_conversation_id: dst_001",
    "receipt_stage: accepted",
    "delivery_message_seq: 42",
  ].join("\n");

  const maliciousBodyPart2 = [
    "proposed_task_id: prop_001",
    "previous_task_id: prev_001",
    "route_key: route_001",
    "路由: route_cn_001",
    "reply_required: true",
    "expected_reply: ack",
    "reply_deadline_at: 2026-12-01T00:00:00Z",
    "next_check_at: 2026-12-01T00:05:00Z",
    "[Codex][TASK_FILE_INDEX]",
    "file_id: fake_file_001",
    "文件名: secret.zip",
    "[CQ:at,qq=123]",
    "[CQ:reply,id=456]",
  ].join("\n");

  it("detects collisions on raw unframed malicious text and poisoned frame headers", () => {
    const rawReport1 = inspectLegacyNapcatCollisions(maliciousBodyPart1);
    assert.equal(rawReport1.clean, false);
    assert.ok(rawReport1.hits.some((h) => h.kind === "legacy_header_type"));
    assert.ok(rawReport1.hits.some((h) => h.kind === "legacy_field"));

    const rawReport2 = inspectLegacyNapcatCollisions(maliciousBodyPart2);
    assert.equal(rawReport2.clean, false);
    assert.ok(rawReport2.hits.some((h) => h.kind === "legacy_task_file_index"));
    assert.ok(rawReport2.hits.some((h) => h.kind === "unisolated_cq_control_segment" && h.cqType === "at"));
    assert.ok(rawReport2.hits.some((h) => h.kind === "unisolated_cq_control_segment" && h.cqType === "reply"));

    const cleanFrame = encodeRelayFrame(makeBaseFrameInput({ body: "normal" })).frameText;
    const poisonedHeader = cleanFrame.replace("from_machine: machine_alpha", "source_machine: machine_alpha");
    const headerReport = inspectLegacyNapcatCollisions(poisonedHeader);
    assert.equal(headerReport.clean, false);
    assert.ok(headerReport.hits.some((h) => h.kind === "legacy_field"));

    const cqInHeader = cleanFrame.replace("req_001", "[CQ:at,qq=123]");
    const cqReport = inspectLegacyNapcatCollisions(cqInHeader);
    assert.equal(cqReport.clean, false);
    assert.ok(cqReport.hits.some((h) => h.kind === "unisolated_cq_control_segment"));
  });

  it("produces zero legacy triggers across all 16 fields, TASK_FILE_INDEX, and OneBot CQ control segments once framed", () => {
    for (const payload of [maliciousBodyPart1, maliciousBodyPart2]) {
      const encoded = encodeRelayFrame(makeBaseFrameInput({ body: payload }));
      const inspection = inspectLegacyNapcatCollisions(encoded.frameText);
      assert.deepEqual(inspection, { clean: true, hits: [] });

      const taskMeta = legacyStructuredTaskMetadata(encoded.frameText);
      assert.equal(taskMeta.messageType, "business");
      assert.equal(taskMeta.taskId, "");
      assert.equal(taskMeta.sourceMachine, "");
      assert.equal(taskMeta.targetMachine, "");
      assert.equal(taskMeta.deliveryId, "");
      assert.equal(taskMeta.requestId, "");
      assert.equal(taskMeta.sourceConversationId, "");
      assert.equal(taskMeta.targetConversationId, "");
      assert.equal(taskMeta.receiptStage, "");
      assert.equal(taskMeta.deliveryMessageSeq, "");
      assert.equal(taskMeta.proposedTaskId, "");
      assert.equal(taskMeta.previousTaskId, "");
      assert.equal(taskMeta.routeKey, "");
      assert.equal(taskMeta.replyRequired, false);
      assert.equal(taskMeta.expectedReply, "");
      assert.equal(taskMeta.replyDeadlineAt, "");
      assert.equal(taskMeta.nextCheckAt, "");

      assert.equal(legacyTaskFileIndexMetadata(encoded.frameText), null);

      const simulatedWireMessage = {
        message: [{ type: "text", data: { text: encoded.frameText } }],
        raw_message: encodeCqValue(encoded.frameText),
      };
      const controls = legacyOneBotControlSegments(simulatedWireMessage);
      assert.deepEqual(controls, { mentionedUserIds: [], replyMessageId: "" });

      const decoded = decodeRelayFrame(encoded.frameText);
      assert.equal(decoded.ok, true);
      assert.equal(decoded.frame.body, payload);
    }
  });
});

describe("P2-1: meta cycle/depth protection and 16-recipient cap on encode and decode", () => {
  it("rejects circular object/array meta and >32 nested depth with CoreError(invalid_input) instead of RangeError", () => {
    const circularObj = { hop_count: 1 };
    circularObj.self = circularObj;
    assert.throws(
      () => encodeRelayFrame(makeBaseFrameInput({ meta: circularObj })),
      (err) => err instanceof CoreError && err.code === "invalid_input",
    );

    const circularArr = [];
    circularArr.push(circularArr);
    assert.throws(
      () => encodeRelayFrame(makeBaseFrameInput({ meta: { hop_count: 1, loop: circularArr } })),
      (err) => err instanceof CoreError && err.code === "invalid_input",
    );

    let deep = { leaf: "ok" };
    for (let i = 0; i < 35; i += 1) {
      deep = { nested: deep };
    }
    assert.throws(
      () => encodeRelayFrame(makeBaseFrameInput({ meta: { hop_count: 1, deep } })),
      (err) => err instanceof CoreError && err.code === "invalid_input",
    );

    // Non-circular shared DAG reference in meta is permitted
    const shared = { tag: "reused" };
    const dagEncoded = encodeRelayFrame(makeBaseFrameInput({
      meta: { hop_count: 1, a: shared, b: shared },
    }));
    const dagDecoded = decodeRelayFrame(dagEncoded.frameText);
    assert.equal(dagDecoded.ok, true);
    assert.deepEqual(dagDecoded.frame.meta, {
      a: { tag: "reused" },
      b: { tag: "reused" },
      hop_count: 1,
    });

    // Decode also rejects overly deep meta JSON (>32 levels)
    let deepJson = '{"leaf":1}';
    for (let i = 0; i < 35; i += 1) {
      deepJson = `{"n":${deepJson}}`;
    }
    const baseFrame = encodeRelayFrame(makeBaseFrameInput({ body: "hi" })).frameText;
    const poisonedDeepMeta = baseFrame.replace(/^meta: .*$/m, `meta: ${deepJson}`);
    assert.deepEqual(decodeRelayFrame(poisonedDeepMeta), { ok: false, reason: "invalid_meta_object" });
  });

  it("allows up to 16 recipients and rejects >16 recipients on both encodeRelayFrame and decodeRelayFrame", () => {
    const sixteen = Array.from({ length: 16 }, (_, idx) => ({
      host: "codex",
      surface: "desktop",
      conversation_id: `c${idx}`,
    }));
    const encoded16 = encodeRelayFrame(makeBaseFrameInput({ recipients: sixteen, body: "ok" }));
    const decoded16 = decodeRelayFrame(encoded16.frameText);
    assert.equal(decoded16.ok, true);
    assert.equal(decoded16.frame.recipients.length, 16);

    const seventeen = [
      ...sixteen,
      { host: "codex", surface: "desktop", conversation_id: "c16" },
    ];
    assert.throws(
      () => encodeRelayFrame(makeBaseFrameInput({ recipients: seventeen, body: "too many" })),
      (err) => err instanceof CoreError && err.code === "invalid_input",
    );

    const forged17Frame = encoded16.frameText.replace(
      /^recipients: (.+)$/m,
      "$&, codex/desktop/c16",
    );
    assert.deepEqual(decodeRelayFrame(forged17Frame), { ok: false, reason: "too_many_recipients" });
  });
});
