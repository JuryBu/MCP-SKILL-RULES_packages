import {
  CoreError, assertExactKeys, digest, hasTargetPermission,
  identityKey, normalizeIdentity, normalizeTarget, requireInteger, requireText,
} from "./contracts.mjs";

export function normalizeHostScope(value) {
  assertExactKeys(value, ["machine_id", "host", "surface"], "宿主身份范围");
  return {
    machine_id: requireText(value.machine_id, "machine_id", 128),
    host: requireText(value.host, "host", 64),
    surface: requireText(value.surface, "surface", 64),
  };
}

export function normalizeConversationAddress(value, machineId) {
  assertExactKeys(value, ["machine_id", "host", "surface", "conversation_id"], "对话地址");
  const identity = normalizeIdentity({ ...value, machine_id: value.machine_id ?? machineId });
  if (identity.conversation_id === "*") throw new CoreError("invalid_input", "对话地址须填写具体对话ID");
  return identity;
}

export class ConversationDirectory {
  constructor({ store, targets = [], routes = [] }) {
    this.store = store;
    this.targets = targets.map(normalizeTarget);
    this.routes = routes;
  }

  route(identity) {
    const matches = this.routes.filter(route => route.machine_id === identity.machine_id
      && route.host === identity.host && route.surface === identity.surface);
    if (matches.length !== 1) throw new CoreError("host_not_enabled", "该机器和宿主尚未启用投递接线");
    return matches[0];
  }

  byBinding(bindingId) {
    requireText(bindingId, "binding_id", 128);
    const matches = this.targets.filter(target => target.binding_id === bindingId);
    if (matches.length > 1) throw new CoreError("target_not_found", "目标绑定存在歧义");
    const target = matches[0] ?? this.store.getBinding(bindingId);
    if (!target) throw new CoreError("target_not_found", "目标绑定不存在");
    return normalizeTarget(target);
  }

  byIdentity(identity, principal) {
    const key = identityKey(identity);
    const matches = this.targets.filter(target => identityKey(target) === key);
    if (matches.length > 1) throw new CoreError("target_not_found", "目标对话地址存在歧义");
    let target = matches[0] ?? this.store.findBindingByIdentity(key);
    if (target) {
      target = normalizeTarget(target);
      if (principal && !hasTargetPermission(principal, target)) throw new CoreError("forbidden", "当前来源没有目标发送授权");
      return target;
    }
    const route = this.route(identity);
    target = normalizeTarget({
      ...identity,
      binding_id: `conversation-${digest(identity).slice(0, 48)}`,
      binding_generation: 1,
      adapter_id: route.adapter_id,
      capabilities: route.capabilities,
      evidence: "address_registered_delivery_unverified",
    });
    if (principal && !hasTargetPermission(principal, target)) throw new CoreError("forbidden", "当前来源没有目标发送授权");
    return normalizeTarget(this.store.putBinding(target, { expectedGeneration: 0 }));
  }

  resolve(reference, principal) {
    const identity = normalizeConversationAddress(reference, principal.identity.machine_id);
    if (reference.surface === undefined) {
      const matches = this.targets.filter(target => target.machine_id === identity.machine_id && target.host === identity.host && target.conversation_id === identity.conversation_id);
      if (matches.length > 1) throw new CoreError("target_not_found", "该对话地址需要明确窗口类型");
      if (matches.length === 1) {
        if (!hasTargetPermission(principal, matches[0])) throw new CoreError("forbidden", "当前来源没有目标发送授权");
        return matches[0];
      }
    }
    return this.byIdentity(identity, principal);
  }

  rememberCaller(identity) {
    const normalized = normalizeIdentity(identity);
    if (!this.routes.some(route => route.machine_id === normalized.machine_id && route.host === normalized.host && route.surface === normalized.surface)) return;
    this.byIdentity(normalized);
  }

  list(principal, input) {
    const limit = requireInteger(input.limit ?? 100, "limit", 1, 100);
    const host = input.host === undefined ? null : requireText(input.host, "host", 64);
    const staticTargets = this.targets.filter(target => hasTargetPermission(principal, target) && (host === null || target.host === host))
      .sort((left, right) => `${identityKey(left)}:${left.binding_id}`.localeCompare(`${identityKey(right)}:${right.binding_id}`));
    const scope = `directory:${digest({ identity: principal.identity, principal_id: principal.id, host, staticTargets })}`;
    let cursor = { phase: "static", offset: 0, afterId: null };
    if (input.cursor !== undefined && input.cursor !== null) {
      requireText(input.cursor, "cursor", 4096);
      let decoded;
      try { decoded = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")); } catch { throw new CoreError("invalid_cursor", "对话目录游标无效"); }
      assertExactKeys(decoded, ["scope", "phase", "offset", "afterId"], "对话目录游标");
      if (decoded.scope !== scope || !["static", "dynamic"].includes(decoded.phase)) throw new CoreError("invalid_cursor", "对话目录游标不属于当前查询");
      requireInteger(decoded.offset, "offset", 0, staticTargets.length);
      if (decoded.afterId !== null) requireText(decoded.afterId, "afterId", 128);
      if ((decoded.phase === "static" && decoded.afterId !== null) || (decoded.phase === "dynamic" && decoded.offset !== staticTargets.length)) throw new CoreError("invalid_cursor", "对话目录游标位置无效");
      cursor = decoded;
    }
    const selected = [];
    if (cursor.phase === "static") {
      selected.push(...staticTargets.slice(cursor.offset, cursor.offset + limit));
      cursor.offset += selected.length;
      if (cursor.offset >= staticTargets.length) cursor.phase = "dynamic";
    }
    let exhausted = false;
    if (cursor.phase === "dynamic") {
      let scanned = 0;
      while (selected.length < limit && scanned < 500) {
        const pageSize = Math.min(100, 500 - scanned);
        const page = this.store.listBindings({ limit: pageSize, ...(cursor.afterId ? { afterId: cursor.afterId } : {}) });
        if (!page.length) { exhausted = true; break; }
        for (const entry of page) {
          cursor.afterId = entry.binding_id;
          scanned += 1;
          const target = normalizeTarget(entry);
          if (!this.targets.some(known => identityKey(known) === identityKey(target))
            && hasTargetPermission(principal, target) && (host === null || target.host === host)) selected.push(target);
          if (selected.length >= limit) break;
        }
        if (selected.length < limit && page.length < pageSize) { exhausted = true; break; }
      }
      if (!exhausted) exhausted = this.store.listBindings({ limit: 1, ...(cursor.afterId ? { afterId: cursor.afterId } : {}) }).length === 0;
    }
    const hasMore = cursor.phase === "static" || !exhausted;
    return {
      targets: selected,
      next_cursor: hasMore ? Buffer.from(JSON.stringify({ scope, phase: cursor.phase, offset: cursor.offset, afterId: cursor.afterId })).toString("base64url") : null,
      has_more: hasMore,
    };
  }
}
