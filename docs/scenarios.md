# The fifteen scenarios, in plain language

Each scenario is a rehearsed situation the platform is put through. You press
start, the vessel sails a route, and at set times something goes wrong on
purpose. Nothing is random: the same scenario always produces exactly the same
run, so you can show it twice and get the same answer both times.

**The question every scenario asks is the same one:** can the platform still
tell you where the vessel is — and, more importantly, does it tell you honestly
when it can't?

---

## How to read the screen during any scenario

Four things on the main display carry the story:

| On screen | What it means |
|---|---|
| **SAFEEN <2 m REQUIREMENT** | The headline. `MET` means we can prove the position is good to within 2 m. `NOT MET` means we cannot prove it — which is not the same as the position being wrong |
| **HORIZONTAL PROTECTION LEVEL** | A worst-case bound on the error, in metres. Not the error itself — the limit we are confident it stays inside |
| **GNSS** | Whether the satellite fix is being trusted, and if not, why |
| **The map** | Cyan is the trusted position, magenta is what GNSS claims, amber is the true position. When these separate, you are watching an attack |

One habit worth teaching an operator: **watch the gap between the cyan and
magenta tracks.** That gap *is* the attack, drawn to scale.

---

## Group 1 — Does it work when nothing is wrong?

### 1. Healthy Navigation · `SCN_01_HEALTHY` · 10 minutes

Everything works. GNSS is honest, all sensors agree, the vessel sails its route.

**Why it matters more than it sounds.** A system that shouts "spoofing!" at
healthy GNSS is worse than useless — the crew will switch it off within a week.
This scenario proves the platform stays quiet when it should.

**What to point at:** the requirement stays `MET` for 99 % of the run, and the
false-alarm count is **zero**. Mean error 0.33 m.

---

## Group 2 — Someone is faking the GNSS signal

These four are the heart of the product. In each one an attacker is transmitting
a false satellite signal to make the vessel think it is somewhere it is not.

### 2. Sudden Jump · `SCN_02_GNSS_JUMP` · 10 minutes

At 3 minutes, the GNSS position **leaps 50 metres east** in an instant. Every
other sensor says the vessel has not moved.

**The obvious attack.** A vessel cannot teleport 50 m, and the radar, the
Doppler log and the gyro all say so.

**What to point at:** detected in **0.4 seconds** — one update. A `CRITICAL`
alarm names the radar disagreement as the evidence, and GNSS is thrown out.
Despite that, the vessel's own position stays accurate to 0.28 m throughout,
because the platform never believed the jump.

### 3. Gradual Drag · `SCN_03_GRADUAL_DRAG` · 12 minutes

From 2½ minutes, GNSS is pulled away **one metre every ten seconds**, creeping
to a 40 m offset.

**This is the dangerous one.** Any single reading looks completely normal — a
metre is well inside ordinary GNSS noise. This is how a real attack would be
done, precisely because it doesn't look like an attack.

**What to point at:** caught at about **3 metres** of offset, roughly 30 seconds
in. The specification asks for detection before 20 m. Three separate pieces of
evidence have to agree before the platform will make the accusation — a steady
drift rate, a good fit to a straight line, and disagreement with radar — so it
isn't tripped by noise.

### 4. Jamming · `SCN_04_JAMMING` · 11 minutes

From 3½ minutes, interference builds until the receiver loses the satellites
entirely.

**Different from spoofing, and the platform says so.** Jamming is loud and
crude: signal strength collapses, satellites drop out. Spoofing is quiet:
signals look *perfect* while the position is a lie. The platform classifies
which it believes it is seeing, because the response differs — jamming is
interference to be reported, spoofing is an attack.

**What to point at:** classified as **interference, not deception**, and
navigation simply carries on without GNSS. Mean error 0.26 m for the whole run.

### 5. False Time and Frozen Position · `SCN_12_FALSE_TIME` · 8 minutes

Three subtler fakes in sequence: the GNSS **clock** is shifted 4 seconds, then
the position is **frozen** while the vessel keeps moving, then the reported
course is falsified by 55°.

**Why the clock matters.** Time and position are the same problem in satellite
navigation — shift the clock and you shift the position. A falsified clock also
corrupts anything else on the vessel using GNSS time.

**What to point at:** the frozen position is caught because the Doppler log
proves the vessel is making way. And note the honest limit — the platform will
**not** flag a frozen fix on a genuinely stationary vessel, because alongside
that is the correct reading.

---

## Group 3 — GNSS is gone, and now the backups are struggling

These test what happens as the independent sources run out. This is where the
platform's honesty is tested rather than its cleverness.

### 6. Flat Seabed · `SCN_05_FLAT_SEABED` · 10 minutes

GNSS is lost, and the vessel crosses a **dredged basin with a featureless
bottom**.

