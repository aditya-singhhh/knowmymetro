import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmt, type Timetable } from '@kmm/shared';
import { plan } from '../src/engine/plan';
import { build } from '../src/timetable/own';
import { resolve } from 'node:path';

const { tt } = build(resolve(__dirname, '../../data/timetable'));
const TUESDAY = '20261006';

test('own timetable plans the 6 Oct ride with the trains that really ran', () => {
  const r = plan({ tt: tt as Timetable, req: { from: 'VWIA', to: 'BSNK', date: TUESDAY, time: '18:52', mode: 'after', priority: 'all' } });
  const green = r.options.flatMap((o) => o.legs).filter((l) => l.line === 'GREEN').map((l) => fmt(l.dep));
  assert.ok(green.includes('19:34'), `Green from Majestic: ${green.join(', ')}`);
});

test('own timetable has every Silk Institute departure from the board', () => {
  const p = tt.patterns.findIndex((x) => x.line === 'GREEN' && x.stops[0] === 'APTS' && x.stops.at(-1) === 'BIET');
  const starts = tt.departures.weekday.filter(([i]) => i === p).map(([, t]) => fmt(t));
  for (const t of ['05:00', '11:16', '12:01', '17:09', '20:37', '23:05']) assert.ok(starts.includes(t), t);
});
