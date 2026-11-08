"""Turn integrity inside the pinned Hermes: paths where Hermes reports no end, session rotation, lost prepares,
restarts, subagents inside internal turns, and the gate on Lite's governed tools.

The failed-turn test runs Hermes's real ``AIAgent.run_conversation`` against a provider that answers HTTP 403,
the shape of Hermes's own tests/run_agent/test_nonretryable_error_html_summary.py. That path returns before
``finalize_turn``, so Hermes fires ``pre_llm_call`` and never ``on_session_end``.
"""

import os
import subprocess
import sys
from unittest.mock import MagicMock, patch

from conftest import CREDENTIAL, CREDENTIAL_ENV, plugin_module, write_profile
from test_host_contract import end, fire, load_provider, turn

UNAVAILABLE = (503, {"error": {"kind": "unavailable", "capability": "postgres", "detail": "x"}})


def gate(tool, *, session="sess-1", turn_id="sess-1:task:aa"):
    """The block message Hermes's tool dispatch would use for this call, or None when it runs."""
    from hermes_cli.plugins import resolve_pre_tool_block

    return resolve_pre_tool_block(tool, {}, task_id="task", session_id=session, tool_call_id="c1", turn_id=turn_id)


def failing_agent():
    import run_agent  # noqa: F401  (patch targets)
    from run_agent import AIAgent

    with patch("run_agent.get_tool_definitions", return_value=[]), patch("run_agent.check_toolset_requirements", return_value={}), patch("run_agent.OpenAI"):
        agent = AIAgent(api_key="test-key-1234567890", base_url="https://api.openai.com/v1", provider="openai", api_mode="chat_completions",
                        model="gpt-5.5", quiet_mode=True, skip_context_files=True, skip_memory=True, platform="cli", session_id="real-1")
    agent.client = MagicMock()
    agent._cached_system_prompt = "You are helpful."
    agent._use_prompt_caching = False
    agent.compression_enabled = False
    agent.save_trajectories = False
    error = Exception("forbidden")
    error.status_code = 403
    agent.client.chat.completions.create.side_effect = error
    return agent


def test_a_turn_hermes_fails_without_on_session_end_is_settled_as_failed_before_the_next_turn(profile, bridge):
    warnings = []
    load_provider().initialize("real-1", hermes_home=str(profile), platform="cli", warning_callback=warnings.append)
    agent = failing_agent()
    with patch.object(agent, "_persist_session"), patch.object(agent, "_save_trajectory"), patch.object(agent, "_cleanup_task_resources"):
        result = agent.run_conversation("hello")
    assert result.get("failed") is True
    # Hermes prepared the turn through the real hook and returned without on_session_end.
    assert [r["route"] for r in bridge.requests] == ["prepare"]
    assert bridge.requests[0]["body"]["message"] == "hello"

    [context] = [r["context"] for r in fire("pre_llm_call", **turn(session="real-1", turn_id="real-1:task:next", message="are you there?"))]
    assert [r["route"] for r in bridge.requests] == ["prepare", "settle", "prepare"]
    [settle] = bridge.bodies("settle")
    assert settle["turnId"] == "turn-1"
    assert settle["outcome"]["kind"] == "failed" and settle["outcome"]["error"]["code"] == "hermes_turn_unfinished"
    assert "recorded in your continuity as failed" in context
    assert any("Hermes did not report how it ended" in w for w in warnings)
    assert [row["turn_id"] for row in plugin_module("runtime").driver().ledger.turns()] == ["turn-2"]


def test_a_turn_still_open_when_hermes_closes_the_session_is_settled_as_failed(profile, bridge):
    load_provider()
    fire("pre_llm_call", **turn(turn_id="t-1"))
    fire("on_session_finalize", session_id="sess-1", platform="cli", reason="session_boundary")
    [settle] = bridge.bodies("settle")
    assert settle["outcome"]["error"]["code"] == "hermes_turn_unfinished"
    # A late end for that turn is reported, not silently dropped, and nothing settles twice.
    warnings = []
    plugin_module("runtime").add_warning_callback(warnings.append)
    fire("on_session_end", **end(turn_id="t-1"))
    assert len(bridge.bodies("settle")) == 1
    assert any("after it was recorded in your continuity as unfinished" in w for w in warnings)


def test_other_sessions_open_turns_are_left_running(profile, bridge):
    load_provider()
    fire("pre_llm_call", **turn(session="sess-a", turn_id="a-1"))
    fire("pre_llm_call", **turn(session="sess-b", turn_id="b-1"))
    assert bridge.bodies("settle") == []
    fire("post_llm_call", session_id="sess-a", task_id="task", turn_id="a-1", user_message="q", assistant_response="A's reply", conversation_history=[], model="m", platform="cli")
    fire("on_session_end", **end(session="sess-a", turn_id="a-1"))
    assert [b["outcome"].get("reply") for b in bridge.bodies("settle")] == ["A's reply"]


