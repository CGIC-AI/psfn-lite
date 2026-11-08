"""The continuity conformance runner inside the pinned Hermes.

It runs the scenario files of tests/conformance/scenarios against the same
conformance host process the TypeScript runner drives
(tests/conformance/fixtures/host-process.ts), with Hermes as the Hermes
surface: the real psfn_lite plugin through Hermes's own hook dispatch
(``pre_llm_call``, ``post_tool_call``, ``post_llm_call``, ``on_session_end``)
and Hermes's own MCP client and tool dispatch (``handle_function_call``)
for every governed call. The Pi surface and the host operations go to the
host process, exactly as in the TypeScript runner.

What the companion is shown on Hermes is what Hermes sends: the participant's
message, then the plugin's context appended to it (agent/turn_context.py),
after the earlier messages of the same Hermes session.

``resolve_templates``, ``capture_into``, ``canonical``, ``participant_blocks``
and the checks mirror tests/conformance/scenario.ts; keep them in step.
"""

import json
import os
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
from concurrent.futures import Future, ThreadPoolExecutor
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
SCENARIO_DIR = REPO / "tests" / "conformance" / "scenarios"
HOST_ENTRY = REPO / "tests" / "conformance" / "fixtures" / "host-process.ts"
POSTGRES_ENTRY = REPO / "tests" / "conformance" / "fixtures" / "postgres.ts"
SERVER = "psfn_lite"
READY_TIMEOUT_SECONDS = 180
REQUEST_TIMEOUT_SECONDS = 90
EVENT_TIMEOUT_SECONDS = 30


# -- the shared contract (mirrors tests/conformance/scenario.ts) ----------------

def load_scenarios() -> list:
    return [json.loads(path.read_text(encoding="utf-8")) for path in sorted(SCENARIO_DIR.glob("*.json"))]


def orders_of(scenario: dict) -> list:
    return [("pi", "hermes"), ("hermes", "pi")] if scenario["orders"] == "both" else [("pi", "hermes")]


def surface_of(on: str, order: tuple) -> str:
    return {"a": order[0], "b": order[1]}.get(on, on)


_TEMPLATE = re.compile(r"\{\{([a-zA-Z0-9_.-]+)\}\}")


def resolve_templates(value, variables: dict):
    if isinstance(value, str):
        def replace(match):
            name = match.group(1)
            if name not in variables:
                raise KeyError(f"unknown scenario variable {{{{{name}}}}}")
            return variables[name]

        return _TEMPLATE.sub(replace, value)
    if isinstance(value, list):
        return [resolve_templates(v, variables) for v in value]
    if isinstance(value, dict):
        return {k: resolve_templates(v, variables) for k, v in value.items()}
    return value


def capture_into(variables: dict, text: str, patterns) -> None:
    for name, pattern in (patterns or {}).items():
        match = re.search(pattern, text)
        if match is None or match.group(1) is None:
            raise ValueError(f"capture {name}: /{pattern}/ did not match {text[:400]}")
        variables[name] = match.group(1)


def canonical(content) -> str:
    """JSON.stringify's compact form; dict order is the order the JSON was parsed in."""
    return content if isinstance(content, str) else json.dumps(content, separators=(",", ":"), ensure_ascii=False)


_PARTICIPANT_BLOCK = re.compile(r"(?:^|\n\n)\[participant speech\]\n([\s\S]*?)(?=\n\n\[[^\]\n]+\]\n|$)")
_QUOTED_LABEL = re.compile(r"^([ \t]*)\\\[", re.MULTILINE)


def participant_blocks(rendered: str) -> list:
    return [_QUOTED_LABEL.sub(r"\1[", m.group(1)) for m in _PARTICIPANT_BLOCK.finditer(rendered)]


def check_result(expect, result: dict, at: str) -> list:
    expect = expect or {}
    issues = []
    want_ok = expect.get("ok", "error" not in expect)
    if result["ok"] != want_ok:
        got = canonical(result["content"])[:300] if result["ok"] else json.dumps(result["error"])
        return [f"{at}: expected {'success' if want_ok else 'a refusal'}, got {got}"]
    if not result["ok"]:
        error = result["error"]
        if "error" in expect and error.get("kind") != expect["error"]:
            issues.append(f"{at}: expected error {expect['error']}, got {json.dumps(error)}")
        if "reason" in expect and error.get("reason") != expect["reason"]:
            issues.append(f"{at}: expected reason {expect['reason']}, got {json.dumps(error)}")
        return issues
    return check_text(expect, canonical(result["content"]), at)


