/**
 * Live trip on the phone: "I'm on this train".
 *
 * Runs the trip recorder (GPS, towers, motion) and feeds its readings into the LiveTracker
 * (shared/src/live.ts), which works out where the train is, how late it is and what to do next.
 * Rings a notification one stop before a change and before the destination, ends by itself
 * after arrival, and shares the measured delay so other riders waiting for that train see it.
 */
import { secondsNow, serviceFor, ymd, LiveTracker, type LiveStatus, type PlanOption, type Timetable } from '@kmm/shared';
import { track } from './analytics';
import { shareTrainDelay } from './firebase';
import { notifyNow } from './notify';
import { onSample, startRecording, stopRecording, uploadPendingRecordings } from './recorder';

export interface LiveTrip { id: string; option: PlanOption; date: Date; tracker: LiveTracker; status: LiveStatus }

let live: LiveTrip | null = null;
let timetable: Timetable | null = null;
let unsub: (() => void) | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<(l: LiveTrip | null) => void>();
const alerted = new Set<string>();
let lastShared = 0;

const emit = () => listeners.forEach((fn) => fn(live ? { ...live } : null));
export const currentLive = () => live;
export function onLive(fn: (l: LiveTrip | null) => void) { listeners.add(fn); fn(live); return () => { listeners.delete(fn); }; }

/** Start following a trip. Asks for location if needed. */
export async function startLive(tt: Timetable, id: string, option: PlanOption, date: Date): Promise<'ok' | 'location' | 'unsupported'> {
  if (live?.id === id) return 'ok';
  stopLive('user');
  const service = serviceFor(tt, date);
  if (!service) return 'unsupported';
  const tracker = new LiveTracker(tt, service, option.legs);
  if (!tracker.ok) return 'unsupported';
  const rec = await startRecording(tt, {
    date: ymd(date), legs: option.legs.map((l) => ({ line: l.line, from: l.from, to: l.to, origin: l.origin, start: l.start })),
  });
  if (!rec.ok) return 'location';

  alerted.clear();
  timetable = tt;
  live = { id, option, date, tracker, status: tracker.status(secondsNow()) };
  unsub = onSample((s) => {
    if (!live) return;
    if (s.k === 'gps') live.tracker.fix(secondsNow(new Date(s.t)), s.lat, s.lon, s.acc ?? 999);
    else if (s.k === 'evt' && s.e === 'train_stopped') live.tracker.stopped(secondsNow(new Date(s.t)));
  });
  timer = setInterval(tick, 3000);
  tick();
  track('live_started', { rides: option.legs.length });
  return 'ok';
}

export function stopLive(reason: 'user' | 'arrived' = 'user') {
  if (!live) return;
  unsub?.(); unsub = null;
  if (timer) clearInterval(timer);
  timer = null;
  track('live_ended', { reason, delay: live.status.delay, source: live.status.source });
  live = null;
  stopRecording(reason);
  uploadPendingRecordings().catch(() => undefined);
  emit();
}

function tick() {
  if (!live) return;
  const now = secondsNow();
  const st = live.tracker.status(now);
  live.status = st;
  alerts(st);
  share(st, now);
  emit();
  // a minute after arriving, wrap up
  if (st.phase === 'arrived' && now - st.arrival > 60) stopLive('arrived');
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
  if (!live || st.phase !== 'riding' || st.source === 'timetable' || st.age == null || st.age > 90) return;
  if (Date.now() - lastShared < 60000) return;
  lastShared = Date.now();
  const leg = live.tracker.legs[st.leg];
  shareTrainDelay({ date: ymd(live.date), origin: leg.origin, start: leg.start, line: leg.line, delay: st.delay, at: now }).catch(() => undefined);
}
