import { assertExactKeys, CoreError, identityKey, normalizeIdentity, requireText } from "./contracts.mjs";
import { isLocalSharedHostPrincipal } from "./board-entry-contract.mjs";

const ADDRESS_KEYS = ["machine_id", "host", "surface", "conversation_id"];
const CONTROL = /[\u0000-\u001f\u007f]/u;
const BOARD_ID = /^[a-z0-9][a-z0-9_-]{0,127}$/u;
const MAX_CONTACTS = 512;

function checkedText(value, name, maximum) {
  const text = requireText(value, name, maximum);
  if (CONTROL.test(text)) throw new CoreError("invalid_input", `${name}不能含控制字符`);
  return text.trim();
}

function aliasKey(alias) {
  const text = checkedText(alias, "联系人别名", 256);
  if ([...text].length > 64) throw new CoreError("invalid_input", "联系人别名过长");
  return text.normalize("NFKC").toLowerCase();
}

function checkedNote(value) {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 1024 || [...value].length > 256 || CONTROL.test(value)) {
    throw new CoreError("invalid_input", "备注必须是大小受限的一行文本");
  }
  return value.trim();
}

function checkedAddress(value, fallbackMachine) {
  assertExactKeys(value, ADDRESS_KEYS, "联系人地址");
  const address = normalizeIdentity({ ...value, machine_id: value.machine_id ?? fallbackMachine });
  if (Object.values(address).some(part => part === "*" || CONTROL.test(part) || part !== part.trim())) {
    throw new CoreError("invalid_input", "联系人需要一个完整、明确的地址");
  }
  return address;
}

export function normalizeBoardAddress(value, fallbackMachine) {
  assertExactKeys(value, ["machine_id", "board_id"], "交流板地址");
  const machine = requireText(value.machine_id ?? fallbackMachine, "建板机标识", 128);
  const boardId = requireText(value.board_id, "交流板标识", 128);
  if (machine !== machine.trim() || machine === "*" || CONTROL.test(machine) || !BOARD_ID.test(boardId)) {
    throw new CoreError("invalid_input", "交流板需要完整的建板机和板标识");
  }
  return { machine_id: machine, board_id: boardId };
}

function bookActor(principal, machineId) {
  const bound = principal?.address_book_identity_bound === true && principal.caller_scope == null;
  const sharedHost = isLocalSharedHostPrincipal(principal, machineId);
  if (!bound && !sharedHost) {
    throw new CoreError("forbidden", "当前入口无法确认这次调用属于哪条对话");
  }
  const identity = checkedAddress(principal.identity);
  if (identity.machine_id !== machineId) throw new CoreError("forbidden", "只能操作本机自己的通讯录");
  if (sharedHost && (identity.host !== principal.caller_scope.host || identity.surface !== principal.caller_scope.surface)) {
    throw new CoreError("forbidden", "来源对话超出当前本机宿主入口范围");
  }
  return identity;
}

function ownerKey(identity) {
  return identityKey(identity);
}

function projectPersonal(row, conflict = false) {
  return { alias: row.alias, note: row.note, target: JSON.parse(row.target_json), scope: "personal",
    entry_kind: row.entry_kind, updated_at: row.updated_at, ...(conflict ? { alias_conflict: true } : {}) };
}

function checkedRoute(row) {
  return Object.freeze({
    machine_id: checkedText(row.machine_id, "机器标识", 128),
    channel: checkedText(row.channel, "中继渠道", 64),
    group_label: checkedText(row.group_label, "机器路线名称", 160),
    group_id: checkedText(row.group_id, "中继群标识", 128),
    account_id: checkedText(row.account_id, "中继账号标识", 128),
    enabled: row.enabled === true,
    relay_mode: checkedText(row.relay_mode ?? "group", "中继方式", 64),
  });
}

export class ConversationAddressBook {
  #database;
  #machineId;
  #shared = new Map();
  #sharedById = new Map();
  #machineRoutes;
  #readInbound;
  #now;

