---
kind: instruction
title: hyperfide-platform Guide — Machines
summary: Command reference for listing and targeting execution machines.
intent: Explain execution-machine discovery and selection from the CLI.
editingNotes: Keep the user-facing noun machine; internal APIs and types use Host.
---

Machine commands

A host is an identity and daemon connection. A machine is a host with a
provider-owned lifecycle. The local host has no machine provider. Every other
host is a machine, including existing machines enrolled with the built-in
`manual` provider (Manual machine setup). Add machines under Settings → Machines
or from the composer machine picker.

One machine runs the hyperfide-platform server. It stores threads, the database, and settings,
and every other machine and app connects to it. Settings → Machines badges it
`server` once there are several persistent machines, and `hyperfide-platform machine list` shows
`server` in its Role column. Keep the server machine on: while it is asleep or
off, nothing can reach hyperfide-platform and running threads may stop. The server machine
cannot be removed.

The server listens on loopback by default. Remote execution machines need
a server access provider: paired hyperfide-platform Connect, or a configured direct URL reachable
from the target, such as a private Tailscale Serve URL. A configured URL alone
does not prove reachability.

  hyperfide-platform machine list                         List persistent machines with role, ID, type,
                                          connection status, and relative last-seen time
    --all                                 Include disposable provider sandboxes
    --json                                Print the raw host list
  hyperfide-platform machine providers                    List installed machine providers
    --json                                Include inputs schemas and policy
  hyperfide-platform machine create --provider <id>       Create a standalone machine
    --key <idempotency-key>               Reuse this creation on retries
    --inputs <JSON>                       Non-secret provider inputs
    --no-wait                             Return the creating host ID immediately
    --json                                Print the created machine as JSON
  hyperfide-platform machine enroll --bootstrap-file <path>
    --bootstrap-env <NAME>                Alternative private bundle source
  hyperfide-platform machine show <id-or-name>            Show machine details
  hyperfide-platform machine rename <id-or-name> <name>   Rename a machine
  hyperfide-platform machine retry-update <id-or-name>    Retry a pending daemon update now
  hyperfide-platform machine reconcile <id-or-name>       Reconcile compute with core’s recorded state
  hyperfide-platform machine suspend <id-or-name>         Suspend a provider-managed machine
  hyperfide-platform machine resume <id-or-name>          Resume a machine (already active is a no-op)
  hyperfide-platform machine retry-cleanup <id-or-name>   Retry failed teardown now
  hyperfide-platform machine remove <id-or-name> [--yes]  Revoke and remove a machine
    --force                               Finish removing a disconnected machine whose
                                          environment cleanup failed; the provider's
                                          removal still runs
  hyperfide-platform machine provider-cli status <machine>
  hyperfide-platform machine provider-cli install <machine> <provider-id>
    --action <install|update>

`hyperfide-platform machine show` includes `threadStorageRootPath` from the latest daemon
session without waking the machine (null before the first session).
`hyperfide-platform machine list --json` includes lifecycle phase, progress, and any suspension
or resume error.

Each machine has a permission limit: the highest permission mode any thread on
that machine can run with. The default is Full Access. A thread that asks for
more resolves down to the limit, and a provider that supports no mode under the
limit cannot run there. Set it in Settings → Machines → the machine → Permission
limit. There is no CLI or SDK command to set it, and a paired machine cannot set
it for any machine, so a sandbox machine can stay at Full Access while your
laptop stays lower. `hyperfide-platform machine list --json` and `hyperfide-platform machine show` report the
current limit.

Standalone create does not create a thread or workspace. Omit inputs to use the
provider defaults; supply JSON when its schema requires additional values. Omit
`--key` to let the server generate one, or supply a stable key for retries.
Creation is durable: `--no-wait` returns the creating host ID immediately;
otherwise the CLI polls that host until active. SIGINT stops following and
exits 130 while creation continues. `hyperfide-platform machine list` includes machines still
being created. Use `hyperfide-platform machine show <host-id>` to inspect progress and
`hyperfide-platform machine remove <host-id>` to cancel and clean up. The SDK provides
`hosts.experimental_create`; pass `wait: false` to receive the creating host and
poll it with `hosts.get`. Aborting a caller signal never cancels the server
operation. A connected daemon does not yet imply an agent-ready checkout and
authenticated provider: thread startup does not install or update agent CLIs or
probe authentication, so use `hyperfide-platform machine provider-cli` for that.

