/**
 * Token alignment shared by caption timing (lib/caption) and storyboard import (lib/scenes).
 *
 * Both problems are the same shape: some authored text has to be pinned to the transcript's words
 * without assuming the two tokenize to the same count. Matching by position drifts as soon as a
 * single word differs, so both callers match by TEXT via a longest common subsequence.
 */

/** Compare key for matching an authored token against a transcript word: case/punctuation-insensitive. */
export function normalize(t: string): string {
  return t.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]/gu, '');
}

/** Above this many DP cells, callers should skip alignment and fall back to spreading evenly. */
export const MAX_DP_CELLS = 400_000;

/**
 * Longest common subsequence over normalized tokens. Returns, for each `a` index, the matched `b`
 * index or -1. Matches are order-preserving, so the result is monotonically increasing.
 */
export function lcsMatch(a: string[], b: string[]): Int32Array {
  const n = a.length;
  const m = b.length;
  // dp[i][j] = LCS length of a[i:] and b[j:], stored row-major in a flat (n+1)*(m+1) grid.
  const dp = new Int32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * (m + 1) + j] =
        a[i] === b[j]
          ? dp[(i + 1) * (m + 1) + j + 1] + 1
          : Math.max(dp[(i + 1) * (m + 1) + j], dp[i * (m + 1) + j + 1]);
    }
  }
  const out = new Int32Array(n).fill(-1);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out[i] = j;
      i++;
      j++;
    } else if (dp[(i + 1) * (m + 1) + j] >= dp[i * (m + 1) + j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return out;
}