def check_text(expect, text: str, at: str) -> list:
    expect = expect or {}
    issues = []
    for s in expect.get("has", []):
        if s not in text:
            issues.append(f"{at}: missing {json.dumps(s)} in {text[:600]}")
    for s in expect.get("lacks", []):
        if s in text:
            issues.append(f"{at}: must not contain {json.dumps(s)}")
    for s, n in expect.get("count", {}).items():
        found = text.count(s)
        if found != n:
            issues.append(f"{at}: expected {n} of {json.dumps(s)}, found {found} in {text[:1200]}")
    return issues


def check_turn(step: dict, observed: dict, at: str) -> list:
    issues = []
    refused = step.get("refused")
    if refused is not None:
        got = observed["refused"]
        if got is None:
            return [f"{at}: expected Lite to refuse the turn ({refused['error']})"]
        if got.get("kind") != refused["error"]:
            issues.append(f"{at}: expected refusal {refused['error']}, got {json.dumps(got)}")
        if "reason" in refused and got.get("reason") != refused["reason"]:
            issues.append(f"{at}: expected reason {refused['reason']}, got {json.dumps(got)}")
        return issues
    if observed["refused"] is not None:
        return [f"{at}: Lite refused the turn: {json.dumps(observed['refused'])}"]
    seen, speech = observed["seen"], observed["speech"]
    for s in step.get("sees", []):
        if s not in seen:
            issues.append(f"{at}: the companion was not shown {json.dumps(s)}")
    for s in step.get("hides", []):
        if s in seen:
            issues.append(f"{at}: the companion was shown {json.dumps(s)}")
    for s in step.get("speech", []):
        if not any(s in t for t in speech):
            issues.append(f"{at}: {json.dumps(s)} was not presented as participant speech")
    for s in step.get("notSpeech", []):
        if s not in seen:
            issues.append(f"{at}: {json.dumps(s)} was not shown at all")
        if any(s in t for t in speech):
            issues.append(f"{at}: {json.dumps(s)} was presented as participant speech")
    if not step.get("abandon") and "crash" not in step:
        calls = step.get("calls", [])
        if len(observed["results"]) != len(calls):
            issues.append(f"{at}: {len(calls)} calls planned, {len(observed['results'])} results")
        for call, result in zip(calls, observed["results"]):
            issues.extend(check_result(call.get("expect"), result, f"{at} {call['tool']}.{call['action']}"))
    return issues


# -- processes -------------------------------------------------------------------

def _node_argv(entry: Path) -> list:
    node = shutil.which("node")
    if node is None or not (REPO / "node_modules" / "tsx").exists():
        raise RuntimeError("the conformance runner needs node and the repository's node_modules (run it under mise; see docs/development.md)")
    # node with tsx's loader in one process, so SIGKILL reaches the runtime itself.
    return [node, "--import", "tsx", str(entry)]


class HostGone(RuntimeError):
    pass


