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


def call_tool(tool: str, action: str, **args):
    from tools.registry import registry

    raw = registry.dispatch(f"mcp__{SERVER}__{tool}", {"action": action, **args})
    text = raw if isinstance(raw, str) else json.dumps(raw)
    assert '"error"' not in text, f"{tool}.{action} failed: {text[:500]}"
    return text


def fire(name, **kwargs):
    from hermes_cli.lifecycle import invoke_hook

    return invoke_hook(name, **kwargs)


def hermes_turn(session, turn_id, message, *, reply=None, interrupted=False, failed=False):
    [result] = fire("pre_llm_call", session_id=session, task_id="task", turn_id=turn_id, user_message=message, conversation_history=[], is_first_turn=False,
                    model="m", platform="cli", parent_session_id="", sender_id="")
    if reply is not None:
        fire("post_llm_call", session_id=session, task_id="task", turn_id=turn_id, user_message=message, assistant_response=reply, conversation_history=[], model="m", platform="cli")
    fire("on_session_end", session_id=session, task_id="task", turn_id=turn_id, completed=not (interrupted or failed), failed=failed, interrupted=interrupted,
         turn_exit_reason="interrupted_by_user" if interrupted else ("provider error" if failed else "text_response"), model="m", platform="cli")
    return result["context"]


def test_hermes_reaches_the_governed_tools_over_its_own_mcp_client(operator):
    for tool in ("journal", "memory", "automata", "free_time", "activity", "session", "orient"):
        assert f"mcp__{SERVER}__{tool}" in operator
    call_tool("journal", "write", path="garden/seeds.md", body="Tomatoes, beans and marigolds this spring.")
    assert "garden/seeds.md" in call_tool("journal", "list", limit=10)
    call_tool("memory", "write", writeId="hermes-e2e-1", kind="fact", content="Robin is planting marigolds beside the beans.", sensitivity="personal")
    call_tool("memory", "census")
    call_tool("automata", "status", limit=5)
    call_tool("free_time", "status")
    assert "Sorting the seed packets for spring" in call_tool("activity", "recent", limit=5)


def test_a_hermes_turn_sees_the_standalone_turns_activity_and_archives_every_outcome(operator, profile):
    context = hermes_turn("e2e-1", "e2e-1:t1", "what have you been up to?", reply="Sorting the seed packets.")
    assert "[internal signal: activity]" in context
    assert "Sorting the seed packets for spring" in context and "in another conversation" in context
    hermes_turn("e2e-1", "e2e-1:t2", "tell me everything", interrupted=True)
    hermes_turn("e2e-1", "e2e-1:t3", "and then?", failed=True)
    assert plugin_module("runtime").driver().ledger.pending() == []
    # The same Hermes turn again is replayed by Lite, not recorded twice.
    [again] = fire("pre_llm_call", session_id="e2e-1", task_id="task", turn_id="e2e-1:t1", user_message="what have you been up to?", conversation_history=[], is_first_turn=False,
                   model="m", platform="cli", parent_session_id="", sender_id="")
    assert "already recorded this turn as completed" in again["context"]

    messages = call_tool("session", "messages", limit=20)
    for text in ("what have you been up to?", "Sorting the seed packets.", "turn interrupted by participant", "turn failed: hermes_turn_failed"):
        assert text in messages
    # Compaction is allowed: Lite proves every turn of the session.
    from agent.memory_manager import MemoryManager

    manager = MemoryManager()
    manager.add_provider(plugin_module("provider").PsfnLiteProvider())
    manager._providers[-1].initialize("e2e-1", hermes_home=str(profile), platform="cli")
    manager.on_pre_compress([], evidence_messages=[], require_checkpoint=True)


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
