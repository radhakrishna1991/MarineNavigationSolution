# iSpatialTec Assured Marine Navigation Platform

A resilient PNT and navigation-assurance system: it decides which navigation
sources can be trusted, fuses the ones that can, quantifies the uncertainty, and
warns before the Safeen **< 2 m horizontal** requirement can no longer be
assured.

GNSS is treated as one untrusted sensor among several — it is cross-checked
against independent physics while it is healthy, which is why an attack is caught
at three metres of offset rather than forty-five.

> **This is a proof of concept.** It runs on simulated sensors and synthetic
> geospatial data. It has no type approval, no classification-society review and
> no flag-state acceptance, it has never been to sea, and the map data is not
> navigational data. See [docs/limitations.md](docs/limitations.md).

---

## What it does

| | |
|---|---|
| **Detects GNSS attack and interference** | 25 named conditions — sudden jump, gradual drag, frozen coordinates, false velocity, false time, jamming — with deception classified separately from interference, each debounced and each with a plain-language explanation |
| **Keeps navigating without GNSS** | 7-state EKF fusing radar map matching, bathymetric terrain matching, gyro heading, DVL bottom-track velocity, LiDAR, acoustic ranging and optional INS |
| **Bounds the error** | A horizontal protection level, not just a covariance — with correlated-error, observed-disagreement and post-exclusion contamination terms |
| **Says when it cannot** | The requirement status is `MET` / `AT RISK` / `NOT MET` / `INSUFFICIENT INFORMATION`, and there is no setting that keeps it green |
| **Refuses to guess** | Bathymetric ambiguity, unobservable terrain and failed scan matching all return "no result and here is why", never a best guess |
| **Never touches the vessel** | No control outputs, structurally. The navigation API refuses every write method |
| **Records everything** | Append-only audit enforced by a database trigger, reproducible runs, five export formats |

**Measured on the shipped configuration:** 0.22–0.46 m mean horizontal error
across 15 scenarios · 0–2.2 % misleading-information rate · spoofing drag
detected at ≈3.2 m of offset · zero false alarms in healthy operation. Full
numbers in [docs/test-plan.md](docs/test-plan.md) §10.

---

## Quick start

### Docker Compose (recommended)

```bash
cp .env.example .env
# Set POSTGRES_PASSWORD, PGPASSWORD, JWT_SECRET, SEED_ADMIN_PASSWORD, SEED_DEMO_PASSWORD
docker compose up --build
```

Dashboard on <http://localhost:8080>. Migrations and seeding run automatically.

### Local development

**Prerequisites:** Node.js ≥ 20 (24 recommended), PostgreSQL ≥ 14 (17
recommended), npm ≥ 10.

```bash
# 1. Create the database and user
psql -U postgres -c "CREATE DATABASE marinenavigation;"
psql -U postgres -c "CREATE USER \"AIUSER\" WITH PASSWORD 'your-password';"
psql -U postgres -c "GRANT ALL PRIVILEGES ON DATABASE marinenavigation TO \"AIUSER\";"
psql -U postgres -d marinenavigation -c "GRANT ALL ON SCHEMA public TO \"AIUSER\";"

# 2. Configure
cp .env.example .env
# Fill in PGPASSWORD, JWT_SECRET, SEED_ADMIN_PASSWORD, SEED_DEMO_PASSWORD
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"   # for JWT_SECRET

# 3. Install, migrate, seed
npm install
npm run db:migrate
npm run db:seed

# 4. Run
npm run dev        # backend :4000, dashboard :5173
```

Open <http://localhost:5173> and sign in with `admin` or `operator` and the seed
passwords from your `.env`.

The server refuses to start with a missing or placeholder `JWT_SECRET`. That is
deliberate.

---

## Configuration

Every secret and every deployment-specific value comes from the environment.
Nothing is hard-coded, `.env` is git-ignored, and `.env.example` contains
placeholders only.

| Variable | Purpose |
|---|---|
| `PGHOST` `PGPORT` `PGDATABASE` `PGUSER` `PGPASSWORD` `PGSSL` | Database connection |
| `JWT_SECRET` `JWT_EXPIRES_IN` `JWT_ISSUER` | Session signing |
| `SEED_ADMIN_PASSWORD` `SEED_DEMO_PASSWORD` | Bootstrap accounts, used only by `db:seed` |
| `BACKEND_PORT` `BACKEND_HOST` `CORS_ORIGINS` | HTTP and WebSocket surface |
| `RATE_LIMIT_*` `MAX_REQUEST_BODY_BYTES` | Request limits |
| `UDP_INGEST_*` | Simulated UDP sensor listener, loopback-bound by default |
| `RECORD_SENSOR_MESSAGES` `RECORDER_*` | Recording volume and batching |
| `VITE_API_BASE_URL` `VITE_WS_URL` | Dashboard build-time endpoints |
| `ALLOW_ANONYMOUS_VIEWER` | Read-only demo access without sign-in. Off by default |

