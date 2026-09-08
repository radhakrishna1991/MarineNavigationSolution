# Limitations

What this platform is not, and what it cannot do. This document exists so that
nothing in the demonstration can be mistaken for a capability that has not been
built.

---

## 1. Status

**This is a proof of concept and a decision-support tool. It is not a certified
navigation product.**

- It has no type approval, no classification-society review and no flag-state
  acceptance.
- It has not been tested at sea, on real sensors, or against a real GNSS attack.
- Every number in the demonstration comes from simulation.
- The geospatial data is synthetic. It is not derived from any chart, ENC or
  survey, and it must never be represented as navigational data.

> iSpatialTec does not claim to create an accurate position from unavailable
> information. The platform determines which navigation sources can be trusted,
> combines valid independent measurements, quantifies the uncertainty, and warns
> before the less-than-2-metre requirement can no longer be assured.

---

## 2. What is deliberately absent

| Absent | Why |
|---|---|
| Any output to autopilot, dynamic positioning, propulsion or steering gear | Out of scope by design. The navigation API refuses every write method with an explanation, and there is no code path that could reach a control system |
| Vertical protection level | No independent vertical reference exists beyond the echo sounder. A VPL derived from it alone would be misleading, so the field is null with a status explaining why |
| GNSS, radar, DVL, INS or sonar hardware | iSpatialTec builds the navigation intelligence layer, not the instruments |
| Named OEM integrations | Sensors are described by vendor-neutral class. Naming a manufacturer would imply an integration that has not been built and validated |

---

## 3. Adapters: implemented versus placeholder

Implemented and working:

- **NMEA 0183 / IEC 61162-1** — GGA, RMC, GLL, VTG, GSA, HDT, THS, ROT, VBW,
  VHW, DBT, DPT, with checksum verification.
- **CSV replay**, **JSON replay**, **REST ingestion**, **WebSocket ingestion**,
  **simulated UDP ingestion**.

Declared with an input/output contract but **not implemented**:

| Adapter | Why not | What completing it needs |
|---|---|---|
| NMEA 2000 / CAN | A binary PGN decoder cannot be validated without hardware | A certified gateway and a PGN dictionary, bench-tested before sea trials |
| IEC 61162-450 | Needs a shipboard LAN with configured multicast groups | Reuses the NMEA 0183 parser once the transport tag block is stripped; needs multicast and source filtering |
| TCP stream | Reconnection, back-pressure and framing policy differ per vendor | A named vendor and their framing specification |
| MQTT | Needs a broker and an agreed topic scheme | Operator's broker and topic map |
| ROS bag import | Bag decoding needs the message definitions used at record time | The definitions plus a topic-to-sensor mapping |
| PCAP import | Useful for forensic replay of a real interference event | A capture of the sensor VLAN plus a port-to-sensor mapping |
| Survey acquisition export | Vendor-specific formats (GSF, S7K, HSX) | A sample export and a channel mapping |

A placeholder returns an honest error. None of them silently pretends to work.

---

## 4. Simplified algorithms

Each of these works, is tested, and has a defined contract — and each is a
simplification of what a production system would use.

### 4.1 Radar and LiDAR scan matching (Mode B)

Trimmed point-to-point ICP with a spatial hash. It does **not** have:

- motion distortion correction for a rotating sensor,
- probabilistic data association,
- multi-hypothesis tracking,
- a sea-clutter or rain model,
- any handling of unmapped moving targets.

**Consequence.** It works well against a clean point cloud from a well-mapped
area and degrades ungracefully in clutter. It converges to a local minimum if
seeded badly, which is why it is seeded from the filter's own prior and why its
residuals are checked before its result is preferred over the vendor fix.

**Production replacement.** OEM radar localization output ingested through the
same adapter contract, or a scan matcher with the features above.

### 4.2 Bathymetric terrain matching

Sequence matching by grid search, with a per-candidate depth-bias estimate. It
does **not** have:

- a particle filter or any state carried between epochs,
- a per-beam measurement likelihood for multibeam swaths,
- rigorous propagation of tide and sound-velocity uncertainty,
- correlation between neighbouring grid cells.

**Consequence.** Over distinctive terrain it produces a usable fix with an
honest covariance. Over flat or repetitive seabed it produces genuine ambiguity,
which it detects and reports rather than hiding — but it cannot resolve that
ambiguity by carrying multiple hypotheses forward, which a particle filter
would.

**Production replacement.** Particle filter with per-beam likelihood and proper
uncertainty propagation.

### 4.3 Protection level

A simplified formulation, documented term by term in
[architecture.md](architecture.md) §6. It is **not** derived from a documented
fault tree with quantified prior probabilities per failure mode, which is what
certification would require.

