# Swoop — Project Plan

> Last updated: 2026-09-22
> Current phase: Phase 1 (read-only triage) — built and verified against a mock PSA; awaiting validation against real SuperOps credentials.

---

## What Swoop is

An open source AI triage agent for MSPs. It reads tickets from a PSA, classifies what each is asking for, extracts the entities an action would need, and posts a private internal note proposing what a technician should do. It executes nothing.

**Target user:** MightyIT, their SuperOps instance, their real clients.

**The thesis:** the hard part of AI triage is not classification, it is *knowing whether the classification is good enough to act on*. Swoop treats that as the product. It runs in shadow mode, collects a verdict from a technician on each classification, and reports an agreement rate — which is the number that decides whether execution is safe to turn on.

---

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| Runtime | Node.js 20+ | Familiar, good ecosystem |
| Backend | Express | Simple, well understood |
| Database | SQLite via Drizzle | Zero-ops, one file, trivially backed up |
| Frontend | React 18 + Vite + Tailwind | Fast to build, good DX |
| AI | Any OpenAI-compatible REST API | Ollama, OpenAI, Groq, LM Studio — no lock-in |
| PSA | SuperOps GraphQL, discovered by introspection | Field names cannot be safely hardcoded |
| M365 | CIPP (Phase 2) | Not touched in Phase 1 |
| Tests | Vitest + supertest | |
| Container | Docker + GHCR | Easy self-hosting |

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                      Docker container                        │
│                                                              │
│  ┌────────────────────┐   ┌──────────────────────────────┐   │
│  │ Express API + SPA  │   │ Per-tenant poll scheduler    │   │
│  │ :3000              │   │  1. fetch tickets (sorted,   │   │
│  │  - auth, setup     │   │     paged, windowed)         │   │
│  │  - clients         │   │  2. dedup against ledger     │   │
│  │  - action log      │   │  3. match to enabled client  │   │
│  │  - review          │   │  4. fetch body via detail    │   │
│  │  - calibration     │   │  5. classify with AI         │   │
│  │  - diagnostics     │   │  6. apply policy + grounding │   │
│  └────────────────────┘   │  7. post private note        │   │
│                           │  8. log; retry on failure    │   │
│  ┌────────────────────┐   └──────────────────────────────┘   │
│  │ SQLite (WAL)       │◄──────────────┘                      │
│  │ /app/data          │                                      │
│  └────────────────────┘                                      │
└───────────────────────┬──────────────────────────────────────┘
                        │
        ┌───────────────┴────────────────┐
        ▼                                ▼
  SuperOps GraphQL              AI provider
  (introspected)          (Ollama / OpenAI / Groq)
