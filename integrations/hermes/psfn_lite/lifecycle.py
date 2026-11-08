"""Drives the Lite turn lifecycle from Hermes plugin hooks.

Every root Hermes turn (not a subagent, not the background review fork) of
a bound sender becomes one Lite turn: ``pre_llm_call`` prepares it under a
stable idempotency key and injects Lite's labelled context into the user
message; ``post_llm_call`` and ``post_tool_call`` collect the reply and the
governed tool calls; ``on_session_end`` settles it as completed, interrupted
or failed. Before Hermes compacts, ``checkpoint`` proves every Lite turn of
the session is in Lite's canonical history.

Nothing fails silently. A lifecycle event Lite did not accept is logged,
kept in the local ledger (a settlement with its outcome, so it is retried
before the next turn), reported through the provider's warning callback,
and named in the next turn's context.
"""

import hashlib
import logging
import os
import re
import secrets
import threading

from .bridge import BridgeClient, BridgeError
from .config import Config
from .ledger import Ledger
from .render import block, render_context

logger = logging.getLogger(__name__)

#: Set in the environment of a Hermes process the plugin starts to run one delegated internal turn.
INTERNAL_JOB_ENV = "PSFN_LITE_INTERNAL_JOB"
_REASON = re.compile(r"[^a-z0-9_ .:-]")


def idempotency_key(session_id: str, turn_id: str) -> str:
    """A key in Lite's id alphabet, stable for one Hermes turn and distinct across turns and sessions."""
    digest = hashlib.sha256(f"{session_id}\n{turn_id}".encode("utf-8")).hexdigest()[:40]
    return f"hermes:{digest}"


def host_instance() -> str:
    return f"hermes-{os.getpid()}-{secrets.token_hex(4)}"


