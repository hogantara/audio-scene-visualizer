/**
 * How long a word takes to say, relative to its neighbours.
 *
 * The transcription source gives timings per PHRASE, not per word (see lib/gemini), so the words
 * inside a phrase have to be placed by estimate. Sharing the phrase out equally makes every word the
 * same length, which is wrong in the one direction that shows: a long word swallowed by a short one
 * lights up early and stays lit, and the highlight visibly drifts ahead of the voice by the end of a
 * long phrase. Weighting by syllables tracks the voice instead — Indonesian is syllable-timed and
 * spelled phonetically, so counting vowel groups is a close read of how long a word takes.
 *
 * Punctuation is folded in as extra weight rather than as a separate pause: the silence after a
 * comma or a full stop belongs to the word before it, and giving that word a longer span is what
 * keeps the words after the pause from being pulled early.
 */

/**
 * Syllable nuclei. Indonesian is spelled one nucleus per vowel LETTER — adjacent vowels are
 * normally separate syllables (ke-nya-ta-an, rang-ka-i-an), which is why this counts letters rather
 * than vowel runs. `y` is excluded: it's a consonant here ("sa-ya").
 */
const VOWEL = /[aeiouáéíóúàèìòùâêîôûäëïöü]/gi;
/**
 * The exception: ai/au/oi in the FINAL syllable are true diphthongs, one nucleus (pan-tai, pu-lau).
 * Elsewhere in a word the same pair is two syllables, so the rule is anchored to the end.
 */
const FINAL_DIPHTHONG = /(ai|au|oi)$/i;
const SENTENCE_TAIL = /[.!?…]["”')\]]*$/;
const CLAUSE_TAIL = /[,;:—–]["”')\]]*$/;

/** Extra weight for the silence a speaker leaves after a clause / a sentence, in syllable units. */
const CLAUSE_PAUSE = 0.6;
const SENTENCE_PAUSE = 1.2;

/**
 * Relative duration of one spoken token, in syllables. Never zero — a token with no vowels at all
 * (an acronym, a numeral, a stray symbol) falls back to its length, so it still takes real time.
 *
 * Tuned for Indonesian, the language this app transcribes. English words mixed in are counted a
 * little long (a silent final `e` gets its own nucleus), which only ever shifts a word's share
 * slightly against its neighbours — the phrase's own start and end stay measured either way.
 */
export function wordWeight(token: string): number {
  const t = token.trim();
  if (!t) return 1;
  const letters = t.replace(/[^\p{L}\p{N}]/gu, '');
  if (!letters) return 1;
  const vowels = letters.match(VOWEL)?.length ?? 0;
  // Spelled out rather than pronounced: an acronym or a number is one syllable per character
  // ("KTP" is ka-te-pe), so its written length is the better estimate of how long it takes.
  const spelled = vowels === 0 || (letters.length > 1 && letters === letters.toUpperCase());
  const base = spelled
    ? letters.length
    : Math.max(1, FINAL_DIPHTHONG.test(letters) ? vowels - 1 : vowels);
  if (SENTENCE_TAIL.test(t)) return base + SENTENCE_PAUSE;
  if (CLAUSE_TAIL.test(t)) return base + CLAUSE_PAUSE;
  return base;
}

/**
 * Split [a, b] across `tokens` in proportion to how long each takes to say. Returns each token's
 * [start, end], tiling the span exactly — a zero-width span collapses them all onto `a`.
 */
export function paceSpans(tokens: string[], a: number, b: number): { s: number; e: number }[] {
  const n = tokens.length;
  if (n === 0) return [];
  const weights = tokens.map(wordWeight);
  const total = weights.reduce((x, y) => x + y, 0);
  const span = Math.max(0, b - a);
  const out: { s: number; e: number }[] = [];
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const s = a + (span * acc) / total;
    acc += weights[i];
    out.push({ s, e: a + (span * acc) / total });
  }
  return out;
}
