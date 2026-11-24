"""The plugin and Hermes's own MCP client against a real PSFN Lite runtime.

tests/hermes/fixtures/lite-host.ts starts the standalone runtime (the
extracted donor companion core) over a throwaway Postgres with the MCP
transport and the lifecycle bridge on loopback; the operator's own Pi turn
has already noted what Robin is doing as one of the companion's
open threads, scoped to Robin. Hermes then runs host-driven turns through the plugin's hooks
and calls the companion's tools through its real MCP client and tool
registry, so the donor runs every call in its own tool loop.

Docker and Node are required, as for the TypeScript integration suites;
LITE_SKIP_DOCKER_TESTS=1 opts out explicitly and says so.
"""

import json
import os
import re
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
    process = subprocess.Popen([shutil.which("node"), "--import", "tsx", str(FIXTURE)], cwd=REPO, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=sys.stderr, text=True)
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
    from conformance_runner import hermes_mcp

    discover_mcp_tools, shutdown_mcp_servers = hermes_mcp()

    write_profile(profile, bridge_url=lite["lifecycleUrl"], mcp_url=lite["mcpUrl"], install_id=lite["hermesInstallId"])
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


SEED_THREAD = "Robin is sorting the seed packets for spring"


@pytest.fixture
def human(monkeypatch):
    """Hermes's interactive CLI approval prompt, answered by the test as its human would."""
    from tools.terminal_tool import set_approval_callback

    prompts = []
    answer = {"choice": "deny"}

    def prompt(command, description, **_):
        prompts.append(description)
        return answer["choice"]

    monkeypatch.setenv("HERMES_INTERACTIVE", "1")
    set_approval_callback(prompt)
    yield prompts, answer
    set_approval_callback(None)


def test_hermes_reaches_the_companion_tools_over_its_own_mcp_client(operator):
    for tool in ("journal", "memory", "orient", "concerns", "scratchpad", "session", "contact", "tool_search", "execute"):
        assert f"mcp__{SERVER}__{tool}" in operator
    begin("e2e-tools", "e2e-tools:t", "keep a note about the garden")
    call_tool("journal", "write", path="garden/seeds.md", content="Tomatoes, beans and marigolds this spring.")
    assert "garden/seeds.md" in call_tool("journal", "list")
    assert "Memory created" in call_tool("memory", "write", text="Robin is planting marigolds beside the beans.", type="semantic", sensitivity="personal")
    assert "Robin is planting marigolds beside the beans." in call_tool("memory", "search", query="marigolds")
    assert SEED_THREAD in call_tool("concerns", "list")
    finish("e2e-tools", "e2e-tools:t", reply="Noted.")


def test_lite_tools_are_refused_outside_a_bound_lite_turn_though_the_mcp_client_holds_the_credential(operator):
    # Hermes's MCP client sends the operator's standing credential on every call; the plugin's gate decides.
    assert "only inside a turn recorded" in dispatch("memory", "search", session="e2e-none", turn_id="e2e-none:t", query="marigolds")
    context = begin("e2e-stranger", "e2e-stranger:t", "what does Robin keep in memory?", platform="telegram", sender="stranger-1")
    assert "not bound to the companion's PSFN Lite continuity" in context
    refused = dispatch("memory", "search", session="e2e-stranger", turn_id="e2e-stranger:t", query="marigolds", limit=5)
    assert "only inside a turn recorded" in refused and "marigolds" not in refused
    finish("e2e-stranger", "e2e-stranger:t", reply="I can't say.", platform="telegram")


