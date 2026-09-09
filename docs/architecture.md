# Architecture

**iSpatialTec Assured Marine Navigation Platform (AMNP)**
Proof of concept · decision support only · not a certified navigation product.

---

## 1. What this system is for

Safeen needs to know, continuously and honestly, whether the vessel's horizontal
position error is bounded below 2 metres — and to be told *before* that stops
being true, not after.

The platform is therefore not a positioning system. It is a **navigation
assurance layer**: it consumes whatever sensors a vessel already has, decides
which of them can be trusted right now, combines the trustworthy ones, quantifies
the uncertainty, and states plainly whether the requirement is met.

The governing principle, which every design decision below follows from:

> GNSS is one potentially untrusted sensor. Nothing is believed because of what
> it claims about itself; things are believed because they agree with
> independent measurements that could not have been influenced together.

---

## 2. Component diagram

```
┌───────────────────────────────────────────────────────────────────────────────┐
│                                  SOURCES                                      │
│                                                                               │
│  GNSS   Gyro   DVL   Speed log   Radar   LiDAR   Echo sounder   Multibeam     │
│  INS (optional)   Local ranging (UWB/terrestrial/acoustic)   AIS (advisory)   │
│  Ground truth (simulation only — never enters the pipeline)                   │
└───────────────────────────────┬───────────────────────────────────────────────┘
                                │
┌───────────────────────────────▼───────────────────────────────────────────────┐
│  ADAPTER LAYER                          backend/src/adapters/                 │
│                                                                               │
│  Simulator │ NMEA 0183 │ CSV │ JSON │ REST │ WebSocket │ UDP                  │
│  Placeholders with declared contracts: NMEA 2000, IEC 61162-450, TCP, MQTT,   │
│  ROS bag, PCAP, survey acquisition export                                     │
│                                                                               │
│  Every adapter emits the SAME internal sensor message. Below this line the    │
│  pipeline cannot tell a simulated sensor from a real one.                     │
└───────────────────────────────┬───────────────────────────────────────────────┘
                                │  validated internal sensor messages
┌───────────────────────────────▼───────────────────────────────────────────────┐
│  NAVIGATION PIPELINE                    backend/src/navigation/pipeline.js    │
│                                                                               │
│  1. Time update ──────────────► prior pose captured HERE, before any          │
│     (heading propagated by      measurement is applied. Every consistency     │
│      the gyro's rate of turn)   check uses this same untainted prior.         │
│                                                                               │
│  2. Ingestion validation ─────► schema, sequence, timestamp order, staleness, │
│     faultDetection.js           frozen values, quality flags                  │
│                                                                               │
│  3. Localization engines ─────► radar & LiDAR map matching (Mode A vendor fix │
│     radarMatching.js            / Mode B independent ICP), bathymetric        │
│     bathymetricMatching.js      terrain matching, local ranging,              │
│     localPositioning.js         independent dead reckoning                    │
│     deadReckoning.js                                                          │
│                                                                               │
│  4. GNSS trust engine ────────► 25 named conditions, debounced, scored,       │
│     gnssIntegrity.js            classified as interference or deception,      │
│                                 recovery-validation state machine             │
│                                                                               │
│  5. Sensor fusion (EKF) ──────► heading, then velocity, then absolute         │
│     fusion/ekf.js               positions, GNSS last and only if permitted.   │
│     fusion/fusionEngine.js      Measurements time-aligned to the epoch.       │
│                                                                               │
│  6. Fault detection,          ► residual monitoring, isolation, exclusion,    │
│     isolation and exclusion     controlled reintegration                      │
│     faultDetection.js                                                         │
│                                                                               │
│  7. Integrity engine ─────────► protection level, confidence radii,           │
│     integrity.js                integrity status, requirement status.         │
│                                 SEPARATE from fusion, by design.              │
│                                                                               │
│  8. Mode state machine ───────► 14 modes, transitions defined in YAML         │
│     modeManager.js              and evaluated by a declarative interpreter    │
└───────────────────────────────┬───────────────────────────────────────────────┘
                                │  trusted navigation output
        ┌───────────────────────┼────────────────────────┐
        ▼                       ▼                        ▼
┌───────────────┐    ┌────────────────────┐    ┌──────────────────────┐
│ WebSocket hub │    │ Recorder           │    │ REST API             │
│ /ws/live      │    │ buffered, batched  │    │ read-only navigation │
│ 5 Hz          │    │ audit trail        │    │ surface              │
└───────┬───────┘    └─────────┬──────────┘    └──────────┬───────────┘
        │                      ▼                          │
        │            ┌──────────────────┐                 │
        │            │ PostgreSQL 17    │                 │
        │            │ append-only      │                 │
        │            │ audit log        │                 │
        │            └──────────────────┘                 │
        └──────────────────┬───────────────────────────────┘
                           ▼
        ┌──────────────────────────────────────┐
        │ React dashboard (Vite, MapLibre,     │
        │ ECharts, Redux Toolkit, Tailwind)    │
        └──────────────────────────────────────┘

  NO PATH EXISTS FROM THIS SYSTEM TO AUTOPILOT, DP, PROPULSION OR STEERING GEAR.
```

