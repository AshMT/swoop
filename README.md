# Swoop

**Open source AI ticket triage for MSPs.** Swoop reads tickets from your PSA, classifies what each one is actually asking for, and posts a private internal note proposing the action a technician should take.

It does not take that action. Nothing is executed, nothing is changed, no ticket state is touched. Swoop's job is to be *measurably right* before anyone lets it do anything.

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

1. **Polls your PSA** for new tickets from clients you have explicitly enabled.
2. **Reads the whole ticket** — subject and body, converted from HTML to clean text.
3. **Classifies it** into one of eleven action types using any OpenAI-compatible model.
4. **Extracts the entities** the action would need: target user, group, licence.
5. **Posts a private internal note** with the proposal, the reasoning and its confidence.
6. **Logs everything** and asks your technicians to mark each verdict right or wrong.
7. **Reports the agreement rate**, per-classification accuracy, and a confusion table.

### Action types

| Action | What it means |
|---|---|
| `password_reset` | Reset a named user's password |
| `mfa_reset` | Reset or re-register MFA |
| `group_add` / `group_remove` | Group, distribution list or team membership |
| `license_assign` / `license_remove` | Microsoft 365 or third-party licences |
| `account_disable` / `account_enable` | Sign-in state, e.g. an offboarding |
| `mailbox_permission` | Shared mailbox access, send-as, delegation |
| `FOLLOW_UP` | Intent is clear; one specific question unblocks it |
| `ESCALATE` | Out of scope, too vague, or needs human judgement |

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

## The client allowlist

Swoop only reads tickets from clients you explicitly enable. Everything else is skipped without being logged.

Tickets are matched to a client by **SuperOps company ID** first, then by exact client name. Use the company ID — names get renamed.

If your SuperOps schema exposes a client list, the Add client form offers a **picker** that fills in the name and company ID for you, and leaves out clients you have already added. If it does not, type the ID by hand — the allowlist works either way.

Each client can also carry **context for the AI**: naming conventions, who counts as a VIP, which MFA provider they use. This gets added to the prompt for that client's tickets, and it is the single change that moves classifications the most:

> Email addresses are firstname.lastname@acme.com. The finance team are all VIPs — treat anything from them as high sensitivity. They use Duo, not Microsoft Authenticator.

A client whose ticket mix is different enough that shared wording cannot serve it can also have its **own prompt**, which replaces the tenant prompt for that client rather than being appended to it. Its accuracy is then tracked as its own version on the Calibration page, so it is not averaged in with everyone else's.

---

## Calibrating

This is the part that matters, and the part most tools skip.

1. Turn on **Preview mode** (Settings → Behaviour) if you would rather not put notes in real client tickets while you calibrate. Swoop still classifies and logs everything.
2. Enable **one** client. Press **Poll now** rather than waiting out the interval.
3. On the Dashboard, mark each classification with the tick or the cross. On a wrong one, pick what it should have been — that is what builds the confusion table.
4. At around twenty reviews, the **Calibration** page starts reporting a meaningful agreement rate.
5. Work the confusion table. Repeated pairs are prompt problems: add the missing distinction under Settings → Prompt, then use **Re-run classifier** on a ticket you know the answer to and check it improved.
6. At 90% or above, enable a second client. Keep sampling, because agreement drifts as ticket mix changes.

The Calibration page also tells you whether confidence is worth anything for your ticket mix, by comparing average confidence on the answers that turned out right against the ones that turned out wrong. If those two numbers are close, raising the confidence threshold will mostly just escalate correct answers, and you should lean on the sensitivity flag instead.

**Changing the prompt or the model resets the comparison.** Each classification is stamped with a fingerprint of the prompt-and-model combination that produced it, so the page can scope to one version and warns when the window spans several. Without that, tuning the prompt to fix a confusion pair leaves you averaging over both versions, and the improvement stays invisible until enough new tickets dilute the old ones. An agreement trend chart shows the daily rate against the 90% target.

Reviewing is the one genuinely repetitive task here, so it has keyboard shortcuts — press **?** on the Dashboard. `j`/`k` move, `y` and `n` record a verdict and advance automatically, `x` clears one.

Export the full log as CSV at any point for offline analysis.

---

## Operator controls

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
- Ticket text is treated as untrusted input: it is fenced and labelled in the prompt, and the model is instructed to ignore instructions inside it.
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

Swoop is **read-only**. That is a deliberate stage, not an incomplete feature.

**Next: approval and execution.** Once agreement rate holds above target on real tickets, the next phase adds Approve/Reject on each proposal and an execution engine that carries out approved actions through [CIPP](https://cipp.app) for Microsoft 365. High-sensitivity actions will require approval regardless of confidence — Swoop already records that flag, so the policy is ready before the mechanism is.

See [PLAN.md](PLAN.md) for the full design and [TODO.md](TODO.md) for what is next.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). `npm run check` runs lint, typecheck and the full test suite.

## License

MIT. Fork it, self-host it, take it apart.
