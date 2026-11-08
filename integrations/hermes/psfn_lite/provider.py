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

from agent.memory_provider import PRE_COMPRESS_CHECKPOINT_API_VERSION, MemoryProvider

from . import runtime
from .config import CONFIG_FILE, ConfigError

logger = logging.getLogger(__name__)

SYSTEM_PROMPT_BLOCK = (
    "Your continuity (orientation, memory, sessions, episodes, journals, contacts, emotion, concerns, values, activity, "
    "workers, automata and free time) lives in PSFN Lite, which is your only memory. Reach it with the psfn_lite tools; "
    "each turn also brings labelled Lite context in the user message. Hermes's own memory files are not used."
)


def ownership_issues(config: dict) -> list:
    """Hermes settings that would give the profile a second memory or a lossy compaction."""
    memory = config.get("memory") if isinstance(config.get("memory"), dict) else {}
    compression = config.get("compression") if isinstance(config.get("compression"), dict) else {}
    issues = []
    if memory.get("provider") != "psfn_lite":
        issues.append("memory.provider must be psfn_lite")
    if memory.get("memory_enabled", True) is not False:
        issues.append("memory.memory_enabled must be false (Lite is the only memory)")
    if memory.get("user_profile_enabled", True) is not False:
        issues.append("memory.user_profile_enabled must be false (Lite is the only memory)")
    if compression.get("checkpoint_required") is not True:
        issues.append("compression.checkpoint_required must be true (compaction must not drop unproven turns)")
    return issues


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
        except (ConfigError, ValueError, OSError):
            return False
        return True

    def unavailable_reason(self) -> str:
        try:
            runtime.driver()
        except (ConfigError, ValueError, OSError) as error:
            return f"{error}; see {CONFIG_FILE} in the psfn_lite plugin README"
        return ""

    def initialize(self, session_id: str, **kwargs) -> None:
        from hermes_cli.config import load_config

        runtime.add_warning_callback(kwargs.get("warning_callback"))
        issues = ownership_issues(load_config() or {})
        if issues:
            raise ConfigError("psfn_lite refuses to start: " + "; ".join(issues))
        self._driver = runtime.driver(kwargs.get("hermes_home"))
        self._session_id = session_id
        pending = self._driver.ledger.pending()
        if pending:
            runtime.notify(f"PSFN Lite has {len(pending)} unacknowledged lifecycle events in this profile's ledger; see the psfn_lite README.")

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
            self._session_id = new_session_id

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
