/**
 * Running status of one train, like a railway "where is my train" screen: every station from where it
 * starts to where it ends, expected times, and the train moving down the list.
 * Position = timetable + the best delay we have: your own GPS (if you're on it), else a rider's report.
 * Opening this records nothing.
 */
import { Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { fmt, secondsNow, serviceFor, stationName, ymd, LiveTracker, type Leg, type Timetable } from '@kmm/shared';
import { useApp, useNow } from '@/core/app-state';
import { dayFromToday } from '@/core/days';
import { getTrainDelay } from '@/core/firebase';
import { Card, Notice, T } from '@/ui/components';
import { DelayPill, useLive } from '@/ui/live-card';
import { space, type, useTheme } from '@/ui/theme';

const ROW = 58;

/** The whole run of a train as one ride, origin to terminus. */
function wholeRun(tt: Timetable, pattern: number, t0: number, day: number): Leg | null {
  const p = tt.patterns[pattern];
  if (!p) return null;
  const last = p.stops.length - 1;
  const svc = serviceFor(tt, dayFromToday(day));
  return { line: p.line, from: p.stops[0], to: p.stops[last], dep: t0 + p.dep[0], arr: t0 + p.arr[last], origin: p.stops[0], start: t0,
    terminus: p.stops[last], before: 0, stops: last, frac: 0, work: svc === 'weekday' || svc === 'monday', dir: 0, platform: p.pf[0] ?? null };
}

export default function TrainScreen() {
  const { p, t0, day: dayS, board, alight } = useLocalSearchParams<{ p: string; t0: string; day?: string; board?: string; alight?: string }>();
  const { t, tt, lang } = useApp();
  const th = useTheme();
  const { c } = th;
  const day = Number(dayS ?? 0);
  const now = useNow(5000);
  const live = useLive();
  const nm = (code: string) => stationName(tt, code, lang);

  const leg = useMemo(() => wholeRun(tt, Number(p), Number(t0), day), [tt, p, t0, day]);
  const tracker = useMemo(() => {
    const svc = serviceFor(tt, dayFromToday(day));
    if (!leg || !svc) return null;
    const tr = new LiveTracker(tt, svc, [leg]);
    return tr.ok ? tr : null;
  }, [tt, leg, day]);

  // best delay we have: your own ride on this train, else what riders on it shared
  const ridingThis = !!live && live.mode === 'ride' && live.tracker.legs.some((l) => l.origin === leg?.origin && l.start === leg?.start);
  const [rider, setRider] = useState<{ delay: number; at: number } | null>(null);
  useEffect(() => {
    if (!leg || day !== 0) return;
    let alive = true;
    const ask = () => getTrainDelay(ymd(dayFromToday(0)), leg.origin, leg.start).then((d) => alive && setRider(d)).catch(() => undefined);
    ask();
    const id = setInterval(ask, 30000);
    return () => { alive = false; clearInterval(id); };
  }, [leg, day]);

  const nowS = secondsNow(now);
  const ownDelay = ridingThis ? live!.status.delay : null;
  if (tracker) {
    if (ownDelay != null) tracker.external(ownDelay, 0, nowS);
    else if (rider) tracker.external(rider.delay, Math.max(0, nowS - rider.at), nowS);
  }
  const st = tracker && day === 0 ? tracker.status(nowS) : null;
  const delay = st?.delay ?? 0;
  const source = ridingThis ? (live!.status.source === 'motion' ? t('src_motion') : t('src_gps')) : rider ? t('src_rider', { n: Math.max(0, Math.round((nowS - rider.at) / 60)) }) : t('src_tt');

  const stops = tracker?.legs[0]?.stops ?? [];
  const idx = (code?: string | null) => (code ? stops.findIndex((s) => s.stn === code) : -1);
  // where the train is, as a position in the list (2.5 = between the 3rd and 4th station)
  const pos = !st ? -1 : st.phase === 'before' ? -1 : st.phase === 'arrived' ? stops.length - 1 : Math.max(0, idx(st.prev)) + (st.next !== st.prev ? st.frac : 0);
  const col = th.line(leg?.line ?? 'PURPLE');
  const bIdx = idx(board), aIdx = idx(alight);

  const scroll = useRef<ScrollView>(null);
  const scrolled = useRef(false);
  useEffect(() => {
    if (scrolled.current || !stops.length) return;
    const target = pos >= 0 ? pos : bIdx >= 0 ? bIdx : 0;
    scrolled.current = true;
    setTimeout(() => scroll.current?.scrollTo({ y: Math.max(0, target * ROW - 160), animated: false }), 50);
  }, [stops.length, pos, bIdx]);

  if (!leg || !tracker) return <View style={{ flex: 1, padding: space.l, backgroundColor: c.bg }}><Notice text={t('err_net')} /></View>;

  const head = !st ? `${t('train_starts', { s: nm(leg.origin), t: fmt(leg.dep) })}`
    : st.phase === 'before' ? t('train_starts', { s: nm(leg.origin), t: fmt(leg.dep + delay) })
    : st.phase === 'arrived' ? t('arrived_at', { s: nm(leg.terminus) })
    : st.next && st.next !== st.prev ? t('train_next', { s: nm(st.next) }) : t('train_at', { s: nm(st.prev ?? leg.origin) });

  return (
    <>
      <Stack.Screen options={{ title: t('towards_big', { s: nm(leg.terminus) }), headerShown: true, headerBackButtonDisplayMode: 'minimal' }} />
      <ScrollView ref={scroll} style={{ backgroundColor: c.bg }} contentContainerStyle={{ padding: space.l, gap: space.l, paddingBottom: 48 }}>
        <Card style={{ gap: space.s }}>
          <View style={s.row}>
            <View style={[s.dot, { backgroundColor: st && rider || ridingThis ? c.ok : c.ink3 }]} />
            <T v="caption" color={c.ink2} style={{ fontWeight: '500', flex: 1 }}>{source}</T>
            {st && st.phase !== 'arrived' ? <DelayPill delay={delay} rider={!ridingThis && !!rider} /> : null}
          </View>
          <T v="title" style={{ fontSize: 22 }}>{head}</T>
          <T v="sub" color={c.ink2}>{t(leg.line === 'GREEN' ? 'G' : leg.line === 'PURPLE' ? 'P' : 'Y')} · {nm(leg.origin)} {fmt(leg.dep)} → {nm(leg.terminus)} {fmt(leg.arr)}</T>
        </Card>

        <Card padded={false} style={{ paddingVertical: space.s }}>
          {stops.map((x, i) => {
            const passed = i <= Math.floor(pos);
            const exp = (i === 0 ? x.dep : x.arr) + delay;
            const sched = i === 0 ? x.dep : x.arr;
            const mine = i === bIdx || i === aIdx;
            const trainHere = pos >= 0 && Math.floor(pos) === i;
            return (
              <View key={x.stn + i} style={[s.stop, { height: ROW, zIndex: trainHere ? 3 : 1, elevation: trainHere ? 3 : 0 }]}>
                <View style={s.times}>
                  <T v="headline" style={[type.time, { color: passed ? c.ink3 : c.ink }]}>{fmt(exp)}</T>
                  {Math.round(delay / 60) !== 0 ? <T v="caption" color={c.ink3} style={[type.time, { fontWeight: '400', textDecorationLine: 'line-through' }]}>{fmt(sched)}</T> : null}
                </View>
                <View style={s.axis}>
                  <View style={[s.railUp, { backgroundColor: i === 0 ? 'transparent' : passed ? col : c.sep }]} />
                  <View style={[s.railDown, { backgroundColor: i === stops.length - 1 ? 'transparent' : i < Math.floor(pos) ? col : c.sep }]} />
                  {/* the line fills up to the train between two stations */}
                  {pos >= 0 && Math.floor(pos) === i && i < stops.length - 1 ? (
                    <View style={[s.railDown, { backgroundColor: col, height: Math.min(ROW / 2, (pos - i) * ROW) }]} />
                  ) : null}
                  {pos >= 0 && Math.floor(pos) === i - 1 && pos - (i - 1) > 0.5 ? (
                    <View style={[s.railUp, { backgroundColor: col, height: (pos - (i - 1)) * ROW - ROW / 2 }]} />
                  ) : null}
                  <View style={[s.node, { borderColor: passed ? col : c.ink3, backgroundColor: passed ? col : c.card }, mine && s.nodeMine]} />
                  {trainHere ? (
                    <View style={[s.train, { top: ROW / 2 - 13 + (pos - i) * ROW, backgroundColor: col }]}>
                      <T v="caption" color="#FFFFFF" style={{ fontWeight: '800', fontSize: 11 }}>▶</T>
                    </View>
                  ) : null}
                </View>
                <View style={{ flex: 1, justifyContent: 'center' }}>
                  <T v="body" numberOfLines={1} color={passed && !trainHere ? c.ink2 : c.ink} style={{ fontWeight: mine || trainHere ? '700' : '500' }}>{nm(x.stn)}</T>
                  {i === bIdx ? <T v="caption" color={c.tint}>{t('you_board')}</T> : i === aIdx ? <T v="caption" color={c.tint}>{t('you_alight')}</T> : null}
                </View>
              </View>
            );
          })}
        </Card>
        <T v="caption" color={c.ink3} style={{ textAlign: 'center', fontWeight: '400' }}>{t('fine')}</T>
      </ScrollView>
    </>
  );
}

const s = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: space.s },
  dot: { width: 8, height: 8, borderRadius: 4 },
  stop: { flexDirection: 'row', alignItems: 'stretch', paddingRight: space.l },
  times: { width: 64, alignItems: 'flex-end', justifyContent: 'center', paddingRight: space.s },
  axis: { width: 34, alignItems: 'center' },
  railUp: { position: 'absolute', top: 0, height: ROW / 2, width: 4 },
  railDown: { position: 'absolute', top: ROW / 2, height: ROW / 2, width: 4 },
  node: { position: 'absolute', top: ROW / 2 - 7, width: 14, height: 14, borderRadius: 7, borderWidth: 3 },
  nodeMine: { width: 18, height: 18, borderRadius: 9, top: ROW / 2 - 9 },
  train: { position: 'absolute', width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center', zIndex: 2 },
});
