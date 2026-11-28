import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { ConversationAddressBook } from "../src/conversation-address-book.mjs";

const localMachine = "sample-home";
const peerMachine = "sample-train";
const recipient = { machine_id: localMachine, host: "codex", surface: "desktop", conversation_id: "sample-one" };
const sibling = { ...recipient, conversation_id: "sample-two" };
const remote = { machine_id: peerMachine, host: "antigravity", surface: "desktop", conversation_id: "sample-remote" };
const sharedContact = {
  id: "sample-common", alias: "协作窗口", note: "公共备注",
  target: { host: "qq", surface: "group", conversation_id: "sample-room" },
};
const principal = identity => ({ identity, address_book_identity_bound: true });

function setup(context) {
  const directory = mkdtempSync(join(tmpdir(), "core-通讯录 样例-"));
  const databasePath = join(directory, "contacts.sqlite");
  const databases = [];
  const open = ({ machineId = localMachine, ...options } = {}) => {
    const database = new DatabaseSync(databasePath, { enableForeignKeyConstraints: true });
    databases.push(database);
    const book = new ConversationAddressBook({ database, machineId, sharedContacts: [sharedContact], ...options });
    return { book, database };
  };
  context.after(() => {
    for (const database of databases) if (database.isOpen) database.close();
    if (existsSync(databasePath)) unlinkSync(databasePath);
    rmdirSync(directory);
  });
  return { open };
}

function bookCount(database) {
  return database.prepare("SELECT count(*) AS count FROM caller_books").get().count;
}

test("lookup used for send is read only; first permitted list or send opens exactly one book", context => {
  const { book, database } = setup(context).open();
  const actor = principal(recipient);
  assert.equal(book.resolve(actor, "协作窗口").target.machine_id, localMachine);
  assert.throws(() => book.resolve(actor, "缺失联系人"), { code: "contact_not_found" });
  assert.equal(bookCount(database), 0);
  book.openForSend(actor);
  assert.equal(book.list(actor).contacts.length, 1);
  book.openForSend(actor);
  assert.equal(bookCount(database), 1);
  book.list(principal(sibling));
  assert.equal(bookCount(database), 2);
});

test("a recipient sees only its own name for a fellow recipient and read-only labels do not create a book", context => {
  const { book, database } = setup(context).open({ sharedContacts: [{ ...sharedContact, target: remote }] });
  const outsider = { ...remote, conversation_id: "fixture-with-no-name" };
  assert.equal(book.resolveDisplayName(recipient, remote), "协作窗口");
  assert.equal(book.resolveDisplayName(recipient, outsider), null);
  assert.equal(bookCount(database), 0);
  book.saveAddress(principal(recipient), { alias: "我的搭档", target: remote, note: "不作为显示名" });
  book.saveAddress(principal(sibling), { alias: "协同伙伴", target: remote });
  assert.equal(book.resolveDisplayName(recipient, remote), "我的搭档");
  assert.equal(book.resolveDisplayName(sibling, remote), "协同伙伴");
  assert.throws(() => book.resolveDisplayName(remote, recipient), { code: "forbidden" });
  assert.equal(bookCount(database), 2);
});

test("personal contacts and shared note overrides survive database close and re-open", context => {
  const { open } = setup(context);
  const first = open();
  first.book.setNote(principal(recipient), { contact: "协作窗口", note: "只改给自己看" });
  first.book.saveAddress(principal(recipient), { alias: "远端", target: remote, note: "原地址" });
  first.database.close();
  const { book, database } = open();
  const chosen = book.resolve(principal(recipient), "远端");
  assert.deepEqual({ ...chosen, updated_at: undefined }, { alias: "远端", note: "原地址", target: remote, scope: "personal", entry_kind: "contact", updated_at: undefined });
  assert.ok(Number.isFinite(Date.parse(chosen.updated_at)));
  assert.equal(book.list(principal(recipient)).contacts[0].note, "只改给自己看");
  assert.equal(book.list(principal(sibling)).contacts[0].note, "公共备注");
  assert.equal(bookCount(database), 2);
  assert.throws(() => book.resolve(principal(sibling), "远端"), { code: "contact_not_found" });
});

test("books are local to a machine and host even for the same conversation identifier", context => {
  const { open } = setup(context);
  const { book } = open();
  const { book: second } = open({ machineId: peerMachine, sharedContacts: [{ ...sharedContact, note: "训练机备注" }] });
  book.setNote(principal(recipient), { contact: "协作窗口", note: "开发机个人备注" });
  assert.equal(book.list(principal({ ...recipient, host: "antigravity" })).contacts[0].note, "公共备注");
  assert.equal(book.list(principal({ ...recipient, surface: "cli" })).contacts[0].note, "公共备注");
  const view = second.list(principal({ ...recipient, machine_id: peerMachine })).contacts[0];
  assert.equal(view.note, "训练机备注");
  assert.equal(view.target.machine_id, peerMachine);
});

