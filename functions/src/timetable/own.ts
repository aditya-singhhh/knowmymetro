/**
 * Our own timetable: a readable, editable source that compiles into data/timetable.json.
 *
 *   data/timetable/meta.json             stations, lines, services, holidays, peak hours, fares
 *   data/timetable/patterns.json         stop sequence + running times of every train pattern
 *   data/timetable/departures/<svc>.json pattern id -> list of start times ("HH:MM:SS")
 *   data/timetable/observations/*.json   what riders saw (screenshots, rides), with their source
 *
 * Observations are applied to the source (so every change is a readable diff), then the source is
 * compiled. Push to main and the server publishes it; phones pick it up on their next launch.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Pattern, Timetable } from '@kmm/shared';

export interface SrcStop { stn: string; arr: string; dep: string; pf: string | null }
export interface SrcPattern { id: string; line: string; stops: SrcStop[]; note?: string }
export interface SrcMeta extends Omit<Timetable, 'patterns' | 'departures' | 'version' | 'generatedAt'> { source: string }

/* ------------------------------------------------------------------ time helpers */
const two = (n: number) => String(n).padStart(2, '0');
export const clock = (s: number) => `${two(Math.floor(s / 3600))}:${two(Math.floor((s % 3600) / 60))}:${two(Math.round(s % 60))}`;
export const offset = (s: number) => `${Math.floor(s / 60)}:${two(Math.round(s % 60))}`;
/** "m:ss" offsets inside a pattern */
export const off = (t: string) => { const [m, s] = t.split(':').map(Number); return m * 60 + s; };
/** "HH:MM" or "HH:MM:SS" clock times */
export const at = (t: string) => { const p = t.split(':').map(Number); return p[0] * 3600 + p[1] * 60 + (p[2] ?? 0); };

export const patternId = (line: string, stops: string[]) => `${line}:${stops[0]}>${stops[stops.length - 1]}`;

/* ------------------------------------------------------------------ export / compile */
export function exportSource(tt: Timetable, dir: string, source: string) {
  mkdirSync(join(dir, 'departures'), { recursive: true });
  mkdirSync(join(dir, 'observations'), { recursive: true });
  const { patterns, departures, version: _v, generatedAt: _g, ...rest } = tt;
  const meta: SrcMeta = { ...rest, source };
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta, null, 1) + '\n');
  const src: SrcPattern[] = patterns.map((p) => ({
    id: patternId(p.line, p.stops), line: p.line,
    stops: p.stops.map((stn, i) => ({ stn, arr: offset(p.arr[i]), dep: offset(p.dep[i]), pf: p.pf[i] ?? null })),
  }));
  writeJson(join(dir, 'patterns.json'), src);
  for (const [svc, list] of Object.entries(departures)) {
    const out: Record<string, string[]> = {};
    for (const [pi, t0] of list) (out[src[pi].id] ||= []).push(clock(t0));
    for (const k of Object.keys(out)) out[k].sort();
    writeJson(join(dir, 'departures', `${svc}.json`), sortKeys(out));
  }
}

export function loadSource(dir: string) {
  const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) as SrcMeta;
  const patterns = JSON.parse(readFileSync(join(dir, 'patterns.json'), 'utf8')) as SrcPattern[];
  const departures: Record<string, Record<string, string[]>> = {};
  for (const f of readdirSync(join(dir, 'departures')).filter((x) => x.endsWith('.json'))) {
    departures[f.replace(/\.json$/, '')] = JSON.parse(readFileSync(join(dir, 'departures', f), 'utf8'));
  }
  return { meta, patterns, departures };
}

export function saveSource(dir: string, s: ReturnType<typeof loadSource>) {
  writeJson(join(dir, 'patterns.json'), s.patterns);
  for (const [svc, d] of Object.entries(s.departures)) {
    for (const k of Object.keys(d)) d[k] = [...new Set(d[k])].sort();
    writeJson(join(dir, 'departures', `${svc}.json`), sortKeys(d));
  }
}

