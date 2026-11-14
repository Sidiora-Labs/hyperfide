import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, expectTypeOf, test } from "vitest";
import {
  DECISION_ACTIONS,
  type Decision as ContractDecision,
  type TaskAssignment as ContractTaskAssignment,
  type InterfaceSelection as ContractInterfaceSelection,
} from "../../../contracts/fleet/index.mjs";
import type {
  Decision,
  TaskAssignment,
  InterfaceSelection,
} from "../src/public-types.js";

function agent_group_envelope_exports_compile() {
  expectTypeOf<Decision>().toEqualTypeOf<ContractDecision>();
  expectTypeOf<TaskAssignment>().toEqualTypeOf<ContractTaskAssignment>();
  expectTypeOf<InterfaceSelection>().toEqualTypeOf<ContractInterfaceSelection>();
  expectTypeOf<Decision["kind"]>().toEqualTypeOf<"hyperfide.fleet-decision">();
  expectTypeOf<
    TaskAssignment["kind"]
  >().toEqualTypeOf<"hyperfide.task-assignment">();
  expectTypeOf<
    InterfaceSelection["coverage"]
  >().toEqualTypeOf<"DECLARED_CLOSURE">();

  const files = [
    fileURLToPath(import.meta.url),
    fileURLToPath(new URL("../src/public-types.ts", import.meta.url)),
    fileURLToPath(
      new URL("../../../contracts/fleet/index.d.mts", import.meta.url),
    ),
  ];
  const program = ts.createProgram(files, {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    esModuleInterop: true,
    types: ["node"],
  });
  const diagnostics = [...program.getOptionsDiagnostics()];
  for (const file of files) {
    const source = program.getSourceFile(file);
    expect(source, `Compiler must load ${file}`).toBeDefined();
    diagnostics.push(
      ...program.getSyntacticDiagnostics(source!),
      ...program.getSemanticDiagnostics(source!),
    );
  }
  expect(
    ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: (file) => file,
      getCurrentDirectory: ts.sys.getCurrentDirectory,
      getNewLine: () => "\n",
    }),
  ).toBe("");
}

function agent_group_runtime_actions_match_control_plane_contracts() {
  const consumer = fileURLToPath(
    new URL(
      "../../../tests/hyperfide/cases/source_control/support/contract_surface_consumer.mjs",
      import.meta.url,
    ),
  );
  const surface = JSON.parse(
    execFileSync(process.execPath, [consumer], {
      encoding: "utf8",
      timeout: 90_000,
    }),
  );
  const actions: readonly Decision["action"][] = DECISION_ACTIONS;
  expect(surface.status).toBe("PASS");
  expect(surface.actions).toEqual(actions);
  expect(
    [...surface.primary_actions, ...surface.manager_actions].sort(),
  ).toEqual([...actions].sort());
  expect(surface.identical_copies).toEqual(["index.mjs", "index.d.mts"]);
}

test(
  agent_group_envelope_exports_compile.name,
  agent_group_envelope_exports_compile,
  90_000,
);
test(
  agent_group_runtime_actions_match_control_plane_contracts.name,
  agent_group_runtime_actions_match_control_plane_contracts,
  90_000,
);
