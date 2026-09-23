# syntax=docker/dockerfile:1

# ─── Backend dependencies ──────────────────────────────────────────────────────
# better-sqlite3 ships prebuilt binaries for common platforms but falls back to
# compiling, so the build toolchain is needed here — and only here.
FROM node:20-alpine AS backend-deps
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package*.json ./
RUN npm ci

# ─── Build the backend ─────────────────────────────────────────────────────────
FROM backend-deps AS backend-build
COPY tsconfig*.json ./
COPY src/ ./src/
RUN npm run build:server

# ─── Build the frontend ────────────────────────────────────────────────────────
FROM node:20-alpine AS frontend-build
WORKDIR /app/web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# ─── Production dependencies only ──────────────────────────────────────────────
FROM node:20-alpine AS prod-deps
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ─── Runtime ───────────────────────────────────────────────────────────────────
FROM node:20-alpine AS production
WORKDIR /app

ENV NODE_ENV=production
# wget serves the container healthcheck; tini reaps zombies and forwards the
# SIGTERM Swoop needs to finish its poll cycle cleanly; su-exec lets the
# entrypoint drop from root to PUID:PGID after fixing data-folder ownership.
RUN apk add --no-cache wget tini su-exec

COPY --from=prod-deps /app/node_modules ./node_modules
COPY package.json ./
COPY --from=backend-build /app/dist ./dist
COPY --from=frontend-build /app/web/dist ./web/dist
COPY docker/entrypoint.sh /usr/local/bin/swoop-entrypoint
RUN chmod 755 /usr/local/bin/swoop-entrypoint && mkdir -p /app/data

# PUID/PGID select the user the app runs as. 1000:1000 is the image's `node`
# user; Unraid users typically set 99:100. The entrypoint starts as root only
# to fix /app/data ownership, then drops to this user before starting Swoop.
ENV PUID=1000 PGID=1000

VOLUME ["/app/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT:-3000}/health || exit 1

ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/swoop-entrypoint"]
CMD ["node", "dist/server.js"]
