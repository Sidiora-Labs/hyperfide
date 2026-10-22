#!/usr/bin/env bash
# Launch prompt policy (hyperfide-v21 4.3, req 4): every worker launch plan
# from the native connector component keeps native prompts disabled (Claude
# Code: --permission-mode dontAsk --permission-prompts none; Codex:
# approvalPolicy never) and injects the codify MCP server with the ask tools
# and the instruction rule of spec/workflow.kvx [loop] step_5. A sandboxed
# worker has nobody at its terminal, so a native prompt would hang unseen;
# without a codify binary to serve the Asks there is no launch at all.
. "$(dirname "$0")/../lib.sh"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

# The connector component lives in hyperfide-native, a separate executable
# (build/ of this checkout); a copy alone in the scratch directory has no
# codify binary beside it.
make -s -C "$ROOT" hyperfide-native >"$TMP/native.log" 2>&1 \
    || { cat "$TMP/native.log" >&2; fail "hyperfide-native build"; }
mkdir -p "$TMP/lone"
cp "$ROOT/build/hyperfide-native" "$TMP/lone/hyperfide-native"
NATIVE="$TMP/lone/hyperfide-native"

# Pinned stand-ins for the two CLIs: only `--version` is read at plan time.
mkdir -p "$TMP/bin" "$TMP/ws" "$TMP/home" "$TMP/tmpdir"
printf '#!/bin/sh\necho "2.1.300 (Claude Code)"\n' > "$TMP/bin/claude"
printf '#!/bin/sh\necho "codex-cli 0.162.1"\n' > "$TMP/bin/codex"
chmod +x "$TMP/bin/claude" "$TMP/bin/codex"

# a codify project for the injected server to serve the ask tools from
cp -r "$FIXTURES/sample" "$TMP/proj"
(cd "$TMP/proj" && git init -q . && "$CG" init >/dev/null 2>&1) || fail "project init"

python3 - "$NATIVE" "$CG" "$TMP" "$ROOT/spec/workflow.kvx" <<'PY' || fail "connector launch policy"
import hashlib, json, os, shutil, subprocess, sys, tomllib
native, cg, tmp, workflow = sys.argv[1:]
cg = os.path.realpath(cg)
rule = next(json.loads(l.split("=", 1)[1]) for l in open(workflow) if l.startswith("step_5 = "))
TOOLS = ["mcp__codify__ask_raise", "mcp__codify__ask_status", "mcp__codify__ask_list", "mcp__codify__approvals_list"]

def snapshot(name):
    exe = f"{tmp}/bin/{name}"
    version = {"codex": "0.162.1", "claude": "2.1.300"}[name]
    p = {"schema_version": 1, "profile_id": "fixture-" + name, "profile_revision": "1",
         "profile_digest": "sha256:" + "a" * 64, "connector": name, "auth_mode": "account_session",
         "binary": {"path": exe, "digest": "sha256:" + hashlib.sha256(open(exe, "rb").read()).hexdigest(), "version": version},
         "credential_reference": "fixture-unavailable", "configured_model_alias": "fixture-frontier",
         "requested_model_id": "fixture-model", "observed_model_id": None, "configured_provider_id": "fixture-provider",
         "observed_provider_id": None, "permission_profile_id": "fixture-workspace",
         "capabilities": {"unattended": True, "refresh": False, "concurrent_account": False, "portable_session": False, "explicit_resume": False},
         "qualification": {"state": "UNQUALIFIED", "live_qualified": False, "receipt_digest": None}}
    path = f"{tmp}/snapshot-{name}.json"
    json.dump(p, open(path, "w"))
    return path

def invoke(action, request, env, binary=native):
    r = subprocess.run([binary, "--component", "13.1", "--action", action], input=json.dumps(request),
                       text=True, capture_output=True, env=env, timeout=20)
    rows = [json.loads(x) for x in r.stdout.splitlines() if x.strip()]
    assert len(rows) == 1, (action, r.stdout, r.stderr)
    return r.returncode, rows[0]

def launch(name, env, binary=native):
    req = {"connector": name, "expected_version": {"codex": "0.162.1", "claude": "2.1.300"}[name], "alias": "fixture-frontier",
           "auth_profile": "fixture-" + name, "workspace": f"{tmp}/ws", "home": f"{tmp}/home", "temp": f"{tmp}/tmpdir",
           "permission_mode": "workspace-write"}
    return invoke("connector.launch", req, env, binary)

def base_env(name, **extra):
    env = {"PATH": "/usr/bin:/bin", "HF_NATIVE_AUTH_SNAPSHOT_FILE": snapshot(name)}
    env.update(extra)
    return env

