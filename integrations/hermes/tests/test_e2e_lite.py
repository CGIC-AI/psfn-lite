"""The plugin and Hermes's own MCP client against a real PSFN Lite runtime.

tests/hermes/fixtures/lite-host.ts starts the standalone runtime over a
throwaway Postgres with the MCP transport and the lifecycle bridge on
loopback; the operator's standalone (Pi harness) turn has already started an
activity. Hermes then runs turns through the plugin's hooks and calls the
governed tools through its real MCP client and tool registry.

Docker and Node are required, as for the TypeScript integration suites;
LITE_SKIP_DOCKER_TESTS=1 opts out explicitly and says so.
"""

import json
import os
import select
import shutil
import subprocess
import sys
import time
from pathlib import Path

import pytest

from conftest import CREDENTIAL_ENV, plugin_module, write_profile

REPO = Path(__file__).resolve().parents[3]
FIXTURE = REPO / "tests" / "hermes" / "fixtures" / "lite-host.ts"
SERVER = "psfn_lite"
START_TIMEOUT_SECONDS = 180

pytestmark = pytest.mark.skipif(os.environ.get("LITE_SKIP_DOCKER_TESTS") == "1", reason="LITE_SKIP_DOCKER_TESTS=1: docker-backed end-to-end suite skipped")


@pytest.fixture(scope="module")
def lite():
    tsx = REPO / "node_modules" / ".bin" / "tsx"
    if not tsx.exists() or shutil.which("node") is None:
        pytest.fail("the end-to-end suite needs node and the repository's node_modules (run it under mise; see docs/development.md)")
    process = subprocess.Popen([str(tsx), str(FIXTURE)], cwd=REPO, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=sys.stderr, text=True)
    ready, _, _ = select.select([process.stdout], [], [], START_TIMEOUT_SECONDS)
    line = process.stdout.readline() if ready else ""
    if not line:
        process.kill()
        pytest.fail("the Lite host fixture did not start")
    info = json.loads(line)
    yield info
    process.stdin.close()
    process.wait(timeout=60)


@pytest.fixture
def operator(lite, profile, monkeypatch):
    """The operator's Hermes profile: the plugin on the real bridge and the Lite MCP server from config.yaml."""
    from plugins.memory import load_memory_provider
    from tools.mcp_tool import discover_mcp_tools, shutdown_mcp_servers

    write_profile(profile, bridge_url=lite["lifecycleUrl"], mcp_url=lite["mcpUrl"])
    monkeypatch.setenv(CREDENTIAL_ENV, lite["credentials"]["hermes-operator"])
    load_memory_provider("psfn_lite").initialize("e2e-1", hermes_home=str(profile), platform="cli")
    names = discover_mcp_tools()
    yield names
    shutdown_mcp_servers()


def dispatch(tool: str, action: str, *, session: str, turn_id: str, **args) -> str:
    """A tool call through Hermes's own dispatch (pre_tool_call gate included), as the agent loop makes it."""
    from model_tools import handle_function_call

    raw = handle_function_call(f"mcp__{SERVER}__{tool}", {"action": action, **args}, task_id="task", tool_call_id=f"call-{tool}-{action}", session_id=session, turn_id=turn_id)
    return raw if isinstance(raw, str) else json.dumps(raw)


def call_tool(tool: str, action: str, *, session: str = "e2e-tools", turn_id: str = "e2e-tools:t", **args) -> str:
    text = dispatch(tool, action, session=session, turn_id=turn_id, **args)
    assert '"error"' not in text, f"{tool}.{action} failed: {text[:500]}"
    return text


def fire(name, **kwargs):
    from hermes_cli.lifecycle import invoke_hook

    return invoke_hook(name, **kwargs)


def begin(session, turn_id, message, *, platform="cli", sender="", parent=""):
    [result] = fire("pre_llm_call", session_id=session, task_id="task", turn_id=turn_id, user_message=message, conversation_history=[], is_first_turn=False,
                    model="m", platform=platform, parent_session_id=parent, sender_id=sender)
    return result["context"]