class HostProcess:
    """The conformance host over JSON lines, as tests/conformance/host-client.ts drives it."""

    def __init__(self, state: dict):
        self._process = subprocess.Popen(_node_argv(HOST_ENTRY), cwd=REPO, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                         text=True, env={"PATH": os.environ.get("PATH", "")})
        self._lock = threading.Condition()
        self._pending = {}
        self._events = {}
        self._next = 1
        self._ready = None
        self._exited = False
        self.stderr_tail = ""
        self.state = state
        threading.Thread(target=self._read, daemon=True).start()
        threading.Thread(target=self._drain_stderr, daemon=True).start()
        self._process.stdin.write(json.dumps(state) + "\n")
        self._process.stdin.flush()
        with self._lock:
            if not self._lock.wait_for(lambda: self._ready is not None or self._exited, READY_TIMEOUT_SECONDS) or self._ready is None:
                self._process.kill()
                raise RuntimeError(f"the conformance host did not start: {self.stderr_tail}")
        self.ready = self._ready
        self.state = self._ready["state"]

    def _drain_stderr(self):
        for line in self._process.stderr:
            self.stderr_tail = (self.stderr_tail + line)[-20000:]
            if os.environ.get("LITE_CONFORMANCE_DEBUG") == "1":
                sys.stderr.write(line)

    def _read(self):
        for line in self._process.stdout:
            message = json.loads(line)
            with self._lock:
                if "event" in message:
                    if message["event"] == "ready":
                        self._ready = message
                    else:
                        self._events[message["event"]] = self._events.get(message["event"], 0) + 1
                else:
                    future = self._pending.pop(message["id"], None)
                    if isinstance(message.get("state"), dict):
                        self.state = message["state"]
                    if future is not None:
                        if message["ok"]:
                            future.set_result(message.get("value"))
                        else:
                            future.set_exception(RuntimeError(str(message.get("error"))))
                self._lock.notify_all()
        with self._lock:
            self._exited = True
            for future in self._pending.values():
                future.set_exception(HostGone(f"the conformance host exited: {self.stderr_tail[-2000:]}"))
            self._pending.clear()
            self._lock.notify_all()

    def submit(self, op: str, args: dict = None) -> Future:
        future = Future()
        with self._lock:
            if self._exited:
                future.set_exception(HostGone("the conformance host has exited"))
                return future
            ident = self._next
            self._next += 1
            self._pending[ident] = future
            self._process.stdin.write(json.dumps({"id": ident, "op": op, "args": args or {}}) + "\n")
            self._process.stdin.flush()
        return future

    def request(self, op: str, args: dict = None):
        return self.submit(op, args).result(timeout=REQUEST_TIMEOUT_SECONDS)

    def event_count(self, event: str) -> int:
        with self._lock:
            return self._events.get(event, 0)

    def wait_event(self, event: str, after: int) -> None:
        with self._lock:
            if not self._lock.wait_for(lambda: self._events.get(event, 0) > after, EVENT_TIMEOUT_SECONDS):
                raise TimeoutError(f"no {event} event within {EVENT_TIMEOUT_SECONDS}s")

    def kill(self) -> dict:
        """SIGKILL: nothing in flight survives, as in a crash."""
        if self._process.poll() is None:
            self._process.send_signal(signal.SIGKILL)
        self._process.wait(timeout=30)
        with self._lock:
            self._lock.wait_for(lambda: self._exited, 10)
        return self.state

    def close(self) -> None:
        if self._process.poll() is not None:
            return
        try:
            self.request("close")
        except Exception:  # noqa: BLE001 - a host already dying is closed by the kill below
            pass
        try:
            self._process.stdin.close()
            self._process.wait(timeout=60)
        except (OSError, subprocess.TimeoutExpired):
            self._process.kill()
            self._process.wait(timeout=30)


class PostgresFixture:
    """A throwaway labelled Postgres container from tests/conformance/fixtures/postgres.ts."""

    def __init__(self):
        self._process = subprocess.Popen(_node_argv(POSTGRES_ENTRY), cwd=REPO, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=sys.stderr, text=True,
                                         env={"PATH": os.environ.get("PATH", ""), "HOME": os.environ.get("HOME", "")})
        line = self._readline()
        if json.loads(line).get("event") != "ready":
            raise RuntimeError(f"the postgres fixture did not start: {line}")

    def _readline(self) -> str:
        deadline = time.monotonic() + READY_TIMEOUT_SECONDS
        result = {}

        def read():
            result["line"] = self._process.stdout.readline()

        reader = threading.Thread(target=read, daemon=True)
        reader.start()
        reader.join(max(0.0, deadline - time.monotonic()))
        line = result.get("line", "")
        if not line:
            self._process.kill()
            raise RuntimeError("the postgres fixture did not answer")
        return line

    def create(self) -> str:
        self._process.stdin.write("create\n")
        self._process.stdin.flush()
        return json.loads(self._readline())["databaseUrl"]

    def stop(self) -> None:
        if self._process.poll() is None:
            self._process.stdin.close()
            self._process.wait(timeout=120)


# -- the Hermes surface -----------------------------------------------------------

#: The plugin's statement that the text ahead of its context is the participant's message (psfn_lite/render.py).
PARTICIPANT_MESSAGE_NOTE = "The text before this note is the participant's own message for this turn"
_REFUSED = re.compile(r"Lite refused the request: (\w+)(?: \(([^)]+)\))?")


