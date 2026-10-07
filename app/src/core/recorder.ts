/**
 * Trip recorder (beta, for founding riders).
 *
 * While recording, the phone logs:
 *  - GPS fixes every ~2 s (position, accuracy, speed)
 *  - visible mobile towers every ~4 s (Android only)
 *  - motion once a second: level push (speeding up / braking), shake and turning (hand use), plus the
 *    app's guess of the train's state and speed (see motion.ts); the raw per-second numbers are kept too
 *  - air pressure once a second where the phone has a barometer (helps spot underground)
 *  - "doors opened" marks the rider taps at stations (ground truth where GPS is missing)
 * Safety nets for real-world use (people forget things):
 *  - saved to the phone every minute, so a killed app loses at most a minute; recovered on next launch
 *  - stops by itself after 10 min away from the metro line, 45 min without ever reaching it, or 2.5 h
 *  - finished trips upload by themselves when the app next opens
 * The trip is saved on the phone first, then uploaded. Later, a server job turns many trips into
 * a "tower -> stretch of line" map so positions can be estimated without GPS.
 */
import { File, Paths, Directory } from 'expo-file-system';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import * as Location from 'expo-location';
import { Accelerometer, Barometer, DeviceMotion } from 'expo-sensors';
import * as TaskManager from 'expo-task-manager';
import { Platform } from 'react-native';
import { translate, type Lang, type Timetable } from '@kmm/shared';
import { getCells, type Cell } from '../../modules/cell-info';
import { uploadRecording } from './firebase';
import { metresFromLine, MotionTracker, type TrainState } from './motion';
import { load } from './storage';

/*
 * Background capture. Android pauses an app's timers when it isn't on screen, so:
 *  - GPS runs as a location "foreground service" (a notification shows while recording). That keeps
 *    the app alive with the screen off, and needs only the normal "while using the app" permission.
 *  - the once-a-second work (motion summary, towers, saving, auto-stop) is driven by incoming
 *    readings (GPS batches and motion events), not only by a timer.
 */
const GPS_TASK = 'kmm-trip-gps';
let fixHandler: ((p: Location.LocationObject) => void) | null = null;
let heartbeat: (() => void) | null = null;
if (Platform.OS === 'android') {
  try {
    TaskManager.defineTask<{ locations?: Location.LocationObject[] }>(GPS_TASK, async ({ data, error }) => {
      if (error || !data?.locations) return;
      for (const loc of data.locations) fixHandler?.(loc);
      heartbeat?.();
    });
  } catch { /* task manager not available */ }
}

export type Sample =
  | { t: number; k: 'gps'; lat: number; lon: number; acc: number | null; spd: number | null; alt: number | null }
  | { t: number; k: 'cell'; c: Cell[] }
  | { t: number; k: 'mot'; m: number; sd: number }   // older recordings (shake only)
  | { t: number; k: 'dm'; a: number[]; g: number[]; h: number; v: number; j: number; r: number; s: TrainState; kmh: number | null }
  | { t: number; k: 'evt'; e: 'train_stopped' | 'train_started' | 'walk_start' | 'walk_end' | 'auto_stop'; why?: string }
  | { t: number; k: 'bar'; p: number }
  | { t: number; k: 'mark'; station: string | null };

export interface Recording {
  id: string;
  startedAt: number;
  endedAt: number | null;
  platform: string;
  samples: Sample[];
  stopReason?: 'user' | 'left_line' | 'never_on_line' | 'too_long' | 'recovered' | 'arrived';
  /** set when recorded as part of a live trip: the planned rides */
  trip?: { date: string; legs: { line: string; from: string; to: string; origin: string; start: number }[] };
}

export interface LiveStats {
  seconds: number;
  gpsFixes: number;
  lastAccuracy: number | null;
  towers: number;
  /** what the phone thinks the train is doing */
  train: TrainState | null;
  /** km/h: from GPS when it has a fix, otherwise estimated from motion */
  kmh: number | null;
  kmhFrom: 'gps' | 'motion' | null;
  marks: number;
  /** motion-detected station stops */
  stops: number;
  lastFix: { lat: number; lon: number } | null;
  /** metres from the nearest metro line at the last GPS fix */
  fromLine: number | null;
  /** latest per-second motion numbers, for the on-screen sensor details */
  motion: { h: number; v: number; j: number; r: number; along: number | null } | null;
  /** last 60 s: push along the track (or level push when direction is unknown) and state, for the graph */
  history: { x: number; signed: boolean; s: TrainState }[];
}

