"""Durable record of lifecycle events Lite has not acknowledged.

A settlement that could not be delivered is kept here (with its outcome, so
it can be retried exactly) until Lite accepts it; every other failure is
kept as a diagnostic row without chat text. Nothing is ever dropped
silently: ``pending()`` is what the plugin surfaces, and the next turn
retries settlements before it prepares. The storage pattern (WAL, FULL
sync, owner-only file, a binding row that refuses another bridge) is kept
from the donor adapter's outbox (integrations/hermes-memory/psfn_memory/outbox.py).
"""

import json
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path


def _encode(value) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


class Ledger:
    def __init__(self, hermes_home, *, bridge_url: str):
        directory = Path(hermes_home) / "psfn-lite"
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.path = directory / "undelivered.sqlite3"
        with self._connect() as db:
            db.execute("PRAGMA journal_mode = WAL")
            db.execute("CREATE TABLE IF NOT EXISTS binding (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)")
            db.execute(
                """CREATE TABLE IF NOT EXISTS events (
                    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                    kind TEXT NOT NULL, session_id TEXT NOT NULL, turn_id TEXT,
                    payload TEXT, error TEXT NOT NULL, at_ms INTEGER NOT NULL
                )"""
            )
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

    def record(self, kind: str, session_id: str, turn_id, error: str, payload=None) -> int:
        with self._connect() as db:
            cursor = db.execute(
                "INSERT INTO events(kind,session_id,turn_id,payload,error,at_ms) VALUES(?,?,?,?,?,?)",
                (kind, session_id, turn_id, None if payload is None else _encode(payload), error, time.time_ns() // 1_000_000),
            )
            return int(cursor.lastrowid)

    def pending_settlements(self) -> list:
        with self._connect() as db:
            rows = db.execute("SELECT sequence,session_id,turn_id,payload FROM events WHERE kind='settle' AND payload IS NOT NULL ORDER BY sequence")
            return [{"sequence": r[0], "session_id": r[1], "turn_id": r[2], "payload": json.loads(r[3])} for r in rows]

    def resolve(self, sequence: int) -> None:
        with self._connect() as db:
            db.execute("DELETE FROM events WHERE sequence=?", (sequence,))

    def pending(self) -> list:
        """Every unacknowledged event, oldest first, without payloads."""
        with self._connect() as db:
            rows = db.execute("SELECT sequence,kind,session_id,turn_id,error,at_ms FROM events ORDER BY sequence")
            return [dict(zip(("sequence", "kind", "session_id", "turn_id", "error", "at_ms"), r)) for r in rows]