  constructor({ database, machineId, sharedContacts = [], machineRoutes = [], readInbound, now = () => new Date().toISOString() }) {
    this.#database = database;
    this.#machineId = checkedText(machineId, "本机标识", 128);
    this.#readInbound = readInbound;
    this.#now = now;
    const ids = new Set();
    for (const entry of sharedContacts) {
      assertExactKeys(entry, ["id", "alias", "target", "note", "entry_kind"], "共有联系人");
      const id = checkedText(entry.id, "共有联系人标识", 128);
      const alias = checkedText(entry.alias, "联系人别名", 256);
      const key = aliasKey(alias);
      if (ids.has(id) || this.#shared.has(key)) throw new CoreError("invalid_config", "共有联系人标识或别名重复");
      ids.add(id);
      const entryKind = entry.entry_kind ?? "contact";
      let target;
      if (entryKind === "contact") target = checkedAddress(entry.target, this.#machineId);
      else if (entryKind === "board") target = normalizeBoardAddress(entry.target, this.#machineId);
      else throw new CoreError("invalid_config", "共有条目类型无效");
      const frozen = Object.freeze({
        id, alias, alias_key: key, entry_kind: entryKind, target: Object.freeze(target), note: checkedNote(entry.note ?? ""),
      });
      this.#shared.set(key, frozen);
      this.#sharedById.set(id, frozen);
    }
    this.#machineRoutes = machineRoutes.map(checkedRoute);
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS caller_books (
        owner_key TEXT NOT NULL PRIMARY KEY,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS caller_contacts (
        owner_key TEXT NOT NULL REFERENCES caller_books(owner_key),
        alias_key TEXT NOT NULL,
        alias TEXT NOT NULL,
        target_json TEXT NOT NULL CHECK (json_valid(target_json)),
        entry_kind TEXT NOT NULL DEFAULT 'contact' CHECK (entry_kind IN ('contact', 'board')),
        note TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (owner_key, alias_key)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS caller_shared_notes (
        owner_key TEXT NOT NULL REFERENCES caller_books(owner_key),
        shared_id TEXT NOT NULL,
        note TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (owner_key, shared_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS caller_shared_aliases (
        owner_key TEXT NOT NULL REFERENCES caller_books(owner_key),
        shared_id TEXT NOT NULL,
        alias_key TEXT NOT NULL,
        alias TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (owner_key, shared_id),
        UNIQUE (owner_key, alias_key)
      ) STRICT;
    `);
  }

  #open(key) {
    const timestamp = this.#now();
    this.#database.prepare("INSERT OR IGNORE INTO caller_books(owner_key, created_at, updated_at) VALUES(?, ?, ?)").run(key, timestamp, timestamp);
  }

  #get(key, name) {
    return this.#database.prepare("SELECT alias, target_json, entry_kind, note, updated_at FROM caller_contacts WHERE owner_key = ? AND alias_key = ?").get(key, name);
  }

  #sharedAliasById(key, sharedId) {
    return key === null ? null : this.#database.prepare("SELECT alias_key, alias, updated_at FROM caller_shared_aliases WHERE owner_key = ? AND shared_id = ?").get(key, sharedId);
  }

  #sharedAliasByName(key, name) {
    return key === null ? null : this.#database.prepare("SELECT shared_id, alias_key, alias, updated_at FROM caller_shared_aliases WHERE owner_key = ? AND alias_key = ?").get(key, name);
  }

  #effectiveSharedEntries(key) {
    const aliasRows = key === null ? [] : this.#database.prepare("SELECT shared_id, alias_key, alias, updated_at FROM caller_shared_aliases WHERE owner_key = ?").all(key);
    const byId = new Map(aliasRows.map(row => [row.shared_id, row]));
    const byEffectiveKey = new Map();
    const list = [];
    for (const shared of this.#shared.values()) {
      const override = byId.get(shared.id) ?? null;
      const effectiveKey = override?.alias_key ?? shared.alias_key;
      const effectiveAlias = override?.alias ?? shared.alias;
      const item = { shared, override, effectiveKey, effectiveAlias };
      list.push(item);
      const bucket = byEffectiveKey.get(effectiveKey);
      if (bucket) bucket.push(item);
      else byEffectiveKey.set(effectiveKey, [item]);
    }
    return { list, byEffectiveKey, byId };
  }

  #sharedContact(key, shared, conflict = false, preloadedAlias = undefined) {
    const savedNote = key === null ? null : this.#database.prepare("SELECT note, updated_at FROM caller_shared_notes WHERE owner_key = ? AND shared_id = ?").get(key, shared.id);
    const savedAlias = preloadedAlias !== undefined ? preloadedAlias : this.#sharedAliasById(key, shared.id);
    let updatedAt = savedNote?.updated_at ?? null;
    if (savedAlias?.updated_at && (!updatedAt || savedAlias.updated_at > updatedAt)) updatedAt = savedAlias.updated_at;
    return {
      alias: savedAlias?.alias ?? shared.alias,
      note: savedNote?.note ?? shared.note,
      target: { ...shared.target },
      scope: "shared",
      shared_id: shared.id,
      entry_kind: shared.entry_kind,
      updated_at: updatedAt,
      ...(savedAlias ? { default_alias: shared.alias } : {}),
      ...(conflict ? { alias_conflict: true } : {}),
    };
  }

  #pruneOrphanSharedAliases(key) {
    const rows = this.#database.prepare("SELECT shared_id FROM caller_shared_aliases WHERE owner_key = ?").all(key);
    for (const row of rows) {
      if (!this.#sharedById.has(row.shared_id)) {
        this.#database.prepare("DELETE FROM caller_shared_aliases WHERE owner_key = ? AND shared_id = ?").run(key, row.shared_id);
      }
    }
  }

  #resolveSharedEffective(key, name) {
    const matches = [];
    const custom = this.#sharedAliasByName(key, name);
    if (custom) {
      const shared = this.#sharedById.get(custom.shared_id);
      if (shared) matches.push({ shared, override: custom });
    }
    const direct = this.#shared.get(name);
    if (direct && !matches.some(item => item.shared.id === direct.id)) {
      const override = this.#sharedAliasById(key, direct.id);
      if (!override || override.alias_key === name) matches.push({ shared: direct, override });
    }
    return matches;
  }

  #resolve(key, name) {
    const sharedMatches = this.#resolveSharedEffective(key, name);
    const personal = this.#get(key, name);
    if (sharedMatches.length > 1 || (sharedMatches.length === 1 && personal)) {
      throw new CoreError("contact_alias_conflict", "共有与个人通讯录有同名联系人，请先调整别名或直接填写地址");
    }
    if (sharedMatches.length === 1) return this.#sharedContact(key, sharedMatches[0].shared, false, sharedMatches[0].override);
    if (personal) return projectPersonal(personal);
    throw new CoreError("contact_not_found", "这本通讯录里没有该联系人");
  }

  #put(key, aliasValue, target, noteValue) {
    const alias = checkedText(aliasValue, "联系人别名", 256);
    const name = aliasKey(alias);
    if (this.#resolveSharedEffective(key, name).length > 0) throw new CoreError("shared_alias_reserved", "此别名已用于本机共有联系人");
    const note = noteValue === undefined ? null : checkedNote(noteValue);
    if (!this.#get(key, name) && this.#database.prepare("SELECT count(*) AS total FROM caller_contacts WHERE owner_key = ?").get(key).total >= MAX_CONTACTS) {
      throw new CoreError("contact_limit", "个人联系人已达到上限");
    }
    this.#open(key);
    const saved = this.#database.prepare(`
      INSERT INTO caller_contacts(owner_key, alias_key, alias, target_json, note, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(owner_key, alias_key) DO UPDATE SET alias = excluded.alias, note = COALESCE(?, caller_contacts.note), updated_at = excluded.updated_at
      WHERE caller_contacts.entry_kind = 'contact' AND caller_contacts.target_json = excluded.target_json
    `).run(key, name, alias, JSON.stringify(target), note ?? "", this.#now(), note);
    if (saved.changes !== 1) throw new CoreError("contact_alias_conflict", "此别名已有其它地址，原地址保持不变");
    return projectPersonal(this.#get(key, name));
  }

  resolveDisplayName(receiverIdentity, peerAddress) {
    const receiver = checkedAddress(receiverIdentity);
    if (receiver.machine_id !== this.#machineId) throw new CoreError("forbidden", "只能用本机收件对话的通讯录译名");
    const peerKey = identityKey(checkedAddress(peerAddress));
    const key = ownerKey(receiver);
    const { list: effectiveShared, byEffectiveKey } = this.#effectiveSharedEntries(key);
    const ownRows = this.#database.prepare("SELECT alias_key, alias, target_json, entry_kind FROM caller_contacts WHERE owner_key = ? ORDER BY alias_key").all(key);
    const personal = ownRows.find(row => row.entry_kind === "contact" && !byEffectiveKey.has(row.alias_key) && identityKey(JSON.parse(row.target_json)) === peerKey);
    if (personal) return personal.alias;
    const ownKeySet = new Set(ownRows.map(row => row.alias_key));
    for (const item of effectiveShared) {
      if (item.shared.entry_kind === "contact" && identityKey(item.shared.target) === peerKey) {
        const conflicted = ownKeySet.has(item.effectiveKey) || (byEffectiveKey.get(item.effectiveKey)?.length ?? 0) > 1;
        return conflicted ? item.shared.alias : item.effectiveAlias;
      }
    }
    return null;
  }

  list(principal, { include_machine_routes = false } = {}) {
    const key = ownerKey(bookActor(principal, this.#machineId));
    this.#open(key);
    const personal = this.#database.prepare("SELECT alias_key, alias, target_json, entry_kind, note, updated_at FROM caller_contacts WHERE owner_key = ? ORDER BY alias_key").all(key);
    const personalNames = new Set(personal.map(row => row.alias_key));
    const { list: effectiveShared, byEffectiveKey } = this.#effectiveSharedEntries(key);
    const shared = effectiveShared.map(item => {
      const conflict = personalNames.has(item.effectiveKey) || (byEffectiveKey.get(item.effectiveKey)?.length ?? 0) > 1;
      return this.#sharedContact(key, item.shared, conflict, item.override);
    });
    return {
      contacts: [...shared, ...personal.map(row => projectPersonal(row, byEffectiveKey.has(row.alias_key)))],
      ...(include_machine_routes === true ? { machine_routes: this.#machineRoutes.map(route => ({ ...route })) } : {}),
    };
  }

  resolve(principal, alias) {
    return this.#resolve(ownerKey(bookActor(principal, this.#machineId)), aliasKey(alias));
  }

  resolveBoard(principal, alias) {
    const entry = this.resolve(principal, alias);
    if (entry.entry_kind !== "board") throw new CoreError("invalid_input", "请填写交流板的代号或地址");
    return normalizeBoardAddress(entry.target);
  }

  listShared({ include_machine_routes = false } = {}) {
    return {
      contacts: [...this.#shared.values()].map(entry => this.#sharedContact(null, entry, false, null)),
      ...(include_machine_routes === true ? { machine_routes: this.#machineRoutes.map(route => ({ ...route })) } : {}),
    };
  }

  resolveShared(alias) {
    const entry = this.#shared.get(aliasKey(alias));
    if (!entry) throw new CoreError("contact_not_found", "共有通讯录里没有该联系人");
    return this.#sharedContact(null, entry, false, null);
  }

  openForSend(principal) {
    this.#open(ownerKey(bookActor(principal, this.#machineId)));
  }

  saveAddress(principal, { alias, target, note }) {
    const key = ownerKey(bookActor(principal, this.#machineId));
    return this.#put(key, alias, checkedAddress(target, this.#machineId), note);
  }

  saveBoard(principal, board) {
    return this.saveBoardForIdentity(bookActor(principal, this.#machineId), board);
  }

  #localBoardMember(memberIdentity) {
    requireText(memberIdentity?.surface, "surface", 64);
    const member = checkedAddress(memberIdentity);
    if (member.machine_id !== this.#machineId) throw new CoreError("forbidden", "只能查改本机对话的交流板代号");
    return member;
  }

  listBoardsForIdentity(memberIdentity) {
    const key = ownerKey(this.#localBoardMember(memberIdentity));
    const { byEffectiveKey } = this.#effectiveSharedEntries(key);
    const rows = this.#database.prepare(
      "SELECT alias_key, alias, target_json FROM caller_contacts WHERE owner_key = ? AND entry_kind = 'board' ORDER BY alias_key, alias");
    return rows.all(key).filter(row => !byEffectiveKey.has(row.alias_key))
      .map(row => ({ alias: row.alias, target: normalizeBoardAddress(JSON.parse(row.target_json)) }));
  }

  saveBoardForIdentity(memberIdentity, board) {
    const member = this.#localBoardMember(memberIdentity);
    assertExactKeys(board, ["machine_id", "board_id", "baseTitle"], "交流板登记");
    const target = JSON.stringify(normalizeBoardAddress({ machine_id: board.machine_id, board_id: board.board_id }));
    const title = [...checkedText(board.baseTitle, "交流板标题", 512)];
    if (title.length > 128) throw new CoreError("invalid_input", "交流板标题过长");
    const key = ownerKey(member);
    const findTarget = this.#database.prepare(
      "SELECT alias FROM caller_contacts WHERE owner_key = ? AND entry_kind = 'board' AND target_json = ? ORDER BY alias_key LIMIT 1");
    const count = this.#database.prepare("SELECT count(*) AS total FROM caller_contacts WHERE owner_key = ?");
    const existing = findTarget.get(key, target);
    if (existing) return { alias_allocated: true, alias: existing.alias };
    if (count.get(key).total >= MAX_CONTACTS) return { alias_allocated: false, alias_warning: "contact_limit" };
    const insert = this.#database.prepare(`
      INSERT INTO caller_contacts(owner_key, alias_key, alias, target_json, entry_kind, note, updated_at)
      SELECT ?, ?, ?, ?, 'board', '', ?
      WHERE NOT EXISTS (SELECT 1 FROM caller_contacts WHERE owner_key = ? AND entry_kind = 'board' AND target_json = ?)
        AND (SELECT count(*) FROM caller_contacts WHERE owner_key = ?) < ?
      ON CONFLICT(owner_key, alias_key) DO NOTHING
      RETURNING alias
    `);
    this.#open(key);
    const { byEffectiveKey } = this.#effectiveSharedEntries(key);
    for (let attempt = 1; attempt <= MAX_CONTACTS + this.#shared.size + 1; attempt += 1) {
      const suffix = attempt === 1 ? "" : "#" + attempt;
      const alias = title.slice(0, 64 - suffix.length).join("").trimEnd() + suffix;
      const name = aliasKey(alias);
      if (byEffectiveKey.has(name) || this.#get(key, name)) continue;
      const saved = insert.get(key, name, alias, target, this.#now(), key, target, key, MAX_CONTACTS);
      const matched = saved ?? findTarget.get(key, target);
      if (matched) return { alias_allocated: true, alias: matched.alias };
      if (count.get(key).total >= MAX_CONTACTS) return { alias_allocated: false, alias_warning: "contact_limit" };
    }
    throw new CoreError("contact_alias_conflict", "未找到可用的交流板短代号");
  }

  saveSender(principal, { message_id, alias, note }) {
    const actor = bookActor(principal, this.#machineId);
    const id = checkedText(message_id, "原消息标识", 256);
    const inbound = this.#readInbound?.(actor, id);
    if (!inbound || inbound.message_id !== id || inbound.source_verified !== true) {
      throw new CoreError("message_not_recipient", "原信不可用于收录");
    }
    let recipient;
    let sender;
    try {
      if (!inbound.recipient?.surface || !inbound.sender?.surface) throw new Error("incomplete_address");
      recipient = checkedAddress(inbound.recipient);
      sender = checkedAddress(inbound.sender);
    } catch {
      throw new CoreError("message_not_recipient", "原信不可用于收录");
    }
    if (identityKey(actor) !== identityKey(recipient)) throw new CoreError("message_not_recipient", "原信不可用于收录");
    return this.#put(ownerKey(actor), alias, sender, note);
  }

  rename(principal, { contact, alias: nextAliasValue, note: noteValue }) {
    const key = ownerKey(bookActor(principal, this.#machineId));
    const currentName = aliasKey(contact);
    const entry = this.#resolve(key, currentName);
    const nextAlias = checkedText(nextAliasValue, "联系人别名", 256);
    const nextName = aliasKey(nextAlias);
    const note = noteValue === undefined ? undefined : checkedNote(noteValue);
    const updatedAt = this.#now();

    if (entry.scope === "shared") {
      const shared = this.#sharedById.get(entry.shared_id);
      const collidingShared = this.#resolveSharedEffective(key, nextName).filter(item => item.shared.id !== shared.id);
      if (collidingShared.length > 0) throw new CoreError("shared_alias_reserved", "此别名已用于本机共有联系人");
      if (this.#get(key, nextName)) throw new CoreError("contact_alias_conflict", "此别名已有其它地址，原地址保持不变");
      const manageTx = !this.#database.isTransaction;
      if (manageTx) this.#database.exec("BEGIN IMMEDIATE");
      try {
        this.#open(key);
        this.#pruneOrphanSharedAliases(key);
        if (nextAlias === shared.alias) {
          this.#database.prepare("DELETE FROM caller_shared_aliases WHERE owner_key = ? AND shared_id = ?").run(key, shared.id);
        } else {
          this.#database.prepare(`
            INSERT INTO caller_shared_aliases(owner_key, shared_id, alias_key, alias, updated_at) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(owner_key, shared_id) DO UPDATE SET alias_key = excluded.alias_key, alias = excluded.alias, updated_at = excluded.updated_at
          `).run(key, shared.id, nextName, nextAlias, updatedAt);
        }
        if (note !== undefined) {
          this.#database.prepare(`
            INSERT INTO caller_shared_notes(owner_key, shared_id, note, updated_at) VALUES (?, ?, ?, ?)
            ON CONFLICT(owner_key, shared_id) DO UPDATE SET note = excluded.note, updated_at = excluded.updated_at
          `).run(key, shared.id, note, updatedAt);
        }
        if (manageTx) this.#database.exec("COMMIT");
      } catch (error) {
        if (manageTx) {
          try { this.#database.exec("ROLLBACK"); } catch {}
        }
        throw error;
      }
      return this.#sharedContact(key, shared);
    }

    if (this.#resolveSharedEffective(key, nextName).length > 0) {
      throw new CoreError("shared_alias_reserved", "此别名已用于本机共有联系人");
    }
    if (nextName !== currentName && this.#get(key, nextName)) {
      throw new CoreError("contact_alias_conflict", "此别名已有其它地址，原地址保持不变");
    }
    this.#database.prepare(`
      UPDATE caller_contacts SET alias_key = ?, alias = ?, note = COALESCE(?, note), updated_at = ?
      WHERE owner_key = ? AND alias_key = ?
    `).run(nextName, nextAlias, note ?? null, updatedAt, key, currentName);
    return projectPersonal(this.#get(key, nextName));
  }

  setNote(principal, { contact, note }) {
    const key = ownerKey(bookActor(principal, this.#machineId));
    const name = aliasKey(contact);
    const entry = this.#resolve(key, name);
    const text = checkedNote(note);
    const updatedAt = this.#now();
    if (entry.scope === "personal") {
      this.#database.prepare("UPDATE caller_contacts SET note = ?, updated_at = ? WHERE owner_key = ? AND alias_key = ?").run(text, updatedAt, key, name);
      return { ...entry, note: text, updated_at: updatedAt };
    }
    this.#open(key);
    this.#database.prepare(`
      INSERT INTO caller_shared_notes(owner_key, shared_id, note, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(owner_key, shared_id) DO UPDATE SET note = excluded.note, updated_at = excluded.updated_at
    `).run(key, entry.shared_id, text, updatedAt);
    return this.#sharedContact(key, this.#sharedById.get(entry.shared_id));
  }

  removePersonal(principal, alias) {
    const key = ownerKey(bookActor(principal, this.#machineId));
    const removed = this.#database.prepare("DELETE FROM caller_contacts WHERE owner_key = ? AND alias_key = ?").run(key, aliasKey(alias));
    return { removed: removed.changes === 1 };
  }

  remove(principal, alias) {
    const key = ownerKey(bookActor(principal, this.#machineId));
    const name = aliasKey(alias);
    const result = this.removePersonal(principal, alias);
    if (result.removed) return result;
    const sharedMatches = this.#resolveSharedEffective(key, name);
    if (sharedMatches.length !== 1) {
      const orphan = this.#sharedAliasByName(key, name);
      if (orphan && !this.#sharedById.has(orphan.shared_id)) {
        const cleaned = this.#database.prepare("DELETE FROM caller_shared_aliases WHERE owner_key = ? AND shared_id = ?").run(key, orphan.shared_id);
        return { removed: cleaned.changes === 1, scope: "shared" };
      }
      return result;
    }
    const { shared, override } = sharedMatches[0];
    if (override) {
      const defaultKey = shared.alias_key;
      if (defaultKey !== name) {
        const collidingShared = this.#resolveSharedEffective(key, defaultKey).filter(item => item.shared.id !== shared.id);
        if (collidingShared.length > 0 || this.#get(key, defaultKey)) {
          throw new CoreError("contact_alias_conflict", "恢复该共有联系人的默认名称会与现有联系人冲突，请先调整冲突联系人名称");
        }
      }
    }
    const sharedId = shared.id;
    const removedNote = this.#database.prepare("DELETE FROM caller_shared_notes WHERE owner_key = ? AND shared_id = ?").run(key, sharedId);
    const removedAlias = this.#database.prepare("DELETE FROM caller_shared_aliases WHERE owner_key = ? AND shared_id = ?").run(key, sharedId);
    return { removed: removedNote.changes === 1 || removedAlias.changes === 1, scope: "shared" };
  }
}
