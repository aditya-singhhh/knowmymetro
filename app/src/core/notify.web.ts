/** Web preview: no phone notifications. */
import type { PlanOption, PlanResponse, Timetable } from '@kmm/shared';
export const allowNotifications = async () => false;
export function notifyNow(_tt: Timetable, _k: 'change' | 'getoff', _at: string, _o: PlanOption) { /* none on web */ }
export async function scheduleCommuteReminders(_tt: Timetable, _lead: number, _plans: { date: Date; res: PlanResponse }[]) { /* none on web */ }
