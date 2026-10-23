import { createMachineOps } from "./src/machine-ops.js";
// Live qualification accepts the same injected settings resolver as the host.
if (process.env.HYPERFIDE_RAILWAY_LIVE !== "1") {
  console.log("SKIP Railway live smoke (HYPERFIDE_RAILWAY_LIVE is not 1)");
} else {
  const settingsModule = process.argv[2];
  if (!settingsModule) throw new Error("Pass a module exporting resolveCredentials from plugin settings.");
  const { resolveCredentials } = await import(settingsModule);
  const ops = createMachineOps(resolveCredentials);
  const machine = await ops.create({ idleTimeoutSec: 120 });
  try {
    const result = await machine.exec("printf hyperfide", { timeoutSec: 10, maxOutputBytes: 1024 });
    if (result.exitCode !== 0 || result.stdout !== "hyperfide") throw new Error("Railway smoke exec failed");
    console.log("Railway live smoke passed");
  } finally { await machine.destroy(); }
}
