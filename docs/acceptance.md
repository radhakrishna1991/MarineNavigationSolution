# Acceptance report

The twenty acceptance criteria of Section 25, each with the evidence that
demonstrates it and the command that reproduces the evidence.

**Result: 20 of 20 met.**

---

## 1. A simulated vessel moves through a mapped UAE-like harbour environment

A synthetic harbour environment around 24.52° N, 54.38° E: a shoreline, a
breakwater, quays, channel markers and jetty structures, with a bathymetric grid
containing a dredged channel, a shoal, a bank slope and a deliberately flat
basin. The vessel follows a waypoint route with rate-limited turns, tide and
squat.

The geospatial data is synthetic and is not derived from any chart or survey.
Every screen carries the demonstration-data label.

**Evidence** · `backend/src/simulation/environment.js`,
`backend/src/simulation/vesselModel.js` · the map on the Navigation screen ·
`tests/replay.test.js` "deterministic route following", "turn-rate limit",
"depth relationship".
**Reproduce** · `GET /api/geospatial/bundle` for the environment ·
`GET /api/performance/tracks?runId=…` for the vessel's track through it

## 2. Ground truth is generated and recorded

Every epoch records the true position, velocity, heading and depth. Ground truth
is carried through the pipeline separately from the solution, is never available
to any estimator, and is persisted for later comparison.

**Evidence** · `attachGroundTruth()` in `backend/src/navigation/pipeline.js` ·
the `truth` block on every epoch · the `ground_truth` table, and
`truth_error_m` on every row of `navigation_solutions`.
**Reproduce** · `GET /api/navigation/history?runId=…`

## 3. GNSS, gyro, DVL, radar, bathymetric and optional INS streams are generated

Thirteen simulated sensors: two GNSS receivers, gyrocompass, DVL, radar, LiDAR,
multibeam and single-beam echo sounders, INS, AIS, speed log, wind and an
acoustic local-ranging system. Each has its own rate, latency, noise model and
Gauss–Markov bias.

INS is genuinely optional: `SCN_13_INS_DISABLED` runs the full pipeline with no INS
fitted, and the mode machine, integrity engine and protection level all behave
correctly without it.

**Evidence** · `backend/src/config/sensors.yaml` ·
`backend/src/simulation/sensors/` · `tests/replay.test.js` "operates with no INS
fitted".
**Reproduce** · `node scripts/run_scenario.js SCN_13_INS_DISABLED`

## 4. Healthy GNSS is accepted

Over 300 epochs of realistic healthy GNSS the trust score stays at or above 76,
status remains `TRUSTED`, no condition is raised, no spoofing is claimed, and
GNSS contributes to the solution throughout. In the healthy scenario the
false-alarm count is zero.

This criterion is as important as the detection ones. A detector that rejects
healthy GNSS is not a detector.

**Evidence** · `tests/gnssIntegrity.test.js` "healthy GNSS is not falsely
rejected" · `tests/replay.test.js` "healthy scenario never falsely claims
spoofing" · the healthy scenario's report: 0 false alarms, requirement met for
99 % of the run.
**Reproduce** · `node scripts/run_scenario.js SCN_01_HEALTHY --json | jq
'.spoofing_detected_at_s'` returns `null` — nothing was ever alleged. The alarm
count itself is in `GET /api/performance/summary?runId=…` as
`false_alarm_count`.

## 5. A sudden GNSS jump is detected and GNSS is rejected

A 50 m jump with all independent sources unchanged is detected within one epoch
(0.4 s in `SCN_02`), classified as deception rather than interference, and GNSS
is excluded from the solution. The explanation names the radar disagreement that
contradicted it.

**Evidence** · `tests/gnssIntegrity.test.js` "sudden position jump detected" ·
`SCN_02_GNSS_JUMP` report: detection at 180.4 s against a fault injected at
180 s.
**Reproduce** · `node scripts/run_scenario.js SCN_02_GNSS_JUMP --json | jq '.spoofing_detected_at_s'` → `180.4`

