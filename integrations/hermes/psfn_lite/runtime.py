"""One plugin runtime per Hermes profile (home), in every Hermes process.

Hermes loads the memory provider once per agent (the gateway builds an
agent per message) and calls ``register`` each time, but the module stays
imported, so the drivers, their ledgers and the hook registrations live
here. Since Hermes 2bd378e one gateway process serves several profiles
(``hermes chat`` itself runs through it): Hermes keeps a plugin manager per
home (hermes_cli/plugins.py get_plugin_manager) and runs each turn with its
profile's home bound (hermes_constants.get_hermes_home), and a user memory
provider may be imported once for several homes (one module name per
provider name at f0187332). So everything here is keyed by home: each
profile's manager gets its own hooks and middleware, each profile its own
driver, host instance and warning callback. Hooks registered by an earlier
load are reused while their handles are active, so no turn is ever prepared
twice.

A profile whose ``memory.provider`` is not ``psfn_lite`` never has its turns
or tools touched, even when its manager holds these hooks.
"""

import logging
import sqlite3
import threading
from pathlib import Path

from . import automata
from .bridge import BridgeClient
from .config import Config, ConfigError, hermes_install_id, ownership_issues
from .ledger import Ledger
from .lifecycle import Driver, host_instance

logger = logging.getLogger(__name__)

HOOKS = ("pre_llm_call", "pre_tool_call", "post_tool_call", "post_llm_call", "on_session_end", "on_session_finalize", "subagent_start")
#: Hermes middleware the plugin registers (hermes_cli/middleware.py LLM_REQUEST_MIDDLEWARE).
MIDDLEWARE = ("llm_request",)
PROVIDER = "psfn_lite"

_lock = threading.RLock()
#: home -> Driver
_drivers = {}
#: (home, registration) -> Hermes registration handle
_handles = {}
#: home -> the latest agent's warning callback
_warning_callbacks = {}


def _home(home) -> str:
    """A profile home as the runtime keys it: resolved, so one profile is one key however Hermes spells it."""
    return str(Path(home).resolve()) if home else hermes_home()


def notify(message: str, home: str = None) -> None:
    home = _home(home)
    with _lock:
        callback = _warning_callbacks.get(home)
    if callback is None:
        return
    try:
        callback(message)
    except Exception:
        logger.exception("psfn_lite warning callback failed")


def add_warning_callback(callback, home: str = None) -> None:
    """The profile's latest agent's callback; the gateway builds an agent per message, so older ones are let go."""
    if callable(callback):
        with _lock:
            _warning_callbacks[_home(home)] = callback


def hermes_config() -> dict:
    """The current profile's config.yaml, as Hermes loads it for the home bound to this turn."""
    from hermes_cli.config import load_config

    return load_config() or {}


def configured(config: dict) -> bool:
    """True when this profile selected the plugin: its memory.provider is psfn_lite."""
    memory = config.get("memory") if isinstance(config.get("memory"), dict) else {}
    return memory.get("provider") == PROVIDER


def profile_issues() -> list:
    """Why this profile must not drive Lite: a second memory or lossy compaction configured beside it."""
    return ownership_issues(hermes_config())


def hermes_home() -> str:
    """The home of the profile this call runs for: Hermes binds it per turn in a multi-profile gateway."""
    from hermes_constants import get_hermes_home

    return str(get_hermes_home().resolve())


def driver(home: str = None) -> Driver:
    """The profile's driver, built on first use. Raises ConfigError when the profile is not configured."""
    home = _home(home)
    with _lock:
        existing = _drivers.get(home)
        if existing is not None:
            return existing
        config = Config.load(home)
        client = BridgeClient(config.bridge_url, config.credential(), config.timeout_seconds)
        built = Driver(config, Ledger(home, bridge_url=config.bridge_url), client, instance=host_instance(), install=hermes_install_id(),
                       notify=lambda message: notify(message, home))
        _drivers[home] = built
        # Turns an exited process of this profile left open are settled before this process prepares any.
        built.delivery.recover()
        return built


def _tool_gate_refusal(tool_name, error) -> dict:
    """pre_tool_call when the plugin is not usable in a profile that selected it: Lite's tools are blocked, never let through."""
    try:
        prefix = Config.load(hermes_home()).tool_prefix
    except (ConfigError, OSError):
        prefix = "mcp__"  # which MCP server is Lite's is unknown, so every MCP tool of this profile is blocked
    if not isinstance(tool_name, str) or not tool_name.startswith(prefix):
        return None
    logger.error("psfn_lite blocked %s: the plugin is not usable (%s)", tool_name, error)
    return {"action": "block", "message": f"PSFN Lite tools are blocked: the psfn_lite plugin is not usable in this Hermes profile ({error})."}


def _selected():
    """This profile's config when it selected the plugin, else None (the hooks then leave its turns alone)."""
    config = hermes_config()
    return config if configured(config) else None


def _hook(name: str):
    def call(**kwargs):
        if name == "pre_tool_call":
            try:
                config = _selected()
                if config is None:
                    return None
                issues = ownership_issues(config)
                if issues:
                    raise ConfigError("psfn_lite refuses to drive Lite turns: " + "; ".join(issues))
                return driver().pre_tool_call(**kwargs)
            except Exception as error:  # a hook that raises lets the tool run, so every failure blocks
                return _tool_gate_refusal(kwargs.get("tool_name"), error)
        try:
            config = _selected()
            if config is None:
                return None
            # The hooks are registered whether or not the provider started, so they refuse on their own
            # when the profile would also keep Hermes's memory or compact without a checkpoint.
            issues = ownership_issues(config)
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


def _llm_request(**kwargs):
    """Hermes's llm_request middleware: the donor's explicit tool contract applied to the provider request."""
    try:
        config = _selected()
        if config is None or ownership_issues(config):
            return None  # the hooks report an unusable profile; the request goes as Hermes built it
        return driver().llm_request(**kwargs)
    except Exception as error:  # a failing middleware sends the request unmodified; the turn may then fail Lite's check
        logger.error("psfn_lite could not apply the companion's tool choice: %s", error)
        notify(f"PSFN Lite could not apply the companion's tool choice to this model call: {error}")
        return None


_llm_request.__name__ = "psfn_lite_llm_request"


def register_hooks(ctx) -> None:
    """The lifecycle hooks and the llm_request middleware, once per profile (each profile's Hermes manager holds its own)."""
    home = hermes_home()
    with _lock:
        for name in HOOKS:
            handle = _handles.get((home, name))
            if handle is not None and getattr(handle, "active", False):
                continue
            _handles[(home, name)] = ctx.register_hook(name, _hook(name))
        for kind in MIDDLEWARE:
            key = (home, "middleware:" + kind)
            handle = _handles.get(key)
            if handle is not None and getattr(handle, "active", False):
                continue
            _handles[key] = ctx.register_middleware(kind, _llm_request)


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
    """Registers ``automata_bus`` once per profile when the profile runs hosted automata."""
    home = hermes_home()
    try:
        enabled = Config.load(home).automata is not None
    except (ConfigError, OSError):
        return  # the hooks report the unusable profile on its first turn
    if not enabled:
        return
    with _lock:
        key = (home, "tool:" + automata.TOOL_NAME)
        handle = _handles.get(key)
        if handle is not None and getattr(handle, "active", False):
            return
        _handles[key] = ctx.register_tool(
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
