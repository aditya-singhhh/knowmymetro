/**
 * npm run own -- export   copy the current data/timetable.json into the editable source (data/timetable/), once
 * npm run own             apply every observation to the source and write data/timetable.json + data/timetable/CHANGES.txt
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Timetable } from '@kmm/shared';
import { readFileSync } from 'node:fs';
import { build, exportSource, sourceExists } from './own';

const root = resolve(__dirname, '../../../data');
const dir = resolve(root, 'timetable');
const out = resolve(root, 'timetable.json');

if (process.argv[2] === 'export') {
  if (sourceExists(dir)) { console.error('data/timetable/ already has a source; delete meta.json first to re-export'); process.exit(1); }
  const tt = JSON.parse(readFileSync(out, 'utf8')) as Timetable;
  exportSource(tt, dir, `exported from ${tt.version} (BMRCL GTFS feed ${tt.feed.version})`);
  console.log(`exported ${tt.version} to data/timetable/`);
} else {
  const { tt, log } = build(dir);
  writeFileSync(out, JSON.stringify(tt));
  writeFileSync(resolve(dir, 'CHANGES.txt'), log.join('\n') + '\n');
  const trips = Object.values(tt.departures).reduce((n, l) => n + l.length, 0);
  console.log(`timetable ${tt.version}: ${tt.patterns.length} patterns, ${trips} trips`);
  console.log(log.filter((l) => !l.startsWith('!')).join('\n'));
}
