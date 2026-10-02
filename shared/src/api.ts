/** Contract between the app and the `plan` Cloud Function. */
import type { Leg, SeatClass } from './types';

export type TimeMode = 'by' | 'after';
export type Priority = 'fast' | 'long' | 'all';
export type Pace = 'fast' | 'normal' | 'slow';

export interface PlanRequest {
  from: string;
  to: string;
  date: string;       // YYYYMMDD, local Bengaluru date
  time: string;       // HH:MM
  mode: TimeMode;
  priority: Priority;
  pace?: Pace;
  women?: boolean;    // may use coach 1
}

export interface Change {
  kind: 'line' | 'wait' | 'reverse';  // line change, wait for a starting train, cross to the other platform
  at: string;
  available: number;  // seconds between trains
  walk: number;       // seconds needed
  tight: boolean;
  coaches: number[];  // coaches to board on the previous ride (1 = front); empty = any
  known: boolean;     // change time is measured, not a rough guess
  held?: boolean;     // the next train is the last one and waits for this connection
}

export interface PlanOption {
  legs: (Leg & { seat: SeatClass })[];
  changes: Change[];
  dep: number;
  arr: number;
  standMinutes: number;       // expected minutes standing
  seatAllTheWay: boolean;
  trick: { kind: 'wait' | 'reverse'; at: string } | null;
  fare: number | null;        // token fare, rupees
}

export interface PlanResponse {
  timetable: string;          // timetable version used
  service: string;
  best: number;               // index into options
  options: PlanOption[];
  fallback: null | { achieved: Priority; seatedArrival: number | null };
  tradeoff: null | { extraMinutes: number; standingSaved: number };
  /** late at night: the last departure that still gets you there (leave-now / leave-at only) */
  last?: { dep: number; arr: number } | null;
  error?: 'same-station' | 'no-route' | 'no-service' | 'none-in-time';
  earliestArrival?: number;
}
