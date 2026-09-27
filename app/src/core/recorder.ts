/**
 * Trip recorder (beta, for founding riders).
 *
 * While recording, the phone logs:
 *  - GPS fixes every ~2 s (position, accuracy, speed)
 *  - visible mobile towers every ~4 s (Android only)
 *  - motion once a second (average and variation of acceleration: tells moving vs stopped)
 *  - air pressure once a second where the phone has a barometer (helps spot underground)
 *  - "doors opened" marks the rider taps at stations (ground truth where GPS is missing)
 * The trip is saved on the phone first, then uploaded. Later, a server job turns many trips into
 * a "tower -> stretch of line" map so positions can be estimated without GPS.
 */
import { File, Paths, Directory } from 'expo-file-system';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import * as Location from 'expo-location';
import { Accelerometer, Barometer } from 'expo-sensors';
import { Platform } from 'react-native';
import { getCells, type Cell } from '../../modules/cell-info';

export type Sample =
  | { t: number; k: 'gps'; lat: number; lon: number; acc: number | null; spd: number | null; alt: number | null }
  | { t: number; k: 'cell'; c: Cell[] }
  | { t: number; k: 'mot'; m: number; sd: number }
  | { t: number; k: 'bar'; p: number }
  | { t: number; k: 'mark'; station: string | null };

export interface Recording {
  id: string;
  startedAt: number;
  endedAt: number | null;
  platform: string;
  samples: Sample[];
}

export interface LiveStats {
  seconds: number;
  gpsFixes: number;
  lastAccuracy: number | null;
  towers: number;
  moving: boolean | null;
  marks: number;
  lastFix: { lat: number; lon: number } | null;
}

const KEEP_AWAKE_TAG = 'trip-recorder';
const dir = () => new Directory(Paths.document, 'recordings');

let current: Recording | null = null;
let stops: (() => void)[] = [];
const towerIds = new Set<string>();
let stats: LiveStats = { seconds: 0, gpsFixes: 0, lastAccuracy: null, towers: 0, moving: null, marks: 0, lastFix: null };
let listener: ((s: LiveStats) => void) | null = null;

const push = (s: Sample) => { current?.samples.push(s); };
const emit = () => listener?.({ ...stats });

export const isRecording = () => current !== null;
export const onStats = (fn: ((s: LiveStats) => void) | null) => { listener = fn; if (fn) emit(); };

export async function startRecording(): Promise<{ ok: true } | { ok: false; reason: 'location' }> {
  if (current) return { ok: true };
  const perm = await Location.requestForegroundPermissionsAsync();
  if (perm.status !== 'granted') return { ok: false, reason: 'location' };

  current = { id: `${Date.now()}`, startedAt: Date.now(), endedAt: null, platform: `${Platform.OS} ${Platform.Version}`, samples: [] };
  towerIds.clear();
  stats = { seconds: 0, gpsFixes: 0, lastAccuracy: null, towers: 0, moving: null, marks: 0, lastFix: null };
  await activateKeepAwakeAsync(KEEP_AWAKE_TAG).catch(() => undefined);

  // GPS
  const gps = await Location.watchPositionAsync(
    { accuracy: Location.Accuracy.BestForNavigation, timeInterval: 2000, distanceInterval: 0 },
    (p) => {
      push({ t: p.timestamp, k: 'gps', lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy ?? null, spd: p.coords.speed ?? null, alt: p.coords.altitude ?? null });
      stats.gpsFixes++; stats.lastAccuracy = p.coords.accuracy ?? null; stats.lastFix = { lat: p.coords.latitude, lon: p.coords.longitude };
      emit();
    },
  );
  stops.push(() => gps.remove());

  // Towers (Android)
  const pollCells = async () => {
    const cells = await getCells();
    if (!cells.length || !current) return;
    push({ t: Date.now(), k: 'cell', c: cells });
    for (const c of cells) if (c.ci != null) towerIds.add(`${c.mcc}-${c.mnc}-${c.tac}-${c.ci}`);
    stats.towers = towerIds.size;
  };
  pollCells();
  const cellTimer = setInterval(pollCells, 4000);
  stops.push(() => clearInterval(cellTimer));

  // Motion: sample at 10 Hz, keep one summary per second
  let buf: number[] = [];
  Accelerometer.setUpdateInterval(100);
  const acc = Accelerometer.addListener(({ x, y, z }) => { buf.push(Math.sqrt(x * x + y * y + z * z)); });
  const motTimer = setInterval(() => {
    if (!buf.length) return;
    const m = buf.reduce((a, b) => a + b, 0) / buf.length;
    const sd = Math.sqrt(buf.reduce((a, b) => a + (b - m) * (b - m), 0) / buf.length);
    buf = [];
    push({ t: Date.now(), k: 'mot', m: round(m, 4), sd: round(sd, 4) });
    stats.moving = sd > 0.02;
    stats.seconds = Math.round((Date.now() - (current?.startedAt ?? Date.now())) / 1000);
    emit();
  }, 1000);
  stops.push(() => { acc.remove(); clearInterval(motTimer); });

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

/** Stops recording and saves the trip on the phone. Returns it for upload. */
export function stopRecording(): Recording | null {
  if (!current) return null;
  stops.forEach((s) => { try { s(); } catch { /* ignore */ } });
  stops = [];
  deactivateKeepAwake(KEEP_AWAKE_TAG);
  const rec = { ...current, endedAt: Date.now() };
  current = null;
  savePending(rec);
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

export function pendingRecordings(): Recording[] {
  try {
    const d = dir();
    if (!d.exists) return [];
    return d.list().filter((f): f is File => f instanceof File && f.name.endsWith('.json'))
      .map((f) => JSON.parse(f.textSync()) as Recording);
  } catch { return []; }
}

export function forgetRecording(id: string) {
  try { const f = new File(dir(), `${id}.json`); if (f.exists) f.delete(); } catch { /* ignore */ }
}

const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;
