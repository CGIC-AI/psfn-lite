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
its own:

- a tool step offers the one tool with a required choice (the donor's
  ``toolChoice: 'required'`` over a one-tool context);
- a "no more tools" step offers no tool at all: the donor removed the tools
  from the request (buildPiContext, ``choice === 'none'``);
- a forced step on a provider that refuses a forced choice while thinking
  turns thinking off for that one request (the donor's Kimi quirk,
  primitives/llm/models.ts requiresThinkingDisabledForRequiredTools, as a
  capability table: FORCED_CHOICE_WITHOUT_THINKING).

Hermes Tool Search (2bd378e tools/tool_search.py, on by default) takes MCP
tools out of the request and offers its ``tool_call`` bridge instead; Hermes
has no per-server or per-tool exemption (is_deferrable_tool_name defers every
``mcp-*`` toolset, and neither the plugin API nor the registry takes a flag).
A tool step for a deferred Lite tool therefore forces the bridge: the request
offers only ``tool_call``, its ``calls`` narrowed to exactly one call of the
Lite tool with the tool's own (or the exact-arguments) schema. Hermes unwraps
that call before its hooks, approvals and dispatch (agent/tool_executor.py
_unwrap_tool_search_call), so the hooks see the Lite tool's own name.

Hermes builds one request shape per API mode. Supported here are the three
whose tool fields the plugin knows; any other mode is reported and left
unchanged, so the turn may still fail Lite's check.
"""

from urllib.parse import urlparse

#: Hermes api_mode values whose request tool fields this module rewrites.
SUPPORTED_API_MODES = ("chat_completions", "codex_responses", "anthropic_messages")

#: Hermes Tool Search's bridge that invokes deferred tools (2bd378e tools/tool_search_catalog.py TOOL_CALL_NAME).
TOOL_CALL_BRIDGE = "tool_call"

#: Providers that refuse a forced tool choice while thinking is on, matched by Hermes provider id or by the
#: base URL's host, and how a forced request turns thinking off on their chat-completions wire. DeepSeek answers
#: 400 "Thinking mode does not support this tool_choice" (shakedown lite-hermes-artie-20261109-r2); Kimi Code is the
#: donor's own case (models.ts:61-67). Both take Hermes's thinking toggle (agent/reasoning_effort.py
#: thinking_toggle_extras: ``extra_body.thinking`` and a top-level ``reasoning_effort``; the disabled form is
#: ``{"thinking": {"type": "disabled"}}`` with no effort). The hosts are the ones Hermes itself treats as these
#: vendors (agent/message_sanitization.py _REASONING_ECHO_RULES); a model id alone is not matched, because an
#: aggregator serving the same model takes another reasoning wire. Anthropic's Messages API refuses a forced
#: choice with extended thinking on every model, so the anthropic_messages mode always drops ``thinking``.
FORCED_CHOICE_WITHOUT_THINKING = (
    {"family": "deepseek", "providers": ("deepseek",), "hosts": ("api.deepseek.com",)},
    {"family": "kimi", "providers": ("kimi-coding", "kimi-coding-cn"), "hosts": ("api.kimi.com", "moonshot.ai", "moonshot.cn")},
)


class ChoiceError(ValueError):
    """The choice cannot be applied to this request; the message says why (no secret, no content)."""


def _tool_name(entry, api_mode):
    if not isinstance(entry, dict):
        return None
    if api_mode == "chat_completions":
        function = entry.get("function")
        return function.get("name") if isinstance(function, dict) else None
    return entry.get("name")


def _with_parameters(entry, api_mode, parameters, description=None):
    """The tool entry with ``parameters`` (and ``description``) in place of its own."""
    entry = dict(entry)
    if api_mode == "chat_completions":
        function = {**entry["function"], "parameters": parameters}
        if description:
            function["description"] = description
        entry["function"] = function
        return entry
    if api_mode == "codex_responses":
        entry["parameters"] = parameters
    else:
        entry["input_schema"] = parameters
    if description:
        entry["description"] = description
    return entry


def _host_matches(base_url, domain):
    text = base_url or ""
    try:
        host = (urlparse(text if "//" in text else f"//{text}").hostname or "").lower()
    except ValueError:
        return False
    return bool(host) and (host == domain or host.endswith("." + domain))


def thinking_family(api_mode, provider, base_url):
    """The FORCED_CHOICE_WITHOUT_THINKING family of this request's provider ("anthropic" for the Messages API), else None."""
    if api_mode == "anthropic_messages":
        return "anthropic"
    if api_mode != "chat_completions":
        return None
    provider = (provider or "").strip().lower()
    for row in FORCED_CHOICE_WITHOUT_THINKING:
        if provider in row["providers"] or any(_host_matches(base_url, host) for host in row["hosts"]):
            return row["family"]
    return None


