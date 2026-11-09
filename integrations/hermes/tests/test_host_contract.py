"""The plugin inside the pinned Hermes: discovery, hook delivery, the turn lifecycle and compaction.

Hermes loads the plugin from a throwaway profile exactly as an operator
installs it, and hooks are fired through Hermes's own ``invoke_hook`` with
the payloads its agent loop sends. The Lite bridge is a scripted fake on
loopback; tests/e2e drive the real one.
"""

import os
import stat

import pytest

from conftest import CREDENTIAL, INSTALL_ID, gateway_line, plugin_module, write_profile


def load_provider():
    from plugins.memory import load_memory_provider

    provider = load_memory_provider("psfn_lite")
    assert provider is not None, "Hermes did not load the psfn_lite provider"
    return provider


def fire(name, **kwargs):
    from hermes_cli.lifecycle import invoke_hook

    return invoke_hook(name, **kwargs)


def turn(session="sess-1", turn_id="sess-1:task:aa", message="what have you been up to?", platform="cli", sender="", parent=""):
    return dict(session_id=session, task_id="task", turn_id=turn_id, user_message=message, conversation_history=[], is_first_turn=True,
                model="test-model", platform=platform, parent_session_id=parent, sender_id=sender)


def end(session="sess-1", turn_id="sess-1:task:aa", *, completed=True, failed=False, interrupted=False, reason="text_response(finish_reason=stop)"):
    return dict(session_id=session, task_id="task", turn_id=turn_id, completed=completed, failed=failed, interrupted=interrupted,
                turn_exit_reason=reason, model="test-model", platform="cli")


def our_hooks():
    from hermes_cli.plugins import VALID_HOOKS, get_plugin_manager

    hooks = get_plugin_manager()._hooks
    return {name: [cb for cb in callbacks if getattr(cb, "__name__", "").startswith("psfn_lite_")] for name, callbacks in hooks.items()}, VALID_HOOKS


def test_hermes_discovers_the_plugin_only_through_the_memory_slot(profile):
    from plugins.memory import _is_memory_provider_dir, find_provider_dir

    assert find_provider_dir("psfn_lite") == profile / "plugins" / "psfn_lite"
    # Classified as a memory provider, so the general plugin loader never loads it a second way.
    assert _is_memory_provider_dir(profile / "plugins" / "psfn_lite")
    provider = load_provider()
    assert provider.name == "psfn_lite"
    assert provider.pre_compress_checkpoint_api_version == 2
    assert provider.get_tool_schemas() == []
    assert provider.is_available()


def test_lifecycle_hooks_are_valid_and_registered_once_however_often_hermes_loads_the_provider(profile):
    for _ in range(3):  # the gateway builds an agent, and loads the provider, per message
        load_provider()
    hooks, valid = our_hooks()
    registered = {name for name, callbacks in hooks.items() if callbacks}
    assert registered == {"pre_llm_call", "pre_tool_call", "post_tool_call", "post_llm_call", "on_session_end", "on_session_finalize", "subagent_start"}
    assert registered <= valid
    assert all(len(hooks[name]) == 1 for name in registered)


def test_listing_the_plugin_in_plugins_enabled_for_the_dashboard_backend_loads_it_no_second_way(profile):
    from hermes_cli.plugins import discover_plugins

    # The dashboard mounts a user plugin's backend only when plugins.enabled names it (README, Install).
    with (profile / "config.yaml").open("a") as config:
        config.write("plugins:\n  enabled:\n    - psfn_lite\n")
    discover_plugins(force=True)
    # The general loader still skips it (a memory provider): nothing of ours is registered yet.
    assert not any(our_hooks()[0].values())
    load_provider()
    hooks, _ = our_hooks()
    assert all(len(callbacks) == 1 for callbacks in hooks.values() if callbacks)
    assert {name for name, callbacks in hooks.items() if callbacks} == {"pre_llm_call", "pre_tool_call", "post_tool_call", "post_llm_call", "on_session_end", "on_session_finalize", "subagent_start"}


