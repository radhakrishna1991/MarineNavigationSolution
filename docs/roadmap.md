# Production roadmap

What exists, and what would have to happen between here and a system that could
be trusted on a working vessel. Sections 31 and 32 of the specification.

The honest summary: **Phase 1 is complete. Phases 2 to 6 have not been started.**
Nothing in this repository has seen a real sensor.

---

## Phase 1 — Offline system · **COMPLETE**

Everything in this repository.

| Deliverable | Status |
|---|---|
| Simulated data | 13 sensor simulators, 15 scenarios, deterministic seeded generation |
| Replay | CSV/JSON import, transport control, chunk-size-independent reproducibility |
| GNSS integrity | 25 detection conditions, trust scoring, deception/interference classification, 30 s recovery validation |
| Sensor fusion | 7-state EKF, FDE with controlled reintegration, source-attributed contribution |
| UI | 11-screen dashboard, live WebSocket, map, charts, alarms, RBAC |
| Reporting | Section 26 performance report, five export formats, append-only audit |

Measured on the shipped configuration: 0.22–0.46 m mean horizontal error across
all scenarios, 0–2.2 % misleading-information rate, spoofing drag detected at
roughly 3 m of offset. See [test-plan.md](test-plan.md) §10.

**What Phase 1 cannot tell you:** whether any of that survives contact with real
sensors. Every number above is measured against a ground truth that the same
program generated. That is a valid test of the *logic* and no test at all of the
*assumptions*.

---

## Phase 2 — Safeen recorded-data integration

**Goal.** Replace simulated input with recorded real data and find out which
assumptions were wrong. This is the phase that decides whether the concept
survives.

**Scope**

- Ingest real NMEA 0183 from Safeen vessel recordings (the parser exists; the
  data does not).
- Ingest Sonardyne acoustic output — the format and the actual uncertainty
  reporting, not the assumed one.
- Ingest radar-derived localization from the installed radar's own processor.
- Ingest survey-system logs (GSF, S7K or HSX depending on the acquisition
  package) for bathymetry.
- Compare the fused solution against RTK ground truth from the same recording.

**Engineering work**

- Complete the NMEA 2000 and IEC 61162-450 adapters against real traffic.
- Time-base reconciliation: each recording system has its own clock and its own
  latency. This is usually the hardest part of the phase and is routinely
  underestimated.
- Sensor lever arms and alignment from the vessel's as-built drawings.
- Re-estimate every noise model from the recorded data. The configured sigmas in
  `default.yaml` are engineering judgement and will be wrong.
- Re-tune the detection thresholds against real GNSS behaviour — real receivers
  produce multipath, urban-canyon and berth-shadowing artefacts that the
  simulator does not.

**Exit criteria**

- The platform runs end to end on at least 20 hours of real recorded data across
  varied conditions.
- Measured error against RTK truth, published with the same three quantities
  separated (actual, estimated, protection level).
- **False-alarm rate below one per operating hour** on healthy data. This is the
  make-or-break number: an assurance system that cries wolf gets switched off.
- A documented list of every assumption in [assumptions.md](assumptions.md) that
  the real data contradicted.

**Risk.** The most likely outcome is that the radar map-matching accuracy is
worse than assumed, which would push the achievable protection level above 2 m
in more situations than the simulation suggests. That is a real finding, not a
failure — but it changes the value proposition and it needs to be discovered
here, cheaply, and not in Phase 4.

**Dependencies on Safeen.** Recordings with synchronised RTK truth; the radar
processor's localization output enabled; sensor installation drawings; the
survey package's export format. Without RTK truth, this phase cannot produce its
central result.

---

## Phase 3 — Vessel shadow mode

**Goal.** Run live on a vessel, connected to nothing, watched by nobody who
depends on it.

**Scope**

- Read-only installation on the sensor network. **No control outputs** — already
  a structural property of the codebase, and it must be reviewed and stated
  again here.
- Live sensor monitoring and live integrity calculation at sea.
- Parallel comparison against the vessel's existing navigation system, logged
  continuously.

**Engineering work**

- Hardware: an industrial fanless PC, appropriate ingress protection, vessel
  power with a UPS.
- Network: a dedicated sensor VLAN with a one-way policy (sensors → platform
  permitted, platform → sensors denied), enforced by the switch and not by
  configuration in the application.
- Continuous recording with enough capacity for a full deployment, plus an
  offload procedure.
- Remote diagnostics that do **not** require a route from the vessel to the
  internet — offline bundles the crew can send.
- Watch-length soak testing, which has not been done at all (see
  [test-plan.md](test-plan.md) §12).

**Exit criteria**

- 30 days of continuous operation with no crash, no memory growth and no
  recording gap.
- Every alarm raised during the period reviewed and classified as true or false,
  by hand.
- Agreement with the vessel's existing navigation system quantified, and every
  disagreement explained.
- Crew feedback on the display gathered from people who were not involved in
  building it.

**Risk.** Shadow mode is where a system stops being interesting and starts being
noisy. If the crew learn to ignore the display in this phase, no amount of later
accuracy recovers it. The alarm-tuning work in this phase matters more than the
algorithm work.

---

## Phase 4 — Controlled harbour trial

**Goal.** Prove GNSS-denied performance against surveyed truth under conditions
that are authorised, bounded and repeatable.

**Scope**

- Authorised GNSS outage simulation within a defined operating polygon.
- **Cable-based GNSS simulation** — the signal generator connected by cable to
  the receiver, never radiated. This is not a preference; radiating a spoofed
  GNSS signal is illegal in essentially every jurisdiction and dangerous to every
  vessel and aircraft in range.
