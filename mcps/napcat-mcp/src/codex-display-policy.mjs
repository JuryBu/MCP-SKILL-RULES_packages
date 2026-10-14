import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const DISPLAY_POLICY_API_VERSION = 1;
export function createCodexDisplayPolicyControl(manager, options = {}) {
  const instanceId = options.instanceId;
  const candidateRoot = options.candidateRoot ? fs.realpathSync(options.candidateRoot) : null;
  if (candidateRoot && !fs.statSync(candidateRoot).isDirectory()) throw new Error("INVALID_DISPLAY_POLICY_ROOT");
  const rootId = candidateRoot ? crypto.createHash("sha256").update(candidateRoot).digest("hex") : null;
  let busy = false;
  let pending = null;
  const activated = new Map();
  const importedHashes = new Set();
  const status = () => ({ enabled: Boolean(candidateRoot), instanceId, rootId, busy,
    preparationId: pending?.receipt.preparationId ?? null, ...manager.status() });
  const fail = (code, httpStatus = 409) => ({ ok: false, httpStatus, error: { code, message: code }, ...status() });
  function validate(input) {
    if (!candidateRoot) return fail("DISPLAY_POLICY_CONTROL_DISABLED", 403);
    if (!input || input.instanceId !== instanceId) return fail("DISPLAY_POLICY_INSTANCE_MISMATCH");
    if (input.rootId !== rootId) return fail("DISPLAY_POLICY_ROOT_MISMATCH");
    return null;
  }
  function readCandidate(input) {
    if (typeof input.candidate !== "string" || input.candidate.length > 512
      || !/^(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_.-]+\.mjs$/.test(input.candidate)
      || input.candidate.split("/").some(segment => segment === "." || segment === "..")
      || !/^[a-f0-9]{64}$/.test(input.sha256 ?? "")) throw new Error("INVALID_DISPLAY_POLICY_CANDIDATE");
    const resolved = fs.realpathSync(path.join(candidateRoot, input.candidate));
    const relative = path.relative(candidateRoot, resolved);
    if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
      throw new Error("DISPLAY_POLICY_PATH_OUTSIDE_ROOT");
    }
    const descriptor = fs.openSync(resolved, "r");
    try {
      const metadata = fs.fstatSync(descriptor);
      if (!metadata.isFile() || metadata.size > 262144) throw new Error("INVALID_DISPLAY_POLICY_FILE");
      const source = fs.readFileSync(descriptor);
      if (crypto.createHash("sha256").update(source).digest("hex") !== input.sha256) {
        throw new Error("DISPLAY_POLICY_SHA_MISMATCH");
      }
      return { source, resolved };
    } finally { fs.closeSync(descriptor); }
  }
  return {
    status,
    observeRpc(stage, id, method) {
      if (!candidateRoot) return;
      try { options.onEvent?.({ type: "display_policy_rpc_observed", stage, id, method }); } catch {}
    },
    async prepare(input) {
      const invalid = validate(input);
      if (invalid) return invalid;
      if (busy) return fail("DISPLAY_POLICY_PREPARE_BUSY");
      if (pending) return fail("DISPLAY_POLICY_PREPARATION_PENDING");
      if (input.expectedRevision !== manager.status().revision) return fail("DISPLAY_POLICY_REVISION_MISMATCH");
      busy = true;
      const finished = outcome => ({ ...outcome, busy: false });
      try {
        const { source, resolved } = readCandidate(input);
        if (!importedHashes.has(input.sha256) && importedHashes.size >= 32) return finished(fail("DISPLAY_POLICY_IMPORT_LIMIT", 429));
        importedHashes.add(input.sha256);
        const token = await manager.prepare(resolved, source);
        if (!token.prepared) return finished(fail(token.error, 422));
        if (input.expectedRevision !== manager.status().revision) return finished(fail("DISPLAY_POLICY_REVISION_MISMATCH"));
        const receipt = Object.freeze({ instanceId, rootId, candidate: input.candidate, sha256: input.sha256,
          preparationId: token.id, expectedRevision: input.expectedRevision, version: token.version });
        pending = { receipt, token, resolved };
        return finished({ ok: true, prepared: true, receipt, ...status() });
      } catch (error) { return finished(fail(String(error.message ?? error), 422)); }
      finally { busy = false; }
    },
    activate(input) {
      const invalid = validate(input);
      if (invalid) return invalid;
      if (busy) return fail("DISPLAY_POLICY_PREPARE_BUSY");
      const priorActivation = activated.get(input.preparationId);
      const matches = receipt => Object.keys(receipt).every(key => input[key] === receipt[key]);
      if (priorActivation) return matches(priorActivation)
        ? { ok: true, activated: false, alreadyActivated: true, ...status() }
        : fail("INVALID_OR_STALE_PREPARATION");
      if (!pending || !matches(pending.receipt)) return fail("INVALID_OR_STALE_PREPARATION");
      if (input.expectedRevision !== manager.status().revision) return fail("DISPLAY_POLICY_REVISION_MISMATCH");
      try {
        if (readCandidate(input).resolved !== pending.resolved) throw new Error("DISPLAY_POLICY_PATH_CHANGED");
        const outcome = manager.activate(pending.token);
        if (!outcome.activated) return fail(outcome.error);
        activated.set(input.preparationId, pending.receipt);
        while (activated.size > 32) activated.delete(activated.keys().next().value);
        pending = null;
        return { ok: true, ...outcome, ...status() };
      } catch (error) { return fail(String(error.message ?? error), 422); }
    },
    restore(input) {
      const invalid = validate(input);
      if (invalid) return invalid;
      if (busy) return fail("DISPLAY_POLICY_PREPARE_BUSY");
      if (input.expectedRevision !== manager.status().revision) return fail("DISPLAY_POLICY_REVISION_MISMATCH");
      const outcome = manager.restore();
      if (!outcome.restored) return fail(outcome.error);
      pending = null;
      return { ok: true, ...outcome, ...status() };
    },
    discard(input) {
      const invalid = validate(input);
      if (invalid) return invalid;
      if (busy) return fail("DISPLAY_POLICY_PREPARE_BUSY");
      if (!pending || input.preparationId !== pending.receipt.preparationId) return fail("INVALID_OR_STALE_PREPARATION");
      pending = null;
      return { ok: true, discarded: true, ...status() };
    },
  };
}
const BASE_POLICY = Object.freeze({
  apiVersion: DISPLAY_POLICY_API_VERSION,
  version: "original",
  decideReminder: () => ({ visibility: "inherit" }),
});
const HISTORY_METHODS = new Set(["thread/read", "thread/resume", "thread/turns/list", "thread/items/list"]);

