# Development and validation contract

The product is Lite's host adapters over the versioned `@cgic/psfn-core` package
published from `CGIC-AI/psfn-framework` (see [architecture](architecture.md)).
Beads contains the executable work plan. Do not mistake this document for a
task tracker.

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
mise exec node@24.22.1 npm@11.17.0 -- npm run typecheck
mise exec node@24.22.1 npm@11.17.0 -- npm run lint
mise exec node@24.22.1 npm@11.17.0 -- npm test
```

The companion core is consumed from the pinned `@cgic/psfn-core` package (rather
than a vendored `packages/companion/` directory); its own unit and package-boundary
tests run in `CGIC-AI/psfn-framework` before release, and Lite validates all
host adapters, lifecycle/MCP/Garden integration suites, boundary rules, and
continuity conformance against the pinned package.

The donor Postgres-harness tests need Docker. Each run gets its own harness
profile and temp directory, and removes exactly its own containers. The temp
directory goes under `$TMPDIR` when it is set, else `/tmp`; every test temp file
lands there, so point `TMPDIR` at a short disk-backed path (for example
`TMPDIR=/var/tmp/lv`) when `/tmp` is a small tmpfs. Both vitest
configs cap the run at 16 forks (`maxWorkers`), the shared-workstation budget. Do
not raise it with `--maxWorkers`: uncapped runs lost forks there (see
[extraction](extraction.md)).

Lite's integration tests (`*.integration.test.ts`: lifecycle, standalone,
conformance) run inside `npx vitest run`
against a throwaway pinned pgvector container, so Docker is required. Without it
they fail. `LITE_SKIP_DOCKER_TESTS=1` skips them explicitly and prints that it did.
`tests/standalone/transformers-embeddings.integration.test.ts` starts the
donor's default embedding provider for real, so it downloads
`Xenova/all-MiniLM-L6-v2` (91,100,283 bytes) into its temporary data directory.
Set `LITE_TEST_TRANSFORMERS_CACHE` to a transformers.js cache directory that
already holds the model (a kept `<dataDir>/models/transformers`) to copy it in
instead.

Run focused checks during implementation. Fetch the base, commit a clean head,
run the complete local gate once, and publish through its wrapper. A coherent
out-of-budget change gets an explicit variance rather than filler. Return the PR
URL without polling unless asked. Merge with exact-head protection after required
checks pass. Close delivered implementation beads; track later live testing separately.

## Hermes plugin tests

`integrations/hermes` is Python. Its tests run in a project-local virtualenv
(`integrations/hermes/.venv`, gitignored) with [uv](https://docs.astral.sh/uv/).
Hermes itself is installed editable from a throwaway clone at a tested
revision. Two are tested (`HERMES_REVISIONS` in `psfn_lite/config.py`), and
the suite runs once against each:
`f0187332d13679e2ace74d1f0eb399eb91a90571` (Python 3.13, pins in
`requirements-test.txt`) and `2bd378ed1b8d6bf2192cb26e0a55ff3091e6bd19`
(Python 3.14, pins in `requirements-test-2bd378e.txt`). Never install into
an operator's Hermes checkout, `~/.hermes` profile or `hermes` binary. The
suite sets `HERMES_HOME` to a temporary directory before importing Hermes,
and it refuses to run unless the imported Hermes is a git checkout at a
tested revision. Every test dependency is pinned exactly.

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

For 2bd378e, use a second virtualenv outside the repository. A live Hermes
install at that revision can be the clone's source, read-only: clone it
(`git clone --no-hardlinks --no-checkout <live checkout> "$HERMES_CLONE"`),
never install into it or run anything inside it. The pins are Hermes's own
`uv.lock` (Hermes overrides a dependency there, so they install with
`--no-deps`), plus pytest:

```bash
HERMES_CLONE=/tmp/hermes-agent-2bd378e   # any disposable path
git clone --no-checkout https://github.com/NousResearch/hermes-agent.git "$HERMES_CLONE"
git -C "$HERMES_CLONE" checkout --detach 2bd378ed1b8d6bf2192cb26e0a55ff3091e6bd19
VENV=/tmp/psfn-hermes-2bd378e-venv        # any disposable path
uv venv --no-config --python 3.14 "$VENV"
uv pip install --no-config --no-deps --python "$VENV/bin/python" -r integrations/hermes/requirements-test-2bd378e.txt
uv pip install --no-config --no-deps --python "$VENV/bin/python" -e "$HERMES_CLONE"
cd integrations/hermes
mise exec node@24.22.1 npm@11.17.0 -- "$VENV/bin/python" -I -m pytest -q -p no:cacheprovider
```

`requirements-test-2bd378e.txt` is
`uv export --no-config --frozen --no-hashes --no-header --no-annotate --extra mcp --no-dev --no-emit-project --python 3.14`
run in the clone, followed by `iniconfig==2.3.1`, `pluggy==1.7.0` and
`pytest==8.4.2`.

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

`tests/test_e2e_lite.py` starts `tests/hermes/fixtures/lite-host.ts` with
`node --import tsx`. That is the conformance host (the standalone runtime
over the extracted companion core, with the MCP transport and the lifecycle
bridge on loopback) over a throwaway pgvector container. Before it reports
ready, a seed turn of the standalone writes a thread for the Hermes tests
to find. So the e2e tests need Docker, Node on `PATH` (hence `mise exec`)
and the repository's `node_modules`. As with the
TypeScript integration suites, `LITE_SKIP_DOCKER_TESTS=1` skips it explicitly. The
host also mounts the light Garden (`garden: true`), and the dashboard
backend tests reach it through Hermes's own dashboard plugin loader.

## Hermes Desktop half

The light Garden's Desktop half is TypeScript and React in
`integrations/hermes/desktop/src`. The root `tsconfig.json` (with
`"jsx": "react-jsx"`) and `eslint .` check it. It is built into one ESM file,
`integrations/hermes/psfn_lite/desktop/plugin.js`, and the built file is
committed:

```bash
mise exec node@24.22.1 npm@11.17.0 -- node integrations/hermes/desktop/build.mjs
```

Rebuild after every change to the source. `tests/desktop/bundle.test.ts`
rebuilds the file in memory and fails when the committed file differs. It
also checks what Desktop's runtime loader requires: only
`@hermes/plugin-sdk`, `react` and `react/jsx-runtime` are imported, there is
no JSX, and the id is the plugin's name. `tests/desktop/garden.test.ts`
renders the screens in jsdom against a stubbed plugin context. Vitest
aliases `@hermes/plugin-sdk` to `tests/support/hermes-plugin-sdk.ts`.
`tests/operator/garden.integration.test.ts` checks that every route the
screens call is served by the real Garden.

The build tool and React are pinned exactly as Hermes Desktop pins them at
2bd378e (`apps/desktop/package.json`): esbuild 0.28.2, react, react-dom and
@types/react 19.3.0, jsdom 29.1.1. Never install the built file, or a
`desktop/` folder, under `~/.hermes` from a test or a tool. Hermes Desktop
loads it from there (see `integrations/hermes/README.md`, "The light
Garden").

