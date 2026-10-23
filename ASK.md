kind: permission

Question: May task 0.9 repair the platform typecheck tool configuration outside its declared touches?

Options:
- Have the platform owner supply a working typecheck toolchain (recommended).
- Approve a scoped tool configuration repair under platform/.

Blocked: bash tests/hyperfide/cases/v22/0_9.sh fails during platform typecheck because hyperfide-plugin-machine-blaxel runs tsc --noEmit and reports sh: 1: tsc: not found. Fixing package scripts or dependencies is a behavioral change outside task touches. The checkout also lacks the canonical tests/hyperfide/cases/v22/identity_gate.py from task 0.7.

Finished: Node 24 CI workflow with push and pull-request path filters, lockfile-keyed pnpm store cache and read-only permission; Corepack CI driver with full and quick modes; real qualification checks; operations documentation. Task has not been marked implemented. No checks were weakened.