def test_a_compression_that_rotates_the_session_mid_turn_keeps_the_turn(profile, bridge):
    load_provider()
    fire("pre_llm_call", **turn(session="C", turn_id="C:task:1"))
    # Hermes's compression set agent.session_id to C2 during the turn; the later hooks carry it.
    fire("post_tool_call", tool_name="mcp__psfn_lite__memory", args={}, result="{}", task_id="task", session_id="C2", tool_call_id="c1", turn_id="C:task:1", api_request_id="", duration_ms=1, status="ok")
    fire("post_llm_call", session_id="C2", task_id="task", turn_id="C:task:1", user_message="q", assistant_response="after compression", conversation_history=[], model="m", platform="cli")
    fire("on_session_end", **end(session="C2", turn_id="C:task:1"))
    [settle] = bridge.bodies("settle")
    assert settle["outcome"] == {"kind": "completed", "reply": "after compression", "delivery": "unknown"}
    assert settle["toolCallCount"] == 1
    # The next turn of the rotated session prepares normally, and checkpoint covers the earlier turn.
    fire("pre_llm_call", **turn(session="C2", turn_id="C2:task:2", parent="C"))
    assert len(bridge.bodies("prepare")) == 2 and len(bridge.bodies("settle")) == 1
    plugin_module("runtime").driver().checkpoint("C2")
    assert bridge.bodies("checkpoint")[-1] == {"turnIds": ["turn-1", "turn-2"]}


def test_a_prepare_whose_answer_was_lost_is_prepared_again_under_the_same_key(profile, bridge):
    load_provider()
    first = []

    def lose_first(route, body):
        if not first:
            first.append(body)
            return UNAVAILABLE
        return bridge.default(route, body)

    bridge.handlers["prepare"] = lose_first
    [result] = fire("pre_llm_call", **turn(turn_id="t-1"))
    keys = [b["idempotencyKey"] for b in bridge.bodies("prepare")]
    assert len(keys) == 2 and keys[0] == keys[1]
    assert "unavailable" not in result["context"]
    fire("on_session_end", **end(turn_id="t-1", completed=False, failed=True))
    assert [b["turnId"] for b in bridge.bodies("settle")] == ["turn-1"]


def test_a_turn_lite_never_answered_is_found_by_its_key_and_settled_with_its_actual_outcome(profile, bridge):
    load_provider()
    bridge.handlers["prepare"] = lambda route, body: UNAVAILABLE
    [result] = fire("pre_llm_call", **turn(turn_id="t-1"))
    assert "continuity is unavailable" in result["context"]
    # The bound sender's turn may still use Lite's tools; Lite itself decides whether they work.
    assert gate("mcp__psfn_lite__memory", turn_id="t-1") is None
    fire("post_llm_call", session_id="sess-1", task_id="task", turn_id="t-1", user_message="q", assistant_response="answered without Lite", conversation_history=[], model="m", platform="cli")
    fire("on_session_end", **end(turn_id="t-1"))
    # Still unreachable: the outcome and the prepare that finds its turn are kept, and compaction is refused.
    assert [e["kind"] for e in plugin_module("runtime").driver().ledger.pending()] == ["settle"]
    del bridge.handlers["prepare"]
    fire("pre_llm_call", **turn(turn_id="t-2"))
    routes = [r["route"] for r in bridge.requests]
    assert routes[-3:] == ["prepare", "settle", "prepare"]
    late_prepare, _, current = bridge.bodies("prepare")[-3:]
    assert late_prepare["idempotencyKey"] == bridge.bodies("prepare")[0]["idempotencyKey"] != current["idempotencyKey"]
    assert bridge.bodies("settle")[-1] == {"hostInstance": late_prepare["hostInstance"], "turnId": "turn-1", "outcome": {"kind": "completed", "reply": "answered without Lite", "delivery": "unknown"}, "toolCallCount": 0}
    assert plugin_module("runtime").driver().ledger.pending() == []


