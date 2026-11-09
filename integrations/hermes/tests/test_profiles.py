"""Several Hermes profiles in one process, as Hermes 2bd378e's gateway runs them (``hermes chat`` included).

Hermes keeps a plugin manager per home and binds the profile's home per turn
(``set_hermes_home_override``); a multiplexing gateway reads each profile's
secrets from its own ``.env`` scope (``set_secret_scope``) and fails closed
without one. The plugin must give every profile that selected it its own
hooks, driver, host instance and credential, and must leave a profile that
did not select it alone, MCP tools included.
"""

import ast
import contextlib
import inspect
import os
import socket
import textwrap
from types import SimpleNamespace

import pytest

from conftest import CREDENTIAL_ENV, FakeBridge, INSTALL_ID, gateway_line, write_profile

LITE_A = "test-credential-a-" + "a" * 32
LITE_B = "test-credential-b-" + "b" * 32
#: The local CLI's (platform, sender id) on the Hermes under test, set by the gateway fixture from Hermes's own code (cli_sender).
CLI = {}


def gateway_platform_key(policy):
    """The platform Hermes 2bd378e's gateway hands the agent and its hooks for a local (``hermes chat``) turn.

    Read from the gateway's own turn runner: the ``platform_key`` assignment in TurnRunner._run_sync_scoped
    (gateway/run_turn_runner.py), evaluated for a Platform.LOCAL source with the session policy given.
    """
    from gateway import run_turn_runner
    from gateway.config import Platform

    tree = ast.parse(textwrap.dedent(inspect.getsource(run_turn_runner.TurnRunner._run_sync_scoped)))
    [expression] = [node.value for node in ast.walk(tree) if isinstance(node, ast.Assign)
                    and [getattr(t, "id", None) for t in node.targets] == ["platform_key"]]
    ctx = SimpleNamespace(source=SimpleNamespace(platform=Platform.LOCAL))
    return eval(compile(ast.Expression(expression), "run_turn_runner.py", "eval"), {"Platform": Platform}, {"policy": policy, "ctx": ctx})


def cli_sender(home):
    """The (platform, sender_id) the local CLI's turns reach the hooks with, from Hermes's own code.

    2bd378e: ``hermes chat`` runs through the gateway. Its sender is the subject the control socket gives the
    connecting OS user (gateway/control_socket.py _posix_peer_subject, read here over a real Unix socket pair),
    and its platform is the gateway's mapping of Platform.LOCAL, with no session policy and with the ``cli``
    launch's policy (gateway/session_policy.py SURFACES). f0187332: the CLI runs its own agent as platform
    "cli" (cli.py AIAgent(platform="cli")) with no sender id.
    """
    if not gateway_line():
        return "cli", ""
    from gateway.control_socket import GatewayControlServer
    from gateway.session_policy import SURFACES

    platforms = {gateway_platform_key(None), gateway_platform_key(SimpleNamespace(platform=SURFACES["cli"]))}
    assert len(platforms) == 1, platforms
    ours, theirs = socket.socketpair(socket.AF_UNIX)
    try:
        subject = GatewayControlServer(home)._posix_peer_subject(SimpleNamespace(get_extra_info=lambda key: ours if key == "socket" else None))
    finally:
        ours.close()
        theirs.close()
    assert subject is not None, "the control socket refused this test's home"
    return platforms.pop(), subject


@contextlib.contextmanager
def profile_turn(home, secrets=None):
    """What the gateway does around one turn of a profile: its home bound, and under multiplexing its secret scope."""
    from agent.secret_scope import reset_secret_scope, set_secret_scope
    from hermes_constants import reset_hermes_home_override, set_hermes_home_override

    home_token = set_hermes_home_override(str(home))
    secret_token = set_secret_scope(secrets) if secrets is not None else None
    try:
        yield
    finally:
        if secret_token is not None:
            reset_secret_scope(secret_token)
        reset_hermes_home_override(home_token)


def load(home, secrets=None):
    from plugins.memory import load_memory_provider

    with profile_turn(home, secrets):
        provider = load_memory_provider("psfn_lite")
        assert provider is not None
        provider.initialize("s", hermes_home=str(home), platform=CLI["platform"])
        return provider


def fire_in(home, name, secrets=None, **kwargs):
    from hermes_cli.lifecycle import invoke_hook

    with profile_turn(home, secrets):
        return invoke_hook(name, **kwargs)


def root_turn(session, sender=None):
    return dict(session_id=session, task_id="task", turn_id=f"{session}:t", user_message="hello", conversation_history=[], is_first_turn=True,
                model="m", platform=CLI["platform"], parent_session_id="", sender_id=CLI["sender"] if sender is None else sender)


def our_hook_count(home, name):
    from hermes_cli.plugins import get_plugin_manager

    with profile_turn(home):
        return len([cb for cb in get_plugin_manager()._hooks.get(name, []) if getattr(cb, "__name__", "") == f"psfn_lite_{name}"])