export function compile(src: Src): Timetable {
  const { meta, patterns, departures } = src;
  const { source: _s, ...rest } = meta;
  const index = new Map(patterns.map((p, i) => [p.id, i]));
  const out: Pattern[] = patterns.map((p) => ({
    line: p.line, stops: p.stops.map((s) => s.stn), arr: p.stops.map((s) => off(s.arr)), dep: p.stops.map((s) => off(s.dep)), pf: p.stops.map((s) => s.pf),
  }));
  const deps: Record<string, [number, number][]> = {};
  for (const [svc, d] of Object.entries(departures)) {
    deps[svc] = [];
    for (const [id, times] of Object.entries(d)) {
      const pi = index.get(id);
      if (pi == null) throw new Error(`departures/${svc}.json: unknown pattern ${id}`);
      for (const t of times) deps[svc].push([pi, at(t)]);
    }
    deps[svc].sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  }
  const body = JSON.stringify({ patterns: out, departures: deps });
  const hash = createHash('sha256').update(body).digest('hex').slice(0, 8);
  return { version: `own-${hash}`, generatedAt: new Date().toISOString(), ...rest, patterns: out, departures: deps } as Timetable;
}

/* ------------------------------------------------------------------ observations */
/** A full run of one train, read off a screen: one time per station (minute precision). */
export interface RunObservation {
  type: 'run'; source: string; date: string; service: string; line: string;
  stops: [string, string][];            // [station code, "HH:MM"] in travel order
  pf?: Record<string, string>;          // platforms seen
  /** true = a normal run whose times can become the running times of every train on this stretch.
   *  Late-night or delayed runs are kept for reference only. */
  typical?: boolean;
}
/** A station's departure board: trains leaving one station in one direction. */
export interface BoardObservation {
  type: 'board'; source: string; date: string; service: string; line: string; station: string;
  towards: string;                       // last station of the line in this direction (sets the direction)
  trains: { dep: string; from: string; to: string; pf?: string; arrive?: Record<string, string> }[];
}
export type Observation = RunObservation | BoardObservation;

const DWELL = 30; // seconds, until rides tell us the real dwell per station

type Src = ReturnType<typeof loadSource>;

function lineStations(meta: SrcMeta, line: string) { return meta.lines[line].stations; }
function dirOf(meta: SrcMeta, line: string, from: string, to: string) {
  const st = lineStations(meta, line); return st.indexOf(to) > st.indexOf(from) ? 1 : -1;
}

/** Make (or find) the pattern line from -> to, cut from the longest pattern going that way. */
function ensurePattern(s: Src, line: string, from: string, to: string, log: string[]): SrcPattern {
  const found = s.patterns.find((p) => p.line === line && p.stops[0].stn === from && p.stops[p.stops.length - 1].stn === to);
  if (found) return found;
  const full = s.patterns.filter((p) => p.line === line).map((p) => ({ p, a: p.stops.findIndex((x) => x.stn === from), b: p.stops.findIndex((x) => x.stn === to) }))
    .filter((x) => x.a >= 0 && x.b > x.a).sort((x, y) => y.p.stops.length - x.p.stops.length)[0];
  if (!full) throw new Error(`no pattern on ${line} runs ${from} -> ${to}`);
  const slice = full.p.stops.slice(full.a, full.b + 1);
  const t0 = off(slice[0].dep);
  const stops = slice.map((x, i) => ({ ...x, arr: offset(i === 0 ? 0 : off(x.arr) - t0), dep: offset(i === 0 ? 0 : i === slice.length - 1 ? off(x.arr) - t0 : off(x.dep) - t0) }));
  const p: SrcPattern = { id: patternId(line, stops.map((x) => x.stn)), line, stops, note: `cut from ${full.p.id}` };
  s.patterns.push(p);
  log.push(`+ pattern ${p.id} (${p.note})`);
  return p;
}

