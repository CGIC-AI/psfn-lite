"""The light Garden's dashboard backend, mounted by Hermes at ``/api/plugins/psfn_lite/``.

A thin proxy to Lite's Garden (packages/operator): Hermes Desktop's Garden calls
``ctx.rest('/api/lite/overview')`` and the like, Hermes authenticates the request (its session
token or OAuth) and scopes it to the profile, and this router forwards it to the Garden with the
Garden's own credential, read from the profile's secret scope. It holds no Garden logic.

Only the Garden's two route families pass (``api/admin/...``, the donor Garden routes, and
``api/lite/...``). The outbound request is built fresh: the method, the path, the query (without
Hermes's own ``profile`` selector), the body and its JSON content type, and the bearer. No inbound
header is forwarded, so the browser's Origin, cookies and Host never reach the Garden, which
refuses all three. The Garden's answer passes through with its status.

Every request uses this one credential, so the donor memory body-gate grants (keyed by the bearer)
are shared by everyone who can open this profile's dashboard: one operator, one grant session.
"""

import importlib.util
import json
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from fastapi import APIRouter, Request
from fastapi.responses import Response
from starlette.concurrency import run_in_threadpool

router = APIRouter()

#: The Garden's route families; each segment is a plain path segment, never ``.`` or ``..``.
_ROUTE = re.compile(r"^api/(admin|lite)(/[A-Za-z0-9._~%:@!$&'()*+,;=-]+)+$")
_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"]
#: Hermes's own query parameter selecting the profile (hermes_cli/web_server_dashboard.py _plugin_route_secret_scope).
_HERMES_QUERY = frozenset({"profile"})


def _config():
    """The plugin's config module, loaded from beside this file (Hermes imports this file alone, not as a package)."""
    name = "psfn_lite_dashboard_config"
    module = sys.modules.get(name)
    if module is None:
        spec = importlib.util.spec_from_file_location(name, Path(__file__).resolve().parent.parent / "config.py")
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        spec.loader.exec_module(module)
    return module


def _answer(status: int, body) -> Response:
    return Response(content=json.dumps(body), status_code=status, media_type="application/json", headers={"Cache-Control": "no-store"})


def _garden():
    """The profile's Garden settings and credential, or an answer saying why there are none."""
    from hermes_constants import get_hermes_home

    config = _config()
    try:
        settings = config.Config.load(get_hermes_home())
        if settings.garden is None:
            return None, _answer(404, {"error": "the light Garden is not configured in psfn-lite.json"})
        return (settings.garden, settings.garden.credential()), None
    except config.ConfigError as error:
        # The message names the field or the variable, never a credential.
        return None, _answer(503, {"error": str(error)})


def _forward(method: str, path: str, query: list, body: bytes, garden, credential: str) -> Response:
    url = f"{garden.url}/{path}"
    if query:
        url = f"{url}?{urllib.parse.urlencode(query)}"
    headers = {"Authorization": f"Bearer {credential}", "Accept": "application/json", "Accept-Encoding": "identity"}
    if body:
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=body or None, method=method, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=garden.timeout_seconds) as response:
            return Response(content=response.read(), status_code=response.status, media_type="application/json", headers={"Cache-Control": "no-store"})
    except urllib.error.HTTPError as error:
        return Response(content=error.read(), status_code=error.code, media_type="application/json", headers={"Cache-Control": "no-store"})
    except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as error:
        name = type(getattr(error, "reason", error)).__name__
        return _answer(502, {"error": f"the Lite Garden is unreachable ({name})"})


@router.api_route("/{path:path}", methods=_METHODS)
async def garden(path: str, request: Request) -> Response:
    if not _ROUTE.match(path) or any(segment in (".", "..") for segment in path.split("/")):
        return _answer(404, {"error": "not a Garden route"})
    resolved, refusal = _garden()
    if refusal is not None:
        return refusal
    settings, credential = resolved
    query = [(key, value) for key, value in request.query_params.multi_items() if key not in _HERMES_QUERY]
    body = await request.body()
    return await run_in_threadpool(_forward, request.method, path, query, body, settings, credential)