**The problem:** one way to navigate without GNSS is to match the measured depth
profile against a survey. Over varied seabed that works well. Over a flat basin,
a hundred different places all look identical.

**What to point at:** the matcher reports **ambiguity** — it says "this terrain
cannot tell me where I am" and declines to produce a fix. It does not quietly
return its best guess. A guess here would be a confidently wrong position, which
is the single most dangerous thing a navigation system can produce.

### 7. Radar Feature Loss · `SCN_06_RADAR_LOSS` · 10 minutes

GNSS is gone, and the vessel moves into open water where **too few mapped
landmarks** remain in radar view.

**What to point at:** the requirement walks down the ladder — `MET` → `AT RISK`
→ `NOT MET` — as the last absolute reference fades. `AT RISK` is a *prediction*:
we are still inside 2 m, but on this trend we won't be for long. That advance
warning is the product.

### 8. Doppler Log Bottom-Lock Loss · `SCN_07_DVL_BOTTOM_LOCK` · 9 minutes

GNSS is gone and the Doppler log **loses its lock on the seabed** in deep water,
falling back to a less accurate speed log.

**What to point at:** the uncertainty growth rate visibly accelerates, and the
panel names which sensor is now the dominant source of error. Bottom lock is the
single biggest factor in how long a vessel can navigate without GNSS.

### 9. Gyro Heading Bias · `SCN_08_GYRO_BIAS` · 10 minutes

The compass slowly develops a **6° error**.

**Why heading matters so much.** A heading error doesn't add to your position
error — it *multiplies* it with distance. Half a mile at 6° off is about 80 m
sideways.

**What to point at:** the filter estimates the bias and corrects for it, while
the monitor separately flags the disagreement with radar-derived heading. The
position error stays bounded, and the requirement is still met 94 % of the run.

### 10. Multiple Sensor Failure · `SCN_10_MULTIPLE_FAILURE` · 12 minutes

Everything fails together: GNSS is dragged then lost, radar goes, LiDAR goes,
the seabed goes flat, and the Doppler log becomes noisy.

**The most important scenario in the set** — and the one where a weaker system
would look best, because it would keep showing a confident position.

**What to point at:** the platform declares **INTEGRITY NOT ASSURED** and
`REQUIREMENT NOT MET`, and tells the operator to verify position by independent
means. It still shows a position — the operator is not left blind — but it makes
no claim about it. There is no setting anywhere that keeps that banner green.

---

## Group 4 — Recovering, and running on other infrastructure

### 11. GNSS Recovery Validation · `SCN_09_GNSS_RECOVERY` · 12 minutes

GNSS is spoofed, rejected, then at 7 minutes **comes back looking perfect**.

**The trap this avoids:** an attacker who goes quiet and returns clean. If you
readmit GNSS the moment it looks healthy, the attack simply resumes.

**What to point at:** GNSS is held out for a full **30 seconds** of continuous
agreement before it is allowed back — and if anything looks wrong during that
window, the clock restarts at zero. When it is readmitted, its influence is
ramped in gradually rather than switched on. Measured: back in at 30.2 s.

### 12. Local Positioning · `SCN_14_LOCAL_POSITIONING` · 10 minutes

GNSS is unavailable, but the vessel is inside a **quay area covered by shore-based
acoustic ranging** — infrastructure, not satellites.

**What to point at:** the requirement stays **met** on local ranging alone, with
a protection level under 1 m. This is what "assured navigation in a GNSS-denied
harbour" actually looks like when the infrastructure exists. The limit is
coverage, not accuracy — outside the instrumented area it is gone.

### 13. Without an Inertial System · `SCN_13_INS_DISABLED` · 10 minutes

The same GNSS outage as scenario 4, but with **no INS fitted at all**.

**What to point at:** it works. INS is genuinely optional. This matters
commercially — it means the platform does not require an expensive inertial unit
on every vessel to be useful.

### 14. Message Integrity Faults · `SCN_11_MESSAGE_INTEGRITY` · 8 minutes

Not an attack — the ordinary mess of a real sensor network. Delayed messages,
duplicates, readings arriving out of order, a frozen value, a speed log reading
18 % high, an echo sounder offset by 1.4 m.

**What to point at:** every defect is detected and categorised, and **navigation
is unaffected**. This is the unglamorous scenario, and it is the one that decides
whether the system survives contact with a real vessel.

---

## 15. The Safeen Demonstration · `SCN_15_SAFEEN_DEMO` · 15 minutes

The full story in one run, with thirteen narrated stages on screen:

| Time | What happens |
|---|---|
| 0:00 | Healthy. Everything agrees, requirement met |
| 2:00 | Spoofing begins — invisible at first |
| 2:30 | Residuals start to rise |
| 3:00 | Trust score collapses |
| 3:20 | **Critical alarm.** GNSS excluded, deception identified |
| 4:00 | Navigating on radar, bathymetry, gyro and Doppler log |
| 7:00 | Feature-poor zone — radar and seabed references fail |
| 7:50 | Uncertainty growing, requirement `AT RISK` |
| 9:00 | **INTEGRITY NOT ASSURED** — the honest answer |
| 10:40 | Radar features return, position corrected |
| 12:00 | GNSS returns — held in a 30-second validation window |
| 12:35 | Reintegrated, event logged |
| 14:20 | Export the performance report |

Full narration for presenting this is in [demo-script.md](demo-script.md).

---

## The numbers, all fifteen

Measured against the simulated truth. "Mean error" is how far the trusted
position actually was from the real one.

| Scenario | Mean error | Worst | Requirement met | Misleading |
|---|---|---|---|---|
| 1 Healthy | 0.33 m | 0.79 m | 99 % | 0 % |
| 2 Sudden jump | 0.28 m | 0.79 m | 45 % | 0 % |
| 3 Gradual drag | 0.36 m | 1.99 m | 24 % | 1.2 % |
| 4 Jamming | 0.26 m | 0.64 m | 47 % | 0 % |
| 5 Flat seabed | 0.24 m | 0.86 m | 20 % | 0 % |
| 6 Radar loss | 0.23 m | 0.77 m | 17 % | 0 % |
| 7 Bottom-lock loss | 0.25 m | 0.70 m | 19 % | 0 % |
| 8 Gyro bias | 0.34 m | 0.86 m | 94 % | 0 % |
| 9 GNSS recovery | 0.33 m | 0.78 m | 58 % | 0 % |
| 10 Multiple failure | 0.41 m | 2.27 m | 18 % | 0.8 % |
| 11 Message faults | 0.37 m | 1.39 m | 49 % | 0 % |
| 12 False time / frozen | 0.25 m | 0.82 m | 45 % | 0 % |
| 13 No INS | 0.28 m | 0.83 m | 20 % | 0 % |
| 14 Local positioning | 0.24 m | 0.65 m | 84 % | 0 % |
| 15 Safeen demonstration | 0.46 m | 3.42 m | 34 % | 2.2 % |

### Reading this table honestly

**The low "requirement met" percentages are the right answer, not a failure.**
In most of these scenarios GNSS is deliberately removed for most of the run. Once
it is gone, radar map matching in this environment gives a 2–3 m bound — and 3 m
does not prove 2 m. So the platform says so.

Look instead at the first column. **The position stays sub-metre throughout**,
including through every attack. The platform knows where the vessel is. What it
declines to do is *claim* an accuracy it cannot prove.

**The last column is the one that would matter to a certification authority.**
"Misleading" counts the moments when the real error was worse than the bound we
published *while we were saying the requirement was met* — the only genuinely
dangerous failure mode. It is zero in eleven of fifteen scenarios and never above
2.2 %.

---

## Running them

From the **Replay & Scenario** screen: pick one, press start. You can pause, step
forward a few seconds at a time, change speed, and inject extra faults by hand.

Headless, for a written record:

```bash
node scripts/run_scenario.js SCN_03_GRADUAL_DRAG    # one scenario, full report
node scripts/run_scenario.js --all                  # all fifteen, one line each
```

Every run is reproducible from its seed — the same scenario gives the same
result every time, which is what makes it fair to compare two configurations.

> All of this is simulation. The vessel, the sensors, the harbour and the seabed
> are synthetic, and none of it is navigational data. What these scenarios
> demonstrate is the platform's *reasoning*, not its performance at sea — see
> [limitations.md](limitations.md).

---

# How to present this to a client

## Do not show all fifteen

Fifteen scenarios is a reference list, not a presentation. An audience can hold
about three ideas. Pick three scenarios that each make one point, and let the
rest sit in this document as evidence that the work is thorough.

## Lead with their problem, not your product

Open with two questions, and wait for the answers:

> "How do you know your position is right?"
>
> — *"GPS."*
>
> "And how would you know if it wasn't?"

The second question usually gets a pause. That pause is your entire pitch. Every
vessel has a position display; almost none can tell you whether to believe it.

Then state the claim in one sentence, and be careful to state it narrowly:

> We don't claim to create an accurate position out of nothing. We work out
> which sources can be trusted, combine the ones that can, and tell you — before
> it matters — when we can no longer guarantee two metres.

## The three-act demonstration

Roughly ten minutes of screen time. Each act makes exactly one point.

### Act 1 — "It stays quiet when nothing is wrong" · scenario 1 · 2 minutes

Start the healthy run. Let it sit. Point at the green banner and the zero
false-alarm count.

> Nothing is happening, and that is the point. A system that cries wolf gets
> switched off in the first week. This one has raised no alarms in ten minutes
> of healthy operation.