## 6. Gradual spoofing drag is detected before reaching 20 m error

| Scenario | Drag rate | Detected at | Offset at detection | Limit |
|---|---|---|---|---|
| `SCN_03_GRADUAL_DRAG` | 0.10 m/s | 182 s (fault at 150 s) | ≈ 3.2 m | 20 m |
| `SCN_15_SAFEEN_DEMO` | 0.12 m/s | ≈ 152 s (fault at 120 s) | ≈ 3.8 m | 20 m |

Detection requires three independent signals to agree — a consistent drag rate,
a good linear fit, and an accumulated offset — so it is not tripped by noise.

**Evidence** · `tests/gnssIntegrity.test.js` "gradual drag detected before 20 m"
(asserts the offset at detection, not merely that detection occurred).
**Reproduce** · `node scripts/run_scenario.js SCN_03_GRADUAL_DRAG --json | jq
'.spoofing_detected_at_s'` for the time; the offset at that moment is asserted
by the test, and `GET /api/performance/summary?runId=…` reports
`spoofing_detection_latency_s` alongside it.

## 7. Navigation continues using radar, gyro and DVL

With GNSS excluded the solution continues on radar map matching, gyro heading,
DVL bottom-track velocity and bathymetric terrain matching. Mean horizontal error
across the GNSS-denied portion of the demonstration stays below 0.5 m and the
maximum below 3.5 m.

The fused position is asserted to stay within 10 m of ground truth throughout an
injected spoof, with the detection engines given no prior knowledge of the
injection.

**Evidence** · `tests/replay.test.js` "injected spoof detected without the
engines being told" · per-scenario mean errors in
[test-plan.md](test-plan.md) §10.

## 8. The dashboard shows the trusted fused position separately from GNSS

The map plots four distinct layers with a permanent legend: the trusted fused
position, the raw GNSS position, ground truth, and each contributing sensor's own
position estimate. The numeric panels show the fused position and the GNSS
position side by side with their separation in metres.

During a spoof the separation is the clearest thing on the screen.

**Evidence** · `frontend/src/map/MapView.tsx` · `frontend/tests/ui.test.tsx`
"legend distinguishes the trusted position from the raw GNSS position and ground
truth".

## 9. The system calculates uncertainty and horizontal protection level

Four distinct quantities, never conflated:

| Quantity | Meaning |
|---|---|
| Actual error | Against ground truth. Available in simulation only |
| Estimated error | The filter's own 1σ position uncertainty |
| Precision | The covariance error ellipse: semi-major, semi-minor, orientation |
| Horizontal protection level | The bound: `k95·√(σ_major² + σ_correlated²)·inflation + bias margin` |

Each term of the HPL is documented in [architecture.md](architecture.md) §6. No
vertical protection level is published, with a status explaining why.

**Evidence** · `backend/src/navigation/integrity.js` ·
`tests/integrity.test.js` "protection level exceeds the raw covariance term",
"accuracy, precision, confidence and integrity remain distinct".

## 10. The dashboard clearly shows whether the 2 m requirement is met

A single banner line, in words, in the largest type on the screen:
`SAFEEN <2 m REQUIREMENT: MET` / `AT RISK` / `NOT MET` / `INSUFFICIENT
INFORMATION`. Colour is never the only indicator — every status carries a glyph
and a text label, and there is no code path that renders a bare coloured dot.

`MET` additionally requires an independent absolute source. A small covariance is
not sufficient on its own, and this is asserted directly.

**Evidence** · `frontend/src/components/StatusBanner.tsx` ·
`frontend/tests/ui.test.tsx` "requirement reads MET", "changes to NOT MET" ·
`tests/integrity.test.js` "never met without an independent absolute source".

## 11. During radar loss, uncertainty grows

In `SCN_06_RADAR_LOSS` and in stages 7–8 of the demonstration, the loss of radar
features removes the last absolute source and the protection level grows
monotonically. The growth rate, the dead-reckoning duration, the time since the
last absolute fix and the dominant error contributor are all published.

