/**
 * Following a train live.
 *
 *   watch  opening any train shows where it is: timetable + the delay other riders on it shared.
 *          No GPS, nothing recorded. Ends when the screen closes.
 *   ride   "I'm on this train": also runs the trip recorder (GPS, towers, motion) and feeds it to the
 *          LiveTracker (shared/src/live.ts). Alerts a stop before a change and before the destination,
 *          shares the measured delay with other riders, ends by itself after arrival.
 */
import { secondsNow, serviceFor, ymd, LiveTracker, type LiveStatus, type PlanOption, type Timetable } from '@kmm/shared';
import { track } from './analytics';
import { getTrainDelay, shareTrainDelay, submitInterchange } from './firebase';
import { notifyNow } from './notify';
import { endShare, updateShare } from './share-live';
import { markStation, onSample, startRecording, stopRecording, uploadPendingRecordings } from './recorder';

export type LiveMode = 'watch' | 'ride';
export interface LiveTrip { id: string; mode: LiveMode; option: PlanOption; date: Date; tracker: LiveTracker; status: LiveStatus }

let live: LiveTrip | null = null;
let timetable: Timetable | null = null;
let unsub: (() => void) | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<(l: LiveTrip | null) => void>();
const alerted = new Set<string>();
let lastShared = 0;
let lastAsked = 0;

const emit = () => listeners.forEach((fn) => fn(live ? { ...live } : null));
export const currentLive = () => live;
export function onLive(fn: (l: LiveTrip | null) => void) { listeners.add(fn); fn(live); return () => { listeners.delete(fn); }; }

function tracker(tt: Timetable, option: PlanOption, date: Date): LiveTracker | null {
  const service = serviceFor(tt, date);
  if (!service) return null;
  const t = new LiveTracker(tt, service, option.legs);
  return t.ok ? t : null;
}

function begin(tt: Timetable, l: Omit<LiveTrip, 'status'>) {
  timetable = tt;
  live = { ...l, status: l.tracker.status(secondsNow()) };
  lastAsked = 0;
  if (timer) clearInterval(timer);
  timer = setInterval(tick, 3000);
  tick();
}

/** Show where this train is (no GPS). Does nothing if this trip is already followed. */
export function watchTrain(tt: Timetable, id: string, option: PlanOption, date: Date): boolean {
  if (live?.id === id) return true;
  if (live?.mode === 'ride') return false;          // never interrupt a ride
  const tr = tracker(tt, option, date);
  if (!tr) return false;
  end();
  begin(tt, { id, mode: 'watch', option, date, tracker: tr });
  return true;
}

/** Stop watching (when the train's screen closes); rides keep going. */
export function unwatch(id: string) {
  if (live?.id === id && live.mode === 'watch') { end(); emit(); }
}

/** "I'm on this train": follow with GPS and motion. Asks for location if needed. */
export async function rideTrain(tt: Timetable, id: string, option: PlanOption, date: Date): Promise<'ok' | 'location' | 'unsupported'> {
  if (live?.id === id && live.mode === 'ride') return 'ok';
  const tr = live?.id === id ? live.tracker : tracker(tt, option, date);   // keep what watching already learned
  if (!tr) return 'unsupported';
  const rec = await startRecording(tt, {
    date: ymd(date), legs: option.legs.map((l) => ({ line: l.line, from: l.from, to: l.to, origin: l.origin, start: l.start })),
  });
  if (!rec.ok) return 'location';
  tr.riding = true;
  if (live && live.id !== id) stopLive('user');
  alerted.clear();
  unsub?.();
  unsub = onSample((s) => {
    if (!live || live.mode !== 'ride') return;
    if (s.k === 'gps') live.tracker.fix(secondsNow(new Date(s.t)), s.lat, s.lon, s.acc ?? 999);
    else if (s.k === 'evt' && s.e === 'train_stopped') live.tracker.stopped(secondsNow(new Date(s.t)));
    else if (s.k === 'evt' && s.e === 'train_started') live.tracker.started(secondsNow(new Date(s.t)));
    else if (s.k === 'evt' && (s.e === 'walk_start' || s.e === 'walk_end')) { live.tracker.walking(secondsNow(new Date(s.t)), s.e === 'walk_start'); learnChange(); }
    // timers pause when the app is in the background; readings keep coming, so update from them too
    if (Date.now() - lastTick >= 3000) tick();
  });
  begin(tt, { id, mode: 'ride', option, date, tracker: tr });
  track('live_started', { rides: option.legs.length });
  return 'ok';
}

