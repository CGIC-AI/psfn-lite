"""Hosted automata in the pinned Hermes (operator automata rules 2-4).

The plugin claims the companion's automaton attempts at the start of a
bound root turn and runs each through Hermes's public
``ctx.subagent_lifecycle``. Hermes's own lifecycle service, hook delivery
and tool dispatch run for real; only the child's model loop is replaced, as
Hermes's own lifecycle tests do (tests/agent/test_subagent_lifecycle.py),
by a child that calls its tools through ``model_tools.handle_function_call``.
The child's builder announces it through Hermes's ``invoke_hook`` exactly as
``tools.delegate_tool._build_child_agent`` does, which the last tests read
from Hermes's source.
"""

import ast
import inspect
import json
import textwrap
import threading
import time
import uuid
from types import SimpleNamespace

import pytest

from conftest import write_profile, plugin_module

CLAIM_LIMIT = 2


def fire(name, **kwargs):
    from hermes_cli.lifecycle import invoke_hook

    return invoke_hook(name, **kwargs)


def turn(session="sess-1", turn_id="sess-1:task:aa"):
    return dict(session_id=session, task_id="task", turn_id=turn_id, user_message="hello", conversation_history=[], is_first_turn=True,
                model="test-model", platform="cli", parent_session_id="", sender_id="")


#: Hermes keeps finished children per parent session for the process, and an attempt id is its correlation id: unique per run.
RUN = uuid.uuid4().hex[:8]


def claim(n, *, lease_ms=60_000, goal="Map the route docs."):
    return {
        "attemptId": f"subagent-{RUN}-{n}:attempt:1",
        "subagentId": f"subagent-{RUN}-{n}",
        "name": f"route-{n}",
        "attempt": 1,
        "maxAttempts": 3,
        "goal": goal,
        "context": "## Role\nResearch the assigned task.",
        "budget": {"maxIterations": 250},
        "credential": f"attempt-credential-{n}-" + "c" * 24,
        "leaseMs": lease_ms,
        "busAccess": True,
    }


class FakeChild:
    """The child agent object Hermes's lifecycle keeps; its run is the test's."""

    def __init__(self, ident, session_id):
        self._subagent_id = ident
        self.session_id = session_id
        self._delegate_role = "leaf"
        self._delegate_depth = 1
        self.provider = "test"
        self.model = "test-model"
        self.interrupted = False

    def interrupt(self, _reason):
        self.interrupted = True

    def hard_interrupt(self, _reason, *, tool_reason=None):
        self.interrupted = True


@pytest.fixture
def hosted(profile, bridge, monkeypatch):
    """The profile with hosted automata on, Hermes's child builder and child run replaced, and a parent bound."""
    global RUN
    RUN = f"{uuid.uuid4().hex[:8]}"
    write_profile(profile, bridge_url=bridge.url, automata={"claim_limit": CLAIM_LIMIT})
    from plugins.memory import load_memory_provider

    assert load_memory_provider("psfn_lite") is not None
    world = SimpleNamespace(built=[], runs={}, claims=[], heartbeat=lambda body: (200, {"status": "active", "attempt": 1}))
    counter = iter(range(1000))

    def build(**kwargs):
        n = next(counter)
        child = FakeChild(f"sa-{n}-test", f"child-session-{n}")
        world.built.append(kwargs)
        # As tools.delegate_tool._build_child_agent announces the child (read from Hermes's source below).
        fire("subagent_start", parent_session_id=kwargs["parent_agent"].session_id, parent_turn_id="", parent_subagent_id=None,
             child_session_id=child.session_id, child_subagent_id=child._subagent_id, child_role="leaf", child_goal=kwargs["goal"])
        return child

    def run(_index, goal, child, _parent):
        return world.runs.get(goal, completes)(child)

    monkeypatch.setattr("tools.delegate_tool._build_child_agent", build)
    monkeypatch.setattr("tools.delegate_tool._run_single_child", run)

    def claim_route(_route, body):
        return 200, {"attempts": world.claims.pop(0) if world.claims else []}

    bridge.handlers["automata/claim"] = claim_route
    bridge.handlers["automata/heartbeat"] = lambda _route, body: world.heartbeat(body)
    bridge.handlers["automata/bus"] = lambda _route, body: (200, {"text": json.dumps({"action": body["arguments"]["action"], "result": {"inserted": True}}), "isError": False})
    bridge.handlers["automata/report"] = lambda _route, body: (200, {"attempt": 1, "next": "completed"})
    world.parent = SimpleNamespace(session_id="sess-1", enabled_toolsets=["file", "psfn_lite"])
    return world