def test_a_hermes_turn_sees_the_standalone_turns_open_thread_and_every_outcome_is_settled(operator, profile):
    context = hermes_turn("e2e-1", "e2e-1:t1", "what have you been up to?", reply="Sorting the seed packets.")
    assert "[system note: companion context]" in context and SEED_THREAD in context
    hermes_turn("e2e-1", "e2e-1:t2", "tell me everything", interrupted=True)
    hermes_turn("e2e-1", "e2e-1:t3", "and then?", failed=True)
    assert plugin_module("runtime").driver().ledger.pending() == []
    # The same Hermes turn again is replayed by Lite, not recorded twice.
    again = begin("e2e-1", "e2e-1:t1", "what have you been up to?")
    assert "already recorded this turn" in again

    # The next turn's donor context carries the completed exchange as the session's history.
    context = begin("e2e-1", "e2e-1:t4", "show me our conversation")
    assert "what have you been up to?" in context
    assert "[your own earlier reply]\nSorting the seed packets." in context
    found = call_tool("session", "grep", session="e2e-1", turn_id="e2e-1:t4", pattern="seed packets")
    finish("e2e-1", "e2e-1:t4", reply="Here it is.")
    assert "Sorting the seed packets." in found
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

    # The rotated conversation is one Lite session: its next turn's donor context holds every completed exchange, the resumed one once.
    context = begin("e2e-2b", "e2e-2b:read", "show me")
    finish("e2e-2b", "e2e-2b:read", reply="Done.")
    for text in ("Second answer.", "After the rotation.", "Still here."):
        assert f"[your own earlier reply]\n{text}" in context
    assert context.count("[your own earlier reply]\nStill here.") == 1


def test_a_contact_the_operator_thread_is_not_disclosed_to_does_not_see_it(lite, profile, monkeypatch):
    write_profile(profile, bridge_url=lite["lifecycleUrl"], senders=[{"platform": "telegram", "sender_id": "friend-1"}], install_id=lite["hermesInstallId"])
    monkeypatch.setenv(CREDENTIAL_ENV, lite["credentials"]["hermes-friend"])
    from plugins.memory import load_memory_provider

    load_memory_provider("psfn_lite").initialize("friend-1", hermes_home=str(profile), platform="telegram")
    [result] = fire("pre_llm_call", session_id="friend-s", task_id="task", turn_id="friend-s:t1", user_message="what have you been up to?", conversation_history=[], is_first_turn=True,
                    model="m", platform="telegram", parent_session_id="", sender_id="friend-1")
    assert "seed packets" not in result["context"] and "[system note: companion context]" in result["context"]
    assert "continuity is unavailable" not in result["context"]
    fire("on_session_end", session_id="friend-s", task_id="task", turn_id="friend-s:t1", completed=False, failed=False, interrupted=True, turn_exit_reason="interrupted", model="m", platform="telegram")
    deadline = time.monotonic() + 5
    while plugin_module("runtime").driver().ledger.pending() and time.monotonic() < deadline:
        time.sleep(0.1)
    assert plugin_module("runtime").driver().ledger.pending() == []


def test_a_memory_delete_is_decided_by_the_hermes_human_and_a_denial_keeps_the_memory(operator, human):
    prompts, answer = human
    session, turn_id = "e2e-delete", "e2e-delete:t"
    begin(session, turn_id, "forget the wrong locker code")
    written = call_tool("memory", "write", session=session, turn_id=turn_id, text="Robin's locker code is 4471.", type="semantic", sensitivity="personal")
    memory_id = re.search(r"id: ([0-9a-f-]{36})", written).group(1)
    delete = dict(memory_id=memory_id, justification_category="factually_incorrect", explanation="The locker code changed.")

    # The human denies: Hermes blocks the call before it runs, so Lite makes no proposal and the memory stays.
    denied = dispatch("memory", "delete", session=session, turn_id=turn_id, **delete)
    assert len(prompts) == 1 and memory_id in prompts[0] and "The locker code changed." in prompts[0]
    assert "BLOCKED" in denied and "Memory deletion proposal" not in denied
    assert "4471" in call_tool("memory", "search", session=session, turn_id=turn_id, query="locker code")

    # The human approves once: the call runs, and the proposal it created is approved, so the memory is deleted.
    answer["choice"] = "once"
    approved = dispatch("memory", "delete", session=session, turn_id=turn_id, **delete)
    assert len(prompts) == 2
    assert "Memory deletion proposal" in approved
    assert "4471" not in call_tool("memory", "search", session=session, turn_id=turn_id, query="locker code")
    finish(session, turn_id, reply="Forgotten.")