function end() {
  unsub?.(); unsub = null;
  if (timer) clearInterval(timer);
  timer = null;
  live = null;
}

/** End following. A ride also stops recording and uploads it. */
export function stopLive(reason: 'user' | 'arrived' = 'user') {
  if (!live) return;
  const wasRide = live.mode === 'ride';
  if (wasRide) endShare(timetable, live);
  if (wasRide) track('live_ended', { reason, delay: live.status.delay, source: live.status.source });
  end();
  if (wasRide) { stopRecording(reason); uploadPendingRecordings().catch(() => undefined); }
  emit();
}

let lastTick = 0;
function tick() {
  if (!live) return;
  lastTick = Date.now();
  const now = secondsNow();
  askRiders(now);
  const st = live.tracker.status(now);
  live.status = st;
  if (live.mode === 'ride') { alerts(st); share(st, now); if (timetable) updateShare(timetable, live); }
  emit();
  if (st.phase === 'arrived' && now - st.arrival > 60) {
    if (live.mode === 'ride') stopLive('arrived'); else { end(); emit(); }
  }
}

/** A change we timed by walking (off the train -> standing on the next platform): teaches the planner real change times. */
let sentChange: string | null = null;
function learnChange() {
  const c = live?.tracker.change;
  if (!c || !live) return;
  const id = `${live.id}|${c.station}|${c.seconds}`;
  if (sentChange === id) return;
  sentChange = id;
  const prev = live.option.legs.find((l) => l.to === c.station && l.line === c.fromLine);
  if (!prev) return;
  const minutes = Math.round((c.seconds / 60) * 10) / 10;
  submitInterchange(`${c.station}|${c.fromLine}${prev.dir}>${c.toLine}`, null, minutes).catch(() => undefined);
  track('change_timed', { station: c.station, minutes });
}

/** Every 30 s: did a rider on this train share how late it is? */
function askRiders(now: number) {
  if (!live || Date.now() - lastAsked < 30000) return;
  lastAsked = Date.now();
  const l = live, leg = l.tracker.legs[Math.min(l.status?.leg ?? 0, l.tracker.legs.length - 1)];
  getTrainDelay(ymd(l.date), leg.origin, leg.start).then((d) => {
    if (d && live === l) { l.tracker.external(d.delay, Math.max(0, now - d.at), now); }
  }).catch(() => undefined);
}

/** One heads-up per step: a stop before the change, and a stop before getting off. */
function alerts(st: LiveStatus) {
  const a = st.action;
  if (!a || a.kind === 'board' || a.stopsAway !== 1) return;
  const key = `${st.leg}:${a.kind}`;
  if (alerted.has(key)) return;
  alerted.add(key);
  if (timetable && live) notifyNow(timetable, a.kind, a.at, live.option);
}

/** Every ~60 s while we really know where the train is, tell other riders how late it is. */
function share(st: LiveStatus, now: number) {
  if (!live || st.phase !== 'riding' || (st.source !== 'gps' && st.source !== 'motion') || st.age == null || st.age > 90) return;
  if (Date.now() - lastShared < 60000) return;
  lastShared = Date.now();
  const leg = live.tracker.legs[st.leg];
  shareTrainDelay({ date: ymd(live.date), origin: leg.origin, start: leg.start, line: leg.line, delay: st.delay, at: now }).catch(() => undefined);
}

/** Rider tapped "Doors opened" (underground, no GPS): a sure station stop for the tracker and the recording. */
export function doorsOpened() {
  if (!live || live.mode !== 'ride') return;
  const now = secondsNow();
  live.tracker.stopped(now, true);
  markStation(live.status.next ?? live.status.prev ?? null);
  tick();
}