test("only a trusted concrete local identity or local model host scope opens a personal book", context => {
  const { book, database } = setup(context).open();
  assert.throws(() => book.list({ identity: recipient }), { code: "forbidden" });
  assert.throws(() => book.list({ ...principal(recipient), caller_scope: { host: "codex" } }), { code: "forbidden" });
  assert.throws(() => book.list(principal({ ...recipient, machine_id: peerMachine })), { code: "forbidden" });
  assert.throws(() => book.list(principal({ ...recipient, conversation_id: "*" })), { code: "invalid_input" });
  // External channels (including github/webhook/non-model hosts), disabled flag, or cross-host impersonation under caller_scope stay forbidden
  for (const [host, surface] of [["qq", "group"], ["wechat", "private"], ["github", "webhook"], ["external-bot", "api"]]) {
    assert.throws(() => book.list({ identity: { machine_id: localMachine, host, surface, conversation_id: "ext-1" },
      caller_scope: { machine_id: localMachine, host, surface }, origin_kinds: ["agent_message"] }), { code: "forbidden" });
  }
  assert.throws(() => book.list({ identity: recipient, caller_scope: { machine_id: localMachine, host: "codex", surface: "desktop" },
    origin_kinds: ["human_message"] }), { code: "forbidden" });
  assert.throws(() => book.list({ identity: recipient, caller_scope: { machine_id: localMachine, host: "codex", surface: "desktop" },
    channel_component: "napcat_owner", origin_kinds: ["agent_message"] }), { code: "forbidden" });
  assert.throws(() => book.list({ identity: recipient, caller_scope: { machine_id: localMachine, host: "codex", surface: "desktop" },
    address_book_identity_bound: false, origin_kinds: ["agent_message"] }), { code: "forbidden" });
  assert.throws(() => book.list({ identity: { ...recipient, host: "antigravity" }, caller_scope: { machine_id: localMachine, host: "codex", surface: "desktop" },
    origin_kinds: ["agent_message"] }), { code: "forbidden" });
  assert.equal(bookCount(database), 0);
  // All three local model hosts (codex / antigravity / windsurf) access the exact same personal book as dedicated identities
  for (const host of ["codex", "antigravity", "windsurf"]) {
    const id = { ...recipient, host };
    const sharedHostActor = { identity: id, caller_scope: { machine_id: localMachine, host, surface: "desktop" }, origin_kinds: ["agent_message"] };
    book.rename(sharedHostActor, { contact: "协作窗口", alias: `共享改名-${host}` });
    assert.equal(book.resolve(principal(id), `共享改名-${host}`).target.conversation_id, "sample-room");
  }
  assert.equal(bookCount(database), 3);
});

test("board aliases are stable across repeated invitations and only appear in each member's book", context => {
  const { open } = setup(context);
  const { book, database } = open();
  const board = { machine_id: peerMachine, board_id: "fixture-board", baseTitle: "协作窗口" };
  book.saveAddress(principal(recipient), { alias: "协作窗口＃２", target: remote });
  assert.deepEqual(book.saveBoard(principal(recipient), board), { alias_allocated: true, alias: "协作窗口#3" });
  assert.deepEqual(book.saveBoardForIdentity(sibling, board), { alias_allocated: true, alias: "协作窗口#2" });
  assert.throws(() => book.resolveBoard(principal(sibling), "协作窗口#3"), { code: "contact_not_found" });
  assert.throws(() => book.resolveBoard(principal(recipient), "协作窗口＃２"), { code: "invalid_input" });
  book.setNote(principal(recipient), { contact: "协作窗口#3", note: "我自己的板备注" });
  database.close();
  const reopened = open().book;
  assert.deepEqual(reopened.saveBoard(principal(recipient), { ...board, baseTitle: "更名后的标题" }),
    { alias_allocated: true, alias: "协作窗口#3" });
  const saved = reopened.list(principal(recipient)).contacts.find(entry => entry.entry_kind === "board");
  assert.equal(saved.note, "我自己的板备注");
  assert.deepEqual(reopened.resolveBoard(principal(recipient), saved.alias), { machine_id: peerMachine, board_id: "fixture-board" });
  assert.equal(reopened.list(principal(sibling)).contacts.find(entry => entry.entry_kind === "board").note, "");
});

