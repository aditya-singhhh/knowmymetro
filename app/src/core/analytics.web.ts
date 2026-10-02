/**
 * Web preview: analytics switched off.. Anonymous: station codes, times and choices only.
 * No names, phone numbers or locations are ever logged.
 */

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
  | 'language_changed'   // lang
  | 'recording_started'
  | 'recording_uploaded' // samples, minutes
  | 'live_started'       // rides
  | 'live_ended'         // reason, delay, source
  | 'reminder_set';      // minutes

export function track(_event: AppEvent, _params: Params = {}) { /* off on web */ }
export function trackScreen(_name: string) { /* off on web */ }
export function setRiderProperty(_name: 'lang' | 'home_line' | 'has_commute', _value: string) { /* off on web */ }
