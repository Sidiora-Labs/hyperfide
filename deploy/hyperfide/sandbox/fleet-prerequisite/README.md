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
