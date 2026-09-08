# API reference

Base URL `http://localhost:4000` (development) or same-origin behind the
dashboard's nginx (`docker compose`). All endpoints are under `/api`.

---

## Authentication

All endpoints except `GET /api/health` and `GET /api` require a bearer token.

```http
POST /api/auth/login
Content-Type: application/json

{ "username": "operator", "password": "..." }
```

```json
{ "token": "eyJ…", "user": { "id": "…", "username": "operator", "role": "operator" }, "expires_in": "8h" }
```

Send it on every subsequent request:

```http
Authorization: Bearer eyJ…
```

A failed login returns `401` with a single generic message regardless of cause,
so the endpoint cannot be used to enumerate accounts. Login attempts are rate
limited (30 per 15 minutes per address, successful attempts not counted) and an
account locks after 8 consecutive failures.

### Roles

Hierarchical — each role includes everything below it.

| Role | Can |
|---|---|
| `viewer` | Read every panel |
| `operator` | + start/pause/stop/reset scenarios, acknowledge alarms, generate reports, run replays |
| `engineer` | + inject faults, change configuration, ingest data, import replays, read the audit log |
| `administrator` | + manage users |

A role violation returns `403` with `required_role` and `your_role`, so the
client can explain the refusal rather than just failing.

---

## Errors

Every error is JSON with a stable shape:

```json
{
  "error": "VALIDATION_FAILED",
  "message": "The request could not be accepted.",
  "correlation_id": "err_m1abcd_x7f2q9",
  "details": [{ "field": "speedMultiplier", "message": "Number must be less than or equal to 50" }]
}
```

Internal detail is never returned. The `correlation_id` appears in the server log
line for the same request, so an operator can quote it and an engineer can find
it.

| Status | Meaning |
|---|---|
| 400 | Validation failed, or a value outside its permitted range |
| 401 | Not authenticated, or the session expired |
| 403 | Authenticated but the role is insufficient |
| 404 | No such resource |
| 405 | Attempted a write on the read-only navigation surface |
| 409 | Conflicting state (e.g. stepping while running) or a duplicate record |
| 429 | Rate limited |
| 503 | Database unreachable — navigation continues, recording may be incomplete |

---

## Health and system

### `GET /api/health` — unauthenticated

```json
{ "status": "ok", "uptime_s": 1986, "version": "1.0.0",
  "database": { "ok": true, "latency_ms": 12 }, "timestamp": "…" }
```

Returns `503` when the database is unreachable, so an orchestrator can act on it.

### `GET /api` — unauthenticated

Machine-readable description of the platform, including the endpoint list and
the statement that it has no control outputs.

### `GET /api/system/status`

Full status: platform identity, uptime, database health and row counts, scenario
and replay runtime, recorder statistics, alarm summary, WebSocket clients,
ingestion configuration, process memory.

### `GET /api/system/adapters`

The adapter catalogue, each entry stating `IMPLEMENTED` or `PLACEHOLDER`, its
transport, and — for placeholders — the input/output contract and what
completing it would need.

### `GET /api/system/modes`

All 14 navigation modes with entry conditions, active and rejected sensors,
expected accuracy, uncertainty behaviour, operator alarm level, operator
guidance, exit conditions and permitted successors.

---

## Sensors

### `GET /api/sensors`

Every configured sensor with its class description, interface, nominal rate, what
it provides, whether it is an absolute position source, and its live health.

### `GET /api/sensors/{sensor_id}`

One sensor, plus its most recent messages and residual history for the current
run.

---

## Navigation — read only

> The navigation surface refuses `POST`, `PUT`, `PATCH` and `DELETE` with `405`
> and an explanation. This platform provides decision support and has no control
> interface to autopilot, dynamic positioning, propulsion or steering gear.

### `GET /api/navigation/current`

The complete trusted navigation output for the current epoch — everything the
main screen needs, so a client that missed WebSocket frames can resynchronise.

Abbreviated:

