export default function plugin(hyperfide: any) {
  const globals = globalThis as any;
  globals.__builtinFixtureLoads = (globals.__builtinFixtureLoads ?? 0) + 1;

  hyperfide.cli.register({
    name: "builtin-fixture",
    summary: "Builtin fixture command",
    commands: [],
    run: async () => ({
      exitCode: 0,
      stdout: `builtin ${hyperfide.pluginId}`,
    }),
  });
}
