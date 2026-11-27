import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import test from "node:test";
import { writeRelayFileBundle } from "../src/file-bundle-codec.mjs";
import { openRelayFileJournal } from "../src/file-bundle-journal.mjs";
import { createRelayFileOffer, createRelayFileTransfer } from "../src/file-bundle-transfer.mjs";

const epoch = 1_790_000_000_000;
const originRoute = { relayId: "route-main", generation: 3, groupId: "10001", selfQqId: "21001", peerQqId: "22001" };
const recipientRoute = { ...originRoute, selfQqId: originRoute.peerQqId, peerQqId: originRoute.selfQqId };

function observed(route, messageId) {
  return { groupId: route.groupId, relayId: route.relayId, generation: route.generation, senderQqId: route.selfQqId, messageId };
}

async function setup(context) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "napcat-relay-flight-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceWork = path.join(root, "source");
  const targetWork = path.join(root, "target");
  const sourceJournal = path.join(root, "source-journal");
  const targetJournal = path.join(root, "target-journal");
  const groupDir = path.join(root, "qq-shadow");
  for (const dir of [sourceWork, targetWork, sourceJournal, targetJournal, groupDir]) await fs.mkdir(dir);
  const counters = { announce: 0, upload: 0, download: 0, receipt: 0 };
  const group = { notices: new Map(), files: new Map(), receipts: new Map() };
  const gate = { allowed: true, room: "ready", beforeUpload: null, lostReceipt: false };
  const io = {
    async authorize() { return gate.allowed; },
    async announce(offer) {
      counters.announce += 1;
      const messageId = "notice-" + offer.transferId;
      group.notices.set(offer.transferId, { messageId, offer });
      return { status: "sent", messageId };
    },
    async findAnnouncement(offer) {
      const notice = group.notices.get(offer.transferId);
      return notice ? { status: "sent", messageId: notice.messageId } : { status: "unknown" };
    },
    async ensureSpace() { return { status: gate.room }; },
    async upload(offer, route, bundlePath) {
      counters.upload += 1;
      await gate.beforeUpload?.(offer);
      const file = { id: "qq-file-" + offer.transferId, name: offer.name, bytes: offer.bytes, uploaderId: route.selfQqId };
      await fs.copyFile(bundlePath, path.join(groupDir, offer.transferId + ".pack"));
      group.files.set(offer.transferId, file);
      return { status: "sent", file };
    },
    async findUpload(offer) {
      const file = group.files.get(offer.transferId);
      return file ? { status: "sent", file } : { status: "unknown" };
    },
    async download(offer, route, file, destination) {
      counters.download += 1;
      await fs.copyFile(path.join(groupDir, offer.transferId + ".pack"), destination);
    },
    async receipt(offer, route, file) {
      counters.receipt += 1;
      const messageId = "receipt-" + offer.transferId;
      group.receipts.set(offer.transferId, { messageId, file });
      return gate.lostReceipt ? { status: "unknown" } : { status: "sent", messageId };
    },
    async findReceipt(offer) {
      const value = group.receipts.get(offer.transferId);
      return value ? { status: "sent", messageId: value.messageId } : { status: "unknown" };
    },
  };
  const machine = async (direction, { ports = io, ledger } = {}) => createRelayFileTransfer({
    localMachine: direction === "source" ? "development" : "training",
    journal: ledger ?? await openRelayFileJournal(direction === "source" ? sourceJournal : targetJournal),
    workRoot: direction === "source" ? sourceWork : targetWork,
    io: ports, now: () => epoch,
  });
  const source = await machine("source");
  const target = await machine("target");
  async function prepare(contents = ["file-alpha", "file-beta"], engine = source) {
    const transferId = randomUUID();
    const files = await Promise.all(contents.map(async (content, index) => {
      const name = "附件 " + index + ".txt";
      const filePath = path.join(sourceWork, transferId + "-" + index + ".data");
      await fs.writeFile(filePath, content);
      return { name, filePath };
    }));
    const bundle = await writeRelayFileBundle({ workRoot: sourceWork, files });
    const offer = createRelayFileOffer({
      transferId, from: "development", to: "training", route: originRoute,
      bytes: bundle.bytes, sha256: bundle.sha256, createdAt: epoch, expiresAt: epoch + 60_000,
    });
    await engine.registerOutgoing({ offer, route: originRoute, bundlePath: bundle.bundlePath });
    return { transferId, bundle, offer };
  }
  const accept = (prepared, engine = target) => engine.acceptAnnouncement({
    offer: prepared.offer,
    route: recipientRoute,
    observed: observed(originRoute, group.notices.get(prepared.transferId).messageId),
  });
  const acceptAck = (prepared, engine = source) => {
    const { messageId, file } = group.receipts.get(prepared.transferId);
    return engine.acceptReceipt({ offer: prepared.offer, observed: observed(recipientRoute, messageId), nativeFile: file });
  };
  return { root, source, target, sourceWork, targetWork, sourceJournal, targetJournal, groupDir, counters, group, gate, io, machine, prepare, accept, acceptAck };
}

