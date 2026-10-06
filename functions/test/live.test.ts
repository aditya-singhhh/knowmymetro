import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LiveTracker, legPlan, serviceFor, type LiveStop, type PlanOption, type Timetable } from '@kmm/shared';
import { plan } from '../src/engine/plan';
import timetable from '../../data/timetable.json';

const tt = timetable as unknown as Timetable;
const TUESDAY = '20261006';
const service = serviceFor(tt, new Date(2026, 9, 6))!;
const trip = (): PlanOption => {
  const r = plan({ tt, req: { from: 'YPM', to: 'KRAM', date: TUESDAY, time: '11:00', mode: 'after', priority: 'fast' } });
  return r.options[r.best];
};
/** Where a train with these stops is at time t (straight lines between stations). */
function posAt(stops: LiveStop[], t: number): { lat: number; lon: number } {
  for (let k = 0; k < stops.length; k++) {
    const S = tt.stations[stops[k].stn];
    if (t <= stops[k].dep) return { lat: S.lat, lon: S.lon };
    const N = stops[k + 1];
    if (N && t < N.arr) {
      const f = (t - stops[k].dep) / (N.arr - stops[k].dep), B = tt.stations[N.stn];
      return { lat: S.lat + f * (B.lat - S.lat), lon: S.lon + f * (B.lon - S.lon) };
    }
  }
  const L = tt.stations[stops[stops.length - 1].stn];
  return { lat: L.lat, lon: L.lon };
}

test('every planned ride can be followed live', () => {
  const o = trip();
  for (const l of o.legs) assert.ok(legPlan(tt, service, l), `${l.from}>${l.to}`);
});

test('GPS on a train running 2 min late: delay and arrival', () => {
  const o = trip();
  const lt = new LiveTracker(tt, service, o.legs);
  const stops = lt.legs[0].stops;
  for (let t = stops[0].dep + 120; t < stops[0].dep + 600; t += 20) { const p = posAt(stops, t - 120); lt.fix(t, p.lat, p.lon, 15); }
  const st = lt.status(stops[0].dep + 600);
  assert.equal(st.phase, 'riding');
  assert.ok(Math.abs(st.delay - 120) < 25, `delay ${st.delay}`);
  const maj = st.etas.find((e) => e.stn === 'KGWA')!;
  assert.ok(Math.abs(maj.at - (stops[stops.length - 1].arr + 120)) < 25);
  assert.equal(st.action?.kind, 'change');
});

test('underground: motion stops alone keep the delay right', () => {
  const o = trip();
  const lt = new LiveTracker(tt, service, o.legs);
  const stops = lt.legs[0].stops;
  // train 90 s late; we only see it stopping at three stations
  for (const k of [1, 2, 3]) lt.stopped(stops[k].arr + 90);
  const st = lt.status(stops[3].arr + 100);
  assert.equal(st.source, 'motion');
  assert.ok(Math.abs(st.delay - 90) < 15, `delay ${st.delay}`);
});

test('boarded the next train by mistake: switches to it', () => {
  const o = trip();
  const lt = new LiveTracker(tt, service, o.legs);
  const planned = lt.legs[0];
  // the next Green train from Yeshwantpur to Majestic
  const next = plan({ tt, req: { from: 'YPM', to: 'KGWA', date: TUESDAY, time: '11:06', mode: 'after', priority: 'fast' } }).options[0].legs[0];
  const nstops = legPlan(tt, service, next)!.stops;
  assert.ok(nstops[0].dep > planned.stops[0].dep);
  for (let t = nstops[0].dep + 60; t < nstops[0].dep + 500; t += 20) { const p = posAt(nstops, t); lt.fix(t, p.lat, p.lon, 15); }
  const st = lt.status(nstops[0].dep + 500);
  assert.ok(st.switched);
  assert.ok(Math.abs(st.delay) < 60, `delay ${st.delay}`);
});

test('running late enough to miss the change: says so and gives the next train', () => {
  const o = trip();
  const lt = new LiveTracker(tt, service, o.legs);
  const stops = lt.legs[0].stops;
  const late = 8 * 60;
  for (let t = stops[0].dep + late + 120; t < stops[0].dep + late + 400; t += 20) { const p = posAt(stops, t - late); lt.fix(t, p.lat, p.lon, 15); }
  const st = lt.status(stops[0].dep + late + 400);
  assert.ok(st.missed, 'missed connection');
  assert.ok(st.missed!.next! > st.missed!.planned);
  assert.ok(st.arrival > o.arr);
});

test('before boarding, and arrival at the end', () => {
  const o = trip();
  const lt = new LiveTracker(tt, service, o.legs);
  const b = lt.status(o.dep - 300);
  assert.equal(b.phase, 'before');
  assert.equal(b.action?.kind, 'board');
  assert.ok(Math.abs(b.action!.inSec - 300) < 2);
  assert.equal(lt.status(o.arr + 60).phase, 'arrived');
});

test('GPS far from the line is ignored', () => {
  const o = trip();
  const lt = new LiveTracker(tt, service, o.legs);
  lt.fix(o.dep + 200, 12.95, 77.70, 10); // somewhere off the route
  const st = lt.status(o.dep + 200);
  assert.ok(st.offLine);
  assert.equal(st.source, 'timetable');
});

test('standing at the boarding station is not mistaken for the next stop', () => {
  const o = trip();
  const lt = new LiveTracker(tt, service, o.legs);
  const stops = lt.legs[0].stops;
  lt.stopped(stops[0].dep - 20);        // waiting on the train before it leaves
  lt.stopped(stops[1].arr + 30);        // first real stop, 30 s late
  const st = lt.status(stops[1].arr + 40);
  assert.ok(Math.abs(st.delay - 30) < 10, `delay ${st.delay}`);
});

test('watching a train before it reaches you: where it is and when it arrives', () => {
  const o = trip();
  const lt = new LiveTracker(tt, service, o.legs);
  const L = lt.legs[0];
  const st = lt.status(L.stops[0].dep - 150);           // 2.5 min before it reaches Yeshwantpur
  assert.equal(st.phase, 'before');
  assert.ok(st.train, 'train position');
  assert.ok(st.train!.stopsAway >= 1 && st.train!.stopsAway <= 3, `stops away ${st.train!.stopsAway}`);
  assert.ok(Math.abs(st.train!.reaches - L.stops[0].arr) < 2);
});

test('a rider report shifts the times; our own GPS wins over it', () => {
  const o = trip();
  const lt = new LiveTracker(tt, service, o.legs);
  const L = lt.legs[0];
  lt.external(240, 30, L.stops[0].dep - 300);
  let st = lt.status(L.stops[0].dep - 300);
  assert.equal(st.source, 'rider');
  assert.equal(st.delay, 240);
  assert.ok(Math.abs(st.train!.reaches - (L.stops[0].arr + 240)) < 2);
  // now our own GPS on the train (on time) — rider report must not override it
  const A = tt.stations[L.stops[1].stn];
  lt.fix(L.stops[1].arr + 5, A.lat, A.lon, 10);
  lt.external(240, 0, L.stops[1].arr + 20);
  st = lt.status(L.stops[1].arr + 20);
  assert.notEqual(st.source, 'rider');
});
