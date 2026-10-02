/**
 * KnowMyMetro journey planner (server only).
 *
 * Multi-criteria search over the timetable in rounds (one ride per round), keeping only
 * trips that no other trip beats on all of: arrival (or departure, for "arrive by"),
 * expected minutes standing, and number of rides.
 *
 * Riders may get off at: the destination, an interchange (to change line), or a station
 * where trains of that line start, but only to board a train that starts there, and only
 * if they were not already likely seated. Short rides the wrong way to reach such a station
 * are allowed (max 20 min). The winner is picked by a weighted cost that depends on the
 * rider's priority, so "fastest" still takes a seat when it costs nothing.
 */
import {
  cardFare, fmt, isPeak, lineDir, lineOrigins, mins, parseTime, seatClass, serviceFor, tokenFare,
  type Change, type Leg, type LineId, type Pace, type PlanOption, type PlanRequest, type PlanResponse,
  type Priority, type SeatClass, type ServiceId, type Timetable,
} from '@kmm/shared';

export interface Tuning {
  seatChance: [number, number, number, number]; // by seat class 0..3
  weight: Record<Priority, number>;            // minutes of travel one standing minute is worth
  ridePenalty: number;                          // minutes per extra ride
  tightPenalty: number;
  maxReverseRide: number;                       // seconds
  lastTrainHold: number;                        // seconds a last train waits for a connecting line's passengers
}
export const DEFAULT_TUNING: Tuning = {
  seatChance: [0.1, 0.5, 0.8, 0.95],
  weight: { fast: 0.15, long: 0.6, all: 1.5 },
  ridePenalty: 4,
  tightPenalty: 3,
  maxReverseRide: 20 * 60,
  lastTrainHold: 5 * 60,
};

/** Measured or reported change times: key `${station}|${fromLine}${dir}>${toLine}` */
export interface InterchangeInfo { coach: 'front' | 'middle' | 'rear' | null; best: number /* minutes from best coach */; estimate?: boolean }
export const DEFAULT_INTERCHANGES: Record<string, InterchangeInfo> = {
  // rider report: front coach, about 3 min (Green from the south towards Majestic, change to Purple)
  'KGWA|GREEN1>PURPLE': { coach: 'front', best: 3 },
};
const GENERIC_CHANGE_MIN = 4;
/** `${station}|${line}${dir}>${nextLine}`; dir is +1/-1 along the line's station order in the timetable. */
export const interchangeKey = (station: string, line: LineId, dir: number, next: LineId) => `${station}|${line}${dir}>${next}`;
const PACE: Record<Pace, number> = { fast: 0.8, normal: 1, slow: 1.4 };

/** Crowd statistics from rider reports: key `${service}|${origin}|${HH:MM start}|${boardStation}` -> chance of a seat */
export type CrowdTable = Record<string, { p: number; n: number }>;

export interface EngineInput {
  tt: Timetable;
  req: PlanRequest;
  tuning?: Tuning;
  interchanges?: Record<string, InterchangeInfo>;
  crowd?: CrowdTable;
}

type RideLeg = Leg & { t0: number; pattern: number };
interface Label { stn: string; time: number; stand: number; rides: number; dep: number | null; legs: RideLeg[]; seen: Set<string> }
interface ChangeReq { kind: Change['kind']; need: number; key?: string; info?: InterchangeInfo }

const INTERCHANGES = new Set(['KGWA', 'RVR']);

