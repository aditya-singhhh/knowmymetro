/**
 * Live trip: where is my train right now, how late is it, when do I get there.
 *
 * Inputs, all optional and in any order:
 *   - GPS fixes        -> snapped onto the trip's line -> "4.2 km past Yeshwantpur" -> compared with the
 *                         timetable for that spot -> delay
 *   - motion stops     -> underground / no GPS: the train just stopped, so we are at the station the
 *                         timetable (plus current delay) says is closest -> delay
 *   - nothing          -> timetable plus the last known delay
 * If the fixes fit another train of the same line much better (rider boarded the next one), we switch.
 *
 * Pure logic, no phone APIs: the app feeds it readings and draws what `status()` returns.
 */
import type { Leg, LineId, Timetable } from './types';

export interface LiveStop { stn: string; km: number; arr: number; dep: number }
export interface LiveLegPlan { line: LineId; dir: number; from: string; to: string; origin: string; start: number; terminus: string; stops: LiveStop[]; pattern: number; held: number }

export type LivePhase = 'before' | 'riding' | 'changing' | 'arrived';
export interface LiveStatus {
  phase: LivePhase;
  leg: number;
  /** delay in seconds (+ late, - early), and where it came from */
  delay: number;
  source: 'gps' | 'motion' | 'timetable';
  /** seconds since the last real reading (gps or motion) */
  age: number | null;
  /** riding: last station passed and next one, with how far between them (0..1) */
  prev: string | null;
  next: string | null;
  frac: number;
  /** expected times at the remaining stops of the current leg */
  etas: { stn: string; at: number }[];
  /** expected arrival at the destination */
  arrival: number;
  /** what to do next */
  action: { kind: 'board' | 'change' | 'getoff'; at: string; stopsAway: number; inSec: number } | null;
  /** the train we are on now differs from the plan */
  switched: boolean;
  /** the connection after this ride will be missed: the next train that way leaves at `next` */
  missed: { at: string; planned: number; next: number | null } | null;
  /** last GPS fix was far from the line */
  offLine: boolean;
}

const R = 6371000;
const toXY = (lat0: number, lat: number, lon: number) => ({ x: (lon * Math.PI / 180) * R * Math.cos(lat0 * Math.PI / 180), y: (lat * Math.PI / 180) * R });

/** Timetable of one ride: every stop from boarding to getting off, with distance along the line. */
export function legPlan(tt: Timetable, service: string, leg: Leg): LiveLegPlan | null {
  const deps = tt.departures[service] ?? [];
  const held = leg.held ?? 0;
  const start = leg.start - held;
  for (let pi = 0; pi < tt.patterns.length; pi++) {
    const p = tt.patterns[pi];
    if (p.line !== leg.line || p.stops[0] !== leg.origin || p.stops[p.stops.length - 1] !== leg.terminus) continue;
    if (p.stops[leg.before] !== leg.from) continue;
    if (!deps.some(([i, t0]) => i === pi && t0 === start)) continue;
    const j = p.stops.indexOf(leg.to, leg.before + 1);
    if (j < 0) continue;
    return { line: leg.line, dir: leg.dir, from: leg.from, to: leg.to, origin: leg.origin, start, terminus: leg.terminus, pattern: pi, held,
      stops: stopsOf(tt, pi, start, leg.before, j, held) };
  }
  return null;
}

function stopsOf(tt: Timetable, pi: number, t0: number, a: number, b: number, held = 0): LiveStop[] {
  const p = tt.patterns[pi];
  const out: LiveStop[] = [];
  let km = 0;
  for (let k = a; k <= b; k++) {
    if (k > a) {
      const A = tt.stations[p.stops[k - 1]], B = tt.stations[p.stops[k]];
      const pa = toXY(A.lat, A.lat, A.lon), pb = toXY(A.lat, B.lat, B.lon);
      km += Math.hypot(pb.x - pa.x, pb.y - pa.y) / 1000;
    }
    out.push({ stn: p.stops[k], km, arr: t0 + held + p.arr[k], dep: t0 + held + p.dep[k] });
  }
  return out;
}

