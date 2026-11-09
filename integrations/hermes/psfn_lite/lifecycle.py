"""Drives the Lite turn lifecycle from Hermes plugin hooks.

Every root Hermes turn (not a subagent, not the background review fork, not
a cron or flush agent) of a bound sender becomes one host-driven turn of
the donor companion core:

- ``pre_llm_call`` prepares it under a stable idempotency key, in the Lite
  session of the Hermes conversation (the root of its compression lineage),
  and injects the context the donor assembled into the user message;
- the companion's tools, called over the Lite MCP server inside the turn,
  run in the donor's own tool loop;
- ``post_llm_call`` collects the reply;
- ``on_session_end`` settles it as completed, interrupted or failed.

Open turns are keyed by Hermes's turn id, which Hermes mints once per turn,
so a compression that rotates the session id mid-turn does not lose the
turn. Several Hermes failure paths return without ``on_session_end``; a turn
left open that way is settled as failed (``hermes_turn_unfinished``) before
the next turn of the same conversation is prepared, or when Hermes finalizes
the session. ``pre_tool_call`` blocks Lite's governed tools outside an open
Lite turn, because Hermes's MCP client sends the profile's standing
credential whoever the turn is for. Before Hermes compacts, ``checkpoint``
proves every Lite turn of the session is in Lite's canonical history.

Nothing fails silently. A lifecycle event Lite did not accept is logged,
kept in the local ledger (a turn and, once it ends, its outcome, so it is
retried before the next turn), reported through the provider's warning
callback, and named in the next turn's context.
"""

import hashlib
import logging
import os
import secrets
import threading

from .bridge import BridgeClient, BridgeError
from .config import NON_INTERACTIVE_PLATFORMS, Config
from .delivery import Delivery
from .ledger import Ledger
from .outcomes import outcome, unfinished
from .render import block, render_context

logger = logging.getLogger(__name__)

_SWEPT_KEPT = 256
_NOTE = "system note: psfn_lite"
TOOL_BLOCKED = (
    "PSFN Lite tools work only inside a turn recorded in the companion's Lite continuity: not in a subagent, "
    "the background review, a cron or flush run, a conversation not bound to Lite, or a turn Lite refused."
)


def idempotency_key(session_id: str, turn_id: str) -> str:
    """A key in Lite's id alphabet, stable for one Hermes turn and distinct across turns and sessions."""
    digest = hashlib.sha256(f"{session_id}\n{turn_id}".encode("utf-8")).hexdigest()[:40]
    return f"hermes:{digest}"


def host_instance() -> str:
    return f"hermes-{os.getpid()}-{secrets.token_hex(4)}"


