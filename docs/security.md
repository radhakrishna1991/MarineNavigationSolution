# Security

What is implemented, what is deliberately a placeholder, and what production
would require. Section 22 of the specification.

---

## 1. Implemented

### Authentication and access control

| Control | Implementation |
|---|---|
| Password storage | bcrypt, work factor 12. Nothing else |
| Password policy | Minimum 10 characters, letters and digits, enforced server-side |
| Account lockout | 8 consecutive failures locks for 15 minutes; configurable |
| Login rate limit | 30 attempts per 15 minutes per address, successes not counted |
| Account enumeration | A failed login returns one generic message regardless of cause, and hashes anyway on an unknown username so timing does not distinguish |
| Sessions | Short-lived JWT (8 h default), issuer-checked, kept in `sessionStorage` rather than `localStorage` — a bridge terminal is a shared device |
| Role changes take effect immediately | Every request re-reads the account's role rather than trusting the token's claim until expiry |
| Disabled accounts | Rejected on the next request, not at token expiry |
| RBAC | Four hierarchical roles enforced by middleware on every mutating route, with the required and actual role returned so the client can explain the refusal |
| Self-protection | An administrator cannot delete their own account, and the last active administrator cannot be removed |

### Input handling

| Control | Implementation |
|---|---|
| Schema validation | Every request body, query and sensor message is validated with zod before it reaches any handler. Unknown top-level fields are **rejected**, not stripped |
| Message-level validation | Sensor messages are validated at the adapter *and again* at the pipeline. The pipeline is the trust boundary and does not assume its callers behaved |
| Timestamp validation | Offsets, backwards steps and staleness are all detected and alarmed |
| Identifier constraints | `sensor_id` is restricted to a safe character class; it reaches log lines and file names |
| SQL | Parameterised throughout. No query interpolates user input |
| Body size limits | 2 MB default; 48 MB for uploads through nginx, bounded separately |
| Batch limits | 5000 messages per ingestion request |
| UDP datagrams | 64 KB maximum, 2000/s per source, bound to loopback by default |
| No dynamic evaluation | The mode state machine uses a fixed operator table; an unsupported operator is a startup error. There is no `eval`, no `Function` constructor and no expression parser anywhere in the codebase |
| Configuration guard rails | Only paths that exist in the defaults may be set, types must match, safety-critical paths carry bounds, and `platform.*` and `security.*` are immutable at runtime |

### Audit

| Control | Implementation |
|---|---|
| What is logged | Every authentication event (success and failure), every mutating request with its actor, path, status and redacted body, every configuration change with old and new values, every user change, every fault injection, every export |
| Immutability | The application issues no UPDATE or DELETE against `audit_log`, and a PL/pgSQL trigger raises an exception if any code ever tried |
| Redaction | Password, token and secret fields are redacted in both the audit detail and the structured application log |
| Correlation | Every error response carries a correlation id that appears in the corresponding log line; internal detail is never returned to the client |

### Transport and headers

| Control | Implementation |
|---|---|
| Security headers | helmet, plus explicit `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Permissions-Policy`, `Cache-Control: no-store` |
| Content Security Policy | Set by the dashboard's nginx: `default-src 'self'`, no inline scripts, `frame-ancestors 'none'`. Only the Google Fonts stylesheet and font files are external |
| CORS | Explicit origin allow-list from the environment; no wildcard, no credentials |
| WebSocket authentication | Same JWT; an invalid token closes with code 4401 and the client stops retrying |
| Ingestion separation | Sensor ingestion requires the engineer role even over the shared WebSocket transport, and has its own rate limit |

### Deployment

| Control | Implementation |
|---|---|
| Non-root containers | Both images run as an unprivileged user |
| No new privileges | `security_opt: no-new-privileges` on both services |
| Read-only dashboard filesystem | With tmpfs for nginx's cache and pid |
| Database not published | Reachable only on the internal Docker network by default |
| Dependency pinning | Exact versions in both `package.json` files; `npm ci` installs from the lockfile |
| No credentials in source | Every secret comes from the environment. `.env` is git-ignored; `.env.example` contains placeholders only |
| Startup secret validation | The server refuses to start with a missing or placeholder `JWT_SECRET` |
| Graceful shutdown | SIGTERM flushes the recorder, closes sockets and drains the pool, with a hard timeout |

---

## 2. Deliberate placeholders

These are honest gaps, not oversights. Each is a demonstration-grade
implementation of something production would do differently.