**Evidence** · `tests/integrity.test.js` "grows monotonically through dead
reckoning to more than double" · `tests/fusion.test.js` dead-reckoning group (4
tests).
**Reproduce** · `node scripts/run_scenario.js SCN_06_RADAR_LOSS`

## 12. When protection level exceeds 2 m, the system declares integrity is not assured

The mode machine enters `INTEGRITY_NOT_ASSURED`, the banner turns critical, and
the operator guidance reads `VERIFY POSITION USING INDEPENDENT MEANS`. The
position is still displayed — the operator is not left blind — but nothing on the
screen claims 2 m performance.

A knowable-but-exceeded bound reports `NOT_ASSURED` rather than "insufficient
information"; this ordering was a defect that the tests found and now protect.

**Evidence** · `backend/src/config/modes.yaml` · `tests/integrity.test.js`
"INTEGRITY_NOT_ASSURED entered when integrity is lost", "definite NOT MET
preferred over insufficient information" · `frontend/tests/ui.test.tsx`
"critical operator instruction stays visible".

## 13. Bathymetric ambiguity is detected rather than hidden

Over featureless seabed the matcher returns `valid: false` with an ambiguity
reason and a terrain-observability score, rather than its best-scoring candidate.
It also refuses to match without sufficient depth history, and exposes the
candidate surface so an engineer can see *why* it was ambiguous.

**Evidence** · `backend/src/navigation/bathymetricMatching.js` ·
`tests/fusion.test.js` "reports ambiguity over featureless seabed", "refuses
without enough depth history", "exposes the candidate surface".
**Reproduce** · `node scripts/run_scenario.js SCN_05_FLAT_SEABED`

## 14. GNSS is not immediately trusted when it returns

Returning GNSS enters `RECOVERY_VALIDATION` and contributes nothing while there.
Its position is displayed and compared, but it does not influence the solution.

**Evidence** · `tests/gnssIntegrity.test.js` "recovery held for the full window"
· demonstration stage 11.

## 15. GNSS is reintegrated only after a validation period

Thirty seconds of continuous agreement, configured at
`gnss_integrity.recovery_validation_s: 30`. A fresh anomaly during the window
restarts it at zero. On reintegration the weight is ramped in over several epochs
rather than switched on, and the event is logged with its evidence.

In `SCN_09_GNSS_RECOVERY`, GNSS returns at 420 s and is reintegrated at 450.2 s —
30.2 s later.

**Evidence** · `tests/gnssIntegrity.test.js` "recovery window restarts on a new
anomaly" · `tests/integrity.test.js` "recovery window is the configured value".

## 16. Every exclusion, alarm, transition and reintegration event is logged

Persisted to PostgreSQL: `navigation_solutions`, `sensor_messages`,
`sensor_residuals`, `sensor_health_snapshots`, `gnss_trust_records`,
`mode_transitions`, `alarms`, `scenario_events`, `scenario_runs`,
`performance_reports`, `config_overrides`, `ground_truth` and `audit_log`.

Every exclusion carries a plain-language sentence naming the evidence. Every mode
transition carries a human-readable reason. Every alarm carries a reason and a
recommended action. The audit log is append-only, enforced by a PL/pgSQL trigger
that raises on UPDATE and DELETE — independent of application code, and tested at
the database level.

**Evidence** · `backend/src/db/migrations/` · `tests/api.test.js` "audit log
rejects UPDATE and DELETE".
**Reproduce** · `GET /api/navigation/mode-transitions?runId=…` ·
`GET /api/alarms?runId=…` · `GET /api/auth/audit` (engineer)

## 17. A performance report compares the fused position against ground truth

All twenty Section 26 fields are produced: scenario name, start and end time,
duration, GNSS outage duration, mean/median/RMS/p95/p99/maximum error, percentage
of time below 2 m, percentage of time integrity was assured, spoofing detection
time, GNSS rejection time, false-alarm count, time to GNSS recovery, sensor
availability, mode durations, alarm count and the compliance result.

