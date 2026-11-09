"""Continuity conformance on the real plugin inside the pinned Hermes.

Every scenario of tests/conformance/scenarios, in each order it declares,
against the conformance host process (the standalone runtime over the
extracted companion core and a throwaway Postgres), with Hermes as the
Hermes surface; see conformance_runner.py.

Docker and Node are required, as for the TypeScript integration suites;
LITE_SKIP_DOCKER_TESTS=1 opts out explicitly and says so.
"""

import os

import pytest

from conformance_runner import HermesSurface, PostgresFixture, load_scenarios, orders_of, run_scenario
from conftest import CREDENTIAL_ENV, USER_NAMESPACE, plugin_module, write_profile

pytestmark = pytest.mark.skipif(os.environ.get("LITE_SKIP_DOCKER_TESTS") == "1", reason="LITE_SKIP_DOCKER_TESTS=1: docker-backed conformance suite skipped")

CASES = [pytest.param(s, order, id=f"{s['name']}[a={order[0]},b={order[1]}]") for s in load_scenarios() for order in orders_of(s)]


@pytest.fixture(scope="module")
def postgres():
    fixture = PostgresFixture()
    yield fixture
    fixture.stop()


@pytest.fixture
def hermes(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "unused-home"))
    monkeypatch.setenv(CREDENTIAL_ENV, "unset")
    surface = HermesSurface(tmp_path, write_profile, CREDENTIAL_ENV, plugin_module, USER_NAMESPACE)
    yield surface
    surface.close()


def fresh_state(postgres, tmp_path) -> dict:
    # The host creates and seeds the data directory; the companion workspace sits beside it.
    return {"databaseUrl": postgres.create(), "base": str(tmp_path / "lite"), "companionId": None, "credentials": None, "ports": None, "generation": 0}


@pytest.mark.parametrize(("scenario", "order"), CASES)
def test_scenario(scenario, order, postgres, hermes, tmp_path):
    issues = run_scenario(scenario, order, fresh_state(postgres, tmp_path), hermes)
    assert issues == [], "\n".join(issues)


def test_hermes_registers_the_donor_tool_catalog_lite_serves(postgres, hermes, tmp_path):
    from conformance_runner import HostProcess

    host = HostProcess(fresh_state(postgres, tmp_path))
    try:
        hermes.attach(host.ready)
        host.request("pi_turn", {"say": "hello", "calls": [], "reply": "Hello.", "vars": {}, "key": "inventory-pi"})
        inventory = host.request("inventory")
        assert inventory["catalog"] and sorted(hermes.tool_names("operator")) == sorted(inventory["catalog"])
        assert set(inventory["offered"]) <= set(inventory["catalog"])
    finally:
        hermes.disconnect()
        host.close()
