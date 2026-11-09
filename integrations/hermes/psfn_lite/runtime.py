"""One plugin runtime per Hermes process and profile.

Hermes loads the memory provider once per agent (the gateway builds an
agent per message) and calls ``register`` each time, but the module stays
imported, so the driver, its ledger and the hook registrations live here,
once. Hooks registered by an earlier load are reused while their handles
are active, so no turn is ever prepared twice.
"""

import logging
import sqlite3
import threading

from . import automata
from .bridge import BridgeClient
from .config import Config, ConfigError, ownership_issues
from .ledger import Ledger
from .lifecycle import Driver, host_instance

logger = logging.getLogger(__name__)

HOOKS = ("pre_llm_call", "pre_tool_call", "post_llm_call", "on_session_end", "on_session_finalize", "subagent_start")

_lock = threading.RLock()
_drivers = {}
_handles = {}
_warning_callbacks = []


def notify(message: str) -> None:
    for callback in list(_warning_callbacks):
        try:
            callback(message)
        except Exception:
            logger.exception("psfn_lite warning callback failed")


def add_warning_callback(callback) -> None:
    """The latest agent's callback; the gateway builds an agent per message, so older ones are let go."""
    if callable(callback):
        with _lock:
            _warning_callbacks[:] = [callback]


def profile_issues() -> list:
    """Why this profile must not drive Lite: a second memory or lossy compaction configured beside it."""
    from hermes_cli.config import load_config

    return ownership_issues(load_config() or {})


def hermes_home() -> str:
    from hermes_constants import get_hermes_home

    return str(get_hermes_home())


def driver(home: str = None) -> Driver:
    """The profile's driver, built on first use. Raises ConfigError when the profile is not configured."""
    home = home or hermes_home()
    with _lock:
        existing = _drivers.get(home)
        if existing is not None:
            return existing
        config = Config.load(home)
        client = BridgeClient(config.bridge_url, config.credential(), config.timeout_seconds)
        built = Driver(config, Ledger(home, bridge_url=config.bridge_url), client, instance=host_instance(), notify=notify)
        _drivers[home] = built
        # Turns an exited process of this profile left open are settled before this process prepares any.
        built.delivery.recover()
        return built


def _tool_gate_refusal(tool_name, error) -> dict:
    """pre_tool_call when the plugin is not usable: Lite's tools are blocked, never let through (Hermes runs a tool no hook blocks)."""
    try:
        prefix = Config.load(hermes_home()).tool_prefix
    except (ConfigError, OSError):
        prefix = "mcp__"  # which MCP server is Lite's is unknown, so every MCP tool is blocked
    if not isinstance(tool_name, str) or not tool_name.startswith(prefix):
        return None
    logger.error("psfn_lite blocked %s: the plugin is not usable (%s)", tool_name, error)
    return {"action": "block", "message": f"PSFN Lite tools are blocked: the psfn_lite plugin is not usable in this Hermes profile ({error})."}


def _hook(name: str):
    def call(**kwargs):
        if name == "pre_tool_call":
            try:
                issues = profile_issues()
                if issues:
                    raise ConfigError("psfn_lite refuses to drive Lite turns: " + "; ".join(issues))
                return driver().pre_tool_call(**kwargs)
            except Exception as error:  # a hook that raises lets the tool run, so every failure blocks
                return _tool_gate_refusal(kwargs.get("tool_name"), error)
        try:
            # The hooks are registered whether or not the provider started, so they refuse on their own
            # when the profile would also keep Hermes's memory or compact without a checkpoint.
            issues = profile_issues()
            if issues:
                raise ConfigError("psfn_lite refuses to drive Lite turns: " + "; ".join(issues))
            return getattr(driver(), name)(**kwargs)
        except (ConfigError, ValueError, OSError, sqlite3.Error) as error:
            logger.error("psfn_lite is not usable: %s", error)
            notify(f"PSFN Lite is not usable in this profile: {error}")
            if name == "pre_llm_call":
                from .render import block

                return {"context": block("system note: psfn_lite", f"Your PSFN Lite continuity is not reachable from this Hermes profile ({error}); this turn is not recorded there.")}
            return None

    call.__name__ = f"psfn_lite_{name}"
    return call


def register_hooks(ctx) -> None:
    with _lock:
        for name in HOOKS:
            handle = _handles.get(name)
            if handle is not None and getattr(handle, "active", False):
                continue
            _handles[name] = ctx.register_hook(name, _hook(name))


def bus_tool(args, **kwargs) -> str:
    """The ``automata_bus`` tool of hosted automaton children; any other caller is refused."""
    import json

    try:
        host = driver().automata
    except (ConfigError, ValueError, OSError, sqlite3.Error) as error:
        return json.dumps({"error": f"PSFN Lite is not usable in this profile: {error}"})
    if host is None:
        return json.dumps({"error": automata.OUTSIDE_ATTEMPT})
    return host.bus_tool(args, **kwargs)


def register_tools(ctx) -> None:
    """Registers ``automata_bus`` once per process when the profile runs hosted automata."""
    try:
        enabled = Config.load(hermes_home()).automata is not None
    except (ConfigError, OSError):
        return  # the hooks report the unusable profile on its first turn
    if not enabled:
        return
    with _lock:
        handle = _handles.get("tool:" + automata.TOOL_NAME)
        if handle is not None and getattr(handle, "active", False):
            return
        _handles["tool:" + automata.TOOL_NAME] = ctx.register_tool(
            name=automata.TOOL_NAME,
            toolset=automata.TOOLSET,
            schema=automata.TOOL_SCHEMA,
            handler=bus_tool,
            description=automata.TOOL_SCHEMA["description"],
        )


def reset_for_tests() -> None:
    with _lock:
        for handle in _handles.values():
            dispose = getattr(handle, "dispose", None)
            if callable(dispose):
                dispose()
        _drivers.clear()
        _handles.clear()
        _warning_callbacks.clear()
