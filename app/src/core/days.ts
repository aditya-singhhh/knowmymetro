import { secondsNow } from '@kmm/shared';

/** Midnight of today + n days. */
export function dayFromToday(n: number): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + n);
  return d;
}

/** The next day the commute runs: today if it is still ahead, else the next day that is not Sunday. */
export function commuteDayOffset(time: string, now = new Date()): number {
  const [h, m] = time.split(':').map(Number);
  for (let i = 0; i < 8; i++) {
    const d = dayFromToday(i);
    if (d.getDay() === 0) continue;
    if (i === 0 && secondsNow(now) > h * 3600 + m * 60 - 20 * 60) continue;
    return i;
  }
  return 1;
}