test("board alias suffixes respect the Unicode length cap and preserve both board targets", context => {
  const { book } = setup(context).open();
  const baseTitle = "屋".repeat(120);
  const first = book.saveBoardForIdentity(recipient, { machine_id: localMachine, board_id: "board-one", baseTitle });
  const second = book.saveBoardForIdentity(recipient, { machine_id: localMachine, board_id: "board-two", baseTitle });
  assert.equal(first.alias, "屋".repeat(64));
  assert.equal(second.alias, "屋".repeat(62) + "#2");
  assert.equal(book.resolveBoard(principal(recipient), first.alias).board_id, "board-one");
  assert.equal(book.resolveBoard(principal(recipient), second.alias).board_id, "board-two");
});

test("board registration refuses foreign, incomplete, wildcard, or untrusted owners and invalid board references", context => {
  const { book, database } = setup(context).open();
  const board = { machine_id: peerMachine, board_id: "fixture-board", baseTitle: "来信板" };
  assert.throws(() => book.saveBoard({ identity: recipient }, board), { code: "forbidden" });
  assert.throws(() => book.saveBoardForIdentity(remote, board), { code: "forbidden" });
  assert.throws(() => book.saveBoardForIdentity({ ...recipient, surface: undefined }, board), { code: "invalid_input" });
  assert.throws(() => book.saveBoardForIdentity({ ...recipient, conversation_id: "*" }, board), { code: "invalid_input" });
  assert.throws(() => book.saveBoard(principal(recipient), { ...board, board_id: "../fixture" }), { code: "invalid_input" });
  assert.throws(() => book.saveBoard(principal(recipient), { ...board, machine_id: "*" }), { code: "invalid_input" });
  assert.equal(bookCount(database), 0);
});