def test_an_explicit_tool_request_is_held_to_the_donor_contract_and_the_turn_completes(operator):
    """The shakedown's tool_contract_incompatible turns: Lite's choice reaches Hermes's request through the plugin's middleware."""
    from test_tool_choice import chat_request, model_call, names

    session, turn_id = "e2e-explicit", "e2e-explicit:t"
    begin(session, turn_id, "Call the concerns tool to list my concerns, then tell me the first one.")
    forced = model_call(chat_request(), turn_id=turn_id, session=session).payload
    assert names(forced["tools"]) == [f"mcp__{SERVER}__concerns"] and forced["tool_choice"] == "required"
    assert SEED_THREAD in call_tool("concerns", "list", session=session, turn_id=turn_id)
    after = model_call(chat_request(), turn_id=turn_id, session=session).payload
    assert not {"tools", "tool_choice", "parallel_tool_calls"} & set(after)  # the donor's "no more tools": no tools at all
    finish(session, turn_id, reply="Your first concern is the seed packets.")
    assert plugin_module("runtime").driver().ledger.pending() == []
    # Lite recorded the turn as completed: its reply is the session's history in the next turn.
    context = begin(session, f"{turn_id}2", "and the next one?")
    assert "[your own earlier reply]\nYour first concern is the seed packets." in context
    finish(session, f"{turn_id}2", reply="That is the only one.")


def mcp_failures() -> int:
    """Hermes's MCP circuit-breaker count for the Lite server (tools/mcp_tool.py _server_error_counts; 3 opens it)."""
    import tools.mcp_tool as core

    try:
        from tools.mcp_tool_scope import _resolve_server_key  # 2bd378e keys the count by the resolved server
        key = _resolve_server_key(SERVER)
    except ImportError:  # f0187332 keys it by name
        key = SERVER
    return core._server_error_counts.get(key, 0)


def breaker_threshold() -> int:
    import tools.mcp_tool as core

    return core._CIRCUIT_BREAKER_THRESHOLD


def test_a_forced_step_missed_twice_fails_the_turn_and_hermess_mcp_breaker_stays_closed(operator):
    """Shakedown r3: a wrong forced call reached Lite, which ended the turn; Hermes kept calling Lite, and three refusals opened its breaker."""
    session, turn_id = "e2e-contract", "e2e-contract:t"
    begin(session, turn_id, "what is on my mind?")
    call_tool("concerns", "list", session=session, turn_id=turn_id)  # a call that succeeds resets the breaker count
    finish(session, turn_id, reply="The seed packets.")
    assert mcp_failures() == 0

    begin(session, f"{turn_id}2", "Call the concerns tool to list my concerns, then tell me the first one.")
    first = dispatch("session", "list", session=session, turn_id=f"{turn_id}2")
    assert "PSFN Lite did not run this call" in first and f"mcp__{SERVER}__concerns" in first
    second = dispatch("session", "list", session=session, turn_id=f"{turn_id}2")
    assert "tool_contract_incompatible" in second
    for _ in range(breaker_threshold() + 1):
        assert "PSFN Lite has ended the companion's turn" in dispatch("concerns", "list", session=session, turn_id=f"{turn_id}2")
    # Nothing of this reached Lite's MCP server, so Hermes counted nothing.
    assert mcp_failures() == 0
    finish(session, f"{turn_id}2", reply="I could not list them.")
    assert plugin_module("runtime").driver().ledger.pending() == []

    # Lite recorded the failed turn without Hermes's reply, and the next turn's tools reach Lite.
    context = begin(session, f"{turn_id}3", "and now?")
    assert "I could not list them." not in context
    assert SEED_THREAD in call_tool("concerns", "list", session=session, turn_id=f"{turn_id}3")
    finish(session, f"{turn_id}3", reply="Still the seed packets.")


def test_after_lite_ends_a_turn_itself_hermes_counts_one_refusal_and_the_breaker_stays_closed(operator):
    session, turn_id = "e2e-ended", "e2e-ended:t"
    begin(session, turn_id, "what is on my mind?")
    call_tool("concerns", "list", session=session, turn_id=turn_id)
    assert mcp_failures() == 0
    # Lite ends the turn without the plugin's knowledge, as its host-turn timeout does (bridge.ts armTimeout).
    driver = plugin_module("runtime").driver()
    [row] = [r for r in driver.ledger.turns() if r["session_id"] == session]
    driver.client.call("settle", {"hostInstance": driver.instance, "turnId": row["turn_id"],
                                  "outcome": {"kind": "failed", "error": {"code": "host_turn_timeout", "message": "the test ended the turn"}}})

    refused = dispatch("concerns", "list", session=session, turn_id=turn_id)
    assert "no_open_turn" in refused or "turn_ended" in refused
    assert mcp_failures() == 1  # Lite's refusal: one strike
    for _ in range(breaker_threshold() + 1):
        assert "PSFN Lite has ended the companion's turn" in dispatch("concerns", "list", session=session, turn_id=turn_id)
    assert mcp_failures() == 1 < breaker_threshold()
    finish(session, turn_id, reply="Hm.")

    begin(session, f"{turn_id}2", "and now?")
    assert SEED_THREAD in call_tool("concerns", "list", session=session, turn_id=f"{turn_id}2")
    assert mcp_failures() == 0
    finish(session, f"{turn_id}2", reply="The seed packets.")


