/**
 * Phone notifications: live-trip heads-ups ("next stop Majestic, change to Purple") and the
 * daily commute reminder ("your 08:27 leaves in 10 min"). All local, nothing is sent from a server.
 */
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { fmt, stationName, translate, type Lang, type PlanOption, type PlanResponse, type StringKey, type Timetable } from '@kmm/shared';
import { load, save } from './storage';

Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
});

const CHANNEL = 'trip';
let channelReady: Promise<unknown> | null = null;
const channel = () => (channelReady ??= Platform.OS === 'android'
  ? Notifications.setNotificationChannelAsync(CHANNEL, { name: 'Trip alerts', importance: Notifications.AndroidImportance.HIGH, vibrationPattern: [0, 250, 150, 250] }).catch(() => undefined)
  : Promise.resolve());

const tr = (k: StringKey, v?: Record<string, string | number>) => translate(load<Lang>('lang', 'en'), k, v);
const lang = () => load<Lang>('lang', 'en');

/** Ask once (only when the rider turns something on). */
export async function allowNotifications(): Promise<boolean> {
  try {
    const cur = await Notifications.getPermissionsAsync();
    if (cur.granted) return true;
    const r = await Notifications.requestPermissionsAsync();
    return r.granted;
  } catch { return false; }
}

async function show(title: string, body: string) {
  try {
    await channel();
    await Notifications.scheduleNotificationAsync({ content: { title, body, sound: true }, trigger: Platform.OS === 'android' ? { channelId: CHANNEL } : null });
  } catch { /* notifications not allowed: the live view still says it */ }
}

/** One stop before a change or the destination. */
export function notifyNow(tt: Timetable, kind: 'change' | 'getoff', at: string, option: PlanOption) {
  const nm = (c: string) => stationName(tt, c, lang());
  const legs = option.legs;
  const i = legs.findIndex((l) => l.to === at);
  const next = legs[i + 1];
  if (kind === 'change' && next) {
    const pf = next.platform ? `${tr('platform', { p: next.platform })} · ` : '';
    show(tr('alert_next', { s: nm(at) }), tr('alert_change', { line: tr(next.line === 'GREEN' ? 'G' : next.line === 'PURPLE' ? 'P' : 'Y'), d: `${pf}${tr('towards_big', { s: nm(next.terminus) })}` }));
  } else {
    show(tr('alert_next', { s: nm(at) }), tr('alert_getoff'));
  }
}

/* ---------------- commute reminder ---------------- */

const IDS_KEY = 'commuteReminderIds';

/**
 * Schedules "time to leave" reminders for the commute's best train on the coming days.
 * `plans` are the commute plans already fetched for those days (date -> response).
 */
export async function scheduleCommuteReminders(tt: Timetable, lead: number, plans: { date: Date; res: PlanResponse }[]) {
  try {
    for (const id of load<string[]>(IDS_KEY, [])) await Notifications.cancelScheduledNotificationAsync(id).catch(() => undefined);
    save(IDS_KEY, []);
    if (!lead) return;
    if (!(await Notifications.getPermissionsAsync()).granted) return;
    await channel();
    const ids: string[] = [];
    for (const { date, res } of plans) {
      const o = res.best >= 0 ? res.options[res.best] : null;
      if (!o) continue;
      const at = new Date(date); at.setHours(0, 0, 0, 0);
      const fire = new Date(at.getTime() + (o.dep - lead * 60) * 1000);
      if (fire.getTime() < Date.now() + 60000) continue;
      const ch = o.changes.find((c) => c.kind === 'line' && c.coaches.length);
      const nm = (c: string) => stationName(tt, c, lang());
      const body = [`${nm(o.legs[0].from)} → ${nm(o.legs[o.legs.length - 1].to)} · ${tr('reach')} ${fmt(o.arr)}`,
        ch ? tr('board_coach', { c: tr('coach', { n: ch.coaches.join(', ') }) }) : null].filter(Boolean).join(' · ');
      const id = await Notifications.scheduleNotificationAsync({
        content: { title: tr('remind_title', { t: fmt(o.dep), n: lead }), body, sound: true },
        trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: fire, ...(Platform.OS === 'android' ? { channelId: CHANNEL } : {}) },
      });
      ids.push(id);
    }
    save(IDS_KEY, ids);
  } catch { /* not allowed or not available */ }
}
