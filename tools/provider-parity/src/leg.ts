import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  CreateParityAssembler,
  ParityAssembler,
  ParityRowProjector,
} from "@hyperfide/provider-bridge-protocol/testing";
import { projectParityRows } from "./index.js";

export interface ParityLeg {
  checkoutRoot: string;
  createAssembler: CreateParityAssembler;
  projectRows: ParityRowProjector;
  source: string;
}

const LEG_PACKAGE_ENTRIES = [
  "tools/provider-parity/src/index.ts",
  "packages/provider-parity/src/index.ts",
];

const COLLECTOR_CANDIDATES = [
  "core/provider-bridge-protocol/src/testing/bridge-delta-assembly.ts",
  "core/agent-runtime/src/test/bridge-delta-assembly.ts",
  "packages/provider-bridge-protocol/src/testing/bridge-delta-assembly.ts",
  "packages/agent-runtime/src/test/bridge-delta-assembly.ts",
];

interface CollectorModule {
  createBridgeDeltaEventCollector?: unknown;
}

interface LegPackageModule {
  createParityAssembler?: unknown;
  projectParityRows?: unknown;
}

type CreateCollector = (providerId: string) => ParityAssembler;

function isCreateCollector(value: unknown): value is CreateCollector {
  return typeof value === "function";
}

async function importFromCheckout<T>(
  checkoutRoot: string,
  relativePath: string,
): Promise<T | null> {
  const file = join(checkoutRoot, relativePath);
  if (!existsSync(file)) {
    return null;
  }
  return (await import(pathToFileURL(file).href)) as T;
}

export async function loadParityLeg(checkoutRoot: string): Promise<ParityLeg> {
  const root = resolve(checkoutRoot);

  for (const candidate of LEG_PACKAGE_ENTRIES) {
    const ownPackage = await importFromCheckout<LegPackageModule>(root, candidate);
    if (
      ownPackage !== null &&
      typeof ownPackage.createParityAssembler === "function" &&
      typeof ownPackage.projectParityRows === "function"
    ) {
      return {
        checkoutRoot: root,
        createAssembler:
          ownPackage.createParityAssembler as CreateParityAssembler,
        projectRows: ownPackage.projectParityRows as ParityRowProjector,
        source: candidate,
      };
    }
  }

  for (const candidate of COLLECTOR_CANDIDATES) {
    const module = await importFromCheckout<CollectorModule>(root, candidate);
    if (
      module === null ||
      !isCreateCollector(module.createBridgeDeltaEventCollector)
    ) {
      continue;
    }
    const createCollector = module.createBridgeDeltaEventCollector;
    return {
      checkoutRoot: root,
      createAssembler: (providerId) => {
        const collector = createCollector(providerId);
        return {
          assembleMessage: (message) => collector.assembleMessage(message),
        };
      },
      projectRows: projectParityRows,
      source: `${candidate} (projection from the harness checkout)`,
    };
  }

  throw new Error(
    `${root} has neither ${LEG_PACKAGE_ENTRIES.join(" / ")} nor a delta collector at ${COLLECTOR_CANDIDATES.join(" / ")}; is it a hyperfide checkout with pnpm install run?`,
  );
}
