import { Stack } from 'expo-router';
import { useEffect, useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { nearestStation, stationName } from '@kmm/shared';
import { track } from '@/core/analytics';
import { useApp } from '@/core/app-state';
import type { TrainState } from '@/core/motion';
import {
  isRecording, markStation, onRecordingState, onStats, pendingRecordings, startRecording, stopRecording, uploadPendingRecordings, type LiveStats,
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
  // The recorder can stop by itself (rider left the metro, or forgot to stop)
  useEffect(() => {
    onRecordingState((rec, reason) => {
      setRecording(rec);
      setPending(pendingRecordings().length);
      if (!rec && reason && reason !== 'user') {
        setMsg({ text: reason === 'left_line' ? 'Stopped by itself: you left the metro line. The trip is being uploaded.'
          : reason === 'never_on_line' ? 'Stopped by itself: no metro line nearby for 45 minutes.'
          : 'Stopped by itself after 2.5 hours.', tone: 'meh' });
        setTimeout(() => setPending(pendingRecordings().length), 8000);
      }
    });
    return () => onRecordingState(null);
  }, []);

  const near = stats?.lastFix ? nearestStation(tt, stats.lastFix.lat, stats.lastFix.lon) : null;

  const start = async () => {
    setMsg(null);
    const r = await startRecording(tt);
    if (!r.ok) { setMsg({ text: 'Location permission is needed to record GPS and mobile towers. Allow it in Settings and try again.', tone: 'bad' }); return; }
    setRecording(true);
    track('recording_started');
  };

  const uploadAll = async () => {
    setBusy(true);
    const before = pendingRecordings();
    const { done, failed } = await uploadPendingRecordings();
    for (const rec of before.slice(0, done)) track('recording_uploaded', { samples: rec.samples.length, minutes: Math.round(((rec.endedAt ?? rec.startedAt) - rec.startedAt) / 60000) });
    setPending(pendingRecordings().length);
    setBusy(false);
    setMsg(failed ? { text: `${done} uploaded, ${failed} waiting for a connection. They stay on the phone and upload next time the app opens.`, tone: 'meh' }
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
              Tap Start any time before you board. The app saves your GPS position, the mobile towers your phone sees
              {Platform.OS === 'ios' ? ' (not available on iPhone)' : ''} and how the train speeds up and brakes. Keep the app open.
              It stops by itself when you leave the metro. Trips are uploaded anonymously, only to improve live train tracking.
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
                <Stat label="Train" value={trainWords(stats?.train ?? null)} sub={stats?.stops ? `${stats.stops} station stop${stats.stops > 1 ? 's' : ''} detected` : 'from motion'} />
                <Stat label="Speed" value={stats?.kmh != null ? `${stats.kmh} km/h` : '—'} sub={stats?.kmhFrom === 'gps' ? 'GPS' : stats?.kmhFrom === 'motion' ? 'estimated from motion' : 'waiting'} />
                <Stat label="GPS" value={String(stats?.gpsFixes ?? 0)} sub={stats?.lastAccuracy != null ? `±${Math.round(stats.lastAccuracy)} m${stats.fromLine != null ? ` · ${stats.fromLine < 400 ? 'on the line' : `${(stats.fromLine / 1000).toFixed(1)} km from line`}` : ''}` : 'no fix (normal underground)'} />
                <Stat label="Towers seen" value={String(stats?.towers ?? 0)} sub={Platform.OS === 'ios' ? 'iPhone: n/a' : `${stats?.marks ?? 0} doors tapped`} />
              </View>
              {near ? <T v="sub" color={c.ink2}>Near {stationName(tt, near, lang)}</T> : null}
            </Card>
            <SensorDetails stats={stats} />
            <Tap onPress={() => markStation(near)} style={[s.mark, { backgroundColor: c.tint }]} accessibilityRole="button">
              <T v="title" color={c.onTint}>Doors opened</T>
              <T v="sub" color={c.onTint}>Optional. Helps most underground</T>
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

/** Live sensor numbers and a 60-second graph, so riders can spot wrong detection on the train. */
function SensorDetails({ stats }: { stats: LiveStats | null }) {
  const { c } = useTheme();
  const [open, setOpen] = useState(true);
  const m = stats?.motion;
  const hist = stats?.history ?? [];
  const MAX = 1.5; // m/s^2 at full bar height
  const H = 44;    // px each side of the middle line
  const n = (x: number | null | undefined, d = 2) => (x == null ? '—' : x.toFixed(d));
  const rows: [string, string, string][] = m ? [
    ['Push along track', m.along == null ? 'waiting for a stop' : `${m.along > 0 ? '+' : ''}${n(m.along)} m/s²`, '+ speeding up, − braking'],
    ['Level push', `${n(m.h)} m/s²`, 'train ≈ 0.8–1.1 when speeding up or braking'],
    ['Up / down', `${n(m.v)} m/s²`, 'bumps, lifts, stairs'],
    ['Shake', `${n(m.j)} m/s²`, 'under 0.06 = still · over 0.8 = hand or walking'],
    ['Turning', `${n(m.r, 0)} °/s`, 'over 20 = phone in hand'],
  ] : [];
  const color = (b: LiveStats['history'][number]) =>
    b.s === 'hand' ? c.meh : !b.signed ? c.ink3 : b.x >= 0 ? c.ok : c.bad;
  return (
    <Card style={{ gap: space.m }}>
      <Tap onPress={() => setOpen((o) => !o)} style={s.row} accessibilityRole="button">
        <T v="headline">Sensor details</T>
        <T v="sub" color={c.tint} style={{ marginLeft: 'auto' }}>{open ? 'Hide' : 'Show'}</T>
      </Tap>
      {open ? (
        <>
          {!m ? <T v="sub" color={c.ink2}>Waiting for motion readings…</T> : null}
          {rows.map(([label, value, hint]) => (
            <View key={label} style={{ gap: 1 }}>
              <View style={s.row}>
                <T v="sub" color={c.ink2}>{label}</T>
                <T v="headline" style={[type.time, { marginLeft: 'auto' }]}>{value}</T>
              </View>
              <T v="caption" color={c.ink3} style={{ fontWeight: '400' }}>{hint}</T>
            </View>
          ))}
          <View style={{ gap: 4 }}>
            <T v="caption" color={c.ink2} style={{ fontWeight: '500' }}>Last 60 seconds</T>
            <View style={[s.graph, { height: H * 2, backgroundColor: c.fill }]}>
              <View style={[s.mid, { top: H, backgroundColor: c.ink3 }]} />
              {hist.map((b, i) => {
                const hgt = Math.min(H, (Math.abs(b.x) / MAX) * H);
                const up = !b.signed || b.x >= 0;
                return <View key={i} style={{ position: 'absolute', left: `${(i / 60) * 100}%`, width: `${100 / 60}%`, paddingHorizontal: 0.5,
                  top: up ? H - hgt : H, height: Math.max(1, hgt) }}>
                  <View style={{ flex: 1, backgroundColor: color(b), borderRadius: 1 }} />
                </View>;
              })}
            </View>
            <View style={[s.row, { flexWrap: 'wrap', columnGap: space.m }]}>
              <Legend color={c.ok} label="speeding up" /><Legend color={c.bad} label="braking" />
              <Legend color={c.ink3} label="direction unknown" /><Legend color={c.meh} label="phone in hand" />
            </View>
            <T v="caption" color={c.ink3} style={{ fontWeight: '400' }}>Full height = 1.5 m/s². Direction is learned when the train pulls away from a station.</T>
          </View>
        </>
      ) : null}
    </Card>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  const { c } = useTheme();
  return (
    <View style={[s.row, { gap: 4 }]}>
      <View style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: color }} />
      <T v="caption" color={c.ink2} style={{ fontWeight: '400' }}>{label}</T>
    </View>
  );
}

function trainWords(s: TrainState | null): string {
  switch (s) {
    case 'stopped': return 'Stopped';
    case 'starting': return 'Speeding up';
    case 'cruising': return 'Moving';
    case 'braking': return 'Braking';
    case 'hand': return 'Phone in hand';
    default: return '—';
  }
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
  graph: { borderRadius: radius.m, overflow: 'hidden', position: 'relative' },
  mid: { position: 'absolute', left: 0, right: 0, height: StyleSheet.hairlineWidth },
  mark: { borderRadius: radius.l, paddingVertical: space.xl, alignItems: 'center', gap: 4 },
});
