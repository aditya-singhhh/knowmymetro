/**
 * The live trip card: replaces the trip summary while following a train. Deliberately compact:
 * a status pill, one big line (what's happening), one line (what to do next), a thin progress strip.
 */
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { fmt, secondsNow, stationName, type LiveStatus } from '@kmm/shared';
import { useApp } from '@/core/app-state';
import { currentLive, doorsOpened, onLive, stopLive, type LiveTrip } from '@/core/live';
import { Button, Card, T, Tap } from './components';
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

export function LiveCard({ live, onRide, rideMsg, onMissed, onStations }: { live: LiveTrip; onRide?: () => void; rideMsg?: string | null; onMissed?: () => void; onStations?: (leg: number) => void }) {
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

  let big = '', small = '', small2 = '';
  const tr = st.train;
  // waiting for a train: where it is now and when it reaches you
  const trainLines = () => {
    if (!tr) return;
    big = tr.startsAt != null ? t('train_starts', { s: nm(tr.at ?? leg.origin), t: fmt(tr.startsAt) })
      : tr.at ? t('train_at', { s: nm(tr.at) }) : t('train_next', { s: nm(tr.next ?? leg.from) });
    small = tr.stopsAway <= 0 ? t('reaches_now', { s: nm(leg.from), t: fmt(tr.reaches) }) : t('reaches', { s: nm(leg.from), t: fmt(tr.reaches), n: tr.stopsAway });
    small2 = where(leg);
  };
  switch (st.phase) {
    case 'before':
      big = st.action && st.action.inSec > 45 ? t('board_in', { n: mins(st.action.inSec) }) : t('board_now');
      small = where(leg);
      trainLines();
      break;
    case 'changing':
      big = t('change_now', { line: lineName(leg.line) });
      small = `${where(leg)}${st.action ? ` · ${fmt(now + st.action.inSec)}` : ''}`;
      if (tr) { const b = big; trainLines(); small2 = `${b} · ${small2}`; }
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
  const src = st.source === 'gps' ? t('src_gps') : st.source === 'motion' ? t('src_motion')
    : st.source === 'rider' ? t('src_rider', { n: Math.max(0, Math.round((st.age ?? 0) / 60)) }) : t('src_tt');
  const watching = live.mode === 'watch';

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
        {small2 ? <T v="sub" color={c.ink2}>{small2}</T> : null}
        {st.missed ? <T v="sub" color={c.bad} style={{ fontWeight: '600' }}>{t('missed_conn', { a: fmt(st.missed.planned), s: nm(st.missed.at), b: st.missed.next != null ? fmt(st.missed.next) : '—' })}</T> : null}
        {st.switched ? <T v="caption" color={c.ink2} style={{ fontWeight: '400' }}>{t('switched')}</T> : null}
      </View>

      {/* no GPS (underground): one tap at each stop keeps the position right and maps the tunnel */}
      {!watching && st.phase === 'riding' && st.source !== 'gps' ? (
        <Tap onPress={doorsOpened} style={[s.doors, { backgroundColor: c.tintBg }]} accessibilityRole="button">
          <T v="sub" color={c.tint} style={{ fontWeight: '700' }}>{t('doors_btn')}</T>
          <T v="caption" color={c.tint} style={{ fontWeight: '400' }}>{t('doors_hint')}</T>
        </Tap>
      ) : null}

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
          {onStations ? (
            <Tap onPress={() => onStations(Math.min(st.leg, legs.length - 1))} hitSlop={8} style={{ alignSelf: 'flex-start', marginTop: 2 }}>
              <T v="sub" color={c.tint} style={{ fontWeight: '600' }}>{t('all_stations')} ›</T>
            </Tap>
          ) : null}
        </View>
      ) : null}

      {/* arrival (and the next ride) on the left, End on the right; text wraps instead of squeezing */}
      <View style={[s.row, { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.sep, paddingTop: space.m, alignItems: 'flex-start' }]}>
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <T v="headline" style={type.time}>{t('arrive_est', { t: fmt(st.arrival) })}</T>
          {st.leg + 1 < legs.length && st.phase !== 'changing' ? (
            <T v="caption" color={c.ink2} style={{ fontWeight: '400' }}>{t('then_line', { line: lineName(legs[st.leg + 1].line), s: nm(legs[st.leg + 1].to) })}</T>
          ) : null}
        </View>
        {!watching ? <Tap onPress={() => stopLive('user')} hitSlop={10}><T v="sub" color={c.tint} style={{ fontWeight: '600' }}>{t('live_end')}</T></Tap> : null}
      </View>

      {watching && st.phase !== 'arrived' ? (
        <View style={{ gap: space.s }}>
          {onRide ? <Button label={t('live_on')} onPress={onRide} /> : null}
          {rideMsg ? <T v="caption" color={c.ink2} style={{ fontWeight: '400', textAlign: 'center' }}>{rideMsg}</T> : null}
          {onMissed && st.leg === 0 && st.phase === 'riding' ? <Button kind="plain" label={t('missed')} onPress={onMissed} /> : null}
        </View>
      ) : null}
    </Card>
  );
}

const s = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: space.s },
  dot: { width: 8, height: 8, borderRadius: 4 },
  doors: { borderRadius: 12, paddingVertical: 10, paddingHorizontal: 14, gap: 2 },
  pill: { borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 },
  track: { height: 18, justifyContent: 'center', marginHorizontal: 7 },
  rail: { position: 'absolute', left: 0, right: 0, height: 4, borderRadius: 2 },
  fill: { position: 'absolute', left: 0, height: 4, borderRadius: 2 },
  stop: { position: 'absolute', width: 10, height: 10, borderRadius: 5, borderWidth: 2, marginLeft: -5 },
  train: { position: 'absolute', width: 18, height: 18, borderRadius: 9, borderWidth: 4, marginLeft: -9 },
});
