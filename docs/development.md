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

## Validation commands

```bash
mise exec node@24.22.1 npm@11.17.0 -- npx tsc --noEmit -p tsconfig.json
mise exec node@24.22.1 npm@11.17.0 -- npx tsc --noEmit -p packages/companion/tsconfig.json
mise exec node@24.22.1 npm@11.17.0 -- npx eslint .
mise exec node@24.22.1 npm@11.17.0 -- npx vitest run
```

`packages/companion` is the extracted donor core (see [extraction](extraction.md)).
It keeps the donor's compiler options in its own `tsconfig.json`, so the root
typecheck and eslint exclude it and the second command typechecks it. `npx vitest
run` runs two projects: `lite` and `companion` (the extracted donor tests, with the
donor's test settings). To check the companion tests against the donor baseline:

```bash
mise exec node@24.22.1 npm@11.17.0 -- npx vitest run --project companion --reporter=json --outputFile=/tmp/companion-report.json
mise exec node@24.22.1 -- node packages/companion/extraction/compare-baseline.mjs /tmp/companion-report.json
```

The donor Postgres-harness tests need Docker. Each run gets its own harness
profile and temp directory, and removes exactly its own containers.

Adapter integration tests (`*.integration.test.ts`) run inside `npx vitest run`
against a throwaway pinned pgvector container, so Docker is required. Without it
they fail. `LITE_SKIP_DOCKER_TESTS=1` skips them explicitly and prints that it did.

Run focused checks during implementation. Fetch the base, commit a clean head,
run the complete local gate once, and publish through its wrapper. A coherent
out-of-budget change gets an explicit variance rather than filler. Return the PR
URL without polling unless asked. Merge with exact-head protection after required
checks pass. Close delivered implementation beads; track later live testing separately.

## Hermes plugin tests

`integrations/hermes` is Python. Its tests run in a project-local virtualenv
(`integrations/hermes/.venv`, gitignored) with [uv](https://docs.astral.sh/uv/).
Hermes itself is installed editable from a throwaway clone at the tested
revision, `f0187332d13679e2ace74d1f0eb399eb91a90571`. Never install into an
operator's Hermes checkout, `~/.hermes` profile or `hermes` binary. The suite
sets `HERMES_HOME` to a temporary directory before importing Hermes, and it
refuses to run unless the imported Hermes is a git checkout at that revision.
Every test dependency is pinned exactly in `requirements-test.txt`.

```bash
HERMES_CLONE=/tmp/hermes-agent-f0187332   # any disposable path
git clone --no-checkout https://github.com/NousResearch/hermes-agent.git "$HERMES_CLONE"
git -C "$HERMES_CLONE" checkout --detach f0187332d13679e2ace74d1f0eb399eb91a90571
cd integrations/hermes
uv venv --no-config --python 3.13 .venv
uv pip install --no-config --python .venv/bin/python -r requirements-test.txt
uv pip install --no-config --python .venv/bin/python --no-deps -e "$HERMES_CLONE"
mise exec node@24.22.1 npm@11.17.0 -- .venv/bin/python -I -m pytest -q
```

Hermes's `setup.py` refuses to build a wheel, so it cannot be a locked uv git
dependency; hence the editable install with `--no-deps`. `--no-config` keeps
user-level uv indexes out of resolution. The pins were compiled from Hermes's
own `pyproject.toml` at the tested revision, with its `mcp` extra plus
pytest. To refresh them after moving the tested revision:

```bash
echo 'pytest==8.4.2' > /tmp/psfn-test-extra.in
uv pip compile --no-config "$HERMES_CLONE/pyproject.toml" /tmp/psfn-test-extra.in \
  --extra mcp --python-version 3.13 --no-header --no-annotate -o requirements-test.txt
```

`tests/test_conformance.py` runs the continuity conformance scenarios
(`tests/conformance/scenarios`) on the real plugin, against the same
conformance host process the TypeScript runner drives. It needs the same
Docker, Node and `node_modules`. See [conformance](conformance.md).

`tests/test_e2e_lite.py` starts `tests/hermes/fixtures/lite-host.ts` (the
standalone runtime over a throwaway pgvector container, with the MCP
transport and the lifecycle bridge on loopback), so it needs Docker, Node on
`PATH` (hence `mise exec`) and the repository's `node_modules`. As with the
TypeScript integration suites, `LITE_SKIP_DOCKER_TESTS=1` skips it explicitly.

