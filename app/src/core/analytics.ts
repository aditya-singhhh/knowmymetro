/**
 * Product analytics (Firebase Analytics). Anonymous: station codes, times and choices only.
 * No names, phone numbers or locations are ever logged.
 */
import { getAnalytics, logEvent, logScreenView, setUserProperty } from '@react-native-firebase/analytics';

type Params = Record<string, string | number | boolean | undefined>;

export type AppEvent =
  | 'plan_search'        // from, to, mode, priority, time
  | 'plan_result'        // options, best_seat_all, fallback, error, cached
  | 'plan_open'          // rank, seat_all, trick, rides
  | 'plan_share'
  | 'commute_saved'      // from, to, priority
  | 'station_open'       // code
  | 'crowd_report'       // level, origin, board
  | 'change_report'      // key, coach, minutes
  | 'timetable_updated'  // version
  | 'onboarding_done'    // lang, has_commute
  | 'language_changed';  // lang

export function track(event: AppEvent, params: Params = {}) {
  try {
    const clean: Record<string, string | number> = {};
    for (const [k, v] of Object.entries(params)) if (v !== undefined) clean[k] = typeof v === 'boolean' ? Number(v) : v;
    logEvent(getAnalytics(), event, clean);
  } catch { /* analytics must never break the app */ }
}

export function trackScreen(name: string) {
  try { logScreenView(getAnalytics(), { screen_name: name, screen_class: name }).catch(() => undefined); } catch { /* ignore */ }
}

export function setRiderProperty(name: 'lang' | 'home_line' | 'has_commute', value: string) {
  try { setUserProperty(getAnalytics(), name, value).catch(() => undefined); } catch { /* ignore */ }
}
