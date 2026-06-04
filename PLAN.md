# Swoop — Project Plan

> Last updated: 2026-06-04
> Current phase: Phase 1 (built, not yet deployed to production)

---

## What Is Swoop

Swoop is an open source AI helpdesk agent for MSPs. It connects to a PSA (SuperOps), classifies incoming support tickets using an AI model, and posts private internal notes proposing what action should be taken. In Phase 1 it is entirely read-only — no actions are executed. The goal is to calibrate the AI before turning on execution in Phase 2.

**Target user:** MightyIT (the MSP running this), their SuperOps instance, their real clients.

---

## Tech Stack

| Layer | Choice | Reason |
|---|---|---|
| Runtime | Node.js 20+ | Familiarity, good ecosystem |
| Backend framework | Express | Simple, well-understood |
| Database | SQLite (via Drizzle ORM) | Zero-ops, single file, easy backup |
| Frontend | React 18 + Vite + Tailwind CSS | Fast to build, good DX |
| AI | OpenAI-compatible REST API | Works with Ollama, OpenAI, Groq, LM Studio — no lock-in |
| PSA | SuperOps GraphQL API | Target PSA for MightyIT |
| M365 | CIPP (Phase 2+) | Not touched in Phase 1 |
| Queue | In-memory (no Redis) | Sufficient for Phase 1 polling model |
| Container | Docker + GHCR | Easy self-hosting |

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Docker Container                      │
│                                                         │
│  ┌──────────────┐    ┌────────────────────────────┐    │
│  │  Express     │    │  Polling Loop (60s)        │    │
│  │  API + SPA   │    │  - Fetch tickets from      │    │
│  │  :3000       │    │    SuperOps GraphQL         │    │
│  └──────────────┘    │  - Match to enabled client │    │
│                      │  - Classify with AI         │    │
│  ┌──────────────┐    │  - Post private note        │    │
│  │  SQLite DB   │◄───│  - Log to DB                │    │
│  │  /data/      │    │  - Mark as processed        │    │
│  │  swoop.db    │    └────────────────────────────┘    │
│  └──────────────┘                                       │
└──────────────────────────┬──────────────────────────────┘
                           │
              ┌────────────┴────────────┐
              ▼                         ▼
     SuperOps GraphQL            AI Provider
     (tickets + notes)     (Ollama / OpenAI / Groq)
```

### Key design decisions

**Allowlist model (not blocklist):** Swoop only processes tickets from clients explicitly enabled in the UI. Everything else is silently skipped. This prevents accidental processing of a client before they're ready for it.

**Deduplication ledger:** Every processed ticket ID is written to `processed_tickets` table. On each poll cycle, tickets already in this table are skipped. This is the primary dedup mechanism — not timestamps alone.

**Polling, not webhooks:** SuperOps webhooks require a publicly reachable endpoint. Polling every 60s is simpler, more resilient (no infrastructure dependency), and sufficient for Phase 1.

**AES-256-GCM for API keys at rest:** SuperOps and AI API keys are encrypted with the `ENCRYPTION_KEY` before writing to SQLite. The key lives only in the environment, not in the DB.

**AI fallback:** If the AI call fails, or the JSON response can't be parsed, the ticket is classified as `ESCALATE` with `confidence=0`. It is still logged and marked as processed (to prevent infinite retry loops).

**Single tenant for Phase 1:** The schema supports multiple tenants, but the UI and README assume one tenant (MightyIT). Multi-tenant is an easy Phase 3+ feature.

---

## Phase 1 — Completed

**Status: Built and pushed. Workflow green. Image in GHCR (private — needs manual visibility change in GitHub UI).**

### What's done

- [x] SQLite schema + Drizzle ORM + auto-create tables on startup
- [x] Express server with JWT auth (bcrypt passwords, 7-day tokens)
- [x] First-run setup wizard (4 steps: admin → SuperOps → AI → first client)
- [x] SuperOps GraphQL client (poll tickets, post private notes)
- [x] OpenAI-compatible AI client (works with any provider)
- [x] AI system prompt with 11 action types + JSON schema enforcement
- [x] 60-second polling loop with deduplication
- [x] Action log DB + dashboard UI
- [x] Client management UI with per-client automation toggle (allowlist)
- [x] AES-256-GCM encryption for stored secrets
- [x] Docker + docker-compose
- [x] GitHub Actions CI: build + push to `ghcr.io/ashmt/swoop` on push to main or feature branch
- [x] Multi-platform image (linux/amd64 + linux/arm64)

### Phase 1 success criteria (from brief)

- [ ] Setup wizard completes, Swoop connects to SuperOps *(needs real SuperOps creds)*
- [ ] Polling starts automatically every 60 seconds *(coded, not validated with real creds)*
- [ ] Tickets are classified correctly *(needs 10+ real MightyIT tickets to validate)*
- [ ] Internal notes appear in SuperOps *(needs real SuperOps creds)*
- [ ] Dashboard shows action logs with correct classification *(UI built, needs real data)*
- [ ] No errors/crashes over 1 week *(needs production deployment)*
- [ ] Enable/disable clients works *(UI built and tested)*

---

## Phase 2 — Approval + Execution (Not started)

### What Phase 2 adds

**Approval flow:**
- After classification, ticket goes into `awaiting_approval` state
- Human sees the proposal in the Swoop dashboard and clicks Approve or Reject
- Alternatively: Swoop posts the proposal as a public (or private) note to the ticket and waits for a reply from the tech (comment detection via polling)
- High-sensitivity actions require a secondary approval regardless of the approver

**Execution engine:**
- On approval, Swoop calls the relevant backend to execute the action
- M365 actions go through CIPP (see below)
- SuperOps status may be updated after execution

**CIPP integration:**
- CIPP is the open source M365 management platform used by MSPs
- It exposes a REST API for user management operations
- Connection config (CIPP URL + API key) added to tenant settings in Swoop
- Actions mapped to CIPP endpoints:
  - `password_reset` → `POST /api/ExecResetPass`
  - `group_add` / `group_remove` → `POST /api/ExecAddMember` / `ExecRemoveMember`
  - `license_assign` / `license_remove` → `POST /api/ExecAssignLicense`
  - `account_disable` / `account_enable` → `POST /api/ExecDisableUser` / `ExecEnableUser`
  - `mfa_reset` → `POST /api/ExecResetMFA`
  - `mailbox_permission` → `POST /api/ExecMailboxPermission`

**FOLLOW_UP handling:**
- If classification is `FOLLOW_UP`, Swoop posts the `follow_up_question` as a note to the ticket
- Polls for a reply on that ticket (comment polling, Phase 2 addition)
- On reply, re-classifies with the additional context

**Sensitivity ratchet:**
- `sensitivity: high` tickets always require human approval, even if confidence is high
- This is already captured in Phase 1 action logs — Phase 2 just acts on it

### Phase 2 schema additions needed

```sql
-- Approval decisions
ALTER TABLE action_logs ADD COLUMN approved_by TEXT;
ALTER TABLE action_logs ADD COLUMN approved_at INTEGER;
ALTER TABLE action_logs ADD COLUMN rejection_reason TEXT;

