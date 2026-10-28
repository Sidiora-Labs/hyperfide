#!/usr/bin/env bash
# Spec symbol resolution: Rust impls over a lifetime-only generic, Rust
# method ties broken by the task's declared touches, and Elixir name/arity.
. "$(dirname "$0")/../lib.sh"

cp -r "$FIXTURES/specrepo" "$TMP/repo"
cd "$TMP/repo"
cat >> spec/demo/spec.kvx <<'EOF'

[task.4.1]
title    = "Lifetime impl method"
status   = "pending"
wave     = 4
symbols  = ["Reader::read"]
touches  = ["src/reader.rs"]

[task.4.2]
title    = "Tie broken by touches"
status   = "pending"
wave     = 4
symbols  = ["Store::get"]
touches  = ["beta/src/store.rs"]

[task.4.3]
title    = "Tie with no touch"
status   = "pending"
wave     = 4
symbols  = ["Store::get"]
touches  = ["gamma/src/other.rs"]

[task.4.4]
title    = "Elixir arity"
status   = "pending"
wave     = 4
symbols  = ["hello/1"]
touches  = ["lib/greeter.ex"]
EOF
mkdir -p src alpha/src beta/src lib
cat > src/reader.rs <<'EOF'
pub struct Reader<'a> {
    bytes: &'a [u8],
}

impl Reader<'_> {
    pub fn read(&self) -> usize {
        self.bytes.len()
    }
}
EOF
for c in alpha beta; do
cat > "$c/src/store.rs" <<'EOF'
pub struct Store {
    n: usize,
}

impl Store {
    pub fn get(&self) -> usize {
        self.n
    }
}
EOF
done
cat > lib/greeter.ex <<'EOF'
defmodule Greeter do
  def hello(name) do
    "hello " <> name
  end
end
EOF
"$CG" init >/dev/null
"$CG" commit -m "baseline" >/dev/null

DB="$(graph_db)"
[ "$(sqlite3 "$DB" "SELECT count(*) FROM symbols s JOIN files f ON f.id=s.file_id WHERE f.path='src/reader.rs' AND s.kind='impl' AND s.name='Reader'")" -ge 1 ] \
    || fail "impl Reader<'_> not named by its type"

out="$("$CG" spec trace 4.1)"
has "$out" "✓ Reader::read"
has "$out" "src/reader.rs"

out="$("$CG" spec trace 4.2)"
has "$out" "✓ Store::get"
has "$out" "beta/src/store.rs"

out="$("$CG" spec trace 4.3)"
has "$out" "✗ Store::get — ambiguous: 2 definitions ("
has "$out" "alpha/src/store.rs"
has "$out" "beta/src/store.rs"

out="$("$CG" spec trace 4.4)"
has "$out" "✓ hello/1"
has "$out" "lib/greeter.ex"

echo ok