def test_the_manifest_declares_every_hook_and_middleware_the_plugin_registers(profile):
    from hermes_cli.plugins import get_plugin_manager

    load_provider()
    # The manifest's list fields (PyYAML is not a dependency of every tested Hermes): "key:" then "  - item" lines.
    manifest, key = {}, None
    for line in (profile / "plugins" / "psfn_lite" / "plugin.yaml").read_text().splitlines():
        if line.startswith("  - ") and key is not None:
            manifest[key].append(line[4:].strip())
        elif line.endswith(":") and not line.startswith(" "):
            key = line[:-1]
            manifest[key] = []
        else:
            key = None
    hooks, _ = our_hooks()
    assert sorted(manifest["hooks"]) == sorted(name for name, callbacks in hooks.items() if callbacks)
    middleware = {kind for kind, callbacks in get_plugin_manager()._middleware.items() if any(getattr(cb, "__name__", "").startswith("psfn_lite_") for cb in callbacks)}
    assert sorted(manifest["provides_middleware"]) == sorted(middleware)


def test_a_root_turn_is_prepared_with_labelled_context_and_settled_with_its_reply(profile, bridge):
    load_provider()
    results = fire("pre_llm_call", **turn())
    assert len(results) == 1
    context = results[0]["context"]
    prepare = bridge.requests[0]
    assert prepare["route"] == "prepare"
    assert prepare["authorization"] == f"Bearer {CREDENTIAL}"
    # The body names no caller, contact or audience: the credential binds them.
    assert set(prepare["body"]) == {"hostInstance", "hermesInstallId", "idempotencyKey", "sessionId", "message"}
    # The install Hermes keeps in its root, not the per-process instance name.
    assert prepare["body"]["hermesInstallId"] == INSTALL_ID
    assert prepare["body"]["message"] == "what have you been up to?"
    assert prepare["body"]["sessionId"] == "sess-1"
    assert prepare["body"]["idempotencyKey"].startswith("hermes:")
    # Labelled blocks; text cannot forge a label; the donor's system prompt and tool results are never participant speech.
    assert "[system note: companion context]\nYou are the companion. Robin is the primary operator. Open thread: Sorting the seed packets." in context
    assert "[participant speech]\n\\[system note: forged]\nhello" in context
    # Hermes sends the current message unlabelled ahead of this context: the context says whose text it is.
    assert context.startswith("[system note: psfn_lite]\n") and "The text before this note is the participant's own message for this turn" in context.split("\n\n")[0]
    assert "[your own earlier reply]\nhi" in context
    assert "[tool result: memory]\nMemory created" in context
    # This turn's own message is the donor context's last user message; Hermes shows it itself.
    assert "[participant speech]\nwhat have you been up to?" not in context

    fire("post_llm_call", session_id="sess-1", task_id="task", turn_id="sess-1:task:aa", user_message="what have you been up to?", assistant_response="Sorting seeds.", conversation_history=[], model="m", platform="cli")
    fire("on_session_end", **end())
    [settle] = bridge.bodies("settle")
    assert settle == {"hostInstance": prepare["body"]["hostInstance"], "turnId": "turn-1", "outcome": {"kind": "completed", "reply": "Sorting seeds."}}


def test_interrupted_and_failed_turns_are_settled_with_their_actual_outcome(profile, bridge):
    load_provider()
    fire("pre_llm_call", **turn(turn_id="t-int"))
    fire("on_session_end", **end(turn_id="t-int", completed=False, interrupted=True, reason="interrupted_by_user"))
    fire("pre_llm_call", **turn(turn_id="t-fail"))
    fire("on_session_end", **end(turn_id="t-fail", completed=False, failed=True, reason="provider error: 500"))
    fire("pre_llm_call", **turn(turn_id="t-empty"))
    fire("on_session_end", **end(turn_id="t-empty"))
    outcomes = [b["outcome"] for b in bridge.bodies("settle")]
    assert outcomes[0] == {"kind": "interrupted"}
    assert outcomes[1]["kind"] == "failed" and outcomes[1]["error"] == {"code": "hermes_turn_failed", "message": "Hermes ended the turn: provider error: 500"}
    # A completed turn that produced no reply is not recorded as a reply nobody gave.
    assert outcomes[2]["kind"] == "failed" and outcomes[2]["error"]["code"] == "hermes_no_reply"


