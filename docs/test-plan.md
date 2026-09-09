# Test plan and results

276 automated tests: 209 backend (Jest), 67 frontend (Vitest + React Testing
Library). Run with `npm test`.

---

## 1. Philosophy

Two principles shape this suite.

**The engine tests need no infrastructure.** No database, no sockets, no timers.
The navigation logic is the part that must be provable, and a test that needs
infrastructure to run is a test that stops being run. The API suite does need a
database; it skips itself loudly, naming the reason, rather than passing while
testing nothing.

**A failing test is investigated before it is adjusted.** Several tests in this
suite failed on first run and were kept, because they had found real defects. The
defects and the fixes are listed in §8 — that list is the most useful part of
this document.

---

## 2. GNSS integrity — `tests/gnssIntegrity.test.js` (12 tests)

Maps directly onto Section 24 "GNSS Integrity".

| Test | Asserts |
|---|---|
| Healthy GNSS is not falsely rejected | 300 epochs of realistic noise: trust stays ≥ 76, status TRUSTED, no conditions, no spoofing claim |
| Sudden position jump detected | A 50 m jump with independent sources unchanged → radar disagreement, exclusion, spoofing suspected, explanation names radar |
| Gradual drag detected before 20 m | A 0.1 m/s drag is caught at an offset well under the 20 m acceptance limit |
| Frozen coordinates detected | Frozen fix while the DVL shows way on → detected, excluded, explanation names it |
| Frozen coordinates **not** flagged when stationary | The mirror case — a correct fix on a stopped vessel must not be called an attack |
| Degraded signal metrics detected | C/N0 collapse and satellite loss → jamming suspected, spoofing **not** suspected |
| False time detected | A 4 s timestamp offset → time-jump condition with the measured offset |
| No fix rejected outright | A receiver disclaiming its own fix is never used, without debouncing |
| Signal loss reported | No message at all → signal lost, excluded |
| Position on land treated as impossible | Trust forced to zero |
| Recovery held for the full window | GNSS returning clean is held out for the configured 30 s and only then readmitted |
| Recovery window restarts on a new anomaly | A fresh anomaly during validation resets the window to zero |

## 3. Fusion — `tests/fusion.test.js` (29 tests)

Section 24 "Fusion", plus the filter and fault-detection internals.

**Extended Kalman filter (7):** position propagation; uncertainty grows on
predict and shrinks on update; a precise measurement is weighted above a noisy
one; an outlier is gated out and does not move the state; the gyro bias is
estimated from an absolute heading reference; the covariance stays symmetric and
positive over 100 update cycles; a turn is followed when the rate of turn is
supplied.

**Fusion engine (4):** contributing and rejected sensors are attributed
correctly; runtime de-weighting scales the covariance as expected; a reported
sigma below the configured floor is not trusted; persistent divergence triggers a
recorded reset onto a trusted absolute source.

**Fault detection (8):** duplicate sequence numbers, out-of-order timestamps,
stale measurements, frozen values and bottom-lock loss are each rejected with the
right fault category; a persistently inconsistent sensor is excluded and later
reintegrated; an offline sensor is **not** excluded; exclusions are held while a
suspect source is still contributing; the last remaining absolute source is
retained under protest rather than removed.

**Bathymetric matching (3):** ambiguity is reported over featureless seabed
rather than a confident fix; matching is refused without enough depth history;
the candidate surface is exposed for inspection.

**Dead reckoning (4):** uncertainty grows monotonically without an absolute
update; it grows faster after bottom-lock loss; the dominant error source is
named; the remaining unassisted time is reported.

**Radar map matching (2):** independent scan matching recovers a known pose to
better than 3 m from a 6 m seed offset; the vendor fix is used when no point
cloud is available.

## 4. Integrity and modes — `tests/integrity.test.js` (30 tests)

Section 24 "Integrity".

**Protection level (4):** exceeds the raw covariance term; grows monotonically
through dead reckoning to more than double; inflates with a single source; no
vertical protection level is published.

**Requirement status (9):** met under good conditions; **never** met without an
independent absolute source even with a tiny covariance; met → at risk as
redundancy is lost; at risk → not met as the bound exceeds the limit;
insufficient information on invalid time sync and on no solution; a definite NOT
MET is preferred over "insufficient information" when the bound is knowable;
rapid growth is reported; accuracy, precision, confidence and integrity remain
distinct figures with the expected ordering.

**Sensor diversity (1):** two GNSS receivers do not count as diversity; a GNSS
and a radar do.

