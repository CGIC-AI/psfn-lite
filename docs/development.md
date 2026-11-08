# Development and validation contract

The repository is at bootstrap, with no product code or installed dependencies.
Beads contains the executable work plan. Do not mistake this document for a task tracker.

## Bootstrap commands

```bash
bd prime
bd ready --json
node scripts/install-hooks.mjs
```

New clones initialize local tracking using `bd init --stealth --shared-server
--prefix psfn-lite --skip-agents --skip-hooks --non-interactive` in environments
using the shared local Dolt service, then set `bd config set export.git-add false`.
Do not assume a Git clone contains the existing tracker. Obtain the configured
authoritative database connection or explicit backup/restore procedure before
creating a competing tracker on another machine. Never push Dolt without instruction.

The primary checkout stays on main. Work branches use external linked worktrees
at the operator-selected location. Tracked hooks live in `.githooks`; the bootstrap
hook rejects direct main pushes and permits remote checkpoint backup of branches.

## Required tooling before product extraction

Port the source project's applicable gate implementations with tests and provenance,
without importing its full dependency graph. Required capabilities are:

- Strict TypeScript build/typecheck, lint and focused tests; pinned toolchain and
  lockfile; Python checks for the Hermes bridge when that language is introduced.
- Module import/public-export constraints, dependency-cycle rejection and no core
  imports from harnesses/transports/storage implementations.
- Unused files/exports, duplicate type names/shapes, policy-literal/config ownership,
  and Bead-linked TODO/FIXME/HACK/XXX checks; reduction-only reviewed debt baselines.
- Public-suitable sanitation, external local privacy blocklist and untracked
  maintainer identity allowlist; secrets and runtime state never enter Git.
- Worktree-local dependency bootstrap with no shared mutable node_modules.
- `npm run hooks:install`, `npm run gate:pre-pr`, `npm run pr:publish` backed by
  real checks, exact committed-head/base attestation and guarded publication.
- CI `ci-required` verifies attestation and cheap PR policy, not duplicate broad
  local tests. No paid-review bot triggers by default.

Those npm commands are reserved workflow targets, not available bootstrap commands.
Do not claim them as passing until the tooling bead lands. Bootstrap branch
publication is parked until those requirements are implemented; checkpoint push
does not assert gate completion.

## Verification principles

Reuse behavior tests with the extracted source, and add tests at the new interfaces.
Prioritize privacy, author attribution, interruptions, crash/retry correctness,
state ownership, harness handover and module isolation. Exercise real entrypoints
and adapters where appropriate; no production in-memory fallback disguised as
durability. Scope expensive validation to actual risk and changed behavior.

Run focused checks during implementation. Fetch the base, commit a clean head,
run the complete local gate once, and publish through its wrapper. A coherent
out-of-budget change gets an explicit variance rather than filler. Return the PR
URL without polling unless asked. Merge with exact-head protection after required
checks pass. Close delivered implementation beads; track later live testing separately.