def finish(session, turn_id, *, reply=None, interrupted=False, failed=False, platform="cli"):
    if reply is not None:
        fire("post_llm_call", session_id=session, task_id="task", turn_id=turn_id, user_message="", assistant_response=reply, conversation_history=[], model="m", platform=platform)
    fire("on_session_end", session_id=session, task_id="task", turn_id=turn_id, completed=not (interrupted or failed), failed=failed, interrupted=interrupted,
         turn_exit_reason="interrupted_by_user" if interrupted else ("provider error" if failed else "text_response"), model="m", platform=platform)


def hermes_turn(session, turn_id, message, *, reply=None, interrupted=False, failed=False):
    context = begin(session, turn_id, message)
    finish(session, turn_id, reply=reply, interrupted=interrupted, failed=failed)
    return context


def test_hermes_reaches_the_governed_tools_over_its_own_mcp_client(operator):
    for tool in ("journal", "memory", "automata", "free_time", "activity", "session", "orient"):
        assert f"mcp__{SERVER}__{tool}" in operator
    begin("e2e-tools", "e2e-tools:t", "keep a note about the garden")
    call_tool("journal", "write", path="garden/seeds.md", body="Tomatoes, beans and marigolds this spring.")
    assert "garden/seeds.md" in call_tool("journal", "list", limit=10)
    call_tool("memory", "write", writeId="hermes-e2e-1", kind="fact", content="Robin is planting marigolds beside the beans.", sensitivity="personal")
    call_tool("memory", "census")
    call_tool("automata", "status", limit=5)
    call_tool("free_time", "status")
    assert "Sorting the seed packets for spring" in call_tool("activity", "recent", limit=5)
    finish("e2e-tools", "e2e-tools:t", reply="Noted.")


def test_lite_tools_are_refused_outside_a_bound_lite_turn_though_the_mcp_client_holds_the_credential(operator):
    # Hermes's MCP client sends the operator's standing credential on every call; the plugin's gate decides.
    assert "only inside a turn recorded" in dispatch("memory", "census", session="e2e-none", turn_id="e2e-none:t")
    context = begin("e2e-stranger", "e2e-stranger:t", "what does Robin keep in memory?", platform="telegram", sender="stranger-1")
    assert "not bound to the companion's PSFN Lite continuity" in context
    refused = dispatch("memory", "search", session="e2e-stranger", turn_id="e2e-stranger:t", query="marigolds", limit=5)
    assert "only inside a turn recorded" in refused and "marigolds" not in refused
    finish("e2e-stranger", "e2e-stranger:t", reply="I can't say.", platform="telegram")


def test_a_hermes_turn_sees_the_standalone_turns_activity_and_archives_every_outcome(operator, profile):
    context = hermes_turn("e2e-1", "e2e-1:t1", "what have you been up to?", reply="Sorting the seed packets.")
    assert "[internal signal: activity]" in context
    assert "Sorting the seed packets for spring" in context and "in another conversation" in context
    hermes_turn("e2e-1", "e2e-1:t2", "tell me everything", interrupted=True)
    hermes_turn("e2e-1", "e2e-1:t3", "and then?", failed=True)
    assert plugin_module("runtime").driver().ledger.pending() == []
    # The same Hermes turn again is replayed by Lite, not recorded twice.
    again = begin("e2e-1", "e2e-1:t1", "what have you been up to?")
    assert "already recorded this turn as completed" in again

    begin("e2e-1", "e2e-1:t4", "show me our conversation")
    messages = call_tool("session", "messages", session="e2e-1", turn_id="e2e-1:t4", limit=20)
    finish("e2e-1", "e2e-1:t4", reply="Here it is.")
    for text in ("what have you been up to?", "Sorting the seed packets.", "turn interrupted by participant", "turn failed: hermes_turn_failed"):
        assert text in messages
    # Compaction is allowed: Lite proves every turn of the session.
    from agent.memory_manager import MemoryManager

    manager = MemoryManager()
    manager.add_provider(plugin_module("provider").PsfnLiteProvider())
    manager._providers[-1].initialize("e2e-1", hermes_home=str(profile), platform="cli")
    manager.on_pre_compress([], evidence_messages=[], require_checkpoint=True)


