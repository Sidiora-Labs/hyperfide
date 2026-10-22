#!/usr/bin/env bash
# measure-source-day.sh: one day of source traffic on a monorepo, as a JSON report.
#
# Contract: spec/hyperfide-v21 task 1.11 (req 6.5). Tasks 2.11, 5.4 and 5.6 read
# the report through docs/hyperfide/source-measurement.md; keep field names stable
# and bump "schema" if one changes meaning.
#
# Danger: clone samples download the whole remote once per sample and mode. On a
# multi-million-line repository that is real egress; size --samples accordingly.
# --maintenance runs git maintenance on the repository you pass (it mutates packs).
# Provider env values are used for the clone commands only and never written out.
set -euo pipefail

usage() {
  cat <<'EOF'
usage: measure-source-day.sh --repo PATH [options]

  --repo PATH            local clone of the monorepo (required; read-only unless --maintenance)
  --trunk REF            trunk ref whose history is measured (default: origin/HEAD, else HEAD)
  --since WHEN           window start, any git date (default: "24 hours ago")
  --until WHEN           window end (default: now)
  --provider NAME        provider the sandboxes run on (railway, local, ...) (default: local)
  --region NAME          provider region the clone samples are taken from
  --provider-env FILE    KEY=VALUE lines exported for clone commands (credentials, mirror URL)
  --remote URL           clone source for samples (default: the repo's origin URL)
  --clone-mode LIST      comma list of full,partial,sparse (default: full,partial)
  --samples N            clone samples per mode (default: 1; 0 disables cloning)
  --interval SECONDS     pause between sample rounds, to spread them over the day (default: 0)
  --events FILE          JSONL observed by sandboxes/provisioner, one object per line, with
                         "kind" in clone|push_refused|rate_limited|rebase_conflict|maintenance|snapshot
                         and optional "seconds", "bytes", "wait_seconds"
  --github OWNER/REPO    sample GitHub rate limits (needs GITHUB_TOKEN or gh auth)
  --maintenance          time `git maintenance run` on --repo (mutates it)
  --no-conflict-replay   skip replaying each trunk merge through git merge-tree
  --out FILE             report path (default: stdout)
  -h, --help             this text
EOF
}

die() { printf 'measure-source-day: %s\n' "$*" >&2; exit 2; }

REPO="" TRUNK="" SINCE="24 hours ago" UNTIL="now" PROVIDER="local" REGION=""
PROVIDER_ENV="" REMOTE="" CLONE_MODES="full,partial" SAMPLES=1 INTERVAL=0
EVENTS="" GITHUB_REPO="" MAINT=0 REPLAY=1 OUT=""

while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="${2:-}"; shift 2 ;;
    --trunk) TRUNK="${2:-}"; shift 2 ;;
    --since) SINCE="${2:-}"; shift 2 ;;
    --until) UNTIL="${2:-}"; shift 2 ;;
    --provider) PROVIDER="${2:-}"; shift 2 ;;
    --region) REGION="${2:-}"; shift 2 ;;
    --provider-env) PROVIDER_ENV="${2:-}"; shift 2 ;;
    --remote) REMOTE="${2:-}"; shift 2 ;;
    --clone-mode) CLONE_MODES="${2:-}"; shift 2 ;;
    --samples) SAMPLES="${2:-}"; shift 2 ;;
    --interval) INTERVAL="${2:-}"; shift 2 ;;
    --events) EVENTS="${2:-}"; shift 2 ;;
    --github) GITHUB_REPO="${2:-}"; shift 2 ;;
    --maintenance) MAINT=1; shift ;;
    --no-conflict-replay) REPLAY=0; shift ;;
    --out) OUT="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "unknown argument: $1" ;;
  esac
done

[ -n "$REPO" ] || { usage >&2; die "--repo is required"; }
git -C "$REPO" rev-parse --git-dir >/dev/null 2>&1 || die "not a git repository: $REPO"
case "$SAMPLES" in ''|*[!0-9]*) die "--samples must be a non-negative integer" ;; esac
case "$INTERVAL" in ''|*[!0-9]*) die "--interval must be a non-negative integer" ;; esac
[ -z "$EVENTS" ] || [ -r "$EVENTS" ] || die "events file not readable: $EVENTS"
[ -z "$PROVIDER_ENV" ] || [ -r "$PROVIDER_ENV" ] || die "provider env file not readable: $PROVIDER_ENV"
for m in $(printf '%s' "$CLONE_MODES" | tr ',' ' '); do
  case "$m" in full|partial|sparse) ;; *) die "unknown clone mode: $m" ;; esac
