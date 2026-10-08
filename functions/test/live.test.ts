import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LiveTracker, legPlan, serviceFor, type LiveStop, type PlanOption, type Timetable } from '@kmm/shared';
import { plan } from '../src/engine/plan';
import timetable from './fixtures/timetable-2026-08-17.json';

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

test('after a change, still on the platform when the planned train leaves: waits for the next one', () => {
  const o = trip();
  assert.ok(o.legs.length >= 2, 'trip has a change');
  const lt = new LiveTracker(tt, service, o.legs);
  lt.riding = true;
  const P = lt.legs[1].stops;
  // first ride on time (GPS), then nothing on the platform
  const G = lt.legs[0].stops;
  for (let t = G[0].dep + 60; t < G[G.length - 1].arr; t += 30) { const p = posAt(G, t); lt.fix(t, p.lat, p.lon, 15); }
  const st = lt.status(P[0].dep + 120);
  assert.equal(st.phase, 'changing');
  assert.ok(st.action && st.action.kind === 'change' && st.action.inSec > 0, 'shows when the next train leaves');
  assert.equal(st.switched, false);
  // boards that next train: GPS after it leaves puts us on it, without "different train"
  const next = P[0].dep + st.delay;
  for (let t = next + 90; t < next + 400; t += 20) { const p = posAt(P, t - st.delay); lt.fix(t, p.lat, p.lon, 15); }
  const r = lt.status(next + 400);
  assert.equal(r.phase, 'riding');
  assert.equal(r.switched, false);
  assert.ok(Math.abs(r.arrival - st.arrival) < 90, `arrival ${r.arrival} vs ${st.arrival}`);   // on the train it said we'd catch
});

test('watching (not riding) a train with a change follows the timetable', () => {
  const o = trip();
  const lt = new LiveTracker(tt, service, o.legs);
  const P = lt.legs[1].stops;
  assert.equal(lt.status(P[0].dep + 120).phase, 'riding');
});

test('one odd GPS fix far from the plan does not change the train', () => {
  const o = trip();
  const lt = new LiveTracker(tt, service, o.legs);
  const stops = lt.legs[0].stops;
  const start = lt.legs[0].start;
  for (let t = stops[0].dep + 60; t < stops[0].dep + 400; t += 20) { const p = posAt(stops, t); lt.fix(t, p.lat, p.lon, 15); }
  // one reading where the next train would be (as if 6 min behind)
  const t1 = stops[0].dep + 420, p1 = posAt(stops, t1 - 360); lt.fix(t1, p1.lat, p1.lon, 30);
  for (let t = t1 + 20; t < t1 + 200; t += 20) { const p = posAt(stops, t); lt.fix(t, p.lat, p.lon, 15); }
  const st = lt.status(t1 + 200);
  assert.equal(st.switched, false);
  assert.equal(lt.legs[0].start, start);
});

test('standing at a station longer than the timetable says: still "at" it, and later by that much', () => {
  const o = trip();
  const lt = new LiveTracker(tt, service, o.legs);
  const stops = lt.legs[0].stops;
  for (let t = stops[0].dep + 30; t < stops[2].arr; t += 20) { const p = posAt(stops, t); lt.fix(t, p.lat, p.lon, 15); }
  const S = tt.stations[stops[2].stn];
  for (let t = stops[2].arr; t <= stops[2].dep + 60; t += 10) lt.fix(t, S.lat + (t % 7) * 1e-6, S.lon, 15);   // real fixes wobble
  const st = lt.status(stops[2].dep + 60);
  assert.equal(st.next, stops[2].stn, 'at the station, not next one');
  assert.ok(st.delay >= 50, `delay ${st.delay}`);
});

test('a door tap on the platform after a change means boarding here, not a stop further on', () => {
  const o = trip();
  const lt = new LiveTracker(tt, service, o.legs);
  lt.riding = true;
  const G = lt.legs[0].stops, P = lt.legs[1].stops;
  for (let t = G[0].dep + 60; t < G[G.length - 1].arr; t += 30) { const p = posAt(G, t); lt.fix(t, p.lat, p.lon, 15); }
  const off = G[G.length - 1].arr + 10;
  lt.walking(off, true); lt.walking(off + 150, false);              // got off, walked to the other platform
  lt.status(off + 160);
  const dep = P[0].dep + lt.status(off + 170).delay;                // the train the app expects
  lt.stopped(dep - 40, true);                                       // doors of that train open here
  const st = lt.status(dep - 30);
  assert.equal(st.prev ?? st.next, P[0].stn, `shows ${st.phase} ${st.prev}/${st.next}`);
});

test('an early door tap while GPS still has us on the platform stays here and keeps the train on time', () => {
  // no walk felt (phone in hand), GPS on the new platform, a tap any time while waiting (8 Oct, Majestic: the card
  // jumped to KR Market, matching the tap to a train that had left before we got there)
  const o = trip();
  const make = () => {
    const lt = new LiveTracker(tt, service, o.legs);
    lt.riding = true;
    const G = lt.legs[0].stops;
    for (let t = G[0].dep + 60; t < G[G.length - 1].arr; t += 30) { const p = posAt(G, t); lt.fix(t, p.lat, p.lon, 15); }
    return lt;
  };
  const G = make().legs[0].stops, P = make().legs[1].stops;
  const s0 = tt.stations[P[0].stn];
  const off = G[G.length - 1].arr + 10;
  for (let tap = off + 130; tap <= off + 600; tap += 20) {
    const lt = make();
    lt.status(off + 30);
    for (let t = off + 60; t < tap; t += 20) lt.fix(t, s0.lat + ((t / 20) % 5) * 1e-6, s0.lon, 20);
    lt.stopped(tap, true);
    const st = lt.status(tap + 5);
    assert.equal(st.prev ?? st.next, P[0].stn, `tap +${tap - off}s shows ${st.phase} ${st.prev}/${st.next}`);
    assert.ok(st.delay >= 0, `tap +${tap - off}s delay ${st.delay}`);
  }
});
