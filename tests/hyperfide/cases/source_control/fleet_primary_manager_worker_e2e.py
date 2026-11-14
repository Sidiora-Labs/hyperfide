#!/usr/bin/env python3
"""Deterministic Primary -> Feature Manager -> provider -> worker E2E contract.

This is the provider-independent companion to the live qualification campaign.  It
uses the same durable identities and effect boundaries as the production routes,
then persists and reloads the journal to exercise restart and uncertain replay.
It deliberately makes no cloud, model, or native-execution claim.
"""
from __future__ import annotations

import copy
import json
import tempfile
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
import sys
sys.path.insert(0, str(ROOT / "tests/hyperfide/support"))
from fleet_live_qualification import TASK_CASES  # noqa: E402


def uid() -> str:
    return str(uuid.uuid4())


class Ledger:
    def __init__(self, state: dict | None = None):
        self.state = state or {
            "decisions": [],
            "effects": [],
            "provider": [],
            "workers": [],
            "feedback": [],
            "operations": {},
        }

    def _decision(self, actor_role: str, actor_id: str, action: str, input_value: dict,
                  delegation_id: str | None = None) -> dict:
        operation_id = uid()
        decision = {
            "schema_version": 1,
            "kind": "hyperfide.fleet-decision",
            "decision_id": uid(),
            "operation_id": operation_id,
            "run_id": RUN_ID,
            "actor_id": actor_id,
            "actor_role": actor_role,
            "authority_epoch": AUTHORITY_EPOCH,
            "leader_generation": "1",
            "delegation_id": delegation_id,
            "manager_generation": "2" if delegation_id else None,
            "action": action,
            "input": input_value,
        }
        self.state["decisions"].append(decision)
        self.state["operations"][operation_id] = {"request": copy.deepcopy(decision), "state": "COMPLETED"}
        return decision

    def _effect(self, decision: dict, result: dict) -> dict:
        effect = {"operation_id": decision["operation_id"], "decision_id": decision["decision_id"], "result": result}
        self.state["effects"].append(effect)
        return effect

    def delegate(self, primary: str, package: str) -> dict:
        decision = self._decision("PRIMARY", primary, "DELEGATE_WAVE", {"package_id": package, "manager_session_id": MANAGER_ID})
        return self._effect(decision, {"kind": "DELEGATE_WAVE", "package_id": package, "manager_session_id": MANAGER_ID, "manager_generation": "2"})

    def provision(self, manager: str, package: str, provider: str, sandbox: str) -> dict:
        decision = self._decision("WAVE_MANAGER", manager, "PROVISION_SANDBOX", {
            "provider_id": provider, "sandbox_id": sandbox, "purpose": "EXECUTION",
        }, package)
        intent = {"id": uid(), "operation_id": decision["operation_id"], "provider": provider, "sandbox_id": sandbox, "state": "ACKNOWLEDGED"}
        self.state["provider"].append(intent)
        return self._effect(decision, {"kind": "PROVISION_SANDBOX", "delegation_id": package, "provider_intent_id": intent["id"], "sandbox_id": sandbox})

    def assign(self, manager: str, package: str, sandbox: str, task: str) -> dict:
        decision = self._decision("WAVE_MANAGER", manager, "ASSIGN_WORKER", {
            "task_id": task, "install_binding": {"sandbox_id": sandbox, "operation_id": self.state["provider"][-1]["operation_id"]},
        }, package)
        attempt = {"id": uid(), "task_id": task, "sandbox_id": sandbox, "state": "CURRENT"}
        self.state["workers"].append(attempt)
        return self._effect(decision, {"kind": "ASSIGN_WORKER", "delegation_id": package, "assignment": {"attempt_id": attempt["id"], "worker_id": manager, "task_id": task}})

    def complete(self, attempt_id: str, exit_code: int = 0) -> dict:
        feedback = {"attempt_id": attempt_id, "state": "COMPLETED", "result": {"exit_code": exit_code, "terminal_observed": True}}
        self.state["feedback"].append(feedback)
        return feedback

    def uncertain(self, operation_id: str) -> None:
        self.state["operations"][operation_id]["state"] = "UNKNOWN"

    def replay(self, decision: dict) -> dict:
        operation = self.state["operations"].get(decision["operation_id"])
        if operation is None:
            raise AssertionError("replay lost original operation identity")
        if operation["request"] != decision:
            raise AssertionError("conflicting replay changed the original request")
        if operation["state"] == "UNKNOWN":
            operation["state"] = "RECONCILED"
            return {"replayed": False, "reconciled": True, "operation_id": decision["operation_id"]}
        return {"replayed": True, "operation_id": decision["operation_id"]}


