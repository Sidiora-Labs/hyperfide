# Board

`mountBoard(element, model, rpc)` mounts the Board app view and returns its cleanup
function. `BoardController` and the render functions are also available for app
hosts with their own rendering lifecycle. A successful action reloads the tasks
before rendering. The host supplies the initial model and transports `BoardRpc`
to `createBoardServer` in the server process; repository and binary paths are
server configuration. The app module has no Node imports.

`read-model-projection.ts` is the local task 2.1 interface. Replace it with the
shared read model when that task merges. Receipt URLs come from the read model;
only HTTP(S) and relative paths are rendered as links. A missing requirement
blocks requires-satisfied just as an unfinished requirement does.

`identity_gate_projection.py` is the local task 0.7 gate. The task verification
prefers the canonical gate whenever it exists.