/** Snap a position onto a ride's stations: distance along (km) and distance off the line (m). */
export function snap(tt: Timetable, stops: LiveStop[], lat: number, lon: number): { km: number; off: number } {
  let best = { km: 0, off: Infinity };
  for (let k = 0; k + 1 < stops.length; k++) {
    const A = tt.stations[stops[k].stn], B = tt.stations[stops[k + 1].stn];
    const a = toXY(lat, A.lat, A.lon), b = toXY(lat, B.lat, B.lon), p = toXY(lat, lat, lon);
    const dx = b.x - a.x, dy = b.y - a.y, L = dx * dx + dy * dy;
    const u = L ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L)) : 0;
    const off = Math.hypot(a.x + u * dx - p.x, a.y + u * dy - p.y);
    if (off < best.off) best = { km: stops[k].km + u * (stops[k + 1].km - stops[k].km), off };
  }
  return best;
}

/** When the timetable has the train at this distance along the ride (moving), or null if it's at a station. */
function schedTimeAt(stops: LiveStop[], km: number): { t: number } | { station: number } {
  for (let k = 0; k < stops.length; k++) if (Math.abs(stops[k].km - km) < 0.15) return { station: k };
  for (let k = 0; k + 1 < stops.length; k++) {
    if (km >= stops[k].km && km <= stops[k + 1].km) {
      const f = (km - stops[k].km) / Math.max(0.001, stops[k + 1].km - stops[k].km);
      return { t: stops[k].dep + f * (stops[k + 1].arr - stops[k].dep) };
    }
  }
  return { t: km <= 0 ? stops[0].dep : stops[stops.length - 1].arr };
}

/** Observed delay from a reading at `km` along the ride at time `t` (null when it can't tell, e.g. dwelling). */
export function delayAt(stops: LiveStop[], km: number, t: number): number | null {
  const s = schedTimeAt(stops, km);
  if ('t' in s) return t - s.t;
  const st = stops[s.station];
  if (t < st.arr) return t - st.arr;      // already here, early
  if (t > st.dep) return t - st.dep;      // still here after departure time: at least this late
  return null;                            // standing here as planned
}

const OFF_LINE_M = 400;
const SWITCH_DELAY = 4 * 60;              // this far off the plan: check if it's another train

export class LiveTracker {
  readonly legs: LiveLegPlan[];
  private delay = 0;
  private source: LiveStatus['source'] = 'timetable';
  private lastReading: number | null = null;
  private onLeg = 0;
  /** highest ride we know we're on (from a reading); -1 = not boarded yet */
  private boardedLeg = -1;
  private switched = false;
  /** index (in the current ride) of the last station we know the train reached */
  private lastStation = 0;
  private offLine = false;

  constructor(private tt: Timetable, private service: string, legs: Leg[], private changeNeed = 180) {
    this.legs = legs.map((l) => legPlan(tt, service, l)).filter((x): x is LiveLegPlan => !!x);
  }

  get ok() { return this.legs.length > 0; }

  /** A GPS fix. */
  fix(t: number, lat: number, lon: number, accuracy: number) {
    if (!this.ok || accuracy > 150) return;
    // which ride does this fix belong to: the current one, or the next (after a change)
    for (const li of [this.onLeg, this.onLeg + 1]) {
      const L = this.legs[li];
      if (!L) continue;
      const { km, off } = snap(this.tt, L.stops, lat, lon);
      if (off > OFF_LINE_M) continue;
      this.offLine = false;
      if (li !== this.onLeg) {
        // only move to the next ride once we've left its first station (we are on the new train)
        if (km < 0.3) continue;
        this.onLeg = li;
        this.lastStation = 0;
      }
      const end = L.stops[L.stops.length - 1].km;
      if (km > 0.3) this.boardedLeg = Math.max(this.boardedLeg, li);
      let passed = 0;
      L.stops.forEach((st, k) => { if (km >= st.km - 0.15) passed = k; });
      this.lastStation = passed;
      let d = delayAt(L.stops, km, t);
      if (d == null) { this.lastReading = t; return; }
      if (Math.abs(d) > SWITCH_DELAY && km > 0.3 && km < end - 0.3) {
        const better = this.otherTrain(li, km, t);
        if (better) { d = better.delay; }
      }
      this.update(d, 'gps', t);
      return;
    }
    this.offLine = true;
  }

