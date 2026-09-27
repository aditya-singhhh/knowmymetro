/**
 * Web preview build (shared demo link). The page can't reach our servers from where it is hosted,
 * so trips are planned in the page with the same engine and timetable, and nothing is saved online.
 */
import type { PlanRequest, PlanResponse, Timetable } from '@kmm/shared';
import { DEFAULT_TUNING, plan } from '../../../functions/src/engine/plan';
import bundled from '../../../data/timetable.json';

export const initFirebase = async (): Promise<string | null> => null;
export const currentUid = (): string | null => null;
export const onUser = (_cb: (uid: string | null) => void) => () => undefined;
export function reportError(e: unknown) { console.warn(e); }

export class PlanError extends Error {
  constructor(public kind: 'network' | 'server', message: string) { super(message); }
}

export async function requestPlan(req: PlanRequest): Promise<PlanResponse> {
  try {
    return plan({ tt: bundled as unknown as Timetable, req, tuning: DEFAULT_TUNING, interchanges: {}, crowd: {} });
  } catch (e) {
    throw new PlanError('server', String((e as Error)?.message ?? e));
  }
}

export const getPublishedTimetable = async (): Promise<{ version: string; url: string } | null> => null;
export const syncProfile = (_p: Record<string, unknown>) => Promise.resolve(false);
export const syncCommute = (_c: Record<string, unknown>) => Promise.resolve(false);
export const submitCrowdReport = (_r: { date: string; service: string; origin: string; start: string; board: string; level: 0 | 1 | 2 }) => Promise.resolve(false);
export const submitInterchange = (_k: string, _c: 'front' | 'middle' | 'rear' | null, _m: number) => Promise.resolve(false);
export const uploadRecording = (_r: { id: string; startedAt: number; endedAt: number | null; platform: string; samples: unknown[]; stopReason?: string }) => Promise.resolve(false);
