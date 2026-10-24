# Board

`mountBoard(element, model, rpc)` mounts the Board app view and returns its cleanup
function. `BoardController` and the render functions are also available for app
hosts with their own rendering lifecycle. A successful action reloads the tasks
before rendering. The host supplies the initial model and transports `BoardRpc`
to `createBoardServer` in the server process; repository and binary paths are
server configuration. The app module has no Node imports.

The package manifest registers `plugin-app.ts`; the shared
`read-model-server.ts` entry registers the read model and board RPC routes.
The Board navigation panel (`views/board-panel.tsx`, with `task-row.tsx` and
`task-detail.tsx`) is a React view on the platform's shared resource kit: a
scope panel for repository and feature, a toolbar with search and owner,
status and requirement filters, one list section per wave, and a task detail
page with the same Start / Implemented actions. It loads the selected
repository and feature through SDK RPC. The server accepts repositories configured for the read model and runs
reads, actions, storage and memory access in the platform server process.
No host process is required. The server finds the latest receipt in the repository's
task artifacts. Receipt URLs are relative to the repository;
only HTTP(S) and relative paths are rendered as links. A missing requirement
blocks requires-satisfied just as an unfinished requirement does.

The task verification runs the canonical identity gate directly.
