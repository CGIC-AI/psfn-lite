"""Several Hermes profiles in one process, as Hermes 2bd378e's gateway runs them (``hermes chat`` included).

Hermes keeps a plugin manager per home and binds the profile's home per turn
(``set_hermes_home_override``); a multiplexing gateway reads each profile's
secrets from its own ``.env`` scope (``set_secret_scope``) and fails closed
without one. The plugin must give every profile that selected it its own
hooks, driver, host instance and credential, and must leave a profile that
did not select it alone, MCP tools included.
"""

import contextlib

import pytest

from conftest import CREDENTIAL_ENV, FakeBridge, INSTALL_ID, write_profile

LITE_A = "test-credential-a-" + "a" * 32
LITE_B = "test-credential-b-" + "b" * 32


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
        provider.initialize("s", hermes_home=str(home), platform="local")
        return provider


def fire_in(home, name, secrets=None, **kwargs):
    from hermes_cli.lifecycle import invoke_hook

    with profile_turn(home, secrets):
        return invoke_hook(name, **kwargs)


def root_turn(session, sender):
    return dict(session_id=session, task_id="task", turn_id=f"{session}:t", user_message="hello", conversation_history=[], is_first_turn=True,
                model="m", platform="local", parent_session_id="", sender_id=sender)


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
    bridges = {"a": FakeBridge(), "b": FakeBridge()}
    homes = {name: root / "profiles" / name for name in ("a", "b", "plain")}
    for name in ("a", "b"):
        homes[name].mkdir()
        write_profile(homes[name], bridge_url=bridges[name].url, install_id=None, senders=[{"platform": "local", "sender_id": "uid:1000"}])
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
    secrets = {"a": {CREDENTIAL_ENV: LITE_A}, "b": {CREDENTIAL_ENV: LITE_B}}
    for _ in range(2):  # the gateway loads the provider per message
        load(homes["a"], secrets["a"])
        load(homes["b"], secrets["b"])
    assert our_hook_count(homes["a"], "pre_llm_call") == 1
    assert our_hook_count(homes["b"], "pre_llm_call") == 1

    fire_in(homes["a"], "pre_llm_call", secrets["a"], **root_turn("sa", "uid:1000"))
    fire_in(homes["b"], "pre_llm_call", secrets["b"], **root_turn("sb", "uid:1000"))
    [a] = bridges["a"].requests
    [b] = bridges["b"].requests
    assert a["authorization"] == f"Bearer {LITE_A}" and b["authorization"] == f"Bearer {LITE_B}"
    assert a["body"]["hostInstance"] != b["body"]["hostInstance"]
    # One install id per Hermes install, whichever profile asks.
    assert a["body"]["hermesInstallId"] == b["body"]["hermesInstallId"] == INSTALL_ID

    # The gateway's CLI sender is the OS user it runs as (control_socket.py _posix_peer_subject): another uid is not bound.
    [refused] = fire_in(homes["a"], "pre_llm_call", secrets["a"], **root_turn("sc", "uid:1001"))
    assert "not bound" in refused["context"]
    assert len(bridges["a"].requests) == 1


def test_a_lite_profile_without_its_profile_secret_is_refused_by_name(gateway):
    homes, bridges = gateway
    from plugins.memory import load_memory_provider

    with profile_turn(homes["a"]):  # multiplexing, no profile secret scope: Hermes fails closed
        provider = load_memory_provider("psfn_lite")
        with pytest.raises(ValueError, match="no profile secret scope"):
            provider.initialize("s", hermes_home=str(homes["a"]), platform="local")
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
    assert fire_in(homes["plain"], "pre_llm_call", **root_turn("p", "uid:1000")) == []
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
