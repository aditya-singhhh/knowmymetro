/** Turn a row of a station's departure board into a trip, so tapping any train opens it (and tracks it). */
import { tokenFare, type Departure, type PlanOption, type Timetable } from '@kmm/shared';

export function tripFromDeparture(tt: Timetable, row: Departure, work: boolean): PlanOption {
  const p = tt.patterns[row.pattern];
  const last = p.stops.length - 1;
  const t0 = row.dep - p.dep[row.before];
  const from = p.stops[row.before], to = p.stops[last];
  const arr = t0 + p.arr[last];
  return {
    legs: [{ line: row.line, from, to, dep: row.dep, arr, origin: row.origin, start: t0, terminus: row.terminus, before: row.before,
      stops: last - row.before, frac: row.frac, work, dir: row.dir, platform: row.platform, seat: row.seat }],
    changes: [], dep: row.dep, arr, standMinutes: 0, seatAllTheWay: row.seat >= 2, trick: null, fare: tokenFare(tt, from, to),
  };
}
