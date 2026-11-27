import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { openRelayFileJournal } from "../src/file-bundle-journal.mjs";

const keyAt = (position) => position.toString(16).padStart(64, "0");

test("完成的旧记录移出待处理扫描，重开仍精确去重，收妥或删除未明均留原处", async (context) => {
  const temporary = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "napcat-bundle-journal-"));
  context.after(() => fs.rm(temporary, { recursive: true, force: true }));
  let journal = await openRelayFileJournal(temporary);
  const pending = [
    { direction: "out", state: "received", releaseState: "released", cleanupState: "deleting" },
    { direction: "out", state: "uploading", releaseState: null },
    { direction: "in", state: "acknowledging", releaseState: null },
    { direction: "in", state: "acknowledged", releaseState: "releasing" },
    { direction: "out", state: "received", releaseState: "released" },
  ];
  for (const [index, value] of pending.entries()) {
    await journal.advance(keyAt(index), null, value);
    assert.equal(await journal.archiveCompleted(keyAt(index), 0), false);
  }
  for (let index = pending.length; index < 24; index += 1) {
    const key = keyAt(index);
    const received = index % 2 === 0 ? { direction: "in", state: "acknowledged", releaseState: "released" }
      : { direction: "out", state: "received", releaseState: "released", cleanupState: "removed" };
    const row = await journal.advance(key, null, received);
    assert.equal(await journal.archiveCompleted(key, row.revision), true);
  }
  journal = await openRelayFileJournal(temporary);
  const seen = [];
  for await (const original of journal.scan({ limit: pending.length })) seen.push(original);
  assert.deepEqual(seen.sort((left, right) => left.key.localeCompare(right.key)).map((original) => original.value), pending);
  const record = await journal.read(keyAt(12));
  assert.equal(record.archived, true);
  assert.deepEqual(record.value, { direction: "in", state: "acknowledged", releaseState: "released" });
  assert.equal(await journal.advance(keyAt(12), null, pending[0]), null);
  assert.equal(await journal.advance(keyAt(12), record.revision, pending[0]), null);
  assert.equal(await journal.archiveCompleted(keyAt(12), record.revision), true);
});

test("进程在归档换名前后非正常退出，重开从唯一原账确认，无需重复收发", async (context) => {
  const temporary = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "napcat-bundle-archive-stop-"));
  context.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const key = keyAt(421);
  const moduleUrl = new URL("../src/file-bundle-journal.mjs", import.meta.url).href;
  const beforeExit = `const journal=await openRelayFileJournal(process.argv[1]);
    await journal.advance(process.argv[2],null,{direction:'in',state:'acknowledged',releaseState:'released'});
    process.exit(71);`;
  const archivedExit = `const journal=await openRelayFileJournal(process.argv[1]);
    if (!(await journal.archiveCompleted(process.argv[2],0))) process.exit(79);
    process.exit(72);`;
  const child = (code) => spawnSync(process.execPath, ["--input-type=module", "--eval",
    `import{openRelayFileJournal}from${JSON.stringify(moduleUrl)};${code}`, temporary, key], { encoding: "utf8", timeout: 5000 });
  const first = child(beforeExit);
  assert.equal(first.status, 71, first.stderr);
  let journal = await openRelayFileJournal(temporary);
  const exact = await journal.read(key);
  assert.equal(exact.revision, 0);
  assert.equal(exact.archived, undefined);
  const second = child(archivedExit);
  assert.equal(second.status, 72, second.stderr);
  journal = await openRelayFileJournal(temporary);
  assert.deepEqual(await journal.read(key), { ...exact, archived: true });
  assert.equal(await journal.advance(key, null, exact.value), null);
  const stillActive = [];
  for await (const item of journal.scan()) stillActive.push(item);
  assert.deepEqual(stillActive, []);
});