---

## 3. Data-flow diagram

```
  sensor message
        │
        ▼
  ┌───────────────┐   reject ──► recorded with the reason, never forwarded
  │ schema valid? │
  └───────┬───────┘
          │ yes
          ▼
  ┌────────────────────────┐  reject ──► DUPLICATE_MESSAGE / OUT_OF_ORDER /
  │ sequence, order, age,  │             STALE_DATA / FROZEN_VALUE /
  │ freshness, flags       │             INVALID_QUALITY_FLAGS
  └───────┬────────────────┘
          │ accept
          ▼
  ┌──────────────────────────────────────────────────────────────┐
  │ dispatch by type                                             │
  │                                                              │
  │  GYRO ─────► heading measurement (bias state estimated)       │
  │  DVL/LOG ──► body-frame velocity (scale factor estimated)     │
  │  RADAR ────► map matching ──► absolute position + heading     │
  │  LIDAR ────► map matching ──► absolute position               │
  │  ECHO ─────► depth buffer ──► terrain matching ──► position   │
  │  LOCAL ────► trilateration ──► absolute position              │
  │  INS ──────► velocity; heading MONITORED only when a gyro     │
  │              is available                                     │
  │  GNSS ─────► trust engine ──► use / de-weight / exclude       │
  │  AIS ──────► advisory display only, never fused               │
  └──────────────────────────┬───────────────────────────────────┘
                             ▼
        ┌────────────────────────────────────────┐
        │ EKF: 7 states in a local ENU frame     │
        │ [E, N, vE, vN, heading, gyroBias, s]   │
        │ gated, Joseph-form covariance update   │
        └───────────────┬────────────────────────┘
                        ▼
        ┌───────────────────────────────────────────────┐
        │ Integrity engine (separate)                   │
        │                                               │
        │ HPL = k95 · √(σ_major² + σ_correlated²)        │
        │        · inflation  +  bias margin            │
        │                                               │
        │ bias margin = max(                            │
        │    floor,                                     │
        │    fault-slope term (undetectable bias),      │
        │    observed disagreement between sources,     │
        │    residual contamination after an exclusion) │
        └───────────────┬───────────────────────────────┘
                        ▼
        requirement status  ·  integrity status  ·  navigation mode
```

---

## 4. Internal sensor message model

Defined and enforced in `backend/src/models/sensorMessage.js`. This is the trust
boundary: anything that passes it is treated as a real measurement.

