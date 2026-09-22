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
# SIGTERM that Swoop needs in order to finish its poll cycle cleanly.
RUN apk add --no-cache wget tini

COPY --from=prod-deps /app/node_modules ./node_modules
COPY package.json ./
COPY --from=backend-build /app/dist ./dist
COPY --from=frontend-build /app/web/dist ./web/dist

# Run unprivileged. The node image already provides uid/gid 1000 as `node`.
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node

VOLUME ["/app/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT:-3000}/health || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/server.js"]
