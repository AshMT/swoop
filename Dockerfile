FROM node:20-alpine AS base
WORKDIR /app

# Build dependencies for native addons (better-sqlite3)
RUN apk add --no-cache python3 make g++

# ─── Install backend deps ──────────────────────────────────────────────────────
FROM base AS backend-deps
COPY package*.json ./
RUN npm ci

# ─── Install frontend deps ─────────────────────────────────────────────────────
FROM base AS frontend-deps
COPY web/package*.json ./web/
RUN cd web && npm ci

# ─── Build frontend ────────────────────────────────────────────────────────────
FROM frontend-deps AS frontend-build
COPY web/ ./web/
RUN cd web && npm run build

# ─── Build backend ─────────────────────────────────────────────────────────────
FROM backend-deps AS backend-build
COPY tsconfig*.json ./
COPY src/ ./src/
RUN npm run build 2>/dev/null || npx tsc -p tsconfig.build.json

# ─── Production image ──────────────────────────────────────────────────────────
FROM node:20-alpine AS production
WORKDIR /app

RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=backend-build /app/dist ./dist
COPY --from=frontend-build /app/web/dist ./web/dist

RUN mkdir -p /app/data

EXPOSE 3000
CMD ["node", "dist/server.js"]
