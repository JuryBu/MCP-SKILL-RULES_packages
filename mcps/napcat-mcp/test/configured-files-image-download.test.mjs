import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createNapCatNotifier } from "../src/core.mjs";

const imagePayload = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);
const selfId = "1000000001";
const peerId = "1000000002";
const groupId = "2000000001";

function createImageFixture(context, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "napcat-configured-image-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bindingPath = path.join(root, "binding.json");
  fs.writeFileSync(bindingPath, JSON.stringify({
    schemaVersion: 2,
    expectedSelfId: selfId,
    groupId: "2000000099",
    groupName: "ExampleTraining",
    expectedMemberCount: 4,
    controlPlane: {
      enabled: true,
      defaultTargetKey: "room",
      targets: {
        room: { type: "group", id: groupId, name: "ExampleRoom", expectedMemberCount: 3 },
        owner: { type: "private", id: peerId, name: "ExamplePeer" },
      },
    },
  }), "utf8");
  const calls = [];
  const historyMessage = options.historyMessage ?? {
    message_id: "701",
    message_seq: "801",
    message_type: "group",
    group_id: groupId,
    user_id: peerId,
    time: 1794816100,
    sender: { user_id: peerId, nickname: "ExamplePeer" },
    raw_message: `[CQ:image,file=SAMPLE01.jpg,sub_type=0,file_size=${imagePayload.length}]`,
    message: `[CQ:image,file=SAMPLE01.jpg,sub_type=0,file_size=${imagePayload.length}]`,
  };
  const getMsgResponse = options.getMsgResponse ?? {
    ...historyMessage,
    raw_message: `[CQ:image,file=SAMPLE01.jpg,sub_type=0,url=https://media.example.invalid/from-get-msg,file_size=${imagePayload.length}]`,
    message: `[CQ:image,file=SAMPLE01.jpg,sub_type=0,url=https://media.example.invalid/from-get-msg,file_size=${imagePayload.length}]`,
  };
  const fetchImpl = async (url, request = {}) => {
    const parsed = new URL(url);
    if (parsed.hostname === "127.0.0.1") {
      const action = parsed.pathname.slice(1);
      const params = JSON.parse(request.body);
      calls.push({ action, params });
      let data;
      switch (action) {
        case "get_status": data = { online: true, good: true }; break;
        case "get_login_info": data = { user_id: selfId, nickname: "ExampleBot" }; break;
        case "get_friend_list": data = [{ user_id: peerId, nickname: "ExamplePeer" }]; break;
        case "get_group_info": data = { group_id: params.group_id, group_name: "ExampleRoom", member_count: 3 }; break;
        case "get_group_msg_history":
        case "get_friend_msg_history": data = { messages: [historyMessage] }; break;
        case "get_msg": data = getMsgResponse; break;
        case "get_image":
          if (options.onGetImage) {
            data = await options.onGetImage(params, request);
          } else {
            data = options.getImageData ?? {
              file: "C:\\never-read-local-path\\sample01.jpg",
              url: "https://media.example.invalid/get-image-download",
              file_size: String(imagePayload.length),
              file_name: "SAMPLE01.jpg",
            };
          }
          break;
        default: throw new Error(`Unexpected action: ${action}`);
      }
      return new Response(JSON.stringify({ status: "ok", retcode: 0, data }));
    }
    calls.push({ action: "download", url });
    return new Response(options.bytes ?? imagePayload, { headers: { "content-type": "image/jpeg", ...(options.headers ?? {}) } });
  };
  const notifier = createNapCatNotifier({
    env: {
      NAPCAT_MCP_BINDING_PATH: bindingPath,
      NAPCAT_MCP_STATE_PATH: path.join(root, "state.json"),
      NAPCAT_HTTP_URL: "http://127.0.0.1:39123",
      NAPCAT_ALLOW_EMPTY_TOKEN: "1",
      ...(options.maximumBytes ? { NAPCAT_MAX_FILE_BYTES: String(options.maximumBytes) } : {}),
    },
    fetchImpl,
  });
  return { root, calls, notifier };
}

test("group CQ image downloads via get_image even when history omits url and get_msg includes url", async (context) => {
  const setup = createImageFixture(context);
  const recent = await setup.notifier.readConfiguredRecent({ target_key: "room" });
  const att = recent.messages[0].attachments[0];
  assert.equal(att.type, "image");
  assert.equal(att.fileId, "SAMPLE01.jpg");
  assert.equal(att.fileName, "SAMPLE01.jpg");
  assert.equal(att.fileBytes, imagePayload.length);
  assert.equal(att.busId, null);
  assert.equal(att.downloadable, true);
  assert.match(att.attachment_ref, /^ncf1:[a-f0-9]{64}$/);
  assert.equal("url" in att, false);

  const destDir = path.join(setup.root, "images");
  const result = await setup.notifier.downloadConfiguredFile({
    target_key: "room",
    message_id: "701",
    attachment_ref: att.attachment_ref,
    destination_dir: destDir,
  });
  assert.equal(result.downloaded, true);
  assert.equal(result.fileName, "SAMPLE01.jpg");
  assert.equal(result.fileBytes, imagePayload.length);
  assert.equal(result.resolvedBusId, null);
  assert.equal(result.sha256, createHash("sha256").update(imagePayload).digest("hex"));
  assert.deepEqual(fs.readFileSync(result.filePath), imagePayload);
  assert.deepEqual(setup.calls.find((c) => c.action === "get_image")?.params, { file: "SAMPLE01.jpg" });
  assert.equal(setup.calls.some((c) => c.action.endsWith("file_url")), false);
  assert.equal(setup.calls.find((c) => c.action === "download")?.url, "https://media.example.invalid/get-image-download");
});