test("预告、文件、接收落盘和回执按同一编号：重复与乱序无重复上传", async (context) => {
  const sample = await setup(context);
  const { source, target, counters, group, prepare, accept, acceptAck } = sample;
  const payload = JSON.stringify({ recipients: ["codex/first", "antigravity/second"], body: "同一份正文" });
  const item = await prepare([payload, "另一个文件"]);
  assert.equal((await source.advanceOutgoing(item.transferId)).status, "announced");
  assert.equal((await source.advanceOutgoing(item.transferId)).status, "uploaded");
  assert.equal((await target.receiveBundle("development", item.transferId)).status, "not_found");
  assert.equal(counters.download, 0);
  await accept(item);
  await accept(item);
  assert.equal((await target.receiveBundle("development", item.transferId)).status, "received");
  const saved = await target.readIncoming("development", item.transferId);
  assert.equal(await fs.readFile(saved.staged.files[0].filePath, "utf8"), payload);
  assert.equal(group.receipts.size, 0);
  assert.equal((await target.confirmReceipt("development", item.transferId)).status, "acknowledged");
  assert.equal((await acceptAck(item)).status, "received");
  assert.equal((await acceptAck(item)).status, "received");
  assert.deepEqual(counters, { announce: 1, upload: 1, download: 1, receipt: 1 });
});

test("上传写出后原进程退出，重新打开账本只查原群文件", async (context) => {
  const sample = await setup(context);
  const item = await sample.prepare(["持久确认"]);
  assert.equal((await sample.source.advanceOutgoing(item.transferId)).status, "announced");
  const manifest = path.join(sample.root, "simulated-qq-upload.json");
  const childCode = [
    "import fs from 'node:fs/promises';",
    "import { openRelayFileJournal } from " + JSON.stringify(new URL("../src/file-bundle-journal.mjs", import.meta.url).href) + ";",
    "import { createRelayFileTransfer } from " + JSON.stringify(new URL("../src/file-bundle-transfer.mjs", import.meta.url).href) + ";",
    "const args = JSON.parse(process.argv[1]);",
    "const journal = await openRelayFileJournal(args.journal);",
    "const engine = await createRelayFileTransfer({localMachine:'development', journal, workRoot:args.workRoot, now:() => args.epoch, io:{",
    "authorize:async()=>true, ensureSpace:async()=>({status:'ready'}), upload:async(offer,route,source)=>{",
    "await fs.copyFile(source,args.package);",
    "await fs.writeFile(args.manifest,JSON.stringify({id:'upload-once',name:offer.name,bytes:offer.bytes,uploaderId:route.selfQqId}));",
    "process.exit(73); } }});",
    "await engine.advanceOutgoing(args.id);",
    "process.exit(74);",
  ].join("\n");
  const child = spawn(process.execPath, ["--input-type=module", "-e", childCode, JSON.stringify({
    manifest, id: item.transferId, journal: sample.sourceJournal, workRoot: sample.sourceWork, epoch,
    package: path.join(sample.groupDir, item.transferId + ".pack"),
  })], { windowsHide: true, stdio: "ignore" });
  assert.deepEqual(await once(child, "exit"), [73, null]);
  const reopened = await sample.machine("source");
  assert.equal((await reopened.readOutgoing(item.transferId)).state, "uploading");
  assert.equal((await reopened.advanceOutgoing(item.transferId)).status, "unknown");
  assert.equal(sample.counters.upload, 0);
  sample.group.files.set(item.transferId, JSON.parse(await fs.readFile(manifest, "utf8")));
  assert.equal((await reopened.advanceOutgoing(item.transferId)).status, "uploaded");
  assert.equal((await reopened.readOutgoing(item.transferId)).file.id, "upload-once");
  await sample.accept(item);
  assert.equal((await sample.target.receiveBundle("development", item.transferId)).status, "received");
  assert.equal(sample.counters.upload, 0);
});

test("账本拒写时不发收妥；已写但回报丢失时保原件并续用", async (context) => {
  const sample = await setup(context);
  const { source, machine, counters, targetJournal, prepare, accept } = sample;
  const durable = await openRelayFileJournal(targetJournal);
  for (const takeEffect of [false, true]) {
    const item = await prepare([String(takeEffect)]);
    await source.advanceOutgoing(item.transferId);
    await source.advanceOutgoing(item.transferId);
    const failing = {
      read: durable.read,
      advance: async (key, revision, state) => {
        if (state.state !== "received") return durable.advance(key, revision, state);
        if (takeEffect) await durable.advance(key, revision, state);
        throw new Error("lost disk write outcome");
      },
    };
    const target = await machine("target", { ledger: failing });
    await accept(item, target);
    const result = await target.receiveBundle("development", item.transferId);
    assert.equal(result.status, takeEffect ? "received" : "receipt_storage_unknown");
    const reopened = await machine("target");
    if (!takeEffect) {
      assert.equal((await reopened.confirmReceipt("development", item.transferId)).status, "waiting_file");
      assert.equal(counters.receipt, 0);
      assert.equal((await reopened.receiveBundle("development", item.transferId)).status, "received");
    }
    const prior = await reopened.readIncoming("development", item.transferId);
    assert.equal(await fs.readFile(prior.staged.files[0].filePath, "utf8"), String(takeEffect));
    assert.equal((await reopened.confirmReceipt("development", item.transferId)).status, "acknowledged");
  }
  assert.deepEqual(counters, { announce: 2, upload: 2, download: 3, receipt: 2 });
});