export function plan(input: EngineInput): PlanResponse {
  const { tt, req } = input;
  const tuning = input.tuning ?? DEFAULT_TUNING;
  const inter = { ...DEFAULT_INTERCHANGES, ...(input.interchanges ?? {}) };
  const pace = PACE[req.pace ?? 'normal'];
  const date = new Date(+req.date.slice(0, 4), +req.date.slice(4, 6) - 1, +req.date.slice(6, 8));
  const service = serviceFor(tt, date);
  const empty = (error: PlanResponse['error'], extra: Partial<PlanResponse> = {}): PlanResponse =>
    ({ timetable: tt.version, service: service ?? '', best: -1, options: [], fallback: null, tradeoff: null, error, ...extra });

  if (req.from === req.to) return empty('same-station');
  if (!tt.stations[req.from] || !tt.stations[req.to]) return empty('no-route');
  if (!service) return empty('no-service');

  const origins = lineOrigins(tt);
  const work = service === 'weekday' || service === 'monday';

  /* ---- seat model ---- */
  const seatOf = (l: RideLeg): SeatClass => seatClass({ before: l.before, frac: l.frac, peak: work && isPeak(tt, service, l.dep) });
  const seatChance = (l: RideLeg): number => {
    const c = input.crowd?.[`${service}|${l.origin}|${fmt(l.t0 - (l.held ?? 0))}|${l.from}`];
    const prior = tuning.seatChance[seatOf(l)];
    if (!c || c.n < 1) return prior;
    const w = Math.min(1, c.n / 8);               // trust reports more as they add up
    return prior * (1 - w) + c.p * w;
  };

  /* ---- boarding index ---- */
  const boardCache = new Map<string, { pattern: number; t0: number; ia: number; dep: number; line: LineId; dir: number; held?: number }[]>();
  const boardings = (stn: string) => {
    let list = boardCache.get(stn);
    if (list) return list;
    list = [];
    tt.patterns.forEach((p, pi) => {
      const ia = p.stops.indexOf(stn);
      if (ia < 0 || ia === p.stops.length - 1) return;
      const dir = lineDir(tt, p.line, stn, p.stops[ia + 1]);
      for (const [i, t0] of tt.departures[service] ?? []) if (i === pi) list!.push({ pattern: pi, t0, ia, dep: t0 + p.dep[ia], line: p.line, dir });
    });
    list.sort((a, b) => a.dep - b.dep);
    boardCache.set(stn, list);
    return list;
  };
  /** latest departure per line and direction at a station: the night's last train that way */
  const lastCache = new Map<string, Record<string, number>>();
  const lastDeps = (stn: string) => {
    let m = lastCache.get(stn);
    if (!m) { m = {}; for (const e of boardings(stn)) m[e.line + e.dir] = Math.max(m[e.line + e.dir] ?? 0, e.dep); lastCache.set(stn, m); }
    return m;
  };
  const makeLeg = (ev: ReturnType<typeof boardings>[number], j: number): RideLeg => {
    const p = tt.patterns[ev.pattern], s = p.stops;
    return { line: p.line, from: s[ev.ia], to: s[j], dep: ev.dep, arr: ev.t0 + p.arr[j], origin: s[0], start: ev.t0, terminus: s[s.length - 1],
      before: ev.ia, stops: j - ev.ia, frac: ev.ia / (s.length - 1), work, dir: ev.dir, platform: p.pf[ev.ia] ?? null, t0: ev.t0, pattern: ev.pattern,
      ...(ev.held ? { held: ev.held } : {}) };
  };
  const changeNeed = (prev: RideLeg, next: { line: LineId; dir: number }): ChangeReq => {
    if (prev.line !== next.line) {
      const key = interchangeKey(prev.to, prev.line, prev.dir, next.line);
      const info = inter[key] ?? mirrored(inter, key);
      return { kind: 'line', key, info, need: Math.round((info ? info.best : GENERIC_CHANGE_MIN) * 60 * pace) };
    }
    return prev.dir === next.dir ? { kind: 'wait', need: Math.round(60 * pace) } : { kind: 'reverse', need: Math.round(180 * pace) };
  };

  /* ---- search ---- */
  const T = parseTime(req.time);
  const byMode = req.mode === 'by';
  const winStart = byMode ? T - 150 * 60 : T, winEnd = byMode ? T : T + 90 * 60, arrLimit = byMode ? T + 45 * 60 : T + 4 * 3600;
  const simplest = simplestRides(tt, req.from, req.to);
  const maxRides = Math.min(4, simplest + 2);
  const useful = (s: string, L: LineId) => s === req.to || INTERCHANGES.has(s) || origins[L]?.has(s);
  // A later first train is never "worse": arrive-by riders want to leave late, leave-now riders want a choice of departures.
  const beats = (a: Label, b: Label) => a.time <= b.time && a.stand <= b.stand + 0.01 && a.rides <= b.rides && (a.dep ?? 0) >= (b.dep ?? 0);
  const pareto = new Map<string, Label[]>();
  const finals: Label[] = [];
  let frontier: Label[] = [{ stn: req.from, time: winStart, stand: 0, rides: 0, dep: null, legs: [], seen: new Set([req.from]) }];

  for (let r = 0; r < maxRides && frontier.length; r++) {
    const next: Label[] = [];
    for (const lab of frontier) {
      const prev = lab.legs[lab.legs.length - 1];
      const perDir: Record<string, number> = {};
      for (const ev0 of boardings(lab.stn)) {
        let ev = ev0;
        if (r === 0) { if (ev.dep < winStart) continue; if (ev.dep > winEnd) break; }
        else {
          if (ev.dep < lab.time - tuning.lastTrainHold) continue;
          if (ev.dep > lab.time + 35 * 60) break;
          // Last train of the night on another line waits a few minutes for connecting passengers.
          if (prev && prev.line !== ev.line && INTERCHANGES.has(lab.stn) && ev.dep === lastDeps(lab.stn)[ev.line + ev.dir]) {
            const ready = prev.arr + changeNeed(prev, ev).need;
            if (ready > ev.dep && ready - ev.dep <= tuning.lastTrainHold) {
              const wait = ready - ev.dep;
              ev = { ...ev, dep: ev.dep + wait, t0: ev.t0 + wait, held: wait };
            }
          }
          if (ev.dep < lab.time) continue;
        }
        if (prev && prev.line === ev.line) {
          if (ev.ia !== 0) continue;                                     // only for a train that starts here
          if (seatOf(prev) >= 2) continue;                               // already seated: stay on
          if (prev.dir !== ev.dir && prev.arr - prev.dep > tuning.maxReverseRide) continue;
        }
        const dk = ev.line + ev.dir;
        if (r > 0 && (perDir[dk] = (perDir[dk] ?? 0) + 1) > 5) continue;
        if (prev && ev.dep - prev.arr < changeNeed(prev, ev).need) continue;
        const stops = tt.patterns[ev.pattern].stops;
        for (let j = ev.ia + 1; j < stops.length; j++) {
          const s = stops[j];
          if (!useful(s, ev.line) || lab.seen.has(s)) continue;
          const leg = makeLeg(ev, j);
          if (leg.arr > arrLimit) break;
          const n: Label = { stn: s, time: leg.arr, stand: lab.stand + ((leg.arr - leg.dep) / 60) * (1 - seatChance(leg)), rides: r + 1,
            dep: lab.dep ?? leg.dep, legs: [...lab.legs, leg], seen: new Set([...lab.seen, s]) };
          const list = pareto.get(s) ?? [];
          if (list.some((m) => beats(m, n))) continue;
          pareto.set(s, [...list.filter((m) => !beats(n, m)), n]);
          (s === req.to ? finals : next).push(n);
        }
      }
    }
    frontier = next.filter((n) => pareto.get(n.stn)?.includes(n));
  }

  /* ---- turn labels into options ---- */
  const women = !!req.women;
  const toOption = (lab: Label): PlanOption & { rides: number; tight: boolean } => {
    const legs = lab.legs, seats = legs.map(seatOf);
    const changes: Change[] = legs.slice(0, -1).map((l, i) => {
      const c = changeNeed(l, legs[i + 1]), available = legs[i + 1].dep - l.arr;
      if (c.kind !== 'line') return { kind: c.kind, at: l.to, available, walk: c.need, tight: available - c.need < 60, coaches: [], known: true };
      const held = !!legs[i + 1].held;
      const advice = coachAdvice(available, c, pace, women);
      return { kind: 'line', at: l.to, available, ...advice, ...(held ? { held: true, tight: false } : {}) };
    });
    const standLegs = legs.reduce((s, l, i) => s + (seats[i] < 2 ? (l.arr - l.dep) / 60 : 0), 0);
    const trickIdx = changes.findIndex((c, i) => c.kind !== 'line' && seats[i + 1] >= 2);
    const fare = tokenFare(tt, req.from, req.to);
    return {
      legs: legs.map(({ t0: _t0, pattern: _p, ...l }, i) => ({ ...l, seat: seats[i] })),
      changes, dep: legs[0].dep, arr: legs[legs.length - 1].arr, standMinutes: Math.round(lab.stand * 10) / 10,
      seatAllTheWay: standLegs <= 5,
      trick: trickIdx >= 0 ? { kind: changes[trickIdx].kind as 'wait' | 'reverse', at: changes[trickIdx].at } : null,
      fare, rides: legs.length, tight: changes.some((c) => c.tight),
    };
  };
  const all = finals.map(toOption);
  let feasible = byMode ? all.filter((o) => o.arr <= T) : all;
  if (!feasible.length) {
    const first = all.slice().sort((a, b) => a.arr - b.arr)[0];
    return empty('none-in-time', first ? { earliestArrival: first.arr } : {});
  }
  // drop "leave earlier only to wait longer": same or later arrival, no less standing, from an earlier first train
  feasible = feasible.filter((o) => !feasible.some((b) => b !== o && b.dep > o.dep && b.arr <= o.arr && b.standMinutes <= o.standMinutes + 0.01 && b.rides <= o.rides));
  // Late at night, warn when the last train that still gets you there is coming up.
  let last: PlanResponse['last'] = null;
  let lastOption: (typeof all)[number] | null = null;
  if (!byMode && T >= 21 * 3600) {
    const latest = all.reduce((a, b) => (b.dep > a.dep || (b.dep === a.dep && b.arr < a.arr) ? b : a));
    if (latest.dep <= winEnd - 10 * 60) { last = { dep: latest.dep, arr: latest.arr }; lastOption = latest; }
  }
  const minDur = Math.min(...feasible.map((o) => o.arr - o.dep)), minArr = Math.min(...feasible.map((o) => o.arr));
  feasible = feasible.filter((o) => o.arr - o.dep <= minDur * 1.35 + 600 && (byMode || o.arr <= minArr + 1800));

  const meets = (o: PlanOption, p: Priority) => p === 'fast' || (p === 'all' ? o.seatAllTheWay : longestSeated(o));
  const cost = (o: ReturnType<typeof toOption>, p: Priority) =>
    (byMode ? (T - o.dep) / 60 : (o.arr - T) / 60) + tuning.weight[p] * o.standMinutes + tuning.ridePenalty * (o.rides - 1) + (o.tight ? tuning.tightPenalty : 0);
  const ranked = feasible.slice().sort((a, b) => cost(a, req.priority) - cost(b, req.priority));
  const best = ranked[0];

  let fallback: PlanResponse['fallback'] = null;
  if (req.priority !== 'fast' && !meets(best, req.priority)) {
    const achieved: Priority = meets(best, 'long') ? 'long' : 'fast';
    const late = byMode ? all.filter((o) => meets(o, req.priority) && o.arr > T).sort((a, b) => a.arr - b.arr)[0] : undefined;
    fallback = { achieved, seatedArrival: late?.arr ?? null };
  }
  let tradeoff: PlanResponse['tradeoff'] = null;
  if (req.priority !== 'fast') {
    const quick = feasible.slice().sort(byMode ? (a, b) => b.dep - a.dep || a.standMinutes - b.standMinutes : (a, b) => a.arr - b.arr || a.standMinutes - b.standMinutes)[0];
    const extra = byMode ? mins(quick.dep - best.dep) : mins(best.arr - quick.arr);
    tradeoff = { extraMinutes: Math.max(0, extra), standingSaved: Math.max(0, Math.round(quick.standMinutes - best.standMinutes)) };
  }
  const seen = new Set<string>(), options: PlanOption[] = [];
  for (const o of ranked) {
    const sig = o.legs.map((l) => l.line + l.dep + l.to).join('|');
    if (seen.has(sig)) continue;
    seen.add(sig);
    const { rides: _r, tight: _t, ...clean } = o;
    options.push(clean);
    if (options.length >= 8) break;
  }
  // the last train must always be openable, even if it arrives much later than the others
  if (lastOption && !options.some((o) => o.dep === lastOption.dep && o.arr === lastOption.arr)) {
    const { rides: _r, tight: _t, ...clean } = lastOption;
    options.push(clean);
  }
  return { timetable: tt.version, service, best: 0, options, fallback, tradeoff, last };
}

