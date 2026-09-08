# Engineering assumptions

Every assumption the platform rests on, why it was made, and what would change
if it turned out to be wrong. Nothing here is hidden in code comments only.

---

## 1. Operating environment

| # | Assumption | Basis | If wrong |
|---|---|---|---|
| A1 | The operating area is a coastal harbour approach of a few kilometres, with a surveyed shoreline and mapped structures | The Safeen use case: hydrographic survey and marine operations in UAE waters | Radar map matching degrades with distance from mapped features; open-ocean operation would leave bathymetry and INS as the only aiding |
| A2 | The vessel is a survey vessel of roughly 38 m, 2.4 m draft, doing 0–15 kn | Stated vessel class | Turn-rate and acceleration plausibility gates would need re-tuning for a faster or more manoeuvrable vessel |
| A3 | Sea state is moderate; heave and roll do not invalidate the depth or DVL measurements | Harbour and coastal survey operations | Heave compensation becomes necessary before terrain matching is usable |
| A4 | A tide model or gauge is available and predicts the tide to about 0.1 m | Standard survey practice in a known area | Terrain matching accuracy degrades roughly in proportion to the tide error |
| A5 | Sound velocity is known to about 1 m/s | Survey practice: SV profiles are taken | Depth bias grows; the terrain matcher's per-candidate bias estimator absorbs a constant offset but not a depth-dependent one |

---

## 2. Sensors

| # | Assumption | Basis | If wrong |
|---|---|---|---|
| B1 | A gyrocompass is fitted and is the vessel's heading reference | Universal on this vessel class | Without any compass the platform cannot rotate DVL velocity into the local frame; heading would have to come from radar matching alone, and the uncertainty would be far larger |
| B2 | A DVL is fitted and holds bottom lock in water shallower than about 120 m | Stated equipment list | Dead-reckoning uncertainty growth roughly triples on the speed log alone; this is modelled and shown |
| B3 | Radar-derived localization is available either as a vendor fix or as a point cloud | Stated: "radar-derived localization" | Without either, the platform falls back to bathymetry and dead reckoning, and 2 m is unlikely to be assurable during an outage |
| B4 | Sensors timestamp their own measurements, and the clocks are disciplined to within about 1 s | Ordinary shipboard practice | Time-alignment errors read as position errors. Offsets and jumps are detected and alarmed rather than silently absorbed |
| B5 | Sensor latency is roughly known and bounded (10–300 ms) | Vendor datasheets | The time-alignment step uses each message's own timestamp, so a wrong *nominal* latency does not matter; an unstamped stream would |
| B6 | INS, where fitted, is not drift-free | Physics | The platform never treats INS as absolute; its uncertainty grows when unaided |
| B7 | AIS is advisory only | Regulatory reality: AIS position is self-reported by other vessels | AIS never enters the fusion, at all |

---

## 3. Maps and reference data

| # | Assumption | Basis | If wrong |
|---|---|---|---|
| C1 | A radar reference map of shoreline and structures exists and is registered to about 0.5 m | Safeen "has general vector maps and ENC-like data" | Map registration error becomes a systematic position error. It is carried explicitly in the protection level as the radar correlated-error term (0.70 m) |
| C2 | Bathymetric data exists at roughly 10 cm grid resolution in selected areas | Stated by Safeen | **Grid resolution is not positioning accuracy.** See §5 below |
| C3 | The bathymetric survey is recent enough that the seabed has not moved | Survey practice | A dredged or shoaled area produces a systematic terrain-matching error; survey age is carried with the grid |
| C4 | Surveyed control points exist for local ranging where that infrastructure is installed | Survey practice | Local ranging accuracy is bounded by the control-point survey, which is carried as its correlated-error term (0.12 m) |
| C5 | An approved operating polygon is defined | Stated requirement | Geographic plausibility checks lose one of their inputs |

---

## 4. Threat model

| # | Assumption | Basis | If wrong |
|---|---|---|---|
| D1 | An attacker can transmit false GNSS signals — jump, drag, freeze, false velocity, false time | The specification's scenario list | Handled: these are exactly the detections implemented |
| D2 | The attacker **cannot** simultaneously falsify radar returns, the seabed, the DVL and the gyrocompass | The physics of those sensors differ; a single RF attack does not reach them | This is the assumption the whole platform rests on. If an adversary could corrupt an independent source *consistently with* the spoofed GNSS, the cross-checks would agree and the platform would be fooled. Stated plainly rather than glossed over |
| D3 | The stored maps have not been tampered with | Physical and procedural control of the vessel's data | A falsified radar map would make radar agree with a spoofed GNSS. Production needs signed map data and version attestation — see [security.md](security.md) |
| D4 | The platform's own network is segmented from the sensor network | Standard OT practice | Sensor ingestion and UI access are separated by role and transport; on a vessel the UDP listener belongs on a dedicated sensor VLAN |

