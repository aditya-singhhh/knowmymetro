/**
 * Share a live trip with anyone, even without the app: a private link to a web page
 * (https://knowmymetro.web.app/t/<token>) that shows where you are and when you'll arrive.
 * While sharing, the app writes a small snapshot to shares/<token> every ~30 s; it ends with the ride.
 */
import { stationName, type Timetable } from '@kmm/shared';
import { shareSnapshot } from './firebase';
import type { LiveTrip } from './live';

export const SHARE_BASE = 'https://knowmymetro.web.app/t/';
let token: string | null = null;
let lastSent = 0;

function newToken(): string {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = new Uint8Array(24);
  try { (globalThis.crypto as Crypto).getRandomValues(bytes); } catch { for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256); }
  return Array.from(bytes, (b) => abc[b % abc.length]).join('');
}

export const isSharing = () => token !== null;

function snapshot(tt: Timetable, l: LiveTrip, ended: boolean) {
  const st = l.status;
  const nm = (c: string | null | undefined) => (c ? stationName(tt, c, 'en') : null);
  return {
    v: 1,
    ended,
    trip: {
      legs: l.tracker.legs.map((g, i) => ({
        line: g.line, from: nm(g.from), to: nm(g.to), towards: nm(g.terminus),
        platform: l.option.legs[i]?.platform ?? null,
        stops: g.stops.map((s) => ({ n: nm(s.stn), t: s.arr })),
      })),
      to: nm(l.option.legs[l.option.legs.length - 1].to),
    },
    now: {
      leg: st.leg, phase: st.phase, prev: nm(st.prev), next: nm(st.next), frac: Math.round(st.frac * 100) / 100,
      delay: st.delay, arrival: st.arrival, source: st.source,
      missed: st.missed ? { at: nm(st.missed.at), next: st.missed.next } : null,
    },
  };
}

/** Starts sharing (or returns the existing link). */
export async function startShare(tt: Timetable, l: LiveTrip): Promise<string | null> {
  if (!token) {
    token = newToken();
    const ok = await shareSnapshot(token, snapshot(tt, l, false));
    if (!ok) { token = null; return null; }
    lastSent = Date.now();
  }
  return SHARE_BASE + token;
}

/** Called on every live update; sends at most every 30 s. */
export function updateShare(tt: Timetable, l: LiveTrip) {
  if (!token || Date.now() - lastSent < 30000) return;
  lastSent = Date.now();
  shareSnapshot(token, snapshot(tt, l, false)).catch(() => undefined);
}

export function endShare(tt: Timetable | null, l: LiveTrip | null) {
  if (!token) return;
  if (tt && l) shareSnapshot(token, snapshot(tt, l, true)).catch(() => undefined);
  token = null;
}