```json
{
  "available": true,
  "navigation": {
    "time_s": 182.4,
    "timestamp_utc": "2024-11-18T06:03:02.400Z",
    "trusted_position": { "latitude": 24.5102, "longitude": 54.3501, "east_m": 10.2, "north_m": 22.4 },
    "velocity": { "north_mps": 3.2, "east_mps": 0.4, "speed_mps": 3.22 },
    "heading_deg": 7.6,
    "solution_available": true,
    "solution_confidence": 0.86,
    "navigation_mode": "RADAR_AIDED_NAVIGATION",
    "navigation_mode_detail": { "label": "Radar-Aided Navigation", "operator_guidance": "…" },
    "integrity": {
      "horizontal_protection_level_m": 1.42,
      "vertical_protection_level_m": null,
      "vertical_protection_level_status": "NOT_IMPLEMENTED_NO_INDEPENDENT_VERTICAL_REFERENCE",
      "estimated_horizontal_error_m": 0.31,
      "radius_95_m": 0.52, "radius_99_m": 0.65,
      "confidence_ellipse": { "semi_major_m": 0.52, "semi_minor_m": 0.46, "orientation_deg": 42.1 },
      "bias_margin_m": 0.19, "correlated_sigma_m": 0.36, "observed_disagreement_m": 0,
      "protection_level_inflation": 1.35,
      "protection_level_inflation_reasons": ["SINGLE_ABSOLUTE_SOURCE"],
      "integrity_status": "ASSURED",
      "requirement_status": "REQUIREMENT_MET",
      "requirement_reasons": ["Protection level 1.42 m is within the 2 m limit at 95% confidence…"],
      "independent_absolute_sources": 1,
      "sensor_diversity_score": 0.6,
      "dead_reckoning_duration_s": 0,
      "time_since_last_absolute_fix_s": 0.4
    },
    "gnss": {
      "trust_score": 0, "status": "REJECTED", "recommended_action": "EXCLUDE_FROM_FUSION",
      "detected_conditions": ["GRADUAL_POSITION_DRAG", "RADAR_POSITION_DISAGREEMENT"],
      "spoofing_suspected": true, "used_in_fusion": false,
      "explanation": "GNSS is not trusted because the offset from the independent solution is walking away at 0.118 m/s (R² 0.97) and it differs from radar localization by 12.4 m.",
      "recovery": null,
      "diagnostics": { "diff_from_radar_m": 12.4, "drag_rate_m_per_s": 0.118, "…": null }
    },
    "localization": { "radar": {…}, "lidar": {…}, "bathymetric": {…}, "local_ranging": {…}, "dead_reckoning": {…} },
    "contributing_sensors": ["RADAR_01", "GYRO_01", "DVL_01"],
    "excluded_sensors": ["GNSS_01"],
    "sensor_health": [ … ],
    "ground_truth": { … },
    "actual_error_vs_truth_m": 0.41
  },
  "scenario": { … }, "replay": { … }
}
```

`ground_truth` and `actual_error_vs_truth_m` exist **only in simulation**. They
are never used by any engine.

### Other navigation endpoints

| Endpoint | Returns |
|---|---|
| `GET /api/navigation/history?runId&from&to&limit&stride` | Recorded solutions, decimated server-side |
| `GET /api/navigation/gnss` | Current trust assessment, recent history, thresholds and score bands |
| `GET /api/navigation/integrity` | Integrity detail, filter debug state, thresholds, and the terminology table |
| `GET /api/navigation/localization` | Radar/LiDAR/local-ranging engine results including the Mode A vs Mode B choice |
| `GET /api/navigation/bathymetric` | Terrain-matching detail including the candidate surface |
| `GET /api/navigation/mode-transitions?runId` | Every mode change with its reason |

---

## Scenarios

