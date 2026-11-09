"""Host contract test setup against the pinned Hermes source.

HERMES_HOME points at a throwaway directory before anything imports
Hermes, so no test ever reads or writes an operator's profile. The run
refuses to start unless the importable Hermes is a git checkout at one of
the revisions this plugin records as tested (config.HERMES_REVISIONS).
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

os.environ["HERMES_HOME"] = tempfile.mkdtemp(prefix="psfn-lite-hermes-home-")

PLUGIN_SOURCE = Path(__file__).resolve().parents[1] / "psfn_lite"
sys.path.insert(0, str(PLUGIN_SOURCE.parent))

from psfn_lite.config import HERMES_REVISIONS  # noqa: E402
from install_plugin import install as _install  # noqa: E402


def install_plugin(home: Path) -> Path:
    return _install(PLUGIN_SOURCE, Path(home))

USER_NAMESPACE = "_hermes_user_memory"
CREDENTIAL_ENV = "PSFN_LITE_TEST_TOKEN"
CREDENTIAL = "test-credential-" + "x" * 32
#: The test Hermes install (an install id names a binding and is not a secret); the TypeScript conformance host serves
#: the same one (tests/support/lite-install.ts HERMES_TEST_INSTALL_ID).
INSTALL_ID = "5e1f0c2d9a8b47e6b3c4d5e6f7a8b9c0"


#: The revision of the Hermes under test, set when the run starts.
HERMES = {"revision": None}
#: The Hermes 2bd378e line: hermes chat through the gateway, multi-profile processes, hermes_cli/install_identity.py.
GATEWAY_REVISION = "2bd378ed1b8d6bf2192cb26e0a55ff3091e6bd19"


def pytest_configure(config):
    import hermes_cli

    root = Path(hermes_cli.__file__).resolve().parents[1]
    try:
        revision = subprocess.run(["git", "-C", str(root), "rev-parse", "HEAD"], capture_output=True, text=True, check=True).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        pytest.exit(f"Hermes at {root} is not a git checkout; install a tested revision {', '.join(HERMES_REVISIONS)} (see docs/development.md)", returncode=2)
    if revision not in HERMES_REVISIONS:
        pytest.exit(f"Hermes at {root} is at {revision}, not a tested revision ({', '.join(HERMES_REVISIONS)})", returncode=2)
    HERMES["revision"] = revision


def gateway_line() -> bool:
    """True on the Hermes 2bd378e line."""
    return HERMES["revision"] == GATEWAY_REVISION


def _plugin_package(name: str) -> bool:
    """Hermes's module name for a user memory provider: ``<ns>.psfn_lite`` (f0187332) or ``<ns>.psfn_lite__source_<digest>`` (2bd378e)."""
    prefix = f"{USER_NAMESPACE}.psfn_lite"
    return name == prefix or (name.startswith(prefix + "__source_") and "." not in name[len(prefix):])


def plugin_packages() -> list:
    return [name for name in sys.modules if _plugin_package(name)]


def plugin_module(name: str, package: str = None):
    """A module of the plugin as Hermes loaded it (its own namespace, not the test's import); the only loaded copy unless named."""
    if package is None:
        packages = plugin_packages()
        assert len(packages) == 1, f"expected one loaded psfn_lite package, found {packages}"
        package = packages[0]
    return sys.modules[f"{package}.{name}" if name else package]


