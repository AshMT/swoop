# Contributing to Swoop

## Getting set up

Requires Node.js 20 or newer.

```bash
npm install
npm install --prefix web
cp .env.example .env
```

In development, `ENCRYPTION_KEY` and `JWT_SECRET` are optional — Swoop generates a throwaway JWT secret and skips credential encryption, warning you that it has. In production both are mandatory and it refuses to start without them.

```bash
npm run dev       # API on :3000, hot reload
npm run dev:web   # Vite dev server on :5173, proxying /api to :3000
```

## Before you open a pull request

```bash
npm run check     # lint + typecheck + tests
```

CI runs the same thing, plus a build and a smoke test that boots the production server. A pull request that fails `npm run check` will fail CI.

## Layout

```
src/
  config.ts              Validated configuration. Refuses to boot on bad input
  version.ts             Reads the version from package.json
  server.ts              Express wiring, static hosting, graceful shutdown
  db/
    schema.ts            Drizzle schema — the source of truth for row types
    migrations.ts        Forward-only numbered migrations
    index.ts             Lazy connection, WAL, checkpoint on close
  domain/
    classifications.ts   The canonical action list. Everything derives from it
  lib/
    logger.ts            Levelled logger with secret redaction
    html.ts              HTML to text for ticket bodies
    json-extract.ts      Pulls JSON out of messy model output
  middleware/
    auth.ts              JWT signing and verification
    security.ts          Headers, rate limiting, access log, error handler
  prompts/
    system.ts            The classifier prompt
  routes/                HTTP layer. Validation with zod, no business logic
  services/
    poller.ts            The engine: schedule, dedup, retry, write-back
    ai.ts                Provider call, validation, policy
    metrics.ts           Calibration report
    matching.ts          Ticket to client resolution
    note-format.ts       The internal note
    crypto.ts            AES-256-GCM envelope with scrypt KDF
    psa/
      capabilities.ts    GraphQL schema probe
      superops.ts        Adaptive client built from the probe
      factory.ts         Builds a client for a tenant, caches the probe
web/src/                 React SPA
tests/                   Vitest suites
```

## Conventions

**The action list lives in one place.** `src/domain/classifications.ts` feeds the prompt, the response validator, the API, and the UI dropdowns. Adding an action type is a one-line change there.

**Routes validate, services decide.** Route handlers parse input with zod and call a service. Business logic that belongs in a service should not end up in a handler.

**Errors say what to do.** Compare:

```
GraphQL Error (Code: 400): {"response":{"error":"","status":400,...
```

against

```
SuperOps rejected the request (HTTP 400). This is usually an invalid or revoked
API token, or a subdomain that does not match the token. Check the credentials
for "mighty.it" in Settings.
```

The second one is the standard. An error an operator cannot act on is a bug.

**Never invent PSA field names.** If you need a field Swoop does not read yet, add it to the candidate list in `capabilities.ts` and let the probe find it. Hardcoding a guess is what this design exists to prevent.

**A failure must be visible in the UI.** Anything that can go wrong should reach `/api/system/status` or an action log row, not just the container logs.

## Migrations

Migrations are forward-only and recorded in `schema_migrations`. Append a new entry to the `migrations` array in `src/db/migrations.ts`; never edit a released one, because installed databases have already recorded its id. Each migration runs in a transaction, so a failure leaves the database on the previous version.

Use `addColumnIfMissing` rather than a bare `ALTER TABLE`. If you need to change a primary key, SQLite requires rebuilding the table — see `004_processed_tickets_tenant_scoped_pk` for the pattern, and copy the data.

## Tests

```bash
npm run test               # once
npm run test:watch         # watch
npm run test:coverage      # with coverage
npx vitest run tests/crypto.test.ts
```

Suites share one in-memory database, so `fileParallelism` is off.

What is worth testing:

- **Pure logic** — parsing, matching, formatting, the metrics maths. Cheap and catches real bugs.
- **The schema probe.** `tests/fixtures/superops-schema.ts` builds fake schemas in the shapes this integration has actually encountered. If you touch `capabilities.ts`, add the shape you are handling as a fixture option.
- **Messy model output.** `tests/json-extract.test.ts` and `tests/classification.test.ts` assert against reasoning traces, fences, truncation and hallucinated entities. A new failure mode you find in the wild belongs here.
- **The API surface**, via supertest, especially anything that must stay authenticated.

When you fix a bug, add the test that would have caught it, with a comment saying what went wrong. Several tests in this repo carry those notes and they are the useful ones.

## Working against a mock PSA

`SUPEROPS_API_URL` overrides the endpoint, so you can develop the full poll path without real credentials — point it at a local server that answers the introspection queries and `getTicketList`. The same variable is the escape hatch for self-hosters behind an egress proxy.

## Reporting a security issue

See [SECURITY.md](SECURITY.md). Please do not open a public issue for a vulnerability.
