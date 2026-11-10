# Running with Docker Compose

`compose.yaml` runs one companion: PostgreSQL with pgvector (`postgres`) and
the standalone host in `serve` mode (`psfn`), and optionally Hermes
([below](#hermes-in-the-project)). A one-shot `psfn-init` service
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
   `./runtime/lite` by default (gitignored), or the directory
   `PSFN_LITE_CONFIG_DIR` names in `.env`.

   ```bash
   mkdir -p runtime/lite
   cp docker/lite.example.json runtime/lite/lite.json
   cp docker/character-card.example.json runtime/lite/character-card.json
   ```

   Edit both: give the companion its own `companionId` (`uuidgen`), your
   operator name, your model and your character card. Keep `dataDir`,
   `workspaceDir`, `characterCardPath` and `postgres.urlEnv` as they are: they
   are the paths and the variable the compose file provides. The container
   runs as uid 1000, so that user must be able to read the files.

   The card is a `chara_card_v2` JSON document with a non-empty `name` and
   `personality`. A PNG card carries the same document, base64-encoded, in
   its `chara` text chunk; extract it to JSON first.

   For a model the Pi catalog does not list (a self-hosted OpenAI-compatible
   server), give the model block an `endpoint`. `provider` is then your own
   name for the endpoint, never a catalog provider's, and `contextWindow` is
   the served model's context length. With `apiKeyEnv` null the endpoint is
   keyless and receives a placeholder bearer:

   ```json
   "model": {
     "provider": "house-server", "modelId": "served-model", "apiKeyEnv": null, "maxOutputTokens": 4096,
     "endpoint": { "baseUrl": "http://192.0.2.10:8000/v1", "contextWindow": 32768 }
   }
   ```
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

A Hermes on the same machine, outside this project, uses
`http://127.0.0.1:8787/mcp` and the lifecycle URL on 8788 once `lite.json`
has `mcp` and `lifecycle` blocks
([the Hermes plugin README](../integrations/hermes/README.md)).

## Hermes in the project

`docker compose --profile hermes up -d` also runs Hermes (`hermes`), as a
gateway with the `psfn_lite` plugin, and a one-shot `psfn-ready` that holds
Hermes back until Lite listens. The image is Hermes release v0.23.0 pinned
by digest; its install stamp names commit
`2bd378ed1b8d6bf2192cb26e0a55ff3091e6bd19`, a revision the plugin is tested
against. Hermes reaches Lite by its service name, so the three transports
list `psfn` in `allowedHosts`.

The Hermes home is a host directory, `./runtime/hermes` by default or the one
`PSFN_LITE_HERMES_HOME` names. Prepare it before the first start; this is the
plugin README's install, with the compose addresses:

```bash
mkdir -p runtime/hermes
openssl rand -hex 16 > runtime/hermes/install_id
python3 -I integrations/hermes/install_plugin.py runtime/hermes
cp docker/hermes/config.example.yaml runtime/hermes/config.yaml
cp docker/hermes/psfn-lite.example.json runtime/hermes/psfn-lite.json
cp docker/hermes/lite.example.json runtime/lite/lite.json
```

Then:

- `runtime/lite/lite.json`: set `lifecycle.hermesInstallId` to the content of
  `install_id`, and the companion id, operator and model as above.
- `.env`: set `PSFN_LITE_TOKEN` (`openssl rand -hex 32`), and `HERMES_UID`
  and `HERMES_GID` to the user that owns the Hermes home (`id -u`, `id -g`).
- `runtime/hermes/.env` (owner-only): the same `PSFN_LITE_TOKEN=...` line.
  Hermes reads the credential from its profile's `.env`, never from the
  container environment.
- `runtime/hermes/config.yaml`: your model.
- `runtime/hermes/psfn-lite.json`: set the sender to `uid:<HERMES_UID>`. The
  gateway accepts local connections from that user only.

Talk to the companion through Hermes:

```bash
docker compose exec hermes hermes chat
```

Hermes seeds its own files into a new home on first start, among them a
`SOUL.md` that tells the model it is Hermes Agent. It is Hermes's persona
file, not Lite's, and it is sent beside the companion's context; edit it if
the two should not compete.

The Hermes dashboard, and so the light Garden's dashboard backend, is not
started. The image starts it when `HERMES_DASHBOARD` is set, and it refuses
a non-loopback bind without an auth provider.

## State

Three named volumes hold the state: `postgres-data` (the database),
`psfn-data` (owner files, file stores, the model cache) and `psfn-workspace`
(the companion's journal and personal files). `docker compose down` keeps
them. `docker compose down -v` deletes the companion.

`docker compose stop` sends `psfn` SIGINT, the signal on which `serve` closes
the runtime.