def bus_call(child, args):
    from model_tools import handle_function_call

    return handle_function_call("automata_bus", args, task_id="child-task", session_id=child.session_id)


def completes(child):
    written = bus_call(child, {"action": "note", "text": "Route docs live under docs/routes."})
    return {"status": "completed", "summary": f"Mapped the route docs. ({written})", "api_calls": 3, "duration_seconds": 0.01}


def root_turn(world, **kwargs):
    from agent.subagent_lifecycle import bind_subagent_parent

    with bind_subagent_parent(world.parent):
        results = fire("pre_llm_call", **turn(**kwargs))
    return results[0]["context"]


def settle_watchers():
    host = plugin_module("runtime").driver().automata
    for watcher in list(host.watchers):
        watcher.join(timeout=10)
        assert not watcher.is_alive()


def test_a_claimed_attempt_runs_as_a_hermes_child_with_its_own_credential_and_budget(hosted, bridge):
    hosted.claims.append([claim(1)])
    root_turn(hosted)
    settle_watchers()
    from tools.delegate_tool import DEFAULT_MAX_ITERATIONS

    # The host declares the budget Hermes gives each lifecycle child, and launches one fresh child for the attempt.
    [claim_body] = bridge.bodies("automata/claim")
    assert claim_body == {"hostInstance": bridge.bodies("prepare")[0]["hostInstance"], "maxIterations": DEFAULT_MAX_ITERATIONS, "limit": CLAIM_LIMIT}
    [built] = hosted.built
    assert built["max_iterations"] == DEFAULT_MAX_ITERATIONS
    assert built["goal"] == "Map the route docs." and built["context"] == "## Role\nResearch the assigned task."
    assert built["role"] == "leaf"
    # The child's Bus write went to core under the attempt's credential, as the attempt's host instance.
    [bus] = bridge.bodies("automata/bus")
    assert bus == {"hostInstance": claim_body["hostInstance"], "attemptCredential": claim(1)["credential"],
                   "arguments": {"action": "note", "text": "Route docs live under docs/routes."}}
    [report] = bridge.bodies("automata/report")
    assert report["attemptCredential"] == claim(1)["credential"]
    assert report["outcome"]["kind"] == "succeeded" and report["outcome"]["apiCalls"] == 3
    assert report["outcome"]["summary"].startswith("Mapped the route docs.") and '"inserted": true' in report["outcome"]["summary"]
    assert report["outcome"]["model"] == "test-model"
    # Only the bridge sees the credential: it is in no request of another route and no other header.
    others = [r for r in bridge.requests if not r["route"].startswith("automata/") or r["route"] == "automata/claim"]
    assert all(claim(1)["credential"] not in json.dumps(r["body"]) for r in others)


def test_automata_bus_is_refused_outside_a_hosted_attempt(hosted, bridge):
    from model_tools import handle_function_call

    root_turn(hosted)
    answer = json.loads(handle_function_call("automata_bus", {"action": "note", "text": "x"}, task_id="task", session_id="sess-1"))
    assert answer == {"error": plugin_module("automata").OUTSIDE_ATTEMPT}
    assert bridge.bodies("automata/bus") == []


def test_a_child_hermes_loses_ends_its_attempt_as_lost_and_a_failed_child_as_failed(hosted, bridge):
    hosted.claims.append([claim(1, goal="lost"), claim(2, goal="failed")])
    hosted.runs["lost"] = lambda child: {"status": "interrupted", "summary": None, "api_calls": 1, "duration_seconds": 0}
    hosted.runs["failed"] = lambda child: {"status": "error", "summary": None, "error": "provider 500", "api_calls": 1, "duration_seconds": 0}
    root_turn(hosted)
    settle_watchers()
    outcomes = {r["attemptCredential"]: r["outcome"] for r in bridge.bodies("automata/report")}
    assert outcomes[claim(1)["credential"]] == {"kind": "lost", "code": "child_interrupted"}
    assert outcomes[claim(2)["credential"]] == {"kind": "failed", "code": "child_failed"}