**Navigation behaviour** — thresholds, noise models, sensor definitions, modes
and scenarios — lives in YAML under `backend/src/config/`, not in the
environment, because it is engineering configuration that belongs under review
and version control:

| File | Contents |
|---|---|
| `default.yaml` | Every threshold: GNSS integrity, fusion, fault detection, protection level, alarms |
| `sensors.yaml` | 13 sensors with simulation and fusion parameters |
| `modes.yaml` | The 14 navigation modes, their entry predicates and operator guidance |
| `scenarios.yaml` | 15 scenarios including the guided Safeen demonstration |

Runtime changes go through `PUT /api/config` (engineer or administrator), which
enforces bounds on safety-critical paths, refuses unknown paths and type
mismatches, treats `platform.*` and `security.*` as immutable, and records every
change with old value, new value, actor and reason.

---

## Using it

### The demonstration

Sign in, open **Demonstration**, press start. Fifteen minutes, thirteen narrated
stages: healthy fix → gradual spoof → detection and exclusion → GNSS-denied
navigation → feature-poor zone → integrity not assured → recovery → 30 s
validation → reintegration → report.

The full narration, the pre-flight checklist and a what-to-do-if-it-breaks table
are in [docs/demo-script.md](docs/demo-script.md).

### Scenarios

Fifteen scenarios, all deterministic and all reproducible from their seed:

`SCN_01_HEALTHY` · `SCN_02_GNSS_JUMP` · `SCN_03_GRADUAL_DRAG` ·
`SCN_04_JAMMING` · `SCN_05_FLAT_SEABED` · `SCN_06_RADAR_LOSS` ·
`SCN_07_DVL_BOTTOM_LOCK` · `SCN_08_GYRO_BIAS` · `SCN_09_GNSS_RECOVERY` ·
`SCN_10_MULTIPLE_FAILURE` · `SCN_11_MESSAGE_INTEGRITY` · `SCN_12_FALSE_TIME` ·
`SCN_13_INS_DISABLED` · `SCN_14_LOCAL_POSITIONING` · `SCN_15_SAFEEN_DEMO`

Drive them from the **Scenarios** screen, or headless:

```bash
node scripts/run_scenario.js SCN_03_GRADUAL_DRAG    # one scenario
node scripts/run_scenario.js --all                 # regression sweep, one line each
node scripts/run_scenario.js SCN_15_SAFEEN_DEMO --json   # machine-readable, pipe to jq

node scripts/export_results.js --list              # recorded runs
node scripts/export_results.js --latest --format csv,geojson,html --out ./data/exports

npm run generate:data                              # seed demonstration history
node scripts/generate_demo_data.js --clean         # …replacing the previous set
```

### Replay

Import a recorded run as CSV or JSON on the **Scenarios** screen, or through
`POST /api/data/upload`, then start it with `POST /api/replay/{id}/start`.
Playback has full transport control. A
replay carries no ground truth unless the recording contained it — in which case
the accuracy statistics are absent and the report says so rather than inventing
them.

### Live ingestion

Real sensor data can be fed in over REST (`POST /api/data/ingest`, or
`POST /api/data/ingest/nmea` for raw sentences), the
WebSocket ingestion channel, or the UDP listener. NMEA 0183 is parsed with
checksum verification. Other transports are declared with their contracts but not
implemented — see [docs/limitations.md](docs/limitations.md) §3.

---

## Screens

**Navigation** — the main operational display: status banner, map with the
trusted position plotted separately from raw GNSS and ground truth, position and
uncertainty panels, mode and guidance.
**Sensors** — every sensor with its decision, reason, residuals and last message.
**GNSS integrity** — trust score, active conditions, evidence, classification,
recovery countdown.
**Fusion** — filter state, covariance, contributors, rejections, gate statistics.
**Alarms** — active and historical, with reason and recommended action.
**Scenarios** — catalogue, transport control, fault injection, replay import.
**Analytics** — the performance report and charts, with actual error, estimated
error and protection level kept distinct.
**Demonstration** — the guided Section 30 script.
**Configuration** — bounded runtime configuration with change history
(engineer).
**Administration** — users, roles, audit log (administrator).

Dark, high-contrast, desktop-first, laid out for a bridge monitor; responsive
down to a phone. Colour is never the only indicator. No decorative animation —
the only motion is the critical-alarm pulse, and it respects
`prefers-reduced-motion`.

