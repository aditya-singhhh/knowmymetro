import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { fmt, secondsNow, serviceFor, stationName, ymd } from '@kmm/shared';
import { track } from '@/core/analytics';
import { useApp, useNow } from '@/core/app-state';
import { dayFromToday } from '@/core/days';
import { getTrainDelay, submitCrowdReport } from '@/core/firebase';
import { rideTrain, unwatch, watchTrain } from '@/core/live';
import { getTrip } from '@/core/trip-store';
import { Button, Card, Notice, Screen, T, Tap } from './components';
import { DelayPill, LiveCard, useLive } from './live-card';
import { space, type, useTheme } from './theme';
import { ShareButton, TripView } from './trip-view';

export function TripScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const trip = getTrip(id);
  const { t, tt, lang, locale } = useApp();
  const { c } = useTheme();
  const now = useNow(15000);
  const live = useLive();
  const [liveMsg, setLiveMsg] = useState<string | null>(null);
  const [rider, setRider] = useState<{ delay: number } | null>(null);
  // someone already on this train shared how late it is
  useEffect(() => {
    if (!trip || trip.day !== 0) return;
    const l = trip.option.legs[0];
    getTrainDelay(ymd(dayFromToday(0)), l.origin, l.start - (l.held ?? 0)).then(setRider).catch(() => undefined);
  }, [trip]);
  useEffect(() => {
    if (trip) track('plan_open', { seat_all: trip.option.seatAllTheWay, trick: !!trip.option.trick, rides: trip.option.legs.length });
  }, [trip]);

  if (!trip) return <Screen><Notice text={t('err_net')} /></Screen>;
  const { option, day } = trip;
  const first = option.legs[0], last = option.legs[option.legs.length - 1];
  const nowS = secondsNow(now);
  const left = option.dep - nowS;
  const ridden = day === 0 && nowS > first.dep + 60;
  const when = day > 0
    ? dayFromToday(day).toLocaleDateString(locale, { weekday: 'long' })
    : left > 0 ? t('in_x', { x: `${Math.round(left / 60)} ${t('min')}` }) : t('leave_now');
  const isLive = live?.id === id;
  const trackable = day === 0 && nowS < option.arr + 60;
  // opening a train today shows where it is right away; leaving the screen stops watching (not riding)
  useEffect(() => {
    if (trip && trackable) watchTrain(tt, id, trip.option, dayFromToday(0));
    return () => unwatch(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  const ride = async () => {
    setLiveMsg(null);
    const r = await rideTrain(tt, id, option, dayFromToday(0));
    if (r === 'location') setLiveMsg(t('loc_needed'));
  };
  const nextTrain = () => router.navigate({ pathname: '/(tabs)/(plan)', params: { from: first.from, to: last.to, at: String(Date.now()) } });

  return (
    <>
      <Stack.Screen options={{ title: `${stationName(tt, first.from, lang)} – ${stationName(tt, last.to, lang)}`, headerLargeTitle: false }} />
      <Screen>
        {isLive && live ? <LiveCard live={live} onRide={ride} rideMsg={liveMsg} onMissed={nextTrain} /> : (
          <Card style={s.summary}>
            <View>
              <T v="caption" color={c.ink2} style={{ fontWeight: '400' }}>{t('board_at', { s: stationName(tt, first.from, lang) })}</T>
              <T v="clock" style={{ fontSize: 44 }}>{fmt(option.dep)}</T>
              <T v="sub" color={c.tint} style={{ fontWeight: '700' }}>{when}</T>
            </View>
            <View style={{ alignItems: 'flex-end', gap: space.s }}>
              {rider ? <DelayPill delay={rider.delay} rider /> : null}
              <View style={{ alignItems: 'flex-end' }}>
                <T v="caption" color={c.ink2} style={{ fontWeight: '400' }}>{t('reach')}</T>
                <T v="title" style={[type.time, { fontSize: 24 }]}>{fmt(option.arr)}</T>
              </View>
            </View>
          </Card>
        )}
        <TripView option={option} />
        {live?.mode !== 'ride' || !isLive ? <ShareButton option={option} /> : null}
        {ridden && !(isLive && live?.mode === 'ride') ? <CrowdReport origin={first.origin} board={first.from} start={first.start} dep={first.dep} /> : null}
      </Screen>
    </>
  );
}

/** One tap after the ride: did you get a seat? Feeds the nightly crowd statistics. */
function CrowdReport({ origin, board, start, dep }: { origin: string; board: string; start: number; dep: number }) {
  const { t, tt } = useApp();
  const { c } = useTheme();
  const [sent, setSent] = useState(false);
  const send = async (level: 0 | 1 | 2) => {
    setSent(true);
    track('crowd_report', { level, origin, board });
    const today = dayFromToday(0);
    await submitCrowdReport({ date: ymd(today), service: serviceFor(tt, today) ?? 'weekday', origin, start: fmt(start), board, level });
  };
  if (sent) return <Notice text={t('report_thanks')} tone="ok" />;
  return (
    <Card style={{ gap: space.m }}>
      <T v="headline">{t('report_q', { t: fmt(dep) })}</T>
      <View style={{ flexDirection: 'row', gap: space.s }}>
        {([[0, 'report_seat'], [1, 'report_stand'], [2, 'report_packed']] as const).map(([lvl, key]) => (
          <Tap key={lvl} onPress={() => send(lvl)} style={[s.report, { backgroundColor: lvl === 0 ? c.okBg : lvl === 1 ? c.mehBg : c.badBg }]}>
            <T v="sub" style={{ fontWeight: '700', textAlign: 'center' }} color={lvl === 0 ? c.ok : lvl === 1 ? c.meh : c.bad}>{t(key)}</T>
          </Tap>
        ))}
      </View>
    </Card>
  );
}

const s = StyleSheet.create({
  summary: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' },
  report: { flex: 1, borderRadius: 12, paddingVertical: 12, paddingHorizontal: 6 },
});
