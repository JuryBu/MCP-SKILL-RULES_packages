import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalMachineRole,
  machineRoleAlias,
  machineRolesEqual,
  oppositeMachineRole,
} from "../src/machine-role.mjs";

test("machine roles keep one canonical vocabulary and one controlled legacy alias", () => {
  assert.equal(canonicalMachineRole("development"), "development");
  assert.equal(canonicalMachineRole("developer"), "development");
  assert.equal(canonicalMachineRole("training"), "training");
  assert.deepEqual(machineRoleAlias("developer"), { alias: "developer", canonical: "development" });
  assert.equal(machineRoleAlias("development"), null);
  assert.equal(machineRolesEqual("developer", "development"), true);
  assert.equal(oppositeMachineRole("developer"), "training");
});

test("unknown and approximate role spellings remain rejected", () => {
  for (const role of ["dev", "Developer", "trainer", "training-preview", ""]) {
    assert.equal(canonicalMachineRole(role), null);
    assert.equal(machineRolesEqual(role, "development"), false);
  }
});