def test_one_hermes_turn_keeps_one_lite_identity_and_different_turns_get_different_ones(profile, bridge):
    load_provider()
    fire("pre_llm_call", **turn(turn_id="t-1"))
    fire("pre_llm_call", **turn(turn_id="t-1"))
    fire("pre_llm_call", **turn(turn_id="t-2"))
    fire("pre_llm_call", **turn(session="sess-2", turn_id="t-1"))
    keys = [b["idempotencyKey"] for b in bridge.bodies("prepare")]
    assert keys[0] == keys[1]
    assert len(set(keys)) == 3


def test_subagents_and_the_review_fork_never_drive_lite_turns(profile, bridge):
    load_provider()
    fire("subagent_start", parent_session_id="sess-1", parent_turn_id="t", parent_subagent_id=None, child_session_id="child-1", child_subagent_id="s1", child_role="leaf", child_goal="look something up")
    assert fire("pre_llm_call", **turn(session="child-1", turn_id="c-1", parent="sess-1")) == []
    assert fire("pre_llm_call", **turn(session="sess-1", turn_id="r-1", parent="sess-1")) == []
    assert bridge.requests == []
    # A compression continuation (new session id, parent is the old one) is still the root conversation.
    fire("pre_llm_call", **turn(session="sess-1b", turn_id="k-1", parent="sess-1"))
    assert len(bridge.bodies("prepare")) == 1


def test_an_unbound_sender_is_told_and_nothing_reaches_lite(profile, bridge):
    load_provider()
    [result] = fire("pre_llm_call", **turn(platform="telegram", sender="9999"))
    assert "not bound to the companion's PSFN Lite continuity" in result["context"]
    assert bridge.requests == []
    fire("pre_llm_call", **turn(platform="telegram", sender="4242"))
    assert len(bridge.bodies("prepare")) == 1


def test_an_undeliverable_settlement_is_kept_surfaced_and_retried_before_the_next_turn(profile, bridge):
    warnings = []
    provider = load_provider()
    provider.initialize("sess-1", hermes_home=str(profile), platform="cli", warning_callback=warnings.append)
    bridge.handlers["settle"] = lambda route, body: (503, {"error": {"kind": "unavailable", "capability": "postgres", "detail": "x"}})
    fire("pre_llm_call", **turn(turn_id="t-1"))
    fire("post_llm_call", session_id="sess-1", task_id="task", turn_id="t-1", user_message="q", assistant_response="a reply", conversation_history=[], model="m", platform="cli")
    fire("on_session_end", **end(turn_id="t-1"))
    assert any("settle did not reach Lite" in w for w in warnings)
    ledger = plugin_module("runtime").driver().ledger
    assert [e["kind"] for e in ledger.pending()] == ["settle"]
    assert stat.S_IMODE(os.stat(ledger.path).st_mode) == 0o600

    # Lite is back: the next turn first delivers the kept outcome, then prepares.
    del bridge.handlers["settle"]
    [result] = fire("pre_llm_call", **turn(turn_id="t-2"))
    assert [r["route"] for r in bridge.requests][-2:] == ["settle", "prepare"]
    assert bridge.bodies("settle")[-1]["outcome"] == {"kind": "completed", "reply": "a reply"}
    assert ledger.pending() == []
    # The model is told what happened on the earlier turn.
    assert "settle did not reach Lite" in result["context"]


def test_an_unreachable_bridge_is_named_in_the_turn_and_recorded(profile, bridge):
    warnings = []
    provider = load_provider()
    provider.initialize("sess-1", hermes_home=str(profile), platform="cli", warning_callback=warnings.append)
    bridge.close()
    [result] = fire("pre_llm_call", **turn())
    assert "continuity is unavailable for this turn" in result["context"]
    assert any("prepare did not reach Lite" in w for w in warnings)
    # The turn is kept with its key, so settling it later finds or records it in Lite.
    [row] = plugin_module("runtime").driver().ledger.turns()
    assert row["turn_id"] is None and row["payload"]["prepare"]["message"] == "what have you been up to?"


