import { router, Stack } from 'expo-router';
import { useMemo, useState } from 'react';
import { FlatList, StyleSheet, View } from 'react-native';
import { lineOrigins, linesOf, stationName, type LineId } from '@kmm/shared';
import { useApp } from '@/core/app-state';
import { Chevron, T, Tap } from '@/ui/components';
import { radius, space, useTheme } from '@/ui/theme';

const LINES: LineId[] = ['PURPLE', 'GREEN', 'YELLOW'];
const LINE_KEY = { PURPLE: 'P', GREEN: 'G', YELLOW: 'Y' } as const;

export default function Stations() {
  const { tt, t, lang, homeStation } = useApp();
  const th = useTheme();
  const { c } = th;
  const [line, setLine] = useState<LineId>(() => (homeStation ? linesOf(tt, homeStation)[0] : 'PURPLE'));
  const [q, setQ] = useState('');
  const origins = useMemo(() => lineOrigins(tt), [tt]);

  const query = q.trim().toLowerCase();
  const rows = useMemo(() => {
    if (!query) return (tt.lines[line]?.stations ?? []).map((code) => ({ code, line }));
    const seen = new Set<string>(), out: { code: string; line: LineId }[] = [];
    for (const L of LINES) for (const code of tt.lines[L]?.stations ?? []) {
      const s = tt.stations[code];
      if (!seen.has(code) && `${s.en} ${s.full} ${s.kn ?? ''}`.toLowerCase().includes(query)) { seen.add(code); out.push({ code, line: L }); }
    }
    return out;
  }, [tt, line, query]);

  return (
    <>
      <Stack.Screen options={{
        title: t('tab_st'),
        headerSearchBarOptions: { placeholder: t('search_st'), onChangeText: (e) => setQ(e.nativeEvent.text), hideWhenScrolling: false },
      }} />
      <FlatList
        style={{ backgroundColor: c.bg }}
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        data={rows}
        keyExtractor={(r) => r.code + r.line}
        ListHeaderComponent={query ? null : (
          <View style={[s.lineTabs, { backgroundColor: c.fill }]}>
            {LINES.map((L) => {
              const on = L === line;
              return (
                <Tap key={L} onPress={() => setLine(L)} style={[s.lineTab, on && { backgroundColor: th.line(L) }]} accessibilityState={{ selected: on }}>
                  <T v="sub" style={{ fontWeight: '700', textAlign: 'center' }} color={on ? th.lineText(L) : c.ink}>{t(LINE_KEY[L as keyof typeof LINE_KEY])}</T>
                </Tap>
              );
            })}
          </View>
        )}
        contentContainerStyle={{ paddingHorizontal: space.l, paddingBottom: 120 }}
        renderItem={({ item, index }) => {
          const first = index === 0, last = index === rows.length - 1;
          const others = linesOf(tt, item.code).filter((L) => L !== item.line);
          const hub = origins[item.line]?.has(item.code);
          return (
            <Tap onPress={() => router.push({ pathname: '/(tabs)/(stations)/station/[code]', params: { code: item.code } })}
              style={[s.row, { backgroundColor: c.card }, first && s.top, last && s.bottom]}>
              <View style={s.rail}>
                {!query ? <View style={[s.track, { backgroundColor: th.line(item.line), top: first ? '50%' : 0, bottom: last ? '50%' : 0 }]} /> : null}
                <View style={[others.length ? s.bigDot : s.dot, { borderColor: others.length ? c.ink : th.line(item.line), backgroundColor: c.card }]} />
              </View>
              <View style={[s.body, !last && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.sep }]}>
                <T v="headline">{stationName(tt, item.code, lang)}</T>
                {others.length || hub || item.code === homeStation ? (
                  <View style={s.badges}>
                    {others.map((L) => (
                      <View key={L} style={[s.mini, { backgroundColor: c.fill }]}><View style={[s.miniDot, { backgroundColor: th.line(L) }]} /><T v="caption" color={c.ink2}>{t('interchange', { x: t(LINE_KEY[L as keyof typeof LINE_KEY]) })}</T></View>
                    ))}
                    {hub ? <View style={[s.mini, { backgroundColor: c.okBg }]}><T v="caption" color={c.ok}>{t('st_hub')}</T></View> : null}
                    {item.code === homeStation ? <View style={[s.mini, { backgroundColor: c.tintBg }]}><T v="caption" color={c.tint}>★ {t('tab_home')}</T></View> : null}
                  </View>
                ) : null}
              </View>
              <Chevron />
            </Tap>
          );
        }}
        ListEmptyComponent={<T v="sub" color={c.ink2} style={{ padding: space.l }}>{t('no_match')}</T>}
      />
    </>
  );
}

const s = StyleSheet.create({
  lineTabs: { flexDirection: 'row', borderRadius: 10, padding: 2, marginBottom: space.m },
  lineTab: { flex: 1, borderRadius: 8, paddingVertical: 8 },
  row: { flexDirection: 'row', alignItems: 'stretch', paddingLeft: space.m, paddingRight: space.l, minHeight: 56 },
  top: { borderTopLeftRadius: radius.l, borderTopRightRadius: radius.l },
  bottom: { borderBottomLeftRadius: radius.l, borderBottomRightRadius: radius.l },
  rail: { width: 30, alignItems: 'center', justifyContent: 'center' },
  track: { position: 'absolute', width: 6 },
  dot: { width: 15, height: 15, borderRadius: 8, borderWidth: 3 },
  bigDot: { width: 20, height: 20, borderRadius: 10, borderWidth: 4 },
  body: { flex: 1, justifyContent: 'center', paddingVertical: space.m, marginLeft: space.m, gap: 4 },
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  mini: { flexDirection: 'row', alignItems: 'center', gap: 5, borderRadius: 6, paddingVertical: 2, paddingHorizontal: 7 },
  miniDot: { width: 8, height: 8, borderRadius: 4 },
});