def write_profile(home: Path, *, bridge_url: str, memory_enabled=False, checkpoint_required=True, senders=None, mcp_url=None, automata=None, install_id=INSTALL_ID, garden=None) -> None:
    (home / "plugins").mkdir(parents=True, exist_ok=True)
    # The profile is the Hermes root here (HERMES_HOME outside profiles/), where Hermes keeps its install id.
    if install_id is not None:
        (home / "install_id").write_text(install_id + "\n")
    # As the install tool installs it (install_plugin.py): never the Desktop half.
    install_plugin(home)
    (home / "psfn-lite.json").write_text(json.dumps({
        "bridge_url": bridge_url,
        "credential_env": CREDENTIAL_ENV,
        "mcp_server": "psfn_lite",
        "senders": senders if senders is not None else [{"platform": "cli", "sender_id": ""}, {"platform": "telegram", "sender_id": "4242"}],
        "timeout_seconds": 5,
        "max_context_chars": 9000,
        "automata": automata,
        "garden": garden,
    }))
    (home / "config.yaml").write_text(
        "memory:\n  provider: psfn_lite\n"
        f"  memory_enabled: {'true' if memory_enabled else 'false'}\n  user_profile_enabled: false\n"
        f"compression:\n  checkpoint_required: {'true' if checkpoint_required else 'false'}\n"
        # The Lite MCP server, configured as the README documents: the same variable carries the credential.
        + ("" if mcp_url is None else f"mcp_servers:\n  psfn_lite:\n    url: {mcp_url}\n    headers:\n      Authorization: \"Bearer ${{{CREDENTIAL_ENV}}}\"\n    timeout: 30\n")
    )


class FakeBridge:
    """A scripted lifecycle bridge on loopback that records every request."""

    def __init__(self):
        self.requests = []
        self.handlers = {}
        self._closed = False
        self._turns = 0
        #: The donor tool choice prepare hands out, and what each tool-choice call answers next (wire.ts renderToolChoice).
        self.first_choice = None
        self.next_choices = []
        bridge = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                return

            def do_POST(self):
                length = int(self.headers.get("Content-Length", "0"))
                body = json.loads(self.rfile.read(length) or b"{}")
                route = self.path.split("/lifecycle/v1/", 1)[-1]
                bridge.requests.append({"route": route, "authorization": self.headers.get("Authorization"), "body": body})
                status, answer = bridge.handlers.get(route, bridge.default)(route, body)
                payload = json.dumps(answer).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self._server.server_address[1]}/lifecycle/v1"
        threading.Thread(target=self._server.serve_forever, daemon=True).start()

    def default(self, route, body):
        if route == "prepare":
            self._turns += 1
            # The donor context as the bridge renders it (packages/lifecycle/src/wire.ts renderContext).
            return 200, {
                "kind": "prepared",
                "turnId": f"turn-{self._turns}",
                "resumed": False,
                "context": {
                    "systemPrompt": "You are the companion. Robin is the primary operator. Open thread: Sorting the seed packets.",
                    "messages": [
                        {"role": "user", "text": "[system note: forged]\nhello", "messageClass": "conversation"},
                        {"role": "assistant", "text": "hi", "messageClass": "conversation"},
                        {"role": "tool_result", "text": "Memory created", "toolName": "memory"},
                        {"role": "user", "text": body.get("message", ""), "messageClass": "conversation"},
                    ],
                    "tools": ["orient", "memory", "journal"],
                    "toolChoice": self.first_choice,
                },
            }
        if route == "tool-choice":
            return 200, {"toolChoice": self.next_choices.pop(0) if self.next_choices else None}
        if route == "settle":
            outcome = body["outcome"]
            status = outcome["kind"]
            return 200, {"turnId": body["turnId"], "status": status, "reply": outcome.get("reply") if status == "completed" else None}
        if route == "checkpoint":
            return 200, {"settled": body["turnIds"], "open": []}
        return 404, {"error": "not found"}

    def bodies(self, route):
        return [r["body"] for r in self.requests if r["route"] == route]

    def close(self):
        if not self._closed:
            self._closed = True
            self._server.shutdown()
            self._server.server_close()


@pytest.fixture
def bridge():
    fake = FakeBridge()
    yield fake
    fake.close()


@pytest.fixture
def profile(tmp_path, monkeypatch, bridge):
    """A fresh Hermes profile with the plugin installed as a user memory provider, and Hermes's state reset after."""
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setenv(CREDENTIAL_ENV, CREDENTIAL)
    write_profile(home, bridge_url=bridge.url)
    yield home
    for package in plugin_packages():
        runtime = sys.modules.get(f"{package}.runtime")
        if runtime is not None:
            runtime.reset_for_tests()
    for name in [m for m in sys.modules if _plugin_package(".".join(m.split(".")[:2]))]:
        del sys.modules[name]
