import { isDeepStrictEqual } from "node:util";
import { CoreError, digest } from "./contracts.mjs";
import { normalizeOwnerWindowBinding } from "./owner-window-ingress.mjs";

const WINDOW_FIELDS = ["window_key", "channel", "component", "window_type", "window_id", "channel_binding_id",
  "target_key", "route_key", "conversation_id"];
const GAP_CODES = new Set(["OWNER_WINDOW_CURSOR_EXPIRED", "OWNER_WINDOW_HISTORY_EXPIRED"]);
const STATUSES = new Set(["idle", "pending", "ready", "blocked", "gap", "closed"]);

function copy(value) { return JSON.parse(JSON.stringify(value)); }
function integer(value, minimum = 0) { return Number.isSafeInteger(value) && value >= minimum; }
function object(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function identifier(value, maximum = 256) {
  return typeof value === "string" && value.length > 0 && value.trim() === value && value !== "*"
    && !/[\u0000-\u001f\u007f]/.test(value) && Buffer.byteLength(value, "utf8") <= maximum;
}
function freeze(value) {
  if (value && typeof value === "object") {
    for (const nested of Object.values(value)) freeze(nested);
    Object.freeze(value);
  }
  return value;
}
function invalid(code = "window_ingress_invalid") { return new CoreError(code, "窗口消费记录或提供方结果校验失败"); }
function errorCode(error) {
  const code = error?.details?.provider_code ?? error?.code;
  return typeof code === "string" && /^[A-Za-z][A-Za-z0-9_]{0,95}$/.test(code) ? code : "window_ingress_unconfirmed";
}
function synchronous(callback, ...args) {
  const result = callback(...args);
  if (result && typeof result.then === "function") throw invalid("window_ingress_store_async");
  return result;
}

export class WindowIngressController {
  #windows = new Map();
  #getBinding;
  #getState;
  #putState;
  #onEvent;
  #onError;
  #now;
  #pollIntervalMs;
  #retryDelayMs;
  #requestTimeoutMs;
  #shutdown = new AbortController();
  #tails = new Map();
  #polls = new Map();
  #closing = null;

  constructor({ getBinding, getState, putState, onEvent, windows = [], now = Date.now, onError = () => {},
    pollIntervalMs = 30000, retryDelayMs = 5000, requestTimeoutMs = 10000 } = {}) {
    if ([getBinding, getState, putState, onEvent, now, onError].some(callback => typeof callback !== "function")
      || !Array.isArray(windows) || windows.length > 1000
      || ![pollIntervalMs, retryDelayMs, requestTimeoutMs].every(value => integer(value, 1) && value <= 60000)) throw invalid();
    this.#getBinding = getBinding;
    this.#getState = getState;
    this.#putState = putState;
    this.#onEvent = onEvent;
    this.#onError = onError;
    this.#now = now;
    this.#pollIntervalMs = pollIntervalMs;
    this.#retryDelayMs = retryDelayMs;
    this.#requestTimeoutMs = requestTimeoutMs;
    const routes = new Set();
    for (const source of windows) {
      if (!object(source) || WINDOW_FIELDS.some(field => !identifier(source[field])) || source.channel !== "qq"
        || !["private", "group"].includes(source.window_type) || !/^[1-9]\d{0,19}$/.test(source.window_id)
        || ["registerOwnerWindowRoute", "getOwnerWindowRoute", "closeOwnerWindowRoute", "readOwnerWindowEvents"]
          .some(method => typeof source.transport?.[method] !== "function")) throw invalid();
      const window = Object.freeze({ ...Object.fromEntries(WINDOW_FIELDS.map(field => [field, source[field]])), transport: source.transport });
      const routeScope = JSON.stringify([window.component, window.route_key]);
      if (this.#windows.has(window.window_key) || routes.has(routeScope)) throw invalid();
      routes.add(routeScope);
      this.#windows.set(window.window_key, window);
    }
  }

  #time() {
    const now = this.#now();
    if (!integer(now)) throw invalid("window_ingress_clock_invalid");
    return now;
  }

  #scope(window) { return digest(WINDOW_FIELDS.map(field => window[field])); }

  #load(window) {
    const saved = synchronous(this.#getState, window.window_key);
    if (saved === null || saved === undefined) return {
      schema_version: 1, window_key: window.window_key, scope: this.#scope(window), status: "idle",
      provider_generation: 0, cursor: null, cursor_generation: null, confirmed_mapping_generation: 0,
      pending_registration: null, pending_close: null, gap: null, last_error: null, next_poll_at: 0,
      blocked_retry_count: 0, last_blocked_retry_at: null,
    };
    const state = copy(saved);
    if (!object(state)) throw invalid("window_ingress_state_invalid");
    if (state.blocked_retry_count === undefined) state.blocked_retry_count = 0;
    if (state.last_blocked_retry_at === undefined) state.last_blocked_retry_at = null;
    if (!object(state) || state.schema_version !== 1 || state.scope !== this.#scope(window)
      || (state.window_key !== undefined && state.window_key !== window.window_key) || !STATUSES.has(state.status)
      || !integer(state.provider_generation) || !integer(state.confirmed_mapping_generation) || !integer(state.next_poll_at)
      || !integer(state.blocked_retry_count) || !(state.last_blocked_retry_at === null || integer(state.last_blocked_retry_at))
      || !(state.cursor === null || (identifier(state.cursor, 4096) && /^[A-Za-z0-9_-]+$/.test(state.cursor)))
      || !(state.cursor_generation === null || integer(state.cursor_generation, 1))
      || (state.cursor !== null && state.cursor_generation === null)
      || Buffer.byteLength(JSON.stringify(state), "utf8") > 16384) throw invalid("window_ingress_state_invalid");
    for (const [field, registration] of [["pending_registration", true], ["pending_close", false]]) {
      const pending = state[field];
      if (pending === null) continue;
      if (!object(pending) || !integer(pending.expected_generation, registration ? 0 : 1)
        || typeof pending.request_started !== "boolean" || !["prepared", "unknown", "blocked"].includes(pending.phase)) throw invalid("window_ingress_state_invalid");
      if (registration) {
        if (!identifier(pending.dedupe_key, 200)) throw invalid("window_ingress_state_invalid");
        pending.window_binding = normalizeOwnerWindowBinding(pending.window_binding);
      }
    }
    if (state.pending_registration && state.pending_close) throw invalid("window_ingress_state_invalid");
    state.window_key = window.window_key;
    return state;
  }

  #save(window, state) {
    if (Buffer.byteLength(JSON.stringify(state), "utf8") > 16384) throw invalid("window_ingress_state_invalid");
    try { synchronous(this.#putState, window.window_key, copy(state)); } catch {
      throw invalid("window_ingress_persistence_failed");
    }
    return copy(state);
  }

  #desired(window) {
    const binding = synchronous(this.#getBinding, window.window_key);
    if (binding === null || binding === undefined) return null;
    if (!object(binding) || ["window_key", "channel", "component", "window_type", "window_id", "channel_binding_id"]
      .some(field => binding[field] !== window[field]) || !integer(binding.generation, 1)) throw invalid("window_ingress_binding_invalid");
    if (binding.deleted === true) return null;
    return normalizeOwnerWindowBinding({ generation: binding.generation, owner_key: binding.owner_key, target: binding.target });
  }

  #report(error, window, stage) {
    try {
      const result = this.#onError(new CoreError(errorCode(error), "窗口消费暂未完成"), { window_key: window.window_key, stage });
      if (result && typeof result.then === "function") void Promise.resolve(result).catch(() => {});
    } catch {}
  }

  #failure(window, state, error, stage, status = "pending") {
    this.#report(error, window, stage);
    state.status = status;
    state.last_error = errorCode(error);
    state.next_poll_at = this.#time() + this.#retryDelayMs;
    return this.#save(window, state);
  }

  async #request(window, method, parameters, onRequestStarted) {
    if (this.#shutdown.signal.aborted) throw invalid("window_ingress_cancelled");
    const deadline = new AbortController();
    const signal = AbortSignal.any([deadline.signal, this.#shutdown.signal]);
    const timer = setTimeout(() => deadline.abort(), this.#requestTimeoutMs);
    try {
      const result = await window.transport[method](parameters, {
        conversationId: window.conversation_id, targetKey: window.target_key, signal, ...(onRequestStarted ? { onRequestStarted } : {}),
      });
      if (signal.aborted) throw invalid("window_ingress_cancelled");
      if (!object(result) || result.ok !== true) {
        if (result?.ok === false && typeof result.code === "string") {
          throw new CoreError(result.code, "窗口提供方拒绝请求", { ...result.details, outcomeUnknown: result.outcomeUnknown });
        }
        throw invalid("window_ingress_response_invalid");
      }
      return result;
    } finally { clearTimeout(timer); }
  }

  #route(window, value, state) {
    if (!object(value) || value.route_key !== window.route_key || value.conversation_id !== window.conversation_id
      || value.target_key !== window.target_key || value.window_capture !== true || value.capture_owner_events !== true
      || value.reply_delivery !== "events_only" || !["open", "closed"].includes(value.status)
      || !integer(value.route_generation, 1) || value.route_generation < state.provider_generation
      || value.window?.channel !== window.channel || value.window?.type !== window.window_type || value.window?.id !== window.window_id
      || !/^[1-9]\d{0,19}$/.test(value.window?.self_id) || !Array.isArray(value.owner_sender_allowlist)
      || value.owner_sender_allowlist.length < 1 || value.owner_sender_allowlist.length > 32
      || value.owner_sender_allowlist.some(sender => typeof sender !== "string" || !/^[1-9]\d{0,19}$/.test(sender))) throw invalid("window_ingress_route_invalid");
    const route = copy(value);
    route.window_binding = normalizeOwnerWindowBinding(value.window_binding);
    return freeze(route);
  }

  async #get(window, state, dedupeKey) {
    const result = await this.#request(window, "getOwnerWindowRoute", {
      route_key: window.route_key, ...(dedupeKey ? { dedupe_key: dedupeKey } : {}),
    });
    return { ...result, route: this.#route(window, result.route, state) };
  }

  #confirmRegistration(window, state, result) {
    const pending = state.pending_registration;
    const route = this.#route(window, result.route, state);
    const receipt = result.registration;
    if (!object(receipt) || receipt.dedupe_key !== pending.dedupe_key || receipt.expected_generation !== pending.expected_generation
      || typeof receipt.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(receipt.fingerprint)
      || !integer(receipt.applied_generation, 1) || receipt.applied_generation < pending.expected_generation
      || receipt.applied_generation > pending.expected_generation + 1 || receipt.applied_generation > route.route_generation
      || (receipt.applied_generation === route.route_generation && !isDeepStrictEqual(route.window_binding, pending.window_binding))) {
      throw invalid("window_ingress_registration_unconfirmed");
    }
    state.provider_generation = route.route_generation;
    state.confirmed_mapping_generation = pending.window_binding.generation;
    state.pending_registration = null;
    state.status = "pending";
    state.last_error = null;
    this.#save(window, state);
    return route;
  }

  async #recover(window, state, retryBlocked) {
    const pending = state.pending_registration ?? state.pending_close;
    if (!pending) return { route: null, resolved: true };
    if (pending.phase === "blocked") {
      if (!retryBlocked) return { route: null, resolved: false };
      if (!integer(state.blocked_retry_count + 1)) throw invalid("window_ingress_state_invalid");
      state.blocked_retry_count += 1;
      state.last_blocked_retry_at = this.#time();
      state.pending_registration = null;
      state.pending_close = null;
      state.status = "pending";
      state.last_error = null;
      state.next_poll_at = 0;
      this.#save(window, state);
      return { route: null, resolved: true };
    }
    let result;
    try {
      result = await this.#get(window, state, state.pending_registration?.dedupe_key);
      if (state.pending_registration) return { route: this.#confirmRegistration(window, state, result), resolved: true };
      if (result.route.status !== "closed" || result.route.route_generation <= pending.expected_generation) throw invalid("window_ingress_close_unconfirmed");
    } catch (error) {
      if (error.code === "window_ingress_persistence_failed") throw error;
      this.#failure(window, state, error, "recover");
      return { route: null, resolved: false };
    }
    state.provider_generation = result.route.route_generation;
    state.pending_close = null;
    state.status = "closed";
    state.last_error = null;
    this.#save(window, state);
    return { route: result.route, resolved: true };
  }

  async #mutate(window, state, desired) {
    const registration = desired !== null;
    const field = registration ? "pending_registration" : "pending_close";
    state[field] = {
      expected_generation: state.provider_generation, request_started: false, phase: "prepared",
      ...(registration ? { dedupe_key: `window-ingress:${digest([this.#scope(window), state.provider_generation, desired])}`, window_binding: desired } : {}),
    };
    state.status = "pending";
    state.last_error = null;
    this.#save(window, state);
    let persistError;
    let result;
    try {
      result = await this.#request(window, registration ? "registerOwnerWindowRoute" : "closeOwnerWindowRoute", {
        route_key: window.route_key, expected_generation: state.provider_generation,
        ...(registration ? { target_key: window.target_key, capture_owner_events: true, reply_delivery: "events_only", window_capture: true,
          dedupe_key: state[field].dedupe_key, window_binding: desired } : {}),
      }, () => {
        state[field].request_started = true;
        state[field].phase = "unknown";
        try { this.#save(window, state); } catch (error) { persistError = error; throw error; }
      });
      if (registration) return this.#confirmRegistration(window, state, result);
      const route = this.#route(window, result.route, state);
      if (route.status !== "closed" || route.route_generation <= state.pending_close.expected_generation) throw invalid("window_ingress_close_unconfirmed");
      state.provider_generation = route.route_generation;
      state.pending_close = null;
      state.status = "closed";
      state.last_error = null;
      this.#save(window, state);
      return route;
    } catch (error) {
      if (persistError || error.code === "window_ingress_persistence_failed") throw persistError ?? error;
      const unsent = error?.details?.request_sent === false && !state[field]?.request_started;
      const rejected = errorCode(error).startsWith("OWNER_WINDOW_") && error?.details?.outcomeUnknown !== true;
      if (state[field]) state[field].phase = unsent || rejected ? "blocked" : "unknown";
      this.#failure(window, state, error, registration ? "register" : "close", unsent || rejected ? "blocked" : "pending");
      return null;
    }
  }

  async #read(window, state, route) {
    const useCursor = state.cursor_generation === route.route_generation ? state.cursor : null;
    let page;
    try {
      page = await this.#request(window, "readOwnerWindowEvents", {
        route_key: window.route_key, expected_route_generation: route.route_generation, limit: 50,
        ...(useCursor === null ? {} : { cursor: useCursor }),
      });
      const currentRoute = this.#route(window, page.route, state);
      if (currentRoute.status !== "open" || currentRoute.route_generation !== route.route_generation || !Array.isArray(page.events)
        || page.events.length > 50 || typeof page.partial !== "boolean"
        || !(page.next_cursor === null || (identifier(page.next_cursor, 4096) && /^[A-Za-z0-9_-]+$/.test(page.next_cursor)))
        || ((page.events.length || page.partial) && (!page.next_cursor || page.next_cursor === useCursor))
        || (page.events.length === 0 && (page.partial || page.next_cursor !== useCursor))
        || (page.retention?.evicted_through > 0 && useCursor === null)) throw invalid(
          page.retention?.evicted_through > 0 && useCursor === null ? "OWNER_WINDOW_HISTORY_EXPIRED" : "window_ingress_page_invalid");
      for (const event of page.events) {
        if (!object(event) || !/^[a-f0-9]{64}$/.test(event.event_id) || event.route_key !== window.route_key
          || event.conversation_id !== window.conversation_id || event.target_key !== window.target_key
          || !integer(event.route_generation, 1) || event.route_generation > route.route_generation
          || !isDeepStrictEqual(event.window, currentRoute.window)) throw invalid("window_ingress_event_invalid");
        normalizeOwnerWindowBinding(event.window_binding);
      }
      const context = Object.freeze({ ...window, native_route: currentRoute });
      for (const event of page.events) {
        if (this.#shutdown.signal.aborted) throw invalid("window_ingress_cancelled");
        const persisted = await this.#onEvent(freeze(copy(event)), context);
        if (persisted === false || persisted?.persisted === false) throw invalid("window_ingress_event_unpersisted");
      }
      if (this.#shutdown.signal.aborted) throw invalid("window_ingress_cancelled");
    } catch (error) {
      const code = errorCode(error);
      if (GAP_CODES.has(code)) {
        state.gap ??= { code, detected_at: this.#time(), provider_generation: route.route_generation };
        this.#failure(window, state, error, "read", "gap");
      } else this.#failure(window, state, error, "read",
        ["OWNER_WINDOW_CURSOR_INVALID", "OWNER_WINDOW_CONTENT_UNAVAILABLE", "OWNER_WINDOW_TRUST_CHANGED", "OWNER_WINDOW_TRUST_UNAVAILABLE",
          "window_ingress_page_invalid", "window_ingress_route_invalid", "window_ingress_event_invalid"].includes(code) ? "blocked" : "pending");
      return false;
    }
    state.cursor = page.next_cursor;
    state.cursor_generation = route.route_generation;
    state.provider_generation = route.route_generation;
    state.last_error = null;
    state.next_poll_at = page.partial ? this.#time() : this.#time() + this.#pollIntervalMs;
    this.#save(window, state);
    return { partial: page.partial };
  }

  async #cycle(window, read, force, retryBlocked) {
    const state = this.#load(window);
    if (!force && state.next_poll_at > this.#time()) return state;
    if (!force && state.status === "blocked") return state;
    if (state.gap) return state;
    const recovered = await this.#recover(window, state, retryBlocked);
    if (!recovered.resolved || this.#shutdown.signal.aborted) return state;
    let desired;
    try { desired = this.#desired(window); } catch (error) { return this.#failure(window, state, error, "binding", "blocked"); }
    let route = recovered.route;
    if (!route) {
      try { route = (await this.#get(window, state)).route; } catch (error) {
        if (errorCode(error) !== "OWNER_WINDOW_SCOPE_MISMATCH" || state.provider_generation !== 0) {
          return this.#failure(window, state, error, "get", errorCode(error).startsWith("OWNER_WINDOW_")
            || errorCode(error) === "window_ingress_route_invalid" ? "blocked" : "pending");
        }
      }
    }
    if (route) {
      state.provider_generation = route.route_generation;
      this.#save(window, state);
      if (desired && !isDeepStrictEqual(desired, route.window_binding) && desired.generation <= route.window_binding.generation) {
        return this.#failure(window, state, invalid("window_ingress_mapping_conflict"), "mapping", "blocked");
      }
    }
    if (!desired && (!route || route.status === "closed")) {
      state.status = route ? "closed" : "idle";
      state.last_error = null;
      state.next_poll_at = this.#time() + this.#pollIntervalMs;
      return this.#save(window, state);
    }
    const changing = route?.status === "open" && (!desired || !isDeepStrictEqual(desired, route.window_binding));
    if (changing) {
      const drained = await this.#read(window, state, route);
      if (!drained) return state;
      if (drained.partial) { state.status = "pending"; return this.#save(window, state); }
      try { desired = this.#desired(window); } catch (error) { return this.#failure(window, state, error, "binding", "blocked"); }
      if (desired && !isDeepStrictEqual(desired, route.window_binding) && desired.generation <= route.window_binding.generation) {
        return this.#failure(window, state, invalid("window_ingress_mapping_conflict"), "mapping", "blocked");
      }
    }
    if (!route || route.status === "closed" || !desired || !isDeepStrictEqual(desired, route.window_binding)) {
      route = await this.#mutate(window, state, desired);
      if (!route || route.status === "closed") return state;
    }
    state.status = "ready";
    state.confirmed_mapping_generation = route.window_binding.generation;
    state.last_error = null;
    this.#save(window, state);
    if (read && !changing) await this.#read(window, state, route);
    if (state.status === "ready" && !read) {
      state.next_poll_at = this.#time();
      this.#save(window, state);
    }
    return state;
  }

  #run(window, read, force, retryBlocked = false) {
    if (this.#shutdown.signal.aborted) return Promise.resolve({ ...this.#load(window), status: "stopped" });
    if (read && this.#polls.has(window.window_key)) return this.#polls.get(window.window_key);
    const previous = this.#tails.get(window.window_key) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(() => this.#shutdown.signal.aborted
      ? { ...this.#load(window), status: "stopped" } : this.#cycle(window, read, force, retryBlocked)).then(copy);
    this.#tails.set(window.window_key, operation);
    if (read) this.#polls.set(window.window_key, operation);
    const clear = () => {
      if (this.#tails.get(window.window_key) === operation) this.#tails.delete(window.window_key);
      if (this.#polls.get(window.window_key) === operation) this.#polls.delete(window.window_key);
    };
    void operation.then(clear, clear);
    return operation;
  }

  #select(windowKey) {
    if (windowKey === undefined) return [...this.#windows.values()];
    const window = this.#windows.get(windowKey);
    if (!window) throw invalid("window_ingress_window_unknown");
    return [window];
  }

  start() { return Promise.all(this.#select().map(window => this.#run(window, false, true))); }

  synchronize(windowKey) {
    const operations = this.#select(windowKey).map(window => this.#run(window, false, true, true));
    return windowKey === undefined ? Promise.all(operations) : operations[0];
  }

  poll(windowKey) {
    const operations = this.#select(windowKey).map(window => this.#run(window, true, false));
    return windowKey === undefined ? Promise.all(operations) : operations[0];
  }

  getStatus(windowKey) {
    const states = this.#select(windowKey).map(window => copy(this.#load(window)));
    return windowKey === undefined ? states : states[0];
  }

  close() {
    if (!this.#closing) {
      this.#shutdown.abort();
      this.#closing = Promise.allSettled([...this.#tails.values()]).then(() => undefined);
    }
    return this.#closing;
  }
}
