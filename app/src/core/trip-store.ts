/** Hands a chosen plan option to the trip screen without putting it in the URL. */
import type { PlanOption } from '@kmm/shared';

const trips = new Map<string, { option: PlanOption; day: number }>();
let seq = 0;

export function putTrip(option: PlanOption, day: number): string {
  const id = String(++seq);
  trips.set(id, { option, day });
  if (trips.size > 30) trips.delete(trips.keys().next().value!);
  return id;
}
export const getTrip = (id: string | undefined) => (id ? trips.get(id) ?? null : null);
