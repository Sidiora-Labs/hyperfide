# Native mobile shell

Status: **2026-09-05: 12 partial/blocked**. See [the audit](../MAINTENANCE.md) and [per-recipe ledger](../validation-2026-09-05.json).

## Setup and entry points

The active native routes are a WebView shell plus device settings and pairing.
Core conversation/project/settings features run in that WebView: repeat their
core recipes there. Older README descriptions of standalone native thread
screens are not evidence that those routes still exist.

## Source

- `apps/mobile/src/screens/shell/RootNavigator.tsx`
- `apps/mobile/src/screens/settings/DeviceSettingsScreen.tsx`
- `apps/mobile/src/screens/settings/ServersScreen.tsx`
- `apps/mobile/app/+native-intent.tsx`
- `apps/mobile/package.json`

## Feature recipes

## Evidence and cleanup

Record each row and platform separately with the actual entry point, observed
state, persisted side effect, and evidence. Missing hardware/service access is
a prerequisite gap, not a pass. Stop only owned sessions/processes, restore
preferences, and remove only synthetic resources after evidence is preserved.
