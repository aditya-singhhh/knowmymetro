import { useMemo, useState } from 'react';
import { FlatList, Modal, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { linesOf, stationName, translate, type LineId } from '@kmm/shared';
import { useApp } from '@/core/app-state';
import { T, Tap } from './components';
import { radius, space, useTheme } from './theme';

const LINE_ORDER: LineId[] = ['PURPLE', 'GREEN', 'YELLOW'];

/** Full-screen native sheet to pick a station, with search in English and Kannada. */
export function StationPicker({ visible, title, onPick, onClose }: { visible: boolean; title: string; onPick: (code: string) => void; onClose: () => void }) {
  const { tt, lang, t } = useApp();
  const { c, line } = useTheme();
  const insets = useSafeAreaInsets();
  const [q, setQ] = useState('');

  const rows = useMemo(() => {
    const seen = new Set<string>();
    const out: { code: string; line: LineId; name: string; hay: string }[] = [];
    for (const L of LINE_ORDER) for (const code of tt.lines[L]?.stations ?? []) {
      if (seen.has(code)) continue;
      seen.add(code);
      const s = tt.stations[code];
      out.push({ code, line: L, name: stationName(tt, code, lang), hay: `${s.en} ${s.full} ${s.kn ?? ''}`.toLowerCase() });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }, [tt, lang]);
  const query = q.trim().toLowerCase();
  const shown = query ? rows.filter((r) => r.hay.includes(query)) : rows;

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: c.bg, paddingTop: space.l }}>
        <View style={s.head}>
          <T v="title">{title}</T>
          <Tap onPress={onClose} hitSlop={12}><T v="headline" color={c.tint}>{t('done')}</T></Tap>
        </View>
        <View style={[s.search, { backgroundColor: c.card }]}>
          <TextInput
            value={q} onChangeText={setQ} placeholder={translate(lang, 'search_st')} placeholderTextColor={c.ink3}
            autoFocus autoCorrect={false} clearButtonMode="while-editing" returnKeyType="search"
            style={{ flex: 1, fontSize: 17, color: c.ink }}
          />
        </View>
        <FlatList
          data={shown}
          keyExtractor={(r) => r.code}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingBottom: insets.bottom + space.xl }}
          ListEmptyComponent={<T v="sub" color={c.ink2} style={{ padding: space.l }}>{t('no_match')}</T>}
          renderItem={({ item }) => (
            <Tap onPress={() => { onPick(item.code); setQ(''); }} style={[s.row, { borderBottomColor: c.sep }]}>
              <View style={{ flexDirection: 'row', gap: 4 }}>
                {linesOf(tt, item.code).map((L) => <View key={L} style={[s.dot, { backgroundColor: line(L) }]} />)}
              </View>
              <T v="body" style={{ flex: 1, fontWeight: '500' }}>{item.name}</T>
            </Tap>
          )}
        />
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: space.l, marginBottom: space.m },
  search: { marginHorizontal: space.l, marginBottom: space.s, borderRadius: radius.m, height: 46, paddingHorizontal: space.m, flexDirection: 'row', alignItems: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.m, paddingVertical: 14, paddingHorizontal: space.l, borderBottomWidth: StyleSheet.hairlineWidth },
  dot: { width: 10, height: 10, borderRadius: 5 },
});
