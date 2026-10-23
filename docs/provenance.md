# Source provenance

PSFN Lite is derived from https://github.com/CGIC-AI/psfn-framework.

Initial inspected donor revision: `e6a9546051f4e92bf7218b133b4523ac53a797c0`.

Bootstrap copied artifacts:

| Lite path | Donor path | Treatment |
| --- | --- | --- |
| `LICENSE` | `LICENSE` | Unmodified inherited license text |
| `docs/framework-agent-contract.md` | `AGENTS.md` | Unmodified reference snapshot; not the active Lite operating contract |

The root AGENTS.md is adapted for Lite. The charter and architecture documents
record the requested derivative scope. No runtime source, data, dependencies,
deployment configuration or private evidence has been imported.

Every later extraction must record donor revision, source/test paths, retained
behavior and deliberate changes here or in a linked module provenance document.
Preserve applicable notices. Prefer reusing cohesive domain implementations and
tests over copying composition roots or introducing a dependency on the framework.

Hermes integration reference: https://github.com/NousResearch/hermes-agent.
No Hermes revision is selected or implementation copied yet. Pin the revision
used for the compatibility proof and record the actual plugin/MCP capabilities
tested before claiming support.
