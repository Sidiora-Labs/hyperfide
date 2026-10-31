Keep hyperfide platform from starting more agent threads than your machines can handle. When a limit is reached, new turns wait in line and start as soon as a running thread goes idle.

## What you get

- An automatic limit for each host: one running thread per available processor.
- A per-host override. Set a fixed number, or set it back to `auto`.
- An overall limit across all hosts, or `unlimited`.
- A Settings section that lists every host with its capacity, its automatic limit, and its effective limit.

## How it works

Before hyperfide platform sends a message to an idle thread, the plugin counts the threads that are running. If the count meets the limit for that host, or the overall limit, the message waits. The thread shows why it waits. A message to a thread that is already running is not held. When a thread goes idle, fails, or is archived, the plugin rechecks the line.

## For agents and scripts

Use the `hyperfide platform concurrency-limit` command:

- `hyperfide platform concurrency-limit status` shows the effective limits.
- `hyperfide platform concurrency-limit global unlimited|<limit>` sets the overall limit.
- `hyperfide platform concurrency-limit host <host-id> auto|<limit>` sets one host.

Add `--json` for machine-readable output. Limits go from 0 to 10000. A limit of 0 holds every new turn in that scope.