done

WORK="$(mktemp -d "${TMPDIR:-/tmp}/measure-source.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
NOTES="$WORK/notes"; : > "$NOTES"
note() { printf '%s\n' "$*" >> "$NOTES"; }

# ---------- helpers ----------
json_str() {
  printf '%s' "$1" | awk 'BEGIN{ORS=""} {
    gsub(/\\/,"\\\\"); gsub(/"/,"\\\""); gsub(/\t/,"\\t"); gsub(/\r/,"\\r");
    if (NR>1) printf "\\n"; printf "%s",$0 }' | { printf '"'; cat; printf '"'; }
}
json_num() { case "$1" in ''|null) printf 'null' ;; *) printf '%s' "$1" ;; esac; }

# Seconds with sub-second precision where date supports %N (GNU); whole seconds otherwise.
now_s() {
  local n; n="$(date +%s.%N 2>/dev/null || true)"
  case "$n" in *N*|'') date +%s ;; *) printf '%s' "$n" ;; esac
}
elapsed() { awk -v a="$1" -v b="$2" 'BEGIN{printf "%.3f", b-a}'; }

dir_bytes() {  # portable: du -k is POSIX, -b is not
  local k; k="$(du -sk "$1" 2>/dev/null | awk '{print $1}')"; printf '%s' "$(( ${k:-0} * 1024 ))"
}

# stdin: one number per line -> {"n":..,"p50":..,"p90":..,"max":..,"mean":..}
stats() {
  sort -n | awk '
    { v[NR]=$1; s+=$1 }
    END {
      if (NR==0) { printf "{\"n\":0,\"p50\":null,\"p90\":null,\"max\":null,\"mean\":null}"; exit }
      # nearest-rank: ceil(p*n)
      i50=int(NR*0.5); if (i50<NR*0.5) i50++; if (i50<1) i50=1
      i90=int(NR*0.9); if (i90<NR*0.9) i90++; if (i90<1) i90=1
      printf "{\"n\":%d,\"p50\":%s,\"p90\":%s,\"max\":%s,\"mean\":%.3f}", NR, v[i50], v[i90], v[NR], s/NR
    }'
}