The correlated-error terms are **configured constants**, not values estimated
from trial data. They are the largest single source of judgement in the bound.

**Consequence.** The protection level is defensible and is empirically checked
against ground truth in every run (the misleading-information rate), but it is
not a certifiable integrity bound.

### 4.4 Fault detection and isolation

Residual monitoring with chi-square consistency testing and a signed-mean bias
test. Isolation prefers the sensor whose residual is largest *relative to its own
declared uncertainty*.

Known weakness: with exactly two absolute sources that disagree, and no third to
break the tie, the platform cannot determine which one is wrong. It handles this
by widening the protection level to cover the disagreement and telling the
operator — it does not guess. Three independent sources would allow true
isolation; two allow only detection.

---

## 5. Detection limits

| Attack | Detected? | How, and what limits it |
|---|---|---|
| Sudden position jump | Yes, within about one epoch | Innovation gate and independent cross-check. A jump smaller than the noise floor is not detectable as a jump — but a *persistent* offset then shows as drag or disagreement |
| Gradual drag | Yes, typically before 5 m of offset | Requires the rate, the fit quality and the accumulated offset to agree. A drag slower than the configured rate threshold (0.045 m/s) will eventually be caught by the absolute cross-check instead, but later |
| Frozen coordinates | Yes | Requires an independent speed reference showing the vessel is making way. A frozen fix on a genuinely stationary vessel is indistinguishable from a correct one, and is deliberately not flagged |
| False velocity / course | Yes | Cross-checked against DVL and gyro |
| False time | Yes | Timestamp offset and step detection |
| Jamming | Yes | Signal metrics: C/N0, satellite count, DOP, and their rate of change |
| **Consistent multi-sensor attack** | **No** | If an adversary corrupts an independent source *consistently with* the spoofed GNSS, the cross-checks agree. This is the platform's fundamental limit and it is stated rather than glossed over |
| Meaconing (delayed replay) | Partially | Shows as a position offset and a time offset; a very short delay may fall inside the noise |

The false-alarm count and detection latency are measured and published in every
performance report, so these claims can be checked rather than taken on trust.

---

## 6. Performance limits

- **Dead reckoning cannot assure 2 m for long.** Uncertainty grows as √t from
  velocity noise plus a linear term from residual heading bias and log scale
  error. The linear term dominates after a couple of minutes. The platform
  reports the growth and the time remaining rather than implying otherwise.
- **Radar map matching alone typically yields a 2–3 m protection level** in this
  environment. That is below the 2 m requirement only in favourable geometry.
  During a GNSS outage the platform will often, correctly, report the requirement
  as not met — that is the honest answer, and reporting it is the product.
- **Bathymetric matching alone rarely assures 2 m.** See
  [assumptions.md](assumptions.md) §5.
- **Local ranging can assure 2 m comfortably**, inside its instrumented area
  only. Coverage is the limiting factor, not accuracy.

---

## 7. Operational limits

- **One scenario or replay at a time.** Two concurrent "trusted positions" would
  be meaningless and would make the audit trail ambiguous.
- **Simulated time cannot run backwards.** To reach an earlier point, reset and
  run forward. This keeps the recorded audit trail monotonic.
- **A replay carries no ground truth** unless the recording contained it.
  Accuracy statistics are then absent, and the report says so rather than
  inventing them.
- **Recording is best-effort.** A database failure degrades the audit trail; it
  never stalls or corrupts the navigation solution. Dropped rows are counted and
  surfaced in the system status.
- **The dashboard is desktop-first.** It is laid out for a large bridge monitor.
  It is responsive and usable on a tablet, and legible on a phone, but the dense
  engineering panels assume width.

---

## 8. Security limits

Detailed in [security.md](security.md). In summary, the following are
**documented requirements, not implemented features**: secure boot, signed
firmware, signed software releases, mTLS, certificate management, network
segmentation enforcement, IEC 62443 alignment, formal vulnerability management
and incident response.

The authentication layer is a demonstration placeholder. It uses bcrypt, lockout
and audit logging correctly, but production would federate to the operator's
identity provider and add server-side token revocation.

---

## 9. What field performance actually depends on

Nothing in this demonstration predicts performance at sea. Real performance
depends on:

vessel type · sensor installation and alignment · gyrocompass quality · DVL
availability and bottom lock · radar field of view and mounting height · map
quality and registration · bathymetric survey age and resolution · tide · sound
velocity · seabed distinctiveness · weather · sea state · sensor latency ·
operating area · outage duration.

Establishing real performance requires the staged programme in
[roadmap.md](roadmap.md): recorded-data integration, shadow mode, and a
controlled harbour trial against surveyed reference truth.
