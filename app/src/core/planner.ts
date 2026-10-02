/**
 * Trip plans come from the server (the routing never ships in the app). Every answer is
 * cached on the phone, so a repeat request, like your daily commute, shows instantly and still
 * works underground with no signal. The saved commute is fetched ahead for the next days.
 */
import { useEffect, useRef, useState } from 'react';
import { ymd, type PlanRequest, type PlanResponse } from '@kmm/shared';
import type { Commute, Prefs } from './app-state';
import { PlanError, requestPlan } from './firebase';
import { load, save } from './storage';

const CACHE_KEY = 'plans';
const MAX_ENTRIES = 60;
type Cache = Record<string, { at: number; res: PlanResponse }>;

let memory: Cache | null = null;
const cache = (): Cache => (memory ??= load<Cache>(CACHE_KEY, {}));
const keyOf = (r: PlanRequest) => [r.from, r.to, r.date, r.time, r.mode, r.priority, r.pace ?? 'normal', r.women ? 1 : 0].join('|');

function remember(req: PlanRequest, res: PlanResponse) {
  const c = cache();
  c[keyOf(req)] = { at: Date.now(), res };
  const keys = Object.keys(c);
  if (keys.length > MAX_ENTRIES) keys.sort((a, b) => c[a].at - c[b].at).slice(0, keys.length - MAX_ENTRIES).forEach((k) => delete c[k]);
  save(CACHE_KEY, c);
}

export const cachedPlan = (req: PlanRequest): PlanResponse | null => cache()[keyOf(req)]?.res ?? null;

const inflight = new Map<string, Promise<PlanResponse>>();
export function fetchPlan(req: PlanRequest): Promise<PlanResponse> {
  const k = keyOf(req);
  let p = inflight.get(k);
  if (!p) {
    p = requestPlan(req).then((res) => { remember(req, res); return res; }).finally(() => inflight.delete(k));
    inflight.set(k, p);
  }
  return p;
}

export function buildRequest(c: Commute, date: Date, prefs: Prefs): PlanRequest {
  return { from: c.from, to: c.to, date: ymd(date), time: c.time, mode: c.mode, priority: c.priority, pace: prefs.pace, women: prefs.women };
}

export interface PlanState { data: PlanResponse | null; loading: boolean; error: PlanError | null; fromCache: boolean; retry: () => void }

/** Shows the cached answer immediately (if any) and refreshes it from the server. */
export function usePlan(req: PlanRequest | null): PlanState {
  const key = req ? keyOf(req) : '';
  const [state, setState] = useState<Omit<PlanState, 'retry'>>(() => {
    const hit = req ? cachedPlan(req) : null;
    return { data: hit, loading: !!req, error: null, fromCache: !!hit };
  });
  const [attempt, setAttempt] = useState(0);
  const reqRef = useRef(req);
  reqRef.current = req;

  useEffect(() => {
    const r = reqRef.current;
    if (!r) { setState({ data: null, loading: false, error: null, fromCache: false }); return; }
    let alive = true;
    const hit = cachedPlan(r);
    setState({ data: hit, loading: true, error: null, fromCache: !!hit });
    fetchPlan(r)
      .then((res) => alive && setState({ data: res, loading: false, error: null, fromCache: false }))
      .catch((e: PlanError) => alive && setState((s) => ({ ...s, loading: false, error: e })));
    return () => { alive = false; };
  }, [key, attempt]);

  return { ...state, retry: () => setAttempt((n) => n + 1) };
}

/** Fetch the commute for the next few working days in the background, for offline use. */
export async function prefetchCommute(c: Commute, prefs: Prefs, days = 5): Promise<{ date: Date; res: PlanResponse }[]> {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const jobs: Promise<{ date: Date; res: PlanResponse } | null>[] = [];
  let fetched = 0;
  for (let i = 0; i < 8 && fetched < days; i++) {
    const d = new Date(start); d.setDate(d.getDate() + i);
    if (d.getDay() === 0) continue;
    fetched++;
    const req = buildRequest(c, d, prefs);
    const hit = cache()[keyOf(req)];
    jobs.push(!hit || Date.now() - hit.at > 12 * 3600 * 1000
      ? fetchPlan(req).then((res) => ({ date: d, res })).catch(() => (hit ? { date: d, res: hit.res } : null))
      : Promise.resolve({ date: d, res: hit.res }));
  }
  return (await Promise.all(jobs)).filter((x): x is { date: Date; res: PlanResponse } => !!x);
}