/** Running times from an observed run replace those of every pattern on that stretch, same direction. */
function applyRun(s: Src, o: RunObservation, log: string[]) {
  if (!o.typical) { log.push(`  run ${o.stops[0][0]} ${o.stops[0][1]} kept for reference only (${o.source})`); return; }
  const obs = new Map(o.stops.map(([stn, t]) => [stn, at(t)]));
  const order = o.stops.map(([stn]) => stn);
  for (const p of s.patterns) {
    if (p.line !== o.line) continue;
    const idx = p.stops.map((x) => order.indexOf(x.stn));
    if (idx.some((i) => i < 0) || idx.some((i, k) => k > 0 && i <= idx[k - 1])) continue; // not on this run, or other direction
    const base = obs.get(p.stops[0].stn)!;
    p.stops.forEach((x, i) => {
      const dep = obs.get(x.stn)! - base;
      const last = i === p.stops.length - 1;
      x.arr = offset(i === 0 ? 0 : Math.max(0, last ? dep : dep - DWELL));
      x.dep = offset(last ? dep : dep);
      if (o.pf?.[x.stn]) x.pf = o.pf[x.stn];
    });
    log.push(`~ running times ${p.id} from ${o.source}: ${offset(off(p.stops[p.stops.length - 1].arr))} end to end`);
  }
}

/** Time this train of pattern p passes (or would pass) station stn, using the longest pattern on that stretch for trains that don't reach it. */
function timeAt(s: Src, p: SrcPattern, t0: number, stn: string): number | null {
  const k = p.stops.findIndex((x) => x.stn === stn);
  if (k >= 0) return t0 + off(p.stops[k].dep);
  const first = p.stops[0].stn, last = p.stops[p.stops.length - 1].stn;
  const ref = s.patterns.filter((q) => q.line === p.line).map((q) => ({ q, a: q.stops.findIndex((x) => x.stn === first), b: q.stops.findIndex((x) => x.stn === last), c: q.stops.findIndex((x) => x.stn === stn) }))
    .filter((x) => x.a >= 0 && x.b > x.a && x.c >= 0).sort((x, y) => y.q.stops.length - x.q.stops.length)[0];
  return ref ? t0 - off(ref.q.stops[ref.a].dep) + off(ref.q.stops[ref.c].dep) : null;
}

/**
 * A departure board: the trains in its time window at that station are exactly these (ours in that window are replaced).
 * Trains that never pass the station (short trips starting or ending elsewhere) can't be seen on this board, but the
 * feed built them from the same timetable bands as their neighbours, so they get the same correction as the nearest
 * matched train ("carried"), unless an observation already placed them.
 */