def test_a_forced_step_with_exact_arguments_is_held_to_the_arguments_lite_hands_over(operator):
    """The exact-arguments schema comes from Lite (the donor's buildExactToolArgumentsModelSchema); the plugin reads the arguments back from it."""
    session, turn_id = "e2e-exact", "e2e-exact:t"
    begin(session, turn_id, 'Call concerns exactly once with arguments {"action": "list"}, then tell me the first concern.')
    wrong = json.loads(dispatch("concerns", "create", session=session, turn_id=turn_id, text="wrong"))["error"]
    assert "other arguments" in wrong and '{"action": "list"}' in wrong
    assert SEED_THREAD in call_tool("concerns", "list", session=session, turn_id=turn_id)
    finish(session, turn_id, reply="The seed packets.")
    context = begin(session, f"{turn_id}2", "thanks")
    assert "[your own earlier reply]\nThe seed packets." in context
    finish(session, f"{turn_id}2", reply="You are welcome.")


GARDEN_ENV = "PSFN_LITE_GARDEN_TEST_TOKEN"


def _mounted_dashboard(home: Path, enabled: set):
    """A FastAPI app with the plugin's dashboard backend mounted the way Hermes mounts it.

    On 2bd378e through Hermes's own discovery and mount (``_discover_dashboard_plugins``,
    ``_mount_one_plugin_api``: the ``plugins.enabled`` gate and the profile secret-scope dependency);
    on f0187332, which has no per-plugin mount, by importing ``plugin_api.py`` as its
    ``_mount_plugin_api_routes`` does. Returns None when Hermes refuses to mount it.
    """
    import importlib.util as util

    from fastapi import FastAPI

    app = FastAPI()
    try:
        from hermes_cli import web_server_dashboard as dashboard
    except ImportError:
        dashboard = None
    if dashboard is not None and hasattr(dashboard, "_mount_one_plugin_api"):
        [plugin] = [p for p in dashboard._discover_dashboard_plugins([(home / "plugins", "user")]) if p["name"] == "psfn_lite"]
        return app if dashboard._mount_one_plugin_api(app, plugin, enabled, set()) else None
    if "psfn_lite" not in enabled:
        return None
    api = home / "plugins" / "psfn_lite" / "dashboard" / "plugin_api.py"
    spec = util.spec_from_file_location("hermes_dashboard_plugin_psfn_lite", api)
    module = util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    app.include_router(module.router, prefix="/api/plugins/psfn_lite")
    return app


@pytest.fixture
def dashboard(lite, profile, monkeypatch):
    """The profile's dashboard backend in front of the real Lite Garden, with the Garden's own credential in the profile's scope."""
    from starlette.testclient import TestClient

    write_profile(profile, bridge_url=lite["lifecycleUrl"], mcp_url=lite["mcpUrl"], install_id=lite["hermesInstallId"],
                  garden={"url": lite["garden"]["url"], "credential_env": GARDEN_ENV, "timeout_seconds": 30})
    monkeypatch.setenv(CREDENTIAL_ENV, lite["credentials"]["hermes-operator"])
    monkeypatch.setenv(GARDEN_ENV, lite["garden"]["credential"])
    assert _mounted_dashboard(profile, set()) is None, "Hermes must not mount a backend that is not in plugins.enabled"
    app = _mounted_dashboard(profile, {"psfn_lite"})
    assert app is not None
    with TestClient(app) as client:
        yield client
    sys.modules.pop("hermes_dashboard_plugin_psfn_lite", None)