| Endpoint | Role | Purpose |
|---|---|---|
| `GET /api/scenarios` | viewer | Catalogue with scripted faults and demo steps |
| `GET /api/scenarios/status` | viewer | Runtime status |
| `GET /api/scenarios/fault-types` | viewer | The fault catalogue with parameter specs |
| `POST /api/scenarios/{id}/start` | operator | `{ speedMultiplier?, insEnabled?, seed?, label? }` |
| `POST /api/scenarios/pause` \| `resume` \| `stop` \| `reset` | operator | Transport |
| `POST /api/scenarios/step` | operator | `{ seconds }` — only while paused |
| `POST /api/scenarios/speed` | operator | `{ speedMultiplier }` — 0.5, 1, 2, 5 or 10 |
| `POST /api/scenarios/jump` | operator | `{ timeS }` — forward only |
| `POST /api/scenarios/manual-fallback` | operator | `{ enabled }` |
| `POST /api/scenarios/inject-fault` | engineer | `{ type, sensor_id, duration_s?, params? }` |
| `POST /api/scenarios/remove-fault` | engineer | `{ faultId }` |

Starting a scenario stops anything running and opens a new recorded run.

---

## Alarms

| Endpoint | Role | Purpose |
|---|---|---|
| `GET /api/alarms` | viewer | Filter by `runId`, `severity`, `code`, `source`, `active`, `acknowledged`, `search`, `from`, `to`, with `limit`/`offset` |
| `GET /api/alarms/active` | viewer | Currently active only |
| `POST /api/alarms/{id}/acknowledge` | operator | Records that it was seen |
| `POST /api/alarms/acknowledge-all` | operator | |

**Acknowledgement does not clear an alarm.** An acknowledged alarm whose
condition is still present stays active and stays visible. The response says so
explicitly.

---

## Performance and export

| Endpoint | Role | Purpose |
|---|---|---|
| `GET /api/runs` | viewer | Recorded runs |
| `GET /api/performance/summary?runId` | viewer | The full report (Section 26) |
| `GET /api/performance/timeseries?runId&maxPoints` | viewer | Decimated series for charts |
| `GET /api/performance/tracks?runId` | viewer | Fused, ground-truth and raw GNSS tracks |
| `POST /api/performance/report` | operator | Generate and store a report |
| `GET /api/performance/reports?runId` | viewer | Previously generated reports |
| `GET /api/export?dataset&format&runId` | viewer | See below |

Datasets: `navigation`, `ground_truth`, `sensor_messages`, `gnss_trust`,
`residuals`, `alarms`, `mode_transitions`, `scenario_events`, `sensor_health`,
`audit`, `report`.
Formats: `csv`, `json`, `geojson`, `kml`, `html` (printable report).

The report keeps three quantities strictly apart, each with its provenance
stated in the payload: **actual error** (against simulated ground truth),
**estimated error** (from the covariance) and **protection level** (the bound).
It also reports the **misleading information rate** — epochs where the actual
error exceeded the published bound while the requirement was reported as met.

---

## Configuration

| Endpoint | Role | Purpose |
|---|---|---|
| `GET /api/config` | viewer | Effective values, defaults, current overrides, editable bounds |
| `PUT /api/config` | engineer | `{ updates: { "requirements.horizontal_error_limit_m": 2.5 }, note? }` |
| `POST /api/config/reset` | engineer | `{ paths?: string[] }` — omit to reset everything |
| `GET /api/config/history` | engineer | Change history with actor and reason |

Guard rails: only paths that exist in the shipped defaults may be set; the value
must have the same type as the default; safety-critical paths carry explicit
bounds; `platform.*` and `security.*` cannot be changed at runtime; and
cross-field consistency is checked (the at-risk bound must be below the limit).
Every change is applied to the live engines and written to the audit log with
both the old and the new value.

---

## Data ingestion

Separated from the rest of the API by role and by rate limit.

| Endpoint | Role | Purpose |
|---|---|---|
| `POST /api/data/ingest` | engineer | `{ messages: [ …internal sensor messages… ] }`, up to 5000 |
| `POST /api/data/ingest/nmea` | engineer | `{ sentences: "$GPGGA,…\n$HEHDT,…" }` |
| `POST /api/data/validate` | viewer | Would this message be accepted? No side effects |
| `GET /api/data/schema` | viewer | The internal message schema, with an example and the rules |
| `GET /api/data/status` | viewer | Ingestion counters |
| `POST /api/data/upload` | engineer | `{ name, format: "csv"\|"json", content }` — creates a replay session |

