"""The donor's explicit tool contract, carried into Hermes's provider request.

When the participant asks for tools by name, the donor forced each model call
of the turn (the requested tool, then no tool) and failed the turn on any
other answer; the 2026-11-09 shakedown lost four turns because Hermes's model
was never told. Lite hands the choice over (prepare's ``toolChoice``, then
the ``tool-choice`` route after each Lite tool call); the plugin's
``llm_request`` middleware rewrites the request. Requests here go through
Hermes's own ``apply_llm_request_middleware``, the call its agent loop makes
before every provider call, with the request shapes Hermes builds per API mode.
"""

import pytest

from test_host_contract import end, fire, load_provider, turn

ORIENT = "mcp__psfn_lite__orient"
MEMORY = "mcp__psfn_lite__memory"
TURN = "sess-1:task:aa"
ORIENT_STEP = {"kind": "tool", "name": "orient", "parameters": None}


def chat_request():
    tool = lambda name: {"type": "function", "function": {"name": name, "description": name, "parameters": {"type": "object"}}}
    return {"model": "m", "messages": [{"role": "user", "content": "hi"}], "tools": [tool(ORIENT), tool(MEMORY), tool("terminal")]}


def anthropic_request():
    tool = lambda name: {"name": name, "description": name, "input_schema": {"type": "object"}}
    return {"model": "m", "messages": [], "max_tokens": 10, "tools": [tool(ORIENT), tool(MEMORY), tool("terminal")],
            "tool_choice": {"type": "auto"}, "thinking": {"type": "enabled", "budget_tokens": 1024}}


def codex_request():
    tool = lambda name: {"type": "function", "name": name, "description": name, "parameters": {"type": "object"}}
    return {"model": "m", "input": [], "tools": [tool(ORIENT), tool(MEMORY), tool("terminal")], "tool_choice": "auto", "parallel_tool_calls": True}


def model_call(request, *, api_mode="chat_completions", turn_id=TURN, session="sess-1"):
    from hermes_cli.middleware import apply_llm_request_middleware

    return apply_llm_request_middleware(request, task_id="task", turn_id=turn_id, api_request_id="req-1", session_id=session, platform="cli",
                                        model="m", provider="p", base_url="http://127.0.0.1:1/v1", api_mode=api_mode, api_call_count=1)


def names(tools, api_mode="chat_completions"):
    return [t["function"]["name"] if api_mode == "chat_completions" else t["name"] for t in tools]


def explicit_turn(bridge, first=ORIENT_STEP, message="Call the orient tool, then tell me my first value."):
    bridge.first_choice = first
    load_provider()
    fire("pre_llm_call", **turn(message=message))


def lite_tool_ran(tool=ORIENT):
    fire("post_tool_call", tool_name=tool, args={"action": "values_list"}, result="{}", session_id="sess-1", turn_id=TURN, tool_call_id="c1", status="ok")


def test_the_first_step_offers_only_the_requested_tool_with_a_required_choice_then_no_tool_once_it_ran(profile, bridge):
    explicit_turn(bridge)
    forced = model_call(chat_request())
    assert names(forced.payload["tools"]) == [ORIENT]
    assert forced.payload["tool_choice"] == "required" and forced.payload["parallel_tool_calls"] is False
    assert [t["source"] for t in forced.trace] == ["psfn_lite"]
    # The choice came with prepare: nothing asked the bridge yet; a retry of the same call is forced the same way.
    assert bridge.bodies("tool-choice") == []
    assert names(model_call(chat_request()).payload["tools"]) == [ORIENT]

    bridge.next_choices.append({"kind": "none"})
    lite_tool_ran()
    after = model_call(chat_request())
    [asked] = bridge.bodies("tool-choice")
    assert asked == {"hostInstance": bridge.bodies("prepare")[0]["hostInstance"], "turnId": "turn-1"}
    assert after.payload["tool_choice"] == "none"
    assert names(after.payload["tools"]) == [ORIENT, MEMORY, "terminal"]

    # Once Lite says the model chooses again (null), the request goes as Hermes built it.
    bridge.next_choices.append(None)
    lite_tool_ran()
    free = model_call(chat_request())
    assert free.changed is False and free.payload == chat_request()
    fire("on_session_end", **end())
    assert model_call(chat_request()).changed is False


def test_each_api_mode_gets_its_own_form_and_the_exact_arguments_schema_replaces_the_tools_own(profile, bridge):
    exact = {"type": "object", "properties": {"action": {"type": "string", "enum": ["values_list"]}}, "required": ["action"], "additionalProperties": False}
    explicit_turn(bridge, first={"kind": "tool", "name": "orient", "parameters": exact})

    anthropic = model_call(anthropic_request(), api_mode="anthropic_messages").payload
    assert names(anthropic["tools"], "anthropic_messages") == [ORIENT] and anthropic["tools"][0]["input_schema"] == exact
    assert anthropic["tool_choice"] == {"type": "any", "disable_parallel_tool_use": True}
    assert "thinking" not in anthropic

    codex = model_call(codex_request(), api_mode="codex_responses").payload
    assert names(codex["tools"], "codex_responses") == [ORIENT] and codex["tools"][0]["parameters"] == exact
    assert codex["tool_choice"] == "required" and codex["parallel_tool_calls"] is False

    chat = model_call(chat_request()).payload
    assert chat["tools"][0]["function"]["parameters"] == exact

    bridge.next_choices.append({"kind": "none"})
    lite_tool_ran()
    none = model_call(anthropic_request(), api_mode="anthropic_messages").payload
    # Hermes's own Anthropic mapping of "none" (agent/anthropic_adapter.py): no tools offered.
    assert "tools" not in none and "tool_choice" not in none
    assert model_call(codex_request(), api_mode="codex_responses").payload["tool_choice"] == "none"


@pytest.mark.parametrize("api_mode, request_of, why", [
    ("bedrock_converse", chat_request, "not one the plugin can force"),
    ("chat_completions", lambda: {**chat_request(), "tools": chat_request()["tools"][1:]}, "is not offered to the model"),
])
def test_a_choice_the_plugin_cannot_apply_is_reported_and_the_request_goes_unchanged(profile, bridge, api_mode, request_of, why):
    warnings = []
    explicit_turn(bridge)
    from conftest import plugin_module

    plugin_module("runtime").add_warning_callback(warnings.append)
    result = model_call(request_of(), api_mode=api_mode)
    assert result.changed is False and result.payload == request_of()
    assert any(why in w for w in warnings)


def test_turns_without_an_explicit_request_and_calls_outside_a_lite_turn_are_left_alone(profile, bridge):
    load_provider()
    fire("pre_llm_call", **turn(message="what have you been up to?"))
    lite_tool_ran()
    assert model_call(chat_request()).changed is False
    assert model_call(chat_request(), turn_id="another-turn", session="sess-9").changed is False
    assert bridge.bodies("tool-choice") == []


def test_the_middleware_is_registered_once_however_often_hermes_loads_the_provider(profile):
    from hermes_cli.plugins import get_plugin_manager

    for _ in range(3):
        load_provider()
    ours = [cb for cb in get_plugin_manager()._middleware.get("llm_request", []) if getattr(cb, "__name__", "") == "psfn_lite_llm_request"]
    assert len(ours) == 1
