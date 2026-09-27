# KnowMyMetro

A Namma Metro (Bengaluru) commute app that tells you which train and which coach to take so you get a seat and still reach on time.

- **App** (`app/`): Expo (React Native), native tabs, five languages (English, ಕನ್ನಡ, हिन्दी, தமிழ், తెలుగు).
- **Server** (`functions/`): Firebase Cloud Functions in Mumbai (`asia-south1`). The journey planner runs only here, behind App Check.
- **Shared** (`shared/`): timetable types, service calendar, seat model and UI strings used by both.
- **Data** (`data/timetable.json`): built from BMRCL's timetable via the open [bmrcl-gtfs](https://github.com/Vonter/bmrcl-gtfs) feed (ODbL). Not affiliated with BMRCL.

## How it fits together

| Piece | Where | What it does |
|---|---|---|
| Home, next trains, stations | app, on the phone | Instant: uses the timetable stored on the phone |
| Trip plans | `planTrip` function | Seat-aware multi-criteria search; answers are cached on the phone for offline use |
| Timetable updates | `syncTimetable`, daily 03:30 IST | Rebuilds from the feed; the app downloads a new version in the background |
| Crowd data | app → `reports`, `crunchCrowd` nightly | One-tap "Got a seat / Standing / Packed" becomes a seat chance per train |
| Change times | app → `interchangeReports`, `crunchInterchanges` nightly | Quickest coach and minutes per interchange |
| App updates | EAS Update | Code changes reach phones without a store release |

## One-time setup

You need: Node 22, a Firebase project on the Blaze plan, an [Expo account](https://expo.dev), and (for release) a Google Play Console account.

1. **Firebase project**
   - Create the project `knowmymetro` (or change `.firebaserc`).
   - Firestore: create the database in `asia-south1`.
   - Storage: enable the default bucket.
   - Authentication → Sign-in method: enable **Anonymous**.
   - App Check: register the Android app with **Play Integrity** and the iOS app with **App Attest**.
   - Add an Android app with package `in.knowmymetro.app` and an iOS app with bundle ID `in.knowmymetro.app`.
     Download `google-services.json` into `app/` (done). `GoogleService-Info.plist` is only needed once you build for iPhone.
   - Billing → set a budget alert (for example ₹1,000/month).
2. **Install**
   ```bash
   npm install              # app + shared (workspaces)
   npm --prefix functions install
   ```
3. **Deploy the server**
   ```bash
   npx firebase-tools login
   npx firebase-tools deploy --only firestore:rules,storage,functions
   ```
   The planner keeps no instance running by default (free when idle, ~1–2 s cold start). After launch, set `PLAN_MIN_INSTANCES=1` in `functions/.env` for instant plans.
4. **Build the app** (EAS, in `app/`)
   ```bash
   npx eas-cli@latest login
   npx eas-cli@latest init            # links the Expo project and adds the update URL
   npx eas-cli@latest build --profile development --platform android
   ```
   Install the build on your phone, then run `npm --prefix app start` and open it.
   For App Check in development builds, add a debug token in the Firebase console and set `EXPO_PUBLIC_APPCHECK_DEBUG_TOKEN`.

## Everyday commands

| Task | Command |
|---|---|
| Routing tests | `npm test` |
| Type-check everything | `npm run typecheck` |
| Rebuild the timetable | `npm run timetable` (or `npm run timetable -- path/to/bmrcl.zip`) |
| Local server with emulators | `npm --prefix functions run serve` and `EXPO_PUBLIC_USE_EMULATOR=1` for the app |
| Ship an over-the-air update | `cd app && npx eas-cli@latest update --channel production` |
| Store build | `cd app && npx eas-cli@latest build --profile production --platform android` |

## Firestore data

```
timetable/current          { version, path, feed, publishedAt }      public read
users/{uid}                { lang, women, pace }                      owner only
users/{uid}/trips/commute  { from, to, time, mode, priority }         owner only
reports/{uid_date_train}   { uid, service, origin, start, board, level, createdAt }   create only
interchangeReports/{id}    { uid, key, coach, minutes, createdAt }                     create only
crowdStats/{service}       { trains: { key: { p, n } } }             server only
interchanges/{key}         { coach, best, n }                         server only
config/tuning              seat weights and penalties                 server only
disruptions/{id}           { line, from, to, msg, starts, ends }     read when signed in
```

Riders are anonymous. No names, phone numbers or location history are stored. Analytics log screen names, station codes and choices only.
