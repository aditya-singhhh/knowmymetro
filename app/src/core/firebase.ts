/**
 * Firebase wiring: App Check (so only the real app can call the planner), anonymous
 * sign-in, the `planTrip` function, and the rider's own data in Firestore.
 */
import { getApp } from '@react-native-firebase/app';
import { initializeAppCheck, ReactNativeFirebaseAppCheckProvider } from '@react-native-firebase/app-check';
import { getAuth, onAuthStateChanged, signInAnonymously, signOut } from '@react-native-firebase/auth';
import { getCrashlytics, recordError, setCrashlyticsCollectionEnabled } from '@react-native-firebase/crashlytics';
import { doc, getDoc, getFirestore, serverTimestamp, setDoc, writeBatch } from '@react-native-firebase/firestore';
import { connectFunctionsEmulator, getFunctions, httpsCallable } from '@react-native-firebase/functions';
import type { PlanRequest, PlanResponse } from '@kmm/shared';

const REGION = 'asia-south1';
const USE_EMULATOR = process.env.EXPO_PUBLIC_USE_EMULATOR === '1';

let ready: Promise<string | null> | null = null;

/** Starts App Check and signs the rider in anonymously. Safe to call many times. */
export function initFirebase(): Promise<string | null> {
  ready ??= (async () => {
    try {
      const provider = new ReactNativeFirebaseAppCheckProvider();
      provider.configure({
        android: { provider: __DEV__ ? 'debug' : 'playIntegrity', debugToken: process.env.EXPO_PUBLIC_APPCHECK_DEBUG_TOKEN },
        apple: { provider: __DEV__ ? 'debug' : 'appAttestWithDeviceCheckFallback', debugToken: process.env.EXPO_PUBLIC_APPCHECK_DEBUG_TOKEN },
      });
      initializeAppCheck(getApp(), { provider, isTokenAutoRefreshEnabled: true });
      await setCrashlyticsCollectionEnabled(getCrashlytics(), !__DEV__);
      if (USE_EMULATOR) connectFunctionsEmulator(getFunctions(getApp(), REGION), 'localhost', 5001);
      const auth = getAuth();
      if (!auth.currentUser) await signInAnonymously(auth);
      return auth.currentUser?.uid ?? null;
    } catch (e) {
      reportError(e);
      return null;
    }
  })();
  return ready;
}

export const currentUid = () => { try { return getAuth().currentUser?.uid ?? null; } catch { return null; } };

/**
 * Signed-in anonymous rider id. Firebase deletes anonymous accounts older than 30 days
 * (automatic clean-up), so this signs in again whenever the account is gone.
 */
async function ensureUser(): Promise<string | null> {
  await initFirebase();
  try {
    const auth = getAuth();
    if (!auth.currentUser) await signInAnonymously(auth);
    return auth.currentUser?.uid ?? null;
  } catch (e) { reportError(e); return null; }
}

/** Runs a write as the current rider; if the account was cleaned up, signs in fresh and retries once. */
async function asUser(write: (uid: string) => Promise<unknown>): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const uid = await ensureUser();
    if (!uid) return false;
    try { await write(uid); return true; } catch (e) {
      const code = String((e as { code?: string })?.code ?? '');
      if (attempt === 0 && (code.includes('unauthenticated') || code.includes('permission-denied') || code.includes('user-not-found') || code.includes('user-token-expired'))) {
        try { await signOut(getAuth()); } catch { /* ignore */ }
        continue;
      }
      reportError(e);
      return false;
    }
  }
  return false;
}
export const onUser = (cb: (uid: string | null) => void) => onAuthStateChanged(getAuth(), (u) => cb(u?.uid ?? null));

export function reportError(e: unknown) {
  try { recordError(getCrashlytics(), e instanceof Error ? e : new Error(String(e))); } catch { /* ignore */ }
}

/* ---------------- planner ---------------- */
export class PlanError extends Error {
  constructor(public kind: 'network' | 'server', message: string) { super(message); }
}

export async function requestPlan(req: PlanRequest): Promise<PlanResponse> {
  await initFirebase();
  try {
    const call = httpsCallable<PlanRequest, PlanResponse>(getFunctions(getApp(), REGION), 'planTrip', { timeout: 15000 });
    const res = await call(req);
    return res.data;
  } catch (e: unknown) {
    const code = (e as { code?: string })?.code ?? '';
    throw new PlanError(code.includes('unavailable') || code.includes('deadline') || code.includes('internal') ? 'network' : 'server', String((e as Error)?.message ?? e));
  }
}

/* ---------------- timetable ---------------- */
export async function getPublishedTimetable(): Promise<{ version: string; url: string } | null> {
  try {
    const snap = await getDoc(doc(getFirestore(), 'timetable/current'));
    const data = snap.data() as { version?: string; path?: string } | undefined;
    const bucket = getApp().options.storageBucket;
    if (!data?.version || !data.path || !bucket) return null;
    return { version: data.version, url: `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/${encodeURIComponent(data.path)}?alt=media` };
  } catch {
    return null;
  }
}

/* ---------------- rider data ---------------- */
export function syncProfile(profile: Record<string, unknown>) {
  return asUser((uid) => setDoc(doc(getFirestore(), `users/${uid}`), { ...profile, updatedAt: serverTimestamp() }, { merge: true }));
}

