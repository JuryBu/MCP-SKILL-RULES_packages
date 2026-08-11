const MACHINE_ROLE_ALIASES = new Map([
  ["development", "development"],
  ["developer", "development"],
  ["training", "training"],
]);

export function canonicalMachineRole(value) {
  const normalized = String(value ?? "").trim();
  return MACHINE_ROLE_ALIASES.get(normalized) ?? null;
}

export function machineRoleAlias(value) {
  const alias = String(value ?? "").trim();
  const canonical = canonicalMachineRole(alias);
  return canonical && canonical !== alias ? { alias, canonical } : null;
}

export function machineRolesEqual(left, right) {
  const canonicalLeft = canonicalMachineRole(left);
  const canonicalRight = canonicalMachineRole(right);
  return canonicalLeft !== null && canonicalLeft === canonicalRight;
}

export function oppositeMachineRole(value) {
  const canonical = canonicalMachineRole(value);
  if (canonical === "development") return "training";
  if (canonical === "training") return "development";
  return null;
}
