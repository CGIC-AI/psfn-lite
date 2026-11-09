"""The memory provider slot: PSFN Lite as the one authoritative memory.

Activating ``memory.provider: psfn_lite`` is how the profile selects the
plugin. The provider adds no tools (the governed tools come from the Lite
MCP server), no recall (Lite context arrives with each prepared turn) and
no turn sync (the lifecycle hooks settle every turn). It refuses to start
unless Hermes's own memory stores are off and compaction is fail-closed, and
it checkpoints with Lite before Hermes compacts, raising when Lite cannot
prove the session's turns so the uncompressed transcript is kept.
"""

import logging
import sqlite3

from agent.memory_provider import PRE_COMPRESS_CHECKPOINT_API_VERSION, MemoryProvider

from . import runtime
from .config import CONFIG_FILE, ConfigError

logger = logging.getLogger(__name__)

SYSTEM_PROMPT_BLOCK = (
    "Your continuity (orientation, memory, sessions, episodes, journals, contacts, emotion, concerns, values, activity, "
    "workers, automata and free time) lives in PSFN Lite, which is your only memory. Reach it with the psfn_lite tools; "
    "each turn also brings labelled Lite context in the user message. Hermes's own memory files are not used."
)


class PsfnLiteProvider(MemoryProvider):
    pre_compress_checkpoint_api_version = PRE_COMPRESS_CHECKPOINT_API_VERSION

    def __init__(self):
        self._session_id = ""
        self._driver = None

    @property
    def name(self) -> str:
        return "psfn_lite"

    def is_available(self) -> bool:
        try:
            runtime.driver()
        except (ConfigError, ValueError, OSError, sqlite3.Error):
            return False
        return True

    def unavailable_reason(self) -> str:
        try:
            runtime.driver()
        except (ConfigError, ValueError, OSError, sqlite3.Error) as error:
            return f"{error}; see {CONFIG_FILE} in the psfn_lite plugin README"
        return ""

    def initialize(self, session_id: str, **kwargs) -> None:
        runtime.add_warning_callback(kwargs.get("warning_callback"), kwargs.get("hermes_home"))
        issues = runtime.profile_issues()
        if issues:
            raise ConfigError("psfn_lite refuses to start: " + "; ".join(issues))
        self._driver = runtime.driver(kwargs.get("hermes_home"))
        self._session_id = session_id
        pending = self._driver.ledger.pending()
        if pending:
            runtime.notify(f"PSFN Lite has {len(pending)} unacknowledged lifecycle events in this profile's ledger; see the psfn_lite README.", kwargs.get("hermes_home"))

    def system_prompt_block(self) -> str:
        return SYSTEM_PROMPT_BLOCK

    def prefetch(self, query: str, *, session_id: str = "") -> str:
        return ""

    def sync_turn(self, user_content, assistant_content, *, session_id: str = "", messages=None) -> None:
        return None

    def get_tool_schemas(self) -> list:
        return []

    def on_session_switch(self, new_session_id: str, **kwargs) -> None:
        if isinstance(new_session_id, str) and new_session_id:
            parent = kwargs.get("parent_session_id") or self._session_id
            self._session_id = new_session_id
            # Only a compression continues the conversation; /new starts another one and /branch forks one
            # that may stay live beside it, so neither is linked.
            if self._driver is not None and isinstance(parent, str) and kwargs.get("reason") == "compression" and not kwargs.get("reset"):
                self._driver.session_switch(new_session_id, parent)

    def on_pre_compress(self, messages) -> str:
        if self._driver is None:
            raise ConfigError("psfn_lite was not initialized; compaction is refused")
        try:
            self._driver.checkpoint(self._session_id)
        except Exception as error:
            logger.error("psfn_lite refused compaction for session %s: %s", self._session_id, error)
            runtime.notify(f"PSFN Lite refused compaction: {error}")
            raise
        return ""

    def shutdown(self) -> None:
        return None