-- CIPP config (on tenants table or separate)
ALTER TABLE tenants ADD COLUMN cipp_base_url TEXT;
ALTER TABLE tenants ADD COLUMN cipp_api_key TEXT;  -- encrypted

-- Execution log
CREATE TABLE execution_logs (
  id TEXT PRIMARY KEY,
  action_log_id TEXT REFERENCES action_logs(id),
  executed_at INTEGER DEFAULT (unixepoch()),
  result TEXT,  -- 'success' | 'failure'
  response TEXT,  -- raw response from CIPP/API
  error TEXT
);
```

### Phase 2 API additions needed

- `POST /api/actions/:id/approve` — approve and execute
- `POST /api/actions/:id/reject` — reject with reason
- `GET /api/actions/:id/execution` — execution result
- `POST /api/tenants/:id/cipp-config` — save CIPP settings
- `POST /api/tenants/:id/test-cipp` — test CIPP connection

---

## Phase 3 — Nice-to-haves (Future)

- Multi-user with roles (admin, approver, read-only)
- Email/Slack notifications when high-sensitivity tickets arrive
- Prompt tuning UI (edit system prompt per client)
- Audit log (who approved what, when)
- Metrics / accuracy dashboard (classification confidence over time)
- Webhook receiver (replace polling if SuperOps adds webhook support)
- Multi-tenant management UI

---

## Known Risks + Open Questions

### SuperOps GraphQL field names (HIGH — blocks real usage)
The queries in `src/services/psa/superops.ts` use field names that are educated guesses based on API conventions. **They need to be verified against the actual SuperOps GraphQL schema before Phase 1 can be considered validated.**

To verify:
1. Open SuperOps → Settings → API
2. Use the GraphQL introspection endpoint or their API docs
3. Compare against the queries in `superops.ts` and adjust field names

Fields most likely to need adjustment:
- `description` (ticket body) — may be `ticketBody`, `details`, or `body`
- `requesterEmail` — may be nested as `requester { email }`  
- `companyId` — may be `clientId`, `company { id }`, or `companyID`
- `addTicketNote` mutation — may be `createNote`, `addNote`, or different field names

### GHCR package visibility (MEDIUM — blocks `docker pull`)
The image `ghcr.io/ashmt/swoop:latest` has been built and pushed but is private. Changing package visibility via the API requires a PAT, not `GITHUB_TOKEN`. **Needs one manual step in GitHub UI.**

Fix: github.com/ashmt → Packages → swoop → Package settings → Change visibility → Public

### AI classification accuracy (UNKNOWN — needs calibration)
Phase 1's whole purpose is to validate classification accuracy on real MightyIT tickets. Until 10+ real tickets have been run through the system, we don't know if the model/prompt combination is good enough.

Recommended approach: run Phase 1 for 1-2 weeks, export the action logs, review classification accuracy, adjust the system prompt in `src/prompts/system.ts` as needed before enabling Phase 2.

---

## Repository

- **Repo:** `github.com/AshMT/swoop`
- **Main branch:** `main`
- **Phase 1 branch:** `claude/swoop-phase-1-build-PRp7n`
- **Container:** `ghcr.io/ashmt/swoop:latest`
- **License:** MIT
