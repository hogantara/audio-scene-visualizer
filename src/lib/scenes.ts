import type { Project, Scene, Word } from '../types';
import { MAX_WORD_SEC } from './gemini';

const MIN_SEC = 10;
const MAX_SEC = 30;
const PAUSE_GAP = 0.7;
const SENTENCE_END = /[.!?…]["”')\]]*$/;

const uid = () => crypto.randomUUID();

/** A transcript word plus its hand-corrected timing offset, kept separate from the raw times. */
export interface SourceWord extends Word {
  off?: number;
}

/**
 * The scene's transcript words with any hand-corrected timing attached as `off` — what karaoke
 * should follow. The raw `s`/`e` are kept untouched so `fitToWindow` repairs from the transcript's
 * own timing; the correction is applied after fitting (see `buildWordLines`), which is what makes
 * a hand nudge authoritative over the automatic repair.
 *
 * Scene bounds deliberately keep using the RAW words (see `recomputeBounds`): nudging a word fixes
 * where the highlight fires, and must not drag the scene's cut points around with it.
 */
export function sceneWords(p: Project, s: Scene): SourceWord[] {
  const out: SourceWord[] = p.words.slice(s.wordStart, s.wordEnd);
  for (let i = 0; i < out.length; i++) {
    const d = p.wordOffsets?.[s.wordStart + i];
    if (d) out[i] = { ...out[i], off: d };
  }
  return out;
}

export function sceneText(words: Word[], from: number, to: number): string {
  return words
    .slice(from, to)
    .map((w) => w.w)
    .join(' ');
}

export function defaultPrompt(text: string): string {
  const t = text.length > 240 ? text.slice(0, 240).trimEnd() + '…' : text;
  return `Illustration for this narration: "${t}"`;
}

export function buildFinalPrompt(prompt: string, style: string): string {
  const parts = [prompt.trim()];
  if (style.trim()) parts.push(`Style: ${style.trim()}`);
  parts.push('Wide 16:9 cinematic landscape composition');
  parts.push('No text, words, or lettering in the image.');
  return parts.join(' — ');
}

/**
 * Choose scene start indices (first is always 0). Cuts at sentence ends, pauses,
 * or transcript segment starts, targeting 10–30 s per scene.
 */
export function autoChunk(words: Word[]): number[] {
  if (words.length === 0) return [];
  const cuts = [0];
  let start = 0;
  let lastCandidate = -1;
  for (let i = 1; i < words.length; i++) {
    const prev = words[i - 1];
    const dur = prev.e - words[start].s;
    const gap = words[i].s - prev.e;
    const candidate = words[i].p || gap >= PAUSE_GAP || SENTENCE_END.test(prev.w);
    if (candidate) {
      if (dur >= MIN_SEC) {
        cuts.push(i);
        start = i;
        lastCandidate = -1;
        continue;
      }
      lastCandidate = i;
    }
    if (words[i].e - words[start].s > MAX_SEC) {
      const at = lastCandidate > start ? lastCandidate : i;
      cuts.push(at);
      start = at;
      lastCandidate = -1;
    }
  }
  // Merge a tiny tail scene into the previous one.
  if (cuts.length > 1 && words[words.length - 1].e - words[cuts[cuts.length - 1]].s < 4) {
    cuts.pop();
  }
  return cuts;
}

export function makeScene(words: Word[], from: number, to: number): Scene {
  const text = sceneText(words, from, to);
  return {
    id: uid(),
    start: 0,
    end: 0,
    wordStart: from,
    wordEnd: to,
    text,
    prompt: defaultPrompt(text),
    imageId: null,
    imageStatus: 'none',
  };
}

/**
 * Recompute scene start/end so scenes exactly tile [0, duration]:
 * each boundary is the midpoint of the silence between adjacent words.
 */
export function recomputeBounds(scenes: Scene[], words: Word[], duration: number): void {
  for (let i = 0; i < scenes.length; i++) {
    const s = scenes[i];
    if (i === 0) {
      s.start = 0;
    } else {
      const prevWord = words[s.wordStart - 1];
      const firstWord = words[s.wordStart];
      s.start = (prevWord.e + firstWord.s) / 2;
      scenes[i - 1].end = s.start;
    }
  }
  scenes[scenes.length - 1].end = duration;
}

/**
 * Transcription rounds timestamps to the millisecond, so a tail pinned to the clip's end can sit a
 * fraction of a ms BELOW `duration` — anything this close to the end counts as "at the end".
 */
const END_EPS = 0.005;
/** Tolerance for recognizing a word width as exactly the transcription pace cap (ms rounding). */
const CAP_EPS = 0.002;

/**
 * Refit transcript word timestamps that run past the real audio length, in place.
 *
 * The model estimates word timings itself and that estimate drifts — the error compounds across
 * segments, so it is the trailing words that end up claiming time the audio does not have. Left
 * alone those words also drag scene boundaries past `duration` (see `recomputeBounds`), which can
 * strand a whole trailing scene outside the playable timeline.
 *
 * The overshooting tail is redistributed evenly across whatever real time remains rather than
 * collapsed onto the final instant: collapsing keeps the numbers legal but pins every affected word
 * to a single unreachable moment, which is exactly how they go missing on screen. Words that already
 * fit are never touched, so correctly-timed speech keeps matching the audio.
 */
export function clampWordsToDuration(words: Word[], duration: number): void {
  if (words.length === 0 || !(duration > 0)) return;
  const endT = duration - END_EPS;
  // Two shapes of broken tail are repaired here: a word ending past the audio, and a word whose
  // ONSET has landed at/after the end (within END_EPS — ms rounding can leave a flattened tail a
  // hair short of `duration`). The second matters because the playhead never advances past
  // `duration`, so such a word can never fire — and because a tail already folded flat onto the end
  // no longer overshoots, it would otherwise read as valid and stay stuck forever.
  let first = words.findIndex((w) => w.e > duration || w.s >= endT);
  if (first === -1) return;
  // Pull in preceding words that are part of the same damage:
  //  - words already flattened onto the very end: they carry no headroom, so anchoring on one would
  //    divide a zero-width gap and simply re-pin the whole tail in place;
  //  - words exactly MAX_WORD_SEC wide: that width is the transcription pace cap, which only binds
  //    when the model's segment end was garbage — their span is synthetic, and it is precisely the
  //    time the flattened tail lost, so reclaim it for the respread.
  while (
    first > 0 &&
    (words[first - 1].e >= endT || Math.abs(words[first - 1].e - words[first - 1].s - MAX_WORD_SEC) < CAP_EPS)
  ) {
    first--;
  }
  // Everything from `first` on has to share the gap between the last good word and the audio end.
  // Starts are the reliable half of the model's timestamps (see transcribeChunk), so when the run's
  // own first start is credible — after the previous word, before the end — anchor there instead of
  // the previous word's end, keeping the run in step with where its speech actually begins.
  let from = first > 0 ? Math.min(words[first - 1].e, duration) : 0;
  if (words[first].s > from && words[first].s < endT) from = words[first].s;
  const count = words.length - first;
  const step = Math.max(0, duration - from) / count;
  for (let k = 0; k < count; k++) {
    const w = words[first + k];
    // Rounding to ms can nudge a value back over the edge, so clamp after rounding, not before.
    w.s = Math.min(duration, Number((from + step * k).toFixed(3)));
    w.e = Math.min(duration, Number((from + step * (k + 1)).toFixed(3)));
  }
}

export function buildScenes(words: Word[], duration: number): Scene[] {
  const cuts = autoChunk(words);
  const scenes = cuts.map((c, k) => makeScene(words, c, k + 1 < cuts.length ? cuts[k + 1] : words.length));
  recomputeBounds(scenes, words, duration);
  return scenes;
}

/** Merge scene at index i with the next one, in place. Returns the removed scene's orphaned imageId (to delete), if any. */
export function mergeWithNext(p: Project, i: number): string | null {
  const a = p.scenes[i];
  const b = p.scenes[i + 1];
  if (!b) return null;
  const orphan = a.imageId && b.imageId ? b.imageId : null;
  const merged: Scene = {
    ...a,
    wordEnd: b.wordEnd,
    text: `${a.text.trim()} ${b.text.trim()}`,
    prompt: a.prompt.trim() ? a.prompt : b.prompt,
    imageId: a.imageId ?? b.imageId,
    imageStatus: a.imageId ?? b.imageId ? 'ready' : 'none',
    imageError: undefined,
  };
  p.scenes.splice(i, 2, merged);
  // The merged scene keeps `a`'s id and `a`'s text as a prefix, so `a`'s displayed-word corrections
  // still key correctly; `b`'s can't follow its words (occurrence keys shift), so drop them.
  if (p.sceneWordOffsets) delete p.sceneWordOffsets[b.id];
  recomputeBounds(p.scenes, p.words, p.duration);
  return orphan;
}

/** Split a scene so the word at `relIndex` (relative to the scene) starts the new second half. In place. */
export function splitScene(p: Project, i: number, relIndex: number): void {
  const s = p.scenes[i];
  const abs = s.wordStart + relIndex;
  if (abs <= s.wordStart || abs >= s.wordEnd) return;
  const first: Scene = {
    ...s,
    wordEnd: abs,
    text: sceneText(p.words, s.wordStart, abs),
  };
  const second = makeScene(p.words, abs, s.wordEnd);
  p.scenes.splice(i, 1, first, second);
  recomputeBounds(p.scenes, p.words, p.duration);
}
