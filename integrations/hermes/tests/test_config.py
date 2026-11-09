"""The profile configuration is strict: every field required, nothing unknown, no secret in the file."""

import pytest

from psfn_lite.config import Config, ConfigError

VALID = {
    "bridge_url": "http://127.0.0.1:7412/lifecycle/v1",
    "credential_env": "PSFN_LITE_TOKEN",
    "mcp_server": "psfn_lite",
    "senders": [{"platform": "cli", "sender_id": ""}],
    "timeout_seconds": 30,
    "max_context_chars": 9000,
    "automata": None,
}


def test_a_complete_config_parses():
    config = Config.parse(VALID)
    assert config.binds("cli", "") and not config.binds("telegram", "")
    assert config.tool_prefix == "mcp__psfn_lite__"


@pytest.mark.parametrize(
    "change, message",
    [
        ({"extra": 1}, "unknown fields: extra"),
        ({"bridge_url": "http://127.0.0.1:7412/mcp"}, "bridge_url"),
        ({"credential_env": "not a name"}, "credential_env"),
        ({"senders": []}, "senders"),
        ({"senders": [{"platform": "cron", "sender_id": ""}]}, "interactive"),
        ({"timeout_seconds": 0}, "timeout_seconds"),
        ({"internal_turns": None}, "unknown fields: internal_turns"),
        ({"automata": {}}, "automata is missing required fields: claim_limit"),
        ({"automata": {"claim_limit": 9}}, "claim_limit"),
        ({"automata": {"claim_limit": 2, "max_iterations": 250}}, "automata has unknown fields: max_iterations"),
    ],
)
def test_a_malformed_config_is_refused_by_field(change, message):
    with pytest.raises(ConfigError, match=message):
        Config.parse({**VALID, **change})


def test_hosted_automata_are_off_unless_configured():
    assert Config.parse(VALID).automata is None
    assert Config.parse({**VALID, "automata": {"claim_limit": 2}}).automata.claim_limit == 2
    values = dict(VALID)
    del values["automata"]
    with pytest.raises(ConfigError, match="missing required fields: automata"):
        Config.parse(values)


def test_a_missing_field_is_named():
    values = dict(VALID)
    del values["max_context_chars"]
    with pytest.raises(ConfigError, match="missing required fields: max_context_chars"):
        Config.parse(values)


def test_the_credential_comes_only_from_the_named_variable(monkeypatch):
    config = Config.parse(VALID)
    monkeypatch.delenv("PSFN_LITE_TOKEN", raising=False)
    with pytest.raises(ConfigError, match="PSFN_LITE_TOKEN"):
        config.credential()
    monkeypatch.setenv("PSFN_LITE_TOKEN", "short")
    with pytest.raises(ConfigError) as refused:
        config.credential()
    assert "short" not in str(refused.value)
    monkeypatch.setenv("PSFN_LITE_TOKEN", "z" * 40)
    assert config.credential() == "z" * 40
