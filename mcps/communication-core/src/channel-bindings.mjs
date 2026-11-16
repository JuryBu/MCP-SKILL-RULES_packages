import { isDeepStrictEqual, types } from "node:util";
import { CoreError, digest, identityKey, requireInteger, requireText } from "./contracts.mjs";

const MAX_WINDOWS = 1000;
const MAX_PAGE_SIZE = 100;
const IDENTITY_FIELDS = ["machine_id", "host", "surface", "conversation_id"];
const WINDOW_FIELDS = ["channel", "component", "window_type", "window_id", "binding_id"];
const INPUT_FIELDS = ["caller", "action", "channel", "window_type", "window_id", "expected_generation", "limit", "after_key"];
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const ACTION_FIELDS = {
  bind: ["caller", "action", "channel", "window_type", "window_id", "expected_generation"],
  get: ["caller", "action", "channel", "window_type", "window_id"],
  list: ["caller", "action", "channel", "window_type", "window_id", "limit", "after_key"],
  remove: ["caller", "action", "channel", "window_type", "window_id", "expected_generation"],
};

function dataObject(value, name, allowed) {
  if (!value || typeof value !== "object" || types.isProxy(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new CoreError("invalid_input", `${name}必须是普通对象`);
  }
  const copied = {};
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || UNSAFE_KEYS.has(key) || (allowed && !allowed.includes(key))
      || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
      throw new CoreError("invalid_input", `${name}包含不支持或不安全的字段`);
    }
    copied[key] = descriptor.value;
  }
  return copied;
}

function text(value, name, maximum) {
  requireText(value, name, maximum);
  if (value.includes("\0")) throw new CoreError("invalid_input", `${name}不能包含空字符`);
  return value;
}

function callerIdentity(value) {
  const record = dataObject(value, "对话身份", IDENTITY_FIELDS);
  const identity = {
    machine_id: text(record.machine_id, "machine_id", 128),
    host: text(record.host, "host", 64),
    surface: text(record.surface ?? "desktop", "surface", 64),
    conversation_id: text(record.conversation_id, "conversation_id", 256),
  };
  if (identity.conversation_id === "*") throw new CoreError("invalid_input", "需要本次实际调用者的对话ID");
  return identity;
}

function windowType(value) {
  text(value, "window_type", 16);
  if (!["private", "group"].includes(value)) throw new CoreError("invalid_input", "不支持该聊天窗口类型");
  return value;
}

function addressKey(record) {
  return JSON.stringify([record.channel, record.window_type, record.window_id]);
}

export class ChannelBindingManager {
  #windowsByAddress = new Map();
  #enabledChannels = new Set();
  #resolveCallerTarget;