def _without_thinking(request, family):
    """The forced request with thinking off for this one call (the donor deleted reasoning and sent thinking disabled)."""
    if family == "anthropic":
        request.pop("thinking", None)
    elif family is not None:
        extra_body = request.get("extra_body")
        request["extra_body"] = {**(extra_body if isinstance(extra_body, dict) else {}), "thinking": {"type": "disabled"}}
        request.pop("reasoning_effort", None)
    return request


def registered_tool(name):
    """The Hermes registry's (parameters, description) for a deferred tool, or None when Hermes has no such tool."""
    try:
        from tools.registry import registry
    except ImportError:
        return None
    schema = registry.get_schema(name)
    if not isinstance(schema, dict):
        return None
    function = schema.get("function") if schema.get("type") == "function" else schema
    if not isinstance(function, dict):
        return None
    parameters = function.get("parameters")
    return (parameters if isinstance(parameters, dict) else {"type": "object"}), function.get("description") or ""


def _parameters(entry, api_mode):
    if api_mode == "chat_completions":
        function = entry.get("function")
        return function.get("parameters") if isinstance(function, dict) else None
    return entry.get("parameters" if api_mode == "codex_responses" else "input_schema")


def _one_call_bridge(entry, api_mode, wanted, arguments, description):
    """Hermes's ``tool_call`` bridge narrowed to exactly one call of ``wanted`` with ``arguments`` as its schema.

    The bridge takes ``{calls: [{name, arguments}]}`` at 2bd378e (tools/tool_search.py bridge_tool_schemas) and one
    ``{name, arguments}`` at f0187332; the narrowed schema keeps the form the request offers.
    """
    one = {
        "type": "object",
        "properties": {
            "name": {"type": "string", "enum": [wanted], "description": "Exact tool name to invoke."},
            "arguments": arguments,
        },
        "required": ["name", "arguments"],
    }
    offered = _parameters(entry, api_mode)
    properties = offered.get("properties") if isinstance(offered, dict) else None
    properties = properties if isinstance(properties, dict) else {}
    if "calls" in properties:
        parameters = {
            "type": "object",
            "properties": {"calls": {"type": "array", "minItems": 1, "maxItems": 1, "items": one, "description": f"Exactly one invocation of {wanted}."}},
            "required": ["calls"],
        }
        form = "`calls` holds exactly one {name, arguments} entry"
    elif {"name", "arguments"} <= set(properties):
        parameters, form = one, "`name` and its `arguments`"
    else:
        raise ChoiceError(f"Hermes's {TOOL_CALL_BRIDGE} bridge has a form the plugin does not know, so {wanted} cannot be forced through it")
    summary = f"Invoke {wanted}: {form}." + (f" {wanted}: {description}" if description else "")
    return _with_parameters(entry, api_mode, parameters, summary)


def apply(request, api_mode, choice, tool_prefix, *, provider="", base_url="", lookup=registered_tool):
    """The request rewritten for ``choice`` ({kind: tool, name, parameters} or {kind: none}). Raises ChoiceError."""
    if api_mode not in SUPPORTED_API_MODES:
        raise ChoiceError(f"Hermes API mode {api_mode!r} is not one the plugin can force a tool choice on")
    rewritten = dict(request)
    if choice.get("kind") == "none":
        # The donor offered no tool once the requested sequence ran: the tools leave the request.
        for field in ("tools", "tool_choice", "parallel_tool_calls"):
            rewritten.pop(field, None)
        return rewritten
    if choice.get("kind") != "tool" or not isinstance(choice.get("name"), str):
        raise ChoiceError("Lite answered an unknown tool choice")
    wanted = tool_prefix + choice["name"]
    offered = rewritten.get("tools") or []
    exact = choice.get("parameters") if isinstance(choice.get("parameters"), dict) else None
    tools = [entry for entry in offered if _tool_name(entry, api_mode) == wanted]
    if len(tools) == 1:
        tools = [_with_parameters(tools[0], api_mode, exact)] if exact is not None else tools
    else:
        # Deferred by Hermes Tool Search: force its tool_call bridge to the one Lite tool.
        bridges = [entry for entry in offered if _tool_name(entry, api_mode) == TOOL_CALL_BRIDGE]
        known = lookup(wanted) if not tools and len(bridges) == 1 else None
        if known is None:
            raise ChoiceError(f"the requested tool {wanted} is not offered to the model in this Hermes request")
        parameters, description = known
        tools = [_one_call_bridge(bridges[0], api_mode, wanted, exact if exact is not None else parameters, description)]
    rewritten["tools"] = tools
    if api_mode == "anthropic_messages":
        rewritten["tool_choice"] = {"type": "any", "disable_parallel_tool_use": True}
    else:
        rewritten["tool_choice"] = "required"
        rewritten["parallel_tool_calls"] = False
    return _without_thinking(rewritten, thinking_family(api_mode, provider, base_url))