@pytest.fixture
def gateway(tmp_path, monkeypatch):
    """A Hermes root with two Lite profiles (each its own Lite) and one profile that does not use Lite; multiplexing on."""
    from agent.secret_scope import set_multiplex_active

    root = tmp_path / "root"
    (root / "profiles").mkdir(parents=True)
    (root / "install_id").write_text(INSTALL_ID + "\n")  # one install id in the root, shared by every profile
    monkeypatch.setenv("HERMES_HOME", str(root))
    monkeypatch.delenv(CREDENTIAL_ENV, raising=False)
    CLI["platform"], CLI["sender"] = cli_sender(root)
    bridges = {"a": FakeBridge(), "b": FakeBridge()}
    homes = {name: root / "profiles" / name for name in ("a", "b", "plain")}
    for name in ("a", "b"):
        homes[name].mkdir()
        write_profile(homes[name], bridge_url=bridges[name].url, install_id=None, senders=[{"platform": CLI["platform"], "sender_id": CLI["sender"]}])
    plain = homes["plain"]
    (plain / "plugins").mkdir(parents=True)
    write_profile(plain, bridge_url=bridges["a"].url, install_id=None)
    (plain / "psfn-lite.json").unlink()  # this profile never configured the plugin
    (plain / "config.yaml").write_text("memory:\n  provider: ''\n")
    set_multiplex_active(True)
    try:
        yield homes, bridges
    finally:
        set_multiplex_active(False)
        for bridge in bridges.values():
            bridge.close()
        import sys

        from conftest import _plugin_package

        for package in [m for m in sys.modules if _plugin_package(m)]:
            runtime = sys.modules.get(f"{package}.runtime")
            if runtime is not None:
                runtime.reset_for_tests()
        for name in [m for m in sys.modules if _plugin_package(".".join(m.split(".")[:2]))]:
            del sys.modules[name]


def test_each_lite_profile_gets_its_own_hooks_driver_instance_and_credential(gateway):
    homes, bridges = gateway
    # The pair the README and config.py document: through the 2bd378e gateway, platform "cli" (Platform.LOCAL's mapping,
    # run_turn_runner.py) with the gateway user's uid; r2 bound "local" and every turn was refused as unbound.
    assert CLI == ({"platform": "cli", "sender": f"uid:{os.getuid()}"} if gateway_line() else {"platform": "cli", "sender": ""})
    secrets = {"a": {CREDENTIAL_ENV: LITE_A}, "b": {CREDENTIAL_ENV: LITE_B}}
    for _ in range(2):  # the gateway loads the provider per message
        load(homes["a"], secrets["a"])
        load(homes["b"], secrets["b"])
    assert our_hook_count(homes["a"], "pre_llm_call") == 1
    assert our_hook_count(homes["b"], "pre_llm_call") == 1

    fire_in(homes["a"], "pre_llm_call", secrets["a"], **root_turn("sa"))
    fire_in(homes["b"], "pre_llm_call", secrets["b"], **root_turn("sb"))
    [a] = bridges["a"].requests
    [b] = bridges["b"].requests
    assert a["authorization"] == f"Bearer {LITE_A}" and b["authorization"] == f"Bearer {LITE_B}"
    assert a["body"]["hostInstance"] != b["body"]["hostInstance"]
    # One install id per Hermes install, whichever profile asks.
    assert a["body"]["hermesInstallId"] == b["body"]["hermesInstallId"] == INSTALL_ID

    # The CLI sender is the OS user the gateway runs as (control_socket.py _posix_peer_subject): another uid is not bound.
    [refused] = fire_in(homes["a"], "pre_llm_call", secrets["a"], **root_turn("sc", f"uid:{os.getuid() + 1}"))
    assert "not bound" in refused["context"]
    assert len(bridges["a"].requests) == 1


def test_a_lite_profile_without_its_profile_secret_is_refused_by_name(gateway):
    homes, bridges = gateway
    from plugins.memory import load_memory_provider

    with profile_turn(homes["a"]):  # multiplexing, no profile secret scope: Hermes fails closed
        provider = load_memory_provider("psfn_lite")
        with pytest.raises(ValueError, match="no profile secret scope"):
            provider.initialize("s", hermes_home=str(homes["a"]), platform=CLI["platform"])
    assert bridges["a"].requests == []


def test_a_profile_that_did_not_select_the_plugin_is_left_alone_and_a_misconfigured_one_stays_closed(gateway):
    homes, bridges = gateway
    secrets = {CREDENTIAL_ENV: LITE_A}
    load(homes["a"], secrets)
    # Hooks of the plugin in the plain profile's manager, as a provider inspection there would leave them.
    from plugins.memory import load_memory_provider

    with profile_turn(homes["plain"]):
        load_memory_provider("psfn_lite")
    assert our_hook_count(homes["plain"], "pre_tool_call") == 1
    assert fire_in(homes["plain"], "pre_tool_call", tool_name="mcp__github__search", args={}, session_id="p", turn_id="p:t", tool_call_id="c") == []
    assert fire_in(homes["plain"], "pre_llm_call", **root_turn("p")) == []
    assert bridges["a"].requests == []

    # The profile that selected the plugin keeps its gate: Lite's tools outside a Lite turn are blocked...
    [blocked] = fire_in(homes["a"], "pre_tool_call", secrets, tool_name="mcp__psfn_lite__memory", args={}, session_id="x", turn_id="x:t", tool_call_id="c")
    assert blocked["action"] == "block"
    # ...and once its psfn-lite.json is unreadable, which MCP server is Lite's is unknown, so every MCP tool is blocked.
    (homes["a"] / "psfn-lite.json").write_text("{not json")
    import sys

    from conftest import _plugin_package

    for package in [m for m in sys.modules if _plugin_package(m)]:
        sys.modules[f"{package}.runtime"]._drivers.clear()
    [closed] = fire_in(homes["a"], "pre_tool_call", secrets, tool_name="mcp__github__search", args={}, session_id="x", turn_id="x:t", tool_call_id="c2")
    assert closed["action"] == "block" and "not usable" in closed["message"]