test("错误群代次和实际发件身份被拒；丢回执续查不发第二条", async (context) => {
  const sample = await setup(context);
  const { source, target, counters, prepare, group, gate } = sample;
  const item = await prepare();
  await source.advanceOutgoing(item.transferId);
  const messageId = group.notices.get(item.transferId).messageId;
  const original = observed(originRoute, messageId);
  for (const changed of [{ ...original, senderQqId: "1234" }, { ...original, generation: 5 }]) {
    await assert.rejects(target.acceptAnnouncement({ offer: item.offer, route: recipientRoute, observed: changed }), {
      code: "RELAY_FILE_SOURCE_MISMATCH",
    });
  }
  await sample.accept(item);
  await source.advanceOutgoing(item.transferId);
  const actual = group.files.get(item.transferId);
  group.files.set(item.transferId, { ...actual, uploaderId: "1234" });
  assert.equal((await target.receiveBundle("development", item.transferId)).status, "file_unverified");
  assert.equal(counters.download, 0);
  group.files.set(item.transferId, actual);
  await target.receiveBundle("development", item.transferId);
  gate.lostReceipt = true;
  assert.equal((await target.confirmReceipt("development", item.transferId)).status, "unknown");
  const reopened = await sample.machine("target");
  assert.equal((await reopened.confirmReceipt("development", item.transferId)).status, "acknowledged");
  assert.equal(counters.receipt, 1);
  assert.equal((await sample.acceptAck(item)).status, "received");
});

test("存档内容变动不能补发收妥；配额阻塞后沿原预告继续", async (context) => {
  const sample = await setup(context);
  const item = await sample.prepare();
  await sample.source.advanceOutgoing(item.transferId);
  sample.gate.room = "pending_capacity";
  assert.deepEqual(await sample.source.advanceOutgoing(item.transferId), {
    status: "not_sent", reason: "pending_capacity", state: "announced",
  });
  assert.equal(sample.counters.upload, 0);
  sample.gate.room = "ready";
  await sample.source.advanceOutgoing(item.transferId);
  await sample.accept(item);
  await sample.target.receiveBundle("development", item.transferId);
  const persisted = await sample.target.readIncoming("development", item.transferId);
  await fs.writeFile(persisted.staged.files[0].filePath, "something");
  const reopened = await sample.machine("target");
  assert.deepEqual(await reopened.confirmReceipt("development", item.transferId), {
    status: "not_sent", reason: "stored_evidence_invalid", state: "received",
  });
  assert.deepEqual(sample.counters, { announce: 1, upload: 1, download: 1, receipt: 0 });
});

test("群容量长期不足不消耗上传账本；重开腾位后原包只上传一次", async (context) => {
  const sample = await setup(context);
  const item = await sample.prepare(["原包"]);
  await sample.source.advanceOutgoing(item.transferId);
  sample.gate.room = "pending_capacity";
  for (let check = 0; check < 80; check += 1) {
    assert.deepEqual(await sample.source.advanceOutgoing(item.transferId), {
      status: "not_sent", reason: "pending_capacity", state: "announced",
    });
  }
  assert.equal(sample.counters.upload, 0);
  sample.gate.room = "ready";
  const reopened = await sample.machine("source");
  assert.equal((await reopened.advanceOutgoing(item.transferId)).status, "uploaded");
  assert.equal((await reopened.advanceOutgoing(item.transferId)).status, "uploaded");
  assert.equal(sample.counters.upload, 1);
  assert.equal(sample.counters.announce, 1);
});

test("不同包的同群文件写串行，等待文件时小帧仍可送或核原次", async (context) => {
  const sample = await setup(context);
  const first = await sample.prepare();
  const second = await sample.prepare();
  const textBoundary = await sample.prepare();
  await sample.source.advanceOutgoing(first.transferId);
  await sample.source.advanceOutgoing(second.transferId);
  let started;
  let release;
  const entered = new Promise((resolve) => { started = resolve; });
  const open = new Promise((resolve) => { release = resolve; });
  sample.gate.beforeUpload = async (offer) => {
    if (offer.transferId === first.transferId) {
      started();
      await open;
    }
  };
  const pendingFirst = sample.source.advanceOutgoing(first.transferId);
  await entered;
  const secondEngine = await sample.machine("source");
  const pendingSecond = secondEngine.advanceOutgoing(second.transferId);
  try {
    assert.equal((await secondEngine.advanceOutgoing(textBoundary.transferId)).status, "announced");
    assert.equal(sample.counters.announce, 3);
    assert.equal(sample.counters.upload, 1);
  } finally {
    release();
  }
  assert.equal((await pendingFirst).status, "uploaded");
  assert.equal((await pendingSecond).status, "uploaded");
  assert.equal(sample.counters.upload, 2);
});