def test_compaction_is_refused_unless_lite_proves_the_sessions_turns(profile, bridge):
    from agent.memory_manager import MemoryManager

    provider = load_provider()
    provider.initialize("sess-1", hermes_home=str(profile), platform="cli")
    manager = MemoryManager()
    manager.add_provider(provider)
    fire("pre_llm_call", **turn(turn_id="t-1"))
    fire("post_llm_call", session_id="sess-1", task_id="task", turn_id="t-1", user_message="q", assistant_response="a", conversation_history=[], model="m", platform="cli")
    fire("on_session_end", **end(turn_id="t-1"))

    manager.on_pre_compress([], evidence_messages=[], require_checkpoint=True)
    assert bridge.bodies("checkpoint")[-1] == {"hermesInstallId": INSTALL_ID, "sessionId": "sess-1", "turnIds": ["turn-1"]}

    bridge.handlers["checkpoint"] = lambda route, body: (404, {"error": {"kind": "not_found", "subject": "turn turn-1"}})
    with pytest.raises(Exception, match="not_found"):
        manager.on_pre_compress([], evidence_messages=[], require_checkpoint=True)

    # An outcome only this profile holds blocks compaction until Lite has it.
    del bridge.handlers["checkpoint"]
    bridge.handlers["settle"] = lambda route, body: (503, {"error": {"kind": "unavailable", "capability": "postgres", "detail": "x"}})
    fire("pre_llm_call", **turn(turn_id="t-2"))
    fire("on_session_end", **end(turn_id="t-2", completed=False, interrupted=True))
    with pytest.raises(Exception, match="not yet in Lite"):
        manager.on_pre_compress([], evidence_messages=[], require_checkpoint=True)


@pytest.mark.parametrize(
    "setting, issue",
    [({"memory_enabled": True}, "memory.memory_enabled must be false"), ({"checkpoint_required": False}, "compression.checkpoint_required must be true")],
)
def test_the_provider_refuses_to_start_beside_a_second_memory_or_lossy_compaction(profile, bridge, setting, issue):
    write_profile(profile, bridge_url=bridge.url, **setting)
    provider = load_provider()
    with pytest.raises(ValueError, match=issue):
        provider.initialize("sess-1", hermes_home=str(profile), platform="cli")


@pytest.mark.parametrize("setting", [{"memory_enabled": True}, {"checkpoint_required": False}])
def test_the_hooks_drive_no_lite_turn_while_the_profile_keeps_a_second_memory(profile, bridge, setting):
    # Hermes only logs a provider that refuses to initialize, so the hooks refuse on their own.
    write_profile(profile, bridge_url=bridge.url, **setting)
    warnings = []
    provider = load_provider()
    with pytest.raises(ValueError):
        provider.initialize("sess-1", hermes_home=str(profile), platform="cli", warning_callback=warnings.append)
    [result] = fire("pre_llm_call", **turn())
    fire("on_session_end", **end())
    assert bridge.requests == []
    assert "refuses to drive Lite turns" in result["context"]
    assert any("refuses to drive Lite turns" in w for w in warnings)


@pytest.mark.parametrize("content, issue", [(None, "does not exist yet"), ("not-an-install-id\n", "not 32 lowercase hex characters")])
def test_no_turn_is_driven_and_no_tool_runs_without_the_hermes_install_id(profile, bridge, content, issue):
    # The install id names the binding Lite serves; the plugin reads it from the Hermes root and never mints it.
    if gateway_line():
        pytest.skip("Hermes 2bd378e mints its own install id (hermes_cli/install_identity.py); see the test below")
    path = profile / "install_id"
    path.unlink()
    if content is not None:
        path.write_text(content)
    provider = load_provider()
    with pytest.raises(ValueError, match=issue):
        provider.initialize("sess-1", hermes_home=str(profile), platform="cli")
    [result] = fire("pre_llm_call", **turn())
    assert bridge.requests == []
    assert issue in result["context"]
    [blocked] = fire("pre_tool_call", tool_name="mcp__psfn_lite__memory", args={"action": "list"}, session_id="sess-1", turn_id="sess-1:task:aa")
    assert blocked["action"] == "block" and issue in blocked["message"]
    assert not path.exists() or path.read_text() == content