def test_the_install_never_carries_a_desktop_half(tmp_path):
    from conftest import PLUGIN_SOURCE, install_plugin
    from install_plugin import InstallError, desktop_halves

    target = install_plugin(tmp_path)
    assert target == tmp_path / "plugins" / "psfn_lite"
    assert (target / "dashboard" / "plugin_api.py").exists() and (target / "plugin.yaml").exists()
    assert desktop_halves(target) == []
    if (PLUGIN_SOURCE / "desktop" / "plugin.js").exists():
        assert desktop_halves(PLUGIN_SOURCE) != []  # the source has one; the install did not copy it
    # A Desktop half already in the profile stops the install before anything is copied.
    (target / "desktop").mkdir()
    (target / "desktop" / "plugin.js").write_text("export default {}\n")
    with pytest.raises(InstallError, match="Desktop half"):
        install_plugin(tmp_path)
    assert (target / "desktop" / "plugin.js").exists()


def test_the_dashboard_backend_proxies_every_garden_screen_with_the_gardens_own_credential(dashboard, lite):
    base = "/api/plugins/psfn_lite"
    for path in ("/api/lite/overview", "/api/admin/memory", "/api/lite/memory-deletions", "/api/admin/identity", "/api/admin/prompts",
                 "/api/admin/contacts", "/api/admin/biographical-claims", "/api/admin/graph-proposals", "/api/admin/sessions",
                 "/api/admin/concerns", "/api/lite/inner-life", "/api/admin/scheduler", "/api/admin/automata", "/api/lite/settings"):
        # The browser's Origin and cookies reach Hermes, never the Garden (which refuses any Origin).
        answer = dashboard.get(f"{base}{path}", headers={"Origin": "http://127.0.0.1:9119", "Cookie": "psfn_garden_session=x"})
        assert answer.status_code == 200, f"{path}: {answer.text[:300]}"
    # Never ?profile= here: Hermes would scope the request to a real profile outside the test home.
    overview = dashboard.get(f"{base}/api/lite/overview").json()
    assert overview["model"]["modelId"] and overview["restartRequired"] is False
    assert SEED_THREAD in json.dumps(dashboard.get(f"{base}/api/admin/concerns").json())
    assert dashboard.get(f"{base}/api/admin/automata", params={"limit": "1", "busLimit": "1"}).status_code == 200  # the query passes
    # Only the Garden's two route families pass.
    assert dashboard.get(f"{base}/lifecycle/v1/prepare").status_code == 404
    # The client normalises a literal "..", so send it encoded; Starlette decodes it into the path.
    assert dashboard.get(f"{base}/api/lite/%2E%2E/admin/memory").status_code == 404


def test_garden_writes_through_the_dashboard_backend_reach_lite(operator, dashboard):
    # operator first: its profile is then rewritten with the Garden block (the MCP client it started stays up).
    base = "/api/plugins/psfn_lite"
    begin("e2e-garden", "e2e-garden:t", "remember the shed key")
    written = call_tool("memory", "write", session="e2e-garden", turn_id="e2e-garden:t", text="Robin keeps the shed key on the red hook.", type="semantic")
    finish("e2e-garden", "e2e-garden:t", reply="Noted.")
    memory_id = re.search(r"id: ([0-9a-f-]{36})", written).group(1)

    deleted = dashboard.post(f"{base}/api/lite/memories/{memory_id}/delete", json={"reason": "moved"})
    assert deleted.status_code == 200, deleted.text
    restored = dashboard.post(f"{base}/api/lite/memories/restore", json={"deleteId": deleted.json()["deleteId"]})
    assert restored.status_code == 200 and restored.json()["memoryId"] == memory_id
    tier = dashboard.put(f"{base}/api/lite/settings/tier", json={"tier": "apprentice", "customTokens": []})
    assert tier.status_code == 200 and tier.json()["restartRequired"] is True
    refused = dashboard.put(f"{base}/api/lite/settings/tier", json={"tier": "omnipotent", "customTokens": []})
    assert refused.status_code == 400
    assert dashboard.get(f"{base}/api/lite/settings").json()["tier"]["tier"] == "apprentice"


def test_the_dashboard_backend_says_why_when_the_garden_credential_is_missing(dashboard, monkeypatch):
    monkeypatch.delenv(GARDEN_ENV)
    answer = dashboard.get("/api/plugins/psfn_lite/api/lite/overview")
    assert answer.status_code == 503 and GARDEN_ENV in answer.json()["error"]
