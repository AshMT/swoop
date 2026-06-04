# Swoop — TODO

> Last updated: 2026-06-04
> Pick this up from the top. Items are ordered by priority.

---

## Immediate blockers (must do before Phase 1 is usable)

### 1. Make GHCR image public
The Docker image has been built and pushed but is private. Without this, `docker pull ghcr.io/ashmt/swoop:latest` returns a 403.

**Steps:**
1. Go to https://github.com/ashmt?tab=packages
2. Click **swoop**
3. Click **Package settings** (bottom right of the page)
4. Scroll to **Danger Zone** → **Change package visibility** → select **Public**
5. Confirm

After this, anyone can `docker pull ghcr.io/ashmt/swoop:latest` without logging in.

---

### 2. Verify SuperOps GraphQL field names
The queries in `src/services/psa/superops.ts` use estimated field names. They **will almost certainly fail** against the real SuperOps API. This is the #1 thing to fix before running Swoop against a real SuperOps instance.

**Steps:**
1. Get a SuperOps API token from: SuperOps → Settings → My Profile → API Token
2. Run this against the API to introspect the schema:
   ```bash
   curl -X POST https://YOURSUBDOMAIN.superops.ai/graphql \
     -H "Authorization: Bearer YOUR_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"query": "{ __schema { queryType { fields { name } } } }"}'
   ```
3. Check the actual field names for tickets against what's in `src/services/psa/superops.ts`
4. Key fields to verify:
   - Ticket body field name (`description`? `ticketBody`? `details`?)
   - Requester email field (`requesterEmail`? `requester { email }`?)
   - Company ID field (`companyId`? `clientId`? `company { id }`?)
   - The `addTicketNote` mutation name and parameters
5. Update `src/services/psa/superops.ts` to match

---

### 3. First production deployment
Once the above two are done:

```bash
# On your server:
git clone https://github.com/AshMT/swoop.git
cd swoop
cp .env.example .env
# Edit .env — fill in ENCRYPTION_KEY (32 chars), JWT_SECRET (long random string)
# AI vars are optional if configured via setup wizard

docker compose -f docker-compose.simple.yml up -d
# Open http://your-server:3000
# Complete the setup wizard
```

Or if the image is now public:
```bash
SWOOP_IMAGE=ghcr.io/ashmt/swoop:latest docker compose -f docker-compose.simple.yml up -d
```

---

## Phase 1 validation (after deployment)

- [ ] Add MightyIT's first real client (enable automation for one client only to start)
- [ ] Let it run for 48 hours, check the dashboard action logs
- [ ] Review 10+ classifications — are they correct?
- [ ] Check SuperOps — are internal notes appearing on the right tickets?
- [ ] Note any recurring misclassifications and adjust `src/prompts/system.ts`
- [ ] Enable a second client once confident in accuracy
- [ ] Run for 1 week without crashes = Phase 1 validated

---

## CI/CD

- [x] GitHub Actions workflow at `.github/workflows/docker.yml`
- [x] Triggers on push to `main` and `claude/swoop-phase-1-build-PRp7n`
- [x] Builds `linux/amd64` + `linux/arm64`
- [x] Pushes to `ghcr.io/ashmt/swoop:latest` and `sha-<short>`
- [x] Layer cache using GitHub Actions cache
- [ ] GHCR package visibility set to public *(manual step — see item #1 above)*
- [ ] Merge Phase 1 branch to `main` once validated

### To trigger a new build manually
Go to: https://github.com/AshMT/swoop/actions → **Build & Push Docker Image** → **Run workflow**

---

## Code TODOs (before Phase 2)

- [ ] **SuperOps field names** — verify and fix `src/services/psa/superops.ts` (see blocker #2)
- [ ] **SuperOps company list endpoint** — add a query to fetch all companies from SuperOps so users can pick from a dropdown in the "Add client" UI instead of typing an ID manually
- [ ] **Error surfacing** — polling errors are logged to console but not visible in the dashboard; add an error state UI for "last poll failed"
- [ ] **Prompt tuning** — after Phase 1 calibration, consider per-client prompt overrides
- [ ] **Node.js action deprecation warning** — GitHub Actions warned that `actions/checkout@v4`, `docker/build-push-action@v5` etc. will require Node 24 from June 16 2026; upgrade these action versions in `.github/workflows/docker.yml`

---

## Phase 2 prep (don't start until Phase 1 is validated)

These are the additions needed for Phase 2. See `PLAN.md` for full detail.

- [ ] CIPP integration (`src/services/cipp.ts`)
- [ ] Approval UI (Approve / Reject buttons on Dashboard action rows)
- [ ] Execution engine (`src/services/executor.ts`)
- [ ] `POST /api/actions/:id/approve` and `reject` routes
- [ ] FOLLOW_UP comment polling (re-classify after requester replies)
- [ ] Schema migrations for approval + execution log tables
- [ ] Sensitivity ratchet enforcement (high-sensitivity always needs approval)
- [ ] Tenant settings UI for CIPP config

---

## Environment variables reference

| Variable | Where set | Notes |
|---|---|---|
| `ENCRYPTION_KEY` | `.env` | **Required.** 32 chars. Generate: `openssl rand -hex 16` |
| `JWT_SECRET` | `.env` | **Required.** Long random string. Generate: `openssl rand -hex 32` |
| `SQLITE_PATH` | `.env` or Docker volume | Default: `./data/swoop.db` |
| `AI_BASE_URL` | `.env` or setup wizard | AI provider base URL |
| `AI_API_KEY` | `.env` or setup wizard | AI provider key |
| `AI_MODEL` | `.env` or setup wizard | Model name |
| `PORT` | `.env` | Default: `3000` |

If AI vars are set in the setup wizard, they're stored encrypted in the `tenants` table and override env vars at runtime.

---

## Key files to know

| File | What it does |
|---|---|
| `src/server.ts` | Express entry point, starts poller |
| `src/services/poller.ts` | The 60s poll loop — core engine |
| `src/services/psa/superops.ts` | SuperOps GraphQL — **verify field names here** |
| `src/services/ai.ts` | AI call + JSON parse + fallback |
| `src/prompts/system.ts` | The AI system prompt — tune this for accuracy |
| `src/db/schema.ts` | Database schema |
| `src/db/index.ts` | DB connection + table creation |
| `src/services/crypto.ts` | AES-256-GCM encrypt/decrypt |
| `src/middleware/auth.ts` | JWT middleware |
| `src/routes/setup.ts` | First-run setup API |
| `web/src/pages/Dashboard.tsx` | Main dashboard UI |
| `web/src/pages/Setup.tsx` | Setup wizard UI |
| `web/src/pages/Clients.tsx` | Client management UI |
| `.github/workflows/docker.yml` | CI/CD — builds and pushes Docker image |

---

## Handover notes

**What Claude Code built (2026-06-04):**
- Complete Phase 1 from scratch: ~40 files, ~9,700 lines
- Backend: Express + SQLite + Drizzle + full polling engine + auth
- Frontend: React setup wizard, dashboard, client management
- Docker + GitHub Actions CI/CD
- Image built and pushed to `ghcr.io/ashmt/swoop:latest` (private — needs manual step)

**What was not built:**
- CIPP integration (Phase 2)
- Approval/execution flow (Phase 2)
- The SuperOps GraphQL queries are untested against a real SuperOps API — field names need verification

**Biggest unknown:**
The AI classification accuracy on real MightyIT tickets. The system prompt and action types are well-designed but the proof is in the real data. Budget 1-2 weeks of Phase 1 running in production before deciding if Phase 2 is ready.