  constructor(options = {}) {
    const { store, windows = [], resolveCallerTarget } = dataObject(options, "窗口对应关系管理配置",
      ["store", "windows", "resolveCallerTarget"]);
    if (typeof resolveCallerTarget !== "function" || types.isAsyncFunction(resolveCallerTarget)) {
      throw new CoreError("invalid_input", "resolveCallerTarget必须是同步函数");
    }
    if (types.isProxy(windows) || !Array.isArray(windows) || Object.getPrototypeOf(windows) !== Array.prototype
      || windows.length > MAX_WINDOWS || Reflect.ownKeys(windows).length !== windows.length + 1) {
      throw new CoreError("invalid_input", "windows必须是最多1000项的普通窗口数组");
    }
    this.store = store;
    this.#resolveCallerTarget = resolveCallerTarget;
    const keys = new Set();
    for (let windowIndex = 0; windowIndex < windows.length; windowIndex += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(windows, String(windowIndex));
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
        throw new CoreError("invalid_input", "windows不能包含空项或访问器");
      }
      const source = dataObject(descriptor.value, "已授权窗口", WINDOW_FIELDS);
      if (!["qq", "wechat"].includes(source.channel)) throw new CoreError("invalid_input", "配置包含不支持的渠道");
      const window = {
        channel: source.channel,
        component: text(source.component, "component", 64),
        window_type: windowType(source.window_type),
        window_id: text(source.window_id, "window_id", 256),
        binding_id: text(source.binding_id, "binding_id", 128),
      };
      window.window_key = `window:${digest([window.channel, window.component, window.window_type, window.window_id])}`;
      if (keys.has(window.window_key)) throw new CoreError("invalid_input", "windows包含重复的实际窗口");
      keys.add(window.window_key);
      const address = addressKey(window);
      const candidates = this.#windowsByAddress.get(address) ?? [];
      candidates.push(Object.freeze(window));
      this.#windowsByAddress.set(address, candidates);
      this.#enabledChannels.add(window.channel);
    }
  }

  #store() {
    const store = this.store;
    if (!store || ["transaction", "getChannelBinding", "putChannelBinding", "deleteChannelBinding", "listChannelBindings"]
      .some(method => typeof store[method] !== "function")) {
      throw new CoreError("store_not_ready", "窗口对应关系存储尚未就绪");
    }
    return store;
  }

  #channel(value) {
    text(value, "channel", 16);
    if (!["qq", "wechat"].includes(value) || !this.#enabledChannels.has(value)) {
      throw new CoreError("channel_not_enabled", "当前服务没有该渠道的已授权实际窗口");
    }
    return value;
  }

  #window(input) {
    this.#channel(input.channel);
    windowType(input.window_type);
    text(input.window_id, "window_id", 256);
    const candidates = this.#windowsByAddress.get(addressKey(input)) ?? [];
    if (candidates.length === 0) throw new CoreError("channel_not_enabled", "该聊天窗口没有已启用的授权配置");
    if (candidates.length !== 1) {
      throw new CoreError("channel_window_ambiguous", "同一聊天地址存在多个组件，当前输入无法唯一选择窗口");
    }
    return candidates[0];
  }

  #target(principal, ownerKey) {
    const resolved = this.#resolveCallerTarget(principal);
    if (types.isPromise(resolved)) {
      resolved.catch(() => {});
      throw new CoreError("invalid_input", "resolveCallerTarget不能返回Promise");
    }
    const record = dataObject(resolved, "调用者绑定目标");
    if (typeof record.then === "function") throw new CoreError("invalid_input", "resolveCallerTarget不能返回thenable");
    const identity = callerIdentity(Object.fromEntries(IDENTITY_FIELDS.map(field => [field, record[field]])));
    if (identityKey(identity) !== ownerKey) throw new CoreError("caller_mismatch", "窗口绑定目标必须属于本次实际调用者");
    return {
      ...identity,
      binding_id: text(record.binding_id, "binding_id", 128),
      binding_generation: requireInteger(record.binding_generation, "binding_generation", 1),
    };
  }

  #bind(store, principal, ownerKey, input, window) {
    const expectedGeneration = requireInteger(input.expected_generation ?? 0, "expected_generation");
    return store.transaction(() => {
      const current = store.getChannelBinding(window.window_key);
      if (current && !current.deleted && current.owner_key !== ownerKey) throw new CoreError("channel_binding_conflict", "该聊天窗口属于其它对话");
      const actualGeneration = current?.generation ?? 0;
      if (expectedGeneration !== actualGeneration) {
        throw new CoreError("binding_changed", "窗口对应关系代次已变化", {
          expected_generation: expectedGeneration,
          actual_generation: actualGeneration,
        });
      }
      const record = {
        window_key: window.window_key,
        channel: window.channel,
        component: window.component,
        window_type: window.window_type,
        window_id: window.window_id,
        channel_binding_id: window.binding_id,
        target: this.#target(principal, ownerKey),
      };
      if (current && !current.deleted
        && isDeepStrictEqual(current, { ...record, generation: current.generation, owner_key: ownerKey, deleted: false })) {
        return current;
      }
      return store.putChannelBinding(record, { ownerKey, expectedGeneration, claimReleased: Boolean(current?.deleted && current.owner_key !== ownerKey) });
    });
  }

  #list(store, ownerKey, input) {
    if (input.channel !== undefined) this.#channel(input.channel);
    if (input.window_type !== undefined) windowType(input.window_type);
    if (input.window_id !== undefined) text(input.window_id, "window_id", 256);
    const limit = requireInteger(input.limit === undefined ? MAX_PAGE_SIZE : input.limit, "limit", 1, MAX_PAGE_SIZE);
    if (input.after_key !== undefined) text(input.after_key, "after_key", 256);
    const page = store.listChannelBindings({ ownerKey, limit, afterKey: input.after_key });
    if (!Array.isArray(page) || page.length > limit || page.some(record => record.owner_key !== ownerKey)) {
      throw new CoreError("store_result_invalid", "窗口存储返回了不符合归属或分页约定的结果");
    }
    const lastKey = page.at(-1)?.window_key;
    let hasMore = false;
    if (page.length === limit) {
      const following = store.listChannelBindings({ ownerKey, limit: 1, afterKey: lastKey });
      if (!Array.isArray(following) || following.length > 1 || following.some(record => record.owner_key !== ownerKey)) {
        throw new CoreError("store_result_invalid", "窗口存储返回了不符合归属或分页约定的结果");
      }
      hasMore = following.length === 1;
    }
    return {
      bindings: page.filter(record => ["channel", "window_type", "window_id"]
        .every(field => input[field] === undefined || record[field] === input[field])),
      next_after_key: hasMore ? lastKey : null,
      has_more: hasMore,
    };
  }

  manage(principal, input) {
    const actor = dataObject(principal, "调用者");
    const ownerKey = identityKey(callerIdentity(actor.identity));
    const request = dataObject(input, "窗口对应关系请求", INPUT_FIELDS);
    const action = text(request.action, "action", 16);
    if (!Object.hasOwn(ACTION_FIELDS, action)) throw new CoreError("invalid_input", "不支持该窗口管理操作");
    if (Object.keys(request).some(field => request[field] !== undefined && !ACTION_FIELDS[action].includes(field))) {
      throw new CoreError("invalid_input", "请求包含不适用于该操作的字段");
    }
    if (request.caller !== undefined && identityKey(callerIdentity(request.caller)) !== ownerKey) {
      throw new CoreError("caller_mismatch", "caller与本次实际调用者不一致");
    }
    if (request.expected_generation !== undefined) requireInteger(request.expected_generation, "expected_generation");
    if (action === "list") return this.#list(this.#store(), ownerKey, request);
    const window = this.#window(request);
    const store = this.#store();
    if (action === "bind") return this.#bind(store, principal, ownerKey, request, window);
    if (action === "get") {
      const current = store.getChannelBinding(window.window_key);
      if (current?.owner_key === ownerKey) return current;
      if (current?.deleted) return Object.fromEntries(["window_key", "channel", "component", "window_type", "window_id", "channel_binding_id", "generation", "deleted"].map(field => [field, current[field]]));
      return null;
    }
    requireInteger(request.expected_generation, "expected_generation");
    return store.deleteChannelBinding(window.window_key, { ownerKey, expectedGeneration: request.expected_generation });
  }
}
