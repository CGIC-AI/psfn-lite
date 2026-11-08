"""Continuity conformance on the real plugin inside the pinned Hermes.

Every scenario of tests/conformance/scenarios this runner supports, in each
order it declares, against the conformance host process (the standalone
runtime over a throwaway Postgres), with Hermes as the Hermes surface; see
conformance_runner.py. Scenarios it cannot run say why when skipped.

Docker and Node are required, as for the TypeScript integration suites;
LITE_SKIP_DOCKER_TESTS=1 opts out explicitly and says so.
"""

import os

import pytest

from conformance_runner import HermesSurface, PostgresFixture, load_scenarios, orders_of, run_scenario, unsupported
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
    monkeypatch.delenv("PSFN_LITE_INTERNAL_JOB", raising=False)
    monkeypatch.delenv("PSFN_LITE_INTERNAL_HOST", raising=False)
    surface = HermesSurface(tmp_path, write_profile, CREDENTIAL_ENV, plugin_module, USER_NAMESPACE)
    yield surface
    surface.close()


def fresh_state(postgres, tmp_path) -> dict:
    base = tmp_path / "lite"
    base.mkdir()
    return {
        "databaseUrl": postgres.create(),
        "spareDatabaseUrl": postgres.create(),
        "base": str(base),
        "roots": None,
        "clockMs": 0,
        "credentials": None,
        "ports": None,
        "internalTurns": "harness",
        "generation": 0,
    }


@pytest.mark.parametrize(("scenario", "order"), CASES)
def test_scenario(scenario, order, postgres, hermes, tmp_path):
    why = unsupported(scenario)
    if why is not None:
        pytest.skip(why)
    issues = run_scenario(scenario, order, {**fresh_state(postgres, tmp_path), "internalTurns": scenario["internalTurns"]}, hermes)
    assert issues == [], "\n".join(issues)


def test_hermes_offers_the_full_inventory_the_pi_harness_offers(postgres, hermes, tmp_path):
    from conformance_runner import HostProcess

    host = HostProcess(fresh_state(postgres, tmp_path))
    try:
        hermes.attach(host.ready)
        inventory = host.request("inventory")
        host.request("pi_turn", {"say": "hello", "calls": [], "reply": "Hello.", "hang": False, "vars": {}, "key": "inventory-pi"})
        pi = host.request("pi_tools")
        listed = hermes.tool_names("operator")
        assert inventory and pi == inventory
        assert sorted(listed, key=lambda t: t["name"]) == sorted(inventory, key=lambda t: t["name"])
    finally:
        hermes.disconnect()
        host.close()
