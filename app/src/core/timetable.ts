/**
 * Timetable loading and background updates.
 *
 * 1. On launch the app uses the newest timetable it has: a downloaded copy if present,
 *    otherwise the one bundled in the app. This is synchronous, so the first screen is instant.
 * 2. In the background it checks Firestore `timetable/current`. If a newer version was
 *    published, it downloads the file and uses it from then on.
 */
import { File, Paths } from 'expo-file-system';
import type { Timetable } from '@kmm/shared';
import bundled from '../../../data/timetable.json';
import { getPublishedTimetable } from './firebase';

const file = () => new File(Paths.document, 'timetable.json');

export function loadTimetable(): Timetable {
  const base = bundled as unknown as Timetable;
  try {
    const f = file();
    if (f.exists) {
      const cached = JSON.parse(f.textSync()) as Timetable;
      if (cached.version && cached.generatedAt >= base.generatedAt) return cached;
    }
  } catch {
    // corrupted download: fall back to the bundled copy
  }
  return base;
}

/** Returns the new timetable if one was downloaded, otherwise null. */
export async function checkForNewTimetable(current: Timetable): Promise<Timetable | null> {
  const published = await getPublishedTimetable();
  if (!published || published.version === current.version) return null;
  const res = await fetch(published.url);
  if (!res.ok) return null;
  const text = await res.text();
  const next = JSON.parse(text) as Timetable;
  if (!next.version || !next.patterns?.length) return null;
  file().write(text);
  return next;
}
