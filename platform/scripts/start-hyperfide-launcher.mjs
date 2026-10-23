import { runNativeModulePreflight } from "./start-hyperfide.mjs";

const { runHyperfideApp, runLauncherEntry } =
  await import("../packages/hyperfide-app/src/launcher.ts");

runLauncherEntry(() =>
  runHyperfideApp(process.argv.slice(2), {
    beforeServerStart: () => runNativeModulePreflight({ checkOnly: true }),
    worktreePolicy: null,
  }),
);
