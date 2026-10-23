# Board

`mountBoard(element, model, rpc)` mounts the Board app view and returns its cleanup
function. `BoardController` and the render functions are also available for app
hosts with their own rendering lifecycle. A successful action reloads the tasks
before rendering. The host supplies the initial model and transports `BoardRpc`
to `createBoardServer` in the server process; repository and binary paths are
server configuration. The app module has no Node imports.

The package manifest registers `plugin-app.ts`, `plugin-server.ts` and `host.ts`.
The Board navigation panel loads the selected host, repository and feature through
SDK RPC. The server routes reads and actions to that host, where `SpecReader`
loads the real shared model. The host finds the latest receipt in the repository's
task artifacts. Receipt URLs are relative to the repository;
only HTTP(S) and relative paths are rendered as links. A missing requirement
blocks requires-satisfied just as an unfinished requirement does.

The task verification runs the canonical identity gate directly.
