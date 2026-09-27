/**
 * npm run timetable                   download the latest feed and rebuild data/timetable.json
 * npm run timetable -- path/to.zip    build from a local feed file
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { buildTimetable, downloadFeed } from './build';

const out = resolve(__dirname, '../../../data/timetable.json');
const src = process.argv[2];

async function main() {
  const zip = src ? new Uint8Array(readFileSync(src)) : await downloadFeed();
  const tt = buildTimetable(zip);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(tt));
  const trips = Object.values(tt.departures).reduce((s, l) => s + l.length, 0);
  console.log(`timetable ${tt.version}: ${Object.keys(tt.stations).length} stations, ${tt.patterns.length} patterns, ${trips} trips`);
}
main().catch((e) => { console.error(e); process.exit(1); });