function longestSeated(o: PlanOption) {
  let li = 0;
  o.legs.forEach((l, i) => { if (l.arr - l.dep > o.legs[li].arr - o.legs[li].dep) li = i; });
  return o.legs[li].seat >= 2;
}

/** Fewest rides between two stations ignoring time (1 same line, 2 one change, 3 two changes). */
function simplestRides(tt: Timetable, a: string, b: string): number {
  const la = Object.keys(tt.lines).filter((L) => tt.lines[L].stations.includes(a));
  const lb = Object.keys(tt.lines).filter((L) => tt.lines[L].stations.includes(b));
  if (la.some((L) => lb.includes(L))) return 1;
  for (const A of la) for (const B of lb) if (tt.lines[A].stations.some((s) => tt.lines[B].stations.includes(s))) return 2;
  return 3;
}

/**
 * No report yet for this direction: use the opposite direction of the same change. The stairs don't move,
 * so a train arriving from the other side has them at its other end (front <-> rear). Marked as an estimate.
 */
function mirrored(inter: Record<string, InterchangeInfo>, key: string): InterchangeInfo | undefined {
  const m = /^(.+\|[A-Z]+)(-?1)>(.+)$/.exec(key);
  if (!m) return undefined;
  const other = inter[`${m[1]}${m[2] === '1' ? '-1' : '1'}>${m[3]}`];
  if (!other?.coach) return undefined;
  const flip = { front: 'rear', rear: 'front', middle: 'middle' } as const;
  return { coach: flip[other.coach], best: other.best, estimate: true };
}

/** Which coach to be in for a line change, given the time available. Always names the quickest coaches. */
function coachAdvice(available: number, c: ChangeReq, pace: number, women: boolean) {
  const info = c.info;
  if (!info || !info.coach) return { walk: c.need, tight: available - c.need < 90, coaches: [] as number[], known: false };
  const step = 90 * pace, best = c.need, mid = best + step, far = best + (info.coach === 'middle' ? step : 2 * step);
  const sets = {
    front: { one: [women ? 1 : 2], half: women ? [1, 2, 3] : [2, 3] },
    middle: { one: [3, 4], half: [2, 3, 4, 5] },
    rear: { one: [6], half: [4, 5, 6] },
  }[info.coach];
  const known = !info.estimate;
  if (available >= far) return { walk: best, tight: false, coaches: sets.half, known };
  // walking time assumes the rider takes the coaches we recommend
  if (available >= mid) return { walk: best, tight: false, coaches: sets.half, known };
  return { walk: best, tight: true, coaches: sets.one, known };
}

export { cardFare };
export type { ServiceId };
