/**
 * Summary of recent trip recordings, for tuning the motion/live logic.
 * Writes reports/recordings.md and reports/series/<n>.csv (time series without any location).
 *   GOOGLE_APPLICATION_CREDENTIALS=sa.json npx tsx tools/recordings-report.ts [limit]
 */
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { mkdirSync, writeFileSync } from 'node:fs';

initializeApp();
const db = getFirestore();
const LIMIT = Number(process.argv[2] ?? 20);

type S = Record<string, any>;
const pct = (xs: number[], p: number) => { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const r1 = (x: number) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : '—');
const ist = (ms: number) => new Date(ms + 5.5 * 3600e3).toISOString().slice(0, 16).replace('T', ' ');

async function main() {
  const snap = await db.collection('recordings').orderBy('createdAt', 'desc').limit(LIMIT).get();
  mkdirSync('reports/series', { recursive: true });
  const out: string[] = [`# Recordings (latest ${snap.size})`, ''];
  let n = 0;
  for (const d of snap.docs) {
    n++;
    const m = d.data();
    const chunks = await d.ref.collection('chunks').orderBy('n').get();
    const samples: S[] = chunks.docs.flatMap((c) => c.get('samples') ?? []).sort((a: S, b: S) => a.t - b.t);
    const by = (k: string) => samples.filter((s) => s.k === k);
    const gps = by('gps'), cell = by('cell'), dm = by('dm'), mot = by('mot'), evt = by('evt'), mark = by('mark'), bar = by('bar');
    const dur = ((m.endedAt ?? samples.at(-1)?.t ?? m.startedAt) - m.startedAt) / 60000;

    // GPS coverage
    const acc = gps.map((g) => g.acc).filter((x) => x != null);
    let maxGap = 0; for (let i = 1; i < gps.length; i++) maxGap = Math.max(maxGap, (gps[i].t - gps[i - 1].t) / 1000);
    const minutesWithFix = new Set(gps.map((g) => Math.floor((g.t - m.startedAt) / 60000))).size;

    // towers by operator
    const ops: Record<string, Set<string>> = {}; const types: Record<string, number> = {};
    for (const c of cell) for (const x of c.c ?? []) {
      const op = `${x.mcc ?? '?'}-${x.mnc ?? '?'}`; (ops[op] ||= new Set()).add(`${x.tac}-${x.ci}`); types[x.type] = (types[x.type] ?? 0) + 1;
    }

    // motion states and speed vs GPS speed
    const states: Record<string, number> = {}; for (const s of dm) states[s.s] = (states[s.s] ?? 0) + 1;
    const nullKmh = dm.filter((s) => s.kmh == null).length;
    const pairs: { gps: number; mot: number }[] = [];
    let j = 0;
    for (const g of gps) {
      if (g.spd == null || g.spd < 0 || (g.acc ?? 999) > 50) continue;
      while (j + 1 < dm.length && Math.abs(dm[j + 1].t - g.t) <= Math.abs(dm[j].t - g.t)) j++;
      const s = dm[j]; if (!s || Math.abs(s.t - g.t) > 1500 || s.kmh == null) continue;
      pairs.push({ gps: g.spd * 3.6, mot: s.kmh });
    }
    const err = pairs.map((p) => p.mot - p.gps);
    // state vs GPS truth
    const truth = { movingButStopped: 0, moving: 0, stillButMoving: 0, still: 0 };
    j = 0;
    for (const g of gps) {
      if (g.spd == null || (g.acc ?? 999) > 50) continue;
      while (j + 1 < dm.length && Math.abs(dm[j + 1].t - g.t) <= Math.abs(dm[j].t - g.t)) j++;
      const s = dm[j]; if (!s || Math.abs(s.t - g.t) > 1500) continue;
      const kmh = g.spd * 3.6;
      if (kmh > 20) { truth.moving++; if (s.s === 'stopped') truth.movingButStopped++; }
      if (kmh < 1) { truth.still++; if (s.s === 'starting' || s.s === 'braking') truth.stillButMoving++; }
    }
    const hMoving = dm.filter((s) => s.s !== 'hand').map((s) => s.h);
    const jAll = dm.map((s) => s.j), rAll = dm.map((s) => s.r);
    const stopsEvt = evt.filter((e) => e.e === 'train_stopped').length;
    // GPS-based stops: speed < 1 km/h for >= 15 s after moving > 20 km/h
    let gpsStops = 0, still = 0, wasMoving = false;
    for (let i = 1; i < gps.length; i++) {
      const g = gps[i]; if (g.spd == null) continue;
      const kmh = g.spd * 3.6;
      if (kmh > 20) { wasMoving = true; still = 0; }
      else if (kmh < 1 && wasMoving) { still += (g.t - gps[i - 1].t) / 1000; if (still >= 15) { gpsStops++; wasMoving = false; still = 0; } }
    }

    out.push(`## ${n}. ${ist(m.startedAt)} IST · ${r1(dur)} min · stop: ${m.stopReason ?? '—'} · ${m.platform}${m.trip ? ` · live trip ${m.trip.legs.map((l: S) => `${l.from}>${l.to}`).join(', ')}` : ''}`,
      `- samples: ${samples.length} (${Object.entries({ gps: gps.length, cell: cell.length, dm: dm.length, mot: mot.length, evt: evt.length, mark: mark.length, bar: bar.length }).map(([k, v]) => `${k} ${v}`).join(', ')})`,
      `- GPS: median accuracy ${r1(pct(acc, 0.5))} m, p90 ${r1(pct(acc, 0.9))} m, longest gap ${r1(maxGap)} s, minutes with a fix ${minutesWithFix}/${Math.ceil(dur)}`,
      `- towers: ${Object.entries(ops).map(([op, s]) => `${op}: ${s.size}`).join(', ') || 'none'} · types ${JSON.stringify(types)}`,
      `- motion states (s): ${JSON.stringify(states)} · speed unknown ${dm.length ? Math.round(100 * nullKmh / dm.length) : '—'}%`,
      `- motion speed vs GPS speed: ${pairs.length} pairs, mean error ${r1(err.reduce((a, b) => a + b, 0) / (err.length || 1))} km/h, median |error| ${r1(pct(err.map(Math.abs), 0.5))}, p90 |error| ${r1(pct(err.map(Math.abs), 0.9))}`,
      `- state vs GPS: moving>20km/h ${truth.moving}s of which "stopped" ${truth.movingButStopped}; still<1km/h ${truth.still}s of which "speeding up/braking" ${truth.stillButMoving}`,
      `- level push h p50/p90/p99: ${r1(pct(hMoving, 0.5))}/${r1(pct(hMoving, 0.9))}/${r1(pct(hMoving, 0.99))} · shake j p50/p90: ${r1(pct(jAll, 0.5))}/${r1(pct(jAll, 0.9))} · turning r p50/p90: ${r1(pct(rAll, 0.5))}/${r1(pct(rAll, 0.9))}`,
      `- stops: motion detected ${stopsEvt}, GPS shows ${gpsStops}, doors tapped ${mark.length}`, '');

    // time series without location: t (s from start), gps speed, accuracy, motion fields
    const rows = ['t,src,gps_kmh,acc,h,v,j,r,state,mot_kmh,a_x,a_y,a_z,g_x,g_y,g_z,event'];
    for (const s of samples) {
      const t = ((s.t - m.startedAt) / 1000).toFixed(1);
      if (s.k === 'gps') rows.push(`${t},gps,${s.spd != null ? (s.spd * 3.6).toFixed(1) : ''},${s.acc != null ? Math.round(s.acc) : ''},,,,,,,,,,,,,`);
      else if (s.k === 'dm') rows.push(`${t},dm,,,${s.h},${s.v},${s.j},${s.r},${s.s},${s.kmh ?? ''},${s.a.join(',')},${s.g.join(',')},`);
      else if (s.k === 'evt' || s.k === 'mark') rows.push(`${t},${s.k},,,,,,,,,,,,,,,${s.e ?? 'doors'}`);
    }
    writeFileSync(`reports/series/${n}.csv`, rows.join('\n'));
  }
  writeFileSync('reports/recordings.md', out.join('\n'));
  console.log(`report: ${n} recordings`);
}
main().catch((e) => { console.error(e); process.exit(1); });
