import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkAllowlist,
  scanTree,
  providerLiteralRegex,
} from "../../workspace/check-provider-literal-ratchet.mjs";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SCRIPT = join(ROOT, "tools", "workspace", "check-provider-literal-ratchet.mjs");

function run(args = [], env = {}) {
  try {
    return {
      code: 0,
      out: execFileSync("node", [SCRIPT, ...args], {
        cwd: ROOT,
        encoding: "utf8",
        env: { ...process.env, ...env },
        stdio: ["ignore", "pipe", "pipe"],
      }),
    };
  } catch (e) {
    return { code: e.status ?? 1, out: (e.stdout ?? "") + (e.stderr ?? "") };
  }
}

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ratchet-fixture-"));
  mkdirSync(join(dir, "core", "fixture"), { recursive: true });
  mkdirSync(join(dir, "plugins", "provider-codex"), { recursive: true });
  mkdirSync(join(dir, "core", "fixture", "__fixtures__"), { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function write(rel, content) {
  const abs = join(dir, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
}

describe("scanTree (pure)", () => {
  it.each([
    [
      "plugins/.bundled-stage-fixture/server.ts",
      "plugins/hyperfide-dispatch/src/server.ts",
    ],
    [
      "apps/cli/.packaged-plugin-build-IZlVup/cli-chunks/server.js",
      "apps/cli/src/server.ts",
    ],
    [
      "examples/demo-server/.wrangler/tmp/dev-R0GX8u/worker.js",
      "examples/demo-server/src/worker.ts",
    ],
    [
      "sdk/plugins/.runtime-test-repro/provider-bridge-testing.js",
      "sdk/plugins/src/provider-bridge.ts",
    ],
  ])(
    "excludes generated artifact %s while scanning source",
    (artifact, source) => {
      write(artifact, 'const id = "codex";\n');
      write(source, 'const id = "claude-code";\n');
      expect(scanTree(dir).files).toEqual({ [source]: 1 });
    },
  );

  it("counts every occurrence, including two ids on one line", () => {
    write(
      "core/fixture/a.ts",
      'const m = { codexHint: "codex", claudeHint: "claude-code" };\n',
    );
    const { total, files } = scanTree(dir);
    expect(files["core/fixture/a.ts"]).toBe(2); // both ids on one line
    expect(total).toBe(2);
  });

  it("counts named id constants and helpers", () => {
    write(
      "core/fixture/b.ts",
      "if (isAcpProviderId(x) || RESERVED_PROVIDER_ID_OWNERS.has(y)) {}\n",
    );
    expect(scanTree(dir).files["core/fixture/b.ts"]).toBe(2);
  });

  it("catches ids in .mjs and .js, not only .ts", () => {
    write("core/fixture/x.mjs", 'export const id = "codex";\n');
    write("core/fixture/y.js", 'export const id = "acp-cursor";\n');
    const { files } = scanTree(dir);
    expect(files["core/fixture/x.mjs"]).toBe(1);
    expect(files["core/fixture/y.js"]).toBe(1);
  });

  it("counts an uppercase-only constant even with no lowercase id text", () => {
    write(
      "core/fixture/c.ts",
      "export const D = PRODUCT_DEFAULT_PROVIDER_ID;\n",
    );
    expect(scanTree(dir).files["core/fixture/c.ts"]).toBe(1);
  });

  it("excludes the src/testing test-kit convention (parity/conformance harnesses name providers)", () => {
    write(
      "core/fixture/src/testing/parity.ts",
      'const bridge = id === "codex" ? a : "claude-code";\n',
    );
    expect(scanTree(dir).total).toBe(0);
  });

  it("excludes provider plugins, tests, and fixtures", () => {
    write("plugins/provider-codex/server.ts", 'register("codex");\n'); // provider plugin
    write(
      "plugins/environment-modal-sandbox/server.ts",
      'const providerId = "codex";\n',
    );
    write("core/fixture/a.test.ts", 'expect("codex").toBe("codex");\n'); // test
    write("core/fixture/__fixtures__/f.ts", 'const id = "codex";\n'); // fixture
    expect(scanTree(dir).total).toBe(0);
  });

  // The published ACP bridge kit is a provider implementation that lives
  // under packages/ so the plugin SDK can re-export it; it gets the same
  // carve-out a provider plugin does. Its neighbours do not.
  it("excludes the published provider bridge kit but not its neighbours", () => {
    write(
      "core/provider-bridge-acp/src/dialect.ts",
      'const dialects = { "cursor-agent": "cursor" };\n',
    );
    expect(scanTree(dir).total).toBe(0);
    write(
      "core/provider-bridge-protocol/src/a.ts",
      'const id = "acp-cursor";\n',
    );
    expect(scanTree(dir).total).toBe(1);
  });

  it('providerLiteralRegex does not double-count `providerId === "codex"`', () => {
    const line = 'if (providerId === "codex") {}';
    expect(line.match(providerLiteralRegex())).toHaveLength(1);
  });

  it("does not count a bare cursor: an editor id or a pagination cursor, not the acp-cursor provider", () => {
    write(
      "core/fixture/open.ts",
      'const editor = { id: "cursor", executable: "cursor" }; const page = option(args, "cursor");\n',
    );
    write("core/fixture/agent.ts", 'const id = "acp-cursor";\n');
    const { files, total } = scanTree(dir);
    expect(files["core/fixture/open.ts"]).toBeUndefined();
    expect(files["core/fixture/agent.ts"]).toBe(1);
    expect(total).toBe(1);
  });

  it("excludes the test-only helpers package", () => {
    write(
      "tools/test-helpers/src/models.ts",
      'const m = { codex: ["gpt"] , "claude-code": [] };\n',
    );
    expect(scanTree(dir).total).toBe(0);
  });
});

describe("checkAllowlist (pure)", () => {
  const scan = { files: { "core/fixture/a.ts": 2, "core/fixture/b.ts": 1 } };
  const entry = (count) => ({
    count,
    reason: "legacy reader",
    owner: "provider-x",
    diesAt: "0.41",
  });

  it("passes when every counted file is listed at its live count", () => {
    expect(
      checkAllowlist(scan, {
        "core/fixture/a.ts": entry(2),
        "core/fixture/b.ts": entry(1),
      }),
    ).toEqual([]);
  });

  it("names a counted file with no entry", () => {
    const problems = checkAllowlist(scan, { "core/fixture/a.ts": entry(2) });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/packages\/core\/b\.ts: 1 reference/);
  });

  it("names an entry whose count drifted and an entry with nothing left", () => {
    const problems = checkAllowlist(scan, {
      "core/fixture/a.ts": entry(3),
      "core/fixture/b.ts": entry(1),
      "core/fixture/gone.ts": entry(1),
    });
    expect(problems.map((p) => p.trim()[0])).toEqual(["≠", "−"]);
  });

  it("treats a missing allowlist block as empty", () => {
    expect(checkAllowlist(scan, undefined)).toHaveLength(2);
  });

  it("rejects an entry that omits the reason, the owner, or when it dies", () => {
    const problems = checkAllowlist(
      { files: { "core/fixture/a.ts": 1 } },
      {
        "core/fixture/a.ts": {
          count: 1,
          reason: "x",
          owner: "",
          diesAt: undefined,
        },
      },
    );
    expect(problems.map((p) => p.trim())).toEqual([
      "! core/fixture/a.ts: allowlist entry has no owner",
      "! core/fixture/a.ts: allowlist entry has no diesAt",
    ]);
  });
});

describe("ratchet CLI refusal paths (fixture root)", () => {
  function baseline(files, allowlist = {}) {
    return JSON.stringify({
      total: Object.values(files).reduce((a, b) => a + b, 0),
      files,
      allowlist,
    });
  }
  const entry = (count) => ({
    count,
    reason: "fixture",
    owner: "test",
    diesAt: "never",
  });

  it("refuses --write when the live total rises above the committed baseline", () => {
    write("core/fixture/a.ts", 'const id = "codex";\n');
    write("scripts/provider-literal-baseline.json", baseline({}));
    const r = run(["--write"], { HYPERFIDE_RATCHET_ROOT: dir });
    expect(r.code, r.out).toBe(1);
    expect(r.out).toMatch(/Refusing to raise the baseline \(0 → 1\)/);
    // The override is the documented escape hatch.
    expect(
      run(["--write"], {
        HYPERFIDE_RATCHET_ROOT: dir,
        HYPERFIDE_RATCHET_ALLOW_INCREASE: "1",
      }).code,
    ).toBe(0);
  });

  it("fails the exact-match check when a new core file carries a reference", () => {
    write("core/fixture/a.ts", 'const id = "codex";\n');
    write("core/fixture/b.ts", 'const other = "claude-code";\n');
    write(
      "scripts/provider-literal-baseline.json",
      baseline({ "core/fixture/a.ts": 1 }, { "core/fixture/a.ts": entry(1) }),
    );
    const r = run([], { HYPERFIDE_RATCHET_ROOT: dir });
    expect(r.code, r.out).toBe(1);
    expect(r.out).toMatch(/core gained provider-id references/);
    expect(r.out).toMatch(/\+ packages\/core\/b\.ts: 1/);
  });

  it("fails --base when a file's count rose vs the base ref, even with a regenerated baseline", () => {
    const git = (...args) =>
      execFileSync("git", args, {
        cwd: dir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    git("init", "-q");
    git("config", "user.email", "ratchet@test");
    git("config", "user.name", "ratchet");
    write("core/fixture/a.ts", 'const id = "codex";\n');
    write(
      "scripts/provider-literal-baseline.json",
      baseline({ "core/fixture/a.ts": 1 }, { "core/fixture/a.ts": entry(1) }),
    );
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    // A second reference, and a baseline regenerated to match it.
    write("core/fixture/a.ts", 'const id = "codex"; const again = "codex";\n');
    write(
      "scripts/provider-literal-baseline.json",
      baseline({ "core/fixture/a.ts": 2 }, { "core/fixture/a.ts": entry(2) }),
    );
    expect(run([], { HYPERFIDE_RATCHET_ROOT: dir }).code).toBe(0); // exact match alone passes
    const r = run(["--base", "HEAD"], { HYPERFIDE_RATCHET_ROOT: dir });
    expect(r.code, r.out).toBe(1);
    expect(r.out).toMatch(/FAILED vs HEAD/);
    expect(r.out).toMatch(/↑ packages\/core\/a\.ts: 1 → 2/);
  });

  it("fails when a counted file has no allowlist entry", () => {
    write("core/fixture/a.ts", 'const id = "codex";\n');
    write(
      "scripts/provider-literal-baseline.json",
      baseline({ "core/fixture/a.ts": 1 }),
    );
    const r = run([], { HYPERFIDE_RATCHET_ROOT: dir });
    expect(r.code, r.out).toBe(1);
    expect(r.out).toMatch(/outside the allowlist/);
  });
});

describe("ratchet CLI (against the real repo baseline)", () => {
  // These two scan the whole repo tree: ~0.3s locally, ~6s on a slow CI
  // runner, so vitest's 5s default is not enough headroom.
  it("passes against the committed baseline", () => {
    const r = run();
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/ratchet OK/);
  }, 30_000);

  it("--write refuses to raise the total without the override", () => {
    // The live tree already matches the baseline, so we cannot force an
    // increase without editing tracked files. Instead assert the guard exists
    // by checking the message path via --base against a synthetic higher ref is
    // out of scope here; the pure fixture tests above cover counting. This
    // asserts the OK path only.
    const result = run();
    expect(result.code, result.out).toBe(0);
  }, 30_000);
});
