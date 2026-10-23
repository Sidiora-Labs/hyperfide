kind: permission

Question: Can the task commit be created with write access to this checkout's Git metadata?

Options:
- Recommended: Allow Git metadata writes and create the requested single commit.
- Leave the verified implementation uncommitted.

Blocked: Staging and committing task 0.1; Git cannot create .git/index.lock because .git is mounted read-only.

Finished anyway: Rename map, codemod, inventory README, fixture verification, and spec status implemented. bash tests/hyperfide/cases/v22/0_1.sh passes. No commit was created.
