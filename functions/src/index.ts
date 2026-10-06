/**
 * KnowMyMetro Cloud Functions (region asia-south1, Mumbai).
 *
 *   plan               callable, App Check enforced: journey planning (the routing never ships in the app)
 *   syncTimetable      daily: publish our own timetable (data/timetable/ + observations, bundled at deploy) if it changed
 *   crunchCrowd        nightly: rider crowd reports -> seat chance per train
 *   crunchInterchanges nightly: rider change-time reports -> quickest coach per change
 */
import { initializeApp } from 'firebase-admin/app';
import { FieldValue, getFirestore, Timestamp } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { defineBoolean, defineInt } from 'firebase-functions/params';
import { HttpsError, onCall, onRequest } from 'firebase-functions/https';
import * as logger from 'firebase-functions/logger';
import { setGlobalOptions } from 'firebase-functions/options';
import { onSchedule } from 'firebase-functions/scheduler';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PlanRequest, PlanResponse, Timetable } from '@kmm/shared';
import { DEFAULT_TUNING, plan, type CrowdTable, type InterchangeInfo, type Tuning } from './engine/plan';

initializeApp();
setGlobalOptions({ region: 'asia-south1', maxInstances: 20 });
const db = getFirestore();

/** Instances kept warm. 0 = free when idle (a cold start adds ~1-2 s); set to 1 after launch for instant plans (~₹500-1,000/month). */
const PLAN_MIN_INSTANCES = defineInt('PLAN_MIN_INSTANCES', { default: 0 });
/** App Check is on by default; switch off only for local emulator runs. */
const ENFORCE_APP_CHECK = defineBoolean('ENFORCE_APP_CHECK', { default: true });

const TIMETABLE_OBJECT = 'timetable/current.json';

/* ------------------------------------------------------------------ caches */
interface Cache { tt: Timetable; tuning: Tuning; interchanges: Record<string, InterchangeInfo>; crowd: CrowdTable; loadedAt: number }
let cache: Cache | null = null;
let loading: Promise<Cache> | null = null;
const CACHE_MS = 10 * 60 * 1000;

const bundledTimetable = (): Timetable => JSON.parse(readFileSync(join(__dirname, 'timetable.json'), 'utf8'));

async function loadCache(): Promise<Cache> {
  const [metaSnap, tuningSnap, interSnap, crowdSnap] = await Promise.all([
    db.doc('timetable/current').get(), db.doc('config/tuning').get(), db.collection('interchanges').get(), db.collection('crowdStats').get(),
  ]);
  let tt = cache?.tt ?? bundledTimetable();
  const published = metaSnap.get('version') as string | undefined;
  if (published && published !== tt.version) {
    try {
      const [buf] = await getStorage().bucket().file(TIMETABLE_OBJECT).download();
      tt = JSON.parse(buf.toString('utf8'));
    } catch (e) { logger.warn('Could not load published timetable, using bundled copy', e); }
  }
  const interchanges: Record<string, InterchangeInfo> = {};
  interSnap.forEach((d) => { const v = d.data(); if (v.n >= 3) interchanges[d.id] = { coach: v.coach ?? null, best: v.best }; });
  const crowd: CrowdTable = {};
  crowdSnap.forEach((d) => Object.assign(crowd, d.get('trains') ?? {}));
  return { tt, tuning: { ...DEFAULT_TUNING, ...(tuningSnap.data() ?? {}) }, interchanges, crowd, loadedAt: Date.now() };
}
async function getCache(): Promise<Cache> {
  if (cache && Date.now() - cache.loadedAt < CACHE_MS) return cache;
  loading ??= loadCache().then((c) => (cache = c)).finally(() => { loading = null; });
  return cache ?? loading; // serve stale data while refreshing
}

/* ------------------------------------------------------------------ plan */
const CODE = /^[A-Z]{2,5}$/;
function validate(d: unknown): PlanRequest {
  const r = d as Partial<PlanRequest>;
  const bad = (m: string) => { throw new HttpsError('invalid-argument', m); };
  if (!r || typeof r !== 'object') bad('Missing request');
  if (!CODE.test(r.from ?? '') || !CODE.test(r.to ?? '')) bad('from/to must be station codes');
  if (!/^\d{8}$/.test(r.date ?? '')) bad('date must be YYYYMMDD');
  if (!/^\d{2}:\d{2}$/.test(r.time ?? '')) bad('time must be HH:MM');
  if (r.mode !== 'by' && r.mode !== 'after') bad('mode must be by|after');
  if (!['fast', 'long', 'all'].includes(r.priority ?? '')) bad('priority must be fast|long|all');
  if (r.pace && !['fast', 'normal', 'slow'].includes(r.pace)) bad('pace must be fast|normal|slow');
  return { from: r.from!, to: r.to!, date: r.date!, time: r.time!, mode: r.mode!, priority: r.priority!, pace: r.pace ?? 'normal', women: !!r.women };
}

export const planTrip = onCall(
  { enforceAppCheck: ENFORCE_APP_CHECK, minInstances: PLAN_MIN_INSTANCES, memory: '512MiB', concurrency: 40, cors: false, invoker: 'public' },
  async (request): Promise<PlanResponse> => {
    const req = validate(request.data);
    const c = await getCache();
    return plan({ tt: c.tt, req, tuning: c.tuning, interchanges: c.interchanges, crowd: c.crowd });
  },
);

