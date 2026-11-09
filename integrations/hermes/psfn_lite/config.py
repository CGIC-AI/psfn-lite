"""Profile-owned plugin configuration, parsed strictly.

The file names where the bridge credential lives (an environment variable,
read through Hermes's profile secret scope, so in a multi-profile gateway it
comes from this profile's ``.env``), never the credential. Every field is required; unknown fields are refused,
so a typo cannot silently fall back to anything. Pattern kept from the donor
PSFN Hermes memory adapter (integrations/hermes-memory/psfn_memory/config.py).
"""

import json
import re
from dataclasses import dataclass
from pathlib import Path

CONFIG_FILE = "psfn-lite.json"
#: The Hermes revisions this plugin's host contract tests ran against (docs/development.md).
HERMES_REVISIONS = (
    "f0187332d13679e2ace74d1f0eb399eb91a90571",
    "2bd378ed1b8d6bf2192cb26e0a55ff3091e6bd19",
)

_ENV_NAME = re.compile(r"^[A-Z_][A-Z0-9_]*$")
#: Hermes's install id file in the Hermes root and its format (hermes_cli/install_identity.py _INSTALL_ID_FILENAME,
#: _INSTALL_ID_RE; at f0187332 hermes_cli/web_server.py).
INSTALL_ID_FILE = "install_id"
_INSTALL_ID = re.compile(r"^[0-9a-f]{32}$")
_SERVER_NAME = re.compile(r"^[a-z][a-z0-9_]{0,31}$")
#: Hermes surfaces that are never a participant's conversation.
NON_INTERACTIVE_PLATFORMS = frozenset({"subagent", "cron", "tool", "flush"})
_MIN_CREDENTIAL = 32


class ConfigError(ValueError):
    """The plugin configuration is missing or malformed; the message names the field, never a secret."""


@dataclass(frozen=True)
class Sender:
    platform: str
    #: The platform's sender id. The local CLI is platform "cli" with sender "" when it runs its own agent (f0187332),
    #: and platform "local" with sender "uid:<uid>" when ``hermes chat`` runs through the gateway (2bd378e
    #: gateway/control_socket.py _posix_peer_subject: the OS user the gateway itself runs as).
    sender_id: str


@dataclass(frozen=True)
class Automata:
    #: Attempts claimed at the start of one bound root turn (Hermes runs at most 8 lifecycle children at once).
    claim_limit: int


@dataclass(frozen=True)
class Config:
    bridge_url: str
    credential_env: str
    mcp_server: str
    senders: tuple
    timeout_seconds: float
    max_context_chars: int
    #: Hosted automata (operator automata rule 4), or None to leave the companion's automata to Lite's core.
    automata: "Automata | None"

    def credential(self) -> str:
        """The bridge credential from this profile's secret scope (agent.secret_scope.get_secret, fail-closed in a multiplexing gateway)."""
        from agent.secret_scope import UnscopedSecretError, get_secret

        try:
            value = get_secret(self.credential_env) or ""
        except UnscopedSecretError:
            raise ConfigError(f"Hermes has no profile secret scope for {self.credential_env} here (a multiplexing gateway reads it only inside a profile's turn)") from None
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
        fields = ("bridge_url", "credential_env", "mcp_server", "senders", "timeout_seconds", "max_context_chars", "automata")
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
            if not isinstance(platform, str) or not platform.strip() or platform in NON_INTERACTIVE_PLATFORMS:
                raise ConfigError(f"senders[{index}].platform must name an interactive Hermes platform")
            if not isinstance(sender, str):
                raise ConfigError(f"senders[{index}].sender_id must be a string (\"\" for the cli platform, \"uid:<uid>\" for the local platform)")
            parsed.append(Sender(platform, sender))
        timeout = values["timeout_seconds"]
        if type(timeout) not in (int, float) or not 0 < timeout <= 300:
            raise ConfigError("timeout_seconds must be a number from 0 to 300")
        limit = values["max_context_chars"]
        if type(limit) is not int or not 1_000 <= limit <= 1_000_000:
            raise ConfigError("max_context_chars must be an integer from 1000 to 1000000")
        automata = values["automata"]
        if automata is not None:
            _exact(automata, ("claim_limit",), "automata")
            claim_limit = automata["claim_limit"]
            if type(claim_limit) is not int or not 1 <= claim_limit <= 8:
                raise ConfigError("automata.claim_limit must be an integer from 1 to 8")
            automata = Automata(claim_limit)
        return cls(url.rstrip("/"), env, server, tuple(parsed), float(timeout), limit, automata)

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


def hermes_install_id() -> str:
    """The Hermes install this process belongs to: one id in the Hermes root, shared by every profile and surface.

    Read through Hermes's own install identity (hermes_cli/install_identity.py get_install_id, which reads the
    id or mints it once, atomically, under its lock). Hermes f0187332 has no such module; its only reader is
    the dashboard server's (hermes_cli/web_server.py get_install_id), so there the file is read as that reader
    reads it and never minted here. A missing or malformed id is a configuration error, so no turn is driven
    unbound.
    """
    try:
        from hermes_cli.install_identity import get_install_id
    except ImportError:
        get_install_id = None
    if get_install_id is not None:
        value = get_install_id()
        if value is None or not _INSTALL_ID.match(value):
            raise ConfigError("Hermes could neither read nor create its install id in the Hermes root")
        return value
    from hermes_constants import get_default_hermes_root

    path = Path(get_default_hermes_root()) / INSTALL_ID_FILE
    try:
        value = path.read_text(encoding="utf-8").strip().lower()
    except FileNotFoundError:
        raise ConfigError(f"the Hermes install id ({path}) does not exist yet; Hermes creates it when its dashboard first starts") from None
    except (OSError, UnicodeDecodeError):
        raise ConfigError(f"the Hermes install id ({path}) is not readable") from None
    if not _INSTALL_ID.match(value):
        raise ConfigError(f"the Hermes install id ({path}) is not 32 lowercase hex characters")
    return value


def ownership_issues(hermes_config: dict) -> list:
    """Hermes settings that would give the profile a second memory or a lossy compaction."""
    memory = hermes_config.get("memory") if isinstance(hermes_config.get("memory"), dict) else {}
    compression = hermes_config.get("compression") if isinstance(hermes_config.get("compression"), dict) else {}
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


def _exact(raw, fields, at: str) -> None:
    if not isinstance(raw, dict):
        raise ConfigError(f"{at} must be an object")
    unknown = sorted(set(raw) - set(fields))
    missing = [f for f in fields if f not in raw]
    if unknown:
        raise ConfigError(f"{at} has unknown fields: {', '.join(unknown)}")
    if missing:
        raise ConfigError(f"{at} is missing required fields: {', '.join(missing)}")
