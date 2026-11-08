"""HTTP JSON client for the Lite lifecycle bridge.

The caller is bound by the bearer credential; no request body ever names a
caller, contact or audience. Failures are classified into a short, adapter-
owned diagnostic: core's public error kind and reason (which never carry
another audience's content), or the transport failure class. Server text is
never echoed, a pattern kept from the donor adapter's ``_server_error``.
"""

import json
import urllib.error
import urllib.request


class BridgeError(RuntimeError):
    """A lifecycle request that did not succeed. ``transient`` failures may be retried."""

    def __init__(self, message: str, *, kind: str, reason: str = "", status: int = 0):
        super().__init__(message)
        self.kind = kind
        self.reason = reason
        self.status = status

    @property
    def transient(self) -> bool:
        return self.kind in ("unreachable", "unavailable", "bridge_failure")


class BridgeClient:
    def __init__(self, url: str, credential: str, timeout: float):
        self._url = url
        self._credential = credential
        self._timeout = timeout

    def call(self, route: str, body: dict) -> dict:
        request = urllib.request.Request(
            f"{self._url}/{route}",
            data=json.dumps(body).encode("utf-8"),
            method="POST",
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {self._credential}"},
        )
        try:
            with urllib.request.urlopen(request, timeout=self._timeout) as response:
                return _decode(response.read())
        except urllib.error.HTTPError as error:
            raise _classify(error.code, error.read()) from None
        except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as error:
            name = type(getattr(error, "reason", error)).__name__
            raise BridgeError(f"Lite lifecycle bridge unreachable ({name})", kind="unreachable") from None


def _decode(raw: bytes) -> dict:
    try:
        value = json.loads(raw)
    except ValueError:
        raise BridgeError("Lite lifecycle bridge answered with invalid JSON", kind="protocol") from None
    if not isinstance(value, dict):
        raise BridgeError("Lite lifecycle bridge answered with a non-object", kind="protocol")
    return value


def _classify(status: int, raw: bytes) -> BridgeError:
    if status == 401:
        return BridgeError("Lite bridge refused the credential; check the configured credential variable", kind="unauthenticated", status=status)
    if status == 500:
        return BridgeError("Lite bridge failed internally; see the Lite operator log", kind="bridge_failure", status=status)
    try:
        error = json.loads(raw).get("error")
    except (ValueError, AttributeError):
        error = None
    if isinstance(error, dict) and isinstance(error.get("kind"), str):
        kind = error["kind"]
        reason = error.get("reason") if isinstance(error.get("reason"), str) else ""
        if kind == "invalid":
            issues = error.get("issues") if isinstance(error.get("issues"), list) else []
            # Core's own validation messages name fields, never content.
            shown = "; ".join(str(i) for i in issues[:3])
            return BridgeError(f"Lite refused the request as invalid: {shown}", kind=kind, status=status)
        return BridgeError(f"Lite refused the request: {kind}{f' ({reason})' if reason else ''}", kind=kind, reason=reason, status=status)
    return BridgeError(f"Lite bridge answered HTTP {status}", kind="protocol", status=status)