**Mode state machine (8):** an unsupported operator is rejected; all/any/not
combinators work; a missing context field is unsatisfiable rather than truthy;
every declared successor is validated at construction; INTEGRITY_NOT_ASSURED is
entered when integrity is lost; the dwell timer suppresses flapping;
MANUAL_FALLBACK latches until cleared; transitions record a human-readable
reason; all 14 modes publish guidance and successors.

**Configuration (1):** the requirement limit and recovery window are the values
the specification asks for.

**Time integrity (6):** GNSS is the source while it is trusted and contributing;
UTC falls into holdover the moment GNSS stops contributing, *and* when the GNSS
clock itself is under suspicion even though its position is still being used -
the same transmitter controls both; the bound grows with holdover duration;
before any trusted reference the source is `UNKNOWN` and the bound is null
rather than zero, because a bound that cannot be computed is not a small bound;
and it recovers when a trusted reference returns.

## 5. Replay and scenarios — `tests/replay.test.js` (26 tests)

Section 24 "Replay".

**Determinism (4):** identical output across chunk sizes of 1, 3.7, 5 and 10
seconds; the same seed reproduces the run; a different seed does not; `reset()`
restores the state exactly.

**Transport (3):** the clock advances only when told; a partial tick is carried
across calls rather than dropped; the run stops at its configured duration.

**Fault injection (6):** the same injection produces the same outcome; an
injected spoof is detected by the pipeline without the engines being told, and
the fused solution stays within 10 m of truth; faults can be removed; unknown
types and out-of-range parameters are rejected; defaults are filled;
applicability is reported.

**Vessel model (3):** deterministic route following; the turn-rate limit is
respected; the depth relationship between seabed, tide, draft and squat holds.

**Scenario catalogue (7):** every scenario the specification names is defined;
the multiple-failure scenario ends in NOT MET and NOT ASSURED; the healthy
scenario never falsely claims spoofing and reports the requirement met for over
90 % of the run; the protection level contains the actual error in more than
90 % of epochs; the platform operates with no INS fitted; a completed scenario is
marked complete.

**Recorder durability (3):** `stop()` waits for a flush that is still in flight,
so a report generated the moment a run ends sees the whole run; two flushes never
overlap; a flush that fails does not stall every flush after it.

## 5a. Fleet — `tests/fleet.test.js` (10 tests)

Fleet monitoring runs a complete, independent pipeline per vessel. The property
under test is that independence: if two vessels shared a filter, a trust
assessment or an integrity calculation, one vessel being attacked would corrupt
the answer for another, and a fleet display would be worse than none.

Configuration: every declared vessel references a real scenario; identities and
MMSIs are unique; exactly one vessel is nominated as focused, so "the current
run" is never ambiguous.

Service: no mutable state is shared between vessels — engine, pipeline, filter,
vessel model and RNG are all distinct — while the environment *is* deliberately
shared, because it is read-only reference data and copying the depth grid per
vessel would cost megabytes for nothing. A spoofed vessel and a healthy one
reach different verdicts, and the healthy one's GNSS is untouched by its
neighbour's attack. A station offset moves one vessel's route without mutating
the shared environment — which would otherwise move the whole fleet. The
summary carries every field the display needs, the counts are the states an
operations room acts on, `stop()` releases everything and ticking afterwards is
a no-op, and one vessel throwing does not stop the rest.

## 6. Adapters — `tests/adapters.test.js` (34 tests)

**NMEA 0183 (13):** checksum verification and rejection of a corrupted sentence;
missing delimiter; GGA position and quality; southern and western hemispheres;
no-fix marked invalid; RMC position and velocity; void status; HDT heading; ROT
rate conversion; VBW bottom-track versus water-track discrimination; DBT and DPT
depths with transducer offset reference; an unconsumed but valid sentence returns
null; the originating sentence is retained for audit; every produced message
satisfies the internal schema; multi-line chunks report per-line errors.

**CSV (5) and JSON (3):** round-tripped exports parse; quoted cells containing
commas; unacceptable rows are reported rather than dropped; a file with no data
rows is rejected; a file with no recognisable measurement columns is rejected;
malformed JSON and wrong-shaped payloads report clearly.

**Internal schema (9):** a well-formed message is accepted; out-of-range
latitude, impossible velocity, unknown sensor type, malformed timestamp,
negative sequence number, unknown top-level fields, a hostile `sensor_id`, and
`NaN`/`Infinity` are each rejected.

**Catalogue and base adapter (4):** implemented and placeholder adapters are
declared honestly, every placeholder documents its contract, and the base adapter
validates before forwarding and counts rejections.

## 7. API integration — `tests/api.test.js` (67 tests)

