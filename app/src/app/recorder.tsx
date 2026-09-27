import { Stack } from 'expo-router';
import { useEffect, useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { nearestStation, stationName } from '@kmm/shared';
import { track } from '@/core/analytics';
import { useApp } from '@/core/app-state';
import { uploadRecording } from '@/core/firebase';
import {
  forgetRecording, isRecording, markStation, onStats, pendingRecordings, startRecording, stopRecording, type LiveStats,
} from '@/core/recorder';
import { Button, Card, Notice, Screen, T, Tap } from '@/ui/components';
import { radius, space, type, useTheme } from '@/ui/theme';

/**
 * Beta tool for founding riders: records GPS, mobile towers and motion during a metro ride,
 * so we can learn to place trains without GPS (underground, or with GPS off).
 */
export default function Recorder() {
  const { tt, lang } = useApp();
  const { c } = useTheme();
  const [recording, setRecording] = useState(isRecording());
  const [stats, setStats] = useState<LiveStats | null>(null);
  const [pending, setPending] = useState(() => pendingRecordings().length);
  const [msg, setMsg] = useState<{ text: string; tone: 'ok' | 'bad' | 'meh' } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { onStats(setStats); return () => onStats(null); }, []);

  const near = stats?.lastFix ? nearestStation(tt, stats.lastFix.lat, stats.lastFix.lon) : null;

  const start = async () => {
    setMsg(null);
    const r = await startRecording();
    if (!r.ok) { setMsg({ text: 'Location permission is needed to record GPS and mobile towers. Allow it in Settings and try again.', tone: 'bad' }); return; }
    setRecording(true);
    track('recording_started');
  };

  const uploadAll = async () => {
    setBusy(true);
    let done = 0, failed = 0;
    for (const rec of pendingRecordings()) {
      if (await uploadRecording(rec)) { forgetRecording(rec.id); done++; track('recording_uploaded', { samples: rec.samples.length, minutes: Math.round(((rec.endedAt ?? rec.startedAt) - rec.startedAt) / 60000) }); } else failed++;
    }
    setPending(pendingRecordings().length);
    setBusy(false);
    setMsg(failed ? { text: `${done} uploaded, ${failed} waiting for a connection. They stay on the phone until then.`, tone: 'meh' }
      : { text: done ? `Uploaded ${done} trip${done > 1 ? 's' : ''}. Thank you!` : 'Nothing to upload.', tone: 'ok' });
  };

  const stop = async () => {
    const rec = stopRecording();
    setRecording(false);
    setPending(pendingRecordings().length);
    if (rec) await uploadAll();
  };

  const mins = stats ? `${Math.floor(stats.seconds / 60)}:${String(stats.seconds % 60).padStart(2, '0')}` : '0:00';

  return (
    <>
      <Stack.Screen options={{ title: 'Trip recorder' }} />
      <Screen>
        <View style={{ height: space.s }} />
        {!recording ? (
          <Card style={{ gap: space.m }}>
            <T v="title">Help map the metro</T>
            <T v="sub" color={c.ink2}>
              Tap Start when you board. While recording, the app saves your GPS position, the mobile towers your phone sees
              {Platform.OS === 'ios' ? ' (not available on iPhone)' : ''} and motion. Keep the app open until you get off.
              Trips are uploaded anonymously and used only to improve live train tracking.
            </T>
            <Button label="Start recording" onPress={start} />
          </Card>
        ) : (
          <>
            <Card style={{ gap: space.l }}>
              <View style={s.row}>
                <View style={[s.dot, { backgroundColor: c.bad }]} />
                <T v="headline">Recording</T>
                <T v="headline" style={[type.time, { marginLeft: 'auto' }]}>{mins}</T>
              </View>
              <View style={s.grid}>
                <Stat label="GPS fixes" value={String(stats?.gpsFixes ?? 0)} sub={stats?.lastAccuracy != null ? `±${Math.round(stats.lastAccuracy)} m` : 'waiting'} />
                <Stat label="Towers seen" value={String(stats?.towers ?? 0)} sub={Platform.OS === 'ios' ? 'iPhone: n/a' : 'unique'} />
                <Stat label="Motion" value={stats?.moving == null ? '—' : stats.moving ? 'Moving' : 'Stopped'} />
                <Stat label="Stations marked" value={String(stats?.marks ?? 0)} />
              </View>
              {near ? <T v="sub" color={c.ink2}>Near {stationName(tt, near, lang)}</T> : null}
            </Card>
            <Tap onPress={() => markStation(near)} style={[s.mark, { backgroundColor: c.tint }]} accessibilityRole="button">
              <T v="title" color={c.onTint}>Doors opened</T>
              <T v="sub" color={c.onTint}>Tap at every station stop, especially underground</T>
            </Tap>
            <Button label="Stop and upload" kind="plain" onPress={stop} />
          </>
        )}
        {msg ? <Notice text={msg.text} tone={msg.tone} /> : null}
        {!recording && pending > 0 ? (
          <Card style={{ gap: space.m }}>
            <T v="sub">{pending} trip{pending > 1 ? 's' : ''} saved on this phone, not uploaded yet.</T>
            <Button label={busy ? 'Uploading…' : 'Upload now'} kind="plain" disabled={busy} onPress={uploadAll} />
          </Card>
        ) : null}
      </Screen>
    </>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  const { c } = useTheme();
  return (
    <View style={[s.stat, { backgroundColor: c.fill }]}>
      <T v="caption" color={c.ink2} style={{ fontWeight: '500' }}>{label}</T>
      <T v="title" style={type.time}>{value}</T>
      {sub ? <T v="caption" color={c.ink2} style={{ fontWeight: '400' }}>{sub}</T> : null}
    </View>
  );
}

const s = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: space.s },
  dot: { width: 10, height: 10, borderRadius: 5 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.s },
  stat: { flexBasis: '48%', flexGrow: 1, borderRadius: radius.m, padding: space.m, gap: 2 },
  mark: { borderRadius: radius.l, paddingVertical: space.xl, alignItems: 'center', gap: 4 },
});
