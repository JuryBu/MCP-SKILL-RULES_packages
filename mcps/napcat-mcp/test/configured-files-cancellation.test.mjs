import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createConfiguredFileAccess, CONFIGURED_OPERATION_MAX_MS } from "../src/configured-files.mjs";
import { NapCatNotifierError } from "../src/core.mjs";

const bytes = Buffer.from("cancel-safe original\n");
const target = { targetKey: "room", type: "group", id: "2000000001" };

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function until(predicate) {
  const deadline = performance.now() + 1500;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error("Owned test state did not settle");
    await delay(5);
  }
}

async function fixture(context, operationTimeoutMs = 40000) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "configured-cancellation-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const hooks = new Map();
  const original = {
    message_id: "501", message_seq: "601", message_type: "group", group_id: target.id,
    user_id: "1000000002", sender: { user_id: "1000000002" },
  };
  const summary = {
    messageId: "501", messageSeq: "601", attachments: [{
      type: "file", fileId: "original-501", fileName: "original.txt", fileBytes: bytes.length, busId: 102,
    }],
  };
  const checked = { target, login: { actualSelfId: "1000000001" } };
  const access = createConfiguredFileAccess({
    loadBinding: () => {
      calls.push("binding");
      return { expectedSelfId: "1000000001", controlPlane: { targets: { room: target } } };
    },
    checkConfiguredTarget: async () => {
      calls.push("identity");
      return hooks.has("identity") ? hooks.get("identity")() : checked;
    },
    callOneBot: async (action) => {
      calls.push(action);
      if (hooks.has(action)) return hooks.get(action)();
      if (action === "get_group_msg_history") return { messages: [original] };
      if (action === "get_msg") return original;
      if (action === "get_group_file_url") return { url: "https://files.example.invalid/original" };
      throw new Error(`Unexpected test action ${action}`);
    },
    summarizeMessage: () => summary,
    fetchImpl: async (url, options) => {
      calls.push("download");
      return hooks.has("download") ? hooks.get("download")(options) : new Response(bytes);
    },
    maximumFileBytes: 100,
    fileDownloadTimeoutMs: 600000,
    operationTimeoutMs,
    ErrorClass: NapCatNotifierError,
  });
  const recent = await access.readConfiguredRecent({ target_key: "room" });
  calls.length = 0;
  const input = {
    target_key: "room", message_id: "501", attachment_ref: recent.messages[0].attachments[0].attachment_ref,
    destination_dir: path.join(root, "output"),
  };
  return { access, calls, hooks, root, input, checked, original };
}

test("both new entrypoints cap their complete-operation timer at 40000ms instead of the legacy 600000ms", async (context) => {
  assert.equal(CONFIGURED_OPERATION_MAX_MS, 40000);
  const originalTimeout = globalThis.setTimeout;
  const requested = [];
  globalThis.setTimeout = (callback, milliseconds, ...args) => {
    requested.push(milliseconds);
    return originalTimeout(callback, milliseconds, ...args);
  };
  try {
    const setup = await fixture(context, 600000);
    await setup.access.downloadConfiguredFile(setup.input);
  } finally {
    globalThis.setTimeout = originalTimeout;
  }
  assert.deepEqual(requested.filter((milliseconds) => milliseconds >= 40000), [40000, 40000]);
  assert.equal(requested.includes(600000), false);
});

test("a pre-cancelled Core signal starts no identity, history or file work", async (context) => {
  const setup = await fixture(context);
  const caller = new AbortController();
  caller.abort();
  await assert.rejects(setup.access.readConfiguredRecent({ target_key: "room" }, { signal: caller.signal }),
    { code: "CONFIGURED_OPERATION_CANCELLED", outcomeUnknown: false });
  await assert.rejects(setup.access.downloadConfiguredFile(setup.input, { signal: caller.signal }),
    { code: "CONFIGURED_OPERATION_CANCELLED", outcomeUnknown: false });
  assert.deepEqual(setup.calls, []);
  assert.equal(fs.existsSync(setup.input.destination_dir), false);
});

test("Core cancellation while identity is delayed returns before it settles and never advances to file writes", async (context) => {
  const setup = await fixture(context);
  const prepared = deferred();
  const started = deferred();
  const caller = new AbortController();
  setup.hooks.set("identity", () => { started.resolve(); return prepared.promise; });
  const request = setup.access.downloadConfiguredFile(setup.input, { signal: caller.signal });
  await started.promise;
  caller.abort();
  await assert.rejects(request, { code: "CONFIGURED_OPERATION_CANCELLED", outcomeUnknown: false });
  assert.equal(fs.existsSync(setup.input.destination_dir), false);
  prepared.resolve(setup.checked);
  await delay(15);
  assert.deepEqual(setup.calls, ["binding", "identity"]);
  assert.equal(fs.existsSync(setup.input.destination_dir), false);
});

test("short total deadlines include delayed identity, original-message and URL preparation", async (context) => {
  for (const phase of ["identity", "get_msg", "get_group_file_url"]) {
    const setup = await fixture(context, 25);
    const pending = deferred();
    setup.hooks.set(phase, () => pending.promise);
    const began = performance.now();
    await assert.rejects(setup.access.downloadConfiguredFile(setup.input),
      { code: "CONFIGURED_OPERATION_TIMEOUT", outcomeUnknown: false });
    assert.ok(performance.now() - began < 1000);
    assert.equal(fs.existsSync(setup.input.destination_dir), false);
    pending.resolve(phase === "identity" ? setup.checked : phase === "get_msg" ? setup.original : { url: "https://files.example.invalid/original" });
    await delay(10);
    assert.equal(setup.calls.includes("download"), false);
    assert.equal(fs.existsSync(setup.input.destination_dir), false);
  }
  console.log("total deadline covers identity/get_msg/file_url; late preparation never starts file writes");
});

