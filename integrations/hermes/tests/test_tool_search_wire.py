"""The donor's tool steps on the provider wire, through Hermes's own agent loop with Tool Search at its default.

Hermes defers every MCP tool behind its Tool Search bridges by default
(tools.tool_search ``enabled: "auto"``), so the Lite tools are not in the
provider request and the model reaches them through ``tool_call``. These tests
run a real ``AIAgent`` turn (Hermes's request builder, its Tool Search
assembly over the real registry, its DeepSeek provider profile, its tool
dispatch and hooks) against a loopback chat-completions server that records
each provider request as it arrives over HTTP. They show what the 2026-11-09
r2 shakedown lacked: a forced step reaches the provider forced, a "no more
tools" step carries no tools at all, and DeepSeek's thinking is off for the
forced call only.
"""

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from test_host_contract import load_provider

ORIENT = "mcp__psfn_lite__orient"
ORIENT_SCHEMA = {
    "type": "object",
    "properties": {"action": {"type": "string", "enum": ["values_list", "orient"]}},
    "required": ["action"],
}
TOOL_FIELDS = {"tools", "tool_choice", "parallel_tool_calls"}


class ModelServer:
    """A loopback chat-completions endpoint: records each request body and answers from a script (SSE when asked)."""

    def __init__(self):
        self.bodies = []
        self.replies = []
        server = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                return

            def do_GET(self):
                self.send_response(404)
                self.end_headers()

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))) or b"{}")
                if not self.path.endswith("/chat/completions"):  # Hermes's model-metadata probes: not a model call
                    self.send_response(404)
                    self.end_headers()
                    return
                server.bodies.append(body)
                message = server.replies.pop(0) if server.replies else {"role": "assistant", "content": "done"}
                message = message(body) if callable(message) else message  # a reply may answer the request it receives
                finish = "tool_calls" if message.get("tool_calls") else "stop"
                if body.get("stream"):
                    self.send_response(200)
                    self.send_header("Content-Type", "text/event-stream")
                    self.end_headers()
                    delta = {"role": "assistant", "content": message.get("content") or ""}
                    if message.get("tool_calls"):
                        delta["tool_calls"] = [{"index": i, **call} for i, call in enumerate(message["tool_calls"])]
                    for chunk in ({"delta": delta, "finish_reason": None}, {"delta": {}, "finish_reason": finish}):
                        event = {"id": "m", "object": "chat.completion.chunk", "model": body.get("model"), "choices": [{"index": 0, **chunk}]}
                        self.wfile.write(f"data: {json.dumps(event)}\n\n".encode())
                    self.wfile.write(b"data: [DONE]\n\n")
                    self.wfile.flush()
                    return
                payload = json.dumps({"id": "m", "object": "chat.completion", "model": body.get("model"),
                                      "choices": [{"index": 0, "message": message, "finish_reason": finish}],
                                      "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self._server.server_address[1]}/v1"
        threading.Thread(target=self._server.serve_forever, daemon=True).start()

    def close(self):
        self._server.shutdown()
        self._server.server_close()


@pytest.fixture
def model():
    server = ModelServer()
    yield server
    server.close()


@pytest.fixture
def lite_tool():
    """The Lite MCP server's orient tool, registered as Hermes's MCP client registers it (toolset ``mcp-<server>``)."""
    from tools.registry import registry

    calls = []

    def handler(args, **_):
        calls.append(args)
        return json.dumps({"values": ["Kindness"]})

    registry.register(name=ORIENT, toolset="mcp-psfn_lite", schema={"name": ORIENT, "description": "Orient the companion.", "parameters": ORIENT_SCHEMA},
                      handler=handler)
    yield calls
    registry.deregister(ORIENT)


def agent_turn(model, message):
    """One Hermes turn through its own loop: DeepSeek's provider profile, the Lite MCP toolset, Tool Search as configured by default."""
    from run_agent import AIAgent

    agent = AIAgent(api_key="test-key", base_url=model.url, provider="deepseek", model="deepseek-flash", enabled_toolsets=["mcp-psfn_lite"],
                    max_iterations=4, quiet_mode=True, skip_context_files=True, skip_memory=True, save_trajectories=False, platform="cli")
    return agent.run_conversation(message, conversation_history=[], task_id="task")


def tool_names(body):
    return [tool["function"]["name"] for tool in body.get("tools") or []]


def one_call(bridge_tool):
    """The schema of the single ``{name, arguments}`` call the forced bridge accepts, and whether it sits in ``calls``."""
    properties = bridge_tool["function"]["parameters"]["properties"]
    if "calls" in properties:  # 2bd378e: {calls: [{name, arguments}]}
        calls = properties["calls"]
        assert calls["minItems"] == calls["maxItems"] == 1
        return calls["items"], True
    return bridge_tool["function"]["parameters"], False  # f0187332: {name, arguments}


def bridged(arguments):
    """The model's answer to a forced step: the one tool call the offered schema allows, in the form it offers."""
    def answer(body):
        [bridge_tool] = body["tools"]
        schema, batched = one_call(bridge_tool)
        call = {"name": schema["properties"]["name"]["enum"][0], "arguments": arguments}
        payload = {"calls": [call]} if batched else call
        return {"role": "assistant", "content": "", "tool_calls": [
            {"id": "call_1", "type": "function", "function": {"name": "tool_call", "arguments": json.dumps(payload)}}]}
    return answer


def test_by_default_hermes_defers_the_lite_tools_and_thinks_on_deepseek(profile, bridge, model, lite_tool):
    from tools.tool_search import load_config

    assert load_config().enabled == "auto"  # the profile leaves Tool Search at Hermes's default
    load_provider()
    agent_turn(model, "what have you been up to?")
    [free] = model.bodies
    # What r2 saw: the Lite tool is not in the request; the model reaches it through the bridges.
    assert ORIENT not in tool_names(free) and {"tool_search", "tool_describe", "tool_call"} <= set(tool_names(free))
    assert "tool_choice" not in free or free["tool_choice"] == "auto"
    assert free["thinking"] == {"type": "enabled"}


EXACT = {"type": "object", "properties": {"action": {"type": "string", "enum": ["values_list"]}}, "required": ["action"], "additionalProperties": False}


@pytest.mark.parametrize("exact", [None, EXACT], ids=["own-schema", "exact-arguments"])
def test_a_forced_step_forces_the_bridge_to_the_lite_tool_without_thinking_and_the_last_step_carries_no_tools(profile, bridge, model, lite_tool, exact):
    bridge.first_choice = {"kind": "tool", "name": "orient", "parameters": exact}
    bridge.next_choices.append({"kind": "none"})
    model.replies += [bridged({"action": "values_list"}), {"role": "assistant", "content": "Your first value is Kindness."}]
    load_provider()

    result = agent_turn(model, "Call the orient tool, then tell me my first value.")
    forced, last = model.bodies

    # The forced step: only the tool_call bridge, required, one call, and that call can only name the Lite tool,
    # with the tool's own schema (or the donor's exact-arguments schema) for its arguments.
    [bridge_tool] = forced["tools"]
    assert bridge_tool["function"]["name"] == "tool_call"
    assert forced["tool_choice"] == "required" and forced["parallel_tool_calls"] is False
    call, _ = one_call(bridge_tool)
    assert call["properties"]["name"]["enum"] == [ORIENT] and call["required"] == ["name", "arguments"]
    assert call["properties"]["arguments"] == (exact or ORIENT_SCHEMA)
    # DeepSeek refuses a forced choice while thinking (HTTP 400 in r2): thinking off, no effort, for this call.
    assert forced["thinking"] == {"type": "disabled"} and "reasoning_effort" not in forced

    # Hermes unwrapped the bridge: the Lite tool ran with the model's arguments, and the plugin's post_tool_call saw its
    # own name (it asked Lite for the next step exactly once).
    assert lite_tool == [{"action": "values_list"}]
    assert len(bridge.bodies("tool-choice")) == 1

    # The "no more tools" step: no tools at all (the donor's buildPiContext), so nothing can be written as a call.
    assert not TOOL_FIELDS & set(last)
    assert last["thinking"] == {"type": "enabled"}  # the next, unforced call thinks again
    # ...and DeepSeek in thinking mode requires reasoning_content on every earlier tool-call turn (HTTP 400 without it);
    # the forced call ran without thinking, so Hermes pads it (agent/message_sanitization.py reapply_reasoning_echo).
    [replayed] = [m for m in last["messages"] if m.get("role") == "assistant" and m.get("tool_calls")]
    assert isinstance(replayed.get("reasoning_content"), str) and replayed["reasoning_content"]
    assert result["final_response"] == "Your first value is Kindness."
    [settled] = bridge.bodies("settle")
    assert settled["outcome"]["kind"] == "completed" and settled["outcome"]["reply"] == "Your first value is Kindness."