Do not linger. This act only exists so that Act 2 means something.

### Act 2 — "It catches what you cannot see" · scenario 3 · 5 minutes

This is the one that sells the product. Start the gradual drag.

At two minutes, before anything visible happens, say:

> The attack has already started. GNSS is being pulled off track by one metre
> every ten seconds. You cannot see it, and neither could the receiver — a
> metre is ordinary GNSS noise. This is how it would actually be done.

Then let them watch the two tracks separate on the chart. **Say nothing while
that happens.** The picture is stronger than any sentence you have.

When the alarm fires:

> Caught at about three metres of offset. Read the alarm — it is a sentence, not
> a code, and it names which independent sensor contradicted GNSS. And note what
> it says: *deception*, not interference. The signal strength is perfect. That is
> exactly what tells us this is an attack and not a fault.

### Act 3 — "It tells you when it cannot help" · scenario 10 · 3 minutes

Jump to the multiple-failure scenario and run to the point where everything has
gone.

> Everything independent is now gone. Look at what the system does.

Point at **INTEGRITY NOT ASSURED** and the operator instruction.

> The position is still on the screen — the operator is not left blind — but we
> make no claim about it. A less honest system would still be showing you a
> green light here, because it still *has* a position. Being able to prove a
> position and merely having one are different things, and the difference is
> what you would be buying.

Then close the loop:

> That is the whole product in one screen. Anyone can show you a position. We
> will tell you when to stop trusting it.

## Fitting the time you actually have

| You have | Show | Why |
|---|---|---|
| **5 minutes** | Scenario 3 only | The gradual drag alone makes the case |
| **10 minutes** | Acts 1–3 above | The full argument |
| **20 minutes** | Add scenario 9 (recovery validation) | Shows judgement, not just detection — GNSS returns looking perfect and is still held out for 30 seconds |
| **A full session** | Run scenario 15 end to end | The narrated 15-minute story; see [demo-script.md](demo-script.md) |

If someone in the room is technical, add scenario 5 (flat seabed). Engineers
respond to a system that says "I cannot answer this" far better than to one that
always produces a number.

## The question that will catch you out

Someone will look at the results table and ask why the requirement is only met
17 % of the time. Have this answer ready, because it decides the meeting:

> Because for most of that run we deliberately took GNSS away. Without it,
> radar matching in this harbour gives us a two-to-three metre bound — and three
> metres does not prove two metres, so we say so.
>
> Look at the actual error instead: under half a metre, the whole way through.
> We knew where the vessel was. What we would not do is *claim* an accuracy we
> could not prove. If we had reported "met" through that section, the number
> would have looked better and the system would have been lying to you.

Then point at the misleading-information column:

> That column counts the only failure that actually matters: moments when the
> real error was worse than the bound we published, while we were telling you
> the requirement was met. It is zero in eleven of fifteen scenarios. That is
> the number a certification authority would ask for, and it is the number a
> vendor is least likely to show you.

## Other questions worth rehearsing

**"Could an attacker fool the radar too?"**
> Then we would be fooled, and we say so in our limitations document. The design
> assumes radar reflecting off a mapped shoreline, sound bouncing off the
> seabed, and inertial sensing cannot all be corrupted consistently by one radio
> transmitter. Doing that is a physically different and far harder attack.

**"Would this work with our sensors?"**
> The adapter layer is vendor-neutral and NMEA 0183 is working today. NMEA 2000
> and the shipboard-LAN transports are specified but not built — they need real
> hardware to validate against, which is the next phase.

**"Can it steer the vessel?"**
> No, and not because we haven't got to it. There is no output path to steering
> or DP anywhere in the system, and the read-only property cannot be switched
> off. A decision-support system that can also act is a control system, and that
> needs a completely different safety case.

**"What would it cost us to find out if this works for real?"**
> Recorded data. Give us twenty hours of your vessel logs with RTK truth
> alongside, and we will tell you honestly whether our assumptions survive
> contact with your sensors. That is Phase 2 in the roadmap, it needs no capital
> and no vessel time, and it is designed to fail cheaply if it is going to fail.

## Three things to say before you finish

1. **This is a proof of concept.** Simulated sensors, synthetic seabed, never
   been to sea, no type approval. Say it yourself before they ask — it buys you
   credibility for everything else you claimed.
2. **Every run is reproducible.** Same seed, same result, epoch for epoch. They
   can change a threshold and see exactly what it costs.
3. **The honest answer is the feature.** Not the accuracy, not the algorithms —
   the willingness to say "not assured" when it is true.

## What to leave behind

- This document — what each scenario does and why.
- An exported HTML performance report from the run you showed them.
- [limitations.md](limitations.md) — leading with what the system *cannot* do is
  the fastest way to be believed about what it can.
