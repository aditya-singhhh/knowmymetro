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
}

const Native = requireOptionalNativeModule<{ getCellsAsync(): Promise<Cell[]> }>('CellInfo');

/** Towers visible right now. Empty on iOS, web, or without the location permission. */
export async function getCells(): Promise<Cell[]> {
  if (!Native) return [];
  try { return await Native.getCellsAsync(); } catch { return []; }
}