```

### Key design decisions

**Discover the PSA schema, never hardcode it.** The original implementation guessed SuperOps field names and the guesses were wrong. Each wrong guess cost a deploy cycle, and the git history is a run of "field not in schema" fixes. Swoop now introspects the live schema on connect and builds its queries from what exists — the ticket body field, the client field's shape, whether sorting is supported and in what form, and which note mutation the instance exposes. The result is cached per tenant and shown to the operator in Diagnostics. Where the schema lacks something, Swoop degrades explicitly and says what it could not find.

**The body is not optional.** Classifying from a subject line alone is measurably worse, and an earlier version did exactly that: the list query could not project the body, so the poller passed an empty string to the model. Swoop now fetches the body from the single-ticket detail query and converts it from HTML to plain text.

**A model outage is not an escalation.** The fallback used to be a synthetic `ESCALATE` with confidence 0, which made a dead AI provider look like a wave of tickets the model had correctly declined — corrupting the one number Phase 1 exists to produce. Failures are now a distinct `ai_failed` status, excluded from accuracy and visible as failures in the UI.

**Claim a ticket as retryable, not as done.** The old poller marked a ticket processed *before* calling the AI, so any failure lost that ticket permanently and silently. It is now claimed with a retry timestamp, retried with backoff (60s, 5m, 15m), and after four attempts recorded as a visible failure.

**Allowlist, not blocklist.** Only clients explicitly enabled are processed. Matching is by company ID first, then exact name — the previous code compared the configured *ID* against the ticket's *name*, so an ID-configured client never matched at all.

**Deduplication keyed per tenant.** `processed_tickets` was keyed on `ticket_id` alone, so a second tenant with overlapping numbering would have had its tickets silently swallowed. The key is now `(tenant_id, ticket_id)`.

**Ground the entities.** The prompt says never to invent an email address, and it also carries worked examples. A small model can copy an address out of an example. Any extracted address that does not appear in the ticket is discarded and the verdict becomes `FOLLOW_UP`: proposing an action against a user who never asked is worse than proposing nothing.

**Policy is separate from parsing.** The stored log holds what the model actually said; the confidence floor and grounding are applied afterwards and recorded as explicit adjustments, so a disagreement can be traced to either the model or the policy.

**The note format is a setting, not a guess.** Whether a PSA renders Markdown or HTML in a note cannot be settled from outside a real instance, and guessing wrong is visible to every technician on every ticket. The note is built once as a structure and rendered into the chosen format, so the three renderers cannot drift apart, and Settings shows a worked example of each.

**Accuracy is scoped to a prompt version.** Figures from different prompts are not comparable, and the failure mode is silent: tune the prompt to fix a confusion pair, and the agreement rate afterwards averages over both versions, so the improvement is invisible until enough new tickets dilute the old ones. Each row carries a fingerprint of the prompt-and-model combination. The fingerprint covers the template rather than the rendered prompt, so per-client context does not fragment the figures.

**Fail to start rather than start insecurely.** `JWT_SECRET` used to default to `change-me-in-production`, which meant anyone could mint a valid session for any install running the default. In production Swoop now validates its configuration and exits with a list of what is wrong.

**Polling, not webhooks.** Webhooks need a publicly reachable endpoint. Polling is simpler, needs no inbound network, and is sufficient. The interval is per-tenant and adjustable from the UI.

**Single tenant in practice.** The schema is multi-tenant throughout and the poller schedules per tenant, but the UI assumes one. Multi-tenant management is a later phase.

---

## Phase 1 — Read-only triage

**Status: complete. Verified end to end against a mock SuperOps and a mock OpenAI-compatible provider. Not yet run against real credentials.**

### Engine
- [x] Per-tenant poll scheduler with configurable interval and overlap protection
- [x] GraphQL schema introspection and adaptive query construction
- [x] Ticket body retrieval and HTML-to-text conversion
- [x] Sorted, paged, time-windowed ticket fetch with runtime degradation if sort is rejected
- [x] Tenant-scoped deduplication ledger with retry and backoff
- [x] Client matching by company ID or name
- [x] Robust model-output parsing: reasoning traces, fences, prose, truncation, malformed JSON
- [x] Schema validation, label canonicalisation, confidence rescaling, entity grounding
- [x] Confidence threshold and sensitivity flag
- [x] Private note write-back with per-row delivery status
- [x] Preview mode (classify and log, never write back) and a global pause
- [x] Single-ticket re-classification for prompt tuning
- [x] Note delivery retried independently of classification, so a transient PSA
      failure does not cost a second AI call
- [x] Client discovery from the PSA, so company IDs need not be typed by hand
- [x] Two-stage log retention, off by default
- [x] Note rendered as plain text, Markdown or HTML from one shared structure,
      with a worked preview of each
- [x] Per-client prompt overrides, fingerprinted separately
- [x] Bounded per-ticket concurrency, so a slow local model does not serialise
      a morning's backlog

### Calibration
- [x] Per-classification review: correct / incorrect plus the correct label and a note
- [x] Bulk review
- [x] Agreement rate, review coverage, readiness verdict against the 85% / 90% guidance
- [x] Per-classification accuracy and average confidence
- [x] Confusion table of predicted against actual
- [x] Confidence separation — whether confidence distinguishes right from wrong
- [x] Latency percentiles, note delivery, daily volume
- [x] CSV export of the full log
- [x] Keyboard shortcuts for the review queue
- [x] Prompt-and-model fingerprint on every row, so tuning the prompt does not
      silently average the new figures in with the old ones
- [x] Agreement trend against the target

### Platform
- [x] Validated configuration that refuses to boot insecurely
- [x] Forward-only migrations with a recorded ledger, run in transactions
- [x] AES-256-GCM with a scrypt KDF, backward compatible with the legacy envelope
- [x] Rate limiting, security headers, JSON 404s, body limits, error handler
- [x] Authenticated setup routes (previously fully open)
- [x] Levelled logging with secret redaction, optional JSON output
- [x] Graceful shutdown that lets the in-flight cycle finish
- [x] Poll health and discovered-schema diagnostics surfaced in the UI
- [x] 285 tests across backend and frontend, ESLint, CI gating the Docker publish on lint + typecheck + test + boot check
- [x] Non-root container, build toolchain dropped from the runtime image

### Validation still outstanding
These need real SuperOps credentials and cannot be closed from a dev environment:

- [ ] The schema probe resolves correctly against a live SuperOps instance
- [ ] Internal notes appear on the right tickets, marked private
- [ ] 20+ real classifications reviewed, and the agreement rate read
- [ ] One week without crashes or stuck tickets

---

## Phase 2 — Approval and execution

**Entry criterion: agreement rate at or above 90% on at least 20 reviewed real tickets, holding across at least two clients.** Do not start before that. The whole point of Phase 1 is to earn this.

### Approval flow
- Classified tickets enter `awaiting_approval` instead of terminating at `classified`
- Approve / Reject with a reason, from the dashboard
- High sensitivity always requires approval regardless of confidence — the flag is already recorded, so this is policy on existing data
- Actions above a configurable blast radius require a second approver

### Execution engine
- `src/services/executor.ts`, dispatching on the action type
- M365 actions go through [CIPP](https://cipp.app):

| Action | CIPP endpoint |
|---|---|
| `password_reset` | `POST /api/ExecResetPass` |
| `group_add` / `group_remove` | `POST /api/ExecAddMember` / `ExecRemoveMember` |
| `license_assign` / `license_remove` | `POST /api/ExecAssignLicense` |
| `account_disable` / `account_enable` | `POST /api/ExecDisableUser` / `ExecEnableUser` |
| `mfa_reset` | `POST /api/ExecResetMFA` |
| `mailbox_permission` | `POST /api/ExecMailboxPermission` |

- Every execution is logged with the request, the response and the outcome
- Rollback guidance recorded for reversible actions
- The PSA ticket is updated after a successful execution

### FOLLOW_UP handling
- Post the follow-up question as a public reply rather than a private note
- Poll for a response on that ticket
- Re-classify with the added context, and compare against the original verdict

### Schema additions

```sql
ALTER TABLE action_logs ADD COLUMN approved_by TEXT;
ALTER TABLE action_logs ADD COLUMN approved_at INTEGER;
ALTER TABLE action_logs ADD COLUMN rejection_reason TEXT;