# Flat-JSONL field extraction without jq: prints the value of key $1 per matching line.
jsonl_field() {
  awk -v key="$1" -v kind="$2" '
    function val(line, k,   re, m) {
      re = "\"" k "\"[ \t]*:[ \t]*"
      if (!match(line, re)) return ""
      m = substr(line, RSTART+RLENGTH)
      if (substr(m,1,1)=="\"") { m=substr(m,2); sub(/".*/,"",m); return m }
      sub(/[ \t]*[,}].*/,"",m); return m
    }
    { if (kind=="" || val($0,"kind")==kind) { x=val($0,key); if (x!="") print x } }' "$EVENTS"
}

# ---------- repository ----------
if [ -z "$TRUNK" ]; then
  if git -C "$REPO" rev-parse --verify -q refs/remotes/origin/HEAD >/dev/null; then TRUNK="origin/HEAD"; else TRUNK="HEAD"; fi
fi
git -C "$REPO" rev-parse --verify -q "$TRUNK^{commit}" >/dev/null || die "trunk ref not found: $TRUNK"
TRUNK_SHA="$(git -C "$REPO" rev-parse "$TRUNK^{commit}")"
ORIGIN_URL="$(git -C "$REPO" config --get remote.origin.url || true)"
[ -n "$REMOTE" ] || REMOTE="$ORIGIN_URL"
TRACKED_FILES="$(git -C "$REPO" ls-tree -r --name-only "$TRUNK_SHA" | wc -l | tr -d ' ')"
GIT_VERSION="$(git --version | awk '{print $3}')"

COUNT_OBJECTS="$(git -C "$REPO" count-objects -v | awk -F': ' '
  BEGIN{printf "{"} { gsub(/-/,"_",$1); printf "%s\"%s\":%s", (NR>1?",":""), $1, $2 } END{printf "}"}')"

# ---------- integration wait and conflicts (from trunk history) ----------
# Each first-parent merge in the window integrated the commits on its second side;
# wait = merge committer time - commit committer time. Rebased or squashed trunks
# leave no such trace: they are counted under non_merge_commits and need --events.
WAITS="$WORK/waits"; : > "$WAITS"
MERGES=0 NONMERGE=0 REPLAYED=0 CONFLICTED=0 REPLAY_SUPPORTED=1
# merge-tree --write-tree needs git >= 2.38
if [ "$REPLAY" = 1 ] && ! git -C "$REPO" merge-tree --write-tree "$TRUNK_SHA" "$TRUNK_SHA" >/dev/null 2>&1; then
  REPLAY_SUPPORTED=0; note "git $GIT_VERSION lacks merge-tree --write-tree; conflict replay skipped"
fi
while read -r sha ct parents; do
  [ -n "$sha" ] || continue
  set -- $parents
  if [ $# -lt 2 ]; then NONMERGE=$((NONMERGE+1)); continue; fi
  MERGES=$((MERGES+1))
  git -C "$REPO" log --format='%ct' "$1..$2" | awk -v m="$ct" '{print m-$1}' >> "$WAITS"
  if [ "$REPLAY" = 1 ] && [ "$REPLAY_SUPPORTED" = 1 ]; then
    REPLAYED=$((REPLAYED+1))
    rc=0; git -C "$REPO" merge-tree --write-tree --no-messages "$1" "$2" >/dev/null 2>&1 || rc=$?
    [ "$rc" = 1 ] && CONFLICTED=$((CONFLICTED+1))
  fi
done < <(git -C "$REPO" log --first-parent --since="$SINCE" --until="$UNTIL" --format='%H %ct %P' "$TRUNK_SHA")
HISTORY_WAIT="$(stats < "$WAITS")"

# ---------- provider env (names reported, values never) ----------
ENV_KEYS=""
load_provider_env() {
  [ -n "$PROVIDER_ENV" ] || return 0
  local line key
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|\#*) continue ;; esac
    line="${line#export }"; key="${line%%=*}"
    case "$key" in *[!A-Za-z0-9_]*|'') continue ;; esac
    export "$key=${line#*=}"
    ENV_KEYS="${ENV_KEYS:+$ENV_KEYS,}$(json_str "$key")"
  done < "$PROVIDER_ENV"
}

# ---------- clone samples ----------
CLONES="$WORK/clones"; : > "$CLONES"
clone_once() {  # mode round
  local mode="$1" dest="$WORK/clone-$1-$2" t0 t1 rc=0 err="$WORK/clone.err"
  local args=(clone --quiet --no-tags --single-branch)
  case "$mode" in
    partial) args+=(--filter=blob:none) ;;
    sparse)  args+=(--filter=blob:none --sparse) ;;
  esac
  t0="$(now_s)"
  ( load_provider_env; GIT_TERMINAL_PROMPT=0 git "${args[@]}" "$REMOTE" "$dest" ) 2>"$err" || rc=$?
  t1="$(now_s)"
  local pack=0 disk=0 files=0
  if [ "$rc" = 0 ]; then
    pack="$(dir_bytes "$dest/.git/objects")"; disk="$(dir_bytes "$dest")"
    files="$(git -C "$dest" ls-files | wc -l | tr -d ' ')"
  else
    note "clone $mode round $2 failed (exit $rc): $(head -c 300 "$err" | tr '\n' ' ')"
  fi
  printf '{"mode":"%s","round":%s,"ok":%s,"seconds":%s,"object_bytes":%s,"disk_bytes":%s,"checked_out_files":%s}\n' \
    "$mode" "$2" "$([ "$rc" = 0 ] && echo true || echo false)" "$(elapsed "$t0" "$t1")" "$pack" "$disk" "$files" >> "$CLONES"
  rm -rf "$dest"
}
load_provider_env  # populate ENV_KEYS in this shell for the report
if [ "$SAMPLES" -gt 0 ]; then
  [ -n "$REMOTE" ] || die "no clone source: pass --remote or give the repo an origin"
  r=1
  while [ "$r" -le "$SAMPLES" ]; do
    for m in $(printf '%s' "$CLONE_MODES" | tr ',' ' '); do clone_once "$m" "$r"; done
    [ "$r" -lt "$SAMPLES" ] && [ "$INTERVAL" -gt 0 ] && sleep "$INTERVAL"
    r=$((r+1))
  done
