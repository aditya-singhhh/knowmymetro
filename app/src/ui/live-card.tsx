/**
 * The live trip card: replaces the trip summary while following a train. Deliberately compact:
 * a status pill, one big line (what's happening), one line (what to do next), a thin progress strip.
 */
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { fmt, secondsNow, stationName, type LiveStatus } from '@kmm/shared';
import { useApp } from '@/core/app-state';
import { currentLive, onLive, stopLive, type LiveTrip } from '@/core/live';
import { Card, T, Tap } from './components';
import { space, type, useTheme } from './theme';
import { coachWords } from './trip-view';

export function useLive(): LiveTrip | null {
  const [l, setL] = useState<LiveTrip | null>(currentLive);
  useEffect(() => onLive(setL), []);
  return l;
}

export function DelayPill({ delay, rider }: { delay: number; rider?: boolean }) {
  const { t } = useApp();
  const { c } = useTheme();
  const m = Math.round(delay / 60);
  const tone = m >= 5 ? { fg: c.bad, bg: c.badBg } : m >= 2 ? { fg: c.meh, bg: c.mehBg } : { fg: c.ok, bg: c.okBg };
  const text = rider ? (m >= 1 ? t('rider_late', { n: m }) : t('rider_ontime')) : m >= 1 ? t('late_n', { n: m }) : m <= -1 ? t('early_n', { n: -m }) : t('on_time');
  return <View style={[s.pill, { backgroundColor: tone.bg }]}><T v="caption" color={tone.fg} style={{ fontWeight: '700' }}>{text}</T></View>;
}

