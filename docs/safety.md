# Safety

How the platform behaves when it cannot do its job, and why those behaviours
were chosen.

---

## 1. The safety argument in one paragraph

A navigation display that is confidently wrong is more dangerous than no display
at all, because it removes the operator's reason to check. Every design decision
in this platform follows from that: the system prefers to say "I cannot bound
this" over producing a number it cannot justify, it never lets a status turn
green without an independent absolute source, and it makes the raw sensor values
available so the operator can always go behind the conclusion.

---

## 2. Fail-safe behaviour

When confidence is insufficient the platform:

| Requirement (Section 23) | How it is met |
|---|---|
| Does not continue displaying a green assured status | `REQUIREMENT_MET` requires the bound to be inside the limit **and** an independent absolute source **and** no unresolved critical inconsistency. Removing any one of them changes the status |
| Displays `INTEGRITY NOT ASSURED` | A dedicated mode and integrity state, shown in the main banner in critical styling with the reason |
| Displays the increasing uncertainty | The protection level, its growth rate, the dead-reckoning duration and the time since the last absolute fix are all on the main screen |
| Identifies the missing or faulty sensors | The excluded-sensor list carries a plain-language reason for each; the sensor panel gives the residuals behind it |
| Recommends manual verification | Every mode carries operator guidance; the critical banner shows it verbatim |
| Preserves operator access to raw sensor values | The sensor panel shows the last messages per sensor, and the map plots each source's own position separately |

### Never fabricate a position

There is no code path that invents a position when observability is
insufficient:

- The filter publishes nothing until it has been seeded with **both** an
  absolute position and a heading reference. Until then `solution_available` is
  false and the banner reads `NOT AVAILABLE`.
- Bathymetric matching returns `valid: false` with a reason when the terrain is
  unobservable or the solution is ambiguous, rather than returning its best
  guess.
- Scan matching returns `valid: false` when it cannot find enough
  correspondences.
- The dead-reckoning engine returns `null` before it has been anchored.

### Never hide a reset

If the filter has to be reset onto an absolute source after persistent
divergence, that reset raises a `WARNING` alarm stating how far the solution
moved, and telling the operator that positions published in the preceding period
should be treated as unreliable. A silent reset would erase the evidence that the
display had been wrong.

---

## 3. Alarm philosophy

| Property | Behaviour | Why |
|---|---|---|
| Acknowledgement ≠ clearing | An acknowledged alarm whose condition persists stays active and visible | Standard bridge convention. It stops a critical warning being dismissed while it is still true |
| Debounced | An identical code from the same source within the debounce window increments an occurrence count instead of creating a new alarm | At 5 Hz a persistent condition would otherwise produce 300 alarms a minute and the panel would become useless |
| Every alarm has a reason and an action | `reason` explains what was observed; `recommended_action` says what to do | An alarm without an action is noise |
| Severity ladder | INFO · ADVISORY · WARNING · CRITICAL | Section 15.5 |
| Only critical unacknowledged alarms animate | A slow pulse, disabled under `prefers-reduced-motion` | Motion is an alerting channel; spending it on decoration destroys it |
| Alarms are immutable from the UI | No edit or delete control exists, and the audit log is protected by a database trigger | Section 21 |

---

## 4. Colour is never the only indicator

Section 27 requires it, and it is enforced structurally: the `StatusChip`
component renders a glyph and a label alongside the colour, and there is no code
path that renders a bare coloured dot. The status palette is additionally
blue-shifted in the greens and amber in the warnings, so the states remain
distinguishable under the common forms of colour vision deficiency.

Every status also appears as text in the main banner:

```
TRUSTED NAVIGATION: AVAILABLE
MODE: RADAR-AIDED NAVIGATION
GNSS: REJECTED — GRADUAL SPOOFING DETECTED
HORIZONTAL PROTECTION LEVEL: 1.42 m
SAFEEN <2 m REQUIREMENT: MET
```

```
INTEGRITY NOT ASSURED
MODE: DEAD RECKONING
HORIZONTAL PROTECTION LEVEL: 3.75 m
SAFEEN <2 m REQUIREMENT: NOT MET
OPERATOR ACTION: VERIFY POSITION USING INDEPENDENT MEANS
```

---

## 5. Staleness is a first-class state

