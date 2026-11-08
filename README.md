# PSFN Lite

A modular persistent companion core, derived from [PSFN Framework](https://github.com/CGIC-AI/psfn-framework), with a native Pi harness and a planned Hermes integration.

Status: bootstrap. `packages/core` defines the domain interfaces, tool inventory and
application boundary (ingress, turn lifecycle, dispatch); no storage, harness or
companion runtime is implemented yet. See [the tool inventory](docs/tool-inventory.md).

The core owns one companion's identity and continuity: constitution, persona,
values, North Star, sessions, contacts, privacy, core and long-term memory,
episodes, journals, emotion, self-model, concerns, reflection, free time,
automata, and bounded subagents. A replaceable harness provides conversation
and practical execution without becoming another owner of the companion's self.

Hermes integration must expose the companion's internal capabilities, not only
a small subset of memory search. MCP supplies a transport for governed tools;
a native Hermes adapter supplies identity/context and lifecycle integration.
Both use the same application operations and authorization rules.

No PSFN Gateway, satellites, fleet, shared worlds, shards, or charge subsystem
is required. Host control planes own credentials, approvals, execution isolation,
and delivery; the core retains privacy, authorship, and continuity authority.

- [Agent operating contract](AGENTS.md)
- [Architecture and extraction decisions](docs/architecture.md)
- [Lite charter](docs/charter.md)
- [Development and validation contract](docs/development.md)
- [Source provenance](docs/provenance.md)
- [Continuity conformance](docs/conformance.md)
- [Measured footprint](docs/footprint.md)
- [Donor extraction record](docs/extraction.md)

Work is tracked in Beads, not Markdown task lists. In this checkout run
`bd prime` and `bd ready --json`. New clones require local Beads setup; Git
intentionally contains no tracker database or exports.

The bootstrap hook protects main from direct pushes. The complete local-gate
and publication workflow is a tracked prerequisite to product implementation;
this bootstrap does not claim those gates are already ported.

The inherited license text is retained in [LICENSE](LICENSE).
