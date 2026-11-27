import { assertExactKeys, CoreError, identityKey, normalizeIdentity, requireText } from "./contracts.mjs";

const ADDRESS_KEYS = ["machine_id", "host", "surface", "conversation_id"];
const CONTROL = /[\u0000-\u001f\u007f]/u;
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

function bookActor(principal, machineId) {
  if (principal?.address_book_identity_bound !== true || principal.caller_scope != null) {
    throw new CoreError("forbidden", "当前入口无法确认这次调用属于哪条对话");
  }
  const identity = checkedAddress(principal.identity);
  if (identity.machine_id !== machineId) throw new CoreError("forbidden", "只能操作本机自己的通讯录");
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
      else if (entryKind === "board") {
        assertExactKeys(entry.target, ["machine_id", "board_id"], "交流板地址");
        target = {
          machine_id: checkedText(entry.target.machine_id ?? this.#machineId, "建板机标识", 128),
          board_id: checkedText(entry.target.board_id, "交流板标识", 128),
        };
      } else throw new CoreError("invalid_config", "共有条目类型无效");
      this.#shared.set(key, Object.freeze({
        id, alias, entry_kind: entryKind, target: Object.freeze(target), note: checkedNote(entry.note ?? ""),
      }));
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
    `);
  }

  #open(key) {
    const timestamp = this.#now();
    this.#database.prepare("INSERT OR IGNORE INTO caller_books(owner_key, created_at, updated_at) VALUES(?, ?, ?)").run(key, timestamp, timestamp);
  }

  #get(key, name) {
    return this.#database.prepare("SELECT alias, target_json, entry_kind, note, updated_at FROM caller_contacts WHERE owner_key = ? AND alias_key = ?").get(key, name);
  }

  #sharedContact(key, shared, conflict = false) {
    const saved = key === null ? null : this.#database.prepare("SELECT note, updated_at FROM caller_shared_notes WHERE owner_key = ? AND shared_id = ?").get(key, shared.id);
    return {
      alias: shared.alias, note: saved?.note ?? shared.note, target: { ...shared.target }, scope: "shared",
      shared_id: shared.id, entry_kind: shared.entry_kind, updated_at: saved?.updated_at ?? null, ...(conflict ? { alias_conflict: true } : {}),
    };
  }

  #resolve(key, name) {
    const shared = this.#shared.get(name);
    const personal = this.#get(key, name);
    if (shared && personal) throw new CoreError("contact_alias_conflict", "共有与个人通讯录有同名联系人，请先调整别名或直接填写地址");
    if (shared) return this.#sharedContact(key, shared);
    if (personal) return projectPersonal(personal);
    throw new CoreError("contact_not_found", "这本通讯录里没有该联系人");
  }

  #put(key, aliasValue, target, noteValue) {
    const alias = checkedText(aliasValue, "联系人别名", 256);
    const name = aliasKey(alias);
    if (this.#shared.has(name)) throw new CoreError("shared_alias_reserved", "此别名已用于本机共有联系人");
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
    const ownNames = this.#database.prepare("SELECT alias_key, alias, target_json FROM caller_contacts WHERE owner_key = ? AND entry_kind = 'contact' ORDER BY alias_key").all(ownerKey(receiver));
    const personal = ownNames.find(row => !this.#shared.has(row.alias_key) && identityKey(JSON.parse(row.target_json)) === peerKey);
    if (personal) return personal.alias;
    for (const entry of this.#shared.values()) {
      if (entry.entry_kind === "contact" && identityKey(entry.target) === peerKey) return entry.alias;
    }
    return null;
  }

  list(principal, { include_machine_routes = false } = {}) {
    const key = ownerKey(bookActor(principal, this.#machineId));
    this.#open(key);
    const personal = this.#database.prepare("SELECT alias_key, alias, target_json, entry_kind, note, updated_at FROM caller_contacts WHERE owner_key = ? ORDER BY alias_key").all(key);
    const names = new Set(personal.map(row => row.alias_key));
    const shared = [...this.#shared.entries()].map(([name, entry]) => this.#sharedContact(key, entry, names.has(name)));
    return {
      contacts: [...shared, ...personal.map(row => projectPersonal(row, this.#shared.has(row.alias_key)))],
      ...(include_machine_routes === true ? { machine_routes: this.#machineRoutes.map(route => ({ ...route })) } : {}),
    };
  }

  resolve(principal, alias) {
    return this.#resolve(ownerKey(bookActor(principal, this.#machineId)), aliasKey(alias));
  }

  listShared({ include_machine_routes = false } = {}) {
    return {
      contacts: [...this.#shared.values()].map(entry => this.#sharedContact(null, entry)),
      ...(include_machine_routes === true ? { machine_routes: this.#machineRoutes.map(route => ({ ...route })) } : {}),
    };
  }

  resolveShared(alias) {
    const entry = this.#shared.get(aliasKey(alias));
    if (!entry) throw new CoreError("contact_not_found", "共有通讯录里没有该联系人");
    return this.#sharedContact(null, entry);
  }

  openForSend(principal) {
    this.#open(ownerKey(bookActor(principal, this.#machineId)));
  }

  saveAddress(principal, { alias, target, note }) {
    const key = ownerKey(bookActor(principal, this.#machineId));
    return this.#put(key, alias, checkedAddress(target, this.#machineId), note);
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

  setNote(principal, { contact, note }) {
    const key = ownerKey(bookActor(principal, this.#machineId));
    const name = aliasKey(contact);
    const entry = this.#resolve(key, name);
    const text = checkedNote(note);
    const updatedAt = this.#now();
    if (entry.scope === "personal") {
      this.#database.prepare("UPDATE caller_contacts SET note = ?, updated_at = ? WHERE owner_key = ? AND alias_key = ?").run(text, updatedAt, key, name);
    } else {
      this.#open(key);
      this.#database.prepare(`
        INSERT INTO caller_shared_notes(owner_key, shared_id, note, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(owner_key, shared_id) DO UPDATE SET note = excluded.note, updated_at = excluded.updated_at
      `).run(key, this.#shared.get(name).id, text, updatedAt);
    }
    return { ...entry, note: text, updated_at: updatedAt };
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
    const shared = this.#shared.get(name);
    if (result.removed || !shared) return result;
    const removed = this.#database.prepare("DELETE FROM caller_shared_notes WHERE owner_key = ? AND shared_id = ?").run(key, shared.id);
    return { removed: removed.changes === 1, scope: "shared" };
  }
}
