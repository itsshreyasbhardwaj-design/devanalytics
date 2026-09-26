# Security policy

## Reporting a vulnerability

Report privately through [GitHub Security Advisories](https://github.com/itsshreyasbhardwaj-design/devanalytics/security/advisories/new).
Please do not open a public issue for a security problem.

Include what you did, what happened, and what you expected. A proof of concept against a local instance
(`pnpm demo:seed && pnpm dev`) is ideal and requires no credentials of ours.

Expect an acknowledgement within three working days and an assessment within ten. Fixes for confirmed issues ship
before public disclosure, and you will be credited unless you prefer otherwise.

## Scope

In scope: tenant isolation, webhook authenticity, secret handling, the AI SQL guard, RBAC, rate limiting, injection of
any kind, and anything that makes the platform report a number it did not compute.

Out of scope: findings that require an attacker to already hold a valid API token for the organization they are
attacking; denial of service by volume against a local instance; the deliberately permissive `local-dev` auth mode,
which refuses to start when `NODE_ENV=production`.

## Security model

### Tenant isolation

Every tenant table carries `org_id` and a row-level security policy keyed on the `devanalytics.org_id` session setting.
Application connections run as `devanalytics_app`, a non-superuser role, so the policy is enforced by Postgres rather
than by application discipline. With no organization set, every policy evaluates false and queries return zero rows —
the failure mode is emptiness, not leakage.

Cross-organization access is not expressible: a `Principal` carries exactly one `orgId`, and `assertOrgAccess` rejects
any request naming another.

Covered by `tests/security/tenant-isolation.test.ts` (21 tests), including cross-org reads, foreign scope ids, metric
breakdowns, exports, AI answers, revoked tokens and secret leakage in responses.

### Least privilege in the database

| Role | Grants |
| --- | --- |
| owner (migrations) | everything |
| `devanalytics_app` | SELECT/INSERT/UPDATE/DELETE on tenant tables, under RLS |
| `devanalytics_ro` | SELECT only, under RLS, with **no grant** on `api_tokens`, `org_members`, `webhook_endpoints`, `webhook_deliveries`, `job_queue` or `principals` |

The read-only role backs the AI analytics path. Covered by `tests/security/sql-guard.test.ts`.

### Webhook authenticity

Signatures are verified with HMAC-SHA256 over the **raw request bytes**, before parsing — parsing and re-serialising
changes whitespace and key order, and the HMAC would no longer be over what the provider signed. Comparison is
constant-time after a length check.

The endpoint id in the URL selects the secret, so the secret can be found without parsing the body. An unknown endpoint
and a bad signature return the same result, so endpoint ids cannot be probed for existence.

Bodies of rejected deliveries are **not stored**: an unauthenticated caller must not be able to write arbitrary content
into our tables. The body hash is stored either way, for auditing.

### Secrets

Webhook secrets and host access tokens are encrypted at rest with AES-256-GCM under `DEVANALYTICS_ENCRYPTION_KEY`
(32 random bytes, base64). Ciphertext is `v1.<iv>.<tag>.<data>`, so the format is self-describing and rotatable.

API tokens are stored only as a SHA-256; the plaintext is shown once at creation. Lookup is by hash with a
constant-time comparison.

Provider tokens are decrypted only inside the server process and are never returned by any endpoint. A test asserts no
API response contains a token, a secret or ciphertext.

### AI SQL guard

Five independent layers, each sufficient on its own:

1. The connection assumes `devanalytics_ro`, which holds `SELECT` and nothing else.
2. Row-level security scopes it to one organization.
3. A single statement only; string literals and comments are stripped before keyword checks, so a keyword cannot be
   smuggled inside a quoted string.
4. An allowlist of readable tables, so credential tables are unreachable even where the role could read them.
5. A statement timeout and a hard row cap applied by wrapping the caller's query.

Every execution — accepted, rejected or failed — is written to the audit log with its text.

### Reporting integrity

This is treated as a security property, not a UX one. `MetricResult` is a sum type that every consumer must destructure,
so a fabricated statistic cannot reach a user through a forgotten branch. Model-generated narration is verified figure
by figure against the evidence that produced it and discarded if any magnitude is absent or a causal claim is made.

## Operational guidance

- Set `DEVANALYTICS_ENCRYPTION_KEY` before connecting any repository. Store it in a secrets manager, not in the repo.
- Use a `viewer`-role API token for the MCP server so the credential cannot write, independently of the tools exposed.
- Rotate webhook endpoints by creating a new one and revoking the old; `revoked_at` takes effect immediately.
- Run the app behind TLS. Webhook signatures authenticate the body, not the transport.
- `DEVANALYTICS_AUTH_MODE=local-dev` refuses to start when `NODE_ENV=production`. Do not remove that check.