class Driver:
    def __init__(self, config: Config, ledger: Ledger, client: BridgeClient, *, instance: str, notify):
        self.config = config
        self.ledger = ledger
        self.client = client
        self.instance = instance
        self._notify = notify
        self._lock = threading.RLock()
        #: Hermes session id -> Lite turn ids prepared in it (inherited across a compression's session rotation).
        self._turns = {}
        #: Hermes turn id -> the open Lite turn ({turn, session, reply, prepare, row}).
        self._open = {}
        #: Hermes session id -> the session it continues after a compression.
        self._parents = {}
        #: Hermes turn ids settled as unfinished, so a late on_session_end is reported, not ignored.
        self._swept = {}
        self._subagents = set()
        #: Warnings to show in the next turn's context, per Hermes session.
        self._carry = {}
        self.delivery = Delivery(client, ledger, instance=instance, fail=self._fail, notice=self._notice)

    # -- hooks ---------------------------------------------------------------

    def subagent_start(self, child_session_id=None, **_):
        if isinstance(child_session_id, str) and child_session_id:
            with self._lock:
                self._subagents.add(child_session_id)

    def session_switch(self, new_session_id: str, parent_session_id: str) -> None:
        """A compression rotated the session id; the provider forwards only that reason of Hermes's notification."""
        if new_session_id and parent_session_id and new_session_id != parent_session_id:
            with self._lock:
                self._link(new_session_id, parent_session_id)

    def pre_llm_call(self, session_id="", turn_id="", user_message="", parent_session_id="", platform="", sender_id="", **_):
        # Subagents, the review fork and cron or flush agents never drive Lite.
        if not self._root(session_id, parent_session_id, platform):
            return None
        # Sessions are linked only by a compression (on_session_switch) or a turn seen under a rotated id;
        # Hermes gives a root agent no parent session id, and a branch is another conversation.
        if not self.config.binds(platform or "", sender_id or ""):
            # Logged and reported, not carried: an unbound conversation never gets Lite context to show it in.
            logger.error("psfn_lite unbound_sender for session %s: platform %r sender is not bound to PSFN Lite", session_id, platform)
            self._notify(f"PSFN Lite ignored a turn from platform {platform!r}: its sender is not bound to PSFN Lite")
            return {"context": block(_NOTE, "This conversation is not bound to the companion's PSFN Lite continuity: nothing from it is recorded there, no continuity context is shown, and the PSFN Lite tools are blocked in it.")}
        if not isinstance(turn_id, str) or not turn_id or not isinstance(session_id, str) or not session_id:
            self._fail("prepare", session_id or "", None, "Hermes gave the turn no session or turn id")
            return {"context": block(_NOTE, "This turn could not be recorded in your PSFN Lite continuity (Hermes gave it no turn identity).")}
        warnings = self._sweep(session_id, keep=turn_id, why="Hermes started the next turn of the conversation")
        warnings += self.retry_settlements()
        with self._lock:
            carried = [w for s in sorted(self._related(session_id)) for w in self._carry.pop(s, [])]
        warnings = carried + warnings
        body = {
            "hostInstance": self.instance,
            "idempotencyKey": idempotency_key(session_id, turn_id),
            "sessionId": self._lite_session(session_id),
            "message": user_message,
        }
        entry = self._begin(session_id, turn_id, body)
        try:
            prepared = self.delivery.prepare(body)
        except BridgeError as error:
            if error.transient:
                # Lite may hold the turn; its row keeps the key, and settling it prepares the key again.
                self._fail("prepare", session_id, None, str(error), record=False)
            else:
                self._drop(turn_id)
                self._fail("prepare_refused", session_id, None, str(error))
            return {"context": "\n\n".join([*(block(_NOTE, w) for w in warnings), block(
                _NOTE,
                f"Your PSFN Lite continuity is unavailable for this turn ({error}). You have no fresh continuity context; say so if it matters.",
            )])}
        if prepared.get("kind") == "replayed":
            self._drop(turn_id)
            return {"context": block(_NOTE, "Lite already recorded this turn; it is not recorded again.")}
        if prepared.get("kind") == "answered":
            # The donor ended the turn before asking for a model answer; it is recorded with the donor's own reply.
            self._drop(turn_id)
            with self._lock:
                if isinstance(prepared.get("turnId"), str):
                    self._remember(session_id, prepared["turnId"])
            return {"context": block(_NOTE, "Your PSFN Lite continuity ended this turn itself and recorded it; nothing you reply now is recorded there.")}
        lite_turn = prepared.get("turnId")
        if prepared.get("kind") != "prepared" or not isinstance(lite_turn, str) or not isinstance(prepared.get("context"), dict):
            self._fail("prepare", session_id, None, "Lite answered prepare with an unexpected shape", record=False)
            return {"context": block(_NOTE, "Your PSFN Lite continuity answered unexpectedly; you have no fresh continuity context for this turn.")}
        with self._lock:
            entry["turn"] = lite_turn
            self._remember(session_id, lite_turn)
        self.ledger.bind_turn(entry["row"], lite_turn)
        text = render_context(prepared["context"], warnings=warnings, limit=self.config.max_context_chars)
        return {"context": text}

    def pre_tool_call(self, tool_name="", session_id="", turn_id="", **_):
        """Lite's governed tools run only inside an open Lite turn; Hermes sends the standing credential for every caller."""
        if not isinstance(tool_name, str) or not tool_name.startswith(self.config.tool_prefix):
            return None
        entry = self._entry(turn_id, session_id)
        if entry is not None:
            return None
        logger.warning("psfn_lite blocked %s outside a Lite turn (session %s, turn %s)", tool_name, session_id, turn_id)
        return {"action": "block", "message": TOOL_BLOCKED}

    def post_llm_call(self, session_id="", turn_id="", assistant_response=None, **_):
        entry = self._entry(turn_id, session_id)
        if entry is not None and isinstance(assistant_response, str) and assistant_response.strip():
            with self._lock:
                entry["reply"] = assistant_response

    def on_session_end(self, session_id="", turn_id="", completed=False, failed=False, interrupted=False, turn_exit_reason="", **_):
        entry = self._entry(turn_id, session_id)
        with self._lock:
            if entry is not None:
                self._open.pop(turn_id, None)
            swept = turn_id in self._swept
        if entry is None:
            if swept:
                kind = "interrupted" if interrupted else ("completed" if completed and not failed else "failed")
                self._notice(session_id, f"Hermes reported a turn as {kind} after it was recorded in your continuity as unfinished; Lite keeps the failure.")
            return
        self._finish(entry, outcome(entry["reply"], completed=completed, failed=failed, interrupted=interrupted, reason=turn_exit_reason))

    def on_session_finalize(self, session_id="", **_):
        """Hermes closed the session (exit, /new, expiry): a turn still open in it never reported its end."""
        if isinstance(session_id, str) and session_id:
            self._sweep(session_id, keep=None, why="Hermes closed the session")

    # -- compaction ----------------------------------------------------------

    def checkpoint(self, session_id: str) -> None:
        """Raises unless every Lite turn this Hermes session holds is in Lite's canonical history."""
        self.retry_settlements()
        with self._lock:
            lineage = self._related(session_id)
            turns = list(self._turns.get(session_id, []))
        kept = [r for r in self.ledger.pending_settlements() if r["session_id"] in lineage]
        if kept:
            raise BridgeError(f"{len(kept)} turn outcomes of this session are not yet in Lite; compaction would lose them", kind="undelivered")
        unknown = [r for r in self.ledger.turns() if r["host_instance"] == self.instance and r["turn_id"] is None and r["session_id"] in lineage]
        if unknown:
            raise BridgeError(f"{len(unknown)} turns of this session are not yet known to Lite; compaction would lose them", kind="undelivered")
        if not turns:
            return
        result = self.client.call("checkpoint", {"sessionId": self._lite_session(session_id), "turnIds": turns})
        proven = set(result.get("settled", [])) | set(result.get("open", []))
        if not set(turns) <= proven:
            raise BridgeError("Lite did not prove every turn of this session", kind="protocol")

    # -- delivery ------------------------------------------------------------

    def retry_settlements(self) -> list:
        """Delivers settlements kept from earlier failures; returns warnings for those still undelivered."""
        warnings, delivered = self.delivery.retry()
        with self._lock:
            for session_id, lite_turn in delivered:
                self._remember(session_id, lite_turn)
        return warnings

    def _begin(self, session_id: str, turn_id: str, body: dict) -> dict:
        with self._lock:
            entry = self._open.get(turn_id)
        if entry is not None:
            return entry  # Hermes prepared the same turn again; Lite resumes its key
        row = self.ledger.open_turn(session_id=session_id, host_instance=self.instance, pid=os.getpid(), hermes_turn=turn_id, prepare=body)
        entry = {"turn": None, "session": session_id, "reply": None, "prepare": body, "row": row}
        with self._lock:
            self._open[turn_id] = entry
        return entry

    def _drop(self, turn_id: str) -> None:
        with self._lock:
            entry = self._open.pop(turn_id, None)
        if entry is not None:
            self.ledger.resolve(entry["row"])

    def _finish(self, entry: dict, result: dict) -> None:
        settle = {"hostInstance": self.instance, "turnId": entry["turn"], "outcome": result}
        answer = self.delivery.settle(entry["session"], entry["row"], settle, entry["prepare"])
        if answer is not None and entry["turn"] is None and isinstance(answer.get("turnId"), str):
            with self._lock:
                self._remember(entry["session"], answer["turnId"])

    def _sweep(self, session_id: str, *, keep, why: str) -> list:
        """Settles as failed the open turns of this conversation Hermes never reported the end of; returns warnings."""
        with self._lock:
            lineage = self._related(session_id)
            stale = [(t, e) for t, e in self._open.items() if t != keep and e["session"] in lineage]
            for hermes_turn, _ in stale:
                del self._open[hermes_turn]
                self._swept[hermes_turn] = True
            while len(self._swept) > _SWEPT_KEPT:
                del self._swept[next(iter(self._swept))]
        warnings = []
        for _, entry in stale:
            message = f"An earlier turn is recorded in your continuity as failed: Hermes did not report how it ended ({why})."
            logger.error("psfn_lite settles an unfinished turn of session %s as failed: %s", entry["session"], why)
            self._notify(message)
            warnings.append(message)
            self._finish(entry, unfinished(why))
        return warnings

    def _entry(self, turn_id, session_id):
        """The open turn for a Hermes turn id, following the turn when a compression rotated its session id."""
        with self._lock:
            entry = self._open.get(turn_id) if isinstance(turn_id, str) else None
            if entry is not None and isinstance(session_id, str) and session_id and session_id != entry["session"]:
                self._link(session_id, entry["session"])
                entry["session"] = session_id
            return entry

    def _link(self, child: str, parent: str) -> None:
        self._parents[child] = parent
        if parent in self._turns and child not in self._turns:
            self._turns[child] = list(self._turns[parent])

    def _lite_session(self, session_id: str) -> str:
        """The Lite session of a Hermes conversation: the session its compressions rotated from first, so it stays one donor session."""
        with self._lock:
            seen = {session_id}
            while session_id in self._parents and self._parents[session_id] not in seen:
                session_id = self._parents[session_id]
                seen.add(session_id)
            return session_id

    def _remember(self, session_id: str, lite_turn: str) -> None:
        turns = self._turns.setdefault(session_id, [])
        if lite_turn not in turns:
            turns.append(lite_turn)

    def _related(self, session_id: str) -> set:
        """The session and every session a compression rotated it from or into."""
        neighbours = {}
        for child, parent in self._parents.items():
            neighbours.setdefault(child, set()).add(parent)
            neighbours.setdefault(parent, set()).add(child)
        seen, frontier = {session_id}, [session_id]
        while frontier:
            for other in neighbours.get(frontier.pop(), ()):
                if other not in seen:
                    seen.add(other)
                    frontier.append(other)
        return seen

    def _root(self, session_id, parent_session_id, platform="") -> bool:
        if parent_session_id and parent_session_id == session_id:
            return False  # the background review fork shares its parent's session
        if platform in NON_INTERACTIVE_PLATFORMS:
            return False  # delegate children run as platform "subagent"; cron and flush agents speak for no participant
        with self._lock:
            return session_id not in self._subagents

    def _fail(self, kind: str, session_id: str, turn_id, message: str, *, record=True) -> None:
        logger.error("psfn_lite %s failed for session %s: %s", kind, session_id, message)
        if record:
            self.ledger.record(kind, session_id, turn_id, message)
        self._carry_warning(session_id, f"PSFN Lite {kind.replace('_', ' ')} did not reach Lite: {message}")

    def _notice(self, session_id: str, message: str) -> None:
        logger.error("psfn_lite: %s (session %s)", message, session_id)
        self._carry_warning(session_id, message)

    def _carry_warning(self, session_id: str, warning: str) -> None:
        with self._lock:
            self._carry.setdefault(session_id, []).append(warning)
        self._notify(warning)