test("private image downloads via get_image for both inbound peer and outbound self messages", async (context) => {
  for (const senderId of [peerId, selfId]) {
    const privateMsg = {
      message_id: "702",
      message_seq: "802",
      message_type: "private",
      user_id: senderId,
      time: 1794816200,
      sender: { user_id: senderId },
      raw_message: "[CQ:image,file=PRIVATE02.png]",
      message: [{ type: "image", data: { file: "PRIVATE02.png", sub_type: 0 } }],
    };
    const setup = createImageFixture(context, {
      historyMessage: privateMsg,
      getMsgResponse: privateMsg,
      getImageData: {
        url: "https://media.example.invalid/private-02",
        file_name: "PRIVATE02.png",
      },
    });
    const recent = await setup.notifier.readConfiguredRecent({ target_key: "owner" });
    const att = recent.messages[0].attachments[0];
    assert.equal(att.type, "image");
    assert.equal(att.fileBytes, null);
    assert.equal(att.downloadable, true);

    const result = await setup.notifier.downloadConfiguredFile({
      target_key: "owner",
      message_id: "702",
      attachment_ref: att.attachment_ref,
      destination_dir: path.join(setup.root, `priv-${senderId}`),
    });
    assert.equal(result.downloaded, true);
    assert.equal(result.fileName, "PRIVATE02.png");
    assert.equal(result.fileBytes, imagePayload.length);
    assert.deepEqual(fs.readFileSync(result.filePath), imagePayload);
  }
});

test("image download rejects local file:// url, missing url, size mismatch and oversize without reading local disk", async (context) => {
  for (const scenario of [
    { getImageData: { file: "C:\\Windows\\win.ini", url: "file:///C:/Windows/win.ini" }, expected: "FILE_URL_INVALID" },
    { getImageData: { file: "C:\\Windows\\win.ini" }, expected: "FILE_URL_INVALID" },
    { bytes: Buffer.from([1, 2, 3]), expected: "FILE_SIZE_MISMATCH" },
    { maximumBytes: 4, expected: "FILE_TOO_LARGE" },
  ]) {
    const setup = createImageFixture(context, scenario);
    const recent = await setup.notifier.readConfiguredRecent({ target_key: "room" });
    const destDir = path.join(setup.root, `err-${scenario.expected}`);
    await assert.rejects(setup.notifier.downloadConfiguredFile({
      target_key: "room",
      message_id: "701",
      attachment_ref: recent.messages[0].attachments[0].attachment_ref,
      destination_dir: destDir,
    }), { code: scenario.expected });
    if (fs.existsSync(destDir)) assert.deepEqual(fs.readdirSync(destDir), []);
  }
});

test("image without safe attachment fileName falls back to get_image file_name then napcat-image prefix", async (context) => {
  const unsafeMsg = {
    message_id: "703",
    message_seq: "803",
    message_type: "group",
    group_id: groupId,
    user_id: peerId,
    time: 1794816300,
    sender: { user_id: peerId },
    raw_message: "[CQ:image,file=bad/path:name]",
    message: [{ type: "image", data: { file: "bad/path:name" } }],
  };
  const setup1 = createImageFixture(context, {
    historyMessage: unsafeMsg,
    getMsgResponse: unsafeMsg,
    getImageData: { url: "https://media.example.invalid/safe-remote", file_name: "remote-safe.webp" },
  });
  const recent1 = await setup1.notifier.readConfiguredRecent({ target_key: "room" });
  const r1 = await setup1.notifier.downloadConfiguredFile({
    target_key: "room",
    message_id: "703",
    attachment_ref: recent1.messages[0].attachments[0].attachment_ref,
    destination_dir: path.join(setup1.root, "remote-name"),
  });
  assert.equal(r1.fileName, "remote-safe.webp");

  const setup2 = createImageFixture(context, {
    historyMessage: unsafeMsg,
    getMsgResponse: unsafeMsg,
    getImageData: { url: "https://media.example.invalid/no-name", file_name: "../evil.jpg" },
  });
  const recent2 = await setup2.notifier.readConfiguredRecent({ target_key: "room" });
  const ref2 = recent2.messages[0].attachments[0].attachment_ref;
  const r2 = await setup2.notifier.downloadConfiguredFile({
    target_key: "room",
    message_id: "703",
    attachment_ref: ref2,
    destination_dir: path.join(setup2.root, "fallback-name"),
  });
  assert.equal(r2.fileName, `napcat-image-${ref2.slice(5, 17)}`);
});