function itemKey(threadId, turnId, itemId) {
  return JSON.stringify([threadId, turnId, itemId]);
}

function reminderText(item) {
  if (item?.type !== "userMessage" || typeof item.id !== "string" || item.content?.length !== 1) return null;
  const content = item.content[0];
  return content?.type === "text" && typeof content.text === "string"
    && !(content.text_elements?.length) ? content.text : null;
}

function validateDecision(value) {
  if (typeof value?.then === "function") {
    Promise.resolve(value).catch(() => {});
    throw new Error("ASYNCHRONOUS_DISPLAY_DECISION");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some(key => !["visibility", "text"].includes(key))
    || !["inherit", "hidden", "visible"].includes(value.visibility)
    || (Object.hasOwn(value, "text") && (typeof value.text !== "string" || Buffer.byteLength(value.text) > 400000))) {
    throw new Error("INVALID_DISPLAY_DECISION");
  }
  return Object.freeze({ visibility: value.visibility, ...(Object.hasOwn(value, "text") ? { text: value.text } : {}) });
}

function visitItems(message, request, visitor) {
  const items = value => Array.isArray(value) ? value : [];
  const params = message?.params;
  if (["item/started", "item/completed"].includes(message?.method) && !Object.hasOwn(message, "id")) {
    visitor(params?.threadId, params?.turnId, params?.item);
  } else if (["turn/started", "turn/completed"].includes(message?.method) && !Object.hasOwn(message, "id")) {
    for (const item of items(params?.turn?.items)) visitor(params?.threadId, params.turn.id, item);
  } else if (request && !message?.error) {
    if (request.method === "thread/items/list") {
      for (const entry of items(message.result?.data)) visitor(request.threadId, entry?.turnId, entry?.item);
    } else {
      const thread = message.result?.thread;
      const threadId = thread?.id ?? request.threadId;
      const turns = request.method === "thread/turns/list" ? message.result?.data : thread?.turns;
      for (const turn of items(turns)) for (const item of items(turn?.items)) visitor(threadId, turn.id, item);
    }
  }
}

