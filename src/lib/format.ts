export function fmtTime(t: number): string {
  const total = Math.max(0, Math.floor(t));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function fmtDur(t: number): string {
  return `${Math.round(t)}s`;
}

/** Format an estimated USD cost. Sub-cent totals get an extra decimal so they don't all round to $0.00. */
export function fmtUSD(v: number): string {
  return `$${v.toFixed(v < 0.01 && v > 0 ? 3 : 2)}`;
}