**Roles:** `viewer` (read-only) · `operator` (run scenarios, acknowledge alarms,
generate reports) · `engineer` (inject faults, ingest data, change configuration,
read the audit log) · `administrator` (manage users). Hierarchical, enforced on
every mutating route, and a role change takes effect on the next request rather
than at token expiry.

Seeding creates one account per role — `admin`, `engineer`, `operator`,
`viewer` — using `SEED_ADMIN_PASSWORD` for the administrator and
`SEED_DEMO_PASSWORD` for the rest.

---

## Testing

```bash
npm test              # 196 tests
npm run test:backend  # 178 (Jest)
npm run test:frontend # 18 (Vitest + React Testing Library)
```

The API suite needs PostgreSQL; without it, it skips itself loudly and names the
reason rather than passing while testing nothing. The other 123 backend tests
need no infrastructure at all.

Eighteen real defects found by this suite — filter divergence, a bias test that
excluded every healthy sensor, an isolation logic that removed the honest sensor
instead of the lying one — are documented with their fixes in
[docs/test-plan.md](docs/test-plan.md) §9.

---

## Documentation

| Document | Read it for |
|---|---|
| [docs/architecture.md](docs/architecture.md) | Components, data flow, the fusion state, how the protection level is built term by term |
| [docs/api.md](docs/api.md) | Every endpoint, role, error shape and WebSocket frame |
| [docs/assumptions.md](docs/assumptions.md) | What is assumed and why each assumption might be wrong |
| [docs/limitations.md](docs/limitations.md) | What this is not, and what it cannot detect |
| [docs/safety.md](docs/safety.md) | Fail-safe behaviour, alarm philosophy, known undetectable conditions |
| [docs/security.md](docs/security.md) | Implemented controls, deliberate placeholders, production requirements |
| [docs/test-plan.md](docs/test-plan.md) | The suite, the measured results, the defects it found |
| [docs/demo-script.md](docs/demo-script.md) | Running the Safeen demonstration |
| [docs/roadmap.md](docs/roadmap.md) | Phases 1–6, with exit criteria and how it could fail |
| [docs/acceptance.md](docs/acceptance.md) | The 20 acceptance criteria, each with its evidence |

---

## Repository layout

```
backend/
  src/
    config/        default.yaml, sensors.yaml, modes.yaml, scenarios.yaml
    simulation/    environment, vessel model, 13 sensor simulators, RNG tree
    navigation/    pipeline, EKF, fusion, GNSS integrity, FDE, integrity,
                   mode manager, radar/bathy/LiDAR matching, dead reckoning
    adapters/      NMEA 0183, CSV, JSON, REST/WS/UDP ingest, placeholders
    services/      recorder, alarms, scenarios, auth, config, performance,
                   export, replay
    api/           routes, middleware, app
    ws/            live hub
    db/            migrations, seeds, pool
  tests/           178 Jest tests
frontend/
  src/             pages, components, map, charts, store, api, ws, hooks
  tests/           18 Vitest + RTL tests
scripts/           generate_demo_data, run_scenario, export_results, seed_database
docs/              the ten documents above
```

---

## Technology

Node.js 24 · Express 4 · `ws` · PostgreSQL 17 · zod · JWT + bcrypt · helmet ·
React 18 · TypeScript · Vite · Redux Toolkit (RTK Query) · MapLibre GL · Apache
ECharts · Tailwind CSS · Jest · Vitest · Docker.

No `eval`, no `Function` constructor and no expression parser anywhere in the
codebase — the mode state machine uses a fixed operator table, and an unsupported
operator is a startup error rather than a runtime surprise.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `JWT_SECRET is not configured` on start | Placeholder still in `.env` | Generate a real one; the refusal is deliberate |
| `password authentication failed` | `PGPASSWORD` wrong, or the user lacks schema rights | Re-run the `GRANT ALL ON SCHEMA public` statement |
| Dashboard header reads `DISCONNECTED` | Backend down, or token expired | Check `:4000/api/health`; sign in again |
| API tests all skipped | No database reachable | Expected — the other 123 backend tests still run |
| `Cannot start: a scenario is already running` | One run at a time, by design | **Reset**, then start |
| Map tiles blank | Style assets blocked | The tracks and legend still render; the basemap is optional |
| Port 4000 or 5173 in use | Something else is bound | Change `BACKEND_PORT`, or the Vite port |
| Server logs "ready" but `localhost:4000` refuses | `BACKEND_HOST` narrowed to `0.0.0.0`, which is IPv4 only, while `localhost` resolves to `::1` | Leave `BACKEND_HOST=::` (the default), or use `127.0.0.1:4000` |

---

## Licence and status

Unlicensed, proprietary to iSpatialTec. Proof of concept — **not for
navigational use**.