def fire(name, **kwargs):
    from hermes_cli.lifecycle import invoke_hook

    return invoke_hook(name, **kwargs)


def parse_tool_result(raw) -> dict:
    """Hermes's MCP result string as the scenario's call result: core content, or core's error kind and reason."""
    text = raw if isinstance(raw, str) else json.dumps(raw)
    try:
        payload = json.loads(text)
    except ValueError:
        return {"ok": False, "error": {"kind": "unparsed", "reason": text[:200]}}
    if isinstance(payload, dict) and "error" in payload:
        inner = payload["error"]
        try:
            core = json.loads(inner).get("error") if isinstance(inner, str) else None
        except ValueError:
            core = None
        if not isinstance(core, dict):
            # Not a Lite refusal: Hermes's gate, its MCP client, or a dead connection.
            return {"ok": False, "error": {"kind": "transport", "reason": str(inner)[:300]}}
        reason = core.get("reason", core.get("capability"))
        return {"ok": False, "error": {"kind": str(core.get("kind")), **({"reason": reason} if isinstance(reason, str) else {})}}
    structured = payload.get("structuredContent") if isinstance(payload, dict) else None
    if structured is None and isinstance(payload, dict):
        result = payload.get("result")
        structured = result if isinstance(result, dict) else json.loads(result)
    return {"ok": True, "content": structured.get("content")}


class Profile:
    def __init__(self, name: str, home: Path, principal: str, platform: str, sender: str):
        self.name = name
        self.home = home
        self.principal = principal
        self.platform = platform
        self.sender = sender
        self.session = f"conformance-{name}"
        #: A Hermes process of this profile died with a turn open; its successor settles what the ledger kept.
        self.successor_pending = False
        #: (role, text) of this Hermes session, as Hermes replays them to the model.
        self.transcript = []


