import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { stageRelayFileBundle, writeRelayFileBundle } from "../src/file-bundle-codec.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

async function setup(context) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "napcat-relay-data-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const sender = path.join(root, "建包 临时区");
  const receiver = path.join(root, "验包 临时区");
  await fs.mkdir(sender);
  await fs.mkdir(receiver);
  const writeSource = async (name, body) => {
    const filePath = path.join(root, name);
    await fs.writeFile(filePath, body);
    return { name, filePath };
  };
  return { sender, receiver, writeSource };
}

test("整包和每项内容精确往返，标签不决定接收端路径", async (context) => {
  const { sender, receiver, writeSource } = await setup(context);
  const binary = Buffer.alloc(210 * 1024);
  for (let offset = 0; offset < binary.length; offset += 1) binary[offset] = offset % 239;
  const details = await writeSource("报告 一.bin", binary);
  const empty = await writeSource("空文件.txt", "");
  const bundle = await writeRelayFileBundle({ workRoot: sender, files: [details, empty] });
  assert.equal(bundle.bytes, (await fs.stat(bundle.bundlePath)).size);
  assert.equal(bundle.sha256, sha256(await fs.readFile(bundle.bundlePath)));
  const { files, directory } = await stageRelayFileBundle({
    workRoot: receiver, bundlePath: bundle.bundlePath, expected: bundle,
  });
  assert.deepEqual(files.map((file) => file.name), [details.name, empty.name]);
  assert.deepEqual(files.map((file) => path.basename(file.filePath)), ["0.data", "1.data"]);
  assert.deepEqual(files.map((file) => path.dirname(file.filePath)), [directory, directory]);
  assert.deepEqual(await fs.readFile(files[0].filePath), binary);
  assert.equal((await fs.stat(files[1].filePath)).size, 0);
});

test("同名标签不会覆盖另一项，本机路径仍独立", async (context) => {
  const { sender, receiver, writeSource } = await setup(context);
  const first = await writeSource("one.txt", "one");
  const second = await writeSource("two.txt", "two");
  const bundle = await writeRelayFileBundle({
    workRoot: sender, files: [{ ...first, name: "same" }, { ...second, name: "same" }],
  });
  const { files } = await stageRelayFileBundle({ workRoot: receiver, bundlePath: bundle.bundlePath, expected: bundle });
  assert.notEqual(files[0].filePath, files[1].filePath);
  assert.deepEqual(await Promise.all(files.map((file) => fs.readFile(file.filePath, "utf8"))), ["one", "two"]);
});

test("预告长度不符、整包和内项损坏时均无受理目录", async (context) => {
  const { sender, receiver, writeSource } = await setup(context);
  const bundle = await writeRelayFileBundle({ workRoot: sender, files: [await writeSource("body.txt", "original")] });
  const inspect = (expected) => stageRelayFileBundle({ workRoot: receiver, bundlePath: bundle.bundlePath, expected });
  await assert.rejects(inspect({ ...bundle, bytes: bundle.bytes - 1 }), { code: "RELAY_BUNDLE_SIZE_MISMATCH" });
  await assert.rejects(inspect({ ...bundle, sha256: "0".repeat(64) }), { code: "RELAY_BUNDLE_HASH_MISMATCH" });
  const corrupted = await fs.readFile(bundle.bundlePath);
  corrupted[corrupted.indexOf(0x0a) + 1] ^= 1;
  await fs.writeFile(bundle.bundlePath, corrupted);
  await assert.rejects(inspect({ ...bundle, sha256: sha256(corrupted) }), { code: "RELAY_BUNDLE_ENTRY_HASH_MISMATCH" });
  assert.deepEqual(await fs.readdir(receiver), []);
});

test("索引边界独立于整包签收校验", async (context) => {
  const { sender, receiver, writeSource } = await setup(context);
  const original = await writeRelayFileBundle({ workRoot: sender, files: [await writeSource("data.bin", "12345")] });
  const bytes = await fs.readFile(original.bundlePath);
  bytes.writeUInt32BE(0xffffffff, bytes.length - 4);
  await fs.writeFile(original.bundlePath, bytes);
  await assert.rejects(stageRelayFileBundle({
    workRoot: receiver, bundlePath: original.bundlePath, expected: { bytes: bytes.length, sha256: sha256(bytes) },
  }), { code: "RELAY_BUNDLE_MANIFEST_INVALID" });
  assert.deepEqual(await fs.readdir(receiver), []);
});

test("非法标签、文件数量、体积和提前取消不留下封包", async (context) => {
  const { sender, writeSource } = await setup(context);
  const detail = await writeSource("capped.txt", Buffer.alloc(256));
  const pack = (files, limits, signal) => writeRelayFileBundle({ workRoot: sender, files, limits, signal });
  await assert.rejects(pack([{ ...detail, name: "../draft.md" }]), { code: "RELAY_BUNDLE_NAME_INVALID" });
  await assert.rejects(pack([{ ...detail, name: "C:\\local.txt" }]), { code: "RELAY_BUNDLE_NAME_INVALID" });
  await assert.rejects(pack([detail, detail], { maxFiles: 1 }), { code: "RELAY_BUNDLE_FILE_COUNT" });
  await assert.rejects(pack([detail], { maxBundleBytes: 256 }), { code: "RELAY_BUNDLE_TOO_LARGE" });
  await assert.rejects(pack([detail], { maxManifestBytes: 6 }), { code: "RELAY_BUNDLE_TOO_LARGE" });
  const stop = new Error("cancel before local work");
  await assert.rejects(pack([detail], {}, AbortSignal.abort(stop)), (error) => error === stop);
  assert.deepEqual(await fs.readdir(sender), []);
  assert.equal((await fs.stat(detail.filePath)).size, 256);
});
