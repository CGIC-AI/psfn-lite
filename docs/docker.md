# Running with Docker Compose

`compose.yaml` runs one companion: PostgreSQL with pgvector (`postgres`) and
the standalone host in `serve` mode (`psfn`). A one-shot `psfn-init` service
runs the CLI's `init` first, which seeds the companion's owner files into the
data volume and keeps the ones already there.

The image (`Dockerfile`) runs the TypeScript sources with tsx, as
`npm run standalone` does. The Node image, the pgvector image (the one the
integration tests use), npm and ripgrep are pinned exactly.

## Setup

1. Secrets. Copy `.env.example` to `.env` and fill in every value; the file
   names a command that generates each one. `.env` is gitignored. Compose
   builds `PSFN_LITE_DATABASE_URL` from `POSTGRES_PASSWORD` itself.
2. Configuration. The `psfn` container reads `/etc/psfn-lite/lite.json` and
   the character card beside it from a host directory mounted read-only:
   `./runtime` by default (gitignored), or the directory `PSFN_LITE_CONFIG_DIR`
   names in `.env`.

   ```bash
   mkdir -p runtime
   cp docker/lite.example.json runtime/lite.json
   cp docker/character-card.example.json runtime/character-card.json
   ```

   Edit both: give the companion its own `companionId` (`uuidgen`), your
   operator name, your model and your character card. Keep `dataDir`,
   `workspaceDir`, `characterCardPath` and `postgres.urlEnv` as they are: they
   are the paths and the variable the compose file provides. The container
   runs as uid 1000, so that user must be able to read the files.
3. Start.

   ```bash
   docker compose up --build -d
   docker compose logs -f psfn
   ```

   The first start downloads the default embedding model (about 91 MB) into
   the data volume, so it needs network access. The service is up when the
   log prints its transports, for example `garden http://0.0.0.0:8789`.

A configuration or secret the host refuses is named in the `psfn` log and the
container exits; nothing falls back to a default.

## Transports

The compose file publishes three ports on the host's loopback only. A
transport listens when `lite.json` configures it.

| Port | Config block | Used by |
| --- | --- | --- |
| 8787 | `mcp` | the Hermes plugin's MCP client |
| 8788 | `lifecycle` | the Hermes plugin's lifecycle bridge |
| 8789 | `garden` | the light Garden (the Hermes dashboard proxy) |

Inside the container a transport must bind `0.0.0.0` to be reachable through
the published port, and each transport refuses a non-loopback bind unless
`allowedHosts` lists the Host names it serves. So every block uses:

```json
"host": "0.0.0.0", "port": 8789, "allowedHosts": ["127.0.0.1", "localhost"]
```

The example config enables only the Garden. Check it with the credential
from `.env`:

```bash
curl -H "Authorization: Bearer $PSFN_LITE_GARDEN_TOKEN" http://127.0.0.1:8789/api/lite/overview
```

For Hermes, add `mcp` and `lifecycle` blocks as
[the Hermes plugin README](../integrations/hermes/README.md) describes, on
ports 8787 and 8788, and add each binding's credential variable to `.env`.
A Hermes on the same machine then uses `http://127.0.0.1:8787/mcp` and the
lifecycle URL on 8788.

## State

Three named volumes hold the state: `postgres-data` (the database),
`psfn-data` (owner files, file stores, the model cache) and `psfn-workspace`
(the companion's journal and personal files). `docker compose down` keeps
them. `docker compose down -v` deletes the companion.

`docker compose stop` sends `psfn` SIGINT, the signal on which `serve` closes
the runtime.