export function createCodexDisplayPolicyManager(options = {}) {
  const maximumTurns = options.maximumTurns ?? 256;
  const maximumRequests = options.maximumRequests ?? 1000;
  const maximumReminders = options.maximumReminders ?? 2048;
  const onEvent = options.onEvent ?? (() => {});
  const base = { policy: BASE_POLICY, previous: null, failed: false };
  let active = base;
  let preparation = null;
  let preparing = false;
  let revision = 0;
  let processing = null;
  const registrations = new Map();
  const decisions = new Map();
  let failures = 0;
  let boundReminders = 0;

  function remember(entries, key, value, maximum) {
    entries.set(key, value);
    while (entries.size > maximum) entries.delete(entries.keys().next().value);
  }

  function evaluate(entry, input) {
    while (entry.failed && entry.previous) entry = entry.previous;
    try {
      return { version: entry.policy.version, decision: validateDecision(entry.policy.decideReminder(Object.freeze(input))) };
    } catch (error) {
      if (!entry.previous) throw error;
      entry.failed = true;
      failures += 1;
      if (active === entry) { active = entry.previous; revision += 1; }
      onEvent({ type: "display_policy_fallback", version: entry.policy.version, error: String(error.message ?? error) });
      return evaluate(entry.previous, input);
    }
  }

  return {
    async prepare(modulePath, verifiedSource = null) {
      if (preparing) return { prepared: false, version: active.policy.version, error: "DISPLAY_POLICY_PREPARE_BUSY" };
      preparing = true;
      const prior = active;
      try {
        const source = verifiedSource ?? fs.readFileSync(modulePath);
        const sha256 = crypto.createHash("sha256").update(source).digest("hex");
        const url = pathToFileURL(modulePath);
        url.searchParams.set("displayPolicySha256", sha256);
        const imported = await import(verifiedSource
          ? `data:text/javascript;base64,${source.toString("base64")}#${sha256}` : url.href);
        if (!verifiedSource && crypto.createHash("sha256").update(fs.readFileSync(modulePath)).digest("hex") !== sha256) {
          throw new Error("DISPLAY_POLICY_SOURCE_CHANGED");
        }
        const candidate = imported.default ?? imported.displayPolicy;
        if (candidate?.apiVersion !== DISPLAY_POLICY_API_VERSION || typeof candidate.version !== "string"
          || !/^[a-zA-Z0-9._-]{1,128}$/.test(candidate.version) || candidate.version === "original"
          || typeof candidate.decideReminder !== "function") throw new Error("INCOMPATIBLE_DISPLAY_POLICY");
        const policy = Object.freeze({ apiVersion: candidate.apiVersion, version: candidate.version, decideReminder: candidate.decideReminder });
        for (const messageVisibility of ["hidden", "visible"]) {
          validateDecision(policy.decideReminder(Object.freeze({
            wakeId: "display-policy-probe", messageVisibility, text: "display-policy-probe",
            threadId: "probe-thread", turnId: "probe-turn", itemId: "probe-item",
          })));
        }
        if (active !== prior) throw new Error("DISPLAY_POLICY_CHANGED_DURING_PREPARE");
        const token = Object.freeze({ prepared: true, version: policy.version, sha256, id: crypto.randomUUID() });
        preparation = { token, prior, entry: { policy, previous: prior, failed: false } };
        return token;
      } catch (error) {
        return { prepared: false, version: active.policy.version, error: String(error.message ?? error) };
      } finally {
        preparing = false;
      }
    },
    activate(token) {
      if (preparation?.token !== token || preparation.prior !== active) {
        return { activated: false, version: active.policy.version, error: "INVALID_OR_STALE_PREPARATION" };
      }
      active = preparation.entry;
      preparation = null;
      revision += 1;
      onEvent({ type: "display_policy_activated", version: active.policy.version });
      return { activated: true, version: active.policy.version };
    },
    restore() {
      if (preparing) return { restored: false, error: "DISPLAY_POLICY_PREPARE_BUSY" };
      if (!active.previous) return { restored: false, error: "NO_PREVIOUS_DISPLAY_POLICY" };
      active = active.previous;
      while (active.failed && active.previous) active = active.previous;
      preparation = null;
      revision += 1;
      onEvent({ type: "display_policy_restored", version: active.policy.version });
      return { restored: true, version: active.policy.version };
    },
    registerReminder(registration, saved = {}) {
      if (!registration) return;
      remember(registrations, registration.key, registration, maximumReminders);
      if (registration.itemKey && saved.displayDecision) {
        try {
          remember(decisions, registration.itemKey, {
            version: saved.displayPolicyVersion ?? "original", decision: validateDecision(saved.displayDecision),
          }, maximumReminders);
        } catch {
        }
      }
    },
    forgetReminder(registration) {
      if (registrations.get(registration?.key) === registration) registrations.delete(registration.key);
    },
    prepareReminderBinding(registration) {
      const known = decisions.get(registration.itemKey);
      if (known) return known;
      const item = processing?.items.get(registration.itemKey);
      if (!item) return { version: "original", decision: { visibility: "inherit" } };
      const [threadId, turnId] = JSON.parse(registration.itemKey);
      return evaluate(processing.view.policyForTurn(threadId, turnId, processing.entry), {
        wakeId: registration.wakeId, messageVisibility: registration.hidden ? "hidden" : "visible",
        text: reminderText(item), threadId, turnId, itemId: item.id,
      });
    },
    commitReminderBinding(registration, binding) {
      remember(decisions, registration.itemKey, binding, maximumReminders);
      boundReminders += 1;
      onEvent({ type: "display_reminder_bound", version: binding.version, wakeId: registration.wakeId, itemKey: registration.itemKey });
    },
    createView() {
      const requests = new Map();
      const turns = new Map();
      let context = null;
      const view = {
        policyForTurn(threadId, turnId, fallback = active) {
          const key = itemKey(threadId, turnId, "");
          if (!turns.has(key)) remember(turns, key, fallback, maximumTurns);
          return turns.get(key);
        },
        observeRequest(message) {
          if (typeof message?.method !== "string" || !Object.hasOwn(message, "id")) return;
          if (!HISTORY_METHODS.has(message.method) && !["turn/start", "turn/steer", "turn/interrupt"].includes(message.method)) return;
          const threadId = message.params?.threadId;
          const target = message.params?.turnId ?? message.params?.expectedTurnId;
          const entry = target ? view.policyForTurn(threadId, target) : active;
          remember(requests, message.id, { method: message.method, threadId, entry }, maximumRequests);
        },
        observeUpstream(message) {
          const request = message && !Object.hasOwn(message, "method") ? requests.get(message.id) : null;
          if (request) requests.delete(message.id);
          const params = message?.params;
          const threadId = params?.threadId ?? request?.threadId;
          const turnId = params?.turnId ?? params?.turn?.id ?? (request?.method === "turn/start" ? message.result?.turn?.id : null);
          const knownTurn = turns.get(itemKey(threadId, turnId, ""));
          const pendingStart = [...requests.values()].find(value => value.method === "turn/start"
            && value.threadId === threadId && !value.observedTurnId);
          const selected = request?.entry ?? pendingStart?.entry ?? active;
          const entry = threadId && turnId ? view.policyForTurn(threadId, turnId, selected) : selected;
          if (!knownTurn && threadId && turnId && pendingStart && !request) pendingStart.observedTurnId = turnId;
          context = { view, request, entry, items: new Map() };
          visitItems(message, request, (itemThreadId, itemTurnId, item) => {
            if (reminderText(item) !== null) context.items.set(itemKey(itemThreadId, itemTurnId, item.id), item);
          });
          processing = context;
        },
        project(message, stableMessage, suppressed) {
          if (!message) return suppressed ? null : stableMessage;
          function projectItem(threadId, turnId, original, stable) {
            const key = itemKey(threadId, turnId, original?.id);
            const text = reminderText(original);
            if (text === null) return stable;
            const hash = crypto.createHash("sha256").update(text, "utf8").digest("hex");
            const registration = registrations.get(JSON.stringify([threadId, hash]));
            if (!registration || registration.ambiguous || registration.itemKey !== key
              || (original.clientId != null && original.clientId !== registration.visibilityClientId)) return stable;
            const binding = decisions.get(key) ?? { version: "original", decision: { visibility: "inherit" } };
            const decision = binding.decision;
            if (decision.visibility === "hidden" || (decision.visibility === "inherit" && !stable)) return null;
            const item = stable ?? original;
            return Object.hasOwn(decision, "text") && decision.text !== text
              ? { ...item, content: [{ ...item.content[0], text: decision.text }] } : item;
          }
          function projectTurn(threadId, original, stable) {
            if (!Array.isArray(original?.items) || (original.itemsView && original.itemsView !== "full")) return stable;
            const stableItems = new Map((stable?.items ?? []).map(item => [item.id, item]));
            const items = original.items.map(item => projectItem(threadId, original.id, item, stableItems.get(item.id))).filter(Boolean);
            return items.length === stable?.items?.length && items.every((item, index) => item === stable.items[index])
              ? stable : { ...stable, items };
          }
          let result = suppressed ? null : stableMessage;
          if (["item/started", "item/completed"].includes(message.method) && !Object.hasOwn(message, "id")) {
            const item = projectItem(message.params?.threadId, message.params?.turnId, message.params?.item, suppressed ? null : stableMessage?.params?.item);
            result = item ? (item === message.params.item ? message : { ...message, params: { ...message.params, item } }) : null;
          } else if (["turn/started", "turn/completed"].includes(message.method) && !Object.hasOwn(message, "id")) {
            const turn = projectTurn(message.params?.threadId, message.params?.turn, stableMessage?.params?.turn);
            result = turn === stableMessage?.params?.turn ? stableMessage : { ...message, params: { ...message.params, turn } };
          } else if (context?.request && !message.error) {
            const request = context.request;
            if (request.method === "thread/items/list" && Array.isArray(message.result?.data)) {
              const stableItems = new Map((stableMessage.result.data ?? []).map(entry => [itemKey(request.threadId, entry.turnId, entry.item?.id), entry]));
              const data = message.result.data.flatMap(entry => {
                const stable = stableItems.get(itemKey(request.threadId, entry.turnId, entry.item?.id));
                const item = projectItem(request.threadId, entry.turnId, entry.item, stable?.item);
                return item ? [item === stable?.item ? stable : { ...entry, item }] : [];
              });
              if (data.length !== stableMessage.result.data.length || data.some((entry, index) => entry !== stableMessage.result.data[index])) result = { ...message, result: { ...message.result, data } };
            } else if (request.method === "thread/turns/list" && Array.isArray(message.result?.data)) {
              const data = message.result.data.map((turn, index) => projectTurn(request.threadId, turn, stableMessage.result.data[index]));
              if (data.some((turn, index) => turn !== stableMessage.result.data[index])) result = { ...message, result: { ...message.result, data } };
            } else if (message.result?.thread?.id === request.threadId && Array.isArray(message.result.thread.turns)) {
              const thread = message.result.thread;
              const mapped = thread.turns.map((turn, index) => projectTurn(thread.id, turn, stableMessage.result.thread.turns[index]));
              if (mapped.some((turn, index) => turn !== stableMessage.result.thread.turns[index])) result = { ...message, result: { ...message.result, thread: { ...thread, turns: mapped } } };
            }
          }
          if (processing === context) processing = null;
          context = null;
          return result;
        },
        close() { requests.clear(); turns.clear(); context = null; },
        snapshot() { return { requests: requests.size, retainedTurns: turns.size }; },
      };
      return view;
    },
    status() {
      return { apiVersion: DISPLAY_POLICY_API_VERSION, version: active.policy.version, revision, failures, boundReminders, retainedDecisions: decisions.size };
    },
  };
}
