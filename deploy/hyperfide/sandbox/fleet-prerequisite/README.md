# Fleet prerequisite seed

`prepare-seed.py` assembles the compiled native executables, stamped control-plane installer, production dependencies, Node 24.22.0, npm 11.19.1, Git, shared libraries, and optional pinned worker runtimes. Its input manifest records file bytes, modes, links, platform image digests, the control source stamp, and working-tree state.

Supply `base-images.json` with resolved Linux x64 OCI references under `ubuntu.reference` and `sandbox_api.reference`, plus their registry metadata. `resource-plan.json` supplies a new `hf-fleet-prereq-seed-<12 hex characters>` image name. Both files belong in the ignored seed build directory.

```sh
python3 deploy/hyperfide/sandbox/fleet-prerequisite/prepare-seed.py \
  --node-root /opt/node-v24.22.0 \
  --output build/fleet/seed/context \
  --base-images build/fleet/seed/base-images.json \
  --resource-plan build/fleet/seed/resource-plan.json \
  --claude /path/to/verified/claude-2.1.300 \
  --claude-sha256 674deba0bba9aee479f4503c438b49303b6fdd304b9a471b14977aaec5215453 \
  --python-root /path/to/python-3.14.8-runtime
```

`push-seed.mjs` verifies the manifest before starting one image build with a private CLI home, 4 GiB build memory, and a 20-minute deadline. It retains the full build-input SHA-256 and uses its first 32 hexadecimal characters for the immutable Blaxel catalog tag.

```sh
node --env-file=.env --import ./deploy/hyperfide/fleet-env.mjs \
  deploy/hyperfide/sandbox/fleet-prerequisite/push-seed.mjs \
  --context build/fleet/seed/context \
  --cli build/fleet/seed/tooling/bl-pinned
```

The private Blaxel adapter policy uses body version 2 for these tags: `preparation_seed_reference` selects the published catalog tag and `preparation_seed_digest` retains the full build-input digest. The build journal records the exact image reference for subsequent probes and cleanup.

## Prerequisite handoff

Seed publication supplies pinned runtime inputs; the final prerequisite remains a
separate qualification. Use the [operations journey](../../../../../../docs/hyperfide/hyperfide/operations.md#prerequisite-handoff)
for the approved provider/model campaign and signed fault captures. Resolve Node
with `HYPERFIDE_FLEET_NODE` or the executable on PATH; a machine-specific home path
is not part of the seed contract.

The bounded task gate runs `0_14.py --component` with `support/withpg.py` and writes
private `build/fleet/0.14/component-receipt.json`, `receipt.json` and the explicitly
UNRUN `live-receipt.json`. Keep supervisor restoration logs and operation identities.
The owner runs `0_14_live.py evidence-index --task 0.14` with private
`0_14-index-input.json` and `0_14-target-input.json` beside the actual captures, then
`0_14.py --live-evidence ... --target ... --receipt ...` through `withpg.py`.
The full commands, enrollment prerequisites and recovery steps are in operations.
The final live receipt records the classified assertion inventory and must be PASS.

Keep uncertain provider/native operations under their original IDs for reconciliation,
retain capacity until confirmed absence, and recover installation only through its
signed failure/quiescence chain. The Git source adapter migrates to native revision,
root-tree and namespace pins through the existing install/result contracts. Native
task 0.1 is released only after the final prerequisite has live PASS; a seed, local
component PASS or an UNRUN campaign does not release it.