---

## 5. The 10 cm bathymetry question

Safeen has bathymetric data at approximately 10 cm grid resolution. It does
**not** follow that terrain matching yields 10 cm positioning.

Achievable accuracy is governed by, in rough order of importance:

1. **Seabed distinctiveness.** Over a flat dredged basin the depth is the same
   for hundreds of metres in every direction. No amount of grid resolution
   recovers position information that the seabed does not contain. This is why
   the platform measures *terrain observability* and *ambiguity* explicitly and
   refuses to publish a confident fix when they are poor.
2. **Sounder noise and beam footprint.** A single-beam sounder at 12 m depth
   with a 3° beam averages over roughly a 0.6 m footprint.
3. **Tide and sound-velocity uncertainty.** Both appear as a depth bias. The
   matcher estimates and removes a constant bias per candidate, which handles
   the common-mode part but not a depth-dependent error.
4. **Draft and squat.** Squat varies with speed and under-keel clearance.
5. **Vessel dynamics.** Sequence matching assumes the track shape between
   samples is known; a heading error distorts it.

In this platform bathymetric matching is configured with a 2.6 m fusion sigma and
a 1.5 m correlated-error term. That is the honest number for this method on this
data, and it is the reason bathymetry alone does not assure 2 m.

---

## 6. Modelling simplifications

| # | Simplification | Effect | Production alternative |
|---|---|---|---|
| E1 | Local tangent-plane (ENU) rather than full geodetic filtering | Sub-centimetre over a few kilometres — two orders of magnitude below the quantity being assessed | Earth-centred frame for ocean-scale operation |
| E2 | Nearly-constant-velocity process model | Adequate for a survey vessel; a hard manoeuvre transiently inflates residuals | Coordinated-turn or IMM model |
| E3 | Heading propagated by measured rate of turn, not by a full attitude solution | Correct for a surface vessel with a compass | Full INS mechanisation where an INS is fitted |
| E4 | Trimmed point-to-point ICP for scan matching | No motion distortion correction, no probabilistic data association, no clutter model | OEM localization output, or a proper scan matcher with those features |
| E5 | Grid search rather than a particle filter for terrain matching | Discretisation adds `step²/12` to the covariance; multi-modality is detected but not tracked over time | Particle filter with per-beam measurement likelihood |
| E6 | Correlated errors are configured constants | Cannot adapt to conditions | Estimated online, or from trial data |
| E7 | Alarm severity is a static mapping | Cannot escalate on repetition | Configurable escalation policy |

---

## 7. Simulation assumptions

These apply only to the demonstration data, and are called out because
simulation results must never be presented as field-proven.

| # | Assumption |
|---|---|
| F1 | Sensor noise is Gaussian and white, apart from explicitly modelled Gauss–Markov biases. Real sensors have heavier tails |
| F2 | Radar performance is modelled as a function of the number and bearing spread of mapped features in range. Real radar also depends on sea clutter, rain, target aspect and antenna height |
| F3 | The synthetic seabed is smooth and analytic. Real seabeds have rocks, wrecks and dredge scars that both help and hinder matching |
| F4 | Ground truth is exact. In a real trial the reference is RTK, itself good to a few centimetres, and must be time-aligned |
| F5 | The vessel follows its route with a simple heading controller. A real vessel is steered by a human or an autopilot responding to wind, current and traffic |
| F6 | Message loss is modelled as dropout; real networks also reorder and duplicate — both of which are separately injectable and detected |

---

## 8. What "requirement met" means here

The platform reports `REQUIREMENT_MET` when **all** of the following hold:

- the horizontal protection level is at or below the configured limit (2.0 m) at
  the configured confidence (95 %);
- at least one independent absolute positioning source is currently valid;
- no unresolved critical sensor inconsistency is being carried.

It is a statement about a **bound**, not about the average error. A system with a
0.3 m average error and no way to detect a 40 m spoof has not met this
requirement; a system with a 0.9 m error and a defensible 1.8 m bound has.

The performance report additionally measures how often the bound actually
contained the error — the **misleading information rate**. That number, not the
average error, is the one to judge the platform by.