Suspend and resume are available only when the machine provider implements
both operations. Suspending interrupts active turns and closes terminals before
saving; interrupted turns are never reported successful, so submit a new turn
after restore. `hyperfide-platform machine suspend` polls until the machine is paused, and
`hyperfide-platform machine resume` waits for the provider restore; resume does not rerun
environment setup. `hyperfide-platform machine reconcile` / `hosts.experimental_reconcile` is an
explicit request, not a timer: for a machine core records as suspended, it runs
the provider's save-and-stop operation, and the CLI polls until completion.
Active machines and lifecycle operations already in progress are left alone.
Retry cleanup is accepted only for a retiring machine whose provider teardown
failed. `hyperfide-platform machine remove --force` / `hosts.delete({ hostId, force: true })`
finishes removing a persistent machine that is disconnected and whose
environment cleanup failed, for example because the computer no longer exists:
it marks the machine's environments destroyed without running their teardown on
the machine (files stay on its disk), then runs the provider's removal and
revokes the machine. It is refused (409) while the machine is connected,
before teardown has failed, or when no environment cleanup is blocking removal;
use retry cleanup then.

Machines installed from Settings run as launchd or systemd services with
`--auto-update`: when the server is upgraded, each daemon updates its private
hyperfide-platform install to match and restarts. A daemon never downgrades. Use Settings →
Machines or `hyperfide-platform machine retry-update` to retry a failed update now. To opt out,
remove `--auto-update` from the launchd plist or systemd user unit and reload
that service; foreground `bb-app host-daemon` runs leave it off unless you pass
`--auto-update`.

Application logs rotate in `logs/server.N.log` and `logs/host-daemon.N.log`
under the selected data directory. Startup errors, crashes, and other output
that bypasses the logger are appended to `logs/server-stdio.log` and
`logs/host-daemon-stdio.log`; a file over 10 MB is renamed to `-stdio.1.log`
when its service starts. Follow them with `tail -F`.

Updates commands

One consolidated view of hyperfide-platform and provider CLI updates across machines — the
CLI counterpart of Settings → Updates.

  hyperfide-platform updates [status]                     Show bb-app and provider CLI update status for
                                          every persistent machine
    --machine <id-or-name>                Limit to one machine (including a sandbox)
    --json                                Print the aggregate as JSON
  hyperfide-platform updates apply                        Run every available provider CLI install/update,
                                          one at a time
    --machine <id-or-name>                Limit to one machine
    --json                                Print per-target results as JSON
  hyperfide-platform updates app [status]                 Show whether hyperfide-platform can update itself, the available
                                          version, and the last result
    --json                                Print the status as JSON
  hyperfide-platform updates app apply                    Download the update and restart hyperfide-platform into it
    --yes                                 Interrupt running threads without asking
    --no-wait                             Return once the update starts
    --json                                Print the final status as JSON
  hyperfide-platform updates app dismiss                  Mark the last update result as seen

`hyperfide-platform updates app apply` also updates a server hosted by the desktop app, restarting
that hosting app through its native updater. It never updates the desktop you
are viewing from unless that desktop hosts this server.

`hyperfide-platform updates apply` covers provider CLIs only. `hyperfide-platform updates app apply` updates
hyperfide-platform itself when it was started from `npx bb-app` (or a global `bb-app`) without
`--no-in-app-updates`: it installs the new version next to the running one and
restarts into it. It does not roll back if the new version fails to start.
Desktop users update through the desktop app's relaunch, and `bb-server` cannot
update itself. Connected daemons follow the server version automatically.

Targeting machines

For source installs, `hyperfide-platform updates` shows the checkout commit and explains manual
Git updates when no update shim is running. It does not compare that checkout
with npm releases. Failed or unavailable release checks show “Latest unknown”;
“Up to date” requires a successful check.