/** Auto-stop rules. */
const MAX_MS = 150 * 60 * 1000;
const OFF_LINE_MS = 10 * 60 * 1000;
const NEVER_ON_LINE_MS = 45 * 60 * 1000;
const NEAR_LINE_M = 400;

const KEEP_AWAKE_TAG = 'trip-recorder';
const dir = () => new Directory(Paths.document, 'recordings');

let current: Recording | null = null;
let stops: (() => void)[] = [];
const towerIds = new Set<string>();
const fresh = (): LiveStats => ({ seconds: 0, gpsFixes: 0, lastAccuracy: null, towers: 0, train: null, kmh: null, kmhFrom: null, marks: 0, stops: 0, lastFix: null, fromLine: null, motion: null, history: [] });
let stats: LiveStats = fresh();
let listener: ((s: LiveStats) => void) | null = null;
let stateListener: ((recording: boolean, reason?: Recording['stopReason']) => void) | null = null;
let lastGpsSpeedAt = 0;
let onLineAt = 0;       // last time a GPS fix was near the line
let seenLine = false;

const sampleListeners = new Set<(s: Sample) => void>();
const push = (s: Sample) => { if (!current) return; current.samples.push(s); sampleListeners.forEach((fn) => { try { fn(s); } catch { /* ignore */ } }); };
/** Every reading as it's recorded (used by the live trip). Returns an unsubscribe function. */
export const onSample = (fn: (s: Sample) => void) => { sampleListeners.add(fn); return () => { sampleListeners.delete(fn); }; };
const emit = () => listener?.({ ...stats });

export const isRecording = () => current !== null;
export const onStats = (fn: ((s: LiveStats) => void) | null) => { listener = fn; if (fn) emit(); };
/** Told when recording stops (by the rider or automatically). */
export const onRecordingState = (fn: typeof stateListener) => { stateListener = fn; };