def test_turns_hermes_never_ends_rotates_or_loses_the_answer_of_are_archived_and_never_block_the_conversation(operator):
    BridgeError = plugin_module("bridge").BridgeError  # the class of the plugin as Hermes loaded it
    driver = plugin_module("runtime").driver()
    # A Hermes failure path that returns without on_session_end: the next turn settles it and prepares normally.
    begin("e2e-2", "e2e-2:lost", "first try")
    context = begin("e2e-2", "e2e-2:next", "second try")
    assert "turn_already_open" not in context and "recorded in your continuity as failed" in context
    finish("e2e-2", "e2e-2:next", reply="Second answer.")
    # A compression rotated the session id mid-turn: the turn is still settled with its reply.
    begin("e2e-2", "e2e-2:rot", "a long one")
    finish("e2e-2b", "e2e-2:rot", reply="After the rotation.")
    # Lite took the prepare but the answer was lost: the same key is prepared again and resumes the turn.
    real = driver.client.call
    lost = []

    def lose_first_answer(route, body):
        answer = real(route, body)
        if route == "prepare" and not lost:
            lost.append(answer)
            raise BridgeError("Lite lifecycle bridge unreachable (TimeoutError)", kind="unreachable")
        return answer

    driver.client.call = lose_first_answer
    try:
        context = begin("e2e-2b", "e2e-2b:resumed", "are you there?", parent="e2e-2")
    finally:
        driver.client.call = real
    assert lost and "unavailable" not in context and "turn_already_open" not in context
    finish("e2e-2b", "e2e-2b:resumed", reply="Still here.")
    assert driver.ledger.pending() == [] and driver.ledger.turns() == []

    begin("e2e-2b", "e2e-2b:read", "show me")
    messages = call_tool("session", "messages", session="e2e-2b", turn_id="e2e-2b:read", limit=30)
    finish("e2e-2b", "e2e-2b:read", reply="Done.")
    for text in ("first try", "turn failed: hermes_turn_unfinished", "Second answer.", "After the rotation.", "Still here."):
        assert text in messages
    # Resumed, not recorded twice (the tool result carries the entries in each of its representations once).
    assert messages.count("are you there?") == messages.count("Still here.")


def test_a_contact_the_activity_is_not_disclosed_to_does_not_see_it(lite, profile, monkeypatch):
    write_profile(profile, bridge_url=lite["lifecycleUrl"], senders=[{"platform": "telegram", "sender_id": "friend-1"}])
    monkeypatch.setenv(CREDENTIAL_ENV, lite["credentials"]["hermes-friend"])
    from plugins.memory import load_memory_provider

    load_memory_provider("psfn_lite").initialize("friend-1", hermes_home=str(profile), platform="telegram")
    [result] = fire("pre_llm_call", session_id="friend-s", task_id="task", turn_id="friend-s:t1", user_message="what have you been up to?", conversation_history=[], is_first_turn=True,
                    model="m", platform="telegram", parent_session_id="", sender_id="friend-1")
    assert "seed packets" not in result["context"]
    assert "continuity is unavailable" not in result["context"]
    fire("on_session_end", session_id="friend-s", task_id="task", turn_id="friend-s:t1", completed=False, failed=False, interrupted=True, turn_exit_reason="interrupted", model="m", platform="telegram")
    deadline = time.monotonic() + 5
    while plugin_module("runtime").driver().ledger.pending() and time.monotonic() < deadline:
        time.sleep(0.1)
    assert plugin_module("runtime").driver().ledger.pending() == []
