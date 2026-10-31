#!/usr/bin/env sh
set -u

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)" || exit 1
workspace_root="$(CDPATH= cd -- "${script_dir}/../.." && pwd)" || exit 1
cd "${workspace_root}" || exit 1

log() {
  printf '%s\n' "[hyperfide-env-setup] $*"
}

run_step() {
  step_name="$1"
  shift
  log "Running: ${step_name}"
  if "$@"; then
    log "Completed: ${step_name}"
    return 0
  else
    exit_code=$?
    log "Warning: ${step_name} failed (exit ${exit_code}); continuing provisioning"
    return 1
  fi
}

# Hash of the inputs that decide what `pnpm install` would do. Stored inside
# node_modules so it travels with an installed tree (copy-on-write
# environments) and disappears with it (fresh worktrees).
INSTALL_STAMP="node_modules/.hyperfide-env-setup-install-hash"
INSTALL_INPUTS="pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc .pnpmfile.cjs"

install_input_paths() {
  for input in ${INSTALL_INPUTS}; do
    [ ! -f "${input}" ] || printf '%s\n' "${input}"
  done
  for category in apps core sdk contracts lib plugins tools tests examples examples/plugins tests/fixtures/plugins; do
    for input in "${category}"/*/package.json; do
      [ "${input}" != core/control-plane/package.json ] || continue
      [ ! -f "${input}" ] || printf '%s\n' "${input}"
    done
  done
  if [ -d patches ]; then
    find patches -type f -print
  fi
}

install_inputs_hash() {
  if command -v sha256sum >/dev/null 2>&1; then
    hash_cmd="sha256sum"
  elif command -v shasum >/dev/null 2>&1; then
    hash_cmd="shasum -a 256"
  else
    return 1
  fi
  install_input_paths | LC_ALL=C sort -u | while IFS= read -r input; do
    printf '%s\n' "${input}"
    ${hash_cmd} < "${input}"
  done | ${hash_cmd} | cut -d ' ' -f 1
}

if ! command -v pnpm >/dev/null 2>&1; then
  log "Warning: pnpm is not available; skipping install/build"
  exit 0
fi

if [ ! -f package.json ]; then
  log "Warning: package.json not found; skipping install/build"
  exit 0
fi

current_hash="$(install_inputs_hash 2>/dev/null || true)"

if [ -n "${current_hash}" ] && [ -f "${INSTALL_STAMP}" ] && [ -d node_modules/.pnpm ]; then
  if [ "$(cat "${INSTALL_STAMP}" 2>/dev/null)" = "${current_hash}" ]; then
    log "Skipping pnpm install: node_modules already matches the lockfile"
    exit 0
  fi
fi

if run_step "pnpm install" pnpm install && [ -n "${current_hash}" ]; then
  printf '%s\n' "${current_hash}" > "${INSTALL_STAMP}"
fi
exit 0