def test_a_core_cancel_reaches_the_child_through_its_heartbeat(hosted, bridge):
    hosted.claims.append([claim(1, lease_ms=150, goal="long")])
    hosted.heartbeat = lambda body: (200, {"status": "cancel_requested", "attempt": 1})

    def long(child):
        deadline = time.monotonic() + 5
        while not child.interrupted and time.monotonic() < deadline:
            time.sleep(0.01)
        return {"status": "interrupted", "summary": None, "api_calls": 1, "duration_seconds": 0}

    hosted.runs["long"] = long
    root_turn(hosted)
    settle_watchers()
    assert bridge.bodies("automata/heartbeat")
    [report] = bridge.bodies("automata/report")
    assert report["outcome"] == {"kind": "cancelled"}


def test_a_child_whose_attempt_core_ended_is_stopped_and_not_reported(hosted, bridge):
    hosted.claims.append([claim(1, lease_ms=150, goal="long")])
    hosted.heartbeat = lambda body: (410, {"error": {"kind": "attempt_ended", "detail": "the attempt ended (lost:lease_expired)"}})
    stopped = threading.Event()

    def long(child):
        deadline = time.monotonic() + 5
        while not child.interrupted and time.monotonic() < deadline:
            time.sleep(0.01)
        stopped.set()
        return {"status": "interrupted", "summary": None, "api_calls": 1, "duration_seconds": 0}

    hosted.runs["long"] = long
    root_turn(hosted)
    settle_watchers()
    assert stopped.wait(5)
    assert bridge.bodies("automata/report") == []


def test_attempts_of_different_automata_run_at_once(hosted, bridge):
    hosted.claims.append([claim(1, goal="a"), claim(2, goal="b")])
    both = threading.Barrier(2, timeout=5)

    def meets(child):
        both.wait()  # neither child finishes until the other is running too
        return completes(child)

    hosted.runs["a"] = meets
    hosted.runs["b"] = meets
    root_turn(hosted)
    settle_watchers()
    assert sorted(r["attemptCredential"] for r in bridge.bodies("automata/bus")) == sorted([claim(1)["credential"], claim(2)["credential"]])
    assert [r["outcome"]["kind"] for r in bridge.bodies("automata/report")] == ["succeeded", "succeeded"]


def test_no_attempt_is_claimed_when_hermes_no_longer_declares_its_child_budget(hosted, bridge, monkeypatch):
    monkeypatch.delattr("tools.delegate_tool.DEFAULT_MAX_ITERATIONS")
    hosted.claims.append([claim(1)])
    context = root_turn(hosted)
    assert bridge.bodies("automata/claim") == []
    assert "DEFAULT_MAX_ITERATIONS" in context


def test_subagent_children_and_cron_turns_never_claim(hosted, bridge):
    from agent.subagent_lifecycle import bind_subagent_parent

    with bind_subagent_parent(hosted.parent):
        fire("pre_llm_call", **{**turn(session="child-x"), "platform": "subagent"})
        fire("pre_llm_call", **{**turn(session="cron-x"), "platform": "cron"})
    assert bridge.bodies("automata/claim") == []


# -- the Hermes facts the host relies on, read from the pinned source ---------


def _source_tree(function):
    return ast.parse(textwrap.dedent(inspect.getsource(function)))


def test_hermes_launches_every_lifecycle_child_with_the_default_iteration_budget():
    from agent.subagent_lifecycle import SubagentLaunchRequest, SubagentLifecycleService

    calls = [n for n in ast.walk(_source_tree(SubagentLifecycleService.launch))
             if isinstance(n, ast.Call) and getattr(n.func, "id", None) == "_build_child_preserving_parent_tools"]
    assert len(calls) == 1
    budget = {k.arg: k.value for k in calls[0].keywords}["max_iterations"]
    assert isinstance(budget, ast.Name) and budget.id == "DEFAULT_MAX_ITERATIONS"
    # The public request has no per-launch budget field, so the host declares this one to core.
    assert "max_iterations" not in SubagentLaunchRequest.__dataclass_fields__


def test_hermes_announces_each_child_session_through_subagent_start_while_building_it():
    from tools.delegate_tool import _build_child_agent, _build_child_preserving_parent_tools

    hooks = [n for n in ast.walk(_source_tree(_build_child_agent))
             if isinstance(n, ast.Call) and n.args and isinstance(n.args[0], ast.Constant) and n.args[0].value == "subagent_start"]
    assert len(hooks) == 1
    keywords = {k.arg: ast.unparse(k.value) for k in hooks[0].keywords}
    assert keywords["child_session_id"] == "getattr(child, 'session_id', None)"
    assert keywords["child_subagent_id"] == "subagent_id"
    assert "_build_child_agent(" in inspect.getsource(_build_child_preserving_parent_tools)