/* ------------------------------------------------------------------ timetable sync */
export const syncTimetable = onSchedule({ schedule: 'every day 03:30', timeZone: 'Asia/Kolkata', memory: '1GiB', timeoutSeconds: 300 }, async () => {
  // Our own timetable, compiled from data/timetable/ (base feed + rider observations) by `npm run own` and bundled at deploy.
  const tt = bundledTimetable();
  const meta = db.doc('timetable/current');
  if ((await meta.get()).get('version') === tt.version) { logger.info(`Timetable unchanged (${tt.version})`); return; }
  const json = JSON.stringify(tt);
  await getStorage().bucket().file(TIMETABLE_OBJECT).save(json, { contentType: 'application/json', resumable: false, metadata: { cacheControl: 'public, max-age=300' } });
  await getStorage().bucket().file(`timetable/${tt.version}.json`).save(json, { contentType: 'application/json', resumable: false, metadata: { cacheControl: 'public, max-age=31536000, immutable' } });
  await meta.set({ version: tt.version, path: `timetable/${tt.version}.json`, feed: tt.feed, bytes: json.length, publishedAt: FieldValue.serverTimestamp() });
  cache = null;
  logger.info(`Published timetable ${tt.version}`);
});

/* ------------------------------------------------------------------ crowd reports */
/**
 * reports/{uid_date_trainKey} = { uid, service, origin, start: 'HH:MM', board, level: 0|1|2, createdAt }
 *   level 0 = got a seat, 1 = standing, 2 = packed
 * crowdStats/{service}.trains[`${service}|${origin}|${start}|${board}`] = { p, n }
 */
export const crunchCrowd = onSchedule({ schedule: 'every day 02:30', timeZone: 'Asia/Kolkata', memory: '512MiB', timeoutSeconds: 300 }, async () => {
  const since = Timestamp.fromMillis(Date.now() - 42 * 86400 * 1000);
  const snap = await db.collection('reports').where('createdAt', '>=', since).get();
  const acc: Record<string, Record<string, { seat: number; n: number }>> = {};
  snap.forEach((d) => {
    const r = d.data();
    const key = `${r.service}|${r.origin}|${r.start}|${r.board}`;
    const ageDays = (Date.now() - r.createdAt.toMillis()) / 86400000;
    const w = Math.pow(0.5, ageDays / 14);           // recent weeks count more
    const cell = ((acc[r.service] ||= {})[key] ||= { seat: 0, n: 0 });
    cell.seat += (r.level === 0 ? 1 : 0) * w; cell.n += w;
  });
  const batch = db.batch();
  for (const [service, trains] of Object.entries(acc)) {
    const out: CrowdTable = {};
    for (const [k, v] of Object.entries(trains)) out[k] = { p: Math.round((v.seat / v.n) * 100) / 100, n: Math.round(v.n * 10) / 10 };
    batch.set(db.doc(`crowdStats/${service}`), { trains: out, updatedAt: FieldValue.serverTimestamp() });
  }
  await batch.commit();
  cache = null;
  logger.info(`Crowd stats from ${snap.size} reports`);
});

/**
 * interchangeReports/{id} = { uid, key: 'KGWA|GREEN1>PURPLE', coach: 'front'|'middle'|'rear'|null, minutes, createdAt }
 * interchanges/{key} = { coach, best, n }
 */
export const crunchInterchanges = onSchedule({ schedule: 'every day 02:45', timeZone: 'Asia/Kolkata' }, async () => {
  const snap = await db.collection('interchangeReports').where('createdAt', '>=', Timestamp.fromMillis(Date.now() - 180 * 86400 * 1000)).get();
  const acc: Record<string, { votes: Record<string, number>; mins: number[] }> = {};
  snap.forEach((d) => {
    const r = d.data();
    const a = (acc[r.key] ||= { votes: {}, mins: [] });
    if (r.coach) a.votes[r.coach] = (a.votes[r.coach] ?? 0) + 1;
    if (typeof r.minutes === 'number' && r.minutes > 0 && r.minutes < 20) a.mins.push(r.minutes);
  });
  const batch = db.batch();
  for (const [key, a] of Object.entries(acc)) {
    const coach = Object.entries(a.votes).sort((x, y) => y[1] - x[1])[0]?.[0] ?? null;
    const sorted = a.mins.sort((x, y) => x - y), median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 4;
    batch.set(db.doc(`interchanges/${key.replace(/\//g, '_')}`), { coach, best: median, n: a.mins.length, updatedAt: FieldValue.serverTimestamp() });
  }
  await batch.commit();
  cache = null;
});

/* ------------------------------------------------------------------ shared live trips */
/**
 * shares/{token} is written by a rider's app while they share a live trip (see app/src/core/share-live.ts).
 * The web page /t/{token} (hosting, web/share.html) reads it through this endpoint, so the page needs
 * no keys and only someone with the link can see the trip. Stale shares (6 h) are treated as ended.
 */
export const shareView = onRequest({ cors: true, invoker: 'public', memory: '256MiB', maxInstances: 5 }, async (req, res) => {
  const token = (req.path.split('/').filter(Boolean).pop() ?? '').trim();
  res.set('Cache-Control', 'no-store');
  if (!/^[A-Za-z0-9]{20,40}$/.test(token)) { res.status(400).json({ error: 'bad-link' }); return; }
  const snap = await db.doc(`shares/${token}`).get();
  if (!snap.exists) { res.status(404).json({ error: 'not-found' }); return; }
  const d = snap.data()!;
  const updated = (d.updatedAt as Timestamp | undefined)?.toMillis() ?? 0;
  const { uid: _uid, ...pub } = d;
  res.json({ ...pub, updatedAt: updated, ended: !!d.ended || Date.now() - updated > 6 * 3600 * 1000 });
});
