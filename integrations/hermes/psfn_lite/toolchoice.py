"""The donor's explicit tool contract, applied to Hermes's provider request.

When the participant asks for tools by name ("call tool_search, then
orient"), the donor forced each model call of the turn: exactly the
requested tool while the sequence runs, then no tool at all (its provider
client, primitives/llm/client-request-capability.ts applyExplicitToolChoice
and buildPiContext). Its stream adapter fails the turn on any other answer.
Lite hands the host that choice per model call (``toolChoice`` in prepare's
context and the bridge's ``tool-choice`` route); this module rewrites
Hermes's request for it, in Hermes's ``llm_request`` middleware
(hermes_cli/middleware.py apply_llm_request_middleware), as the donor rewrote
its own: the one tool offered with a required choice, or no tool.

Hermes builds one request shape per API mode. Supported here are the three
whose tool fields the plugin knows; any other mode is reported and left
unchanged, so the turn may still fail Lite's check.
"""

#: Hermes api_mode values whose request tool fields this module rewrites.
SUPPORTED_API_MODES = ("chat_completions", "codex_responses", "anthropic_messages")


class ChoiceError(ValueError):
    """The choice cannot be applied to this request; the message says why (no secret, no content)."""


def _tool_name(entry, api_mode):
    if not isinstance(entry, dict):
        return None
    if api_mode == "chat_completions":
        function = entry.get("function")
        return function.get("name") if isinstance(function, dict) else None
    return entry.get("name")


def _with_parameters(entry, api_mode, parameters):
    """The tool entry with the donor's exact-arguments schema in place of its own (buildPiContext)."""
    entry = dict(entry)
    if api_mode == "chat_completions":
        entry["function"] = {**entry["function"], "parameters": parameters}
    elif api_mode == "codex_responses":
        entry["parameters"] = parameters
    else:
        entry["input_schema"] = parameters
    return entry


def apply(request: dict, api_mode: str, choice: dict, tool_prefix: str) -> dict:
    """The request rewritten for ``choice`` ({kind: tool, name, parameters} or {kind: none}). Raises ChoiceError."""
    if api_mode not in SUPPORTED_API_MODES:
        raise ChoiceError(f"Hermes API mode {api_mode!r} is not one the plugin can force a tool choice on")
    rewritten = dict(request)
    if choice.get("kind") == "none":
        # The donor offered no tool once the requested sequence ran.
        if api_mode == "anthropic_messages":
            # Hermes's own Anthropic mapping of "none": the API has no such choice, so the tools are omitted.
            rewritten.pop("tools", None)
            rewritten.pop("tool_choice", None)
        elif rewritten.get("tools"):
            rewritten["tool_choice"] = "none"
            rewritten.pop("parallel_tool_calls", None)
        return rewritten
    if choice.get("kind") != "tool" or not isinstance(choice.get("name"), str):
        raise ChoiceError("Lite answered an unknown tool choice")
    wanted = tool_prefix + choice["name"]
    tools = [entry for entry in rewritten.get("tools") or [] if _tool_name(entry, api_mode) == wanted]
    if len(tools) != 1:
        raise ChoiceError(f"the requested tool {wanted} is not offered to the model in this Hermes request")
    parameters = choice.get("parameters")
    if isinstance(parameters, dict):
        tools = [_with_parameters(tools[0], api_mode, parameters)]
    rewritten["tools"] = tools
    if api_mode == "anthropic_messages":
        rewritten["tool_choice"] = {"type": "any", "disable_parallel_tool_use": True}
        # Anthropic refuses extended thinking with a forced tool choice; the donor dropped reasoning where its provider did.
        rewritten.pop("thinking", None)
    else:
        rewritten["tool_choice"] = "required"
        rewritten["parallel_tool_calls"] = False
    return rewritten
