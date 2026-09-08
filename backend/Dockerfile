# syntax=docker/dockerfile:1
#
# Backend image.
#
# Multi-stage so the runtime image carries no build tooling, and non-root by
# design (Section 22). Dependencies are installed from the lockfile only, so a
# build is reproducible and cannot silently pick up a newer transitive package.

# ---- Dependencies ----------------------------------------------------------
FROM node:22-alpine AS deps
WORKDIR /app

COPY package.json package-lock.json ./
COPY backend/package.json ./backend/
COPY frontend/package.json ./frontend/

# `npm ci` needs the workspace manifests present. Only the backend workspace's
# production dependencies are kept.
RUN npm ci --omit=dev --workspace @amnp/backend --include-workspace-root \
    && npm cache clean --force

# ---- Runtime ---------------------------------------------------------------
FROM node:22-alpine AS runtime

# dumb-init reaps zombies and forwards signals, so SIGTERM reaches Node and the
# graceful shutdown path actually runs.
RUN apk add --no-cache dumb-init curl

ENV NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NODE_OPTIONS="--max-old-space-size=768"

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY backend ./backend
COPY scripts ./scripts

# Run as an unprivileged user. The node image already provides uid/gid 1000.
RUN mkdir -p /app/data/exports \
    && chown -R node:node /app
USER node

EXPOSE 4000
EXPOSE 5005/udp

# The health endpoint reports the database as well as the process, so an
# unhealthy database marks the container unhealthy rather than silently
# serving a dashboard with no data behind it.
HEALTHCHECK --interval=20s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -fsS http://127.0.0.1:4000/api/health || exit 1

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "backend/src/index.js"]