| Area | What exists | What production needs |
|---|---|---|
| Identity | Local accounts with bcrypt | Federation to the operator's identity provider (SAML/OIDC), MFA for engineer and administrator roles |
| Token revocation | Tokens are short-lived and stateless; sign-out discards the client copy | Server-side deny-list or reference tokens, so a compromised token can be revoked before expiry |
| Transport encryption | Plain HTTP in the demonstration stack | TLS 1.3 terminated at the reverse proxy, HSTS, and mTLS between the platform and any sensor gateway |
| Secrets | Environment variables | A secrets manager or the vessel's key store; no secret on disk in plaintext |
| Database credentials | A single application user | Least-privilege roles, separate read-only role for reporting, connection encryption |

---

## 3. Future requirements (documented, not implemented)

Section 22 asks for these to be documented. They are requirements for a
production deployment, and none of them exists in this codebase.

### Secure boot and signed firmware

The platform must run on hardware with a verified boot chain. Every stage —
bootloader, kernel, root filesystem — must be signature-checked, and the
platform must refuse to start on an unverified chain. Firmware for any attached
gateway must be signed by the vendor and its signature verified at install time.

### Signed software releases

Every release artefact (container image, deployment bundle) must be signed and
the signature verified before deployment. The signing key must be held offline.
A reproducible build is needed so a third party can confirm that the artefact
corresponds to the audited source.

**This matters more here than in most systems.** A tampered build could change a
threshold, suppress an alarm, or make the requirement status read green — and it
would look identical on screen.

### mTLS and certificate management

Mutual TLS between the platform, sensor gateways and any fleet-monitoring
service. That requires a certificate authority, an enrolment process, a
revocation mechanism (CRL or OCSP), automated rotation before expiry, and
monitoring that alerts before a certificate lapses rather than after.

### Network segmentation

The sensor network, the platform and the crew network must be separate broadcast
domains with an enforced policy between them:

- sensor VLAN → platform: permitted, specific ports only, one direction;
- platform → sensor VLAN: **denied** (the platform never writes to a sensor);
- crew network → platform: HTTPS only, authenticated;
- platform → internet: denied by default.

The UDP ingestion listener belongs on the sensor VLAN, never on a routable
interface.

### IEC 62443 alignment

Target security level SL 2 for a decision-support system with no control
authority, assessed against the relevant parts:

- 62443-3-3 system requirements: identification, use control, system integrity,
  data confidentiality, restricted data flow, timely response, resource
  availability;
- 62443-4-1 secure development lifecycle: threat modelling, secure design
  review, security testing, defect management;
- 62443-4-2 component requirements for the platform as an embedded device.

A zone-and-conduit model must be produced for the vessel, with the platform in
its own zone.

### Classification-society and flag review

Before any operational use: an agreed scope with the classification society,
software-quality evidence, a failure-mode analysis, and an assessment of the
platform's role in the vessel's navigation arrangements. A system that presents
navigation information on the bridge may fall within the society's scope even
without control authority.

### Vulnerability management

- A software bill of materials for every release.
- Automated dependency scanning in CI, with a defined severity threshold that
  blocks release.
- A published contact for vulnerability reports and a disclosure policy.
- A patch cadence agreed with the operator, including how a vessel at sea is
  updated and how an update is rolled back.

### Incident response

- Defined severity levels and escalation paths.
- The audit trail is already the forensic record; it needs offload to
  write-once storage and a retention policy.
- A rehearsed procedure for a suspected GNSS attack: preserve the recording,
  export the run, report to the relevant authority, and continue navigation by
  independent means.
- Post-incident review feeding threshold tuning.

---

## 4. Threat model summary

| Threat | Mitigated? | How |
|---|---|---|
| GNSS spoofing (jump, drag, freeze, false velocity/time) | Yes | Cross-checks against independent physics; 25 named detection conditions |
| GNSS jamming | Yes | Signal-metric monitoring; classified separately from deception |
| Unauthorised dashboard access | Yes | Authentication, RBAC, rate limiting, lockout, audit |
| Malformed or hostile sensor data | Yes | Schema validation at two layers, size and rate limits, no dynamic evaluation |
| Audit tampering via the application | Yes | Database trigger, independent of application code |
| Replay of captured API requests | Partially | Short token lifetime; production needs TLS and nonces |
| Tampered map or reference data | **No** | Requires signed map data — a production requirement |
| Consistent multi-sensor attack | **No** | The platform's fundamental limit; see [limitations.md](limitations.md) §5 |
| Compromise of the host | **No** | Requires secure boot and host hardening — production requirements |
| Denial of service against the platform | Partially | Rate limits, back-pressure handling, bounded buffers. Navigation continues if the dashboard is unreachable |

---

## 5. Reporting a vulnerability

For this demonstration, report through the iSpatialTec project contact. A
production deployment needs a published security contact, a disclosure policy
with agreed timelines, and an acknowledgement process — see *Vulnerability
management* above.
