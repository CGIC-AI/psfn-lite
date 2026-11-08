"""Runs the internal turns (free time, scheduled prompts) Lite delegates to Hermes.

Only a Hermes process started with ``PSFN_LITE_INTERNAL_HOST=1`` (the
operator's long-running gateway) claims them, and only when the profile
configures ``internal_turns``. Each claimed turn runs as its own Hermes
process from the configured command, with the credential Lite minted for
that one turn in place of the standing credential, so its MCP tools and its
lifecycle calls act in the companion's own self audience, and with
``PSFN_LITE_INTERNAL_JOB=1`` so its plugin prepares the internal trigger Lite
fixed instead of a participant message. A run that fails, times out or ends
without settling is released to Lite, which records the turn as failed.
"""

import logging
import os
import subprocess
import tempfile
import threading
import time
from pathlib import Path

from .bridge import BridgeClient, BridgeError
from .config import Config
from .lifecycle import INTERNAL_JOB_ENV
from .render import block

logger = logging.getLogger(__name__)

INTERNAL_HOST_ENV = "PSFN_LITE_INTERNAL_HOST"
_BACKOFF_SECONDS = 5.0


class InternalTurnHost:
    def __init__(self, config: Config, client: BridgeClient, hermes_home, notify):
        self._config = config
        self._client = client
        self._jobs_dir = Path(hermes_home) / "psfn-lite" / "jobs"
        self._notify = notify
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._loop, name="psfn-lite-internal-turns", daemon=True)

    def start(self) -> None:
        self._jobs_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def _loop(self) -> None:
        settings = self._config.internal_turns
        while not self._stop.is_set():
            try:
                claimed = self._client.call("internal/claim", {"waitMs": settings.poll_wait_ms})
            except BridgeError as error:
                self._warn(f"PSFN Lite internal turns cannot be claimed: {error}")
                self._stop.wait(_BACKOFF_SECONDS)
                continue
            job = claimed.get("job")
            if isinstance(job, dict):
                self.run(job)
            elif settings.poll_wait_ms == 0:
                self._stop.wait(_BACKOFF_SECONDS)

    def run(self, job: dict) -> None:
        """Runs one claimed job to the end; the job is always settled by the turn or released."""
        settings = self._config.internal_turns
        error = None
        handle, path = tempfile.mkstemp(prefix="turn-", suffix=".txt", dir=self._jobs_dir)
        try:
            with os.fdopen(handle, "w", encoding="utf-8") as prompt:
                prompt.write(block(f"system note: {job['purpose']}", job["prompt"]))
            env = {k: v for k, v in os.environ.items() if k != INTERNAL_HOST_ENV}
            env[self._config.credential_env] = job["credential"]
            env[INTERNAL_JOB_ENV] = "1"
            argv = [path if arg == "{prompt_file}" else arg for arg in settings.command]
            started = time.monotonic()
            # Output is discarded: it is the companion's own turn, recorded by Lite, not a log line.
            finished = subprocess.run(argv, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=settings.run_timeout_seconds, check=False)
            if finished.returncode != 0:
                error = {"code": "hermes_runner_failed", "message": f"the internal-turn command exited with status {finished.returncode} after {time.monotonic() - started:.0f}s"}
        except subprocess.TimeoutExpired:
            error = {"code": "hermes_runner_timeout", "message": f"the internal-turn command ran past {settings.run_timeout_seconds:.0f}s"}
        except OSError as failure:
            error = {"code": "hermes_runner_failed", "message": f"the internal-turn command could not start ({type(failure).__name__})"}
        finally:
            Path(path).unlink(missing_ok=True)
        self._release(job["jobId"], error or {"code": "internal_turn_unsettled", "message": "the internal-turn command exited without settling its turn"}, expected=error is None)

    def _release(self, job_id: str, error: dict, *, expected: bool) -> None:
        try:
            self._client.call("internal/release", {"jobId": job_id, "error": error})
        except BridgeError as failure:
            # A turn that settled already ended its job; Lite then refuses the release as invalid.
            if expected and failure.kind == "invalid":
                return
            self._warn(f"PSFN Lite internal turn {job_id} could not be released ({failure}); Lite will time it out as failed")
            return
        if not expected:
            self._warn(f"PSFN Lite internal turn failed: {error['message']}")
        else:
            self._warn("PSFN Lite internal turn ended without settling; Lite recorded it as failed")

    def _warn(self, message: str) -> None:
        logger.error(message)
        self._notify(message)