RUN_ID = uid()
AUTHORITY_EPOCH = uid()
MANAGER_ID = uid()


def run() -> dict:
    live_case_contract = {"model_delegation", "provider_creation", "coding_worker", "manager_replacement"}
    assert live_case_contract.issubset(set(TASK_CASES["0.14"])), "live qualification case contract drifted"
    primary, package, provider, sandbox, task = uid(), uid(), "fixture-provider", uid(), uid()
    ledger = Ledger()
    delegated = ledger.delegate(primary, package)
    delegated_decision = ledger.state["decisions"][-1]
    provisioned = ledger.provision(MANAGER_ID, package, provider, sandbox)
    assigned = ledger.assign(MANAGER_ID, package, sandbox, task)
    attempt_id = assigned["result"]["assignment"]["attempt_id"]
    feedback = ledger.complete(attempt_id)

    assert delegated["result"]["manager_session_id"] == MANAGER_ID
    assert provisioned["result"]["delegation_id"] == package
    assert ledger.state["provider"][0]["id"] == provisioned["result"]["provider_intent_id"]
    assert feedback["attempt_id"] == attempt_id and feedback["result"]["exit_code"] == 0
    effect_count = len(ledger.state["effects"])

    uncertain = ledger.provision(MANAGER_ID, package, provider, uid())
    uncertain_decision = ledger.state["decisions"][-1]
    ledger.uncertain(uncertain["operation_id"])
    reconciled = ledger.replay(uncertain_decision)
    assert reconciled == {"replayed": False, "reconciled": True, "operation_id": uncertain["operation_id"]}
    assert len(ledger.state["effects"]) == effect_count + 1
    assert ledger.replay(uncertain_decision)["replayed"] is True

    with tempfile.TemporaryDirectory(prefix="hyperfide-fleet-e2e-") as directory:
        checkpoint = Path(directory) / "fleet-ledger.json"
        checkpoint.write_text(json.dumps(ledger.state, sort_keys=True), encoding="utf-8")
        restarted = Ledger(json.loads(checkpoint.read_text(encoding="utf-8")))
        assert restarted.replay(delegated_decision)["replayed"] is True
        assert restarted.state["feedback"] == ledger.state["feedback"]
        assert restarted.state["effects"] == ledger.state["effects"]

    return {
        "status": "PASS",
        "scope": "deterministic durable coordination contract; no model/provider/native qualification",
        "checks": [
            "existing 0.14 live qualification case contract includes delegation, provider, worker and replacement stages",
            "Primary DELEGATE_WAVE receipt binds the Feature Manager and package",
            "Feature Manager PROVISION_SANDBOX receipt binds provider intent and delegation",
            "Feature Manager ASSIGN_WORKER receipt binds the installed sandbox and attempt",
            "worker feedback binds a successful terminal result to the assigned attempt",
            "UNKNOWN operation reconciliation and exact replay never create a second effect",
            "restart reload preserves decisions, effect receipts and worker feedback",
        ],
        "effect_receipts": len(ledger.state["effects"]),
        "worker_feedback": len(ledger.state["feedback"]),
    }


if __name__ == "__main__":
    print(json.dumps(run(), sort_keys=True))
