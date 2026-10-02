/**
 * The station the rider is probably standing at, for "leave now" planning.
 * Uses location only if the rider already allowed it (never asks here), prefers a recent
 * cached position so the answer is instant, and falls back to null.
 */
import * as Location from 'expo-location';
import { useEffect, useState } from 'react';
import { nearestStation, type Timetable } from '@kmm/shared';

let last: { code: string; at: number } | null = null;
const FRESH_MS = 3 * 60 * 1000;
const MAX_KM = 3; // further than this from any station: don't guess

function within(tt: Timetable, code: string, lat: number, lon: number) {
  const s = tt.stations[code];
  if (!s) return false;
  const dx = (s.lon - lon) * 111.32 * Math.cos((lat * Math.PI) / 180), dy = (s.lat - lat) * 110.54;
  return Math.sqrt(dx * dx + dy * dy) <= MAX_KM;
}

export async function stationHere(tt: Timetable): Promise<string | null> {
  if (last && Date.now() - last.at < FRESH_MS) return last.code;
  try {
    const perm = await Location.getForegroundPermissionsAsync();
    if (perm.status !== 'granted') return null;
    const quick = await Location.getLastKnownPositionAsync({ maxAge: FRESH_MS, requiredAccuracy: 1000 });
    const pos = quick ?? await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
    const code = nearestStation(tt, pos.coords.latitude, pos.coords.longitude);
    if (!code || !within(tt, code, pos.coords.latitude, pos.coords.longitude)) return null;
    last = { code, at: Date.now() };
    return code;
  } catch {
    return null;
  }
}

/** Nearest station (or null while unknown / not allowed), plus a way to ask for location from a button. */
export function useStationHere(tt: Timetable, refreshKey?: unknown): { code: string | null; allowed: boolean | null; ask: () => Promise<void> } {
  const [code, setCode] = useState<string | null>(() => (last && Date.now() - last.at < FRESH_MS ? last.code : null));
  const [allowed, setAllowed] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    Location.getForegroundPermissionsAsync().then((p) => alive && setAllowed(p.status === 'granted')).catch(() => undefined);
    stationHere(tt).then((c) => alive && c && setCode(c));
    return () => { alive = false; };
  }, [tt, refreshKey]);
  const ask = async () => {
    try {
      const p = await Location.requestForegroundPermissionsAsync();
      setAllowed(p.status === 'granted');
      if (p.status === 'granted') { last = null; const c = await stationHere(tt); if (c) setCode(c); }
    } catch { /* ignore */ }
  };
  return { code, allowed, ask };
}