Machine selectors accept either an exact machine ID or an unambiguous machine
name. `--host` is an alias for `--machine`.

  hyperfide-platform thread spawn --project <id> --machine <id-or-name> --prompt "..."
  hyperfide-platform thread spawn --project <id> --new-machine <provider-id> --prompt "..."
    --machine-inputs <json>
  hyperfide-platform project create --name "..." --root <path> --machine <id-or-name>
  hyperfide-platform project source add <projectId> --machine <id-or-name> --path <path>

For thread spawning, machine targeting works with an unmanaged workspace path,
a new managed worktree, or the personal workspace. Do not combine it with an
existing environment ID: the reused environment already selects its machine.
`--new-machine` creates through a machine provider and always needs an explicit
`--environment-provider <id>`; machine providers do not choose an environment.
Use `--environment-inputs <json>` for workspace configuration, separately from
`--machine-inputs <json>`. Machine inputs are persisted and readable by
plugins; never put secrets there. Store credentials in plugin settings and pass
only non-secret configuration or references.

An environment provider that composes its own machine, such as
`modal-sandbox`, chooses that machine:
`hyperfide-platform thread spawn --project <id> --environment-provider modal-sandbox --prompt "..."`
creates the machine, prepares the project checkout, and runs environment setup.
Machine selectors are refused, and `--machine-inputs <json>` configures the
machine (for example `{"preset":"Large","image":"Node 22"}`). Progress and
failures appear in the thread's provisioning details; if cloning fails, the
machine remains available for retry or explicit removal.

When `--new-machine` or a composed provider needs a project checkout, core
clones the project's Git remote and registers a source on the new machine
before creating the environment. Existing sources are reused, and a completed
checkout whose remote matches is registered instead of cloned again; a
conflicting target is refused. hyperfide-platform owns a checkout it cloned (here or with
`project source add --clone`), so environments in it run `.hyperfide-env-setup.sh`
and `.hyperfide-env-teardown.sh`. The project needs a Git remote and the machine needs
Git access to it. Choosing Personal workspace does not clone a project.
Standalone `hyperfide-platform machine create` does not set up a project source and remains
available until explicitly removed. Machines created for threads retire after
their last live thread is archived when the provider declares them ephemeral.

For project creation and sources, `--root`/`--path` refers to a path on the
selected connected machine. Omit the selector to keep the existing local CLI
machine fallback (normally the server machine). Pass `--clone` to source add
instead of `--path` to clone the project's Git remote there; `--remote-url` and
`--target-path` optionally override the clone inputs.

## Server access





## Move the server

Moving the server is experimental and off by default. Turn on the `serverMove`
experiment in Settings → Experiments or with
`hyperfide-platform settings experiment serverMove true`; until then Settings → Machines hides
Move server here, and `hyperfide-platform server move`, `hyperfide-platform server export`, and deleting an old
server copy from the server are refused with `server_move_experiment_disabled`.

Agents must not move a server, abandon a move, or unlock an old copy without
the user's explicit confirmation in the conversation. Run `--check`, show the
user the checklist, and wait for their confirmation; don't pass `--yes` to skip
the confirmation on their behalf.

A move copies the server's data (database, settings, plugin data, attachments)
to another persistent machine, points every machine and app at it, and keeps the
old computer running as a regular machine. Worktrees, thread storage, and
checkouts stay on the machines that own them.

  hyperfide-platform server move --to <id-or-name>        Stop all work and move the server
    --check                               Print the checklist and stop
    --address <url>                       New server address (direct setups)
    --archive-existing-data               Move hyperfide-platform server data on the target aside
    --yes                                 Skip the confirmation
    --json                                Print the final move status
  hyperfide-platform server move status                   Show the steps, or the last move
  hyperfide-platform server move cancel                   Cancel before the switch starts
    --yes                                 Abandon a move that needs recovery without asking
  hyperfide-platform server export --out <file>           Export a running server
  hyperfide-platform server import <file>                 Install an export on this computer
    --data-dir <dir>                      Target data directory
  hyperfide-platform server unlock                        Let this computer's old copy start again
    --force                               Skip the new-server health check
  hyperfide-platform server allow-connect                 Turn hyperfide-platform connect and hyperfide-platform account on for an imported copy
  hyperfide-platform server delete-old-copy               Delete the old copy a move left here
  hyperfide-platform server install-machine-service       Keep this computer connected after a move