def test_a_restarted_process_settles_the_turns_an_exited_process_left_open(profile, bridge):
    from psfn_lite.ledger import STANDING, Ledger

    exited = subprocess.Popen([sys.executable, "-c", "pass"])
    exited.wait()
    ledger = Ledger(profile, bridge_url=bridge.url)
    body = {"hostInstance": "hermes-old-1", "idempotencyKey": "hermes:" + "a" * 40, "message": "hi"}
    known = ledger.open_turn(session_id="old-s", host_instance="hermes-old-1", scope=STANDING, pid=exited.pid, hermes_turn="old:1", prepare=body)
    ledger.bind_turn(known, "turn-known")
    ledger.open_turn(session_id="old-s", host_instance="hermes-old-1", scope=STANDING, pid=exited.pid, hermes_turn="old:2", prepare=body)
    # A live process's turn is left alone.
    ledger.open_turn(session_id="live-s", host_instance="hermes-live-1", scope=STANDING, pid=os.getpid(), hermes_turn="live:1", prepare=body)

    load_provider()
    fire("pre_llm_call", **turn())
    settles = bridge.bodies("settle")
    assert [(s["hostInstance"], s["turnId"], s["outcome"]["error"]["code"]) for s in settles] == [("hermes-old-1", "turn-known", "hermes_process_ended"), ("hermes-old-1", "turn-1", "hermes_process_ended")]
    # The unbound row was found by preparing its kept key again, with the exited process's instance.
    assert bridge.bodies("prepare")[0] == body
    assert [r["host_instance"] for r in plugin_module("runtime").driver().ledger.turns()] == ["hermes-live-1", plugin_module("runtime").driver().instance]


def test_a_subagent_inside_an_internal_turn_never_drives_the_turn_or_uses_lite_tools(profile, bridge, monkeypatch):
    monkeypatch.setenv("PSFN_LITE_INTERNAL_JOB", "1")
    load_provider()
    fire("pre_llm_call", **turn(session="job-s", turn_id="job:1", message="[system note: free_time]\nopen"))
    fire("subagent_start", parent_session_id="job-s", parent_turn_id="job:1", parent_subagent_id=None, child_session_id="child-1", child_subagent_id="s1", child_role="leaf", child_goal="g")
    assert fire("pre_llm_call", **turn(session="child-1", turn_id="c:1", platform="subagent", parent="job-s")) == []
    assert gate("mcp__psfn_lite__free_time", session="child-1", turn_id="c:1") is not None
    fire("post_llm_call", session_id="child-1", task_id="t", turn_id="c:1", user_message="x", assistant_response="SUBAGENT OUTPUT", conversation_history=[], model="m", platform="subagent")
    fire("on_session_end", **end(session="child-1", turn_id="c:1"))
    # The review fork shares the job's session and is skipped too.
    assert fire("pre_llm_call", **turn(session="job-s", turn_id="review:1", parent="job-s")) == []
    assert gate("mcp__psfn_lite__free_time", session="job-s", turn_id="job:1") is None
    fire("post_llm_call", session_id="job-s", task_id="t", turn_id="job:1", user_message="x", assistant_response="my own time", conversation_history=[], model="m", platform="cli")
    fire("on_session_end", **end(session="job-s", turn_id="job:1"))
    assert len(bridge.bodies("prepare")) == 1
    assert [b["outcome"] for b in bridge.bodies("settle")] == [{"kind": "completed", "reply": "my own time", "delivery": "unknown"}]


def test_lite_tools_run_only_inside_an_open_lite_turn(profile, bridge):
    load_provider()
    # No Lite turn: blocked, with a message the model sees. Other tools are not the plugin's business.
    assert "only inside a turn recorded" in gate("mcp__psfn_lite__memory")
    assert gate("terminal") is None and gate("mcp__other__thing") is None
    # An unbound sender's turn: its Lite tool calls are refused, though the MCP client holds the standing credential.
    fire("pre_llm_call", **turn(session="stranger", turn_id="s:1", platform="telegram", sender="9999"))
    assert gate("mcp__psfn_lite__memory", session="stranger", turn_id="s:1") is not None
    # A bound root turn may use them until it ends.
    fire("pre_llm_call", **turn())
    assert gate("mcp__psfn_lite__memory") is None
    fire("on_session_end", **end())
    assert gate("mcp__psfn_lite__memory") is not None
    # Subagents and cron agents of the bound conversation are refused.
    assert gate("mcp__psfn_lite__memory", session="child-1", turn_id="child-1:task:1") is not None


def test_lite_tools_are_blocked_while_the_profile_is_not_usable(profile, bridge, monkeypatch):
    load_provider()
    monkeypatch.delenv(CREDENTIAL_ENV)
    assert "plugin is not usable" in gate("mcp__psfn_lite__memory")
    assert gate("terminal") is None
    monkeypatch.setenv(CREDENTIAL_ENV, CREDENTIAL)
    write_profile(profile, bridge_url=bridge.url, memory_enabled=True)
    fire("pre_llm_call", **turn())
    assert "plugin is not usable" in gate("mcp__psfn_lite__memory")
    # Which MCP server is Lite's is unknown without the plugin's config, so every MCP tool is blocked.
    (profile / "psfn-lite.json").write_text("{")
    assert gate("mcp__other__thing") is not None and gate("terminal") is None
