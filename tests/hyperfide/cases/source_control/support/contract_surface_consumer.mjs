import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DECISION_ACTIONS } from "../../../../../contracts/fleet/index.mjs";
import { MANAGER_ACTION_CONTRACTS } from "../../../../../core/control-plane/dist/scheduler/fleet.js";

async function assertContractSurface() {
  const primaryActions = [
    "CONFIGURE_WAVE",
    "DELEGATE_WAVE",
    "REPLACE_MANAGER",
    "SOURCE_OPERATION",
  ];
  assert.ok(DECISION_ACTIONS.length > primaryActions.length);
  assert.equal(new Set(DECISION_ACTIONS).size, DECISION_ACTIONS.length);
  for (const action of primaryActions) {
    assert.ok(
      DECISION_ACTIONS.includes(action),
      `Missing Primary action ${action}`,
    );
  }
  const managerActions = DECISION_ACTIONS.filter(
    (action) => !primaryActions.includes(action),
  );
  assert.deepEqual(
    Object.keys(MANAGER_ACTION_CONTRACTS).sort(),
    [...managerActions].sort(),
    "Scheduler contracts must cover exactly the non-Primary decision actions",
  );
  for (const action of managerActions) {
    const contract = MANAGER_ACTION_CONTRACTS[action];
    assert.ok(contract && typeof contract === "object", `${action} contract`);
    assert.ok(Array.isArray(contract.required), `${action} required fields`);
    assert.ok(
      contract.required.length > 0,
      `${action} required fields are empty`,
    );
    assert.equal(new Set(contract.required).size, contract.required.length);
    for (const field of contract.required) {
      assert.equal(typeof field, "string", `${action} required field name`);
      assert.ok(
        field.trim().length > 0,
        `${action} required field name is empty`,
      );
    }
    assert.equal(
      typeof contract.description,
      "string",
      `${action} description`,
    );
    assert.ok(
      contract.description.trim().length > 0,
      `${action} description is empty`,
    );
  }
  const copies = ["index.mjs", "index.d.mts"];
  for (const name of copies) {
    const [canonical, compiled] = await Promise.all([
      readFile(
        new URL(`../../../../../contracts/fleet/${name}`, import.meta.url),
      ),
      readFile(
        new URL(
          `../../../../../core/control-plane/dist/contracts/fleet/${name}`,
          import.meta.url,
        ),
      ),
    ]);
    assert.deepEqual(
      compiled,
      canonical,
      `Compiled fleet ${name} differs from canonical contract`,
    );
  }
  return {
    status: "PASS",
    scope: "control-plane-contract-surface",
    actions: DECISION_ACTIONS,
    primary_actions: primaryActions,
    manager_actions: managerActions,
    identical_copies: copies,
  };
}

console.log(JSON.stringify(await assertContractSurface()));
