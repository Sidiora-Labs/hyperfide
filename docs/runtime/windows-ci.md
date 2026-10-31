# Windows checks

The root `.github/workflows/platform.yml` owns platform CI. See
[testing](testing.md) for the Node 24 and pnpm 9.15 checks. This repository does
not carry a separate Windows shard workflow under platform/.

Windows support requires running the relevant workspace checks on Windows,
including host process handling, filesystem paths and packaged desktop startup.
A Linux test pass does not establish Windows support. See
[platform support](platform-support.md) for capability boundaries.
