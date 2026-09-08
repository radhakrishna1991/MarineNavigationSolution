# Safeen GNSS-Denied Survey Demonstration

The guided demonstration required by Section 30. Fifteen minutes of simulated
time, thirteen narrated stages, one continuous run — from a healthy fix, through
a spoofing attack, into GNSS-denied navigation, past the point where the 2 m
requirement can no longer be assured, and back to a validated GNSS solution.

Scenario id `SCN_15_SAFEEN_DEMO` · seed 2024 · 900 s · INS fitted · local
ranging not available.

---

## 1. Before the room fills

```bash
# 1. Database ready and seeded
npm run db:migrate && npm run db:seed

# 2. Start the stack
npm run dev            # backend :4000, dashboard :5173
#   or: docker compose up --build   → dashboard on :8080

# 3. Confirm health
curl -s localhost:4000/api/health | jq .status     # "ok"
```

Sign in as `operator` (or `admin` to change configuration live). Open
**Demonstration** in the navigation rail. Put the browser full-screen on the
largest display available; the layout is built for a bridge monitor.

Pre-flight checklist:

- [ ] Health endpoint returns `ok` and the database is connected.
- [ ] The header link indicator reads **LIVE**.
- [ ] No scenario is running (`Reset` if one is).
- [ ] The Demonstration page shows all thirteen steps, none active.
- [ ] A second browser tab is open on **Analytics**, for the report at the end.

If anything is wrong, use `npm run generate:data` to reseed the demonstration
history, then reload.

**Total running time:** 15 minutes at 1× speed. At 2× the whole story takes 7½
minutes, which fits a short slot; the narration below holds at either speed. The
speed control is on the scenario bar.

---

## 2. Opening — the claim, stated precisely (1 min, before starting)

Say this before pressing Start, and say it in these words:

> We do not claim to create an accurate position from information that is not
> available. What this platform does is decide which navigation sources can be
> trusted, combine the ones that can, quantify how uncertain the result is, and
> warn you *before* the less-than-two-metre requirement can no longer be assured.
>
> You are going to watch it lose GNSS to an attack, keep navigating without it,
> and then tell you honestly that it can no longer guarantee two metres. That
> last part is the product.

Point out three things on screen before anything moves:

1. **The requirement banner** — `SAFEEN <2 m REQUIREMENT: MET`. This is the
   single line that matters.
2. **The protection level** — currently around 1.1 m. Not the estimated error;
   the *bound* on the error.
3. **The read-only notice** in the rail — this system has no connection to
   steering, propulsion or DP, and cannot be given one.

Press **Start demonstration**.

---

## 3. The thirteen stages

The Demonstration page highlights the current stage and marks completed ones. The
narration column on the right repeats the detail text; you can read from the
screen.

### Stage 1 — Healthy start · t = 0 s

GNSS, radar and DVL agree. Trust score 90+. Mode `NORMAL_GNSS`. Protection level
about 1.1 m against a 2 m limit.

> Everything is healthy. GNSS agrees with radar and with the Doppler log to
> within the noise. Note that GNSS is being *checked* even now — it is one
> sensor among several, not the reference the others are compared against.

**On screen:** the trusted position, the raw GNSS position and ground truth are
plotted separately on the map and sit on top of one another. Keep the legend
visible; the moment they separate is the moment that matters.

### Stage 2 — Spoofing begins · t = 120 s

A gradual drag starts: 0.12 m/s on a bearing of 100°, ramping to 45 m. Nothing
visible yet. That is the point.

> The attack has started. You cannot see it — the offset is centimetres. A
> receiver-only integrity check would not see it either. What follows is why an
> independent physical cross-check matters.

### Stage 3 — Residuals rise · t = 150 s

Switch to the **GNSS integrity** tab, or use the integrity panel on the
demonstration page.

> The innovation — the difference between where GNSS says we are and where the
> independent solution says we are — is growing steadily. The drag detector is
> fitting a line to that offset: rate, fit quality and accumulated distance all
> have to agree before it will call it.

**On screen:** the trust score has begun to fall; the drag condition is
accumulating confirmation epochs but is not yet confirmed.

### Stage 4 — Trust collapses · t = 180 s

Trust falls through the degraded band into suspect.

> Three separate conditions now agree: a consistent drag rate, disagreement with
> radar beyond what either sensor's own uncertainty can explain, and a velocity
> inconsistency against the Doppler log. The score is a weighted combination, not
> a single trip.

**On screen:** the map now shows visible separation between the magenta raw GNSS
track and the cyan trusted track. This is the strongest visual in the
demonstration — let it sit for a few seconds.

### Stage 5 — Spoofing alarm · t = 200 s

A `CRITICAL` alarm: GNSS rejected, spoofing suspected. GNSS is excluded from
fusion.

