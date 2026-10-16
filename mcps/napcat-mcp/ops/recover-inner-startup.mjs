import { planInnerStartupRecovery, applyInnerStartupRecovery } from "../src/inner-startup-residual-recovery.mjs";

try {
  const [mode, dataRoot, configurationPath, profilePath, profileSha256, downstream, control, upstream, probe] = process.argv.slice(2);
  if (!["Plan", "Apply"].includes(mode) || !probe) throw new Error("STARTUP_RECOVERY_MODE_REQUIRED");
  const input = { dataRoot, configurationPath, profilePath, profileSha256, historyPolicy: "preserve", allowInterruptedSnapshot: true,
    ports: { downstream: Number(downstream), control: Number(control), upstream: Number(upstream), probe: Number(probe) } };
  const plan = planInnerStartupRecovery(input);
  console.log(JSON.stringify(mode === "Plan" ? plan : applyInnerStartupRecovery(input, plan)));
} catch (error) {
  console.error(error.code ?? error.message);
  process.exitCode = 1;
}