```json
{
  "sensor_id": "GNSS_01",
  "sensor_type": "GNSS",
  "timestamp_utc": "2024-11-18T06:02:00.400Z",
  "sequence_number": 601,
  "position":  { "latitude": 24.51, "longitude": 54.35, "altitude_m": 1.6 },
  "velocity":  { "north_mps": 3.2, "east_mps": 0.4, "down_mps": 0.0 },
  "heading_deg": 7.6,
  "depth_m": null,
  "quality": { "satellites": 14, "hdop": 0.82, "cn0_mean_dbhz": 45.3,
               "fix_type": "RTK_FIXED", "reported_accuracy_m": 1.28,
               "position_covariance": [0.64, 0, 0, 0.64] },
  "raw": { "constellation": "GPS+GAL+BDS" },
  "valid": true
}
```

Rules enforced by the schema, each for a reason:

| Rule | Why |
|---|---|
| Unknown top-level fields are **rejected**, not ignored | An ignored field is an undetected integration mismatch. |
| `sensor_id` is restricted to `[A-Za-z0-9_-.:]` | It reaches log lines, file names and SQL parameters. |
| `timestamp_utc` must be ISO-8601 with an offset | "Local time" on a vessel crossing a boundary is ambiguous. |
| Positions, velocities and depths are range-checked | A latitude of 91° is not a measurement. |
| `NaN` and `Infinity` are rejected | They propagate silently through a filter and poison it. |
| `sequence_number` must not repeat | Duplicate application shrinks the covariance dishonestly. |

Sensor-specific data lives in `quality` (a permissive but typed block) and `raw`
(free-form, retained for audit). A new sensor type needs no migration.

---

## 5. Fusion state

Extended Kalman Filter, 7 states, in a **local East-North-Up tangent plane**
anchored at the harbour reference point and converted to WGS84 only for display.

| # | State | Unit | Why it is a state |
|---|---|---|---|
| 0 | east | m | position |
| 1 | north | m | position |
| 2 | velocity east | m/s | needed for prediction and for time-alignment |
| 3 | velocity north | m/s | |
| 4 | heading | rad | rotates the DVL body-frame velocity into the local frame |
| 5 | gyro bias | rad | a compass drifts; without this the drift leaks into the track |
| 6 | speed scale | – | a log's calibration error is systematic, not noise |

Design decisions worth stating explicitly:

- **Heading is propagated using the gyrocompass rate of turn.** A heading state
  driven only by random-walk process noise cannot follow an 8 °/s alteration of
  course: the innovations become enormous, the gyro is gated out as an outlier,
  and the solution collapses at exactly the moment the vessel manoeuvres.
- **The DVL supplies body-frame velocity, and the filter rotates it.** Supplying
  a pre-rotated NED velocity would hide the coupling between a heading error and
  a position error, which is precisely the coupling that matters.
- **Radar map matching corrects heading as well as position.** Heading and gyro
  bias are only *jointly* observable from a compass; without an absolute heading
  reference they drift together while the gyro innovation stays near zero, and
  the track quietly curves away.
- **Joseph-form covariance update**, so the covariance stays positive
  semi-definite even when a measurement covariance has been inflated at runtime.
- **Measurements are time-aligned to the epoch.** Each sensor reports a position
  that was true when it was sampled. At 3.5 m/s, 300 ms of radar processing is a
  full metre of systematic lag — the same size as the quantity being measured.
- **Divergence recovery.** A filter whose state has run away rejects every honest
  measurement. After a configurable number of consecutive gate failures from a
  trusted absolute source, the filter resets onto it. The reset is alarmed and
  recorded; it is never silent, because a reset means the preceding solution was
  wrong.

---

## 6. Integrity calculation

The integrity engine is deliberately **separate from the filter**. A filter that
grades its own homework is the exact failure mode this platform exists to
prevent.

