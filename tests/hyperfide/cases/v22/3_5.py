#!/usr/bin/env python3
"""Qualify Ask persistence and the thread/inbox/notification lifecycle."""

import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "support"))
from platform_fixture import PlatformFixture


def main():
    with PlatformFixture() as platform:
        variable = platform.rpc("thread.raise", kind="variable",
                                question="Which deployment region?", recommendation="eu-west")
        assert variable["blocking"] is True, variable
        paused = platform.rpc("thread.get")
        assert paused["paused"] == {"askId": variable["id"], "reason": variable["title"]}, paused
        assert paused["thread"]["status"] == "idle", paused
        inbox = platform.rpc("inbox.list")
        assert len(inbox) == 1 and inbox[0]["id"] == variable["id"], inbox
        for field in ("kind", "task", "deadline", "recommended"):
            assert inbox[0][field] == variable[field], inbox
        # Repeated reads must not create duplicate notifications or run turns.
        again = platform.rpc("thread.get")
        assert again["events"] == paused["events"], again
        assert again["notifications"] == [{
            "askId": variable["id"], "task": variable["task"],
            "kind": "variable", "deadline": variable["deadline"],
        }], again
        try:
            platform.rpc("thread.send", text="must not run while blocked")
        except RuntimeError as error:
            assert "thread is paused" in str(error), error
        else:
            raise AssertionError("paused thread accepted a new turn")

        platform.rpc("inbox.answer", id=variable["id"], answer="eu-west")
        resumed = platform.rpc("thread.get")
        assert resumed["paused"] is None, resumed
        assert len(resumed["events"]) > len(paused["events"]), resumed
        assert f'Ask #{variable["id"]} answered: eu-west' in json.dumps(resumed["events"]), resumed
        answered = next(a for a in platform.rpc("store.list") if a["id"] == variable["id"])
        assert answered["state"] == "answered" and answered["answer"] == "eu-west", answered
        assert platform.rpc("inbox.list") == [], "answered Ask remained in inbox"
        stable = platform.rpc("thread.get")
        assert stable["events"] == resumed["events"], "answer was injected twice"

        decision = platform.rpc("thread.raise", kind="decision",
                                question="Which rollout strategy?", recommendation="canary")
        flagged = platform.rpc("thread.get")
        assert flagged["paused"] is None and decision["blocking"] is False, flagged
        assert flagged["annotations"] == [{
            "askId": decision["id"], "flagged": True, "recommendation": "canary",
        }], flagged
        platform.rpc("thread.send", text="Proceed with the canary rollout")
        proceeded = platform.rpc("thread.get")
        assert len(proceeded["events"]) > len(flagged["events"]), proceeded
        assert "Proceed with the canary rollout" in json.dumps(proceeded["events"]), proceeded
        assert proceeded["notifications"] == paused["notifications"], proceeded
        assert [a["id"] for a in platform.rpc("inbox.list")] == [decision["id"]]
        journal = platform.rpc("journal.list")
        raised = [e for e in journal if e["kind"] == "ask.raised"]
        answered_events = [e for e in journal if e["kind"] == "ask.answered"]
        assert len(raised) == 2 and len(answered_events) == 1, journal
        assert {e["subject"] for e in raised} == {
            f'ask/{variable["id"]}', f'ask/{decision["id"]}',
        }, journal
        assert answered_events[0]["subject"] == f'ask/{variable["id"]}', journal
        payload = answered_events[0]["payload"]
        if isinstance(payload, str):
            payload = json.loads(payload)
        assert payload["state"] == "answered" and payload["answer"] == "eu-west", journal
        print("ok: Ask pause, inbox, answer/resume, flagged decision, notification and journal (projection)")


if __name__ == "__main__":
    main()
