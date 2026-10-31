# Fleet prerequisite contracts

`index.mjs` is the canonical dependency-free runtime shared by the independent control-plane package and other Hyperfide consumers. `index.d.mts` declares the same public surface. Deployment builds copy these files into their own distribution; production code must not depend on a checkout-relative fallback.

`parseNeron` and `parsePackage` validate strict KVX and return frozen section records. Pass the parsed source configuration as `parsePackage(text, {neron})` to check environment identity, source configuration digest and read scope. `digest(parsed)` hashes canonical parsed content; comments and field order do not affect that identity. `allowExamples` is only for displaying illustrative documents and must never be enabled for readiness.

The v1 scope language supports exact normalized repository-relative paths, terminal `/**` subtrees and the explicit full scope `**`. Other glob forms are refused. Argument vectors are data, without implicit shell expansion. Manifest validation is necessary but does not authorize commands or establish installation readiness.

`validateDecision` validates an explicit model-authored action and its canonical input digest. `validateAssignment` validates individually attributable task attempts and environment/receipt bindings. Callers pass authenticated current bindings through `expected`; they must independently enforce current authority, budgets, dependencies and receipt provenance. These functions create no grants, persist no decisions and never choose a task or fallback plan.

`parseInterfaces` validates bounded delivered blocks while preserving the eight catalogue fields. Parsing a raw fragment does not prove membership or compatibility. A trusted installation plan must bind its digest, source and catalogue provenance.

`createInterfaceIndex` creates small in-memory catalogues. For large inputs, `buildInterfaceIndex` ingests byte chunks and writes blocks through an `InterfaceStore`; `createDirectoryInterfaceStore` supplies an owner-only filesystem implementation. The builder retains membership metadata, rather than the complete catalogue body. Its in-memory fallback refuses catalogues above 8 MiB. Build into a fresh unpublished store and publish its header only after construction succeeds.

`selectInterfaces` reads only requested IDs and their declared closure through `fetchEntry`. It verifies every block's digest and Merkle inclusion against the pinned publication, source and provenance, then enforces byte/block limits and consumer block expectations. Publication headers must come from authenticated trusted state: a self-consistent malicious header is not authorization. `coverage = DECLARED_CLOSURE` and `compatibility = UNVERIFIED` are deliberate; signatures and caller inventories do not establish behavioral compatibility or complete dependency discovery.

The focused executable contract gate is `python3 tests/hyperfide/cases/source_control/0_10.py`. It qualifies this parser/index boundary only; it does not qualify live providers, model sessions or fleet readiness.

Private configuration targets (all secret references and modes other than `0444`) contain exactly one `{slot}` placeholder and expand strictly beneath each signed worker home. Private receipts identify only `{slot,worker_slot_id,target}` destinations, reference and version; they contain no secret values or secret hashes. Nonsecret `0444` configurations retain a shared absolute target without placeholders. Secret environment bindings use sorted configuration section names and consecutive `FLEET_CONFIG_0`, `FLEET_CONFIG_1` names; bindings carry references only.

`environment.image_digest` identifies the full runtime base image digest pinned by the accepted current pool profile (`manifest.profile.image.digest`); it is distinct from a preparation manifest hash. Admission and completion also require the exact profile runtime platform and current boot preparation binding. An unpinned image or an unresolved derived-image binding fails with an image-evidence error instead of deriving an image digest from a tag.

PREPARED receipts carry `probes: []`. Their `readiness-probes` stage has status `DEFERRED` and evidence over `{status:"DEFERRED_TO_NATIVE_READINESS",required_probes:[...]}`. Actual source probes execute only after the native UID handoff. Server READY responses carry separate per-slot native readiness witness digests; the immutable prepared report alone never grants readiness.