  /** The motion sensor saw the train stop (underground, or GPS too weak). */
  stopped(t: number) {
    if (!this.ok) return;
    const L = this.legs[this.onLeg];
    // Trains stop at every station in order: this stop is the next station, or the one after if a stop went unnoticed.
    // still standing at the station we last reached (boarding, or a long stop): nothing new
    if (t < L.stops[this.lastStation].dep + this.delay + 30) return;
    // prefer the very next station; take the one after only if the next clearly doesn't fit
    let best: { k: number; gap: number } | null = null;
    for (const k of [this.lastStation + 1, this.lastStation + 2]) {
      if (k >= L.stops.length) break;
      const gap = Math.abs(t - (L.stops[k].arr + this.delay));
      if (gap <= 150) { best = { k, gap }; break; }
    }
    if (!best) return; // doesn't line up with any station: ignore
    this.lastStation = best.k;
    this.boardedLeg = Math.max(this.boardedLeg, this.onLeg);
    this.update(t - L.stops[best.k].arr, 'motion', t);
  }

  private update(d: number, src: LiveStatus['source'], t: number) {
    // trust new readings quickly, but don't jump on one odd fix
    this.delay = this.source === 'timetable' && this.lastReading == null ? d : 0.4 * this.delay + 0.6 * d;
    this.source = src;
    this.lastReading = t;
  }

  /** Another train of the same line and direction that fits this reading much better. */
  private otherTrain(li: number, km: number, t: number): { delay: number } | null {
    const L = this.legs[li];
    const p = this.tt.patterns[L.pattern];
    const a = p.stops.indexOf(L.from), b = p.stops.indexOf(L.to, a + 1);
    let best: { t0: number; pattern: number; delay: number; a: number; b: number } | null = null;
    for (const [pi, t0] of this.tt.departures[this.service] ?? []) {
      const q = this.tt.patterns[pi];
      if (q.line !== L.line) continue;
      const qa = q.stops.indexOf(L.from), qb = q.stops.indexOf(L.to, qa + 1);
      if (qa < 0 || qb < 0) continue;
      const stops = stopsOf(this.tt, pi, t0, qa, qb);
      const d = delayAt(stops, km, t);
      if (d == null || Math.abs(d) > 150) continue;
      if (!best || Math.abs(d) < Math.abs(best.delay)) best = { t0, pattern: pi, delay: d, a: qa, b: qb };
    }
    if (!best) return null;
    const q = this.tt.patterns[best.pattern];
    this.legs[li] = { ...L, pattern: best.pattern, start: best.t0, origin: q.stops[0], terminus: q.stops[q.stops.length - 1], held: 0,
      stops: stopsOf(this.tt, best.pattern, best.t0, best.a, best.b) };
    this.switched = true;
    this.delay = best.delay;
    return { delay: best.delay };
  }