A dashboard that silently shows the last frame it received, forever, is
dangerous. The connection state is part of the model:

- The header shows `LIVE`, `CONNECTING`, `DISCONNECTED` or `LINK ERROR`.
- The banner shows an explicit staleness warning when the last frame is more
  than three seconds old or the link is down.
- The WebSocket client reconnects with exponential back-off and jitter — a
  dozen bridge displays retrying in lockstep after a switch reboot is a
  self-inflicted denial of service.
- If the interface itself crashes, the error boundary says so and tells the
  operator not to rely on the display until it is reloaded, rather than showing
  a blank area that might read as "nominal".

---

## 6. No control outputs

The platform has no interface to autopilot, dynamic positioning, propulsion or
steering gear, and cannot acquire one by configuration.

- The navigation API refuses `POST`, `PUT`, `PATCH` and `DELETE` with `405` and
  an explanation of why.
- `security.trusted_output_read_only` is true and is not runtime-editable.
- No adapter has an output direction. The adapter interface has `onMessage` and
  no `send`.
- The statement appears in `GET /api`, in `GET /api/system/status`, and in the
  dashboard's navigation rail.

This is a deliberate boundary, not an unimplemented feature. A decision-support
system that can also act is a control system, and a control system needs a
completely different assurance case.

---

## 7. Human factors

| Decision | Reason |
|---|---|
| Dark ground, high contrast | Bridge use at night; the palette does not destroy dark adaptation |
| Large status readouts | Legible across the bridge on a large monitor |
| Tabular figures throughout | A readout that jitters horizontally as digits change is hard to read on a moving vessel |
| A missing value renders as an em dash, never zero | "0.00 m" and "not available" mean very different things |
| No decorative animation | The only motion is the critical-alarm pulse |
| Maritime terminology | Heading as a three-digit bearing, position in degrees and decimal minutes, depth below transducer |
| Guidance in plain language | "Verify position using independent means", not "integrity nominal false" |

---

## 8. Data integrity

| Property | Mechanism |
|---|---|
| Recording never blocks navigation | The recorder buffers and batches; a database failure counts dropped rows and surfaces them in the system status, and never stalls the pipeline |
| The audit log cannot be altered | No application code path issues UPDATE or DELETE, and a PL/pgSQL trigger raises an exception if one ever did |
| Scenario runs are reproducible | A seeded PRNG tree, integer tick accounting, and no `Math.random()` anywhere in the data path. Determinism across differently-chunked time steps is a tested property |
| Configuration changes are attributable | Every change records the path, old and new value, the actor and an optional reason |
| Every exclusion is explained | Both the alarm and the recorded row carry a plain-language sentence naming the evidence |

---

## 9. Known unsafe conditions the platform cannot detect

Stated here rather than left to be discovered:

1. **A consistent multi-sensor attack.** If an adversary corrupts an independent
   source in a way that agrees with the spoofed GNSS, the cross-checks agree and
   the platform is fooled. The whole design rests on the assumption that the
   physics of radar, acoustics and inertial sensing cannot be attacked together
   by one RF transmitter.
2. **A falsified map.** A tampered radar reference map would make radar agree
   with a spoofed GNSS. Production needs signed map data and version
   attestation.
3. **A frozen fix on a stationary vessel.** Indistinguishable from a correct one,
   and deliberately not flagged — flagging it would produce a false alarm every
   time the vessel is alongside.
4. **Slow drag below the detection threshold, with no absolute source.** With
   nothing independent to compare against, a sufficiently slow walk is
   indistinguishable from real motion. The protection level grows in this
   situation because there is no absolute source, so the operator is told the
   position is unbounded even though the cause is not identified.
5. **A common-mode error in the surveyed reference data.** If the control points
   and the radar map share a datum error, everything agrees and everything is
   wrong by the same amount.

---

## 10. Operator responsibilities

The platform supports a decision; it does not make one.

- Position must be verified by independent means whenever `INTEGRITY NOT
  ASSURED` or `REQUIREMENT NOT MET` is displayed.
- The displayed position must never be used for navigation. This is a
  demonstration system.
- Suspected GNSS interference or spoofing should be reported through the
  operator's own channels; the platform records the event but does not report it
  onward.
- Survey operations should be suspended when the requirement cannot be assured,
  unless the operator has an independent basis for continuing.
