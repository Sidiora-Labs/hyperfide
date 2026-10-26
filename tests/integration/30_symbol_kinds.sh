#!/usr/bin/env bash
# package-level constants and variables, Rust consts/statics/variants and
# qualified names (Type.Method, module::Item, Enum::Variant) in cg symbol and
# in the spec graph check
: "${CG:=$(cd "$(dirname "$0")/../.." && pwd)/cg}"
export CG
. "$(dirname "$0")/../lib.sh"

mkdir -p "$TMP/proj/gopkg" "$TMP/proj/rs/src" "$TMP/proj/ts"
cd "$TMP/proj"
cat > gopkg/a.go <<'GO'
package gopkg

// FooConst is a const.
const FooConst = "0x1015"

// BarVar is a var.
var BarVar = &MetaData{Name: "x"}

var (
	ModuleCdc = NewCodec(1)
	grouped   = 2
)

const (
	GroupA = iota
	GroupB
)

type MetaData struct{ Name string }

func NewCodec(n int) *MetaData { return &MetaData{} }

// Baz is a func.
func Baz() string { local := FooConst; return local }

type Params struct{}

// Marshal is a method.
func (p Params) Marshal() ([]byte, error) { return nil, nil }
GO
cat > rs/Cargo.toml <<'TOML'
[package]
name = "rs"
version = "0.1.0"
TOML
cat > rs/src/lib.rs <<'RS'
pub mod evidence;
pub enum SettlementRung { Pending, Final }
pub struct Evidence { pub rung: SettlementRung }
pub fn digest() -> u8 { 1 }
pub const RUNG_MAX: u8 = 2;
pub static RUNG_NAME: &str = "rung";
pub mod inner { pub fn deep() -> u8 { 3 } }
RS
cat > rs/src/evidence.rs <<'RS'
pub enum GatewayError { ReceiptPending, Rejected }
pub struct Receipt { pub id: u64 }
RS
cat > ts/env.ts <<'TS'
export const SEQUENCER_RPC_URL = "http://x";
export const EnvSchema = { a: 1 };
export function readEnv() { return EnvSchema; }
export enum Mode { A, B }
let counter = 0;
TS
git init -q . && git add -A && git -c user.email=t@t -c user.name=t commit -qm fixture

"$CG" init >/dev/null

resolves() {
    local out
    out="$("$CG" symbol "$1" 2>&1)" || fail "cg symbol $1 did not resolve: $out"
    has "$out" "$2"
}
resolves FooConst "gopkg/a.go"
resolves BarVar "gopkg/a.go"
resolves ModuleCdc "gopkg/a.go"
resolves GroupB "gopkg/a.go"
resolves MetaData "gopkg/a.go"
resolves Baz "gopkg/a.go"
resolves Marshal "gopkg/a.go"
resolves Params.Marshal "method Marshal"
resolves SettlementRung "rs/src/lib.rs"
resolves RUNG_MAX "rs/src/lib.rs"
resolves RUNG_NAME "rs/src/lib.rs"
resolves SettlementRung::Final "rs/src/lib.rs"
resolves evidence::GatewayError "rs/src/evidence.rs"
resolves GatewayError::ReceiptPending "rs/src/evidence.rs"
resolves crate::evidence::Receipt "rs/src/evidence.rs"
resolves inner::deep "rs/src/lib.rs"
resolves SEQUENCER_RPC_URL "ts/env.ts"
resolves counter "ts/env.ts"
resolves EnvSchema "object EnvSchema"
resolves readEnv "function readEnv"
resolves Mode "ts/env.ts"

# kinds are recorded as such
out="$("$CG" symbol FooConst)";  has "$out" "constant FooConst"
out="$("$CG" symbol BarVar)";    has "$out" "variable BarVar"
out="$("$CG" symbol RUNG_MAX)";  has "$out" "constant RUNG_MAX"
out="$("$CG" symbol RUNG_NAME)"; has "$out" "static RUNG_NAME"
out="$("$CG" symbol SEQUENCER_RPC_URL)"; has "$out" "variable SEQUENCER_RPC_URL"

# function locals stay out of the graph
"$CG" symbol local >/dev/null 2>&1 && fail "a function-local binding was indexed"

# a name that does not exist, and a qualifier naming the wrong container
for bad in NoSuchSymbolXyz Other.Marshal evidence::digest Params.Baz \
           SettlementRung::ReceiptPending GatewayError::Final nope::Receipt; do
    "$CG" symbol "$bad" >/dev/null 2>&1 && fail "cg symbol $bad should not resolve"
done

# the spec graph check uses the same resolution
cp "$FIXTURES/specrepo/spec/workflow.kvx" "$TMP/workflow.kvx"
mkdir -p spec/demo
cp "$TMP/workflow.kvx" spec/workflow.kvx
cat > spec/demo/spec.kvx <<'KVX'
[meta]
feature = "demo"
intro   = "Symbol kinds."

[req.1]
title = "Symbols"
story = "As a developer, I want every definition in the graph."
ac_1  = "WHEN a task names a constant THE graph check SHALL find it."

[tasks]
heading = "Implementation Plan: Demo"

[task.1]
title   = "Kinds"
section = "Slice 1"
status  = "pending"

[task.1.1]
title      = "Qualified and constant symbols"
status     = "pending"
wave       = 0
verify_cmd = "true"
symbols    = ["FooConst", "Params.Marshal", "SettlementRung::Final", "RUNG_MAX", "SEQUENCER_RPC_URL"]
reqs       = ["1.1"]

[task.1.2]
title      = "Wrong container"
status     = "pending"
wave       = 1
requires   = ["1.1"]
verify_cmd = "true"
symbols    = ["Other.Marshal"]
reqs       = ["1.1"]
KVX
"$CG" spec start 1.1 >/dev/null
out="$("$CG" spec done 1.1 2>&1)" || fail "spec done 1.1 refused: $out"
has "$out" "✓ symbol Params.Marshal"
has "$out" "✓ symbol FooConst"
has "$out" "done 1.1"

"$CG" spec start 1.2 >/dev/null
out="$("$CG" spec done 1.2 2>&1)" && fail "spec done accepted a wrongly qualified symbol: $out"
has "$out" "✗ symbol Other.Marshal — not defined in the graph"

echo "ok 30_symbol_kinds"
