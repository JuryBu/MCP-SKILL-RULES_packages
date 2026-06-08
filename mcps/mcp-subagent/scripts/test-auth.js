#!/usr/bin/env node
import assert from "node:assert/strict";
import { discoverLanguageServerCandidates, getAccessToken, redactToken } from "../src/auth.js";

const tokenInfo = await getAccessToken();
assert.equal(typeof tokenInfo.accessToken, "string", "accessToken must be a string");
assert.match(tokenInfo.accessToken, /^devin-/, "accessToken should use Devin token prefix");
assert.ok(tokenInfo.accessToken.length > 40, "accessToken should look complete");
assert.notEqual(redactToken(tokenInfo.accessToken), tokenInfo.accessToken, "redaction must not reveal full token");

const candidates = await discoverLanguageServerCandidates();
assert.ok(Array.isArray(candidates), "discover must return an array");
assert.ok(candidates.length > 0, "at least one Devin/Windsurf LS candidate should exist");
const usable = candidates.filter((candidate) => candidate.csrf && candidate.ports?.length);
assert.ok(usable.length > 0, "at least one LS candidate should have csrf and listening ports");
for (const candidate of usable) {
  assert.equal(typeof candidate.pid, "number", "pid must be numeric");
  assert.equal(typeof candidate.csrf, "string", "csrf must be a string");
  assert.ok(candidate.ports.every((port) => Number.isInteger(port)), "ports must be integers");
}

console.log(`auth ok: candidates=${candidates.length} usable=${usable.length} token=${redactToken(tokenInfo.accessToken)}`);
