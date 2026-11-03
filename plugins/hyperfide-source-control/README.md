# Native source control

This plugin adds a Source control navigation panel and the `hyperfide platform source` command family. Requests use the shared native source SDK and its signed transport. No repository clone is required.

## Connect projects

In the plugin settings, set **Native source projects** to an array of project bindings:

```json
[
  {
    "projectId": "project-id",
    "configFile": "/protected/source-client.json",
    "hostId": "enrolled-host-id",
    "hostConfigFile": "/protected/source-client.json",
    "revisions": [
      { "id": "sha256:<64 hexadecimal digits>", "label": "Accepted source" }
    ],
    "assignments": [
      { "id": "<assignment UUID>", "label": "Implement the accepted task" }
    ]
  }
]
```

The configuration file uses the signed source configuration from `@hyperfide/authority`: `schema_version`, `endpoint`, `scope`, `credential_id`, `ca_file`, and `key_file`. An assigned worker configuration may wrap those fields in `transport` and include its `assignment`. The plugin keeps credential files on the server; RPC responses expose project names, selected revision labels, and source receipts.

Project bindings are explicit and limited to 64 projects. Named revisions and assignments are bounded pickers; the source service checks every supplied identity and permission.

## Workflows

- **Workspace:** open an immutable base with explicit read/write paths, inspect current generations, edit a UTF-8 file, checkpoint it, and submit its assigned revision.
- **Changes:** read paginated history, compare revisions, merge source, inspect conflicts, apply a resolved workspace revision, and qualify or accept an independently checked candidate.
- **Host files:** check actual virtual filesystem capability, explicitly choose sparse/materialized/virtual mode, attach the workspace to its configured enrolled host, and checkpoint host edits. The host connection must name the same source principal/workspace authority.
- **Transfers:** inspect bounded part progress, verify completion, and cancel an incomplete object transfer; grant tokens are omitted from rendered receipts.
- **Publication:** request publication of an accepted revision, inspect its actual remote state, reconcile an uncertain operation, or cancel a queued publication.
- **Metrics:** inspect bounded operation counts and durations. Acknowledged content bytes measure successful logical checkpoint content, not network traffic. Two request slots remain available for cancellation and recovery. Attached hosts also report measured cache residency/counters, materialized bytes, dirty journal state, and virtual filesystem request counters.

Edits are local until a checkpoint receipt arrives. Mutations retain their operation and request in browser session storage until a definitive response; an uncertain request can be retried with the same identity or inspected by operation ID. Credential revocation and workspace generation changes remain service refusals.

Host file operations use the Environment slices plugin on the enrolled host. The Source control plugin checks the project binding and source authority, then calls the Environment slices public RPC with a project/workspace identity; the host attachment stays pinned to its configured host and source connection.

## CLI

```sh
hyperfide platform source --config /protected/source-client.json history <revision>
hyperfide platform source --config /protected/source-client.json open <revision> --read-path src --write-path src
hyperfide platform source --config /protected/source-client.json --operation-id <uuid> checkpoint <workspace> src/file.txt --file ./file.txt --base <revision> --workspace-generation 1 --scope-generation 1 --overlay-generation 1
```

`HF_SOURCE_CONFIG` supplies the configuration path when `--config` is omitted. Keep the original `--operation-id` on retry. Output is JSON; unknown outcomes exit 75. The text checkpoint command accepts regular UTF-8 files up to 64 KiB. Larger or binary transfers use the source SDK or native request command.

## Verification

`python3 tests/hyperfide/cases/source_control/4_3.py` runs product actions against owned PostgreSQL and the native source service. Chromium component journeys, responsive screenshots, and the signed CLI case run by default. `HF_SOURCE_BROWSER=0` or `HF_SOURCE_PRODUCT_CLI=0` narrows a local debugging run. The browser fixture uses the actual plugin panel and action adapter, with declared project metadata at the host boundary.

`HF_SOURCE_PRODUCT_CLI=1 python3 tests/hyperfide/cases/source_control/signed_transport.py` exercises the platform command registrar through the signed TLS service.