function applyBoard(s: Src, o: BoardObservation, log: string[], seen: Map<string, number>, samples: Sample[]) {
  const dep = (s.departures[o.service] ||= {});
  const dir = dirOf(s.meta, o.line, o.station, o.towards);
  const rows = o.trains.filter((t) => t.from !== '?' && t.to !== '?');
  const times = rows.map((t) => at(t.dep));
  const lo = Math.min(...times) - 60, hi = Math.max(...times) + 60;
  const sameDir = (p: SrcPattern) => p.line === o.line && dirOf(s.meta, o.line, p.stops[0].stn, p.stops[p.stops.length - 1].stn) === dir;
  const passes = (p: SrcPattern) => { const k = p.stops.findIndex((x) => x.stn === o.station); return k >= 0 && k < p.stops.length - 1; };
  // remove what we had in that window, that direction, at that station
  const old: number[] = [];
  for (const p of s.patterns) {
    if (!sameDir(p) || !passes(p)) continue;
    const k = p.stops.findIndex((x) => x.stn === o.station);
    const list = dep[p.id] ?? [];
    // trains an earlier board already placed (e.g. at the terminus) stay; this board only confirms them
    // also the same train (same start and end) a few minutes off: a board with one or two rows moves it rather than adding a twin
    const twin = (here: number) => rows.some((r) => r.from === p.stops[0].stn && r.to === p.stops[p.stops.length - 1].stn && Math.abs(at(r.dep) - here) <= 180);
    const keep = list.filter((t) => { const here = at(t) + off(p.stops[k].dep); if (((here >= lo && here <= hi) || twin(here)) && !seen.has(`${o.service}|${p.id}|${t}`)) { old.push(here); return false; } return true; });
    if (list.length) dep[p.id] = keep;
  }
  // add what the board shows
  const now: number[] = [];
  let confirmed = 0;
  const sample = (pid: string, t0: string, k: number, j: number, d: number) => samples.push({ svc: o.service, pid, k, j, d });
  for (const t of rows) {
    const p = ensurePattern(s, o.line, t.from, t.to, log);
    const k = p.stops.findIndex((x) => x.stn === o.station);
    const placed = (dep[p.id] ?? []).find((x) => seen.has(`${o.service}|${p.id}|${x}`) && Math.abs(at(x) + off(p.stops[k].dep) - at(t.dep)) <= 150);
    const t0 = placed ? at(placed) : at(t.dep) - off(p.stops[k].dep);
    const pk = placed ? seen.get(`${o.service}|${p.id}|${placed}`)! : k;   // where this train's time is anchored
    if (placed) {
      confirmed++;
      sample(p.id, placed, pk, k, at(t.dep) - (t0 + off(p.stops[k].dep)));
    } else {
      (dep[p.id] ||= []).push(clock(t0));
      seen.set(`${o.service}|${p.id}|${clock(t0)}`, k);
      now.push(at(t.dep));
      if (t.pf) p.stops[k].pf = t.pf;
    }
    for (const [stn, a] of Object.entries(t.arrive ?? {})) {
      const j = p.stops.findIndex((x) => x.stn === stn);
      if (j < 0) continue;
      let d = at(a) - (t0 + off(p.stops[j].arr));
      if (d < -43200) d += 86400;
      sample(p.id, clock(t0), pk, j, d);
    }
  }
  // how much each of our old trains moved: pair old and new in order of time, nearest first, within 6 min
  old.sort((a, b) => a - b); now.sort((a, b) => a - b);
  const used = new Set<number>(), shifts: [number, number][] = [];
  for (const a of old) {
    let best = -1;
    now.forEach((b, i) => { if (!used.has(i) && Math.abs(b - a) <= 360 && (best < 0 || Math.abs(b - a) < Math.abs(now[best] - a))) best = i; });
    if (best >= 0) { used.add(best); shifts.push([a, now[best] - a]); }
  }
  // carry the correction to trains this board can't see
  let carried = 0;
  if (shifts.length) {
    for (const p of s.patterns) {
      if (!sameDir(p) || passes(p)) continue;
      const list = dep[p.id];
      if (!list?.length) continue;
      dep[p.id] = list.map((t) => {
        if (seen.has(`${o.service}|${p.id}|${t}`)) return t;
        const here = timeAt(s, p, at(t), o.station);
        if (here == null || here < lo - 300 || here > hi + 300) return t;
        const [, d] = shifts.reduce((x, y) => (Math.abs(y[0] - here) < Math.abs(x[0] - here) ? y : x));
        if (!d) return t;
        carried++;
        return clock(at(t) + d);
      });
    }
  }
  const moved = shifts.filter(([, d]) => d).length;
  log.push(`~ board ${o.station} ${o.line} towards ${o.towards} ${o.service} ${clock(lo + 60).slice(0, 5)}-${clock(hi - 60).slice(0, 5)}: ${confirmed} already placed, ${old.length} others -> ${rows.length - confirmed} (${moved} moved, ${old.length - shifts.length} dropped, ${rows.length - confirmed - shifts.length} added), ${carried} short trips carried (${o.source})`);
}

interface Sample { svc: string; pid: string; k: number; j: number; d: number }

/**
 * Boards also tell us how long trains take: a train placed at one station shows up at another station's board,
 * or the board says when it arrives somewhere. If most trains of a pattern disagree with our running time the same
 * way (median of at least 3, by at least 30 s), the pattern's times are bent to match: corrections are pinned at the
 * station the trains were placed from and spread linearly between the measured stations. A few unusual trains
 * (late night, delays) don't move the median.
 */
