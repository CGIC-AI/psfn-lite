"""Delivers prepares and settlements to Lite, keeping every turn in the ledger until Lite has its outcome.

A prepare whose answer was lost (a timeout, a dropped connection, a bridge
failure) is retried once under the same idempotency key; Lite resumes the
key's turn if the first attempt reached it. A settlement whose turn id was
never learned prepares the kept body again first, so a turn Lite holds is
never left open and unknown. If the first prepare never reached Lite, that
second prepare records the turn late, with the message Hermes ran it on and
the outcome it actually had.

A turn row left by a Hermes process that has exited is settled as failed by
the next standing process of the profile, with the exited process's host
instance, which is the owner Lite checks.
"""

import logging
import os

from .bridge import BridgeError
from .ledger import JOB, STANDING
from .outcomes import failure

logger = logging.getLogger(__name__)


def process_alive(pid) -> bool:
    if type(pid) is not int or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True


class Delivery:
    def __init__(self, client, ledger, *, instance: str, scope: str, fail, notice):
        self.client = client
        self.ledger = ledger
        self.instance = instance
        self.scope = scope
        self._fail = fail
        self._notice = notice

    def prepare(self, body: dict) -> dict:
        try:
            return self.client.call("prepare", body)
        except BridgeError as error:
            if not error.transient:
                raise
            logger.warning("psfn_lite prepare got no answer (%s); preparing the same key again", error)
        return self.client.call("prepare", body)

    def settle(self, session_id: str, sequence: int, settle: dict, prepare: dict):
        """Delivers one turn's settlement. Returns Lite's answer, or None when it is kept or was refused (both reported)."""
        try:
            answer, settle = self._deliver(session_id, settle, prepare)
        except BridgeError as error:
            if error.transient:
                self.ledger.keep_settlement(sequence, settle=settle, prepare=prepare if settle.get("turnId") is None else None, error=str(error))
                self._fail("settle", session_id, settle.get("turnId"), str(error), record=False)
            else:
                self.ledger.resolve(sequence)
                self._fail("settle_refused", session_id, settle.get("turnId"), str(error))
            return None
        self.ledger.resolve(sequence)
        return answer

    def retry(self) -> tuple:
        """Delivers settlements kept from earlier failures. Returns (warnings for those still kept, [(session, Lite turn)] delivered)."""
        warnings, delivered = [], []
        for row in self.ledger.pending_settlements(scope=self.scope, instance=self.instance):
            kept = row["payload"]
            try:
                answer, settle = self._deliver(row["session_id"], kept["settle"], kept.get("prepare"))
            except BridgeError as error:
                if error.transient:
                    warnings.append(f"An earlier turn's outcome is still not in your continuity ({error}); it will be retried.")
                    continue
                self._fail("settle_refused", row["session_id"], kept["settle"].get("turnId"), str(error))
                answer, settle = None, kept["settle"]
            self.ledger.resolve(row["sequence"])
            if answer is not None:
                delivered.append((row["session_id"], settle["turnId"]))
        return warnings, delivered

    def recover(self, alive=process_alive) -> None:
        """Settles, as failed, the turns of standing Hermes processes of this profile that exited before their turns ended."""
        if self.scope != STANDING:
            return
        for row in self.ledger.turns():
            if row["host_instance"] == self.instance or alive(row["payload"].get("pid")):
                continue
            if row["scope"] == JOB:
                # Lite fails a delegated turn itself when its host releases it or its run times out.
                logger.warning("psfn_lite dropped the turn row of exited internal-turn process %s; Lite settles that turn", row["host_instance"])
                self.ledger.resolve(row["sequence"])
                continue
            self._notice(row["session_id"], "A turn of a Hermes process that has exited is recorded in your continuity as failed: the process ended before the turn did.")
            settle = {
                "hostInstance": row["host_instance"],
                "turnId": row["turn_id"],
                "outcome": failure("hermes_process_ended", "the Hermes process running the turn exited before the turn ended"),
                "toolCallCount": 0,
            }
            self.settle(row["session_id"], row["sequence"], settle, row["payload"].get("prepare"))

    def _deliver(self, session_id: str, settle: dict, prepare):
        if settle.get("turnId") is None:
            if not isinstance(prepare, dict):
                raise BridgeError("the turn's prepare was not kept, so its Lite turn cannot be found", kind="protocol")
            try:
                prepared = self.prepare(prepare)
            except BridgeError as error:
                if error.reason == "turn_already_open":
                    # Another turn of the same Lite conversation is running; this one is delivered after it.
                    raise BridgeError(f"{error}; delivered once that turn ends", kind="unavailable") from None
                raise
            if prepared.get("kind") == "replayed":
                self._notice(session_id, f"Lite had already recorded a turn as {prepared.get('status')} before Hermes's outcome for it arrived; Lite keeps its record.")
                return None, settle
            if prepared.get("kind") != "prepared" or not isinstance(prepared.get("turnId"), str):
                raise BridgeError("Lite answered prepare with an unexpected shape", kind="protocol")
            settle = {**settle, "turnId": prepared["turnId"]}
        answer = self.client.call("settle", settle)
        post = answer.get("postTurn") if isinstance(answer.get("postTurn"), dict) else {}
        for part, value in post.items():
            if isinstance(value, dict) and value.get("ok") is False:
                self._fail(f"post_turn_{part}", session_id, settle["turnId"], f"Lite's post-turn {part} work failed")
        return answer, settle