ALTER TABLE tenants ADD COLUMN cipp_base_url TEXT;
ALTER TABLE tenants ADD COLUMN cipp_api_key TEXT;      -- encrypted
ALTER TABLE tenants ADD COLUMN cipp_tenant_id TEXT;

CREATE TABLE execution_logs (
  id TEXT PRIMARY KEY,
  action_log_id TEXT REFERENCES action_logs(id),
  executed_by TEXT,
  executed_at INTEGER DEFAULT (unixepoch()),
  backend TEXT,                -- 'cipp' | 'psa'
  request TEXT,                -- redacted
  result TEXT,                 -- 'success' | 'failure'
  response TEXT,
  error TEXT
);
```

### API additions
- `POST /api/actions/:id/approve`
- `POST /api/actions/:id/reject`
- `GET  /api/actions/:id/execution`
- `PATCH /api/tenants/:id` — CIPP configuration
- `POST /api/tenants/:id/test-cipp`

### Prerequisites from Phase 3
Multi-user with roles and an administrative audit log are **prerequisites**, not nice-to-haves: "who approved this" is meaningless with one shared account.

---

## Phase 3 — Scale and governance

- Multi-user with roles (admin, approver, read-only)
- Administrative audit log — who changed what, when
- Notifications (email, Slack, Teams) for high-sensitivity arrivals and execution failures
- Per-client prompt overrides, building on the per-client context field
- Additional PSA backends. `PSAClient` is already the seam, and the capability probe generalises
- Webhook receiver, if SuperOps adds support, replacing the poller
- Multi-tenant management UI
- Accuracy trend over time, and alerting when agreement drifts below target

---

## Risks and open questions

### Live schema verification (HIGH — the last Phase 1 unknown)
The capability probe is tested against fixtures modelled on the shapes this integration has encountered, and verified end to end against a mock. It has not run against a real SuperOps instance. The probe is designed to degrade with an explicit warning rather than fail silently, so the likely outcome of a surprise is a clear message in Diagnostics — but that remains to be seen.

**First action on deployment:** connect, then read Settings → Diagnostics before anything else. It names every field it resolved and everything it could not.

### Classification accuracy (UNKNOWN — by design)
Unmeasurable until it runs on real tickets. Swoop now measures it, which is the entire point of the phase. Budget one to two weeks.

### Note formatting in SuperOps
Notes are plain text with blank-line structure rather than Markdown, because it is not known whether SuperOps renders Markdown in notes. If it does, the note format can be enriched.

### Local model latency
A large local model on CPU can take tens of seconds per ticket. The AI timeout defaults to five minutes and the poll cycle is sequential, so a slow model on a busy desk will lag. If that bites, per-ticket concurrency is the fix.

---

## Repository

- **Repo:** `github.com/AshMT/swoop`
- **Container:** `ghcr.io/ashmt/swoop:latest`
- **License:** MIT
