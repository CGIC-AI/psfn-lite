# The standalone host (apps/standalone) as a container image. tsx runs the
# TypeScript sources, exactly as `npm run standalone` does, so the image holds
# the full install (tsx is a devDependency) and no build step.
FROM node:24.22.1-bookworm-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c

# ripgrep: the companion's session search runs `rg` (core/tools/session-search.ts).
RUN apt-get update \
  && apt-get install --yes --no-install-recommends ripgrep=13.0.0-4+b2 \
  && rm -rf /var/lib/apt/lists/*

# package.json pins npm exactly and .npmrc sets engine-strict.
RUN npm install --global --no-audit --no-fund npm@11.17.0

WORKDIR /opt/psfn-lite
COPY package.json package-lock.json .npmrc ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json ./
COPY apps ./apps
COPY packages ./packages

# The data and workspace roots, owned by the unprivileged user so that named
# volumes mounted there start out writable.
# data/models is its own directory so that a volume shared between several
# companions' containers can be mounted over it (the local model cache).
RUN mkdir -p /var/lib/psfn-lite/data/models /var/lib/psfn-lite/workspace \
  && chown -R node:node /var/lib/psfn-lite
USER node

ENTRYPOINT ["node", "--import", "tsx", "apps/standalone/src/main.ts"]
CMD ["serve", "--config", "/etc/psfn-lite/lite.json"]
