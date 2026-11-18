# Security

The [November engineering checkpoint](../product/implementation-progress.md) records newer evidence for immutable journal membership, database recovery, tenant-aware Studio publishing and the dependency audit. The [extension model](vekoscript-extension-model.md) covers the Spring and worker boundaries. The assessment below preserves the original ERP release findings.

Status as of 2026-10-28. This describes what is built and tested, and what is not.
**No compliance claim (SOC 2, PCI DSS, GDPR, US tax or accounting standards) is made.**
Those need independent review by qualified professionals.

## Implemented and tested

| Control | Implementation | Test |
| --- | --- | --- |
| Password storage | scrypt (N=16384, r=8, p=1, 16-byte salt) from Node's standard library; parameters stored per hash | `security.test.ts` "stores only a hash…" |
| Login enumeration | same message for unknown email and wrong password; a dummy hash is verified for unknown emails | "rejects wrong passwords without revealing…" |
| Brute force | 10 requests/minute per IP on signup and login (`@fastify/rate-limit`, in-memory) | not automated |
| Sessions | 256-bit random token in an `HttpOnly`, `SameSite=Lax` cookie (`Secure` behind HTTPS via `COOKIE_SECURE`); only the SHA-256 hash is stored; 30-day expiry | "signs out and the old cookie stops working" |
| Revocation | sign-out deletes the session; removing a member deletes their sessions in that org | "removing a member ends their session immediately" |
| CSRF | SameSite=Lax cookies + Origin check on every non-GET request + JSON-only bodies | "rejects state-changing requests from other origins" |
| Authorization | named permissions per role checked on every mutating route; reads require membership. Purchasing (`purchasing.write`, `bills.post`, `bills.pay`) is limited to owner, admin and accountant | `security.test.ts` roles block; `purchasing.test.ts` permissions block |
| Duplicate vendor invoices | the same vendor invoice number cannot be entered twice for a vendor (a common cause of double payment) | `purchasing.test.ts`; e2e procure-to-pay |
| Tenant isolation | every query scoped by the session's organization; composite foreign keys stop cross-tenant references in the database | `security.test.ts` tenant block (read, list, search, reference, update) |
| Ledger integrity | database triggers: balanced entries, immutability, period lock, append-only audit | `ledger.test.ts` (bypasses the API and writes SQL directly) |
| Input validation | Zod schema on every route; money and quantity precision enforced; dates as ISO strings | `order-to-cash.test.ts` "validates input…" |
| Error hygiene | one error shape; 500s return a generic message and are logged server-side | – |
| Log hygiene | cookie, authorization and set-cookie headers redacted in logs | – |
| Web headers | `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options: DENY`, `Permissions-Policy` | – |
| Containers | non-root `node` user; no secrets baked into images | Docker build verified |

## Known gaps (planned)

1. **Row-level security** as a second isolation layer (non-owner DB role + per-transaction `set_config`).
2. **Distributed rate limiting** (Redis or Postgres) for multi-instance deployments; account lockout and CAPTCHA-free throttling.
3. **Account lifecycle:** email verification, password reset, invitations instead of admin-set temporary passwords, forced password change, MFA (TOTP/WebAuthn), SSO (SAML/OIDC).
4. **Content Security Policy** with nonces for the Next.js app.
5. **API keys / OAuth clients** with scopes for integrations; signed webhooks.
6. **Secrets management** in production (the repo holds only local development defaults in `.env.example` and `docker-compose.yml`).
7. **Dependency and container scanning** in CI; SBOM.
8. **Backups and tested restore**, encryption at rest (host-provided), audit-log export.
9. **Data retention and deletion** (account deletion, GDPR/CCPA requests) — needs legal review.
10. **Penetration test** by a third party before handling customer data in production.

## AI assistant (planned, not built)

Any assistant must query only through the same permission-checked API as the user, never
with a privileged connection; never post, void, pay or change settings without an explicit
confirmation by the user; and log every tool call to the audit trail.
