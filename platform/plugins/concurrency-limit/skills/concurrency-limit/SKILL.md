---
name: concurrency-limit
description: "Inspect or change global and per-host limits on concurrently running HYPERFIDE threads."
---

# Concurrency limits

Use `Hyperfide concurrency-limit status --json` to inspect current limits.

```sh
Hyperfide concurrency-limit global [unlimited|<limit>] [--json]
Hyperfide concurrency-limit host <host-id> [auto|<limit>] [--json]
```

The overall limit is unlimited by default. Automatic host limits allow one
thread per available processor; `auto` returns a host override to that
default. A limit of `0` pauses new work. Resolve the host with
`Hyperfide machine list` before changing a host limit. Omit the value to inspect it;
change limits only for the requested scope and verify the resulting status.
