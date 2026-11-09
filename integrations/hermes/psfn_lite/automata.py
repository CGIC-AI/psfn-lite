"""Runs the companion's automata as Hermes subagents (operator automata rule 4).

Lite's core derives each automaton's task and Automata Bus scope from the
spawn that started it and queues its attempts. When the profile enables
hosted automata, this module, at the start of every bound root turn:

- claims the waiting attempts over the lifecycle bridge with the profile's
  standing credential, declaring the per-attempt iteration budget Hermes
  gives every child it launches (``tools.delegate_tool.DEFAULT_MAX_ITERATIONS``:
  ``SubagentLifecycleService.launch`` passes exactly that, and the public
  API has no per-launch budget); core refuses a budget above its policy;
- launches each attempt through the public ``ctx.subagent_lifecycle``, one
  fresh child per attempt, so every attempt starts with the full budget;
- binds the child's session (named by Hermes's ``subagent_start`` hook,
  which fires inside ``launch``) to the attempt's own credential, so the
  child's ``automata_bus`` calls reach core as that attempt and nothing else;
- watches the child on its own thread, renewing the attempt's lease while it
  runs, stopping it when core asks, and reporting how it ended. A child
  Hermes no longer has (an unknown handle, an interrupted child, a process
  that exited and so stopped renewing the lease) ends the attempt as lost;
  core then queues the next attempt until its attempt cap.

The child persists only through the Automata Bus: its ``automata_bus`` tool
forwards each call to core's governed tool, which writes it under a stable
write key, so a write a retried attempt repeats is the same Bus event.
Attempt credentials live in memory only and are never logged.
"""

import contextvars
import json
import logging
import threading
from pathlib import Path

from .bridge import BridgeError

logger = logging.getLogger(__name__)

TOOL_NAME = "automata_bus"
TOOLSET = "psfn_lite"
TOOL_SCHEMA = json.loads((Path(__file__).with_name("automata_bus_tool.json")).read_text())
OUTSIDE_ATTEMPT = "automata_bus works only inside a PSFN Lite automaton run as a Hermes subagent."


def declared_max_iterations() -> int:
    """The iteration budget Hermes gives every lifecycle child; fails closed when the pinned contract moved."""
    from tools import delegate_tool

    value = getattr(delegate_tool, "DEFAULT_MAX_ITERATIONS", None)
    if type(value) is not int or value < 1:
        raise RuntimeError("Hermes no longer exposes tools.delegate_tool.DEFAULT_MAX_ITERATIONS; hosted automata cannot declare their budget")
    return value


def lifecycle_service():
    """Hermes's public subagent lifecycle service for this plugin.

    A memory provider's registration context forwards only ``register_*``
    calls, so the service comes from a PluginContext for this plugin, built
    as Hermes builds one for a memory provider (plugins/memory/__init__.py).
    """
    from hermes_cli.plugins import PluginContext, PluginManifest, get_plugin_manager

    return PluginContext(PluginManifest(name="psfn_lite", key="psfn_lite"), get_plugin_manager()).subagent_lifecycle


class Attempt:
    def __init__(self, claim: dict):
        self.attempt_id = claim["attemptId"]
        self.number = claim["attempt"]
        self.credential = claim["credential"]
        self.lease_seconds = claim["leaseMs"] / 1000.0
        self.goal = claim["goal"]
        self.context = claim["context"]
        self.child_session = None
        self.child_subagent = None
        self.cancel_sent = False