> There is the alarm. Read the reason line: it is a sentence, not a code. It
> names what was observed and which independent sensor contradicted GNSS. And
> read the classification — *deception*, not interference. The signal is strong
> and the metrics look healthy; that is precisely what distinguishes a spoof from
> jamming.
>
> Acknowledge it. Notice the alarm does **not** disappear — acknowledging says "I
> have seen this", not "this is over". It stays until the condition clears.

Click **Acknowledge** to demonstrate. Detection latency for this run is about
32 s from the start of the drag, at roughly 3.2 m of accumulated offset — well
inside the 20 m the specification asks for. The detection-latency figure is on
the integrity panel.

### Stage 6 — Independent navigation · t = 240 s

Mode `RADAR_AIDED` (or `MULTI_SOURCE_FUSION`). GNSS contributes nothing.

> GNSS is gone and we are still navigating. Radar matched against a mapped
> shoreline, bathymetric terrain matching against a surveyed seabed, gyro
> heading, Doppler log speed over ground. Four independent physical measurements,
> none of which can be altered by a radio transmitter.
>
> The protection level has grown — from 1.1 m to about 1.9 m. Larger, because we
> have lost a source. Still inside 2 m, so the requirement is still met, and the
> banner still reads MET. It is telling you the truth, which happens to be good
> news.

### Stage 7 — Feature-poor zone · t = 420 s

Radar confidence collapses, the seabed goes flat, and no structures are in LiDAR
range. The attacker also withdraws — GNSS stops transmitting entirely.

> The vessel has moved into open water. There are no mapped radar features, the
> seabed here is featureless, and there is nothing within LiDAR range. Every
> absolute position source has gone at once.

**On screen:** bathymetric matching now reports `ambiguous` with a reason, rather
than returning a fix. Point at that.

> Look at what bathymetry is doing. It is not guessing. It has detected that this
> terrain cannot distinguish position — many places on this seabed look the same
> — and it is declining to produce a fix. A system that reported its best guess
> here would be the dangerous one.

### Stage 8 — Uncertainty grows · t = 470 s

Protection level rising through 2 m. Requirement `AT_RISK`.

> Dead reckoning. The protection level is growing, and the growth rate is
> published alongside it. The requirement has moved to AT RISK — that is a
> *predictive* state: we are still inside 2 m, but on this trajectory we will not
> be for long. That warning is the whole point of the platform.

**On screen:** the dead-reckoning panel shows time since last absolute fix, the
dominant error contributor, and the estimated time remaining before the bound
crosses 2 m.

### Stage 9 — Integrity not assured · t = 540 s

Protection level exceeds 2 m. Mode `INTEGRITY_NOT_ASSURED`. The banner turns
critical.

> And there it is:
>
> **INTEGRITY NOT ASSURED — SAFEEN <2 m REQUIREMENT: NOT MET — OPERATOR ACTION:
> VERIFY POSITION USING INDEPENDENT MEANS.**
>
> This is the most important screen in the demonstration. A less honest system
> would still be showing a position and a green light, because it still *has* a
> position — look, there it is on the map, and the mean error is actually still
> well under a metre. But we cannot *prove* it is under two metres, and the
> difference between having a good answer and being able to prove it is the
> difference between a display and an assurance system.
>
> The position is still shown. The operator is not left blind. But nothing on
> this screen claims two-metre performance, and the guidance line tells the
> operator exactly what to do about it.

Pause here. This is the stage the audience should remember.

### Stage 10 — Radar restored · t = 640 s

Mapped features return; an absolute correction is applied.

> Radar has features again. Watch the protection level collapse as an absolute
> fix comes back in — and watch the trusted position step slightly as the
> accumulated dead-reckoning drift is corrected. That step is real and it is
> shown, not smoothed away.

Requirement returns to `MET`.

### Stage 11 — GNSS returns · t = 720 s

Clean GNSS reappears. It is **not** used.

> The attacker has stopped. GNSS is transmitting again, and by every metric it
> looks perfect. We are not using it.
>
> It is in a thirty-second validation window. For thirty seconds it has to agree
> with the independent solution continuously — and if a single anomaly appears in
> that window, the clock restarts from zero. A spoofer that goes quiet and comes
> back clean does not get a free pass.

**On screen:** the GNSS panel shows `RECOVERY_VALIDATION` with a live countdown.

### Stage 12 — Reintegration · t = 755 s

GNSS is readmitted, weight ramped in gradually. The event is logged.

> Thirty seconds elapsed, no anomalies. GNSS is readmitted — with its weight
> ramped in over several epochs rather than switched on, so a residual error
> cannot jerk the solution. The whole event is in the audit trail: exclusion
> time, evidence, classification, validation window, reintegration time.

Mode returns to `NORMAL_GNSS`. Protection level back near 1.1 m.

### Stage 13 — Report · t = 860 s

Open the **Analytics** tab.