Runs against the real Express app and the real database.

Health and discovery · authentication including account-enumeration resistance ·
RBAC for all four roles · the read-only navigation surface (all four write
methods) · reference data · full scenario lifecycle with recorded history · step
refused while running · backward jump refused · fault injection detected
end-to-end with the alarm and its reason · acknowledgement that does not clear ·
performance reporting with the three error quantities separated · CSV, JSON,
GeoJSON, KML and HTML export · configuration change, audit and reset ·
out-of-bounds and immutable-path rejection · cross-field consistency · data
ingestion and validation · CSV replay import, playback and deletion · user
administration with password policy and duplicate rejection · and the
database-level proof that the audit log rejects UPDATE and DELETE.

**Vessel management (8):** the register lists vessels with the reference data a
form needs, so the client never hard-codes a list that could drift from the
server; a vessel is created, read, updated and deleted, with a partial update
leaving unmentioned fields alone; validation names the field at fault rather
than only rejecting; a vessel with no absolute positioning source is refused,
because it could never report the requirement as met; a duplicate MMSI is
refused; the focused vessel cannot be deleted; an identifier that is not safe in
a log line is rejected; and changing the register requires the engineer role.

**Malformed identifiers (7):** a path or query identifier that is not a UUID is
rejected with 400 on every route that takes one, a well-formed identifier that
does not exist still returns 404 — the distinction between "that is not an
identifier" and "there is no such thing" is preserved — and no database error
text reaches the client.

## 8. Frontend — `frontend/tests/ui.test.tsx` (25 tests)

Section 24 "UI".

**Status banner (5):** the requirement reads MET when it is met; it changes to
NOT MET when the protection level exceeds the limit; the critical operator
instruction stays visible when integrity is not assured; no position is claimed
when there is no solution; the staleness state is tracked.

**Navigation screen (4):** the map mounts and the position panels render; the
display updates when a new epoch arrives; an explanatory empty state appears when
nothing is running; excluded sensors are shown with their reason.

**Alarms (3):** alarms received over the live link appear with reason and
recommended action; the alarm list renders severity, reason and action;
acknowledging does not remove the alarm from the active list.

**Sensor table (2):** each sensor renders with its decision and reason; search
filters the table.

**Map (2):** it loads and always shows the demonstration label; the legend
distinguishes the trusted position from the raw GNSS position and ground truth.

**Role-based access (2):** a viewer does not see the acknowledge-all control; an
operator does.

**Map style (1):** the MapLibre style omits the `glyphs` property rather than
setting it to undefined. MapLibre validates the style strictly and fails the
whole load on a malformed property; a map that fails to load is silent, so the
panel simply stays empty with nothing reaching the operator.

**Theme (6):** dark is the default; choosing light sets the document theme and
`color-scheme`; the choice survives a reload; three options are offered with the
current one marked by state rather than by highlight colour; the
follow-the-system setting resolves rather than assuming; every positioning
source keeps a distinct colour.

## 8a. Seabed raster — `frontend/tests/bathymetryRaster.test.ts` (6 tests)

The depth grid is turned into a shaded image rather than one polygon per cell.
That conversion is pure geometry, and geometry that is slightly wrong is the
worst kind — a half-cell offset looks plausible until the channel edge sits a
cell away from where the vessel actually is.

The image matches the grid dimensions; it extends half a cell beyond the
outermost cell centres, so the raster registers with the vector layers drawn
over it; rows run north to south as an image is drawn; a cell the survey does
not cover stays transparent rather than being painted as zero depth, which
would read as a shoal; the colour ramp spans the surveyed depth range rather
than a fixed scale; and a grid that cannot be rasterised is declined instead of
half-drawn.

## 8b. Palette — `frontend/tests/palette.test.ts` (32 tests)

The two palettes are read straight out of the stylesheet and measured, because a
theme is easy to break by eye: a colour that looks right on a developer's
monitor can be unreadable on a bridge in daylight.

Per theme: every token the other theme defines is present; each of the ten text
and status colours clears WCAG AA at 4.5:1 against **both** surfaces text is set
on (the panel and the app ground behind it); every positioning-source colour
clears the 3:1 graphical threshold; each source has its own colour; the status
colours stay separable; and the ground ramp runs the right way — `bridge-950` is
the furthest-back ground and `bridge-100` the strongest text in both, which is
the invariant that lets one set of class names serve both themes.

Across themes: dark remains the `:root` default, so a client opening the page
with no stored preference gets the bridge palette rather than a white flash, and
a light palette is declared for the document to select.

---

## 9. Defects found by these tests, and the fixes

