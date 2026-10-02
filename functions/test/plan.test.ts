import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmt, type PlanRequest, type Timetable } from '@kmm/shared';
import { DEFAULT_TUNING, plan } from '../src/engine/plan';
import timetable from '../../data/timetable.json';

const tt = timetable as unknown as Timetable;
const TUESDAY = '20260929';
const run = (r: Partial<PlanRequest>) => plan({ tt, req: { from: 'JPN', to: 'DKIA', date: TUESDAY, time: '09:30', mode: 'by', priority: 'all', ...r } });
const route = (o: { legs: { from: string; to: string; dep: number }[] }) => o.legs.map((l) => `${fmt(l.dep)} ${l.from}>${l.to}`).join(' | ');

test('JP Nagar to Hoodi by 09:30, seat all the way: 08:27 then the Majestic-start train', () => {
  const r = run({});
  const best = r.options[r.best];
  assert.equal(route(best), '08:27 JPN>KGWA | 08:53 KGWA>DKIA');
  assert.ok(best.seatAllTheWay);
  assert.equal(best.fare, 80);
});

test('front-coach tip is used at Majestic (Green to Purple) when the change is tight', () => {
  const r = run({ priority: 'fast', time: '09:16' });
  const withChange = r.options.find((o) => o.changes[0]?.kind === 'line' && o.changes[0].tight);
  if (withChange) assert.deepEqual(withChange.changes[0].coaches, [2]);
  const women = run({ priority: 'fast', time: '09:16', women: true }).options.find((o) => o.changes[0]?.tight);
  if (women) assert.deepEqual(women.changes[0].coaches, [1]);
});

test('Hoodi to MG Road by 09:30: stand one stop to Garudacharpalya, sit on the train that starts there', () => {
  const r = run({ from: 'DKIA', to: 'MAGR' });
  const best = r.options[r.best];
  assert.equal(best.legs.length, 2);
  assert.equal(best.legs[0].to, 'GDCP');
  assert.equal(best.legs[1].before, 0);
  assert.deepEqual(best.trick, { kind: 'wait', at: 'GDCP' });
});

test('never gets off to wait for a train that does not start there (RV Road bug)', () => {
  for (const from of ['WHTM', 'DKIA', 'ITPL', 'MAGR']) {
    for (const priority of ['fast', 'long', 'all'] as const) {
      const r = run({ from, to: 'JPN', mode: 'after', time: '17:30', priority });
      for (const o of r.options) {
        o.legs.forEach((l, i) => {
          const prev = o.legs[i - 1];
          if (prev && prev.line === l.line) assert.equal(l.before, 0, `${from} ${priority}: ${route(o)}`);
        });
      }
    }
  }
});

test('no long detours: MG Road to Whitefield in the evening stays direct', () => {
  const r = run({ from: 'MAGR', to: 'WHTM', mode: 'after', time: '18:30' });
  assert.equal(r.options[r.best].legs.length, 1);
  for (const o of r.options) assert.ok(o.arr - o.dep < 75 * 60, route(o));
});

test('fastest still prefers a seat when it costs nothing', () => {
  const r = run({ priority: 'fast', mode: 'after', time: '08:20' });
  const best = r.options[r.best];
  const sameArrival = r.options.filter((o) => o.arr === best.arr);
  assert.ok(sameArrival.every((o) => o.standMinutes >= best.standMinutes - 0.01));
});

test('arrive-by with no seated option falls back and says how late a seat would be', () => {
  const r = run({ from: 'DKIA', to: 'JPN', mode: 'by', time: '19:00' });
  assert.ok(r.options.length > 0);
  if (r.fallback) assert.ok(r.fallback.seatedArrival === null || r.fallback.seatedArrival > 19 * 3600);
});

test('errors are explicit', () => {
  assert.equal(run({ from: 'JPN', to: 'JPN' }).error, 'same-station');
  assert.equal(run({ time: '05:00' }).error, 'none-in-time');
});

test('plans are fast enough for an interactive app', () => {
  const t0 = performance.now();
  for (let i = 0; i < 20; i++) run({ from: 'WHTM', to: 'APTS', mode: 'after', time: '18:00' });
  assert.ok((performance.now() - t0) / 20 < 250);
});

test('leave now lists the next few departures, not just one (Yeshwantpur to KR Puram at 11:00)', () => {
  const r = run({ from: 'YPM', to: 'KRAM', mode: 'after', time: '11:00', priority: 'fast' });
  const firstTrains = new Set(r.options.map((o) => o.legs[0].dep));
  assert.ok(firstTrains.size >= 3, `only ${firstTrains.size} departures: ${r.options.map(route).join(' / ')}`);
  assert.equal(route(r.options[r.best]).split(' | ')[0].slice(0, 5), '11:04');
  // never "leave earlier only to wait longer"
  for (const o of r.options) assert.ok(!r.options.some((b) => b.dep > o.dep && b.arr <= o.arr && b.standMinutes <= o.standMinutes), route(o));
});

test('coach advice at Majestic from the Yeshwantpur side (mirrored estimate: rear)', () => {
  const r = run({ from: 'YPM', to: 'KRAM', mode: 'after', time: '11:00', priority: 'fast' });
  const ch = r.options[r.best].changes[0];
  assert.equal(ch.at, 'KGWA');
  assert.ok(ch.coaches.length > 0, 'no coach advice');
  assert.ok(ch.coaches.every((n) => n >= 4), `expected rear coaches, got ${ch.coaches}`);
  assert.equal(ch.known, false);
});

test('coach advice from JP Nagar stays front and known', () => {
  const ch = run({}).options[0].changes[0];
  assert.ok(ch.coaches.length > 0 && ch.coaches.every((n) => n <= 3), String(ch.coaches));
  assert.equal(ch.known, true);
});

test('last train at Majestic waits a few minutes for the connecting line (Mysore Road to Silk Institute)', () => {
  const held = run({ from: 'MYRD', to: 'APTS', mode: 'after', time: '22:30', priority: 'fast' });
  const strict = plan({ tt, req: { from: 'MYRD', to: 'APTS', date: TUESDAY, time: '22:30', mode: 'after', priority: 'fast' }, tuning: { ...DEFAULT_TUNING, lastTrainHold: 0 } });
  assert.ok(held.last && strict.last && held.last.dep > strict.last.dep, `held ${held.last?.dep} vs strict ${strict.last?.dep}`);
  const opt = held.options.find((o) => o.dep === held.last!.dep && o.arr === held.last!.arr);
  assert.ok(opt, 'last train is listed');
  assert.ok(opt!.changes.some((c) => c.held) && opt!.legs.some((l) => (l.held ?? 0) > 0 && l.held! <= 300));
});

test('daytime trains never wait for connections', () => {
  for (const o of run({ from: 'YPM', to: 'KRAM', mode: 'after', time: '11:00' }).options) assert.ok(!o.legs.some((l) => l.held));
  assert.equal(run({ from: 'YPM', to: 'KRAM', mode: 'after', time: '11:00' }).last, null);
});