def flag(argv, name):
    assert name in argv, f"missing {name} in {argv}"
    return argv[argv.index(name) + 1]

def configs(argv):
    out = {}
    for i, a in enumerate(argv):
        if a == "-c":
            out.update(tomllib.loads(argv[i + 1].replace("mcp_servers.codify.", "mcp_servers_codify_")))
    return out

# ---- negative: a native binary with no codify binary beside it and no
#      valid HF_CODIFY_MCP_BINARY produces no worker launch plan
for name in ("claude", "codex"):
    rc, row = launch(name, base_env(name))
    assert rc != 0 and row["ok"] is False, (name, row)   # the same request succeeds below with the binary named
    for bad in ("cg", f"{tmp}/missing/cg", f"{tmp}/ws"):
        rc, row = launch(name, base_env(name, HF_CODIFY_MCP_BINARY=bad))
        assert rc != 0 and row["ok"] is False, (name, bad, row)

# ---- Claude Code: prompts disabled, codify MCP with the ask tools, the rule
rc, row = launch("claude", base_env("claude", HF_CODIFY_MCP_BINARY=cg))
assert rc == 0 and row["ok"], row
argv = row["result"]["argv"]
assert flag(argv, "--permission-mode") == "dontAsk"
assert flag(argv, "--permission-prompts") == "none"
assert "--strict-mcp-config" in argv and "--dangerously-skip-permissions" not in argv
assert flag(argv, "--disallowedTools") == "Agent,Task,Workflow"
mcp = json.loads(flag(argv, "--mcp-config"))
assert mcp == {"mcpServers": {"codify": {"type": "stdio", "command": cg, "args": ["mcp"]}}}, mcp
assert flag(argv, "--allowedTools").split(",") == TOOLS
assert flag(argv, "--append-system-prompt") == rule, "Claude instruction rule drifted from workflow.kvx step_5"
assert flag(argv, "--model") == "fixture-model"

# ---- Codex: approvalPolicy never at process and thread level, codify MCP, the rule
rc, row = launch("codex", base_env("codex", HF_CODIFY_MCP_BINARY=cg))
assert rc == 0 and row["ok"], row
argv = row["result"]["argv"]
assert argv[1:4] == ["app-server", "--listen", "stdio://"]
c = configs(argv)
assert c["approval_policy"] == "never", c
assert c["mcp_servers_codify_command"] == cg and c["mcp_servers_codify_args"] == ["mcp"], c
assert c["developer_instructions"] == rule, "Codex instruction rule drifted from workflow.kvx step_5"
assert c["agents"] == {"enabled": False}
rc, row = invoke("connector.initialize", {"connector": "codex", "request_id": "init-1", "workspace": f"{tmp}/ws"}, base_env("codex"))
assert rc == 0, row
start = row["result"]["steps"][2]["frame"]
assert start["method"] == "thread/start" and start["params"]["approvalPolicy"] == "never", start

# ---- release layout: bin/hyperfide beside bin/hyperfide-native is found
#      without the variable
os.makedirs(f"{tmp}/release/bin")
shutil.copy(native, f"{tmp}/release/bin/hyperfide-native")
shutil.copy(cg, f"{tmp}/release/bin/hyperfide")
for name in ("claude", "codex"):
    rc, row = launch(name, base_env(name), f"{tmp}/release/bin/hyperfide-native")
    assert rc == 0 and row["ok"], (name, row)
    assert f"{tmp}/release/bin/hyperfide" in " ".join(row["result"]["argv"]), name

# ---- the injected server really serves the ask tools from a project
cmd = [mcp["mcpServers"]["codify"]["command"]] + mcp["mcpServers"]["codify"]["args"]
frames = '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}\n' \
         '{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n'
r = subprocess.run(cmd, input=frames, text=True, capture_output=True, cwd=f"{tmp}/proj", timeout=60)
msgs = {m["id"]: m for m in map(json.loads, filter(str.strip, r.stdout.splitlines())) if "id" in m}
names = {t["name"] for t in msgs[1]["result"]["tools"]}
for tool in TOOLS:
    assert tool.removeprefix("mcp__codify__") in names, f"injected server lacks {tool}"
print("ok")
PY

# ---- the reason is documented where a reader meets the flags
grep -q 'nobody is at its terminal' "$ROOT/src/hyperfide/connectors.c" || fail "connectors.c lost the sandbox prompt rationale"
grep -q 'native prompt in a sandbox is invisible' "$ROOT/README.md" || fail "README lost the sandbox prompt rationale"
echo "PASS: 91_connector_flags"