test("the read entrypoint deadline also covers history preparation", async (context) => {
  const setup = await fixture(context, 25);
  const pending = deferred();
  setup.hooks.set("get_group_msg_history", () => pending.promise);
  await assert.rejects(setup.access.readConfiguredRecent({ target_key: "room" }),
    { code: "CONFIGURED_OPERATION_TIMEOUT", outcomeUnknown: false });
  pending.resolve({ messages: [setup.original] });
  await delay(10);
  assert.equal(fs.existsSync(setup.input.destination_dir), false);
});

test("Core cancellation aborts an active download stream, closes its writer and removes the part before returning", async (context) => {
  const setup = await fixture(context);
  let cancelled = false;
  let downloadSignal;
  setup.hooks.set("download", ({ signal }) => {
    downloadSignal = signal;
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(bytes.subarray(0, 3)); },
      cancel() { cancelled = true; },
    }));
  });
  const caller = new AbortController();
  const request = setup.access.downloadConfiguredFile(setup.input, { signal: caller.signal });
  await until(() => fs.existsSync(setup.input.destination_dir)
    && fs.readdirSync(setup.input.destination_dir).some((name) => fs.statSync(path.join(setup.input.destination_dir, name)).size > 0));
  caller.abort();
  await assert.rejects(request, { code: "CONFIGURED_OPERATION_CANCELLED", outcomeUnknown: false });
  assert.equal(downloadSignal.aborted, true);
  assert.equal(cancelled, true);
  assert.deepEqual(fs.readdirSync(setup.input.destination_dir), []);
  await delay(15);
  assert.deepEqual(fs.readdirSync(setup.input.destination_dir), []);
});

test("abort after stream close but before publication prevents the link call entirely", async (context) => {
  const setup = await fixture(context);
  const caller = new AbortController();
  const originalStream = fs.createWriteStream;
  const originalLink = fs.promises.link;
  let links = 0;
  fs.createWriteStream = (...args) => {
    const output = originalStream(...args);
    output.once("close", () => caller.abort());
    return output;
  };
  fs.promises.link = (...args) => { links += 1; return originalLink(...args); };
  try {
    await assert.rejects(setup.access.downloadConfiguredFile(setup.input, { signal: caller.signal }),
      { code: "CONFIGURED_OPERATION_CANCELLED", outcomeUnknown: false });
  } finally {
    fs.createWriteStream = originalStream;
    fs.promises.link = originalLink;
  }
  assert.equal(links, 0);
  assert.deepEqual(fs.readdirSync(setup.input.destination_dir), []);
});

test("Core cancellation during a started publication reports unknown with the exact operation; late success cleans only the part", async (context) => {
  const setup = await fixture(context);
  const caller = new AbortController();
  const started = deferred();
  const release = deferred();
  const originalLink = fs.promises.link;
  fs.promises.link = async (...args) => { started.resolve(); await release.promise; return originalLink(...args); };
  let error;
  try {
    const request = setup.access.downloadConfiguredFile(setup.input, { signal: caller.signal });
    await started.promise;
    caller.abort();
    await assert.rejects(request, (failure) => { error = failure; return failure.code === "FILE_PUBLICATION_UNKNOWN"; });
    assert.equal(error.outcomeUnknown, true);
    assert.equal(error.details.published, null);
    assert.equal(error.details.publicationState, "pending");
    assert.equal(error.details.cleanupPending, true);
    assert.equal(error.details.operationResult.sourceMessageId, "501");
    assert.equal(error.details.operationResult.attachment_ref, setup.input.attachment_ref);
    assert.equal(error.details.operationResult.fileName, "original.txt");
    assert.equal(error.details.operationResult.fileBytes, bytes.length);
    assert.equal(error.details.operationResult.sha256, createHash("sha256").update(bytes).digest("hex"));
    assert.equal(error.details.operationResult.resolvedBusId, 102);
    release.resolve();
    await until(() => !fs.existsSync(error.details.temporaryPath));
  } finally {
    release.resolve();
    fs.promises.link = originalLink;
  }
  assert.deepEqual(fs.readFileSync(error.details.operationResult.filePath), bytes);
  assert.deepEqual(fs.readdirSync(setup.input.destination_dir), ["original.txt"]);
  console.log("cancelled started publication: outcomeUnknown=true published=null; late success retains final file and cleans part");
});

test("internal deadline during a started publication stays unknown until late failure and preserves an existing file", async (context) => {
  const setup = await fixture(context, 40);
  const release = deferred();
  const originalLink = fs.promises.link;
  fs.promises.link = async (...args) => { await release.promise; return originalLink(...args); };
  fs.mkdirSync(setup.input.destination_dir);
  const destination = path.join(setup.input.destination_dir, "original.txt");
  fs.writeFileSync(destination, "existing", "utf8");
  let error;
  try {
    await assert.rejects(setup.access.downloadConfiguredFile(setup.input), (failure) => { error = failure; return failure.code === "FILE_PUBLICATION_UNKNOWN"; });
    assert.equal(error.outcomeUnknown, true);
    assert.equal(error.details.publicationState, "pending");
    release.resolve();
    await until(() => !fs.existsSync(error.details.temporaryPath));
  } finally {
    release.resolve();
    fs.promises.link = originalLink;
  }
  assert.equal(fs.readFileSync(destination, "utf8"), "existing");
  assert.deepEqual(fs.readdirSync(setup.input.destination_dir), ["original.txt"]);
  console.log("deadline during started publication: outcomeUnknown=true; late EEXIST keeps existing bytes and cleans part");
});
