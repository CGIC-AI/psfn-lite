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
    "internal_turns": None,
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
        ({"internal_turns": {"command": ["hermes", "chat"], "poll_wait_ms": 0, "run_timeout_seconds": 60}}, "{prompt_file}"),
    ],
)
def test_a_malformed_config_is_refused_by_field(change, message):
    with pytest.raises(ConfigError, match=message.replace("{", r"\{").replace("}", r"\}")):
        Config.parse({**VALID, **change})


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
