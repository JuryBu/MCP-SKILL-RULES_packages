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

test("only a trusted concrete local identity opens a personal book", context => {
  const { book, database } = setup(context).open();
  assert.throws(() => book.list({ identity: recipient }), { code: "forbidden" });
  assert.throws(() => book.list({ ...principal(recipient), caller_scope: { host: "codex" } }), { code: "forbidden" });
  assert.throws(() => book.list(principal({ ...recipient, machine_id: peerMachine })), { code: "forbidden" });
  assert.throws(() => book.list(principal({ ...recipient, conversation_id: "*" })), { code: "invalid_input" });
  assert.equal(bookCount(database), 0);
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