export async function startRecording(tt: Timetable, trip?: Recording['trip']): Promise<{ ok: true } | { ok: false; reason: 'location' }> {
  if (current) { if (trip) current.trip = trip; return { ok: true }; }
  const perm = await Location.requestForegroundPermissionsAsync();
  if (perm.status !== 'granted') return { ok: false, reason: 'location' };

  current = { id: `${Date.now()}`, startedAt: Date.now(), endedAt: null, platform: `${Platform.OS} ${Platform.Version}`, samples: [], ...(trip ? { trip } : {}) };
  towerIds.clear();
  stats = fresh();
  seenLine = false; onLineAt = 0; lastGpsSpeedAt = 0;
  const lines = Object.values(tt.lines);
  await activateKeepAwakeAsync(KEEP_AWAKE_TAG).catch(() => undefined);

  // GPS
  const seenFix = new Set<number>();
  fixHandler = (p) => {
    // the same fix can come from both the on-screen watcher and the background task
    if (seenFix.has(p.timestamp)) return;
    seenFix.add(p.timestamp);
    if (seenFix.size > 500) seenFix.clear();
    push({ t: p.timestamp, k: 'gps', lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy ?? null, spd: p.coords.speed ?? null, alt: p.coords.altitude ?? null });
    stats.gpsFixes++; stats.lastAccuracy = p.coords.accuracy ?? null; stats.lastFix = { lat: p.coords.latitude, lon: p.coords.longitude };
    if (p.coords.speed != null && p.coords.speed >= 0 && (p.coords.accuracy ?? 999) < 50) {
      stats.kmh = Math.round(p.coords.speed * 3.6); stats.kmhFrom = 'gps'; lastGpsSpeedAt = Date.now();
    }
    if ((p.coords.accuracy ?? 999) < 150) {
      stats.fromLine = Math.round(metresFromLine(lines, tt.stations, p.coords.latitude, p.coords.longitude));
      if (stats.fromLine < NEAR_LINE_M) { seenLine = true; onLineAt = Date.now(); }
    }
    emit();
  };
  let background = false;
  if (Platform.OS === 'android') {
    try {
      const lang = load<Lang>('lang', 'en');
      await Location.startLocationUpdatesAsync(GPS_TASK, {
        accuracy: Location.Accuracy.BestForNavigation, timeInterval: 2000, distanceInterval: 0,
        foregroundService: { notificationTitle: translate(lang, 'fg_title'), notificationBody: translate(lang, 'fg_body'), notificationColor: '#7B2268', killServiceOnDestroy: true },
      });
      background = true;
      stops.push(() => { Location.stopLocationUpdatesAsync(GPS_TASK).catch(() => undefined); });
    } catch { /* fall back to on-screen only */ }
  }
  // Also watch on screen: the background task gets fixes in batches (about once a minute), so with the app open
  // this gives each fix as it comes. Without background capture this is the only source.
  {
    const gps = await Location.watchPositionAsync({ accuracy: Location.Accuracy.BestForNavigation, timeInterval: 2000, distanceInterval: 0 }, (p) => fixHandler?.(p));
    stops.push(() => gps.remove());
  }
  stops.push(() => { fixHandler = null; heartbeat = null; });
  // with background capture the screen may turn off as usual (saves battery)
  if (background) deactivateKeepAwake(KEEP_AWAKE_TAG);

  // Towers (Android)
  const pollCells = async () => {
    const cells = await getCells();
    if (!cells.length || !current) return;
    push({ t: Date.now(), k: 'cell', c: cells });
    for (const c of cells) if (c.ci != null) towerIds.add(`${c.mcc}-${c.mnc}-${c.tac}-${c.ci}`);
    stats.towers = towerIds.size;
  };
  pollCells();
  let lastCells = Date.now();

  // Motion: 10 readings a second, summarised once a second (see motion.ts)
  const tracker = new MotionTracker();
  let last: TrainState | null = null;
  let lastDwell = true, lastStopEvt = Date.now(); // you board standing still: that's not a new stop
  const useDeviceMotion = await DeviceMotion.isAvailableAsync().catch(() => false);
  if (useDeviceMotion) {
    DeviceMotion.setUpdateInterval(100);
    const dm = DeviceMotion.addListener((m) => {
      const inc = m.accelerationIncludingGravity, lin = m.acceleration;
      if (!inc || !lin) return;
      const rr = m.rotationRate;
      tracker.push({
        t: Date.now(), ax: lin.x, ay: lin.y, az: lin.z, gx: inc.x - lin.x, gy: inc.y - lin.y, gz: inc.z - lin.z,
        rot: rr ? Math.sqrt(rr.alpha * rr.alpha + rr.beta * rr.beta + rr.gamma * rr.gamma) : 0,
      });
      heartbeat?.();
    });
    stops.push(() => dm.remove());
  }
  // Older phones without a combined motion sensor: keep the simple shake measure
  let buf: number[] = [];
  if (!useDeviceMotion) {
    Accelerometer.setUpdateInterval(100);
    const acc = Accelerometer.addListener(({ x, y, z }) => { buf.push(Math.sqrt(x * x + y * y + z * z)); heartbeat?.(); });
    stops.push(() => acc.remove());
  }
  let lastBeat = Date.now(), lastSave = Date.now();
  let walking = false, lastWalk = 0;
  heartbeat = () => {
    const now = Date.now();
    if (now - lastBeat < 1000) return;
    lastBeat = now;
    if (now - lastCells >= 4000) { lastCells = now; pollCells(); }
    if (now - lastSave >= 60000 && current) { lastSave = now; savePending(current); }
    if (useDeviceMotion) {
      const sec = tracker.second(now);
      if (sec) {
        push({ t: now, k: 'dm', a: sec.a, g: sec.g, h: sec.h, v: sec.v, j: sec.j, r: sec.r, s: sec.state, kmh: sec.kmh });
        // a station stop: the train came to rest (at most one per 40 s)
        if (sec.dwell && !lastDwell && now - lastStopEvt > 40000) { push({ t: now, k: 'evt', e: 'train_stopped' }); stats.stops++; lastStopEvt = now; }
        lastDwell = sec.dwell;
        if (sec.state === 'starting' && last === 'stopped') push({ t: now, k: 'evt', e: 'train_started' });
        // walking: getting off, changing platforms (ends after 10 s without it)
        if (sec.walking) { if (!walking) { walking = true; push({ t: now - 10000, k: 'evt', e: 'walk_start' }); } lastWalk = now; }
        else if (walking && now - lastWalk > 10000) { walking = false; push({ t: lastWalk, k: 'evt', e: 'walk_end' }); }
        last = sec.state;
        stats.train = sec.state;
        stats.motion = { h: sec.h, v: sec.v, j: sec.j, r: sec.r, along: sec.along };
        stats.history = [...stats.history.slice(-59), { x: sec.along ?? sec.h, signed: sec.along != null, s: sec.state }];
        if (now - lastGpsSpeedAt > 10000) { stats.kmh = sec.kmh; stats.kmhFrom = sec.kmh == null ? null : 'motion'; }
      }
    } else if (buf.length) {
      const m = buf.reduce((a, b) => a + b, 0) / buf.length;
      const sd = Math.sqrt(buf.reduce((a, b) => a + (b - m) * (b - m), 0) / buf.length);
      buf = [];
      push({ t: now, k: 'mot', m: round(m, 4), sd: round(sd, 4) });
    }
    stats.seconds = Math.round((now - (current?.startedAt ?? now)) / 1000);
    emit();
    checkAutoStop(now);
  };
  // also on a timer, for when the phone lies perfectly still and nothing else arrives
  const beatTimer = setInterval(() => heartbeat?.(), 1000);
  stops.push(() => clearInterval(beatTimer));

  // Air pressure, if available
  if (await Barometer.isAvailableAsync().catch(() => false)) {
    let last = 0;
    Barometer.setUpdateInterval(1000);
    const bar = Barometer.addListener(({ pressure }) => {
      const now = Date.now();
      if (now - last < 900) return;
      last = now;
      push({ t: now, k: 'bar', p: round(pressure, 3) });
    });
    stops.push(() => bar.remove());
  }
  return { ok: true };
}