Actual error, estimated error and protection level are reported as three separate
quantities and are never conflated. The report additionally publishes the
misleading-information rate — epochs where actual error exceeded the published
protection level while the requirement was reported as met — which the
specification does not ask for and which is the number that matters most.

If a run has no ground truth (an imported replay), the accuracy statistics are
absent and the report says so rather than inventing them.

**Evidence** · `backend/src/services/performanceService.js` ·
`tests/api.test.js` performance group · Analytics screen · exports in CSV, JSON,
GeoJSON, KML and HTML.

## 18. The full system runs locally using Docker Compose

```bash
cp .env.example .env      # set POSTGRES_PASSWORD and JWT_SECRET
docker compose up --build
```

Three services: PostgreSQL 17, the backend (Node 24, multi-stage build, non-root)
and the dashboard (nginx serving the built SPA and reverse-proxying the API and
WebSocket, with a CSP). Migrations and seeding run on start. Health checks and
ordered start-up are defined. The database is not published outside the internal
network by default.

**Evidence** · `docker-compose.yml`, `backend/Dockerfile`,
`frontend/Dockerfile`, `frontend/nginx.conf`.

## 19. Automated tests pass

**248 tests: 185 backend, 63 frontend.** Run with `npm test`.

Every one of the twenty-one defects listed in [test-plan.md](test-plan.md) §9 was
found by a test that was written to fail, investigated, and kept.

The API suite requires PostgreSQL; without it, it skips itself loudly and names
the reason, rather than passing while testing nothing. The remaining 123 backend
tests need no infrastructure at all.

**Evidence** · [test-plan.md](test-plan.md).
**Reproduce** · `npm test`

## 20. Setup and demo instructions are complete

| Document | Covers |
|---|---|
| [README.md](../README.md) | Prerequisites, local setup, Docker, environment, scripts, troubleshooting |
| [demo-script.md](demo-script.md) | The Section 30 demonstration, stage by stage, with narration and a failure playbook |
| [architecture.md](architecture.md) | Components, data flow, algorithms, technology choices |
| [api.md](api.md) | Every endpoint, role, error shape and WebSocket frame |
| [assumptions.md](assumptions.md) | What is assumed and why it might be wrong |
| [limitations.md](limitations.md) | What this is not |
| [safety.md](safety.md) | Fail-safe behaviour and known undetectable conditions |
| [security.md](security.md) | Implemented, placeholder and future-requirement controls |
| [test-plan.md](test-plan.md) | The suite, the results, and the defects it found |
| [roadmap.md](roadmap.md) | Phases 1–6, with exit criteria and failure modes |

---

## Summary

| # | Criterion | Status |
|---|---|---|
| 1 | Simulated vessel in a mapped harbour | Met |
| 2 | Ground truth generated and recorded | Met |
| 3 | All sensor streams, INS optional | Met |
| 4 | Healthy GNSS accepted | Met |
| 5 | Sudden jump detected and rejected | Met |
| 6 | Gradual drag detected before 20 m | Met — at ≈3.2 m |
| 7 | Navigation continues without GNSS | Met |
| 8 | Fused position shown separately from GNSS | Met |
| 9 | Uncertainty and protection level calculated | Met |
| 10 | 2 m requirement status clearly shown | Met |
| 11 | Uncertainty grows during radar loss | Met |
| 12 | Integrity not assured when HPL > 2 m | Met |
| 13 | Bathymetric ambiguity detected | Met |
| 14 | Returning GNSS not immediately trusted | Met |
| 15 | Reintegration only after validation | Met — 30 s |
| 16 | All events logged | Met — append-only |
| 17 | Performance report against ground truth | Met — plus MI rate |
| 18 | Runs on Docker Compose | Met |
| 19 | Automated tests pass | Met — 248 |
| 20 | Setup and demo instructions complete | Met |

**The scope of this acceptance.** These twenty criteria are met by a proof of
concept running on simulated data and synthetic geospatial data. They do not
constitute evidence of performance at sea, and nothing here has type approval,
classification-society review or flag acceptance. What would be needed for that
is set out in [roadmap.md](roadmap.md).