Each of these was a real bug found while writing the suite. They are recorded
because the fixes are the substance of the work.

| # | Defect | Fix |
|---|---|---|
| 1 | The filter was seeded with position but no heading, so every body-velocity update was wrong by the true heading and the solution diverged while rejecting the very measurements that would have corrected it | Seed from an absolute position **and** a heading reference; publish nothing until both exist |
| 2 | Stale localization fixes were re-applied every epoch, counting one measurement several times and dragging the solution back to a position the vessel had left | A `fresh` flag; only a fix derived from a message received this epoch is applied |
| 3 | Bias detection used the mean of the innovation **magnitude**, which is always positive — so every healthy sensor was declared biased and excluded | Test the mean of the *signed* innovation, with a floor at a fraction of the sensor's declared uncertainty |
| 4 | The heading state could not follow a turn: at 8 °/s the gyro innovation became several sigma, the gyro was gated out as an outlier, and the whole solution collapsed at the first alteration of course | Propagate heading with the gyro's measured rate of turn, read from the current epoch, with rate uncertainty scaled by the turn magnitude |
| 5 | Three heading sources each claiming to be the unbiased truth fought each other and drove healthy sensors out | The gyro is the compass reference with a bias state; radar map matching corrects as the absolute heading; INS is monitored only while a gyro is available |
| 6 | Measurements were applied as if current, so the solution lagged by the sensor latency — about a metre at survey speed | Time-align each measurement to the epoch using its own timestamp, inflating its covariance for the extrapolation |
| 7 | The residual monitor excluded the *honest* sensor: while a dragging GNSS was still in the solution, radar's residuals grew and radar was removed first | Adaptive cross-check thresholds that trip earlier, plus an isolation hold that suspends exclusions of other sources while a suspect one is still contributing |
| 8 | An excluded sensor could never be reintegrated: its stale residual window kept re-triggering the same fault, so the controlled re-entry path was dead code | Clear the residual history at the moment of exclusion; if the sensor is still faulty, residuals rebuild and it is excluded again |
| 9 | Simulation output depended on how the caller chunked its calls to `advance()`, so replay was not reproducible | Integer tick accounting with a carried remainder; verified identical across four chunk sizes |
| 10 | `reset()` restored values but not the underlying random streams, so a reset run diverged from the original | Gauss–Markov processes reset their stream; INS drift direction and AIS contacts are rebuilt in the same RNG order as construction |
| 11 | The protection level did not bound the error during a slow spoof: the covariance was small — the filter was confident, and wrong | Carry the observed disagreement between contributing sources (less what their own uncertainties explain) into the bias margin |
| 12 | After excluding a dragging source, the solution was still contaminated but the bound had already shrunk | A decaying contamination term latched at exclusion, sized by the disagreement observed at that moment |
| 13 | Integrity reported UNKNOWN when a stale-but-computable bound demonstrably exceeded the limit | Reorder: "unknown" is only for genuinely unanswerable cases; a knowable and bad answer is NOT ASSURED |
| 14 | A GNSS message the receiver had marked invalid could be used, because the debounce had not yet confirmed the condition | An explicit disclaimer from a sensor is never debounced |
| 15 | Fault-parameter validation errors surfaced as HTTP 500 | Validation failures carry a 400 status |
| 16 | A CSV with none of the expected columns was accepted and turned into a stream of empty but schema-valid messages | Require at least one recognisable measurement column, and name what was looked for |
| 17 | The alarm that says *why* GNSS was excluded was suppressed when the residual monitor happened to exclude it a fraction earlier | The classification alarm follows the trust engine's own transition, not the exclusion flag |
| 18 | The API test suite silently skipped itself and passed, because `describe` blocks evaluate before `beforeAll` | Probe the database at module scope with top-level await |
| 19 | The recorder's scheduled flush and its explicit one could overlap, so `stop()` returned while earlier inserts were still in flight. The performance report is generated the instant a scenario ends, so it was computed from part of the run — silently, and differently each time. It was caught by one scenario's report disagreeing with the rows it had supposedly just read | Serialise flushes through a promise chain, so awaiting a flush also awaits every flush queued before it. `stop()` now means the run is durable |
| 20 | The map never rendered. The style set `glyphs: undefined`, and MapLibre treats a present-but-undefined property as invalid: style validation failed, the `load` event never fired, and every layer effect bailed out on `ready === false`. Nothing appeared in the console the operator would see and no error state was shown — the map panel was simply empty | Omit the key entirely. A test asserts the style has no `glyphs` own-property |
| 21 | A path or query identifier that was not a UUID reached PostgreSQL, which rejected it with `22P02`. That surfaced as HTTP 500 with a logged SQL error, reporting a server fault for a caller's typo | Validate UUID parameters at the route boundary with a shared `uuidParams` middleware, and map `22P02` to 400 in the error handler as a safety net |