def test_the_install_id_comes_from_hermes_install_identity_and_an_unreadable_one_drives_no_turn(profile, bridge):
    """Hermes 2bd378e: one id per install, read or minted by Hermes itself (get_install_id), shared by every profile."""
    if not gateway_line():
        pytest.skip("Hermes f0187332 has no hermes_cli/install_identity.py")
    from hermes_cli.install_identity import get_install_id

    path = profile / "install_id"
    path.unlink()
    load_provider().initialize("sess-1", hermes_home=str(profile), platform="cli")
    fire("pre_llm_call", **turn())
    minted = path.read_text().strip()
    assert minted == get_install_id() and minted != INSTALL_ID
    assert bridge.bodies("prepare")[0]["hermesInstallId"] == minted

    # A root whose id Hermes can neither read nor replace: refused by name, no turn, no tool.
    plugin_module("runtime").reset_for_tests()
    import hermes_cli.install_identity as identity

    identity._INSTALL_ID_CACHE.update(root=None, value=None)
    path.chmod(0)
    try:
        before = len(bridge.requests)
        with pytest.raises(ValueError, match="could neither read nor create its install id"):
            load_provider().initialize("sess-2", hermes_home=str(profile), platform="cli")
        [result] = fire("pre_llm_call", **turn(session="sess-2", turn_id="sess-2:task:aa"))
        assert len(bridge.requests) == before
        assert "could neither read nor create its install id" in result["context"]
    finally:
        path.chmod(0o600)


def test_a_prepare_refused_for_another_install_is_reported_and_drives_no_turn(profile, bridge):
    bridge.handlers["prepare"] = lambda route, body: (403, {"error": {"kind": "denied", "reason": "wrong_install", "detail": "this companion is bound to another Hermes install"}})
    warnings = []
    provider = load_provider()
    provider.initialize("sess-1", hermes_home=str(profile), platform="cli", warning_callback=warnings.append)
    [result] = fire("pre_llm_call", **turn())
    assert [r["route"] for r in bridge.requests] == ["prepare"]
    assert "wrong_install" in result["context"] or "another Hermes install" in result["context"]
    assert any("another Hermes install" in w or "wrong_install" in w for w in warnings)
    [blocked] = fire("pre_tool_call", tool_name="mcp__psfn_lite__memory", args={"action": "list"}, session_id="sess-1", turn_id="sess-1:task:aa")
    assert blocked["action"] == "block"


def test_a_subagent_is_recognised_by_its_platform_even_without_subagent_start(profile, bridge):
    load_provider()
    assert fire("pre_llm_call", **turn(session="child-x", turn_id="c-x", platform="subagent", parent="sess-1")) == []
    assert bridge.requests == []


MEMORY_TOOL = "mcp__psfn_lite__memory"
DELETE = {"action": "delete", "memory_id": "mem-1", "justification_category": "factually_incorrect", "explanation": "The stored number is wrong."}
PENDING = '{"result": "Memory deletion proposal prop-1 is pending Operator validation. The memory remains active."}'


