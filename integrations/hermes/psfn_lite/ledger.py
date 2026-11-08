"""Durable record of Lite turns this profile has not finished delivering.

Each Lite turn the plugin starts gets one ``turn`` row before it is
prepared (the prepare body, so a restarted process can learn the turn's id
by preparing the same key again, and the host instance that owns it). The
row becomes a ``settle`` row (with the outcome, so it can be retried
exactly) when the settlement could not be delivered, and is deleted once
Lite accepted the settlement. Every other failure is kept as a diagnostic
row without chat text. Nothing is ever dropped silently: ``pending()`` is
what the plugin surfaces, and the next turn retries settlements before it
prepares. The storage pattern (WAL, FULL sync, owner-only file, a binding
row that refuses another bridge) is kept from the donor adapter's outbox
(integrations/hermes-memory/psfn_memory/outbox.py).

Rows carry their credential scope: ``standing`` rows were made with the
profile's standing credential and any standing process of the profile may
deliver them; ``job`` rows belong to one delegated internal-turn process,
whose minted credential no other process holds.
"""

import json
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path

SCHEMA_VERSION = 2
STANDING = "standing"
JOB = "job"


def _encode(value) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


class Ledger:
    def __init__(self, hermes_home, *, bridge_url: str):
        directory = Path(hermes_home) / "psfn-lite"
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.path = directory / "undelivered.sqlite3"
        with self._connect() as db:
            db.execute("PRAGMA journal_mode = WAL")
            version = db.execute("PRAGMA user_version").fetchone()[0]
            if version not in (0, SCHEMA_VERSION):
                raise ValueError(f"psfn_lite ledger {self.path} has schema {version}, not {SCHEMA_VERSION}; deliver or move it aside")
            db.execute("CREATE TABLE IF NOT EXISTS binding (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)")
            db.execute(
                """CREATE TABLE IF NOT EXISTS events (
                    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                    kind TEXT NOT NULL, session_id TEXT NOT NULL, turn_id TEXT,
                    payload TEXT, error TEXT NOT NULL, at_ms INTEGER NOT NULL,
                    host_instance TEXT, scope TEXT
                )"""
            )
            db.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
            binding = _encode({"bridgeUrl": bridge_url})
            db.execute("INSERT OR IGNORE INTO binding(id,value) VALUES(1,?)", (binding,))
            if db.execute("SELECT value FROM binding WHERE id=1").fetchone()[0] != binding:
                raise ValueError("psfn_lite ledger belongs to a different Lite bridge; use a separate Hermes profile")
        self.path.chmod(0o600)

    @contextmanager
    def _connect(self):
        db = sqlite3.connect(self.path)
        try:
            db.execute("PRAGMA synchronous = FULL")
            with db:
                yield db
        finally:
            db.close()

    def record(self, kind: str, session_id: str, turn_id, error: str) -> int:
        """A diagnostic row: what failed, never chat text."""
        with self._connect() as db:
            cursor = db.execute(
                "INSERT INTO events(kind,session_id,turn_id,payload,error,at_ms) VALUES(?,?,?,NULL,?,?)",
                (kind, session_id, turn_id, error, _now()),
            )
            return int(cursor.lastrowid)

    def open_turn(self, *, session_id: str, host_instance: str, scope: str, pid: int, hermes_turn: str, prepare: dict) -> int:
        """The row of a turn about to be prepared; deleted once its settlement is accepted."""
        with self._connect() as db:
            cursor = db.execute(
                "INSERT INTO events(kind,session_id,turn_id,payload,error,at_ms,host_instance,scope) VALUES('turn',?,NULL,?,'',?,?,?)",
                (session_id, _encode({"pid": pid, "hermesTurn": hermes_turn, "prepare": prepare}), _now(), host_instance, scope),
            )
            return int(cursor.lastrowid)

    def bind_turn(self, sequence: int, lite_turn: str) -> None:
        with self._connect() as db:
            db.execute("UPDATE events SET turn_id=? WHERE sequence=? AND kind='turn'", (lite_turn, sequence))

    def keep_settlement(self, sequence: int, *, settle: dict, prepare, error: str) -> None:
        """The turn's settlement was not delivered: keep it, and the prepare that learns the turn id when it is unknown."""
        with self._connect() as db:
            db.execute(
                "UPDATE events SET kind='settle', turn_id=?, payload=?, error=?, at_ms=? WHERE sequence=?",
                (settle.get("turnId"), _encode({"settle": settle, "prepare": prepare}), error, _now(), sequence),
            )

    def turns(self) -> list:
        """Open turn rows of every process of this profile."""
        with self._connect() as db:
            rows = db.execute("SELECT sequence,session_id,turn_id,payload,host_instance,scope FROM events WHERE kind='turn' ORDER BY sequence")
            return [_row(r, ("sequence", "session_id", "turn_id", "payload", "host_instance", "scope")) for r in rows]

    def pending_settlements(self, *, scope: str, instance: str) -> list:
        """Kept settlements this process may deliver: every standing one, or a job process's own."""
        query = "SELECT sequence,session_id,turn_id,payload,host_instance,scope FROM events WHERE kind='settle' AND payload IS NOT NULL"
        with self._connect() as db:
            if scope == STANDING:
                rows = db.execute(query + " AND scope=? ORDER BY sequence", (STANDING,))
            else:
                rows = db.execute(query + " AND scope=? AND host_instance=? ORDER BY sequence", (JOB, instance))
            return [_row(r, ("sequence", "session_id", "turn_id", "payload", "host_instance", "scope")) for r in rows]

    def resolve(self, sequence: int) -> None:
        with self._connect() as db:
            db.execute("DELETE FROM events WHERE sequence=?", (sequence,))

    def pending(self) -> list:
        """Every unacknowledged event (kept settlements and diagnostics; not turns still running), oldest first, without payloads."""
        with self._connect() as db:
            rows = db.execute("SELECT sequence,kind,session_id,turn_id,error,at_ms FROM events WHERE kind<>'turn' ORDER BY sequence")
            return [dict(zip(("sequence", "kind", "session_id", "turn_id", "error", "at_ms"), r)) for r in rows]


def _row(values, names) -> dict:
    row = dict(zip(names, values))
    row["payload"] = None if row["payload"] is None else json.loads(row["payload"])
    return row


def _now() -> int:
    return time.time_ns() // 1_000_000