class HermesSurface:
    def __init__(self, base: Path, write_profile, credential_env: str, plugin_module, namespace: str):
        self._write_profile = write_profile
        self._namespace = namespace
        self._loaded = None
        self._credential_env = credential_env
        self._plugin_module = plugin_module
        self._connected = None
        self.ready = None
        self.profiles = {
            "operator": Profile("operator", base / "hermes-operator", "hermes-operator", "cli", ""),
            "friend": Profile("friend", base / "hermes-friend", "hermes-friend", "telegram", "friend-1"),
        }

    def attach(self, ready: dict) -> None:
        """A (new) Lite host: same ports, so the profiles stay valid; Hermes's MCP sessions to the old one are gone."""
        self.ready = ready
        for profile in self.profiles.values():
            profile.home.mkdir(parents=True, exist_ok=True)
            senders = [{"platform": profile.platform, "sender_id": profile.sender}]
            self._write_profile(profile.home, bridge_url=ready["lifecycleUrl"], mcp_url=ready["mcpUrl"], senders=senders)
            settings = json.loads((profile.home / "psfn-lite.json").read_text())
            settings["max_context_chars"] = 200000
            (profile.home / "psfn-lite.json").write_text(json.dumps(settings))
        self.disconnect()

    def close(self) -> None:
        self.disconnect()
        self._unload()

    def disconnect(self) -> None:
        from tools.mcp_tool import shutdown_mcp_servers

        if self._connected is not None:
            shutdown_mcp_servers()
        self._connected = None

    def use(self, name: str) -> Profile:
        from plugins.memory import load_memory_provider
        from tools.mcp_tool import discover_mcp_tools

        profile = self.profiles[name]
        if self._connected != name:
            self.disconnect()
            os.environ["HERMES_HOME"] = str(profile.home)
            os.environ[self._credential_env] = self.ready["credentials"][profile.principal]
            if self._loaded != name:
                # One Hermes process per profile, as deployed: Hermes keeps a plugin manager per home, and the plugin
                # registers its hooks once per process, so the other profile's process is ended before this one starts.
                self._unload()
                load_memory_provider("psfn_lite").initialize(profile.session, hermes_home=str(profile.home), platform=profile.platform)
                self._loaded = name
            names = discover_mcp_tools()
            if f"mcp__{SERVER}__memory" not in names:
                raise RuntimeError(f"Hermes did not discover the Lite MCP tools: {names}")
            self._connected = name
        if profile.successor_pending:
            # The successor Hermes process of this profile starts: it settles, as failed, what the dead process left open.
            self._plugin_module("runtime").driver().delivery.recover(alive=lambda _pid: False)
            profile.successor_pending = False
        return profile

    def _unload(self) -> None:
        if self._loaded is None:
            return
        runtime = sys.modules.get(f"{self._namespace}.psfn_lite.runtime")
        if runtime is not None:
            runtime.reset_for_tests()
        for module in [m for m in sys.modules if m == f"{self._namespace}.psfn_lite" or m.startswith(f"{self._namespace}.psfn_lite.")]:
            del sys.modules[module]
        self._loaded = None

    def process_died(self, profile: Profile) -> None:
        """The Hermes process holding the profile died: its plugin state is gone, its ledger on disk is not."""
        self.disconnect()
        self._unload()
        profile.successor_pending = True

    def tool_names(self, name: str = "operator") -> dict:
        from tools.registry import registry

        self.use(name)
        prefix = f"mcp__{SERVER}__"
        out = []
        for entry in registry.get_all_entries():
            if entry.name.startswith(prefix):
                action = entry.schema.get("parameters", {}).get("properties", {}).get("action", {})
                out.append({"name": entry.name[len(prefix):], "actions": list(action.get("enum", []))})
        return out

    def turn(self, step_key: str, as_: str, say: str, calls: list, reply: str, variables: dict, *, abandon: bool, on_call_error=None) -> dict:
        from model_tools import handle_function_call

        profile = self.use(as_)
        turn_id = f"{profile.session}:{step_key}"
        [result] = fire("pre_llm_call", session_id=profile.session, task_id="task", turn_id=turn_id, user_message=say, conversation_history=[],
                        is_first_turn=not profile.transcript, model="m", platform=profile.platform, parent_session_id="", sender_id=profile.sender)
        context = result["context"]
        earlier = [text for _, text in profile.transcript]
        # What Hermes sends: earlier messages of the session, then this message with the plugin's context appended.
        seen = "\n\n".join([*earlier, say + "\n\n" + context])
        # Hermes sends the participant's message unlabelled ahead of the plugin's blocks; it is presented as participant
        # speech only when the plugin's context says that the text before it is the participant's own message.
        attributed = PARTICIPANT_MESSAGE_NOTE in context
        speech = [*participant_blocks(context), *((text for role, text in profile.transcript if role == "user") if attributed else ()), *([say] if attributed else [])]
        if "continuity is unavailable for this turn" in context:
            match = _REFUSED.search(context)
            if match is not None:
                return {"turnId": None, "refused": {"kind": match.group(1), **({"reason": match.group(2)} if match.group(2) else {})}, "seen": seen, "speech": speech, "results": [], "vars": {}}
            raise RuntimeError(f"Lite was unreachable for the Hermes turn: {context[-600:]}")
        entry = self._plugin_module("runtime").driver()._open.get(turn_id)  # noqa: SLF001 - the Lite turn id the plugin prepared
        lite_turn = entry["turn"] if entry else None
        profile.transcript.append(("user", say))
        if abandon:
            self.process_died(profile)
            return {"turnId": lite_turn, "refused": None, "seen": seen, "speech": speech, "results": [], "vars": {}}
        local = dict(variables)
        results = []
        for index, planned in enumerate(calls):
            resolved = resolve_templates(planned, local)
            tool = f"mcp__{SERVER}__{resolved['tool']}"
            raw = handle_function_call(tool, {"action": resolved["action"], **resolved.get("args", {})}, task_id="task", tool_call_id=f"call-{step_key}-{index}",
                                       session_id=profile.session, turn_id=turn_id)
            # handle_function_call runs Hermes's own pre_tool_call gate and post_tool_call hook, as the agent loop does.
            outcome = parse_tool_result(raw)
            results.append(outcome)
            if outcome["ok"]:
                capture_into(local, canonical(outcome["content"]), planned.get("capture"))
            elif outcome["error"]["kind"] == "transport" and on_call_error is not None:
                on_call_error()
                break
        answer = resolve_templates(reply, local)
        fire("post_llm_call", session_id=profile.session, task_id="task", turn_id=turn_id, user_message="", assistant_response=answer, conversation_history=[], model="m", platform=profile.platform)
        fire("on_session_end", session_id=profile.session, task_id="task", turn_id=turn_id, completed=True, failed=False, interrupted=False,
             turn_exit_reason="text_response", model="m", platform=profile.platform)
        profile.transcript.append(("assistant", answer))
        return {"turnId": lite_turn, "refused": None, "seen": seen, "speech": speech, "results": results, "vars": local}


