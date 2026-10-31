import { enrollMachine } from "../../../cli/src/commands/machine-enrollment.ts";

const env = {
  HYPERFIDE_DATA_DIR: process.env.HYPERFIDE_DATA_DIR,
  HYPERFIDE_ENROLLMENT: process.env.HYPERFIDE_ENROLLMENT,
  PATH: "/nonexistent",
};

await enrollMachine(
  { bootstrapEnv: "HYPERFIDE_ENROLLMENT" },
  {
    env,
    fetchFn: async () =>
      Response.json(
        { hostId: "host_synthetic", hostKey: "synthetic-host-key" },
        { status: 201 },
      ),
    homeDir: process.env.HYPERFIDE_DATA_DIR,
  },
);