Simulated UDP ingestion listens on `127.0.0.1:5005` by default and accepts either
JSON messages or raw NMEA sentences, size-limited and rate-limited per source.

---

## Replay

| Endpoint | Role | Purpose |
|---|---|---|
| `GET /api/replay/sessions` | viewer | Sessions and current replay status |
| `POST /api/replay/from-run` | engineer | `{ runId, name? }` |
| `POST /api/replay/{id}/start` | operator | `{ speedMultiplier? }` |
| `POST /api/replay/pause` \| `resume` \| `stop` | operator | |
| `DELETE /api/replay/{id}` | engineer | |

A replay drives the same navigation pipeline as the live simulator. If the
recording carries no ground truth, accuracy statistics are absent — the report
says so rather than inventing them.

---

## Geospatial

| Endpoint | Purpose |
|---|---|
| `GET /api/geospatial/bundle` | Every map layer plus bathymetry metadata and control points |
| `GET /api/geospatial/layers` | Layer list |
| `GET /api/geospatial/layers/{id}` | One layer as GeoJSON |
| `GET /api/geospatial/bathymetry?stride` | Depth grid, decimated server-side |
| `GET /api/geospatial/depth?latitude&longitude` | Point depth lookup |

Every response carries the label **"Demonstration geospatial data — not for
navigation."**

---

## Users and audit

| Endpoint | Role | Purpose |
|---|---|---|
| `GET /api/auth/me` | any | Current user |
| `POST /api/auth/change-password` | any | `{ currentPassword, newPassword }` |
| `GET /api/auth/users` | administrator | |
| `POST /api/auth/users` | administrator | `{ username, fullName, email?, role, password }` |
| `PUT /api/auth/users/{id}` | administrator | Any of `fullName`, `email`, `role`, `isActive`, `password`, `unlock` |
| `DELETE /api/auth/users/{id}` | administrator | Refuses self-deletion and the last administrator |
| `GET /api/auth/audit` | engineer | Filter by `action`, `actorId`, `from`, `to`, `search` |

The audit log is append-only. The application issues no update or delete against
it, and a database trigger enforces that independently of the application code.

---

## WebSocket — `/ws/live`

```js
const ws = new WebSocket(`ws://localhost:4000/ws/live?token=${token}`);
ws.onopen = () => ws.send(JSON.stringify({
  type: 'subscribe',
  channels: ['navigation', 'alarms', 'scenario', 'replay', 'system']
}));
```

Authentication is the same JWT. An invalid token closes the socket with code
`4401`; the client must not retry with the same token.

**Server frames**

| `type` | Contains |
|---|---|
| `hello` | Server time, user, channels, platform identity |
| `navigation` | The full navigation output, active alarms, scenario and replay status (5 Hz) |
| `alarm` | A newly raised alarm |
| `alarm_cleared` / `alarm_acknowledged` | Alarm lifecycle |
| `mode_transition` | A mode change with its reason |
| `scenario` / `replay` | Runtime state changes |
| `error` | `{ error, message }` |

**Client frames**

| `type` | Purpose |
|---|---|
| `ping` | Answered with `pong` |
| `subscribe` | `{ channels: [...] }` |
| `ingest` | `{ messages: [...] }` — requires the engineer role |

Back-pressure: if a client's send buffer exceeds 1 MB, frames are dropped for
that client and counted. A stale display that is honest about being stale is
better than one running minutes behind while memory grows.

---

## Rate limits

| Scope | Limit |
|---|---|
| `/api/*` | 600 requests per minute per address |
| `/api/auth/login` | 30 per 15 minutes per address, successes not counted |
| Ingestion endpoints | 6000 per minute per address |
| UDP ingestion | 2000 datagrams per second per source |

All configurable through the environment.