/** Rider taps "Doors opened" at a station. */
export function markStation(station: string | null) {
  push({ t: Date.now(), k: 'mark', station });
  stats.marks++;
  emit();
}

function checkAutoStop(now: number) {
  if (!current) return;
  const age = now - current.startedAt;
  let why: Recording['stopReason'] | null = null;
  if (age > MAX_MS) why = 'too_long';
  // Only judge "away from the line" on a recent, good GPS fix (underground there are no fixes at all).
  else if (seenLine && stats.fromLine != null && stats.fromLine > NEAR_LINE_M && now - onLineAt > OFF_LINE_MS) why = 'left_line';
  else if (!seenLine && age > NEVER_ON_LINE_MS) why = 'never_on_line';
  if (!why) return;
  push({ t: now, k: 'evt', e: 'auto_stop', why });
  const rec = stopRecording(why);
  if (rec) uploadPendingRecordings();
}

/** Stops recording and saves the trip on the phone. Returns it for upload. */
export function stopRecording(reason: Recording['stopReason'] = 'user'): Recording | null {
  if (!current) return null;
  stops.forEach((s) => { try { s(); } catch { /* ignore */ } });
  stops = [];
  deactivateKeepAwake(KEEP_AWAKE_TAG);
  const rec = { ...current, endedAt: Date.now(), stopReason: reason };
  current = null;
  savePending(rec);
  stateListener?.(false, reason);
  return rec;
}

/* ---------------- on-phone queue (uploads can wait for signal) ---------------- */
function savePending(rec: Recording) {
  try {
    const d = dir();
    if (!d.exists) d.create();
    new File(d, `${rec.id}.json`).write(JSON.stringify(rec));
  } catch { /* storage full: upload straight away still works */ }
}

/** Finished trips waiting to upload. A trip left unfinished by a killed app is closed at its last reading. */
export function pendingRecordings(): Recording[] {
  try {
    const d = dir();
    if (!d.exists) return [];
    return d.list().filter((f): f is File => f instanceof File && f.name.endsWith('.json'))
      .map((f) => JSON.parse(f.textSync()) as Recording)
      .filter((r) => r.id !== current?.id)
      .map((r) => r.endedAt ? r : { ...r, endedAt: r.samples.at(-1)?.t ?? r.startedAt, stopReason: 'recovered' as const });
  } catch { return []; }
}

let uploading: Promise<{ done: number; failed: number }> | null = null;
/** Uploads every finished trip; ones that fail stay on the phone for next time. */
export function uploadPendingRecordings(): Promise<{ done: number; failed: number }> {
  uploading ??= (async () => {
    let done = 0, failed = 0;
    for (const rec of pendingRecordings()) {
      if (await uploadRecording(rec)) { forgetRecording(rec.id); done++; } else failed++;
    }
    return { done, failed };
  })().finally(() => { uploading = null; });
  return uploading;
}

export function forgetRecording(id: string) {
  try { const f = new File(dir(), `${id}.json`); if (f.exists) f.delete(); } catch { /* ignore */ }
}

const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;
