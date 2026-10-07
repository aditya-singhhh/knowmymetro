import { requireOptionalNativeModule } from 'expo';

/** One mobile tower (cell) the phone can see. */
export interface Cell {
  type: 'lte' | 'nr' | 'wcdma' | 'gsm';
  reg: boolean;          // the tower the phone is connected to
  ci: number | null;     // cell id
  tac: number | null;    // tracking / location area code
  pci: number | null;    // physical cell id (seen for neighbours even when ci is not)
  arfcn: number | null;  // channel
  mcc: string | null;
  mnc: string | null;
  dbm: number | null;    // signal strength
  // newer app builds (null/absent on older ones)
  age?: number | null;   // ms since the modem took this reading
  conn?: number | null;  // 1 = primary serving, 2 = secondary (carrier aggregation), 0 = none
  ta?: number | null;    // timing advance (LTE/GSM): distance to the tower in steps (~78 m LTE, ~550 m GSM)
  rsrp?: number | null; rsrq?: number | null; snr?: number | null; bw?: number | null;
}

const Native = requireOptionalNativeModule<{ getCellsAsync(): Promise<Cell[]> }>('CellInfo');

/** Towers visible right now. Empty on iOS, web, or without the location permission. */
export async function getCells(): Promise<Cell[]> {
  if (!Native) return [];
  try { return await Native.getCellsAsync(); } catch { return []; }
}
