"""One plugin runtime per Hermes process and profile.

Hermes loads the memory provider once per agent (the gateway builds an
agent per message) and calls ``register`` each time, but the module stays
imported, so the driver, its ledger and the hook registrations live here,
once. Hooks registered by an earlier load are reused while their handles
are active, so no turn is ever prepared twice.
"""

import logging
import os
import threading

from .bridge import BridgeClient
from .config import Config, ConfigError, ownership_issues
from .internal import INTERNAL_HOST_ENV, InternalTurnHost
from .ledger import Ledger
from .lifecycle import INTERNAL_JOB_ENV, Driver, host_instance

logger = logging.getLogger(__name__)

HOOKS = ("pre_llm_call", "post_llm_call", "post_tool_call", "on_session_end", "subagent_start")

_lock = threading.RLock()
_drivers = {}
_handles = {}
_internal_hosts = {}
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
        built = Driver(config, Ledger(home, bridge_url=config.bridge_url), client, instance=host_instance(), internal_job=os.environ.get(INTERNAL_JOB_ENV) == "1", notify=notify)
        _drivers[home] = built
        if config.internal_turns is not None and os.environ.get(INTERNAL_HOST_ENV) == "1" and not built.internal_job:
            host = InternalTurnHost(config, client, home, notify)
            host.start()
            _internal_hosts[home] = host
        return built


def _hook(name: str):
    def call(**kwargs):
        try:
            # The hooks are registered whether or not the provider started, so they refuse on their own
            # when the profile would also keep Hermes's memory or compact without a checkpoint.
            issues = profile_issues()
            if issues:
                raise ConfigError("psfn_lite refuses to drive Lite turns: " + "; ".join(issues))
            active = driver()
        except (ConfigError, ValueError, OSError) as error:
            logger.error("psfn_lite is not usable: %s", error)
            notify(f"PSFN Lite is not usable in this profile: {error}")
            if name == "pre_llm_call":
                from .render import block

                return {"context": block("system note: psfn_lite", f"Your PSFN Lite continuity is not reachable from this Hermes profile ({error}); this turn is not recorded there.")}
            return None
        return getattr(active, name)(**kwargs)

    call.__name__ = f"psfn_lite_{name}"
    return call


def register_hooks(ctx) -> None:
    with _lock:
        for name in HOOKS:
            handle = _handles.get(name)
            if handle is not None and getattr(handle, "active", False):
                continue
            _handles[name] = ctx.register_hook(name, _hook(name))


def reset_for_tests() -> None:
    with _lock:
        for host in _internal_hosts.values():
            host.stop()
        for handle in _handles.values():
            dispose = getattr(handle, "dispose", None)
            if callable(dispose):
                dispose()
        _drivers.clear()
        _handles.clear()
        _internal_hosts.clear()
        _warning_callbacks.clear()
