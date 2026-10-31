import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { SpecReader } from "../../../hyperfide-spec/src/reader.js";
import { specSource } from "./spec-source.js";

it("reads real spec tasks and formats the canonical worker packet", async () => {
  const repository = await mkdtemp(join(tmpdir(), "hyperfide-spec-source-"));
  try {
    await mkdir(join(repository, "spec", "feature"), { recursive: true });
    await writeFile(join(repository, "spec", "feature", "spec.kvx"), `
[task.5.4]
title = "Dispatcher"
status = "pending"
wave = 5
requires = ["5.1"]
touches = ["src/**"]
verify_cmd = "npm test"
do_1 = "Dispatch ready tasks"
`);
    const reader = new SpecReader(repository, {
      get: async () => undefined,
      set: async () => {},
    }, async () => {}, async () => ({}));
    const ownership = {
      merged: vi.fn(async () => true),
      claim: vi.fn(async () => true),
      release: vi.fn(async () => {}),
    };
    const source = specSource(reader, "feature", ownership, async () => "abc123");
    expect(await source.spec.tasks()).toEqual([
      expect.objectContaining({ id: "5.4", requires: ["5.1"], wave: 5 }),
    ]);
    const packet = await source.packet("5.4");
    expect(packet.prompt).toContain("# Task feature/5.4: Dispatcher");
    expect(packet.prompt).toContain("- do_1: Dispatch ready tasks");
    expect(packet.prompt).toContain("Base commit: abc123");
    expect(packet.prompt).toContain("[spec:feature/5.4]");
    await source.spec.merged("5.1", "tip");
    await source.spec.claim("5.4", "job");
    await source.spec.release("5.4", "job");
    expect(ownership.merged).toHaveBeenCalledWith("5.1", "tip");
    expect(ownership.claim).toHaveBeenCalledWith("5.4", "job");
    expect(ownership.release).toHaveBeenCalledWith("5.4", "job");
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});
