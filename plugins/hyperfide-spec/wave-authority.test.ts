import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { SpecReader, binaryCommand } from "./src/reader";
import { createWaveAuthority } from "./wave-authority";
import { closureView } from "./wave-detail";

it("reads the real spec service, persists operator marks, and blocks missing lane evidence", async () => {
  const repository = await mkdtemp(join(tmpdir(), "hyperfide-wave-authority-"));
  const values = new Map<string, unknown>();
  const storage = {
    async get<T>(key: string) { return values.get(key) as T | undefined; },
    async put(key: string, value: unknown) { values.set(key, structuredClone(value)); },
  };
  try {
    await mkdir(join(repository, "spec/fixture"), { recursive: true });
    await writeFile(join(repository, "spec/fixture/spec.kvx"), `[meta]
name = "Fixture"
[task.4.1]
title = "Publish"
status = "done"
wave = 4
`);
    const binary = join(repository, "hyperfide");
    await writeFile(binary, '#!/usr/bin/env node\nconsole.log(JSON.stringify({tasks:[]}));\n', { mode: 0o755 });
    const reader = new SpecReader(repository, {get: storage.get, set: storage.put}, async () => {}, binaryCommand(binary));
    const authority = createWaveAuthority({repository, reader, storage,
      lanes: {list: () => []}, asks: {list: async () => []}, checker: async () => undefined});
    let wave = await authority.read("fixture", 4);
    expect(wave.tasks[0]).toMatchObject({id:"4.1", title:"Publish", status:"done", lanes:[], checker:{verdict:"pending"}});
    expect(closureView(wave).ready).toBe(false);
    await expect(authority.mark("fixture", 4, "judge-output", {role:"worker", id:"agent"} as never)).rejects.toThrow("Operator");
    for (const human of wave.humans) await authority.mark("fixture", 4, human.id, {role:"operator", id:"owner"});
    wave = await authority.read("fixture", 4);
    expect(wave.humans.every(human => human.mark?.operator === "owner")).toBe(true);
    expect(closureView(wave).blockers).toEqual(expect.arrayContaining([
      "4.1: checker must pass at task commit", "4.1: lanes and closure checks must be green at task commit",
    ]));
    await writeFile(join(repository, "spec/fixture/spec.kvx"), 'invalid kvx');
    await expect(authority.read("fixture", 4)).rejects.toThrow("Stale spec");
  } finally { await rm(repository, {recursive:true, force:true}); }
}, 60_000);