export function LiveCard({ live }: { live: LiveTrip }) {
  const { t, tt, lang } = useApp();
  const th = useTheme();
  const { c } = th;
  const st: LiveStatus = live.status;
  const legs = live.option.legs;
  const nm = (code: string) => stationName(tt, code, lang);
  const lineName = (L: string) => t(L === 'GREEN' ? 'G' : L === 'PURPLE' ? 'P' : 'Y');
  const leg = legs[Math.min(st.leg, legs.length - 1)];
  const plan = live.tracker.legs[Math.min(st.leg, live.tracker.legs.length - 1)];
  const now = secondsNow();
  const mins = (sec: number) => Math.max(0, Math.round(sec / 60));
  const where = (l: typeof leg) => [l.platform ? t('platform', { p: l.platform }) : null, t('towards_big', { s: nm(plan?.terminus ?? l.terminus) })].filter(Boolean).join(' · ');
  const change = live.option.changes[st.leg];

  let big = '', small = '';
  switch (st.phase) {
    case 'before':
      big = st.action && st.action.inSec > 45 ? t('board_in', { n: mins(st.action.inSec) }) : t('board_now');
      small = where(leg);
      break;
    case 'changing':
      big = t('change_now', { line: lineName(leg.line) });
      small = `${where(leg)}${st.action ? ` · ${fmt(now + st.action.inSec)}` : ''}`;
      break;
    case 'riding':
      big = st.next && st.next !== st.prev ? t('next_stn', { s: nm(st.next) }) : t('at_stn', { s: nm(st.prev ?? leg.from) });
      if (st.action?.kind === 'change') {
        small = `${t('change_in', { s: nm(st.action.at), n: mins(st.action.inSec) })}${change?.coaches.length ? ` · ${coachWords(change.coaches, t('or'), t)}` : ''}`;
      } else if (st.action) {
        small = st.action.stopsAway <= 1 ? t('getoff_next', { s: nm(st.action.at) }) : t('getoff_in', { s: nm(st.action.at), n: st.action.stopsAway });
      }
      break;
    case 'arrived':
      big = t('arrived');
      small = nm(legs[legs.length - 1].to);
      break;
  }
  const src = st.source === 'gps' ? t('src_gps') : st.source === 'motion' ? t('src_motion') : t('src_tt');

  // progress through this ride: one dot per station
  const stops = plan?.stops ?? [];
  const passed = stops.findIndex((x) => x.stn === st.prev);
  const pos = st.phase === 'riding' ? Math.max(0, passed) + st.frac : st.phase === 'arrived' ? stops.length - 1 : 0;
  const col = th.line(leg.line);

  return (
    <Card style={{ gap: space.m }}>
      <View style={s.row}>
        <View style={[s.dot, { backgroundColor: st.source === 'timetable' ? c.ink3 : c.ok }]} />
        <T v="caption" color={c.ink2} style={{ fontWeight: '500', flex: 1 }}>{src}</T>
        {st.phase !== 'arrived' ? <DelayPill delay={st.delay} /> : null}
      </View>

      <View style={{ gap: 4 }}>
        <T v="title" style={{ fontSize: 24 }}>{big}</T>
        {small ? <T v="sub" color={c.ink2}>{small}</T> : null}
        {st.missed ? <T v="sub" color={c.bad} style={{ fontWeight: '600' }}>{t('missed_conn', { a: fmt(st.missed.planned), s: nm(st.missed.at), b: st.missed.next != null ? fmt(st.missed.next) : '—' })}</T> : null}
        {st.switched ? <T v="caption" color={c.ink2} style={{ fontWeight: '400' }}>{t('switched')}</T> : null}
      </View>

      {stops.length > 1 ? (
        <View style={{ gap: 4 }}>
          <View style={s.track}>
            <View style={[s.rail, { backgroundColor: c.fill }]} />
            <View style={[s.fill, { backgroundColor: col, width: `${(pos / (stops.length - 1)) * 100}%` }]} />
            {stops.map((x, i) => (
              <View key={x.stn} style={[s.stop, { left: `${(i / (stops.length - 1)) * 100}%`, backgroundColor: i <= pos ? col : c.card, borderColor: i <= pos ? col : c.ink3 }]} />
            ))}
            {st.phase === 'riding' ? <View style={[s.train, { left: `${(pos / (stops.length - 1)) * 100}%`, borderColor: col, backgroundColor: c.card }]} /> : null}
          </View>
          <View style={s.row}>
            <T v="caption" color={c.ink2} style={{ fontWeight: '400', flex: 1 }} numberOfLines={1}>{nm(stops[0].stn)}</T>
            <T v="caption" color={c.ink2} style={{ fontWeight: '400', flex: 1, textAlign: 'right' }} numberOfLines={1}>{nm(stops[stops.length - 1].stn)}</T>
          </View>
        </View>
      ) : null}

      <View style={[s.row, { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.sep, paddingTop: space.m }]}>
        <T v="headline" style={[type.time, { flex: 1 }]}>{t('arrive_est', { t: fmt(st.arrival) })}</T>
        {st.leg + 1 < legs.length && st.phase !== 'changing' ? (
          <T v="caption" color={c.ink2} style={{ fontWeight: '400', marginRight: space.m }} numberOfLines={1}>{t('then_line', { line: lineName(legs[st.leg + 1].line), s: nm(legs[st.leg + 1].to) })}</T>
        ) : null}
        <Tap onPress={() => stopLive('user')} hitSlop={10}><T v="sub" color={c.tint} style={{ fontWeight: '600' }}>{t('live_end')}</T></Tap>
      </View>
    </Card>
  );
}

const s = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: space.s },
  dot: { width: 8, height: 8, borderRadius: 4 },
  pill: { borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 },
  track: { height: 18, justifyContent: 'center', marginHorizontal: 7 },
  rail: { position: 'absolute', left: 0, right: 0, height: 4, borderRadius: 2 },
  fill: { position: 'absolute', left: 0, height: 4, borderRadius: 2 },
  stop: { position: 'absolute', width: 10, height: 10, borderRadius: 5, borderWidth: 2, marginLeft: -5 },
  train: { position: 'absolute', width: 18, height: 18, borderRadius: 9, borderWidth: 4, marginLeft: -9 },
});
