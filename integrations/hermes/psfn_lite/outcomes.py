"""Lite turn outcomes for the ways a Hermes turn ends.

The bridge's settle takes exactly three outcomes: ``completed`` with the
reply, ``interrupted``, and ``failed`` with a code (the donor records the
code; the message goes to the operator log only). Hermes reports no partial
reply for an interrupted or failed turn, and the donor records none.
"""

import re

_REASON = re.compile(r"[^a-z0-9_ .:-]")


def outcome(reply, *, completed, failed, interrupted, reason) -> dict:
    """The Lite outcome for how Hermes said the turn ended (``on_session_end``)."""
    shown = _REASON.sub("", str(reason or "").lower())[:200] or "unspecified"
    if interrupted:
        return {"kind": "interrupted"}
    if failed or not completed:
        return failure("hermes_turn_failed", f"Hermes ended the turn: {shown}")
    if reply is None:
        return failure("hermes_no_reply", f"Hermes completed the turn without a reply: {shown}")
    return {"kind": "completed", "reply": reply}


def failure(code: str, message: str) -> dict:
    return {"kind": "failed", "error": {"code": code, "message": message}}


def unfinished(why: str) -> dict:
    """A turn Hermes never reported the end of: several of its failure paths return without ``on_session_end``."""
    return failure("hermes_turn_unfinished", f"Hermes did not report how the turn ended; {why}")
