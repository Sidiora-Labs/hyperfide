# Fleet control on Railway

Deploy this profile as one control-service replica with an allowlisted build context and `deploy/hyperfide/fleet-control/railway.json` as its config path. The Dockerfile builds the pinned independent control-plane package. Its Ubuntu 24.04 runtime matches the native artifacts' glibc ABI and includes the verified public Claude 2.1.300 runtime. Keep provider executors and engineering workers in their own services/sandboxes.

Railway terminates public TLS at its edge. The container accepts the edge's HTTP traffic on `PORT`, then forwards the signed request bytes to the existing TLS 1.3 control listener on loopback port 9443. It preserves duplicate proof headers so the normal authentication layer can reject them. The control listener verifies signatures against the fixed external HTTPS origin in its identity configuration. Clients use that same origin and the public certificate trust chain.

See Railway's [edge networking](https://docs.railway.com/networking/edge-networking) and [public request limits](https://docs.railway.com/networking/public-networking/specs-and-limits).

## Runtime inputs

Set these on the control service through sealed variables or its approved secret-management channel:

| Variable | Input |
|---|---|
| `HYPERFIDE_CONTROL_PRIMARY_DATABASE_URL` | Dedicated unprivileged control-role connection to the selected primary database. Apply the existing runtime grants separately. |
| `HYPERFIDE_DEPLOYMENT_ID` | Admitted deployment UUID. |
| `HYPERFIDE_AUTHORITY_JOURNAL_DIR` | Private persistent-volume path containing the accepted external authority journal. |
| `HYPERFIDE_CAUSAL_BARRIER_KEY` | Existing causal-barrier secret. |
| `HYPERFIDE_REQUIRE_SYNC_REPLICA` | Explicit `0` or `1` durability policy. |
| `HF_SERVICE_REQUEST_DEADLINE_MS` | `120000` for fleet reasoning calls. |
| `HYPERFIDE_FLEET_CONTROL_BOOTSTRAP_B64` | Canonical base64 of the trusted bootstrap JSON described below. |
| `HYPERFIDE_FLEET_CONTROL_BOOTSTRAP_SHA256` | `sha256:<hex>` digest of the decoded JSON bytes. |
| `RAILWAY_RUN_UID` | `0` for the fixed volume initializer; backend identity becomes 22001 before startup. |
| `HYPERFIDE_FLEET_CONTROL_SERVICE_ID` | Exact dedicated control-service UUID. |
| `HYPERFIDE_FLEET_CONTROL_VOLUME_NAME` | Exact dedicated control-volume name. |

The control service receives the gateway-model configuration and scoped configuration references selected by its deployment policy. Configure `HYPERFIDE_FLEET_MODEL_BACKEND=gateway`, its exact model, gateway endpoint, and sealed gateway credential where that backend is selected. Supply the accepted provider-pool, source, artifact, preparation, and executor-RPC profiles required by the chosen components.

Use the dedicated persistent volume at `/app/state`. The controller and native authentication probe run as unprivileged UID/GID 22001, matching the accepted profile's private home. Store the authority journal and required preparation state on that volume.