```
σ_major        largest eigenvalue √ of the horizontal position covariance
σ_correlated   irreducible slowly-varying error, combined across sources in
               inverse variance (GNSS multipath and lever arm, radar/LiDAR map
               registration, bathymetric datum and tide, beacon survey error)

inflation      × 1.35  only one absolute source
               × 1.80  no absolute source
               × 1.50  an unresolved critical fault is being carried

bias margin    max of
               · a configured floor
               · fault slope: gain_i · T_gate · σ_i, maximised over sources —
                 the largest bias that could hide under the detection threshold
               · the OBSERVED disagreement between two sources both currently in
                 the solution, less what their own uncertainties explain
               · residual contamination left by a source that has just been
                 excluded, decaying as the survivors re-anchor the solution

HPL = k95 · √(σ_major² + σ_correlated²) · inflation  +  bias margin
```

The third and fourth bias-margin terms are what keep the bound honest during a
slow spoof. Between "the drag has started" and "GNSS has been excluded", the
covariance is small — the filter is confident, and wrong. Without those terms the
platform would publish a tight protection level at precisely the moment the
number matters most.

### Vocabulary (Section 13 — these are not interchangeable)

| Term | Meaning here | Where it appears |
|---|---|---|
| **accuracy** | closeness to truth; only measurable against a reference | performance report only, never live |
| **precision** | the spread of the estimate: the filter covariance | `sigma_east_m`, ellipse |
| **confidence** | a probability statement about a stated region | 95 % / 99 % radii |
| **integrity** | the ability to *bound* the error and warn when the bound fails | protection level, integrity status |
| **availability** | whether a usable solution exists at all | `solution_available` |
| **continuity** | whether it will keep existing for the intended operation | DR duration, growth rate |

**Vertical protection level is not published.** The platform has no independent
vertical reference beyond the echo sounder; a VPL derived from it alone would be
misleading. The field is present, null, and carries a status explaining why.

---

## 7. Navigation mode state machine

Fourteen modes, defined as **data** in `backend/src/config/modes.yaml` and
evaluated by a small declarative predicate interpreter — `{field, op, value}`
with `all` / `any` / `not`. There is no expression parsing and no dynamic
evaluation, so the "no arbitrary code execution" requirement is satisfiable by
inspection. An unsupported operator is a startup error, not a silent false.

Modes are evaluated in ascending priority; the first satisfied mode that is also
a declared successor of the current mode wins. A minimum dwell time damps
flapping, and `MANUAL_FALLBACK` latches until the operator clears it.

```
priority  mode                            entered when
    5     MANUAL_FALLBACK                 operator request (latching)
   10     INTEGRITY_NOT_ASSURED           no solution, integrity NOT_ASSURED,
                                          or DR beyond its limit with no source
   20     SPOOFING_SUSPECTED              deception signature confirmed
   25     JAMMING_SUSPECTED               interference signature confirmed
   30     GNSS_RECOVERY_VALIDATION        GNSS returned, validation running
   35     GNSS_REJECTED                   GNSS out, no aiding source yet
   40     LOCAL_POSITIONING_MODE          local ranging is the absolute fix
   45     RADAR_AIDED_NAVIGATION          radar matching is the absolute fix
   50     LIDAR_AIDED_NAVIGATION          LiDAR matching is the absolute fix
   55     BATHYMETRIC_AIDED_NAVIGATION    terrain matching is the absolute fix
   60     INS_AIDED_NAVIGATION            inertial propagation only
   65     DEAD_RECKONING                  gyro + log propagation only
   70     GNSS_DEGRADED                   GNSS used but de-weighted
   80     NORMAL_GNSS                     GNSS healthy and corroborated
```

**Mode and requirement status are separate concerns.** The mode says *how* the
position is being maintained; the requirement status says *whether 2 m holds*. A
vessel navigating perfectly well on radar with a 2.6 m protection level has not
met the requirement, but its integrity is not "unassured" — it is bounded, and
the operator is told the bound. Merging the two would hide which source is
actually holding the position up.

---

## 8. Repository structure