- Controlled replay of the recorded trial for post-analysis.
- Surveyed reference truth: shore-based total station or RTK base with a known
  monument.
- A defined operating polygon with an abort procedure.

**Regulatory and safety prerequisites**

- Written authorisation from the port authority and the UAE
  telecommunications regulator for the GNSS test, with scope and dates.
- A risk assessment and a documented abort criterion.
- A safety boat, or an equivalent independent means of position verification.
- Notice to other harbour users.
- An agreed test plan with pass/fail criteria written **before** the trial.

**Exit criteria**

- Measured horizontal error against surveyed truth throughout the outage.
- **The published protection level bounds the actual error in every epoch of the
  trial.** Not "in 98 % of epochs" — the whole point of a protection level is
  that exceeding it is the failure. Any exceedance is a finding that must be
  explained and closed.
- Detection latency and detected offset for each injected attack.
- The duration for which 2 m was genuinely assured, stated per sensor
  configuration.
- An independent review of the results by someone outside the project.

**Risk.** This is where the honest answer may be "2 m cannot be assured for more
than N minutes without radar features". If so, that becomes the specification —
an operating envelope, published, rather than a capability claim.

---

## Phase 5 — Pilot vessel

**Goal.** One vessel, in operational service, with the platform as an accepted
part of the navigation arrangement.

**Scope**

- Hardened hardware: type-approved or type-approvable, vibration and EMC tested,
  with a defined operating temperature range.
- Redundant network interfaces and redundant power.
- Secure deployment: secure boot, signed images, mTLS, a secrets store, network
  segmentation — everything listed as a future requirement in
  [security.md](security.md) §3.
- Class and flag consultation, started early. The scope of the classification
  society's interest must be agreed before the hardware is ordered, not after.
- Operational procedures: what the crew does on each alarm, integrated into the
  vessel's existing bridge procedures rather than bolted alongside them.
- Training, with competency assessment. An operator who cannot explain the
  difference between accuracy and integrity cannot use this system correctly.

**Additional prerequisites**

- A failure-mode and effects analysis covering the platform's role in the
  navigation arrangement.
- A software-quality evidence pack: development process, test evidence, defect
  history, change control.
- A support agreement: response times, patching at sea, rollback.
- Insurance and liability position agreed. A system that influences navigation
  decisions has a liability profile, and it needs an answer before service, not
  after an incident.

**Exit criteria**

- Six months of operational service.
- No incident attributable to the platform.
- Documented operational benefit — survey time recovered, or outages worked
  through — measured, not asserted.
- Class and flag position formally recorded.

---

## Phase 6 — Fleet platform

**Goal.** Many vessels, managed centrally, updated safely.

**Scope**

- **Vessel profiles**: per-vessel sensor configuration, lever arms, noise models
  and thresholds, versioned and auditable. No two vessels have the same fit and
  a single global configuration would be wrong for all of them.
- **Centralised monitoring**: fleet-wide integrity status, with the shore link
  treated as unreliable by design. A vessel must operate fully with no
  connectivity.
- **Remote diagnostics**: read-only, authenticated, rate-limited, over mTLS, and
  incapable of changing a vessel's configuration without the vessel's own
  approval step.
- **Fleet analytics**: cross-vessel performance, regional GNSS interference
  patterns — a fleet of these becomes an interference-monitoring network, which
  may be the most valuable thing in this phase.
- **Configuration management**: staged rollout, per-vessel pinning, one-command
  rollback.
- **Signed software updates**: signature verified on the vessel, offline signing
  key, reproducible builds, automatic rollback on failed health checks. A vessel
  at sea must never be left unable to boot.

**Additional considerations**

- Data ownership and residency for a UAE operator, agreed contractually.
- A cross-fleet incident-response process.
- Fleet-wide threshold changes governed like the safety changes they are, with a
  documented approval path — one bad configuration push must not degrade every
  vessel simultaneously.

---

## Field performance dependencies (Section 31)

**Nothing in this demonstration predicts performance at sea.** Real performance
depends on all of the following, and every one of them is outside this
repository's control:

vessel type · sensor installation and alignment · gyrocompass quality · DVL
availability · bottom lock · radar field of view and mounting height · map
quality and registration · bathymetric survey age and resolution · tide · sound
velocity · seabed distinctiveness · weather · sea state · sensor latency ·
operating area · outage duration.

Two of these deserve emphasis because they dominate:

- **Bottom lock.** Everything about the dead-reckoning performance rests on
  Doppler bottom lock. Lose it and the error growth changes from
  centimetres-per-√second to metres-per-minute. Water-track velocity is not a
  substitute; the current is unknown.
- **Seabed distinctiveness.** Bathymetric matching is worth a great deal over
  varied terrain and worth nothing over a flat seabed. Whether the platform helps
  a given operation depends on the seabed under that operation, and that can be
  assessed in advance from the existing survey — before any trial, at no cost.

---

## What would make this fail

Stated plainly, because a roadmap that only describes success is not useful:

1. **Real GNSS is noisier than simulated GNSS**, and the false-alarm rate in
   Phase 2 cannot be brought below one per hour without also losing the
   detection sensitivity that makes the platform worth having.
2. **Radar map matching underperforms** in the actual operating area, so the
   achievable protection level never gets near 2 m without GNSS, and the honest
   answer is that the requirement cannot be assured during an outage.
3. **The crew stop looking at it.** A true finding delivered on a display nobody
   watches is worth nothing.
4. **The regulatory path proves longer than the commercial patience for it.**
   Class and flag engagement is measured in quarters.

Phase 2 tests failure modes 1 and 2 cheaply, on recorded data, before any capital
is committed. That is why it is the next phase and why it should not be
compressed.
