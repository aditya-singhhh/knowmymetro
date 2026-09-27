#!/usr/bin/env node
/**
 * Builds data/timetable.json from the BMRCL GTFS feed.
 *
 *   node scripts/build-timetable.mjs                 # download the latest feed
 *   node scripts/build-timetable.mjs path/to/feed.zip
 *
 * Output is a compact file used by the app (next trains, station info)
 * and by the `plan` Cloud Function (routing).
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync, strFromU8 } from 'fflate';

const FEED_URL = 'https://raw.githubusercontent.com/Vonter/bmrcl-gtfs/main/gtfs/bmrcl.zip';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'data/timetable.json');

/** Short display names for stations whose official names are long. */
const SHORT = {
  KGWA: 'Majestic', BRCS: 'KSR Railway Station', VSWA: 'Central College', VDSA: 'Vidhana Soudha',
  HSLI: 'Hosahalli', JPN: 'JP Nagar', MAGR: 'MG Road', SVRD: 'Swami Vivekananda Rd', RVR: 'RV Road',
};

export async function loadFeed(src) {
  const buf = src ? readFileSync(src) : new Uint8Array(await (await fetch(FEED_URL)).arrayBuffer());
  const files = unzipSync(buf instanceof Uint8Array ? buf : new Uint8Array(buf));
  const get = (name) => (files[name] ? parseCsv(strFromU8(files[name])) : []);
  return { get, raw: buf };
}

function parseCsv(text) {
  const rows = []; let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const [head, ...body] = rows;
  const h = head.map((s) => s.replace(/^﻿/, ''));
  return body.map((r) => Object.fromEntries(h.map((k, i) => [k, r[i] ?? ''])));
}

const toSec = (t) => { const [h, m, s] = t.split(':').map(Number); return h * 3600 + m * 60 + (s || 0); };

export function buildTimetable(get) {
  const feed = get('feed_info.txt')[0] || {};
  // stations and platforms
  const stops = get('stops.txt');
  const stations = {}, parentOf = {}, platformOf = {};
  for (const s of stops) {
    if (s.location_type === '1') stations[s.stop_id] = { en: SHORT[s.stop_id] || s.stop_name, full: s.stop_name, lat: +(+s.stop_lat).toFixed(5), lon: +(+s.stop_lon).toFixed(5) };
  }
  for (const s of stops) {
    if (s.parent_station && stations[s.parent_station]) { parentOf[s.stop_id] = s.parent_station; platformOf[s.stop_id] = s.platform_code || null; }
    else if (stations[s.stop_id]) parentOf[s.stop_id] = s.stop_id;
  }
  for (const t of get('translations.txt')) {
    if (t.table_name === 'stops' && t.field_name === 'stop_name' && t.language === 'kn' && stations[t.record_id]) stations[t.record_id].kn = t.translation;
  }
  // lines
  const lines = {};
  for (const r of get('routes.txt')) lines[r.route_id] = { name: r.route_short_name || r.route_id, color: '#' + (r.route_color || '888888'), stations: [] };

  // trips -> patterns
  const trips = Object.fromEntries(get('trips.txt').map((t) => [t.trip_id, t]));
  const byTrip = {};
  for (const st of get('stop_times.txt')) (byTrip[st.trip_id] ||= []).push(st);
  const patterns = [], patIndex = new Map(), departures = {};
  for (const [tripId, sts] of Object.entries(byTrip)) {
    const trip = trips[tripId]; if (!trip) continue;
    sts.sort((a, b) => +a.stop_sequence - +b.stop_sequence);
    const t0 = toSec(sts[0].departure_time || sts[0].arrival_time);
    const stopsList = sts.map((s) => parentOf[s.stop_id]);
    const arr = sts.map((s) => toSec(s.arrival_time || s.departure_time) - t0);
    const dep = sts.map((s) => toSec(s.departure_time || s.arrival_time) - t0);
    const pf = sts.map((s) => platformOf[s.stop_id] ?? null);
    const key = [trip.route_id, stopsList.join('.'), arr.join('.'), dep.join('.'), pf.join('.')].join('|');
    let pi = patIndex.get(key);
    if (pi === undefined) { pi = patterns.length; patIndex.set(key, pi); patterns.push({ line: trip.route_id, stops: stopsList, arr, dep, pf }); }
    (departures[trip.service_id] ||= []).push([pi, t0]);
  }
  for (const list of Object.values(departures)) list.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  // line station order = longest pattern of each line
  for (const p of patterns) if (p.stops.length > lines[p.line].stations.length) lines[p.line].stations = p.stops.slice();

  // calendar
  const dayCols = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const services = get('calendar.txt').map((c) => ({ id: c.service_id, days: dayCols.map((d) => c[d] === '1'), start: c.start_date, end: c.end_date }));
  const exceptions = get('calendar_dates.txt').map((e) => ({ service: e.service_id, date: e.date, type: +e.exception_type }));
  const peak = get('timeframes.txt').filter((t) => t.timeframe_group_id === 'peak').map((t) => ({ service: t.service_id, from: toSec(t.start_time), to: toSec(t.end_time) }));

  // fares: token fare in rupees between every pair of stations
  const codes = Object.keys(stations).sort(), idx = Object.fromEntries(codes.map((c, i) => [c, i]));
  const matrix = codes.map(() => codes.map(() => 0));
  for (const f of get('fare_leg_rules.txt')) {
    const m = /^fare_(\d+)_token$/.exec(f.fare_product_id);
    if (m && idx[f.from_area_id] !== undefined && idx[f.to_area_id] !== undefined) matrix[idx[f.from_area_id]][idx[f.to_area_id]] = +m[1];
  }

  const body = { feed: { version: feed.feed_version || '', start: feed.feed_start_date || '', end: feed.feed_end_date || '' },
    lines, stations, patterns, departures, services, exceptions, peak, fares: { codes, token: matrix } };
  const version = (feed.feed_version || 'feed') + '-' + createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 8);
  return { version, generatedAt: new Date().toISOString(), ...body };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { get } = await loadFeed(process.argv[2]);
  const tt = buildTimetable(get);
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(tt));
  const n = Object.values(tt.departures).reduce((s, l) => s + l.length, 0);
  console.log(`timetable ${tt.version}: ${Object.keys(tt.stations).length} stations, ${tt.patterns.length} patterns, ${n} trips, ${(JSON.stringify(tt).length / 1024).toFixed(0)} KB`);
}
