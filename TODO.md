# Swoop — TODO

> Last updated: 2026-09-22
> Work from the top.

---

## 1. Deploy and verify against real SuperOps

Everything else waits on this. The engine is built and verified against a mock; what is unverified is the real schema.

```bash
git clone https://github.com/AshMT/swoop.git
cd swoop
cp .env.example .env
echo "ENCRYPTION_KEY=$(openssl rand -hex 32)" >> .env
echo "JWT_SECRET=$(openssl rand -hex 32)" >> .env
docker compose up -d
```

Then, in order:

- [ ] Complete the setup wizard. Press **Test connection** on the SuperOps step and read what it reports.
- [ ] **Go straight to Settings → Diagnostics.** This is the important step. It names every field the probe resolved. Check specifically:
  - **Ticket body field** — if this says "not found", classification is running on subject lines and accuracy will be poor. The candidate list is in `src/services/psa/capabilities.ts` (`BODY_CANDIDATES`); add whatever SuperOps actually calls it.
  - **Note mutation** — if "not found", Swoop cannot write proposals back.
  - **Client field** — if "not found", no ticket can be matched to a client.
  - Any warnings listed.
- [ ] Turn on **Preview mode** (Settings → Behaviour) so nothing is written into real client tickets yet.
- [ ] Enable one client, with its SuperOps company ID filled in.
- [ ] Press **Poll now**. Confirm tickets appear with a non-empty body in the expanded row.
- [ ] Turn Preview mode off and confirm a note lands on the right ticket, marked private.

## 2. Calibrate

- [ ] Review every classification — tick or cross, and on a cross pick what it should have been.
- [ ] At 20 reviews, read the **Calibration** page.
- [ ] Work the confusion table. Each repeated pair is a prompt fix: add the distinction under Settings → Prompt, then **Re-run classifier** on a ticket you know the answer to.
- [ ] Check confidence separation. If confidence barely differs between right and wrong answers, lower the threshold and rely on the sensitivity flag instead — a high threshold that escalates correct answers is pure cost.
- [ ] Enable a second client once agreement holds at 90% or above.
- [ ] One week without crashes or stuck tickets = Phase 1 validated.

## 3. Make the GHCR image public

The image builds and pushes but is private, so `docker pull ghcr.io/ashmt/swoop:latest` returns 403. Changing visibility needs a PAT rather than `GITHUB_TOKEN`, so it is a one-time manual step:

<https://github.com/ashmt?tab=packages> → **swoop** → **Package settings** → **Danger Zone** → **Change visibility** → **Public**

---

## Known gaps, roughly by value

- [x] **Client picker from SuperOps.** The probe now discovers a client list query, and the Add client form offers a dropdown that fills in the name and company ID.
- [x] **Retry the note, not just the classification.** A classification whose note failed to post is retried on later cycles, up to five attempts, without repeating the AI call.
- [x] **Log retention.** Configurable per tenant, two-stage: bulky text cleared at a third of the window, row deleted at the end. Off by default.
- [x] **Review keyboard shortcuts.** `?` on the Dashboard. `j`/`k` to move, `y`/`n` to record a verdict and advance, `x` to clear.
- [x] **Per-ticket concurrency.** A bounded worker pool, 1 to 8, set per tenant. Defaults to 1 so an upgrade does not change how hard an existing install hits its provider.
- [x] **Note format.** Plain, Markdown or HTML, chosen per tenant and defaulting to plain. Settings renders a worked example of each so you can paste one into a test ticket and see which your PSA renders, rather than guessing.
- [x] **Per-client prompt overrides.** A client override replaces the tenant prompt for that client's tickets, and carries its own prompt fingerprint so its accuracy is not averaged in with everyone else's.
- [ ] **Confirm which note format SuperOps renders.** The mechanism is built; the remaining step is a real ticket. Paste each preview from Settings → Behaviour into a test ticket and set the one that renders.
- [x] **Prompt version on each row.** Each classification is stamped with a fingerprint of the prompt-and-model combination, and the Calibration page scopes to one version and warns when the window spans several.
- [x] **Accuracy trend.** Daily agreement rate charted against the 90% target and 85% floor.

## Recently closed

- Health check now probes the database. It previously returned 200 unconditionally, so a container whose SQLite file had gone unreadable reported healthy and no orchestrator would restart it.
- A React error boundary per route, so one bad page no longer white-screens the app and the shell stays usable.
- Frontend test setup in `web/`, with the error boundary covered.

## Deferred deliberately

- Session revocation. Stateless JWTs, no server-side store. Rotating `JWT_SECRET` invalidates everything, and the UI states the limitation. Revisit with multi-user.
- Distributed rate limiting. In-memory is correct for a single-process single-SQLite deployment.
- Webhooks. Needs SuperOps support and an inbound endpoint. Polling is adequate.

## Phase 2 prep — do not start until Phase 1 is validated

See [PLAN.md](PLAN.md) for the design.

- [ ] Multi-user with roles, and an administrative audit log — **prerequisites**, since "who approved this" means nothing with one shared account
- [ ] CIPP client (`src/services/cipp.ts`) and connection test
- [ ] Approve / Reject UI and routes
- [ ] Execution engine and `execution_logs`
- [ ] Sensitivity ratchet enforcement
- [ ] FOLLOW_UP reply polling and re-classification

---

## Development

```bash
npm install && npm install --prefix web
npm run dev          # API, hot reload
npm run dev:web      # Vite on :5173
npm run check        # lint + typecheck + test — run before pushing
```

`SUPEROPS_API_URL` points the PSA client at a mock, so the full poll path can be exercised without real credentials.

See [CONTRIBUTING.md](CONTRIBUTING.md) for layout and conventions.

## Key files

| File | What it does |
|---|---|
| `src/config.ts` | Validated config; refuses to boot insecurely |
| `src/services/poller.ts` | The engine — schedule, dedup, retry, write-back |
| `src/services/psa/capabilities.ts` | GraphQL schema probe. **Add field candidates here** |
| `src/services/psa/superops.ts` | Adaptive client built from the probe |
| `src/services/ai.ts` | Provider call, validation, policy, grounding |
| `src/lib/json-extract.ts` | Pulls JSON out of messy model output |
| `src/services/metrics.ts` | Calibration report |
| `src/prompts/system.ts` | The classifier prompt |
| `src/domain/classifications.ts` | The canonical action list |
| `src/db/migrations.ts` | Forward-only migrations |
| `web/src/pages/Calibration.tsx` | Agreement rate and confusion table |
| `web/src/components/ActionRow.tsx` | The review controls |
