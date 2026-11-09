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


def _openai_tools():
    return [{"type": "function", "function": {"name": name, "description": name, "parameters": {"type": "object"}}} for name in (ORIENT, MEMORY, "terminal")]


def _transport_request(api_mode):
    from agent.transports import get_transport

    return get_transport(api_mode).build_kwargs(model="gpt-5.5", messages=[{"role": "system", "content": "s"}, {"role": "user", "content": "hi"}],
                                                tools=_openai_tools(), instructions="s")


# The provider requests as Hermes's own builders make them, before its llm_request middleware runs
# (agent/chat_completion_helpers.py: the API-mode kwargs are built first, then the middleware).
def chat_request():
    return _transport_request("chat_completions")


def codex_request():
    return _transport_request("codex_responses")


def anthropic_request():
    from agent.anthropic_adapter import build_anthropic_kwargs

    # A manual-thinking model, so the request carries the thinking block Anthropic refuses with a forced tool.
    return build_anthropic_kwargs(model="claude-sonnet-4-5", messages=[{"role": "user", "content": "hi"}], tools=_openai_tools(),
                                  max_tokens=1024, reasoning_config={"enabled": True, "effort": "medium"})


def model_call(request, *, api_mode="chat_completions", turn_id=TURN, session="sess-1", provider="p", base_url="http://127.0.0.1:1/v1", model="m"):
    from hermes_cli.middleware import apply_llm_request_middleware

    return apply_llm_request_middleware(request, task_id="task", turn_id=turn_id, api_request_id="req-1", session_id=session, platform="cli",
                                        model=model, provider=provider, base_url=base_url, api_mode=api_mode, api_call_count=1)


def thinking_request(provider, model):
    """chat_request() with the thinking fields Hermes's own provider profile adds for ``provider`` (build_api_kwargs_extras)."""
    from providers import get_provider_profile

    extra_body, top_level = get_provider_profile(provider).build_api_kwargs_extras(reasoning_config={"enabled": True, "effort": "high"}, model=model)
    return {**chat_request(), **top_level, "extra_body": extra_body}


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
    # The donor's "no more tools" step removes the tools (buildPiContext); "none" with the tools kept let the
    # model write the call it wanted as the reply (shakedown r2, R2-3).
    assert not {"tools", "tool_choice", "parallel_tool_calls"} & set(after.payload)
    assert after.payload == {k: v for k, v in chat_request().items() if k not in ("tools", "tool_choice", "parallel_tool_calls")}

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

    assert "thinking" in anthropic_request()
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
    # Every API mode's "no more tools" step offers no tool at all, as the donor's (and Hermes's own Anthropic "none").
    for api_mode, request_of in (("anthropic_messages", anthropic_request), ("codex_responses", codex_request), ("chat_completions", chat_request)):
        none = model_call(request_of(), api_mode=api_mode).payload
        assert not {"tools", "tool_choice", "parallel_tool_calls"} & set(none), api_mode


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


@pytest.mark.parametrize("provider, model, base_url", [
    ("deepseek", "deepseek-v4-flash", "https://api.deepseek.com/v1"),
    ("kimi-coding", "kimi-k2.6", "https://api.moonshot.ai/v1"),
    ("custom", "deepseek-v4-flash", "https://api.deepseek.com/v1"),  # matched by the provider's host, as Hermes matches it
])
def test_a_forced_step_turns_thinking_off_for_that_call_on_providers_that_refuse_forced_choice_while_thinking(profile, bridge, provider, model, base_url):
    explicit_turn(bridge)
    built = thinking_request("deepseek" if provider == "custom" else provider, model)
    assert built["extra_body"].get("thinking", {}).get("type") != "disabled" and (built.get("reasoning_effort") or built["extra_body"]["thinking"])
    forced = model_call(built, provider=provider, base_url=base_url, model=model).payload
    assert names(forced["tools"]) == [ORIENT] and forced["tool_choice"] == "required"
    # The disabled toggle Hermes itself sends for thinking off (agent/reasoning_effort.py thinking_toggle_extras), no effort.
    assert forced["extra_body"]["thinking"] == {"type": "disabled"} and "reasoning_effort" not in forced

    bridge.next_choices.append({"kind": "none"})
    lite_tool_ran()
    # Only the forced call: the "no more tools" step goes with Hermes's own thinking fields.
    none = model_call(built, provider=provider, base_url=base_url, model=model).payload
    assert none["extra_body"] == built["extra_body"] and none.get("reasoning_effort") == built.get("reasoning_effort")


def test_a_provider_outside_the_capability_table_keeps_its_thinking_on_a_forced_step(profile, bridge):
    explicit_turn(bridge)
    # An aggregator serving a DeepSeek model takes its own reasoning wire; the plugin does not guess it.
    built = {**chat_request(), "extra_body": {"reasoning": {"enabled": True}}}
    forced = model_call(built, provider="openrouter", base_url="https://openrouter.ai/api/v1", model="deepseek/deepseek-flash").payload
    assert forced["tool_choice"] == "required" and forced["extra_body"] == {"reasoning": {"enabled": True}}


def test_a_deferred_lite_tool_is_forced_through_the_tool_call_bridge_in_every_api_mode(profile, bridge):
    from conftest import plugin_module

    load_provider()
    toolchoice = plugin_module("toolchoice")
    schema = {"type": "object", "properties": {"action": {"type": "string"}}, "required": ["action"]}
    known = lambda name: (schema, "Orient the companion.") if name == ORIENT else None  # noqa: E731
    bridge_call = {"type": "object", "properties": {"calls": {"type": "array", "items": {"type": "object"}}}, "required": ["calls"]}
    bridged = {
        "chat_completions": {"tools": [{"type": "function", "function": {"name": n, "description": n, "parameters": bridge_call}} for n in ("terminal", "tool_search", "tool_call")]},
        "codex_responses": {"tools": [{"type": "function", "name": n, "description": n, "parameters": bridge_call} for n in ("terminal", "tool_call")]},
        "anthropic_messages": {"tools": [{"name": n, "description": n, "input_schema": bridge_call} for n in ("terminal", "tool_call")], "thinking": {"type": "enabled"}},
    }
    for api_mode, request in bridged.items():
        forced = toolchoice.apply(request, api_mode, ORIENT_STEP, "mcp__psfn_lite__", lookup=known)
        [only] = forced["tools"]
        parameters = only["function"]["parameters"] if api_mode == "chat_completions" else only["parameters" if api_mode == "codex_responses" else "input_schema"]
        call = parameters["properties"]["calls"]["items"]
        assert call["properties"]["name"]["enum"] == [ORIENT] and call["properties"]["arguments"] == schema, api_mode
        assert "thinking" not in forced
    # f0187332's bridge takes one {name, arguments}; the narrowed schema keeps that form.
    single = {"type": "object", "properties": {"name": {"type": "string"}, "arguments": {"type": "object"}}, "required": ["name", "arguments"]}
    request = {"tools": [{"type": "function", "function": {"name": "tool_call", "description": "d", "parameters": single}}]}
    [only] = toolchoice.apply(request, "chat_completions", ORIENT_STEP, "mcp__psfn_lite__", lookup=known)["tools"]
    assert only["function"]["parameters"]["properties"]["name"]["enum"] == [ORIENT]
    # A bridge for a tool Hermes does not have is refused, not forced.
    with pytest.raises(toolchoice.ChoiceError, match="not offered"):
        toolchoice.apply(bridged["chat_completions"], "chat_completions", {"kind": "tool", "name": "journal", "parameters": None}, "mcp__psfn_lite__", lookup=known)
