"""Profile-owned plugin configuration, parsed strictly.

The file names where the bridge credential lives (an environment variable),
never the credential. Every field is required; unknown fields are refused,
so a typo cannot silently fall back to anything. Pattern kept from the donor
PSFN Hermes memory adapter (integrations/hermes-memory/psfn_memory/config.py).
"""

import json
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

CONFIG_FILE = "psfn-lite.json"
#: The Hermes revision this plugin's host contract tests ran against.
HERMES_REVISION = "f0187332d13679e2ace74d1f0eb399eb91a90571"

_ENV_NAME = re.compile(r"^[A-Z_][A-Z0-9_]*$")
_SERVER_NAME = re.compile(r"^[a-z][a-z0-9_]{0,31}$")
#: Hermes surfaces that are never a participant's conversation.
_NON_INTERACTIVE = {"subagent", "cron", "tool", "flush"}
_MIN_CREDENTIAL = 32


class ConfigError(ValueError):
    """The plugin configuration is missing or malformed; the message names the field, never a secret."""


@dataclass(frozen=True)
class Sender:
    platform: str
    #: The platform's sender id; "" for the local CLI, which has none.
    sender_id: str


@dataclass(frozen=True)
class InternalTurns:
    #: argv for one internal turn; "{prompt_file}" is replaced with the prompt file's path.
    command: tuple
    poll_wait_ms: int
    run_timeout_seconds: float


@dataclass(frozen=True)
class Config:
    bridge_url: str
    credential_env: str
    mcp_server: str
    senders: tuple
    timeout_seconds: float
    max_context_chars: int
    internal_turns: Optional[InternalTurns]

    def credential(self) -> str:
        value = os.environ.get(self.credential_env, "")
        if len(value) < _MIN_CREDENTIAL or any(c.isspace() for c in value):
            raise ConfigError(f"environment variable {self.credential_env} must hold the Lite bridge credential ({_MIN_CREDENTIAL}+ characters)")
        return value

    def binds(self, platform: str, sender_id: str) -> bool:
        return any(s.platform == platform and s.sender_id == sender_id for s in self.senders)

    @property
    def tool_prefix(self) -> str:
        return f"mcp__{self.mcp_server}__"

    @classmethod
    def parse(cls, values) -> "Config":
        fields = ("bridge_url", "credential_env", "mcp_server", "senders", "timeout_seconds", "max_context_chars", "internal_turns")
        _exact(values, fields, "config")
        url = values["bridge_url"]
        if not isinstance(url, str) or not re.match(r"^https?://[^\s/]+(/[^\s]*)?$", url) or not url.rstrip("/").endswith("/lifecycle/v1"):
            raise ConfigError("bridge_url must be the http(s) URL of the Lite lifecycle bridge, ending in /lifecycle/v1")
        env = values["credential_env"]
        if not isinstance(env, str) or not _ENV_NAME.match(env):
            raise ConfigError("credential_env must name an environment variable")
        server = values["mcp_server"]
        if not isinstance(server, str) or not _SERVER_NAME.match(server):
            raise ConfigError("mcp_server must be the mcp_servers key of the Lite MCP server ([a-z][a-z0-9_]*)")
        senders = values["senders"]
        if not isinstance(senders, list) or not senders:
            raise ConfigError("senders must list at least one {platform, sender_id} the bound credential speaks for")
        parsed = []
        for index, raw in enumerate(senders):
            _exact(raw, ("platform", "sender_id"), f"senders[{index}]")
            platform, sender = raw["platform"], raw["sender_id"]
            if not isinstance(platform, str) or not platform.strip() or platform in _NON_INTERACTIVE:
                raise ConfigError(f"senders[{index}].platform must name an interactive Hermes platform")
            if not isinstance(sender, str):
                raise ConfigError(f"senders[{index}].sender_id must be a string (\"\" for the local CLI)")
            parsed.append(Sender(platform, sender))
        timeout = values["timeout_seconds"]
        if type(timeout) not in (int, float) or not 0 < timeout <= 300:
            raise ConfigError("timeout_seconds must be a number from 0 to 300")
        limit = values["max_context_chars"]
        if type(limit) is not int or not 1_000 <= limit <= 1_000_000:
            raise ConfigError("max_context_chars must be an integer from 1000 to 1000000")
        return cls(url.rstrip("/"), env, server, tuple(parsed), float(timeout), limit, _internal(values["internal_turns"]))

    @classmethod
    def load(cls, hermes_home) -> "Config":
        path = Path(hermes_home) / CONFIG_FILE
        try:
            raw = json.loads(path.read_text())
        except FileNotFoundError:
            raise ConfigError(f"{CONFIG_FILE} is missing from the Hermes profile") from None
        except (OSError, ValueError):
            raise ConfigError(f"{CONFIG_FILE} is not readable JSON") from None
        return cls.parse(raw)


def _internal(raw) -> Optional[InternalTurns]:
    if raw is None:
        return None
    _exact(raw, ("command", "poll_wait_ms", "run_timeout_seconds"), "internal_turns")
    command = raw["command"]
    if not isinstance(command, list) or not command or not all(isinstance(a, str) and a for a in command) or "{prompt_file}" not in command:
        raise ConfigError("internal_turns.command must be a non-empty argv list containing the literal argument {prompt_file}")
    wait = raw["poll_wait_ms"]
    if type(wait) is not int or not 0 <= wait <= 60_000:
        raise ConfigError("internal_turns.poll_wait_ms must be an integer from 0 to 60000")
    timeout = raw["run_timeout_seconds"]
    if type(timeout) not in (int, float) or not 0 < timeout <= 86_400:
        raise ConfigError("internal_turns.run_timeout_seconds must be a number from 0 to 86400")
    return InternalTurns(tuple(command), wait, float(timeout))


def _exact(raw, fields, at: str) -> None:
    if not isinstance(raw, dict):
        raise ConfigError(f"{at} must be an object")
    unknown = sorted(set(raw) - set(fields))
    missing = [f for f in fields if f not in raw]
    if unknown:
        raise ConfigError(f"{at} has unknown fields: {', '.join(unknown)}")
    if missing:
        raise ConfigError(f"{at} is missing required fields: {', '.join(missing)}")
