# Task 0.6 permission Ask

Kind: permission

Ask: 1 (open)

May task 0.6 update `platform/apps/desktop/src/desktop-update-provider.ts`,
`platform/apps/desktop/scripts/desktop-release-channel.mjs`, and
`platform/apps/desktop/test/electron-builder-config.test.ts` to use the required
`Sidiora-Labs/hyperfide` desktop update repository consistently?

Options:
- Approve these supporting desktop update-feed edits (recommended).
- Keep the existing runtime feed and defer repository correction.

Blocked: correcting the runtime update feed and its contract test outside the
declared touches. Desktop tests currently report one URL contract failure.

Finished: removed the deleted rename-map dependency, ran the canonical identity
gate with zero hits, added direct identity contract checks, preserved native and
PWA manifest/icon checks, and corrected the owned desktop packaging feed URL.
The full platform build and desktop typecheck/build pass; `bash
tests/hyperfide/cases/v22/0_6.sh` exits zero.
