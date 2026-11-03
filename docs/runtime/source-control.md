# Native source runtime package

The source runtime package contains the control service and migration catalog, Node runtime, source SDK, signed client, host materializer, virtual filesystem module, native CLI and native component executable. Its manifest records every shipped file and internal dependency link, plus the complete input inventory for the service, dependencies, binaries, linked libraries and transitive bundle sources. Assembly rejects inputs that change during the build and dependency links that escape their package. PostgreSQL, S3 storage and the operating system kernel remain deployment services.

## Build and verify

On the release builder, compile the current native and service inputs, then assemble the package:

```sh
make hyperfide hyperfide-native CFLAGS='-O2 -Werror'
npm --prefix core/control-plane run build
python3 deploy/hyperfide/source-control/package.py --node /path/to/node --output /path/to/empty-output
```

The Node version must match `core/control-plane/package.json`. The assembler checks service build stamps and native freshness, bundles the SDK and host modules using the existing workspace build tool, and copies the installed production dependency graph. It performs no package installation or remote publication. Repeating assembly against unchanged inputs produces identical archive bytes.

Run the packaged component profile with an owned PostgreSQL instance:

```sh
python3 tests/hyperfide/cases/source_control/7_1.py
```

The driver builds twice, compares the archives, extracts one, checks its complete inventory, and uses its Node, service, SDK, host modules and native executables. The profile starts the actual `bin/source-control` launcher and verifies migration upgrades preserve existing Git source rows. It exercises API-only source access, sparse materialization, a durable checkpoint, independently checked acceptance, and publication to a disposable local Git destination with independent content readback. `--package-only` performs the archive checks without starting PostgreSQL or source operations.

## Install and start

Extract `native-source-runtime.tar.gz` into a new immutable release directory. Verify its archive hash against `package-manifest.json` before selecting the directory for service startup. Keep the previous directory available until the current deployment and migration checks pass.

Provide the PostgreSQL connection, S3 settings, cursor key, workspace budgets and private listener configuration described in the [source service guide](../hyperfide/source-control.md). Apply the complete packaged migration catalog through the existing migration lifecycle, then run:

```sh
HF_SOURCE_CONTROL_CONFIG=/run/secrets/source-control.json /opt/hyperfide/source-runtime/bin/source-control
```

The listener configuration contains public token verification keys and TLS file references. Signing keys remain with the issuer. Source workers receiving native control-plane credentials use the signed endpoint and the private configuration installed through `HF_SOURCE_CONFIG`.

The SDK exports are available from `sdk/index.js`; `sdk/signed.js` exports `createSignedSourceClient`. The native command is `bin/hyperfide source invoke --request-file FILE`. Host modules under `host/` expose the bounded cache, workspace journal, sparse materializer and checkpoint adapter.

## Filesystem profile

The initial materializer uses Linux descriptor-relative paths. Virtual workspaces require the declared Linux FUSE profile, `/dev/fuse`, the necessary kernel capability and verified mount/unmount helpers. The package includes the available helper executables and their linked libraries; host discovery still checks actual kernel access before mounting. A host selects `SPARSE` or `MATERIALIZED` explicitly when virtual mounting is unavailable.

Dirty state belongs to the workspace journal and is retained independently from the immutable cache. Keep the exact workspace and operation identities when recovering interrupted checkpoints. Restore source metadata, object placement and retained roots together, and establish a fresh authority epoch before reopening writes.

## Release closure

Packaging and product acceptance have separate records. A complete release binds all canonical source cases and required backend/provider variants to the same source and policy inputs:

```sh
python3 tests/hyperfide/cases/source_control/6_3.py --packet /path/to/closure.json
python3 tests/hyperfide/cases/source_control/7_2.py --manifest /path/to/release.json
```

The closure reruns the canonical checker for every full-case receipt. The release gate checks artifact checksums and the operator acceptance record bound to that closure packet and source revision. Component receipts do not satisfy a full-case obligation.