class AutomataHost:
    def __init__(self, client, *, instance: str, claim_limit: int, notify, service=None, budget=declared_max_iterations):
        self._client = client
        self._instance = instance
        self._limit = claim_limit
        self._notify = notify
        self._service = service
        self._budget = budget
        self._lock = threading.RLock()
        #: child session id -> its attempt, while the attempt is live.
        self._by_session = {}
        self._launching = threading.local()
        self.watchers = []

    # -- the parent's turn ---------------------------------------------------

    def claim_and_launch(self) -> list:
        """Claims the waiting attempts and launches each as a Hermes child; returns warnings for the turn."""
        try:
            budget = self._budget()
        except RuntimeError as error:
            logger.error("psfn_lite hosted automata: %s", error)
            return [f"PSFN Lite automata are not run by this Hermes: {error}"]
        try:
            answer = self._client.call("automata/claim", {"hostInstance": self._instance, "maxIterations": budget, "limit": self._limit})
        except BridgeError as error:
            logger.error("psfn_lite could not claim automata: %s", error)
            return [f"PSFN Lite automata could not be claimed: {error}"]
        claims = answer.get("attempts")
        if not isinstance(claims, list):
            return ["PSFN Lite answered the automata claim with an unexpected shape."]
        warnings = []
        for claim in claims:
            warning = self._launch(Attempt(claim))
            if warning:
                warnings.append(warning)
        return warnings

    def _launch(self, attempt: Attempt):
        from agent.subagent_lifecycle import SubagentLaunchRequest

        service = self._service or lifecycle_service()
        request = SubagentLaunchRequest(goal=attempt.goal, context=attempt.context, role="leaf", correlation_id=attempt.attempt_id)
        self._launching.attempt = attempt
        try:
            handle = service.launch(request)
        except Exception as error:  # Hermes refused the child: the attempt ends now rather than at its lease
            logger.error("psfn_lite could not launch automaton attempt %s: %s", attempt.attempt_id, type(error).__name__)
            self._report(attempt, {"kind": "failed", "code": "launch_refused"})
            return f"A PSFN Lite automaton could not start as a Hermes subagent ({type(error).__name__})."
        finally:
            self._launching.attempt = None
        if attempt.child_session is None or attempt.child_subagent != handle.subagent_id:
            # Without its session the child's Bus calls cannot be told apart from anyone's: stop it.
            service.cancel(handle, reason="psfn_lite could not bind the child to its attempt")
            self._report(attempt, {"kind": "failed", "code": "child_unbound"})
            return "A PSFN Lite automaton was stopped: Hermes did not name its subagent session."
        # The waiter runs in this turn's context, where Hermes bound the parent the handle belongs to.
        watcher = threading.Thread(target=contextvars.copy_context().run, args=(self._watch, service, attempt, handle), name=f"psfn-lite-{attempt.attempt_id}", daemon=True)
        with self._lock:
            self.watchers.append(watcher)
        watcher.start()
        return None

    def subagent_start(self, child_session_id=None, child_subagent_id=None, **_) -> None:
        """Hermes names the child it is building inside ``launch``: bind it to the attempt being launched."""
        attempt = getattr(self._launching, "attempt", None)
        if attempt is None or not isinstance(child_session_id, str) or not child_session_id:
            return
        attempt.child_session = child_session_id
        attempt.child_subagent = child_subagent_id
        with self._lock:
            self._by_session[child_session_id] = attempt

    # -- the child's run -----------------------------------------------------

    def _watch(self, service, attempt: Attempt, handle) -> None:
        interval = max(attempt.lease_seconds / 3.0, 0.05)
        try:
            while True:
                terminal = service.wait(handle, timeout_seconds=interval)
                if not terminal.timed_out:
                    break  # the child reached a terminal state, or Hermes no longer knows it (UNKNOWN)
                try:
                    status = self._client.call("automata/heartbeat", {"hostInstance": self._instance, "attemptCredential": attempt.credential})
                except BridgeError as error:
                    if error.kind in ("attempt_ended", "unknown_attempt"):
                        # Core ended the attempt (its lease ran out): the child's work no longer counts.
                        service.cancel(handle, reason="PSFN Lite ended this attempt")
                        return
                    logger.warning("psfn_lite heartbeat for attempt %s failed: %s", attempt.attempt_id, error)
                    continue
                if status.get("status") == "cancel_requested" and not attempt.cancel_sent:
                    attempt.cancel_sent = True
                    service.cancel(handle, reason="PSFN Lite asked the automaton to stop")
            self._report(attempt, report_of(service.result(handle), terminal.state.value))
        finally:
            with self._lock:
                if attempt.child_session is not None:
                    self._by_session.pop(attempt.child_session, None)

    def _report(self, attempt: Attempt, outcome: dict) -> None:
        try:
            self._client.call("automata/report", {"hostInstance": self._instance, "attemptCredential": attempt.credential, "outcome": outcome})
        except BridgeError as error:
            # Unreported, the attempt ends when its lease runs out, as a lost child.
            logger.error("psfn_lite could not report attempt %s: %s", attempt.attempt_id, error)
            self._notify(f"PSFN Lite did not receive how an automaton attempt ended ({error}); it ends when its lease runs out.")

    # -- the child's tool ----------------------------------------------------

    def bus_tool(self, args, session_id=None, **_) -> str:
        """The child's ``automata_bus``: forwarded to core's governed tool as the attempt the child runs."""
        with self._lock:
            attempt = self._by_session.get(session_id) if isinstance(session_id, str) else None
        if attempt is None:
            return json.dumps({"error": OUTSIDE_ATTEMPT})
        if not isinstance(args, dict):
            return json.dumps({"error": "automata_bus arguments must be an object"})
        try:
            answer = self._client.call("automata/bus", {"hostInstance": self._instance, "attemptCredential": attempt.credential, "arguments": args})
        except BridgeError as error:
            return json.dumps({"error": f"automata_bus did not reach PSFN Lite: {error}"})
        text = answer.get("text")
        return text if isinstance(text, str) else json.dumps({"error": "PSFN Lite answered automata_bus with an unexpected shape"})


def report_of(result, state: str) -> dict:
    """How the child ended, as core's attempt report."""
    if state == "SUCCEEDED":
        summary = result.summary if isinstance(result.summary, str) and result.summary.strip() else None
        if summary is None:
            return {"kind": "failed", "code": "child_no_summary"}
        calls = result.usage_metadata.get("api_calls", 0) if isinstance(result.usage_metadata, dict) else 0
        return {
            "kind": "succeeded",
            "summary": summary,
            "model": result.handle.model if isinstance(result.handle.model, str) and result.handle.model else None,
            "apiCalls": calls if type(calls) is int and calls >= 0 else 0,
        }
    if state == "CANCELLED":
        return {"kind": "cancelled"}
    if state == "FAILED":
        return {"kind": "failed", "code": "child_failed"}
    # INTERRUPTED or UNKNOWN: Hermes no longer has the child's run.
    return {"kind": "lost", "code": "child_interrupted" if state == "INTERRUPTED" else "child_unknown"}
