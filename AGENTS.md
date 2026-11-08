# Agent Instructions

## Purpose and precedence

This is the operating contract for PSFN Lite. Current operator instructions win.
Runtime and configuration contracts win over stale prose. Read
`docs/charter.md`, `docs/architecture.md`, and `docs/development.md` for the
applicable product, module, and delivery contracts.

`docs/framework-agent-contract.md` is an unmodified provenance snapshot of the
source project's rules. It is reference material, not an additional instruction
file. Its full-framework runtime paths, deployment topology, and missing npm
commands do not apply here. Preserve its engineering rigor without importing
its product machinery. Do not silently weaken a quality requirement when
adapting its implementation.

## Implementation first

- Inspect the target, run `bd prime`, find or create and claim the bead, and
  verify the branch/worktree before the first edit.
- Read-only answers and reviews do not need beads unless tracking is requested.
- Use one implementer and focused validation for ordinary small changes.
  Parallelize only independent seams when it saves time after integration cost.
- Every concurrent writer owns a distinct branch and worktree. Never share a
  writable checkout between agents, even for different files.
- Stop optional process if setup consumes ten minutes or process consumes
  roughly a quarter of task time. State an actual blocker when necessary.
- Tracker priority does not automatically require extra agents or broad review.
- Review an assembled train at most once when its complexity or trust boundaries
  warrant it. Paid review is opt-in; never trigger Greptile without instructions.
- When asked to ship or stop reviewing, finish minimum safe validation and delivery.

## Beads

Use `bd` for durable work. No Markdown TODO trackers and no interactive `bd edit`.
Initialize a new workspace with `bd init --stealth`; use the shared local Dolt
server where configured, with a distinct `psfn-lite` database/prefix. Keep
`bd config get export.git-add` false. Never stage `.beads/`, `.dolt/`, exports,
credentials, or local connection metadata.

Search before creating. Each bead must contain why, concrete files/modules,
scope, non-goals, and independently checkable acceptance criteria. Use
`kind:<bug|feat|chore|design>` and `system:<system>` labels. Initial systems are
`memory`, `session`, `contacts`, `emotion`, `intention`, `identity`, `scheduler`,
`automata`, `persistence`, `integration`, `agent-tooling`, `testing`, and `docs`.
Link discovered work with `discovered-from:<id>` and use parent-child edges for epics.

```bash
bd prime
bd ready --json
bd search 'task terms' --json
bd show <id> --json
bd update <id> --claim --json
bd create 'Title' --description 'Why, files, scope and non-goals' \
  --acceptance 'Observable completion criteria' -t task -p 2 \
  -l kind:chore,system:agent-tooling --json
bd close <id> --reason 'Main commit or merged PR evidence' --json
bd dolt commit --json
```

Commit local Dolt changes. Do not `bd dolt push` unless explicitly requested.
Use `bd remember` for durable project memory, never ad hoc memory files.
Close implementation beads when their implementation is on main. Remaining
live/manual testing gets a separate testing bead before closure; never reopen
delivered implementation for a later defect. Close delivered implementation epics.

## Git and delivery

- Team-maintainer authority: commit coherent checkpoints and push every non-main
  work branch. Local-only work is not a saved handoff.
- Keep the primary checkout on main, synchronized with origin/main. Use linked
  worktrees at an operator-approved external path for all non-main work.
- Preserve unrelated changes. They block only overlapping or unsafe mutations.
- No direct main pushes. Use PRs, rebase merging for linear branches, merge
  commits for integration trains containing lane merges. Squash is disabled.
- Never manually rewrite or force-push a shared branch. Fetch the base before
  publication; rebase unpublished linear work or merge the base into a train.
  Only an exact-head attestation-aware publisher may lease-update rebased work.
- Install tracked hooks once per clone. Worktrees inherit the shared Git config.
  Never share mutable node_modules between worktrees. Pin dependencies exactly.
- Run focused tests and changed-file lint during implementation. Run the full
  local pre-PR gate once on the final clean committed head, then use its publisher.
