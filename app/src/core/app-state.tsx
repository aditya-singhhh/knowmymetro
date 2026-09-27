import { getLocales } from 'expo-localization';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';
import {
  LANGS, LOCALE, translate, type Lang, type Pace, type Priority, type StringKey, type TimeMode, type Timetable,
} from '@kmm/shared';
import { initFirebase, syncCommute, syncProfile } from './firebase';
import { load, save } from './storage';
import { checkForNewTimetable, loadTimetable } from './timetable';

export interface Commute { from: string; to: string; time: string; mode: TimeMode; priority: Priority }
export interface Prefs { women: boolean; pace: Pace }

interface AppCtx {
  tt: Timetable;
  lang: Lang; setLang: (l: Lang) => void;
  t: (k: StringKey, v?: Record<string, string | number>) => string;
  locale: string;
  prefs: Prefs; setPrefs: (p: Partial<Prefs>) => void;
  commute: Commute | null; setCommute: (c: Commute | null) => void;
  homeStation: string | null; setHomeStation: (s: string | null) => void;
  onboarded: boolean; finishOnboarding: () => void;
  timetableUpdated: boolean;
}

const Ctx = createContext<AppCtx | null>(null);

function deviceLang(): Lang {
  const code = getLocales()[0]?.languageCode ?? 'en';
  return (LANGS.find(([k]) => k === code)?.[0] ?? 'en') as Lang;
}

export function AppProvider({ children }: { children: ReactNode }) {
  // everything below is read synchronously so the first frame already has real data
  const [tt, setTT] = useState<Timetable>(loadTimetable);
  const [lang, setLangState] = useState<Lang>(() => load<Lang | null>('lang', null) ?? deviceLang());
  const [prefs, setPrefsState] = useState<Prefs>(() => load<Prefs>('prefs', { women: false, pace: 'normal' }));
  const [commute, setCommuteState] = useState<Commute | null>(() => load<Commute | null>('commute', null));
  const [homeStation, setHomeState] = useState<string | null>(() => load<string | null>('home', null));
  const [onboarded, setOnboarded] = useState<boolean>(() => load('onboarded', false));
  const [timetableUpdated, setTimetableUpdated] = useState(false);

  // sign in, then look for a newer timetable; repeat when the app comes back to the foreground
  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      await initFirebase();
      const next = await checkForNewTimetable(tt).catch(() => null);
      if (alive && next) { setTT(next); setTimetableUpdated(true); }
    };
    refresh();
    const sub = AppState.addEventListener('change', (s) => { if (s === 'active') refresh(); });
    return () => { alive = false; sub.remove(); };
  }, [tt]);

  const setLang = useCallback((l: Lang) => { setLangState(l); save('lang', l); syncProfile({ lang: l }); }, []);
  const setPrefs = useCallback((p: Partial<Prefs>) => {
    setPrefsState((old) => { const n = { ...old, ...p }; save('prefs', n); syncProfile(n); return n; });
  }, []);
  const setCommute = useCallback((c: Commute | null) => {
    setCommuteState(c); save('commute', c);
    if (c) { syncCommute({ ...c }); setHomeState((h) => { const n = h ?? c.from; save('home', n); return n; }); }
  }, []);
  const setHomeStation = useCallback((s: string | null) => { setHomeState(s); save('home', s); }, []);
  const finishOnboarding = useCallback(() => { setOnboarded(true); save('onboarded', true); }, []);
  const t = useCallback((k: StringKey, v?: Record<string, string | number>) => translate(lang, k, v), [lang]);

  const value = useMemo<AppCtx>(() => ({
    tt, lang, setLang, t, locale: LOCALE[lang], prefs, setPrefs, commute, setCommute, homeStation, setHomeStation,
    onboarded, finishOnboarding, timetableUpdated,
  }), [tt, lang, setLang, t, prefs, setPrefs, commute, setCommute, homeStation, setHomeStation, onboarded, finishOnboarding, timetableUpdated]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp must be used inside AppProvider');
  return v;
}

/** Current time that re-renders every 30 s (for countdowns). */
export function useNow(intervalMs = 30000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), intervalMs);
    const sub = AppState.addEventListener('change', (s) => { if (s === 'active') setNow(new Date()); });
    return () => { clearInterval(id); sub.remove(); };
  }, [intervalMs]);
  return now;
}
