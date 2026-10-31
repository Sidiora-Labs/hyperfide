# Fleet

`app.tsx` registers the Fleet navigation panel. It reads `fleetLedger` through
the plugin RPC, refreshes every five seconds, and applies `fleetAction` responses
after mutations. Log output is rendered as text and limited to its last 16,384 characters.
Budget keys are a count, never credentials.

The dispatcher supplies `FleetBackend` to `registerFleetRpc(api, backend)` in its
server setup (or uses `createFleetPlugin(backend)`). `readLedger` returns the
structural read model defined by `ledgerSchema`; timestamps are UTC ISO strings.
The backend owns ledger persistence, cancellation, destruction, pause state and
cap enforcement during dispatch. No provider or runner is called by this view.
Cap commands are serialized and clamped between the current cap and configured
maximum before being sent to the backend. Action errors preserve the displayed
ledger and appear in an alert.

The fixture ledger and SDK app harness tests exercise this boundary without
network services. The dispatcher is a separately owned prerequisite; its setup
can attach this RPC without changing the component or its contract.
