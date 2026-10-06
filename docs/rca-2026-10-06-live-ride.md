# Live ride RCA — 6 Oct 2026, Seetharampalya → Majestic → JP Nagar (got off Banashankari)

Evidence: rider's live notes + 26 screenshots + the ride recording (56 min, 570 GPS fixes, 3,205 s of motion,
16 motion stops, 804 tower scans), replayed offline through the same `LiveTracker` the app ran
(`scratchpad/replay.ts`). The replay reproduces the screenshots closely.

## What really happened (from GPS stops and motion stops)

- Purple: the planned train (Whitefield 18:41 → Challaghatta) was **+1.4 min late at Garudacharpalya, +2 to +3 min late
  from Swami Vivekananda Rd to Central College**, arrived Majestic ~19:30 (+1.2).
- Green: rider boarded at Majestic ~19:34. Its times (Chickpete 19:36:28, South End Circle ~19:42:57,
  Banashankari 19:51:02) are **−0.5 to −2.3 min vs our "19:36" train, or +2.7 to +4.5 vs our "19:31"** — i.e. our
  timetable has no train at that time (see C).
- Trains stood **50–90 s** at stations (GPS speed ≈ 0 windows; GPS smoothing inflates these a little).
  **Our timetable gives every stop 26 s.**

## Root causes

| # | Symptom (rider) | Root cause | Evidence |
|---|---|---|---|
| A | "At X" while approaching, "Next Y" while still standing (Baiyappanahalli, Trinity, MG Road) | **The display follows the clock, not the position.** "At / Next" is decided by timetable times + delay, with a fixed **26 s** dwell from the feed. Real dwell is ~45–75 s, so the clock "leaves" the station while the train is still there. | Replay: At IDN 19:15:30 → Next HLRU 19:15:45 while GPS shows standing 19:15:17–19:16:31; HLRU and TTY skipped "At" entirely. |
| A2 | Delay too small (said ~1.5 min when +2.5) | **Constant-speed assumption between stations**: mid-stretch fixes look early. Also no update while standing "within the timetable window". | Replay delay 1.4–2.0 min vs true 2.2–2.7 on SVRD–MAGR. |
| B | Cubbon Park: delay +4 → −2, "different train", "you'll miss the 19:36", counting one station behind | **Low-accuracy fixes accepted** (filter ≤150 m; 30% of fixes were 50–100 m, 24% worse than 150 m) near the tunnel → delay +3.7 → **train switch on a single reading** (rule: >4 min off) to the *next* train (−2.3). After that every expected time belonged to the wrong train, so motion stops matched one station off and the change looked missed. | Replay 19:25:45 delay 3.7 gps → 19:26:30 −2.3 SWITCHED; "At CBPK" shown 19:27:45, true 19:25:19; MISSED at 19:34:15. |
| C | Green "2 min early", "different train", lag after tunnel | **Timetable out of date for Green evening service** (rider observed 19:34; Where is my Train shows shifted times and Nagasandra short-turns; our 17 Aug copy has Peenya Industry and 19:31/19:36). Plus the "switched" flag from Purple **never reset** at the change (bug). | Obs vs table above; screenshots show "different train" on Green from the first minute. |
| D | National College showing KR Market | Underground (Majestic–KR Market) → clock only; **GPS needs ~30–60 s to recover after the tunnel**, and the motion stop at the exit station wasn't used to re-sync. | Replay: first good fix after tunnel at Chickpete/NLC; stops matched late. |
| E | "Rider report · 1 min ago" while riding | **Own shared delay read back** as another rider's report once GPS was stale. | Code path `askRiders` → `external()` doesn't exclude own uid. |
| F | No "Doors opened" button underground | Update hadn't reached the phone (0 door taps recorded; button condition met). | Recording: mark = 0. |
| G | Majestic change "6 min walk" | Purple → Green has no rider data → generic estimate. Rider made 19:30 → 19:34 (~4 min incl. wait). | Recording: KGWA arrival ~19:30, departure ~19:34. |

Not causes: background capture (worked: GPS every minute for 56 min), motion stop counting (16 vs 15 GPS stops),
GPS on elevated stretches (re-synced quickly).

## Fixes (to validate by replay on rides from several phones before shipping; no phone-specific constants)

1. **Position decides "At / Next" when GPS is trustworthy**: station zone ±120 m along the track + speed ≈ 0 ⇒ "At";
   leave zone in travel direction (2 readings) ⇒ "Next". Clock only when there is no trustworthy GPS. (A)
2. **Re-sync at every stop**: GPS stop in a zone, motion stop, or door tap ⇒ delay = now − scheduled arrival. (A, D)
3. **Learned dwell** per station from rides (start with a realistic default, e.g. 40 s, not the feed's 26 s). (A)
4. **Speed profile** (accelerate–cruise–brake) instead of constant speed between stations. (A2)
5. **Weight fixes by the accuracy the phone reports**; ignore > ~75 m for delay; expect GPS loss near known tunnel portals. (B)
6. **Train switch only on sustained evidence** (≥3 good fixes over ≥30 s, all fitting the other train better), never while
   counting stops; reset `switched` at each leg. (B, C)
7. **Timetable freshness**: verify against the official source; flag trains that rides consistently disagree with; learn
   corrections (≥2 riders). (C)
8. Ignore own uid in rider delay reports; show "On time" within ±90 s with hysteresis; app version in Settings. (E, F)
9. Interchange time learned from rides (Majestic Purple→Green: first measurement ~4 min). (G)

Open question to rider: Green train's destination board — Silk Institute or Yelachenahalli? (decides which train it was)
