# PSFN Lite

A persistent companion core you can embed, extracted from
[PSFN Framework](https://github.com/CGIC-AI/psfn-framework), with a standalone
host on Pi and a native Hermes integration.

The companion is the donor's own core, extracted path-preserving into
`packages/companion` from `psfn-framework` at
`e6a9546051f4e92bf7218b133b4523ac53a797c0`. Only the recorded seam cuts
were made ([extraction record](docs/extraction.md)), and the extracted donor
tests reproduce the donor baseline, less the recorded deletions of tests of
cut scaffolding. It owns one companion's identity and
continuity: prompt layers and persona, values and North Star, sessions,
contacts and trust, memory, episodes, journals, emotion and self-model,
concerns, scheduler and free time, letters, and bounded subagents.

Around it, Lite has host adapters only:

- `apps/standalone`: a thin host over `startCompanionRuntime`. A validated
  config document and a CLI (`init`, `once`, `chat`, `serve`) run the
  companion on a Pi model over PostgreSQL with pgvector. Embeddings use the
  donor's own providers: by default `transformers`, in process and without
  an API key (`Xenova/all-MiniLM-L6-v2`, 384 dimensions; the first start
  downloads about 91 MB into `<dataDir>/models/transformers`), or `ollama`
  or an `api` endpoint named in the config's `embedding` block.
- `packages/mcp`: the donor tool catalog over MCP. The caller is bound
  from the transport credential, never from tool arguments.
- `packages/lifecycle`: host-driven turns for a host with its own model
  loop. The donor assembles the context, runs every tool call and archives
  the turn, and the host supplies the model's answers.
- `packages/conversation`: the operator's own conversation over HTTP, for
  a host that carries their words to the companion (voice, chat bridges).
  The companion runs each turn herself.
- `packages/pi`: the Pi model runtime, and the adapter for a host that
  supplies its own embedding port.
- `integrations/hermes`: the Hermes plugin, which makes every root Hermes
  turn a host-driven Lite turn.

No PSFN Gateway, satellites, fleet, shared worlds, shards, charge, wiki,
skills, Discord, CogSec intake or Garden is included. Host control planes
own credentials, approvals, execution isolation, practical tools and
delivery. The companion keeps privacy, authorship and continuity authority.

- [Agent operating contract](AGENTS.md)
- [Architecture](docs/architecture.md)
- [Lite charter](docs/charter.md)
- [Development and validation](docs/development.md)
- [Running with Docker Compose](docs/docker.md)
- [Source provenance](docs/provenance.md)
- [Companion tool inventory](docs/tool-inventory.md)
- [Continuity conformance](docs/conformance.md)
- [Measured footprint](docs/footprint.md)
- [Donor extraction record](docs/extraction.md)
- [Hermes plugin](integrations/hermes/README.md)

Work is tracked in Beads, not Markdown task lists. In this checkout run
`bd prime` and `bd ready --json`. New clones require local Beads setup; Git
intentionally contains no tracker database or exports.

The bootstrap hook protects main from direct pushes.

The inherited license text is retained in [LICENSE](LICENSE).