```
assured-marine-navigation/
├── docker-compose.yml            postgres + backend + dashboard, no cloud
├── .env.example                  every secret, none of them in source
├── docs/                         this file and its companions
├── backend/
│   ├── src/
│   │   ├── index.js              wiring, startup, graceful shutdown
│   │   ├── app.js                Express assembly
│   │   ├── config/               default.yaml · modes.yaml · sensors.yaml
│   │   │                         scenarios.yaml · loader
│   │   ├── models/               internal message schema, enums
│   │   ├── db/                   schema.sql · migrate · seed · pool
│   │   ├── adapters/             NMEA 0183, CSV, JSON, UDP, catalogue
│   │   ├── geospatial/           synthetic harbour, bathymetry, maps
│   │   ├── simulation/           vessel · sensors · faults · engine
│   │   ├── navigation/
│   │   │   ├── pipeline.js       the orchestrator
│   │   │   ├── fusion/           ekf.js · fusionEngine.js
│   │   │   ├── deadReckoning.js
│   │   │   ├── radarMatching.js  Mode A and Mode B
│   │   │   ├── pointCloudMatch.js  trimmed ICP + spatial index
│   │   │   ├── bathymetricMatching.js
│   │   │   ├── localPositioning.js
│   │   │   ├── gnssIntegrity.js
│   │   │   ├── faultDetection.js
│   │   │   ├── integrity.js
│   │   │   └── modeManager.js
│   │   ├── services/             scenario · replay · alarms · recorder ·
│   │   │                         config · performance · export · auth
│   │   ├── api/routes/           auth · system · navigation · scenarios ·
│   │   │                         performance · ingest
│   │   ├── middleware/           auth, RBAC, validation, rate limits, audit
│   │   ├── ws/hub.js             live stream with back-pressure handling
│   │   └── utils/                geo · matrix · stats · random · logger
│   └── tests/                    209 tests
├── frontend/
│   ├── src/
│   │   ├── pages/                navigation · sensors · gnss · fusion ·
│   │   │                         alarms · scenario · analytics · demo ·
│   │   │                         config · admin · login
│   │   ├── map/MapView.tsx       MapLibre chart, no external tiles
│   │   ├── charts/               ECharts wrappers
│   │   ├── components/           shell, status banner, UI primitives
│   │   ├── store/                Redux Toolkit slices
│   │   ├── api/api.ts            RTK Query
│   │   ├── ws/liveClient.ts      reconnecting WebSocket client
│   │   └── utils/                formatting, status vocabulary
│   └── tests/                    67 tests
├── data/exports/                 export output
└── scripts/                      generate_demo_data · run_scenario ·
                                  export_results · seed_database
```

---

## 9. Technology choices and why

| Choice | Reason |
|---|---|
| **Modular monolith**, not microservices | One navigation solution, one audit trail, one deployment. Microservices would add network partitions between stages that must agree on a single epoch. |
| **Node.js + Express** | The specification's recommended stack; the numerical work here is small (a 7×7 filter at 5 Hz) and stays far inside one core. |
| **PostgreSQL** | Transactional audit trail with a database-enforced append-only guarantee. |
| **YAML configuration** | Thresholds are data. An engineer changes the 2 m limit without a rebuild, and every change is audited. |
| **MapLibre with a self-generated style** | No external tile server. The demonstration must run on an isolated network, and a basemap that silently failed to load would leave position markers floating on grey. |
| **Seeded PRNG everywhere** | `Math.random()` appears nowhere in the data path. Replay determinism is a tested property, not an aspiration. |
| **Integer tick accounting in the simulator** | Accumulating `time += dt` makes results depend on how the caller chunks its calls. Determinism must not be an accident of scheduling. |

---

## 10. Implementation milestones (as delivered)