def test_a_memory_delete_in_a_lite_turn_goes_to_the_hermes_human_and_its_approval_resolves_the_proposal(profile, bridge):
    bridge.handlers["memory-deletion/approve"] = lambda route, body: (200, {"proposalId": body["proposalId"], "status": "approved", "deleteId": "del-1"})
    load_provider().initialize("sess-1", hermes_home=str(profile), platform="cli")
    fire("pre_llm_call", **turn())
    # Other memory actions are not escalated.
    assert fire("pre_tool_call", tool_name=MEMORY_TOOL, args={"action": "search", "query": "x"}, session_id="sess-1", turn_id="sess-1:task:aa", tool_call_id="c-0") == []
    [directive] = fire("pre_tool_call", tool_name=MEMORY_TOOL, args=dict(DELETE), session_id="sess-1", turn_id="sess-1:task:aa", tool_call_id="c-1")
    # Hermes's human approval gate (tools.approval.request_tool_approval), not a plugin decision.
    assert directive["action"] == "approve"
    assert "mem-1" in directive["message"] and "factually_incorrect" in directive["message"] and "The stored number is wrong." in directive["message"]
    # The [a]lways grain is this memory for this reason, never every delete.
    assert directive["rule_key"].startswith("psfn_lite_memory_delete:") and directive["rule_key"] != "psfn_lite_memory_delete:"
    [other] = fire("pre_tool_call", tool_name=MEMORY_TOOL, args={**DELETE, "memory_id": "mem-2"}, session_id="sess-1", turn_id="sess-1:task:aa", tool_call_id="c-2")
    assert other["rule_key"] != directive["rule_key"]
    # The donor resolves the memory from its aliases too (id, memoryId); the human is asked about that memory.
    aliased = {k: v for k, v in DELETE.items() if k != "memory_id"} | {"memoryId": "mem-3"}
    [named] = fire("pre_tool_call", tool_name=MEMORY_TOOL, args=aliased, session_id="sess-1", turn_id="sess-1:task:aa", tool_call_id="c-3")
    assert "mem-3" in named["message"]
    fire("post_tool_call", tool_name=MEMORY_TOOL, args=aliased, result='{"error": "denied"}', session_id="sess-1", turn_id="sess-1:task:aa", tool_call_id="c-3", status="blocked")
    fire("post_tool_call", tool_name=MEMORY_TOOL, args={**DELETE, "memory_id": "mem-2"}, result='{"error": "denied"}', session_id="sess-1", turn_id="sess-1:task:aa", tool_call_id="c-2", status="blocked")
    assert bridge.bodies("memory-deletion/approve") == []
    # Approved and run: Lite approves the proposal that call created, for the bound install.
    fire("post_tool_call", tool_name=MEMORY_TOOL, args=dict(DELETE), result=PENDING, session_id="sess-1", turn_id="sess-1:task:aa", tool_call_id="c-1", status="ok")
    assert bridge.bodies("memory-deletion/approve") == [{"hostInstance": bridge.bodies("prepare")[0]["hostInstance"], "hermesInstallId": INSTALL_ID, "proposalId": "prop-1", "memoryId": "mem-1"}]
    # A second post for the same call resolves nothing more.
    fire("post_tool_call", tool_name=MEMORY_TOOL, args=dict(DELETE), result=PENDING, session_id="sess-1", turn_id="sess-1:task:aa", tool_call_id="c-1", status="ok")
    assert len(bridge.bodies("memory-deletion/approve")) == 1
    fire("on_session_end", **end())


def test_a_memory_delete_whose_call_was_changed_or_did_not_reach_lite_is_kept_and_reported(profile, bridge):
    bridge.handlers["memory-deletion/approve"] = lambda route, body: (409, {"error": {"kind": "conflict", "reason": "turn_ended", "detail": "the turn ended"}})
    warnings = []
    load_provider().initialize("sess-1", hermes_home=str(profile), platform="cli", warning_callback=warnings.append)
    fire("pre_llm_call", **turn())
    # Another plugin's modify directive changed the memory after the human was asked: nothing is approved.
    fire("pre_tool_call", tool_name=MEMORY_TOOL, args=dict(DELETE), session_id="sess-1", turn_id="sess-1:task:aa", tool_call_id="c-1")
    fire("post_tool_call", tool_name=MEMORY_TOOL, args={**DELETE, "memory_id": "mem-9"}, result=PENDING.replace("prop-1", "prop-9"), session_id="sess-1", turn_id="sess-1:task:aa", tool_call_id="c-1", status="ok")
    assert bridge.bodies("memory-deletion/approve") == []
    assert any("not the one approved" in w and "mem-1" in w for w in warnings)
    # Lite refused the approval: the memory is kept and the refusal is reported.
    fire("pre_tool_call", tool_name=MEMORY_TOOL, args=dict(DELETE), session_id="sess-1", turn_id="sess-1:task:aa", tool_call_id="c-2")
    fire("post_tool_call", tool_name=MEMORY_TOOL, args=dict(DELETE), result=PENDING, session_id="sess-1", turn_id="sess-1:task:aa", tool_call_id="c-2", status="ok")
    assert len(bridge.bodies("memory-deletion/approve")) == 1
    assert any("did not reach Lite" in w and "stays pending" in w for w in warnings)
    fire("on_session_end", **end())