---

## 10. Measured results

From `node scripts/run_scenario.js --all` on the shipped configuration. "MI" is
the misleading-information rate: epochs where the actual error exceeded the
published protection level while the requirement was reported as met.

| Scenario | Mean error | p95 | Max | Mean HPL | MI | Requirement met |
|---|---|---|---|---|---|---|
| Healthy navigation | 0.33 m | 0.60 m | 0.79 m | 1.13 m | 0.0 % | 99 % |
| GNSS sudden jump | 0.28 m | 0.60 m | 0.79 m | 1.92 m | 0.0 % | 45 % |
| Gradual spoofing drag | 0.36 m | 0.75 m | 1.99 m | 2.31 m | 1.2 % | 24 % |
| GNSS jamming | 0.26 m | 0.53 m | 0.64 m | 2.20 m | 0.0 % | 47 % |
| Flat seabed ambiguity | 0.24 m | 0.51 m | 0.86 m | 2.28 m | 0.0 % | 20 % |
| Radar feature loss | 0.23 m | 0.45 m | 0.77 m | 2.49 m | 0.0 % | 17 % |
| DVL bottom-lock loss | 0.25 m | 0.49 m | 0.70 m | 2.29 m | 0.0 % | 19 % |
| Gyro heading bias | 0.34 m | 0.65 m | 0.86 m | 1.29 m | 0.0 % | 94 % |
| GNSS recovery validation | 0.33 m | 0.57 m | 0.78 m | 1.75 m | 0.0 % | 58 % |
| Multiple sensor failure | 0.41 m | 0.88 m | 2.27 m | 7.04 m | 0.8 % | 18 % |
| Message integrity faults | 0.37 m | 1.16 m | 1.39 m | 2.40 m | 0.0 % | 49 % |
| False time and frozen position | 0.25 m | 0.60 m | 0.82 m | 1.90 m | 0.0 % | 45 % |
| GNSS-denied without INS | 0.28 m | 0.59 m | 0.83 m | 2.40 m | 0.0 % | 20 % |
| Local positioning | 0.24 m | 0.46 m | 0.65 m | 0.97 m | 0.0 % | 84 % |
| **Safeen demonstration** | **0.46 m** | **1.28 m** | **3.42 m** | **2.43 m** | **2.2 %** | **34 %** |

Detection timing:

| Scenario | Fault at | Detected at | Latency |
|---|---|---|---|
| Sudden jump | 180 s | 180.4 s | 0.4 s |
| Gradual drag (0.1 m/s) | 150 s | 182 s | 32 s, at ≈3.2 m of offset |
| Jamming | 200 s | 210.6 s | 10.6 s |
| False time | 120 s | 120.4 s | 0.4 s |
| GNSS returns (scenario 9) | 420 s | reintegrated 450.2 s | 30.2 s validation |

Reading these honestly: the low "requirement met" percentages in the
GNSS-denied scenarios are the *correct* result. Radar map matching in this
environment yields a 2–3 m bound, which does not assure 2 m. The platform says
so. The numbers that matter are the mean error — the solution stays sub-metre
throughout — and the misleading-information rate, which is at or near zero
everywhere.

---

## 11. Running the tests

```bash
npm test                      # everything
npm run test:backend          # 209 backend tests
npm run test:frontend         # 67 frontend tests

# One suite
npm run test --workspace backend -- tests/integrity.test.js

# Scenario regression after a configuration change
node scripts/run_scenario.js --all
node scripts/run_scenario.js SCN_15_SAFEEN_DEMO --json
```

The API suite needs PostgreSQL. Without it, it skips itself and says so; the
other 123 backend tests still run.

---

## 12. Coverage gaps

Honest about what is not covered:

- **No load or soak testing.** The platform has not been run for a full watch, or
  with many concurrent dashboard clients.
- **No fuzzing of the adapters.** The schema tests cover the categories that
  matter, but a proper fuzz campaign against the NMEA parser would be worthwhile.
- **No browser-level end-to-end tests.** The frontend tests use jsdom with the
  map and charts stubbed; the map's rendering is verified by hand.
- **No tests against real sensor data.** By definition — that is roadmap Phase 2.
- **No accessibility audit.** Keyboard navigation and ARIA roles are implemented
  and the colour choices are deliberate, but no screen-reader testing has been
  done.