- Merge only with a passing exact-head local-gate attestation and `ci-required`;
  guard the merge with `--match-head-commit <validated-sha>`.
- CI verifies the local attestation plus cheap host policy, identity and sanitation;
  it must not repeat the broad locally attested suites.
- Return the PR URL after publication. Do not poll or wait for CI unless requested.
- Aim for coherent trains: 800–2,500 changed lines, at most 25 files and 8 commits.
  These are guidance, not filler targets. Use `change-budget:exception` and a
  one-line reason when coherent work falls outside the window.
- Before handoff record branch, exact pushed SHA, validation and next action on
  the bead. Say implemented/checkpoint-pushed/gated/published as appropriate;
  reserve done for code on main with its bead closed.
- Delete branches/worktrees only after verifying preservation on main or a pushed
  integration branch. Unintegrated deletion, stash deletion, hard reset, checkout
  discard, and force-clean require explicit approval.

Bootstrap status: `node scripts/install-hooks.mjs` installs a main-push guard.
It is not a local-gate attestation. The first tooling bead must port and test the
full hook/gate/publisher/CI contract before product implementation or publication.
Until then, bootstrap work is checkpoint-pushed only. Do not invent passing
attestations, use no-op checks, or bypass the publication requirement.

## Module and implementation standards

1. Security, consent, privacy and policy fail closed. Unknown owner, provider,
   capability, confirmation, or authorization data rejects.
2. Do not swallow errors or fabricate healthy state, successful actions, speech,
   consent, emotion, memories, or authorship. Preserve meaningful failure evidence.
3. Reuse source algorithms, contracts and behavior tests where useful. Record the
   donor commit and paths. Do not wholesale import framework composition roots.
4. Dependencies point inward: harnesses/transports/storage implement core-owned
   interfaces. Core must not import Pi, Hermes, MCP, concrete storage, Gateway,
   channels, UI, or provider credentials. Internal domain modules stay separate.
5. One owner per state and operation. MCP and native integrations call the same
   application services; they do not implement separate policy or memory logic.
6. Do not create god files, generic service locators, global runtime configuration,
   or an ever-growing universal core-options object. Enforce import boundaries.
7. Prefer explicit narrow interfaces and shared guards such as `isRecord`.
   Do not expose concrete storage classes through public domain contracts.
8. New runtime code must be reachable from a real entrypoint or registry.
9. No compatibility shims, silent fallback, or legacy execution path unless an
   explicit migration contract gives validation and removal criteria.
10. Pin dependencies, images and fetched artifacts exactly. No latest tags,
    floating installers, branch-pinned dependencies, or unpinned npx commands.
11. Mutable policy belongs to versioned owner configuration with validation and
    inspection. Keep secrets separate. New settings require contract tests.
12. Unused exports/files, duplicate types, hardcoded policy and unowned source
    TODO/FIXME/HACK/XXX comments must be checked. Any debt baseline is reviewed,
    reduction-only and never grown to silence a failure. Source work comments
    name their owning Bead in parentheses.
13. Test observable behavior, trust boundaries, crash recovery and module seams.
    Do not add tests that merely restate implementation. Register integration
    timeout overrides; measure first and preserve at least 2x headroom.

## Privacy and operations

Private Git visibility does not make Git a secret store. Track only material
suitable for public distribution: no real conversations, companion state,
private incidents, tokens, keys, runtime data, databases, logs, backup sets,
kubeconfigs, personal paths or deployment topology.

Live deployment configuration remains external. Obtain its location explicitly
before any live mutation. Never infer topology. Use invented identities,
temporary paths and reserved documentation addresses in examples and tests.
Sanitation inputs and maintainer identity allowlists remain untracked local
configuration, not committed personal-value lists.

Workspace files are distinct from runtime state. The eventual runtime must
reject overlapping workspace/data roots. Host tools receive scoped access,
never implicit access to companion-private persistence or raw credentials.

## Session close

Commit and push every work branch; record exact remote evidence and blockers;
close delivered implementation work; commit Beads state; report validation,
remaining risks and open beads. Never report planned gates as executed.