> Here is the run measured against ground truth, which we have because this is
> simulation. Four numbers matter:
>
> - **Mean horizontal error: about 0.46 m.** Sub-metre across the whole run,
>   including the GNSS-denied section.
> - **95th percentile: about 1.3 m.**
> - **Detection latency: 32 s, at 3.2 m of offset.** The specification asks for
>   detection before 20 m.
> - **Misleading information rate: about 2 %.** Epochs where the actual error
>   exceeded the published protection level *while we were claiming the
>   requirement was met*. That is the number that would matter to a certification
>   authority, and it is the number a vendor is least likely to show you.
>
> False alarms during the healthy portion: none.

Export the report — **Export → HTML** for a self-contained document, or CSV for
the raw epochs. The export includes configuration, scenario definition, injected
faults, per-epoch data and the full alarm history, so the run is reproducible
from the artefact alone.

---

## 4. Closing (1 min)

> Three things to take away.
>
> First, GNSS was treated as one untrusted sensor from the start. It was being
> checked while it was healthy, which is why the attack was caught at three
> metres instead of forty-five.
>
> Second, when the system could no longer assure two metres, it said so. It did
> not degrade quietly. There is no configuration setting that makes that banner
> stay green.
>
> Third, everything you saw is reproducible. Same seed, same run, epoch for
> epoch. You can re-run it, change a threshold, and see exactly what that change
> costs — which is what you need before you would ever trust a system like this
> at sea.
>
> This is a proof of concept. It runs on simulation and synthetic geospatial
> data, it has no type approval, and it has never been to sea. The roadmap for
> getting from here to something that could be is a separate conversation, and we
> have written it down.

---

## 5. Running it without a browser

The whole demonstration runs headless, which is useful for a screenshot-free
record or for CI:

```bash
node scripts/run_scenario.js SCN_15_SAFEEN_DEMO --json > demo-run.json
node scripts/export_results.js --latest --format html --out ./data/exports
```

Or drive it through the API:

```bash
TOKEN=$(curl -s -X POST localhost:4000/api/auth/login \
  -H 'content-type: application/json' \
  -d '{"username":"operator","password":"'"$SEED_DEMO_PASSWORD"'"}' | jq -r .token)

curl -s -X POST localhost:4000/api/scenarios/SCN_15_SAFEEN_DEMO/start \
  -H "authorization: Bearer $TOKEN"
curl -s localhost:4000/api/navigation/current -H "authorization: Bearer $TOKEN" | jq
```

---

## 6. If something goes wrong on the day

| Symptom | Cause | Fix |
|---|---|---|
| Header reads `DISCONNECTED` | Backend not running, or the token expired | Check `:4000/api/health`; sign in again |
| No scenario starts | One is already running | **Reset**, then start |
| The map is blank | Style assets blocked | The demonstration works without the basemap; the tracks and legend still render |
| Timings differ from this document by a second or two | Debounce and confirmation windows depend on message arrival within the epoch | Expected; the stage order never changes |
| Requirement stays MET at stage 9 | The scenario was started late or restarted mid-run | Reset and start from t = 0 |
| Analytics is empty | The run has not finished | Let it complete, or use a previous run from the run selector |

**Never demonstrate against a live-ingested feed.** The recorded scenario is
deterministic; a live feed is not, and a demonstration that depends on an
attacker behaving on schedule is a demonstration that will fail in front of an
audience.

---

## 7. Questions you should expect

**"How do you know it is spoofing and not just bad GNSS?"**
Signal quality. A spoof arrives with strong, clean signals and healthy C/N0 —
the position is wrong while the metrics look excellent. Jamming is the opposite:
degraded metrics, lost satellites, no position or a noisy one. The platform
classifies them separately and says which it believes, with the evidence.

**"What if the attacker also spoofs the radar?"**
Then we are fooled, and we say so in the limitations document. The design rests
on the assumption that radar reflection off a mapped shoreline, acoustic ranging
to the seabed, and inertial sensing cannot all be corrupted consistently by one
RF transmitter. Corrupting them together is a physically different and much
harder attack.

**"Why is the requirement 'not met' when the position is actually good?"**
Because we cannot prove it is good. The mean error at that moment is about half
a metre — you can see it on the analytics page afterwards. But with no absolute
source, we cannot bound it, and an unprovable claim is not an assurance. Saying
"met" there is exactly the failure mode this system exists to prevent.

**"Would this work with our sensors?"**
The adapter layer is vendor-neutral and NMEA 0183 is implemented. NMEA 2000,
IEC 61162-450 and vendor-specific transports are declared with their contracts
but not built — they need hardware to validate against. That is Phase 2 of the
roadmap.

**"Can it steer the vessel?"**
No, and it is not that it has not been built yet. The navigation API refuses
every write method with an explanation, no adapter has an output direction, and
the read-only property is not runtime-editable. A decision-support system that
can also act is a control system, and that needs a completely different
assurance case.