fi
clone_summary() {
  local first=1 m
  printf '{'
  for m in full partial sparse; do
    grep -q "\"mode\":\"$m\",.*\"ok\":true" "$CLONES" || continue
    [ $first = 1 ] || printf ','; first=0
    printf '"%s":{"seconds":%s,"object_bytes":%s}' "$m" \
      "$(grep "\"mode\":\"$m\",.*\"ok\":true" "$CLONES" | sed 's/.*"seconds":\([0-9.]*\).*/\1/' | stats)" \
      "$(grep "\"mode\":\"$m\",.*\"ok\":true" "$CLONES" | sed 's/.*"object_bytes":\([0-9]*\).*/\1/' | stats)"
  done
  printf '}'
}

# ---------- GitHub rate limits ----------
GH_SAMPLE='null'
if [ -n "$GITHUB_REPO" ]; then
  body=""
  if [ -n "${GITHUB_TOKEN:-}" ] && command -v curl >/dev/null; then
    body="$(curl -fsS -H "Authorization: Bearer $GITHUB_TOKEN" -H 'Accept: application/vnd.github+json' https://api.github.com/rate_limit 2>/dev/null || true)"
  elif command -v gh >/dev/null; then
    body="$(gh api rate_limit 2>/dev/null || true)"
  fi
  if [ -n "$body" ]; then
    # core and graphql blocks: limit, used, remaining, reset
    GH_SAMPLE="$(printf '%s' "$body" | tr -d '\n ' | awk -v now="$(date +%s)" '
      function blk(s, name,   i, r) { i=index(s,"\"" name "\":{"); if(!i) return "null"; r=substr(s,i+length(name)+3); sub(/}.*/,"}",r); return r }
      { printf "{\"sampled_at\":%d,\"core\":%s,\"graphql\":%s}", now, blk($0,"core"), blk($0,"graphql") }' 2>/dev/null || echo null)"
    [ -n "$GH_SAMPLE" ] || GH_SAMPLE=null
  else
    note "github rate limit not sampled: no GITHUB_TOKEN with curl and no authenticated gh"
  fi
fi

# ---------- events observed by sandboxes ----------
# null, not 0, when nothing was observed: zero refusals and "not measured" differ.
EV_LINES=0 EV_KINDS='{}' EV_CLONE_S='null' EV_CLONE_B='null' EV_WAIT='null'
EV_PUSH='null' EV_RATE='null' EV_REBASE='null' EV_MAINT='null'
if [ -n "$EVENTS" ]; then
  EV_LINES="$(grep -c . "$EVENTS" || true)"
  EV_KINDS="$(jsonl_field kind "" | sort | uniq -c | awk 'BEGIN{printf "{"} {printf "%s\"%s\":%d",(NR>1?",":""),$2,$1} END{printf "}"}')"
  EV_CLONE_S="$(jsonl_field seconds clone | stats)"
  EV_CLONE_B="$(jsonl_field bytes clone | stats)"
  EV_WAIT="$(jsonl_field wait_seconds snapshot | stats)"
  EV_MAINT="$(jsonl_field seconds maintenance | stats)"
  EV_PUSH="$(jsonl_field kind push_refused | wc -l | tr -d ' ')"
  EV_RATE="$(jsonl_field kind rate_limited | wc -l | tr -d ' ')"
  EV_REBASE="$(jsonl_field kind rebase_conflict | wc -l | tr -d ' ')"
fi

