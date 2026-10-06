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

export function compile(dir: string): Timetable {
  const { meta, patterns, departures } = loadSource(dir);
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
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return { version: `${day}-${hash}`, generatedAt: new Date().toISOString(), ...rest, patterns: out, departures: deps } as Timetable;
}

/* ------------------------------------------------------------------ observations */
/** A full run of one train, read off a screen: one time per station (minute precision). */
export interface RunObservation {
  type: 'run'; source: string; date: string; service: string; line: string;
  stops: [string, string][];            // [station code, "HH:MM"] in travel order
  pf?: Record<string, string>;          // platforms seen
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

/** A departure board: the trains in its time window are exactly these (others in that window are removed). */
function applyBoard(s: Src, o: BoardObservation, log: string[]) {
  const dep = (s.departures[o.service] ||= {});
  const dir = dirOf(s.meta, o.line, o.station, o.towards);
  const times = o.trains.map((t) => at(t.dep));
  const lo = Math.min(...times) - 60, hi = Math.max(...times) + 60;
  // remove what we had in that window, that direction, at that station
  let removed = 0;
  for (const p of s.patterns) {
    if (p.line !== o.line) continue;
    const k = p.stops.findIndex((x) => x.stn === o.station);
    if (k < 0 || k === p.stops.length - 1 || dirOf(s.meta, o.line, p.stops[0].stn, p.stops[p.stops.length - 1].stn) !== dir) continue;
    const list = dep[p.id] ?? [];
    const keep = list.filter((t) => { const here = at(t) + off(p.stops[k].dep); return here < lo || here > hi; });
    removed += list.length - keep.length;
    if (list.length) dep[p.id] = keep;
  }
  // add what the board shows
  for (const t of o.trains) {
    const p = ensurePattern(s, o.line, t.from, t.to, log);
    const k = p.stops.findIndex((x) => x.stn === o.station);
    const t0 = at(t.dep) - off(p.stops[k].dep);
    (dep[p.id] ||= []).push(clock(t0));
    if (t.pf) p.stops[k].pf = t.pf;
    for (const [stn, a] of Object.entries(t.arrive ?? {})) {
      const j = p.stops.findIndex((x) => x.stn === stn);
      if (j < 0) continue;
      const ours = t0 + off(p.stops[j].arr);
      const diff = Math.round((at(a) - ours) / 60);
      if (Math.abs(diff) >= 2) log.push(`! ${p.id} ${t.dep}: board says ${stn} ${a}, our running time gives ${clock(ours).slice(0, 5)} (${diff > 0 ? '+' : ''}${diff} min)`);
    }
  }
  log.push(`~ board ${o.station} ${o.line} towards ${o.towards} ${o.service} ${clock(lo + 60).slice(0, 5)}-${clock(hi - 60).slice(0, 5)}: -${removed} +${o.trains.length} (${o.source})`);
}

export function applyObservations(dir: string, files: string[]): string[] {
  const s = loadSource(dir);
  const log: string[] = [];
  const obs = files.map((f) => JSON.parse(readFileSync(f, 'utf8')) as Observation);
  // running times first, then boards (boards place trains using the corrected running times)
  for (const o of obs) if (o.type === 'run') applyRun(s, o, log);
  for (const o of obs) if (o.type === 'board') applyBoard(s, o, log);
  saveSource(dir, s);
  return log;
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