`--check` exits nonzero while a blocker remains. With hyperfide-platform connect, machines and
apps keep the same URL. A direct-address server needs `--address`: the URL every
machine and app will use to reach the new server. Existing hyperfide-platform server data on the
target is archived to `<dir>.before-move-<date>` only with
`--archive-existing-data`; it is never merged. SIGINT stops following while the
move continues. Failure or cancellation before the switch leaves the server
where it was. The SDK equivalents are `sdk.experimental_server.checkMove`,
`startMove`, `moveStatus`, `cancelMove`, and `export`.

`hyperfide-platform server move` exits 0 once moved and 1 when the move fails or is cancelled.
When the target never confirms that it took over, the move waits in
`recovery_required`: the old server stays up and read-only, and hyperfide-platform finishes the
move on its own once the target answers. `hyperfide-platform server move` and
`hyperfide-platform server move status` exit 2 in that state and name the exits:
`hyperfide-platform server move cancel` abandons the move and keeps the server here (it asks
first, since abandoning while the target took over leaves two servers; `--yes`
skips the question), and `hyperfide-platform server unlock` recovers an old copy that stopped.

`hyperfide-platform server export` writes a gzip archive to a 0600 file. The archive is not
encrypted and holds the server's credentials and plugin secrets, so keep it
private. `hyperfide-platform server import` works offline: it refuses a data directory that has
`bb.db` or a running hyperfide-platform and an export made by a newer hyperfide-platform or with the
`serverMove` experiment off. Rerunning an interrupted import rolls it back
first (`--json` reports `rolledBackInterruptedImport: true`). An imported
server starts with hyperfide-platform connect and hyperfide-platform account off so it can't take the original
server's tunnel or account; stop the original server, then run
`hyperfide-platform server allow-connect` to turn them on at the next start.

After a move, hyperfide-platform on the old computer refuses to start the old server and runs as
a regular machine. `hyperfide-platform server delete-old-copy` deletes the server files left
behind and keeps that lock. The desktop app installs the persistent machine
service itself; after a move from `bb-app`, or to retry, run
`hyperfide-platform server install-machine-service` (macOS and Linux; needs Node.js 22.19 or
newer on the PATH). `hyperfide-platform server unlock` is a last resort: everything since the
move is lost on that copy, it refuses while the new server still answers unless
`--force` is passed, and it refuses while the machine service is installed.
`unlock`, `delete-old-copy`, `allow-connect`, and `install-machine-service`
act on `HYPERFIDE_DATA_DIR` or `~/.hyperfide` unless `--data-dir <dir>` is passed.

## Local daemon lifecycle

Reconnect a disconnected machine whose server access or host key was revoked
or became stale, without changing its BB host ID:

  hyperfide-platform machine reconnect <id-or-name>       Print a short-lived reconnect command and wait for reconnection
                                          (refused for a connected machine)
    --json                                Print the command and expiry without waiting

Run the printed command on the affected machine; if it fails, run it again. The
machine re-enrolls with a new host key and server access and restarts its
daemon service. Environments, workspaces, and thread associations are kept. The
command reuses the data directory the daemon last reported (an explicit
`HYPERFIDE_DATA_DIR` takes precedence) and refuses a directory that does not hold this
machine. The server's own machine cannot be reconnected this way.

`install-machine.sh --start|--stop|--uninstall --host-id <id>` starts, stops, or
removes an owned local installation; optional `--server-url <url>` and
`--data-dir <path>` (or `HYPERFIDE_DATA_DIR`) assert the expected installation, and a
mismatch refuses the operation. Stop and uninstall succeed when no matching
installation exists; start requires one. They refuse the default BB data
directory. `install-machine.sh --adopt --data-dir <path>` installs the service
for a directory that is already enrolled. These are local primitives:
`hyperfide-platform machine remove` asks the server to remove the provider resource, and
`hyperfide-platform machine suspend` invokes provider suspension.

## Enroll a preinstalled machine

`hyperfide-platform machine enroll --bootstrap-file <path>` or `hyperfide-platform machine enroll --bootstrap-env <NAME>` consumes a private enrollment bundle prepared by core. Supply exactly one source. The environment variable is removed from the CLI process after reading it; files remain under the caller's ownership. Neither command prints the bundle or credentials.