export function syncCommute(commute: Record<string, unknown>) {
  return asUser((uid) => setDoc(doc(getFirestore(), `users/${uid}/trips/commute`), { ...commute, updatedAt: serverTimestamp() }, { merge: true }));
}

/** One-tap crowd report: 0 got a seat, 1 standing, 2 packed. */
export function submitCrowdReport(r: { date: string; service: string; origin: string; start: string; board: string; level: 0 | 1 | 2 }) {
  return asUser((uid) => setDoc(doc(getFirestore(), `reports/${uid}_${r.date}_${r.origin}${r.start.replace(':', '')}${r.board}`),
    { uid, service: r.service, origin: r.origin, start: r.start, board: r.board, level: r.level, createdAt: serverTimestamp() }));
}

export function submitInterchange(key: string, coach: 'front' | 'middle' | 'rear' | null, minutes: number) {
  return asUser((uid) => setDoc(doc(getFirestore(), `interchangeReports/${uid}_${Date.now()}`), { uid, key, coach, minutes, createdAt: serverTimestamp() }));
}

/**
 * Trip recorder upload: one summary document plus size-limited chunks
 * (recordings/{uid_id} and recordings/{uid_id}/chunks/{n}). Create-only for the owner.
 */
export function uploadRecording(rec: { id: string; startedAt: number; endedAt: number | null; platform: string; samples: unknown[]; stopReason?: string; trip?: unknown }) {
  return asUser(async (uid) => {
    const db = getFirestore();
    const recId = `${uid}_${rec.id}`;
    // Firestore documents are limited to 1 MB: split by size (~350 KB per chunk)
    const chunks: unknown[][] = [];
    let cur: unknown[] = [], size = 0;
    for (const s of rec.samples) {
      const n = JSON.stringify(s).length;
      if (size + n > 350_000 && cur.length) { chunks.push(cur); cur = []; size = 0; }
      cur.push(s); size += n;
    }
    if (cur.length) chunks.push(cur);
    const kinds: Record<string, number> = {};
    for (const s of rec.samples as { k: string }[]) kinds[s.k] = (kinds[s.k] ?? 0) + 1;
    // chunks first, summary last: a summary means the upload is complete
    for (let i = 0; i < chunks.length; i += 5) {
      const batch = writeBatch(db);
      for (let n = i; n < Math.min(chunks.length, i + 5); n++) batch.set(doc(db, `recordings/${recId}/chunks/${n}`), { uid, n, samples: chunks[n] });
      await batch.commit();
    }
    await setDoc(doc(db, `recordings/${recId}`), {
      uid, startedAt: rec.startedAt, endedAt: rec.endedAt, platform: rec.platform, samples: rec.samples.length, chunks: chunks.length, kinds,
      stopReason: rec.stopReason ?? 'user', ...(rec.trip ? { trip: rec.trip } : {}), createdAt: serverTimestamp(),
    });
  });
}

/* ---------------- live delays shared between riders ---------------- */
/**
 * trainLive/{YYYYMMDD_origin_start} = { line, delay (s), at (s after midnight), uid, updatedAt }
 * Written by riders following that train live; read by anyone planning a trip on it.
 */
export const trainKey = (date: string, origin: string, start: number) => `${date}_${origin}_${start}`;

export function shareTrainDelay(d: { date: string; origin: string; start: number; line: string; delay: number; at: number }) {
  // latest value (what other riders read) + an append-only log (for delay history and later analysis)
  return asUser(async (uid) => {
    const db = getFirestore(), key = trainKey(d.date, d.origin, d.start);
    const batch = writeBatch(db);
    batch.set(doc(db, `trainLive/${key}`), { line: d.line, delay: Math.round(d.delay), at: Math.round(d.at), uid, updatedAt: serverTimestamp() });
    batch.set(doc(db, `trainLive/${key}/log/${uid}_${Math.round(d.at)}`), { delay: Math.round(d.delay), at: Math.round(d.at), uid, updatedAt: serverTimestamp() });
    await batch.commit();
  });
}

const liveCache = new Map<string, { at: number; v: { delay: number; at: number } | null }>();
/** Latest rider-measured delay for a train, if someone reported it in the last 10 minutes. */
export async function getTrainDelay(date: string, origin: string, start: number): Promise<{ delay: number; at: number } | null> {
  const k = trainKey(date, origin, start);
  const hit = liveCache.get(k);
  if (hit && Date.now() - hit.at < 45000) return hit.v;
  try {
    const snap = await getDoc(doc(getFirestore(), `trainLive/${k}`));
    const data = snap.data() as { delay?: number; at?: number; updatedAt?: { toMillis(): number } } | undefined;
    const fresh = data?.updatedAt && Date.now() - data.updatedAt.toMillis() < 10 * 60 * 1000;
    const v = fresh && typeof data?.delay === 'number' ? { delay: data.delay, at: data.at ?? 0 } : null;
    liveCache.set(k, { at: Date.now(), v });
    return v;
  } catch { return null; }
}

/** shares/{token}: snapshot of a live trip for the share link (see share-live.ts). */
export function shareSnapshot(token: string, data: Record<string, unknown>) {
  return asUser((uid) => setDoc(doc(getFirestore(), `shares/${token}`), { ...data, uid, updatedAt: serverTimestamp() }));
}
