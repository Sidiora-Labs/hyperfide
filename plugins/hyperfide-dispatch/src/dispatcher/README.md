# Dispatcher

Construct `Dispatcher` with the plugin data directory, then call `start()` before
`tick()`. One process owns a data directory. Serialize external ownership of this
directory; starting a second dispatcher is a restart and interrupts existing jobs.
`tick()` reserves slots, claims eligible tasks and starts jobs; `drain()` awaits
current jobs. The host calls `tick()` periodically, including after backoff expires.

`specSource()` binds the spec plugin's `SpecRpc` read model and canonical
`taskPacket()` formatter to a feature. Supply integration ownership operations
for atomic claims and merged membership. `merged(task, tip)` must check integration
membership, independently of a task's declared status. Claims must be atomic across
workers and release must compare the job token. `integration()` returns a bundle
containing its tip; checkpoints contain a repository at `/workspace`. Preparation
fetches that bundle, checks out the tip and runs the supplied prepare command.

Inject the concurrency-limit snapshot through `limits()`: global and host limits
include zero, and `otherRunning` counts global usage outside this dispatcher. Key
IDs are persisted; key values are passed only to runners. Supply gateway keys and
MCP configuration through host configuration. Production command runners require
the corresponding CLI in the checkpoint; tests invoke neither CLI nor network.

Job and backoff records use the authority plugin's persistent storage. Startup destroys machines named
`hyperfide-dispatch-*` and machines referenced in ledgers, interrupts live ledgers,
and releases their claims. Failed jobs remain terminal after their one retry;
requeue policy belongs to the spec/claim adapter. Machine destruction failures are
recorded and startup retries cleanup. Keep the data directory across restarts.
