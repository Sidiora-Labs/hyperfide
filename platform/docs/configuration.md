# Hyperfide configuration

Use `hyperfide platform --help` and the relevant subcommand help for supported
flags. The public entry point is the repository's `hyperfide` binary:

```sh
hyperfide platform --help
hyperfide platform thread list
```

Runtime data belongs in `~/.hyperfide`. Platform configuration variables use the
`HYPERFIDE_` prefix. Select a separate data directory and unused ports when running
an isolated test instance. Keep credentials out of logs and issue reports; use
secret references when recording workflow evidence.

## Source development

Use Node 24 and pnpm 9.15. From the repository root:

```sh
pnpm -C platform install --frozen-lockfile
pnpm -C platform dev
```

The source app uses the server API and host daemon. Configure each host for the
repository paths it owns. A project source retains its host boundary; a client
connection does not make another machine's filesystem local.

## Workspaces

Repository setup and teardown scripts run on the execution host. Review scripts
before granting access to credentials or external resources. See
[worktrees](worktrees.md) for provisioning and cleanup contracts.

## Remote access

Clients connect to a server you operate. Use a trusted authenticated network and
restrict listeners to intended operators. Enroll only the host daemons that should
execute work for that server. See [system overview](system-overview.md).

## Reporting configuration problems

Include the Hyperfide version, operating system, launch command with secrets
removed, expected result, and observed error in
https://github.com/Sidiora-Labs/hyperfide/issues.