test("a full personal book declines a new board alias without mutating saved entries", context => {
  const { book, database } = setup(context).open();
  const board = { machine_id: localMachine, board_id: "fixture-board", baseTitle: "第一块板" };
  const actor = principal(recipient);
  database.exec("BEGIN");
  try {
    book.saveBoard(actor, board);
    for (let index = 0; index < 511; index += 1) book.saveAddress(actor, { alias: "测试联系人" + index, target: remote });
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  const before = book.list(actor);
  assert.deepEqual(book.saveBoard(actor, { ...board, board_id: "next-board" }),
    { alias_allocated: false, alias_warning: "contact_limit" });
  assert.deepEqual(book.saveBoard(actor, board), { alias_allocated: true, alias: "第一块板" });
  assert.deepEqual(book.list(actor), before);
});

test("save sender uses the verified inbound address for precisely its original recipient", context => {
  const inbound = {
    message_id: "sample-message", recipient, sender: remote, source_verified: true,
    text: "一段转述或自报来源，不参与选址",
  };
  const { book, database } = setup(context).open({
    readInbound: (_actor, id) => id === inbound.message_id ? inbound : id === "forward-only"
      ? { ...inbound, message_id: id, source_verified: false }
      : id === "missing-surface" ? { ...inbound, message_id: id, sender: { ...remote, surface: undefined } } : null,
  });
  assert.throws(() => book.saveSender(principal(sibling), { message_id: inbound.message_id, alias: "别人收到的" }), { code: "message_not_recipient" });
  for (const id of ["forward-only", "missing-surface", "not-found"]) {
    assert.throws(() => book.saveSender(principal(recipient), { message_id: id, alias: "未确认" }), { code: "message_not_recipient" });
  }
  assert.equal(bookCount(database), 0);
  assert.deepEqual(book.saveSender(principal(recipient), { message_id: inbound.message_id, alias: "从来信收录" }).target, remote);
  assert.equal(bookCount(database), 1);
});

test("equivalent aliases cannot overwrite an address and saving the same address preserves its note", context => {
  const { book } = setup(context).open();
  const actor = principal(recipient);
  assert.throws(() => book.saveAddress(actor, { alias: " 协作窗口 ", target: remote }), { code: "shared_alias_reserved" });
  assert.throws(() => book.saveAddress(actor, { alias: "换行\n", target: remote }), { code: "invalid_input" });
  book.saveAddress(actor, { alias: "Ａ搭档", target: remote, note: "记得回信" });
  assert.throws(() => book.saveAddress(actor, { alias: "a搭档", target: sibling }), { code: "contact_alias_conflict" });
  assert.equal(book.saveAddress(actor, { alias: "a搭档", target: remote }).note, "记得回信");
  assert.deepEqual(book.resolve(actor, "Ａ搭档").target, remote);
});

test("a newly configured shared alias cannot silently retarget a personal address", context => {
  const { open } = setup(context);
  const first = open();
  const actor = principal(recipient);
  first.book.saveAddress(actor, { alias: "改名后同名", target: remote });
  first.database.close();
  const { book } = open({
    sharedContacts: [{ ...sharedContact, alias: "改名后同名" }],
  });
  assert.equal(book.list(actor).contacts.filter(contact => contact.alias_conflict).length, 2);
  assert.throws(() => book.resolve(actor, "改名后同名"), { code: "contact_alias_conflict" });
  assert.equal(book.removePersonal(actor, "改名后同名").removed, true);
  assert.equal(book.resolve(actor, "改名后同名").scope, "shared");
  assert.equal(book.removePersonal(actor, "改名后同名").removed, false);
});

test("the optional machine route view returns only the agreed display fields", context => {
  const { book } = setup(context).open({
    machineRoutes: [{
      machine_id: peerMachine, channel: "qq", group_label: "测试路线", group_id: "sample-group",
      account_id: "sample-account", token: "test-only-secret",
    }],
  });
  const actor = principal(recipient);
  assert.ok(!Object.hasOwn(book.list(actor), "machine_routes"));
  assert.deepEqual(Object.keys(book.list(actor, { include_machine_routes: true }).machine_routes[0]), [
    "machine_id", "channel", "group_label", "group_id", "account_id", "enabled", "relay_mode",
  ]);
});

test("shared contacts act as per-caller defaults that each caller can rename without affecting others", context => {
  const { open } = setup(context);
  const first = open({ sharedContacts: [{ ...sharedContact, target: remote }] });
  const actor = principal(recipient);
  const peer = principal(sibling);

  // Rename shared contact without changing its note: note still dynamically inherits shared default
  const renamed = first.book.rename(actor, { contact: "协作窗口", alias: "主人专属群" });
  assert.equal(renamed.scope, "shared");
  assert.equal(renamed.alias, "主人专属群");
  assert.equal(renamed.default_alias, "协作窗口");
  assert.equal(renamed.note, "公共备注");
  assert.deepEqual(renamed.target, remote);

  // Other callers are completely unaffected; listShared also remains unaffected
  assert.equal(first.book.list(peer).contacts[0].alias, "协作窗口");
  assert.ok(!Object.hasOwn(first.book.list(peer).contacts[0], "default_alias"));
  assert.equal(first.book.listShared().contacts[0].alias, "协作窗口");

  // Renamed shared contact is resolvable by its personal name, supports setNote via new name, and updates display name
  assert.equal(first.book.resolve(actor, "主人专属群").shared_id, "sample-common");
  assert.throws(() => first.book.resolve(actor, "协作窗口"), { code: "contact_not_found" });
  const noted = first.book.setNote(actor, { contact: "主人专属群", note: "改名后备注" });
  assert.equal(noted.alias, "主人专属群");
  assert.equal(noted.note, "改名后备注");
  assert.equal(first.book.resolveDisplayName(recipient, remote), "主人专属群");
  assert.equal(first.book.resolveDisplayName(sibling, remote), "协作窗口");

  // Old default alias freed by caller's rename can be reused as a personal contact in that caller's own book
  first.book.saveAddress(actor, { alias: "协作窗口", target: sibling, note: "个人另用旧名" });
  assert.deepEqual(first.book.resolve(actor, "协作窗口").target, sibling);
  assert.equal(first.book.resolve(actor, "主人专属群").shared_id, "sample-common");

  // Board alias allocation respects caller's personal alias of shared contacts
  const board = first.book.saveBoard(actor, { machine_id: peerMachine, board_id: "renamed-clash", baseTitle: "主人专属群" });
  assert.deepEqual(board, { alias_allocated: true, alias: "主人专属群#2" });

  // Persists across close and reopen
  first.database.close();
  const second = open({ sharedContacts: [{ ...sharedContact, target: remote }] });
  assert.equal(second.book.resolve(actor, "主人专属群").note, "改名后备注");
  assert.equal(second.book.resolveDisplayName(recipient, remote), "主人专属群");
  assert.equal(second.book.resolveDisplayName(sibling, remote), "协作窗口");

  // Remove personal entry occupying old name, then remove shared overrides to restore default name & note
  assert.deepEqual(second.book.remove(actor, "协作窗口"), { removed: true });
  assert.deepEqual(second.book.remove(actor, "主人专属群"), { removed: true, scope: "shared" });
  assert.equal(second.book.resolve(actor, "协作窗口").note, "公共备注");
  assert.ok(!Object.hasOwn(second.book.resolve(actor, "协作窗口"), "default_alias"));
  assert.equal(second.book.resolveDisplayName(recipient, remote), "协作窗口");
});

test("rename supports personal contacts, prevents collisions, and keeps resolveDisplayName read-only", context => {
  const { book, database } = setup(context).open({
    sharedContacts: [
      sharedContact,
      { id: "sample-common-2", alias: "第二共有", note: "", target: remote },
    ],
  });
  const actor = principal(recipient);
  const outsider = { ...recipient, conversation_id: "sample-fresh-reader" };

  // resolveDisplayName on unseen caller creates zero caller_books rows
  assert.equal(book.resolveDisplayName(outsider, remote), "第二共有");
  assert.equal(bookCount(database), 0);

  // Personal rename & note update
  book.saveAddress(actor, { alias: "旧搭档", target: remote, note: "初备注" });
  const updated = book.rename(actor, { contact: "旧搭档", alias: "新搭档", note: "新备注" });
  assert.equal(updated.scope, "personal");
  assert.equal(updated.alias, "新搭档");
  assert.equal(updated.note, "新备注");
  assert.throws(() => book.resolve(actor, "旧搭档"), { code: "contact_not_found" });
  assert.deepEqual(book.resolve(actor, "新搭档").target, remote);

  // Collisions blocked for both shared and personal renames
  assert.throws(() => book.rename(actor, { contact: "新搭档", alias: "协作窗口" }), { code: "shared_alias_reserved" });
  assert.throws(() => book.rename(actor, { contact: "协作窗口", alias: "第二共有" }), { code: "shared_alias_reserved" });
  assert.throws(() => book.rename(actor, { contact: "协作窗口", alias: "新搭档" }), { code: "contact_alias_conflict" });

  // Renaming shared contact back to its exact default alias cleans the override cleanly
  book.rename(actor, { contact: "协作窗口", alias: "临时别名" });
  const restored = book.rename(actor, { contact: "临时别名", alias: "协作窗口" });
  assert.equal(restored.alias, "协作窗口");
  assert.ok(!Object.hasOwn(restored, "default_alias"));
});

test("remove refuses restoring a colliding shared default alias and rename prunes orphaned shared overrides", testContext => {
  const { book, database } = setup(testContext).open({
    machineId: "dev",
    sharedContacts: [
      { id: "s1", alias: "默认甲", target: { machine_id: "dev", host: "qq", surface: "group", conversation_id: "g1" } },
      { id: "s2", alias: "默认乙", target: { machine_id: "dev", host: "qq", surface: "group", conversation_id: "g2" } },
    ],
  });
  const actor = principal({ machine_id: "dev", host: "codex", surface: "desktop", conversation_id: "conv-deadlock-guard" });

  // S1 renames "默认甲" -> "临时名", releasing "默认甲"; S2 then claims "默认甲"
  book.rename(actor, { contact: "默认甲", alias: "临时名" });
  book.rename(actor, { contact: "默认乙", alias: "默认甲" });

  // Removing "临时名" would restore S1 back to "默认甲" and deadlock both shared entries -> must reject!
  assert.throws(() => book.remove(actor, "临时名"), error => error.code === "contact_alias_conflict");
  assert.equal(book.resolve(actor, "临时名").target.conversation_id, "g1");
  assert.equal(book.resolve(actor, "默认甲").target.conversation_id, "g2");

  // Once S2 moves off "默认甲", removing "临时名" restores S1 cleanly
  book.rename(actor, { contact: "默认甲", alias: "默认乙" });
  assert.deepEqual(book.remove(actor, "临时名"), { removed: true, scope: "shared" });
  assert.equal(book.resolve(actor, "默认甲").target.conversation_id, "g1");

  // Reopen with s2 removed from shared config while an orphaned alias row remains in SQLite
  book.rename(actor, { contact: "默认乙", alias: "下线占名" });
  const book2 = new ConversationAddressBook({
    database,
    machineId: "dev",
    sharedContacts: [
      { id: "s1", alias: "默认甲", target: { machine_id: "dev", host: "qq", surface: "group", conversation_id: "g1" } },
    ],
  });
  // Renaming s1 to "下线占名" must prune the orphaned s2 override instead of throwing SQLITE_CONSTRAINT_UNIQUE
  const renamed = book2.rename(actor, { contact: "默认甲", alias: "下线占名" });
  assert.equal(renamed.alias, "下线占名");
  assert.equal(book2.resolve(actor, "下线占名").target.conversation_id, "g1");
});