class Driver:
    def __init__(self, config: Config, ledger: Ledger, client: BridgeClient, *, instance: str, internal_job: bool, notify):
        self.config = config
        self.ledger = ledger
        self.client = client
        self.instance = instance
        self.internal_job = internal_job
        self._notify = notify
        self._lock = threading.RLock()
        #: Hermes session id -> Lite turn ids prepared in it (inherited across a compression's session rotation).
        self._turns = {}
        #: (Hermes session id, Hermes turn id) -> the open Lite turn.
        self._open = {}
        self._subagents = set()
        #: Warnings to show in the next turn's context, per Hermes session.
        self._carry = {}

    # -- hooks ---------------------------------------------------------------

    def subagent_start(self, child_session_id=None, **_):
        if isinstance(child_session_id, str) and child_session_id:
            with self._lock:
                self._subagents.add(child_session_id)

    def pre_llm_call(self, session_id="", turn_id="", user_message="", parent_session_id="", platform="", sender_id="", **_):
        if not self._root(session_id, parent_session_id):
            return None
        with self._lock:
            if parent_session_id and parent_session_id in self._turns and session_id not in self._turns:
                # Compression rotated the session id; its Lite turns are this session's history too.
                self._turns[session_id] = list(self._turns[parent_session_id])
            warnings = self._carry.pop(session_id, [])
        if not self.internal_job and not self.config.binds(platform or "", sender_id or ""):
            self._fail("unbound_sender", session_id, None, f"platform {platform!r} sender is not bound to PSFN Lite", record=False)
            return {"context": block("system note: psfn_lite", "This conversation is not bound to the companion's PSFN Lite continuity: nothing from it is recorded there, and no continuity context is shown.")}
        warnings = warnings + self.retry_settlements()
        if not isinstance(turn_id, str) or not turn_id or not isinstance(session_id, str) or not session_id:
            self._fail("prepare", session_id or "", None, "Hermes gave the turn no session or turn id")
            return {"context": block("system note: psfn_lite", "This turn could not be recorded in your PSFN Lite continuity (Hermes gave it no turn identity).")}
        body = {
            "hostInstance": self.instance,
            "idempotencyKey": idempotency_key(session_id, turn_id),
            "message": None if self.internal_job else user_message,
        }
        try:
            prepared = self.client.call("prepare", body)
        except BridgeError as error:
            self._fail("prepare", session_id, None, str(error))
            return {"context": "\n\n".join([*(block("system note: psfn_lite", w) for w in warnings), block(
                "system note: psfn_lite",
                f"Your PSFN Lite continuity is unavailable for this turn ({error}). This turn is not recorded there and you have no fresh continuity context; say so if it matters.",
            )])}
        if prepared.get("kind") == "replayed":
            return {"context": block("system note: psfn_lite", f"Lite already recorded this turn as {prepared.get('status')}; it is not recorded again.")}
        lite_turn = prepared.get("turnId")
        if prepared.get("kind") != "prepared" or not isinstance(lite_turn, str) or not isinstance(prepared.get("context"), dict):
            self._fail("prepare", session_id, None, "Lite answered prepare with an unexpected shape")
            return {"context": block("system note: psfn_lite", "Your PSFN Lite continuity answered unexpectedly; this turn is not recorded there.")}
        with self._lock:
            known = set(self._turns.get(session_id, []))
            self._turns.setdefault(session_id, [])
            if lite_turn not in self._turns[session_id]:
                self._turns[session_id].append(lite_turn)
            self._open[(session_id, turn_id)] = {"turn": lite_turn, "reply": None, "tools": 0}
        text = render_context(prepared["context"], known_turns=known, internal=prepared.get("internal"), warnings=warnings, limit=self.config.max_context_chars)
        return {"context": text}

    def post_llm_call(self, session_id="", turn_id="", assistant_response=None, **_):
        with self._lock:
            entry = self._open.get((session_id, turn_id))
            if entry is not None and isinstance(assistant_response, str) and assistant_response.strip():
                entry["reply"] = assistant_response

    def post_tool_call(self, session_id="", turn_id="", tool_name="", **_):
        if not isinstance(tool_name, str) or not tool_name.startswith(self.config.tool_prefix):
            return
        with self._lock:
            entry = self._open.get((session_id, turn_id))
            if entry is not None:
                entry["tools"] += 1

    def on_session_end(self, session_id="", turn_id="", completed=False, failed=False, interrupted=False, turn_exit_reason="", **_):
        with self._lock:
            entry = self._open.pop((session_id, turn_id), None)
        if entry is None:
            return
        payload = {
            "hostInstance": self.instance,
            "turnId": entry["turn"],
            "outcome": outcome(entry["reply"], completed=completed, failed=failed, interrupted=interrupted, reason=turn_exit_reason),
            "toolCallCount": min(entry["tools"], 10_000),
        }
        self._settle(session_id, payload)

    # -- compaction ----------------------------------------------------------

    def checkpoint(self, session_id: str) -> None:
        """Raises unless every Lite turn this Hermes session holds is in Lite's canonical history."""
        self.retry_settlements()
        pending = [p for p in self.ledger.pending_settlements() if p["session_id"] == session_id]
        if pending:
            raise BridgeError(f"{len(pending)} turn outcomes of this session are not yet in Lite; compaction would lose them", kind="undelivered")
        with self._lock:
            turns = list(self._turns.get(session_id, []))
        if not turns:
            return
        result = self.client.call("checkpoint", {"turnIds": turns})
        proven = set(result.get("settled", [])) | set(result.get("open", []))
        if not set(turns) <= proven:
            raise BridgeError("Lite did not prove every turn of this session", kind="protocol")

    # -- delivery ------------------------------------------------------------

    def retry_settlements(self) -> list:
        """Delivers settlements kept from earlier failures; returns warnings for those still undelivered."""
        warnings = []
        for item in self.ledger.pending_settlements():
            try:
                self.client.call("settle", item["payload"])
            except BridgeError as error:
                if error.transient:
                    warnings.append(f"An earlier turn's outcome is still not in your continuity ({error}); it will be retried.")
                    continue
                self._fail("settle_refused", item["session_id"], item["turn_id"], str(error))
            self.ledger.resolve(item["sequence"])
        return warnings

    def _settle(self, session_id: str, payload: dict) -> None:
        try:
            result = self.client.call("settle", payload)
        except BridgeError as error:
            if error.transient:
                self._fail("settle", session_id, payload["turnId"], str(error), payload=payload)
            else:
                self._fail("settle_refused", session_id, payload["turnId"], str(error))
            return
        post = result.get("postTurn") if isinstance(result.get("postTurn"), dict) else {}
        for part, value in post.items():
            if isinstance(value, dict) and value.get("ok") is False:
                self._fail(f"post_turn_{part}", session_id, payload["turnId"], f"Lite's post-turn {part} work failed", record=True)

    def _root(self, session_id, parent_session_id) -> bool:
        if parent_session_id and parent_session_id == session_id:
            return False  # the background review fork shares its parent's session
        with self._lock:
            return session_id not in self._subagents

    def _fail(self, kind: str, session_id: str, turn_id, message: str, *, payload=None, record=True) -> None:
        logger.error("psfn_lite %s failed for session %s: %s", kind, session_id, message)
        if record:
            self.ledger.record(kind, session_id, turn_id, message, payload)
        warning = f"PSFN Lite {kind.replace('_', ' ')} did not reach Lite: {message}"
        with self._lock:
            self._carry.setdefault(session_id, []).append(warning)
        self._notify(warning)


def outcome(reply, *, completed, failed, interrupted, reason) -> dict:
    """The Lite outcome for how Hermes ended the turn; Hermes reports no partial reply, and delivery happens after the hook."""
    shown = _REASON.sub("", str(reason or "").lower())[:200] or "unspecified"
    if interrupted:
        by = "shutdown" if "shutdown" in shown else "participant"
        return {"kind": "interrupted", "by": by, "partialReply": None, "delivery": "unknown"}
    if failed or not completed:
        return {"kind": "failed", "error": {"code": "hermes_turn_failed", "message": f"Hermes ended the turn: {shown}"}, "partialReply": None, "delivery": "unknown"}
    if reply is None:
        return {"kind": "failed", "error": {"code": "hermes_no_reply", "message": f"Hermes completed the turn without a reply: {shown}"}, "partialReply": None, "delivery": "unknown"}
    return {"kind": "completed", "reply": reply, "delivery": "unknown"}