# ---------- maintenance ----------
# The tasks git's scheduled maintenance runs on a host, timed one by one so a task
# that cannot run (incremental-repack with no packs) does not hide the others.
MAINT_S='null' MAINT_OK='null' MAINT_TASKS='[]'
if [ "$MAINT" = 1 ]; then
  MAINT_OK=true; total=0; MAINT_TASKS='['
  for task in commit-graph loose-objects incremental-repack; do
    t0="$(now_s)"; ok=true
    git -C "$REPO" maintenance run --task="$task" >/dev/null 2>"$WORK/maint.err" || { ok=false; MAINT_OK=false; note "maintenance $task failed: $(head -c 300 "$WORK/maint.err" | tr '\n' ' ')"; }
    t1="$(now_s)"; s="$(elapsed "$t0" "$t1")"; total="$(awk -v a="$total" -v b="$s" 'BEGIN{printf "%.3f", a+b}')"
    [ "$MAINT_TASKS" = '[' ] || MAINT_TASKS="$MAINT_TASKS,"
    MAINT_TASKS="$MAINT_TASKS{\"task\":\"$task\",\"ok\":$ok,\"seconds\":$s}"
  done
  MAINT_TASKS="$MAINT_TASKS]"; MAINT_S="$total"
fi

# ---------- report ----------
{
  printf '{\n'
  printf '  "schema": "hyperfide.source-measurement/1",\n'
  printf '  "generated_at": %s,\n' "$(json_str "$(date -u +%Y-%m-%dT%H:%M:%SZ)")"
  printf '  "window": {"since": %s, "until": %s},\n' "$(json_str "$SINCE")" "$(json_str "$UNTIL")"
  printf '  "repo": {"path": %s, "trunk": %s, "trunk_sha": %s, "tracked_files": %s, "git_version": %s, "count_objects": %s},\n' \
    "$(json_str "$REPO")" "$(json_str "$TRUNK")" "$(json_str "$TRUNK_SHA")" "$TRACKED_FILES" "$(json_str "$GIT_VERSION")" "$COUNT_OBJECTS"
  printf '  "provider": {"name": %s, "region": %s, "env_keys": [%s]},\n' \
    "$(json_str "$PROVIDER")" "$( [ -n "$REGION" ] && json_str "$REGION" || printf null)" "$ENV_KEYS"
  printf '  "clone": {\n'
  printf '    "remote_is_github": %s,\n' "$(case "$REMOTE" in *github.com*) echo true ;; *) echo false ;; esac)"
  printf '    "samples": [%s],\n' "$(paste -sd, "$CLONES")"
  printf '    "sampled": %s,\n' "$(clone_summary)"
  printf '    "observed": {"seconds": %s, "bytes": %s}\n' "$EV_CLONE_S" "$EV_CLONE_B"
  printf '  },\n'
  printf '  "integration": {"first_parent_merges": %s, "non_merge_commits": %s, "history_wait_seconds": %s, "observed_wait_seconds": %s},\n' \
    "$MERGES" "$NONMERGE" "$HISTORY_WAIT" "$EV_WAIT"
  printf '  "conflicts": {"merges_replayed": %s, "textual_conflicts": %s, "observed_rebase_conflicts": %s},\n' \
    "$REPLAYED" "$CONFLICTED" "$EV_REBASE"
  printf '  "github": {"repo": %s, "rate_limit": %s, "observed_push_refusals": %s, "observed_rate_limited": %s},\n' \
    "$( [ -n "$GITHUB_REPO" ] && json_str "$GITHUB_REPO" || printf null)" "$GH_SAMPLE" "$EV_PUSH" "$EV_RATE"
  printf '  "maintenance": {"ran": %s, "ok": %s, "seconds": %s, "tasks": %s, "observed_seconds": %s},\n' \
    "$([ "$MAINT" = 1 ] && echo true || echo false)" "$MAINT_OK" "$(json_num "$MAINT_S")" "$MAINT_TASKS" "$EV_MAINT"
  printf '  "events": {"file": %s, "lines": %s, "by_kind": %s},\n' \
    "$( [ -n "$EVENTS" ] && json_str "$EVENTS" || printf null)" "$EV_LINES" "$EV_KINDS"
  printf '  "notes": ['
  first=1; while IFS= read -r n; do [ $first = 1 ] || printf ', '; first=0; json_str "$n"; done < "$NOTES"
  printf ']\n}\n'
} > "$WORK/report.json"

if [ -n "$OUT" ]; then cp "$WORK/report.json" "$OUT"; else cat "$WORK/report.json"; fi
