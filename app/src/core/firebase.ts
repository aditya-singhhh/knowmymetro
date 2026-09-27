/**
 * Firebase wiring: App Check (so only the real app can call the planner), anonymous
 * sign-in, the `planTrip` function, and the rider's own data in Firestore.
 */
import { getApp } from '@react-native-firebase/app';
import { initializeAppCheck, ReactNativeFirebaseAppCheckProvider } from '@react-native-firebase/app-check';
import { getAuth, onAuthStateChanged, signInAnonymously, signOut } from '@react-native-firebase/auth';
import { getCrashlytics, recordError, setCrashlyticsCollectionEnabled } from '@react-native-firebase/crashlytics';
import { doc, getDoc, getFirestore, serverTimestamp, setDoc } from '@react-native-firebase/firestore';
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
