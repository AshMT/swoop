# Swoop — AI Helpdesk Agent for MSPs

Swoop is an open source AI helpdesk agent that connects to SuperOps, classifies support tickets using AI, and posts internal notes proposing what action should be taken — without executing anything.

**Phase 1 is read-only.** Swoop watches and learns. Execution comes in Phase 2.

---

## What it does

1. Polls SuperOps every 60 seconds for new tickets from enabled clients
2. Sends each ticket to an AI model (OpenAI, Groq, Ollama, or any OpenAI-compatible API)
3. The AI classifies the ticket: `password_reset`, `group_add`, `license_assign`, `ESCALATE`, etc.
4. Posts a private internal note to the ticket showing the proposed action and reasoning
5. Logs everything to a dashboard for review

No tickets are modified. No actions are executed. You're calibrating the AI before enabling execution.

---

## Setup in 5 minutes

### With Docker (recommended)

```bash
# 1. Clone
git clone https://github.com/swoopai/swoop.git
cd swoop

# 2. Create .env
cp .env.example .env
# Edit .env — set ENCRYPTION_KEY, JWT_SECRET, and your AI provider

# 3. Start
docker compose -f docker-compose.simple.yml up -d

# 4. Open http://localhost:3000 and follow the setup wizard
```

### Without Docker

```bash
npm install
cd web && npm install && cd ..
cp .env.example .env
# Edit .env

# Start development (hot reload)
npm run dev

# Or build for production
npm run build
npm start
```

---

## Supported AI providers

Swoop uses any OpenAI-compatible API. Set these in `.env` or in the setup wizard:

| Provider | AI_BASE_URL | AI_MODEL |
|----------|-------------|----------|
| **Ollama** (local) | `http://localhost:11434/v1` | `qwen3:8b` |
| **OpenAI** | `https://api.openai.com/v1` | `gpt-4o-mini` |
| **Groq** | `https://api.groq.com/openai/v1` | `llama3-70b-8192` |
| **LM Studio** | `http://localhost:1234/v1` | your model name |

---

## Supported ticket actions

Swoop classifies tickets into one of these action types:

- `password_reset` — user needs their password reset
- `group_add` / `group_remove` — add/remove user from a group
- `license_assign` / `license_remove` — assign/remove M365 or other licenses
- `account_disable` / `account_enable` — disable or enable a user account
- `mfa_reset` — reset MFA for a user
- `mailbox_permission` — mailbox delegation or shared mailbox access
- `ESCALATE` — Swoop can't handle it, needs human review
- `FOLLOW_UP` — more information needed from the requester

---

## SuperOps setup

1. Log in to SuperOps
2. Go to **Settings → My Profile → API Token**
3. Copy the token
4. In Swoop's setup wizard: enter your subdomain (e.g. `yourcompany` from `yourcompany.superops.ai`) and paste the token

> **Note on GraphQL field names:** SuperOps's GraphQL API field names are mapped in `src/services/psa/superops.ts`. If queries fail after connecting, check the file comments for adjustment guidance and compare against SuperOps API documentation.

---

## Client allowlist

Swoop uses an **allowlist model** — it only processes tickets from clients you explicitly enable.

1. Go to **Clients** in the dashboard
2. Add a client and set their SuperOps Company ID
3. Toggle automation ON for that client

Swoop will only process tickets from companies with automation enabled. Everything else is silently skipped.

---

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ENCRYPTION_KEY` | Yes | 32-char key for encrypting stored API keys |
| `JWT_SECRET` | Yes | Secret for signing session tokens |
| `SQLITE_PATH` | No | Path to SQLite database (default: `./data/swoop.db`) |
| `AI_BASE_URL` | No | AI provider base URL (can be set via setup wizard) |
| `AI_API_KEY` | No | AI API key (can be set via setup wizard) |
| `AI_MODEL` | No | Model name (can be set via setup wizard) |
| `PORT` | No | HTTP port (default: `3000`) |

---

## License

MIT — free to use, fork, and self-host.