  status(t: number): LiveStatus {
    const legs = this.legs;
    // No reading says otherwise: once this ride is over by the clock, we're at the change for the next one.
    // If the connection is missed, expect the next train that way instead (shown as an offset from the plan).
    const cur = legs[this.onLeg];
    if (this.onLeg + 1 < legs.length && t > cur.stops[cur.stops.length - 1].arr + this.delay + 30) {
      const arrived = cur.stops[cur.stops.length - 1].arr + this.delay;
      const N = legs[this.onLeg + 1];
      const planned = N.stops[0].dep;
      const next = arrived + this.changeNeed > planned ? this.nextDeparture(N, arrived + this.changeNeed) : planned;
      this.onLeg++;
      this.lastStation = 0;
      this.delay = next != null ? next - planned : 0;
      this.source = 'timetable';
    }
    const li = this.onLeg, L = legs[li];
    const dd = this.delay;
    const first = L.stops[0], last = L.stops[L.stops.length - 1];
    const arrHere = last.arr + dd;
    const finalLeg = legs[legs.length - 1];

    // missed connection: this ride gets in too late for the next one
    let missed: LiveStatus['missed'] = null;
    let nextLegDelay = 0;
    const N = legs[li + 1];
    if (N && arrHere + this.changeNeed > N.stops[0].dep + N.held) {
      const nextDep = this.nextDeparture(N, arrHere + this.changeNeed);
      missed = { at: N.from, planned: N.stops[0].dep, next: nextDep };
      nextLegDelay = nextDep != null ? nextDep - N.stops[0].dep : 0;
    }
    const arrival = li === legs.length - 1 ? arrHere : finalLeg.stops[finalLeg.stops.length - 1].arr + (legs.length - 1 === li + 1 ? nextLegDelay : 0);

    const base = { leg: li, delay: Math.round(dd), source: this.source, age: this.lastReading == null ? null : Math.round(t - this.lastReading), switched: this.switched, missed, arrival, offLine: this.offLine };

    if (li === legs.length - 1 && t >= arrHere) {
      return { ...base, phase: 'arrived', prev: last.stn, next: null, frac: 1, etas: [], action: null };
    }
    if (t < first.dep + dd && this.boardedLeg < li) {
      return { ...base, phase: li === 0 ? 'before' : 'changing', prev: null, next: first.stn, frac: 0, etas: L.stops.map((s) => ({ stn: s.stn, at: s.arr + dd })),
        action: { kind: li === 0 ? 'board' : 'change', at: first.stn, stopsAway: 0, inSec: Math.round(first.dep + dd - t) } };
    }
    // riding: find the stretch we're on by expected times
    let k = 0;
    while (k + 1 < L.stops.length && t >= L.stops[k + 1].arr + dd) k++;
    const atStation = t <= L.stops[k].dep + dd;
    const nextK = Math.min(k + 1, L.stops.length - 1);
    const span = L.stops[nextK].arr - L.stops[k].dep;
    const frac = atStation ? 0 : Math.max(0, Math.min(1, (t - (L.stops[k].dep + dd)) / Math.max(1, span)));
    const etas = L.stops.slice(k + 1).map((s) => ({ stn: s.stn, at: s.arr + dd }));
    const stopsAway = L.stops.length - 1 - k;
    const action = { kind: (li === legs.length - 1 ? 'getoff' : 'change') as 'getoff' | 'change', at: last.stn, stopsAway, inSec: Math.round(arrHere - t) };
    return { ...base, phase: 'riding', prev: L.stops[k].stn, next: atStation ? L.stops[k].stn : L.stops[nextK].stn, frac, etas, action };
  }

  /** Next train of a ride's line and direction leaving its first station at or after `after`. */
  private nextDeparture(N: LiveLegPlan, after: number): number | null {
    let best: number | null = null;
    for (const [pi, t0] of this.tt.departures[this.service] ?? []) {
      const q = this.tt.patterns[pi];
      if (q.line !== N.line) continue;
      const a = q.stops.indexOf(N.from), b = q.stops.indexOf(N.to, a + 1);
      if (a < 0 || b < 0) continue;
      const dep = t0 + q.dep[a];
      if (dep >= after && (best == null || dep < best)) best = dep;
    }
    return best;
  }
}
