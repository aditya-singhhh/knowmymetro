import type { Lang } from './i18n';
import type { LineId, SeatClass, ServiceId, Timetable } from './types';

export const pad2 = (n: number) => String(n).padStart(2, '0');

/** 29700 -> "08:15" (wraps past midnight) */
export function fmt(sec: number): string {
  const s = ((sec % 86400) + 86400) % 86400;
  return `${pad2(Math.floor(s / 3600))}:${pad2(Math.floor((s % 3600) / 60))}`;
}
export const parseTime = (hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); return h * 3600 + m * 60; };
export const mins = (sec: number) => Math.round(sec / 60);
export const secondsNow = (d = new Date()) => d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
export const ymd = (d: Date) => `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;

/** Which timetable runs on a given date (holiday overrides others). */
export function serviceFor(tt: Timetable, date: Date): ServiceId | null {
  const k = ymd(date), dow = date.getDay();
  const active = new Set(tt.services.filter((s) => s.days[dow] && k >= s.start && k <= s.end).map((s) => s.id));
  for (const e of tt.exceptions) if (e.date === k) (e.type === 1 ? active.add(e.service) : active.delete(e.service));
  for (const id of ['holiday', 'monday', 'sunday', 'weekday']) if (active.has(id)) return id;
  return active.values().next().value ?? null;
}

export const linesOf = (tt: Timetable, code: string): LineId[] =>
  Object.keys(tt.lines).filter((L) => tt.lines[L].stations.includes(code));

export const lineDir = (tt: Timetable, L: LineId, a: string, b: string) =>
  Math.sign(tt.lines[L].stations.indexOf(b) - tt.lines[L].stations.indexOf(a));

export function stationName(tt: Timetable, code: string, lang: Lang = 'en'): string {
  const s = tt.stations[code];
  if (!s) return code;
  return lang === 'kn' && s.kn ? s.kn.split(',').pop()!.trim() : s.en;
}

export function isPeak(tt: Timetable, service: ServiceId, sec: number): boolean {
  return tt.peak.some((p) => p.service === service && sec >= p.from && sec < p.to);
}

export function tokenFare(tt: Timetable, a: string, b: string): number | null {
  const i = tt.fares.codes.indexOf(a), j = tt.fares.codes.indexOf(b);
  if (i < 0 || j < 0) return null;
  return tt.fares.token[i][j] || tt.fares.token[j][i] || null;
}
/** Smart cards get 5% off at peak and 10% off-peak. */
export const cardFare = (token: number, peak: boolean) => Math.round(token * (peak ? 0.95 : 0.9) * 100) / 100;

/**
 * Seat estimate for boarding a train. Until crowd reports exist this is a rule of thumb:
 * trains that start at or just before your station have seats; full trains at peak do not;
 * trains near the end of their run empty out.
 */
export function seatClass(opts: { before: number; frac: number; peak: boolean }): SeatClass {
  if (opts.before === 0) return 3;
  if (opts.before <= 2) return 2;
  if (opts.peak && opts.frac < 0.6) return 0;
  return 1;
}

export interface Departure {
  line: LineId;
  pattern: number;
  dep: number;
  origin: string;
  terminus: string;
  before: number;
  frac: number;
  dir: number;
  platform: string | null;
  seat: SeatClass;
}

/** Trains leaving a station, grouped by line and direction. */
export function departuresAt(tt: Timetable, code: string, service: ServiceId, fromSec: number, perDirection = 4) {
  const groups = new Map<string, { line: LineId; dir: number; towards: string; via: string | null; rows: Departure[] }>();
  for (const L of linesOf(tt, code)) {
    const st = tt.lines[L].stations, ic = st.indexOf(code);
    for (const dir of [-1, 1]) {
      const endIdx = dir < 0 ? 0 : st.length - 1;
      if (ic === endIdx) continue;
      const via = ['KGWA', 'RVR'].find((x) => { const ix = st.indexOf(x); return ix >= 0 && x !== code && (dir < 0 ? ix < ic : ix > ic); }) ?? null;
      groups.set(L + dir, { line: L, dir, towards: st[endIdx], via, rows: [] });
    }
  }
  const work = service === 'weekday' || service === 'monday';
  tt.patterns.forEach((p, pi) => {
    const ia = p.stops.indexOf(code);
    if (ia < 0 || ia === p.stops.length - 1) return;
    const dir = lineDir(tt, p.line, code, p.stops[ia + 1]);
    const g = groups.get(p.line + dir); if (!g) return;
    for (const [i, t0] of tt.departures[service] ?? []) {
      if (i !== pi) continue;
      const dep = t0 + p.dep[ia];
      if (dep < fromSec) continue;
      const frac = ia / (p.stops.length - 1);
      g.rows.push({ line: p.line, pattern: pi, dep, origin: p.stops[0], terminus: p.stops[p.stops.length - 1], before: ia, frac, dir,
        platform: p.pf[ia] ?? null, seat: seatClass({ before: ia, frac, peak: work && isPeak(tt, service, dep) }) });
    }
  });
  return [...groups.values()].map((g) => ({ ...g, rows: g.rows.sort((a, b) => a.dep - b.dep).slice(0, perDirection) }));
}

/** Stations where trains of each line start: where "empty train" tricks are possible. */
export function lineOrigins(tt: Timetable): Record<LineId, Set<string>> {
  const out: Record<string, Set<string>> = {};
  for (const p of tt.patterns) (out[p.line] ||= new Set()).add(p.stops[0]);
  return out;
}

export function nearestStation(tt: Timetable, lat: number, lon: number): string | null {
  let best: string | null = null, bd = Infinity;
  for (const [c, s] of Object.entries(tt.stations)) {
    const dx = (s.lon - lon) * Math.cos((lat * Math.PI) / 180), dy = s.lat - lat, d = dx * dx + dy * dy;
    if (d < bd) { bd = d; best = c; }
  }
  return best;
}
