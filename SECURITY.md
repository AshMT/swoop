# Security

## Reporting a vulnerability

Please report security issues privately rather than in a public issue: open a [GitHub security advisory](https://github.com/AshMT/swoop/security/advisories/new) on this repository.

Include what you found, how to reproduce it, and what an attacker could do with it. You will get an acknowledgement, and credit in the fix unless you would rather not.

## What Swoop holds

Swoop is a low-value target that holds high-value credentials. Treat the host accordingly.

- **A PSA API token** with read access to every ticket in your instance, and write access to ticket notes.
- **An AI provider key**, if you use a hosted provider.
- **Ticket content**, including whatever your clients put in tickets — names, email addresses, and sometimes things that should never have been typed into a ticket.
- **One admin password hash.**

## How they are protected

**At rest.** The PSA token and AI key are encrypted with AES-256-GCM before being written to SQLite. The key is derived from `ENCRYPTION_KEY` with scrypt, so a short passphrase still produces a full-width key. `ENCRYPTION_KEY` lives only in the environment, never in the database.

In production Swoop refuses to start without `ENCRYPTION_KEY`. In development it will run without one and store credentials in plaintext, warning you both in the logs and in the UI.

**In transit.** Credentials are never returned by the API. Tenant responses carry `hasSuperopsApiKey: true` rather than the value. The logger redacts any field whose name matches `api_key`, `token`, `secret`, `password` or `authorization`.

**Authentication.** Passwords are bcrypt hashed with a work factor of 12 and a twelve-character minimum. Sign-in is rate limited to ten attempts per fifteen minutes per IP, and always performs a bcrypt comparison — against a dummy hash when the account does not exist — so response time does not reveal whether an address is registered.

Sessions are stateless JWTs valid for seven days. **There is no server-side revocation**: changing your password does not invalidate existing tokens, and the UI says so. If you believe a token is compromised, rotate `JWT_SECRET`, which invalidates every session at once.

**Unauthenticated surface.** Only three endpoints:

- `GET /health` — status and version
- `GET /api/setup/status` — whether an admin exists, so the SPA knows where to route
- `POST /api/setup/admin` — first-run account creation, which works exactly once and is rate limited

Everything else requires a bearer token. The connection-test endpoints are authenticated and rate limited specifically because they make an outbound request to an operator-supplied URL, and an unauthenticated one would be a convenient internal-network scanner.

**Transport headers.** A restrictive `Content-Security-Policy` with no inline scripts, `X-Frame-Options: DENY`, `nosniff`, `no-referrer`, and no `X-Powered-By`. There is no CORS middleware by default — the SPA is same-origin. `CORS_ORIGIN` opts in to one origin for frontend development.

**Prompt injection.** Ticket text is written by whoever raised the ticket, so it is untrusted. It is fenced with an explicit delimiter, labelled as untrusted in the prompt, and the model is instructed to ignore instructions inside it and note the attempt in its reasoning.

That instruction is a mitigation, not a guarantee, which is why the rest of the design does not depend on it: Swoop has no execute path, the response is validated against a fixed schema, an unrecognised classification is forced to `ESCALATE`, and an extracted email address that does not appear anywhere in the ticket is discarded. A successful injection can at worst produce a misleading internal note for a human to read.

**GraphQL construction.** Swoop builds queries from an introspected schema, and inlines argument values as GraphQL literals because the input type names are only known at runtime. Every string is JSON-escaped on the way in, so ticket content cannot terminate a literal or append an operation. This is covered by tests.

**CSV export.** Cells that begin with `=`, `+`, `-` or `@` are prefixed with an apostrophe, so a ticket subject cannot become a formula when the export is opened in Excel.

**Container.** Runs as an unprivileged user with `no-new-privileges`. The build toolchain is dropped from the runtime image. `tini` forwards `SIGTERM` so the in-flight poll cycle finishes cleanly.

## Deploying safely

- **Do not expose Swoop directly to the internet.** Put it on a management network or behind a VPN. It is a single-admin internal tool: it has no MFA, no SSO, and no account lockout beyond rate limiting.
- **Terminate TLS in front of it.** Swoop serves plain HTTP. Set `TRUST_PROXY=1` only once it is genuinely behind a proxy you control — otherwise a client can spoof `X-Forwarded-For` and defeat the rate limiter.
- **Back up `ENCRYPTION_KEY` with the database.** Without it the stored credentials cannot be decrypted.
- **Scope the PSA token** as narrowly as your PSA allows. Swoop needs to read tickets and write notes, nothing more.
- **Prefer a local model** if ticket content should not leave your network. Swoop makes no outbound calls other than to your PSA and the AI endpoint you configure.

## Known limitations

These are deliberate scope decisions for a single-admin self-hosted tool, not oversights:

- One account, one role. No MFA, no SSO, no per-user permissions.
- No session revocation short of rotating `JWT_SECRET`.
- Rate limiting is in-memory, so it resets on restart and is per-process.
- No audit log of administrative changes; the action log covers classifications only.

Multi-user with roles and an audit log are on the roadmap, and are prerequisites for the execution phase.