function fitRunningTimes(s: Src, samples: Sample[], log: string[]) {
  const by = new Map<string, Sample[]>();
  for (const x of samples) (by.get(x.pid) ?? by.set(x.pid, []).get(x.pid)!).push(x);
  for (const [pid, xs] of by) {
    const p = s.patterns.find((q) => q.id === pid)!;
    // use the samples of the most common anchor station
    const ks = new Map<number, number>(); xs.forEach((x) => ks.set(x.k, (ks.get(x.k) ?? 0) + 1));
    const k = [...ks].sort((a, b) => b[1] - a[1])[0][0];
    const at_ = new Map<number, number[]>();
    xs.filter((x) => x.k === k && x.j !== k).forEach((x) => (at_.get(x.j) ?? at_.set(x.j, []).get(x.j)!).push(x.d));
    const anchors: [number, number][] = [[k, 0]];
    for (const [j, ds] of at_) {
      if (ds.length < 3) continue;
      const m = ds.sort((a, b) => a - b)[Math.floor(ds.length / 2)];
      anchors.push([j, Math.abs(m) >= 30 ? m : 0]);
    }
    if (anchors.every(([, d]) => d === 0)) continue;
    anchors.sort((a, b) => a[0] - b[0]);
    const T = (i: number) => off(p.stops[i].dep);
    const corr = (i: number) => {
      if (i <= anchors[0][0]) return anchors[0][1];
      if (i >= anchors[anchors.length - 1][0]) return anchors[anchors.length - 1][1];
      const n = anchors.findIndex(([j]) => j >= i), [a, da] = anchors[n - 1], [b, db] = anchors[n];
      return da + ((db - da) * (T(i) - T(a))) / Math.max(1, T(b) - T(a));
    };
    const before = off(p.stops[p.stops.length - 1].arr);
    const next = p.stops.map((x, i) => ({ arr: off(x.arr) + corr(i), dep: off(x.dep) + corr(i) }));
    const base = next[0].dep;   // keep offsets relative to the first stop (start times move with it)
    if (next.some((x, i) => i > 0 && x.arr < next[i - 1].dep)) { log.push(`  ${pid}: measured running times don't fit, kept`); continue; }
    p.stops.forEach((x, i) => { x.arr = offset(Math.round(next[i].arr - base)); x.dep = offset(Math.round(next[i].dep - base)); });
    if (base) for (const d of Object.values(s.departures)) if (d[pid]) d[pid] = d[pid].map((t) => clock(at(t) + Math.round(base)));
    log.push(`~ running times ${pid}: ${anchors.map(([j, d]) => `${p.stops[j].stn} ${d >= 0 ? '+' : ''}${Math.round(d)}s`).join(', ')} (end to end ${offset(before)} -> ${offset(off(p.stops[p.stops.length - 1].arr))})`);
  }
}

/**
 * Build the timetable: the base source plus every observation, applied fresh each time (the source files are never
 * changed, so the result is reproducible and an observation can be fixed or removed by editing its file).
 * Order: typical runs (running times), then boards at end stations, then boards at middle stations, each by date.
 */
export function build(dir: string): { tt: Timetable; log: string[] } {
  const s = loadSource(dir);
  const log: string[] = [];
  const obsDir = join(dir, 'observations');
  const obs = (existsSync(obsDir) ? readdirSync(obsDir).filter((f) => f.endsWith('.json')).sort() : [])
    .map((f) => JSON.parse(readFileSync(join(obsDir, f), 'utf8')) as Observation);
  for (const o of obs) if (o.type === 'run') applyRun(s, o, log);
  const end = (o: BoardObservation) => { const st = lineStations(s.meta, o.line); return o.station === st[0] || o.station === st[st.length - 1] ? 0 : 1; };
  const boards = obs.filter((o): o is BoardObservation => o.type === 'board').sort((a, b) => end(a) - end(b) || a.date.localeCompare(b.date));
  const seen = new Map<string, number>();
  const samples: Sample[] = [];
  for (const o of boards) applyBoard(s, o, log, seen, samples);
  fitRunningTimes(s, samples, log);
  for (const d of Object.values(s.departures)) for (const k of Object.keys(d)) d[k] = [...new Set(d[k])].sort();
  return { tt: compile(s), log };
}

/* ------------------------------------------------------------------ helpers */
function writeJson(file: string, v: unknown) {
  // one item per line: readable diffs without a huge file
  const body = Array.isArray(v)
    ? '[\n' + v.map((x) => ' ' + JSON.stringify(x)).join(',\n') + '\n]\n'
    : '{\n' + Object.entries(v as Record<string, unknown>).map(([k, x]) => ` ${JSON.stringify(k)}: ${JSON.stringify(x)}`).join(',\n') + '\n}\n';
  writeFileSync(file, body);
}
function sortKeys<T>(o: Record<string, T>) { return Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b))); }
export const sourceExists = (dir: string) => existsSync(join(dir, 'meta.json'));