[Railway mounts volumes as root](https://docs.railway.com/volumes). Set `RAILWAY_RUN_UID=0` for this profile's fixed initializer. It checks the configured service ID, volume name and actual `/proc` mount, changes ownership of only the volume's root, clears supplementary groups and drops to UID/GID 22001 before reading bootstrap configuration or starting the backend. The image's default user is 22001. Set `HYPERFIDE_FLEET_CONTROL_SERVICE_ID` and `HYPERFIDE_FLEET_CONTROL_VOLUME_NAME` to the exact new resource bindings.

The initializer preserves a valid existing OS machine ID. If needed, it initializes the ID from the actual validated `RAILWAY_REPLICA_ID` and records that origin. `/app/state/container-startup.json` contains the observed post-drop identity and mount ownership. The backend repeats the UID/ownership checks before startup. The service process rejects migration credentials and migration-job mode.

## Bootstrap JSON

The bundle contains:

- `schema_version`: `1`.
- `generation`: an explicit immutable UUID chosen before encoding the bundle.
- `spec_revision`: the accepted policy's exact revision.
- `component_ids`: the required closed set of component IDs from the built control-plane registrations.
- `files`: a map from simple configuration filenames to canonical base64 file contents.

Required files are `control-policy.json`, `control-identity.json`, `control.crt`, `control.key`, and `tls-ca.crt`. Additional JSON or PEM configuration files can supply the approved component profiles. Paths inside those configurations refer to `/app/state/bootstrap/<generation-uuid>/<filename>` or the deployment's persistent state paths.

The identity configuration's `origin` is the assigned fixed public HTTPS origin. The internal certificate covers `control.local`; its private key must match, and `tls-ca.crt` trusts that internal listener. The public domain uses Railway's certificate independently. Materialized bootstrap files are mode `0600` in a private generation directory. Reusing a generation verifies its exact bundle digest and existing file bytes. Component selection resolves logical IDs from their actual registration files.

Build the bundle from the actual accepted policy, enrollment configuration and operator-owned certificates. Select component IDs from their registrations and include their dependency closure. Bootstrap and later provider-runner enrollment use the existing authenticated protocols.

## Authority-journal adoption

An optional `authority_adoption` object contains the actual `deployment_id` and a `document_file` filename from the pinned bundle's `files` map. Include the exact committed source journal as that file. The deployment ID must match `HYPERFIDE_DEPLOYMENT_ID`.

Before starting the control listener, the wrapper opens the private volume journal at `HYPERFIDE_AUTHORITY_JOURNAL_DIR` and calls the existing `FileExternalAuthorityJournal.adoptCommitted` with the actual primary's activation lookup. It then checks current external authority against the database. Adoption verifies the journal's complete history/digests and the current ACTIVE committed operation. Its receipt records the accepted epoch, sequence and evidence digest.

Choose a journal directory inside `/app/state` and outside its bootstrap-generation directories. Authority adoption uses the scoped control database connection and initializes the volume journal through that verified path.

## Build context

After the native artifacts are frozen and verified, create a fresh context with `prepare-context.mjs`. Supply `--output`, `--cli`, `--cli-sha256`, `--native`, `--native-sha256`, and `--runtime-home`. Artifact paths name only the two reviewed public ELF files; the digests must match their actual bytes. The runtime-home path must match the accepted native-auth profile, whose target UID is 22001.

The wrapper verifies the protected image-native manifest and actual packaged ELF before setting `HF_NATIVE_CONNECTOR_PLANNER_BINARY=/opt/hyperfide/bin/hyperfide-native` and its matching `HF_NATIVE_CONNECTOR_PLANNER_DIGEST`. Explicit values supplied by deployment configuration must match those bytes.

The helper copies the control-plane source closure and selected deployment files, adds only the pinned public native artifacts, and writes a source/artifact manifest. Deploy that resulting directory as the root. Worker homes, authentication files, `.env`, local dependency trees, and private build state are excluded.

## Deployment sequence

1. Select explicit project and environment IDs and create the dedicated control service.
2. Assign its public domain and pin that HTTPS origin into the accepted identity configuration and client configurations.
3. Provision the dedicated runtime DB role, apply reviewed grants, and initialize the deployment's accepted authority/journal state through the existing bootstrap workflow.
4. Attach the private state volume and set the scoped runtime variables and exact bootstrap bundle.
5. Deploy the exact reviewed source/image and observe its deployment status and `/healthz` response.
6. Perform an authenticated signed API invocation, then run the provider installation and worker journey against that same origin.

`/healthz` becomes ready after the actual control listener reports startup. Normal API requests use only `/v1/invoke` and `/v1/enroll`; credentials, source identities and environment generations are checked by the control service.