The CLI refuses another host or server identity in the selected machine directory. Repeating enrollment with the same persisted identity succeeds, including after the original bundle expired. Machine data defaults to `~/.hyperfide-machines/<server-host>`; `HYPERFIDE_DATA_DIR` can select another isolated machine directory, but enrollment refuses the default `~/.hyperfide` directory unless its `host-id` already names this machine.

The installer accepts `--bootstrap-env <NAME>` and installs a private CLI at `~/.local/bin/bb` without replacing an existing path; non-login transports can use `command -v hyperfide-platform` with `~/.local/bin/bb` as a fallback. On a systemd host whose user bus is unreachable, installation fails before enrolling; containers and machines without systemd as init run a detached daemon. `HYPERFIDE_INSTALL_SKIP_SERVICE=1` leaves a detached daemon that does not start after reboot.

## Existing machines

`hyperfide-platform machine create --provider manual` waits for a private enrollment command,
prints it once with its expiry, and follows the host until the daemon connects.
Run that command on the target machine; it installs hyperfide-platform if needed. The CLI
prints a command for macOS and Linux and a PowerShell command for Windows.
Treat it as a credential. It cannot be renewed and does not survive a server
restart: after it expires, remove the machine and create it again (the app
offers Generate new command). Server access is resolved through the selected
default access provider. `--no-wait` returns the creating host ID.

On Windows, the command installs under
`%USERPROFILE%\.bb-machines\<server-host>`, starts the daemon at sign-in, and
needs Node.js 22.19 or newer on PATH. Manage it with
`node <machine-dir>\install-machine-windows.mjs --stop|--start|--uninstall --host-id <id>`.

Use `hyperfide-platform machine show <host-id>` to recover progress and
`hyperfide-platform machine remove <host-id>` to cancel and revoke enrollment/access. Stopping
the CLI or closing the dialog only stops following; creation continues.
Manual machines never idle-suspend or automatically retire and do not expose
suspend/resume. Removing one revokes its server access without executing on the
machine. Run the original installer with `--uninstall --host-id <host-id>` on that box, with its
original `HYPERFIDE_DATA_DIR` if explicitly configured, to remove its installation.

## Machine environment

  hyperfide-platform machine env list [--project <id>] [--json]
  hyperfide-platform machine env set NAME [--project <id>] [--note text] [--json]
  hyperfide-platform machine env unset NAME [--project <id>] [--json]

`set` reads the value from stdin, removing one trailing newline; values are
never accepted in argv and never returned by list or set. List masks all values,
includes built-in GitHub health, and for project scope includes inherited
global rows. Set and unset update one variable atomically. SDK:
`system.machineEnvironment()` and `system.replaceMachineEnvironment({ variables })`;
replacement is atomic, so pass every row to retain, using `value: null` for an
unchanged saved secret. Settings → Environment variables (and Project settings →
Advanced settings for one project) edits the same variables; saved secrets can be
replaced but never revealed.

Omit `--project` for global variables. Project overrides follow the project
across machines and worktrees, including the primary host, and override global
values. Empty strings override; unset restores inheritance. User variables
override built-in values on every connected host; agent-provider variables win
over them for agent turns. All values are encrypted at rest.

Changes apply to the next agent turn, new terminals and commands (including git
and gh operations), and repository setup, which receives freshly resolved values
on each run. Existing processes, terminals, and cached provider runtimes keep
their launch environment until recreated. Removing an override restores the
daemon's original value. Runtime output is forwarded as-is, so commands and
providers can print these values.

The server's gh login provides GitHub credentials, Git HTTPS and SSH access,
and commit identity to non-primary hosts. The primary host uses its local Git
authentication unless a user supplies an explicit global or project GH_TOKEN.
The built-in GH_TOKEN row reports logged in, not logged in, or overridden; a
custom GH_TOKEN overrides it. No credentials are installed in images or global
Git config. `hyperfide-platform settings general machineGitCredentialsEnabled false` (the
automatic GH_TOKEN switch in Settings → Environment variables) stops forwarding
the server's gh credentials; `true` enables it again. This does not log the
server out or suppress an explicit custom GH_TOKEN.