# -- the runner -------------------------------------------------------------------

def unsupported(scenario: dict):
    """Why this runner cannot run the scenario on the real plugin, or None."""
    if scenario["internalTurns"] == "delegated":
        return ("delegated internal turns need a real internal-turn command (a Hermes process per claimed job, "
                "PSFN_LITE_INTERNAL_HOST=1); the TypeScript protocol driver covers the bridge and MCP side of it")
    return None


def run_scenario(scenario: dict, order: tuple, initial_state: dict, hermes: HermesSurface) -> list:
    label = f"{scenario['name']} [a={order[0]}, b={order[1]}]"
    issues = []
    box = {"host": HostProcess(initial_state)}
    hermes.attach(box["host"].ready)
    variables = dict(box["host"].ready["vars"])

    def relaunch():
        state = box["host"].kill()
        box["host"] = HostProcess({**state, "generation": state["generation"] + 1})
        hermes.attach(box["host"].ready)

    try:
        for step in scenario["steps"]:
            at = f"{label} {step['id']}"
            if step["do"] == "crash":
                relaunch()
                continue
            if step["do"] == "host":
                args = resolve_templates(step.get("args", {}), variables)
                if step["op"] == "dispatch":
                    result = box["host"].request("dispatch", args)
                else:
                    result = {"ok": True, "content": box["host"].request(step["op"], args)}
                if step["op"] in ("restart", "backup_restore"):
                    hermes.attach(box["host"].ready)
                issues.extend(check_result(step.get("expect"), result, at))
                if result["ok"]:
                    capture_into(variables, canonical(result["content"]), step.get("capture"))
                continue
            observed = run_turn(step, order, variables, box, hermes, relaunch)
            variables.update(observed.get("vars") or {})
            issues.extend(check_turn(resolve_templates(step, variables), observed, at))
            if observed["turnId"] is not None:
                variables[f"turn.{step['id']}"] = observed["turnId"]
    finally:
        hermes.disconnect()
        box["host"].close()
    return issues


_EMPTY = {"turnId": None, "refused": None, "seen": "", "speech": [], "results": []}


def run_turn(step: dict, order: tuple, variables: dict, box: dict, hermes: HermesSurface, relaunch) -> dict:
    surface = surface_of(step["on"], order)
    say = resolve_templates(step["say"], variables)
    calls = step.get("calls", [])
    reply = step.get("reply", "ok")
    key = f"{step['id']}-{surface}"
    as_ = step.get("as", "operator")
    host = box["host"]
    if step.get("crash") == "worker":
        # The worker the turn spawns is mid model call when the Lite host dies.
        before = host.event_count("worker_hang")
        with ThreadPoolExecutor(max_workers=1) as pool:
            if surface == "hermes":
                swapped = threading.Event()
                running = pool.submit(hermes.turn, key, as_, say, calls, reply, variables, abandon=False, on_call_error=lambda: swapped.wait(60))
            else:
                running = pool.submit(lambda: host.request("pi_turn", {"say": say, "calls": calls, "reply": reply, "hang": False, "vars": variables, "key": key}))
            host.wait_event("worker_hang", before)
            relaunch()
            if surface == "hermes":
                swapped.set()
            try:
                return running.result(timeout=REQUEST_TIMEOUT_SECONDS)
            except HostGone:
                return dict(_EMPTY)
    if surface == "hermes":
        return hermes.turn(key, as_, say, calls, reply, variables, abandon=bool(step.get("abandon")))
    if step.get("abandon"):
        # The Pi host dies while the companion's model call is in flight.
        before = host.event_count("companion_hang")
        pending = host.submit("pi_turn", {"say": say, "calls": calls, "reply": reply, "hang": True, "vars": variables, "key": key})
        host.wait_event("companion_hang", before)
        relaunch()
        try:
            pending.result(timeout=5)
        except Exception:  # noqa: BLE001 - the killed host never answers
            pass
        return dict(_EMPTY)
    return host.request("pi_turn", {"say": say, "calls": calls, "reply": reply, "hang": False, "vars": variables, "key": key})