| Stage | Content | State |
|---|---|---|
| 1 | Architecture, data models, state machine, API contracts, assumptions | complete — this document and its companions |
| 2 | Skeleton: backend, frontend, Docker Compose, health, live dashboard | complete |
| 3 | Simulation: vessel ground truth, 12 sensor simulators, 15 scenarios, WebSocket streaming | complete |
| 4 | GNSS integrity: 25 conditions, scoring, panel, alarms | complete |
| 5 | Navigation: dead reckoning, radar/LiDAR matching (both modes), bathymetric matching, optional INS, EKF | complete |
| 6 | Integrity: residual monitoring, FDE, protection level, requirement status | complete |
| 7 | Analytics: performance charts, scenario report, CSV/JSON/GeoJSON/KML/HTML export | complete |
| 8 | Testing and documentation: 276 automated tests, demo script, limitations, deployment, security notes | complete |

---

## 11. Technical risks

| Risk | Impact | How it is handled here | What production needs |
|---|---|---|---|
| Simplified scan matching does not represent a real radar stack | Overstated radar performance | Mode B is labelled, contracts defined, tested; Mode A models a vendor fix | OEM localization output through the same adapter contract |
| Terrain matching accuracy depends on seabed distinctiveness | Silent failure over flat seabed | Ambiguity is measured and published; the fix is rejected, not down-graded silently | Particle filter with per-beam likelihood, rigorous tide/SV uncertainty |
| Protection level is a simplified formulation | Under- or over-stated bound | Every term is documented, configurable and reported separately; misleading-information rate is measured and published | Documented fault tree with quantified per-mode prior probabilities |
| Correlated errors are configured, not estimated | Bound may be optimistic on a real vessel | Values are explicit configuration with a stated basis | Estimated from trial data against RTK truth |
| An attacker who can spoof GNSS *and* alter the radar map | Both "independent" sources agree and are both wrong | Out of scope; noted here rather than pretended away | Signed map data, secure boot, map version attestation |
| Detection thresholds are tuned on synthetic data | False alarms or missed detections at sea | Thresholds are configurable and the false-alarm count is reported per run | Re-tuning against recorded Safeen data (roadmap Phase 2) |
| Clock discipline assumed | Time-alignment errors read as position errors | Timestamp offsets and jumps are detected and alarmed | PTP or GNSS-disciplined clock with holdover, monitored |

---

## 12. Features intentionally deferred

Listed so that nothing is mistaken for present:

- **Unscented Kalman filter / factor graph.** The EKF is adequate at these
  dynamics; the alternative is noted as an experimental module, not built.
- **Raw radar video processing.** Mode B consumes a point cloud. Extracting one
  from radar video is a separate product.
- **Vertical protection level.** No independent vertical reference exists.
- **NMEA 2000, IEC 61162-450, TCP, MQTT, ROS bag, PCAP adapters.** Contracts are
  declared; implementations need hardware or recordings to validate against.
- **Direct output to autopilot, DP, propulsion or steering.** Never in scope. The
  navigation API refuses every write with an explanation.
- **Native PDF generation.** The HTML report prints to PDF from any browser; a
  bundled PDF writer would add weight and produce a worse document.
- **Multi-vessel / fleet aggregation.** Roadmap Phase 6.
- **Federated identity.** The authentication layer is a documented placeholder;
  production federates to the operator's identity provider.
- **Server-side token revocation.** Tokens are short-lived and stateless; a
  deny-list is a production requirement recorded in `security.md`.

---

## 13. Where to look next

| Question | Document |
|---|---|
| What has been assumed? | [assumptions.md](assumptions.md) |
| What can this system *not* do? | [limitations.md](limitations.md) |
| How do I call it? | [api.md](api.md) |
| What are the safety properties? | [safety.md](safety.md) |
| What is the security posture? | [security.md](security.md) |
| How was it tested? | [test-plan.md](test-plan.md) |
| How is the position actually derived? | [how-it-works.md](how-it-works.md) |
| What does each scenario show? | [scenarios.md](scenarios.md) |
| How do I run the demonstration? | [demo-script.md](demo-script.md) |
| Where does it go from here? | [roadmap.md](roadmap.md) |
| Does it meet the acceptance criteria? | [acceptance.md](acceptance.md) |
