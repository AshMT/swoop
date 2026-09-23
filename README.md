# Swoop

**Open source AI ticket triage for MSPs.** Swoop reads every ticket from your PSA and does what a good dispatcher does in the first five minutes: works out what it is, how urgent it is, who should take it, what to say to the requester, and whether anything about it smells wrong. Where the ticket asks for a change in a client's Microsoft 365 tenant, it drafts the exact change and waits for a person to approve it.

When you are ready, it can also investigate the ticket the way a technician would — look the user up in Microsoft 365, read your runbooks for that client, check past tickets — and, once a person approves, make the change through CIPP and read the tenant back to prove it worked. That part is off until you switch it on, per action and per client.

Swoop's job is to be *measurably right* before anyone lets it do anything — so every verdict is reviewable, every approval and every change is audited, and the accuracy figures come from your own technicians, not a vendor's benchmark.

Named for the Australian magpie: black and white, very observant, and quick to swoop on anything that does not belong.

[![CI](https://github.com/AshMT/swoop/actions/workflows/ci.yml/badge.svg)](https://github.com/AshMT/swoop/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

---

## Why this exists

Every MSP AI triage product asks you to trust its accuracy. Almost none of them let you *measure* it on your own tickets.

Swoop is built around that measurement. It runs in shadow mode by design: it classifies every ticket, writes its reasoning where your technicians will see it, and then asks them one question — *was that right?* From those answers it computes an **agreement rate**: the share of reviewed classifications that matched what a human would have chosen.

That number, not a vendor's benchmark, is what tells you whether automation is safe to widen. The common industry guidance is roughly 90% agreement before expanding scope, and under about 85% means the prompt or the model needs work. Swoop reports where you actually are, per classification, with the specific label pairs it is confusing.

It is self-hosted, MIT licensed, and a single container with a single SQLite file. Point it at a local Ollama and no ticket content leaves your network.

---

## What it does

For each new ticket from a client you have enabled, Swoop:

1. **Recognises the client** — by SuperOps company, or by the requester's email domain when SuperOps has none — and checks whether the request reaches into *another* client's tenant.
2. **Checks history** — near-duplicates from the same requester, related tickets, and tickets your technicians have already reviewed, which it shows the model as worked examples.
3. **Runs deterministic checks** — security patterns, outage language, VIPs, out-of-hours, repeat requesters.
4. **Asks the model** for a full triage: category, impact, urgency, a one-line summary, a reply the technician could send, next steps, and whether the ticket is one of the changes Swoop could propose.
5. **Computes the priority** from impact and urgency, then lets the checks raise it — never lower it.
6. **Spots incidents** — a burst of similar problem tickets becomes one incident; several clients at once is flagged as probably upstream.
7. **Looks the user up in CIPP** (read-only) when a change is proposed, and builds an **execution plan** from CIPP's real API.
8. **Cites your runbooks** that match the ticket, and — if you turn the agent on — **investigates**: a tool-using model looks up the user, their groups, MFA and sign-ins, reads the runbooks and past tickets, and writes a diagnosis. It can only read.
9. **Checks who is asking** against the client's authorised contacts, so "reset the MD's password" from the wrong person is blocked.
10. **Decides who must approve** under your policy — one person, two, or auto-approval for clean, confident, routine changes if you turn it on.
11. **Carries it out, if you let it** — after approval, for actions and clients you allow, through CIPP, with a dry run first and the result read back from the tenant.
12. **Posts a private note** with all of it, and logs everything for review.

### The triage

| | |
|---|---|
| **Category** | Identity & access, email & collaboration, security, devices, printing, network, software, onboarding & offboarding, servers, telephony, admin & billing, other |
| **Priority** | P1–P4 from an impact × urgency matrix — a whole client down is P1, one person unable to work is P3 |
| **Queue** | Per-category routing you set; security findings always go to Security; urgent tickets out of hours go to on-call |
| **Summary, reply, next steps** | Written for the dispatcher, the requester and the technician respectively |

### What makes it raise an eyebrow

| Signal | Effect |
|---|---|
| Phishing, compromised account, MFA fatigue, malware | Category security, high sensitivity, at least P2, Security queue |
| "Please update our bank details", gift cards | Flagged as possible invoice fraud, same as above |
| "Nobody in the office can…" / "the accounts team can't…" | Impact raised to organisation / team |
| Requester on the client's VIP list | Priority raised one level |
| Requester's domain belongs to a different client | Flagged critical |
| Request targets a user at a different client | Escalated to a person, high sensitivity, never looked up or planned |
| Requester writes from Gmail, Outlook.com and the like | Flagged; any proposed change needs two approvers |
| Same requester, same problem, within 72 hours | Flagged as a possible duplicate |
| Several similar problem tickets within an hour | Grouped as an incident; every member raised to at least P2 |

### Proposed changes

| Action | Plan uses |
|---|---|
| `password_reset` | `ExecResetPass` |
| `mfa_reset` | `ExecResetMFA` |
| `group_add` / `group_remove` | `EditGroup` with `AddMember` / `RemoveMember` |
| `license_assign` / `license_remove` | `ExecBulkLicense` |
| `account_disable` / `account_enable` | `ExecDisableUser` (with `ExecRevokeSessions` on disable) |
| `mailbox_permission` | `ExecEditMailboxPermissions` |
| `FOLLOW_UP` | One specific question unblocks it |
| `ESCALATE` | Needs a technician — most tickets, and the triage is the useful part |

Endpoint names and body shapes follow CIPP's own OpenAPI spec and handlers. Every action except `mailbox_permission` can be carried out by Swoop once [Execution](#execution) is on; until then, and always for mailbox permissions, a technician runs the plan.

---

## Install

### Docker (recommended)

```bash
git clone https://github.com/AshMT/swoop.git
cd swoop

cp .env.example .env
# Generate the two required secrets:
echo "ENCRYPTION_KEY=$(openssl rand -hex 32)" >> .env
echo "JWT_SECRET=$(openssl rand -hex 32)" >> .env

docker compose up -d
```

Open <http://localhost:3000> and follow the setup wizard.

> Swoop **refuses to start** in production without `ENCRYPTION_KEY` and `JWT_SECRET`. A container that exits with a clear message is safer than one running on a default secret, so it tells you exactly what is missing and stops.

### Unraid

Add the container from the Docker tab with these settings:

| Setting | Value |
|---|---|
| Repository | `ghcr.io/ashmt/swoop:latest` |
| Port | `3000` → any free host port |
| Path | `/app/data` → `/mnt/user/appdata/swoop` |
| Variable `PUID` | `99` |
| Variable `PGID` | `100` |
| Variable `ENCRYPTION_KEY` | output of `openssl rand -hex 32` |
| Variable `JWT_SECRET` | output of `openssl rand -hex 32` (at least 32 characters) |

The container starts as root only long enough to make `/app/data` owned by `PUID:PGID`, then drops to that user before starting Swoop. That means an existing appdata folder with the wrong ownership is fixed automatically on start. You will not see `attempt to write a readonly database` after an upgrade.

### Without Docker

Requires Node.js 20 or newer.

```bash
npm install
npm install --prefix web

cp .env.example .env   # set ENCRYPTION_KEY and JWT_SECRET

npm run build
npm start
```

For development, `npm run dev` runs the API with hot reload and `npm run dev:web` runs the Vite dev server on port 5173.

---

## Connecting SuperOps

1. In SuperOps, go to **Settings → My Profile → API Token** and copy the token.
2. In Swoop's wizard, enter your subdomain (`mightyit` from `mightyit.superops.ai` — a custom vanity domain like `mighty.it` also works), pick your data centre, and paste the token.
3. Press **Test connection**.

### About that connection test

SuperOps's GraphQL field names are not something you can safely hardcode. Earlier versions of Swoop guessed them, and the guesses were wrong in ways that produced empty polls and unreadable errors.

So Swoop does not guess. On connect it **introspects your live GraphQL schema** and works out for itself:

- which query lists tickets, and what the ticket array is called
- which field holds the ticket body — `description`, `ticketBody`, `details`, and others are all tried
- whether `client` is a nested object or a bare string, and which sub-field holds the ID
- whether the list input supports sorting, and in what shape
- which note mutation exists — the newer `createNote` with `workItem` addressing, or the older `createTicketNote`
- whether the instance can list your clients, which is what makes the client picker work

Then it builds its queries from what it found, and shows you the result under **Settings → Diagnostics**. If your schema lacks something important — no ticket body field, no note mutation — Swoop says so in plain language rather than failing silently. If a sorted query is rejected at runtime, it degrades to walking pages unsorted instead of returning nothing.

The discovered schema is cached per tenant and re-probed weekly, or whenever you change the credentials.

---

## Choosing a model

Any OpenAI-compatible endpoint works. `/v1` is appended automatically if you leave it off.

| Provider | Base URL | Model | Notes |
|---|---|---|---|
| **Ollama** | `http://localhost:11434` | `qwen3:8b` | Nothing leaves your network |
| **OpenAI** | `https://api.openai.com/v1` | `gpt-4o-mini` | Cheap and accurate |
| **Groq** | `https://api.groq.com/openai/v1` | `llama-3.3-70b-versatile` | Very fast |
| **LM Studio** | `http://localhost:1234/v1` | *your model* | |

From inside Docker, reach an Ollama on the host as `http://host.docker.internal:11434`.

Small reasoning models are fine. Swoop strips `<think>` blocks, code fences and conversational preamble before parsing, repairs common JSON malformations, validates the result against a schema, and retries once with a correction if the response is unusable. If the model still cannot produce valid JSON, the ticket is recorded as an **AI failure** — deliberately *not* as an escalation, because a model outage is not the model declining a ticket, and mixing the two would corrupt your accuracy figures.

---

## Clients and tenant recognition

Swoop only reads tickets from clients you explicitly enable. Everything else is skipped without being logged.

Tickets are matched by **SuperOps company ID**, then exact client name, then the **requester's email domain**. If your SuperOps schema exposes a client list, the Add client form offers a picker.

Each client has a **Recognition** section:

- **Email domains** — every domain its staff send from. Swoop suggests domains it has already seen on that client's tickets. Public providers like gmail.com are refused, and one domain cannot belong to two clients: that ambiguity is exactly what a cross-client request exploits.
- **Microsoft 365 default domain** (and optionally the tenant ID) — what CIPP calls the tenant filter; needed for user lookups and plans.
- **VIPs** — addresses whose tickets are raised one priority level.
- **Authorised contacts** — who may ask for changes to *other people's* accounts. When set, a request from anyone else to reset someone's password or MFA, or change their access, is blocked until a technician confirms it with one of them. People can always ask about their own account.

With domains set, Swoop can tell when a ticket filed under one client asks for a change to a user at another — a classic social-engineering move against MSPs, who hold admin rights in every client's tenant. Those tickets are escalated, routed to Security, and never looked up.

Each client can also carry **context for the AI** (naming conventions, which MFA provider they use), or its **own prompt**, tracked as its own version on the Calibration page.

---

## Approvals

Every proposed change waits for a person. Under **Settings → Approvals**:

- **Two people for sensitive changes** — MFA resets, disabling or enabling accounts, mailbox access, and anything flagged high sensitivity need two *different* approvers.
- **Expiry** — proposals not decided within 72 hours (configurable) expire. Re-run the ticket for a fresh one.
- **Auto-approval** — off by default. When on, it applies only to actions you list, for clients you list, above a confidence you set, and never to sensitive actions, high-sensitivity or cross-client tickets, or anything with a warning flag or an unresolved plan blocker.
- Decisions are posted to the ticket as a private note, with the plan and how to undo it.

Password resets, MFA resets, re-enabling an account and mailbox access also ask the approver **how they confirmed the requester's identity** — a call-back to a known number, confirmation from an authorised contact, in person or video, a verified channel, or something they describe. Replying to the ticket email is not verification: that mailbox may be the thing that was compromised. Auto-approval never covers these.

Approving signs off the plan. Whether Swoop then runs it is up to [Execution](#execution).

## People and roles

Invite colleagues from **People**. Swoop creates a one-time link, valid 72 hours, that you send however you like — there is no mail server to configure. Only a hash of the link is stored.

| Role | Can |
|---|---|
| Viewer | See the queue, log, incidents and reports |
| Reviewer | Also mark triage right or wrong, re-run tickets, investigate, write runbooks, acknowledge incidents |
| Approver | Also approve or reject proposed changes, run them, and reveal a temporary password once |
| Admin | Also change settings, clients and people |

Roles are checked on the server on every request, against the current database row — so demoting or disabling someone takes effect immediately, and changing your password signs out every other session. Swoop will not let you remove the last admin. Every approval, review, settings change and change to people lands in the **audit log**.

## CIPP (optional)

Connect CIPP under **Settings → CIPP** with a CIPP-API client (CIPP → Integrations → CIPP-API → add and enable the client). When a change is proposed, Swoop reads the target user — whether they exist, sign-in state, on-premises sync, licences, groups, MFA registration — and turns that into prechecks on the plan: *already disabled*, *synced from AD so change it there*, *already a member*. Lookups only send GET requests. Writes happen only through [Execution](#execution).

## Knowledge

The **Knowledge** page holds runbooks: how your desk does things, for all clients or for one. *"Finance share access is the Finance security group, not Finance-ReadOnly. The CEO approves."* Triage cites the runbooks that match each ticket, and the agent reads them before recommending anything. A client's own runbook is only ever shown on that client's tickets.

If your SuperOps schema exposes its knowledge base, **Sync SuperOps KB** imports the articles read-only; edit them in SuperOps.

Write group and licence names exactly as they appear in Microsoft 365. Never put passwords in a runbook.

## Investigation agent

Off by default, under **Settings → Agent**. When on, Swoop investigates tickets that propose a change (or every ticket, or only when a reviewer presses **Investigate**). The model gets read-only tools — look up a user, their groups, MFA state, recent sign-ins, find a group, licence stock, search and read runbooks, similar tickets, the client and requester profile — and a budget of lookups. Every lookup is confined to the ticket's own client: it cannot look up an address on a domain that client does not own.

What comes back is checked before anyone sees it:

- A user, group or licence the model names that no lookup returned is dropped, and the ticket says so.
- A finding credited to a lookup that never ran is dropped.
- The investigation can fill in the exact group or licence name for the triage's proposal, but never change the action or the user. If it disagrees, the ticket is flagged instead.

It needs a model that supports tool calling on an OpenAI-compatible API; you can give it a stronger model than triage uses. Small local models often choose tools badly.

## Execution

Off by default, under **Settings → Execution**, and switched off for the whole install by `SWOOP_DISABLE_EXECUTION=1`.

| Mode | What happens |
|---|---|
| Off | Swoop proposes and plans; a technician makes the change |
| Dry runs only | An approver can have Swoop resolve the plan against the live tenant and show exactly what it would send. Nothing is sent |
| Live | Approved changes can be carried out, for the actions and clients you tick |

Nothing is allowed until you tick it: each action and each client is opted in, and a client added later is excluded until you add it. A live run needs:

- an approved (not expired, not superseded) proposal with no plan blockers, on a client that is not part of a cross-client request;
- for identity-sensitive actions, a person's approval that recorded how the requester was verified — never auto-approval;
- a passing dry run from the last 24 hours, unless you turn that off.

Then Swoop:

1. **Resolves** everything against the live tenant: the user by address (on a domain the client owns), the group by exact name — refusing duplicates, dynamic groups, groups synced from on-premises and role-assignable groups — and the licence by exact or unique name with seats free. Users synced from AD are not disabled from the cloud. If the change is already in place it stops and says so.
2. **Sends** the request once. Writes are never retried: if CIPP does not answer, the outcome is recorded as *unknown*, and nothing runs again until a person checks the tenant and records what happened.
3. **Reads the tenant back** — group membership, licences, sign-in state, password-change time — because CIPP answers HTTP 200 for many failures. A change that is not visible is not reported as done.
4. **Records** the result on the ticket as a private note with how to undo it, optionally tells the requester, and audits it.

A temporary password is never written to the ticket, a note, a log or the audit trail. It is encrypted, shown **once** to an approver who asks for it (and the reveal is audited), and deleted after 24 hours if nobody does. A proposal can be carried out live only once.

The CIPP API client needs a role that can write users and groups. With a read-only role, runs stop at the first write and say so.

---

## Calibrating

This is the part that matters, and the part most tools skip.

1. Turn on **Preview mode** (Settings → Behaviour) if you would rather not put notes in real client tickets while you calibrate. Swoop still classifies and logs everything.
2. Enable **one** client. Press **Poll now** rather than waiting out the interval.
3. Open tickets from the **Triage queue** and answer *was this triage right?* On a wrong one, correct only what was wrong — the action, the category or the priority. Each is scored separately, so a right action at the wrong urgency does not count against the action. The activity log has the same tick and cross for fast bulk review. Approving a proposal also counts as marking it right.
4. At around twenty reviews, the **Calibration** page starts reporting a meaningful agreement rate.
5. Work the confusion table. Repeated pairs are prompt problems: add the missing distinction under Settings → Prompt, then use **Re-run classifier** on a ticket you know the answer to and check it improved.
6. At 90% or above, enable a second client. Keep sampling, because agreement drifts as ticket mix changes.

The Calibration page also scores category and priority accuracy, and splits priority mistakes into over-called and under-called — the second is the one that costs a client an hour of downtime. It also tells you whether confidence is worth anything for your ticket mix, by comparing average confidence on the answers that turned out right against the ones that turned out wrong. If those two numbers are close, raising the confidence threshold will mostly just escalate correct answers, and you should lean on the sensitivity flag instead.

**Changing the prompt or the model resets the comparison.** Each classification is stamped with a fingerprint of the prompt-and-model combination that produced it, so the page can scope to one version and warns when the window spans several. Without that, tuning the prompt to fix a confusion pair leaves you averaging over both versions, and the improvement stays invisible until enough new tickets dilute the old ones. An agreement trend chart shows the daily rate against the 90% target.

Reviewing is the one genuinely repetitive task here, so the activity log has keyboard shortcuts — press **?** there. `j`/`k` move, `y` and `n` record a verdict and advance automatically, `x` clears one.

Export the full log as CSV at any point for offline analysis.

---

## Operator controls

Under **Settings → Triage rules**: business hours and timezone, the out-of-hours queue, queue routing per category, the incident window and threshold, the duplicate window, and whether to show the model reviewed examples.

Under **Settings → Behaviour**:

- **Automation running** — master switch; pauses all classification without touching per-client toggles.
- **Preview mode** — classify and log, but never write back to the PSA.
- **Poll interval** — 15 to 3600 seconds. 60 suits most desks.
- **Confidence threshold** — anything the model is less sure of is escalated instead.
- **Concurrency** — how many tickets are classified at once, 1 to 8. Leave it at 1 for a hosted provider. Raise it when a local model is falling behind: an 8B model on CPU can take tens of seconds per ticket, and one at a time means a morning's backlog clears slower than handling it by hand.
- **Note format** — plain text, Markdown or HTML. Plain is the default because it reads correctly even where the PSA renders nothing, and a note full of raw asterisks is visible on every ticket. Settings shows a worked example of each, so you can paste one into a test ticket and set whichever your instance renders.
- **Log retention** — off by default. Every log row keeps the full ticket body and the raw model response, which is what makes the log useful for debugging and also what makes it grow without bound. With a window set, the bulky text is cleared at a third of it and the row deleted at the end; the classification and your review survive the first stage, so accuracy figures are unaffected. The panel shows how much text is currently stored.

**Settings → Diagnostics** shows poll health, the last error in full, and the discovered schema. Poll failures also appear as a banner across the top of the app, because an operator whose API token expired should not have to read container logs to find out.

---

## How it handles failure

| Situation | What happens |
|---|---|
| PSA unreachable or token rejected | Poll marked failed with the cause; the watermark does not advance, so no window is skipped |
| AI provider down | Ticket queued for retry with backoff (60s, 5m, 15m, then given up on and logged as a failure) |
| Model returns unparseable output | One retry with a correction, then recorded as an AI failure, excluded from accuracy |
| Note cannot be posted | Classification still logged and the note retried on later cycles, up to five attempts — the AI call is not repeated |
| Model invents an email address that is not in the ticket | Address discarded and the verdict changed to `FOLLOW_UP` — an action against a user who never asked is worse than no action |
| Swoop restarted mid-cycle | `SIGTERM` lets the in-flight cycle finish, so no ticket is left claimed but unclassified |
| Same ticket seen twice | Deduplication ledger, keyed per tenant |

---

## Security

- Credentials are encrypted at rest with **AES-256-GCM**, keyed by scrypt from `ENCRYPTION_KEY`. They are never returned over the API — the UI is told only whether each one is set.
- Passwords are bcrypt hashed, minimum twelve characters. Sign-in is rate limited and constant-time regardless of whether the address exists.
- The only unauthenticated endpoints are `/health`, `/api/setup/status`, and first-run admin creation, which works exactly once.
- Ticket text is treated as untrusted input: it is fenced and labelled in the prompt, and the model is instructed to ignore instructions inside it. Deterministic checks can raise scrutiny but never lower it, so a ticket cannot talk its way past them.
- Four roles, checked server-side on every request against the live user row. Password changes and disabling revoke sessions immediately. Every consequential action is audited.
- Nothing is written to a client tenant unless execution is on, the action and client are allowlisted, and a person approved it. The lookup client and the agent's tools can only send GET requests; one module, used only by the executor, can write, and a test enforces that.
- The agent's lookups are confined to the ticket's own client, and what it says is checked against what its lookups returned.
- Identity-sensitive changes need a recorded identity check, and requests on someone else's behalf must come from an authorised contact when the client has any.
- Temporary passwords are encrypted, revealed once, never logged, and wiped after 24 hours.
- A request that reaches from one client into another's tenant is escalated, and the target is never looked up.
- CSV exports are protected against formula injection.
- The container starts as root only to fix data-folder ownership, then drops to `PUID:PGID` before Swoop starts; the app never runs as root, and `PUID=0` is refused.

To report a vulnerability, see [SECURITY.md](SECURITY.md).

---

## Configuration

| Variable | Required | Default | Notes |
|---|---|---|---|
| `ENCRYPTION_KEY` | in production | — | Encrypts stored credentials. Back it up with your database |
| `JWT_SECRET` | in production | — | Signs session tokens. At least 32 characters |
| `SQLITE_PATH` | no | `./data/swoop.db` | |
| `PORT` | no | `3000` | |
| `AI_BASE_URL` | no | `http://localhost:11434/v1` | Overridden by the UI |
| `AI_API_KEY` | no | — | Overridden by the UI |
| `AI_MODEL` | no | `qwen3:8b` | Overridden by the UI |
| `AI_TIMEOUT_MS` | no | `300000` | Local models on CPU are slow |
| `POLL_INTERVAL_SECONDS` | no | `60` | Default for tenants without their own |
| `LOG_LEVEL` | no | `info` | `debug`, `info`, `warn`, `error` |
| `LOG_FORMAT` | no | text | Set to `json` for a log collector |
| `TRUST_PROXY` | no | off | Enable only behind a proxy you control |
| `CORS_ORIGIN` | no | — | For frontend development only |
| `SUPEROPS_API_URL` | no | — | Override the endpoint, e.g. an egress proxy |
| `PUID` / `PGID` | no | `1000` / `1000` | User the app runs as in the container. Unraid: `99` / `100` |
| `CIPP_AUTHORITY_URL` | no | `https://login.microsoftonline.com` | Entra authority for CIPP tokens. Change for a sovereign cloud |
| `SWOOP_DISABLE_EXECUTION` | no | off | Set to `1` to stop Swoop changing any client tenant, whatever the settings say |

Anything configured through the UI is stored encrypted and takes precedence over the environment.

---

## Backups

Everything lives in one SQLite file.

```bash
# While running:
docker compose exec swoop sh -c 'sqlite3 /app/data/swoop.db ".backup /app/data/backup.db"'

# Or stop the container and copy the file. Swoop checkpoints the WAL on
# shutdown, so a plain copy of a stopped database is valid.
```

Back up `ENCRYPTION_KEY` alongside it. Without the key, the stored credentials cannot be decrypted, and you would need to re-enter them.

---

## Roadmap

Swoop triages, recognises, investigates, plans, gathers approvals and — when you allow it — carries changes out and proves they took effect.

**Turning execution on, deliberately.** Start in dry-run mode and read what it would send. Then allow one action for one client, once that action's agreement rate has held on real tickets. Mailbox permissions stay plan-only until Swoop can read them back.

**Also on the list:** writing priority and queue back to SuperOps once its ticket-update mutation has been confirmed against a real instance; follow-up questions posted as public replies; embeddings as an optional upgrade to the lexical similarity.

See [PLAN.md](PLAN.md) for the full design and [TODO.md](TODO.md) for what is next.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). `npm run check` runs lint, typecheck and the full test suite.

## License

MIT. Fork it, self-host it, take it apart.
