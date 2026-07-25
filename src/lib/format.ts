export function fmtTime(t: number): string {
  const total = Math.max(0, Math.floor(t));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function fmtDur(t: number): string {
  return `${Math.round(t)}s`;
}

/**
 * Fixed USD→IDR rate for display only, set from the market rate around late July 2026. Gemini's own
 * pricing is USD-denominated (see lib/gemini.ts), so cost is tracked in USD and converted here purely
 * for display — re-check a current rate if this drifts far from actual.
 */
const IDR_PER_USD = 17900;

/** Format an estimated cost (tracked in USD) as Indonesian Rupiah. */
export function fmtIDR(usd: number): string {
  return `Rp${Math.round(usd * IDR_PER_USD).toLocaleString('id-ID')}`;
}
